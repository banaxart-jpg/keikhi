import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import admin from "firebase-admin";
import pg from "pg";
import crypto from "node:crypto";

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  RECEIPTS_BUCKET,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_INSTANCE_CONNECTION_NAME,
  DB_HOST,
  DB_PORT = 5432,
  FIREBASE_PROJECT_ID,
  ALLOWED_EMAILS = "",
  DEV,
  FIREBASE_INIT_JSON,
  PORT = 8080,
} = process.env;

admin.initializeApp({ projectId: FIREBASE_PROJECT_ID || undefined });
const allowList = ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const app = express();
app.use(express.json({ limit: "20mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Gate /api/* with a Firebase ID token. The browser calls this service
// same-origin via Firebase Hosting rewrite, so no CORS/OAuth token is
// involved — auth is a verified Firebase ID token instead.
// 例外: /api/internal/* は Cloud Tasks コールバック用なので別認証(x-tick-secret)。
const INTERNAL_TICK_SECRET = process.env.INTERNAL_TICK_SECRET;
app.use("/api", async (req, res, next) => {
  if (req.path.startsWith("/internal/")) {
    if (!INTERNAL_TICK_SECRET || req.headers["x-tick-secret"] !== INTERNAL_TICK_SECRET) {
      return res.status(403).json({ error: "forbidden (internal)" });
    }
    req.user = { email: "internal@cloud-tasks" };
    return next();
  }
  // Cloud Shell プレビューは cloudshell.dev ドメインで Firebase Auth が
  // 使えない（auth/unauthorized-domain）。DEV のときだけ認証をバイパス。
  // 本番は DEV 未設定なので常に厳格検証。
  if (DEV) { req.user = { email: "dev@local" }; return next(); }
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "ログインが必要です (no token)" });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    if (allowList.length && !allowList.includes((decoded.email || "").toLowerCase())) {
      return res.status(403).json({ error: `権限がありません (${decoded.email || "?"})` });
    }
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: "認証に失敗しました: " + (e.code || e.message) });
  }
});

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const storage = RECEIPTS_BUCKET ? new Storage() : null;

let pool = null;
function getPool() {
  if (pool) return pool;
  // Local/dev: TCP via cloud-sql-proxy (DB_HOST=127.0.0.1).
  // Prod: Cloud Run unix socket /cloudsql/<instance>.
  if (DB_HOST) {
    pool = new pg.Pool({
      user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
      host: DB_HOST, port: Number(DB_PORT), max: 5,
    });
    return pool;
  }
  if (!DB_INSTANCE_CONNECTION_NAME) return null;
  pool = new pg.Pool({
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    host: `/cloudsql/${DB_INSTANCE_CONNECTION_NAME}`,
    max: 5,
  });
  return pool;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    gemini: !!genAI,
    storage: !!storage,
    db: !!DB_INSTANCE_CONNECTION_NAME,
  });
});

// ─────────────────────────────
// Sites
// ─────────────────────────────
app.get("/api/sites", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query("SELECT id, name FROM sites ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error("sites list", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sites", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const { rows } = await p.query(
      "INSERT INTO sites (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id, name",
      [name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("sites insert", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/sites/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query("DELETE FROM sites WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("sites delete", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────
// Receipt scan (Gemini + GCS upload)
// ─────────────────────────────
// 503/UNAVAILABLE 等の過渡的エラーで指数バックオフ→別モデルへフォールバック。
// Gemini Flash は時々スパイクで詰まるので、ユーザーが「Retry」を押す前に
// サーバ側で吸収する。
async function callGeminiWithFallback(content, { primaryModel, maxOutputTokens, useGoogleSearch } = {}) {
  const fallbackChain = [
    ...new Set([primaryModel || GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]),
  ];
  let lastErr;
  for (const name of fallbackChain) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const m = genAI.getGenerativeModel({
          model: name,
          ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
          ...(useGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
        });
        const r = await m.generateContent(content);
        return { result: r, modelUsed: name, attempts: attempt };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = /\b(503|429|500)\b|UNAVAILABLE|overload|high demand|rate limit/i.test(msg);
        if (!transient) throw e;
        if (attempt < 3) {
          const wait = 500 * 2 ** attempt; // 1s, 2s, 4s
          console.warn(`[gemini] ${name} attempt ${attempt} transient (${wait}ms backoff): ${msg.slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          console.warn(`[gemini] ${name} exhausted, falling back`);
        }
      }
    }
  }
  throw lastErr;
}

app.post("/api/scan", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { image, mimeType = "image/jpeg", sites = [] } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64) is required" });

    let imageUrl = null;
    if (storage && RECEIPTS_BUCKET) {
      const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
      await storage
        .bucket(RECEIPTS_BUCKET)
        .file(key)
        .save(Buffer.from(image, "base64"), { contentType: mimeType, resumable: false });
      imageUrl = `gs://${RECEIPTS_BUCKET}/${key}`;
    }

    const today = new Date().toISOString().slice(0, 10);
    // 1枚の画像に複数の領収書が並んでいたら全部抽出する。1枚だけなら要素1配列。
    const prompt = `画像内の領収書を全て検出してJSONのみ返してください。複数並んでいる場合は全部を要素にした配列にする。1枚しか無くても要素1の配列。形式:
{"receipts":[{"date":"YYYY-MM-DD(無ければ${today})","store":"店舗名","total":合計金額の数値,"category":"材料費 or 接待交際費 or ガソリン代 or 駐車場代 or 工具・備品 or 外注費 or その他","workType":"水道 or 電気 or 木工 or 塗装 or 左官 or 内装 or 外構 or 解体 or 設備 or その他","site":"${sites.join(" or ") || "(空文字でOK)"}から最も近いものまたは空文字"}]}`;
    const { result, modelUsed } = await callGeminiWithFallback([
      prompt,
      { inlineData: { data: image, mimeType } },
    ]);
    const text = result.response.text();
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("AI response did not contain JSON");
    const raw = JSON.parse(text.slice(s, e + 1));
    // 後方互換: Gemini が単一オブジェクトを返した場合も配列に正規化
    const receipts = Array.isArray(raw?.receipts)
      ? raw.receipts
      : (raw && (raw.store || raw.total || raw.date)) ? [raw] : [];
    res.json({ receipts, imageUrl, modelUsed });
  } catch (err) {
    console.error("scan error", err);
    const msg = String(err?.message || err);
    const isTransient = /\b(503|429|500)\b|UNAVAILABLE|overload|high demand/i.test(msg);
    res.status(isTransient ? 503 : 500).json({
      error: isTransient
        ? `Gemini が混雑中です（フォールバックも失敗）。少し待って再実行してください: ${msg.slice(0, 200)}`
        : msg,
    });
  }
});

// ─────────────────────────────
// AI 3人議論 (giron)
// ─────────────────────────────
// speakers: [{ name: "Gemini", provider: "gemini" }, { name: "Claude", provider: "claude" }, ...]
// 各 provider 用の API キーが入るまで全部 Gemini にフォールバックする。
// 【デバッグ中】3者とも軽量モデル・短文設定。安定確認後に最上位モデルに戻す。
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEBATE_MAX_TOKENS = 800;

async function callByProvider(provider, prompt, { web = true } = {}) {
  if (provider === "claude" && ANTHROPIC_API_KEY) {
    // Anthropic native web search (web_search_20250305)
    // 【デバッグ中】haiku-4-5 で軽量・高速
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: DEBATE_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
        ...(web ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] } : {}),
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
    const j = await r.json();
    // tool_use/tool_result が混ざるので text ブロックだけ集約
    const text = (j.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n").trim();
    if (!text) {
      throw new Error(`claude 応答が空 (stop_reason=${j.stop_reason}, usage=${JSON.stringify(j.usage || {})})`);
    }
    return { text, modelUsed: j.model };
  }
  if (provider === "gpt" && OPENAI_API_KEY) {
    // 【デバッグ中】gpt-5-mini + reasoning low で速度寄り
    // reasoning.effort: "minimal" は web_search ツールと併用不可（API 制約）
    // web 検索使うなら最低 "low" 必要。
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        max_output_tokens: 3000,
        reasoning: { effort: web ? "low" : "minimal" },
        ...(web ? { tools: [{ type: "web_search" }] } : {}),
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const text = (j.output_text
      || (j.output || [])
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text)
        .join("\n")
    ).trim();
    if (!text) {
      const reason = j.incomplete_details?.reason || j.status || "unknown";
      const usage = JSON.stringify(j.usage || {});
      throw new Error(`gpt 応答が空 (reason=${reason}, usage=${usage})`);
    }
    return { text, modelUsed: j.model };
  }
  // Gemini (本物 or 他 provider のフォールバック)。【デバッグ中】Flash で高速。
  const { result, modelUsed } = await callGeminiWithFallback(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: DEBATE_MAX_TOKENS,
    useGoogleSearch: web,
  });
  const text = result.response.text().trim();
  if (!text) {
    const fr = result.response?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`gemini 応答が空 (finishReason=${fr})`);
  }
  return { text, modelUsed };
}

// プロンプト生成（共通化：/api/debate と /api/kaigi/* で共有）
const providerLabel = {
  gemini: "Google が開発した大規模言語モデル Gemini",
  claude: "Anthropic が開発した大規模言語モデル Claude",
  gpt:    "OpenAI が開発した大規模言語モデル GPT",
};

function buildSpeakerPrompt({ topic, speakers, history, nextSpeaker }) {
  const me = speakers.find((s) => s.name === nextSpeaker);
  if (!me) throw Object.assign(new Error("nextSpeaker not in speakers"), { status: 400 });
  const provider = me.provider || "gemini";
  const meLabel = providerLabel[provider] || `AI「${me.name}」`;
  const others = speakers.filter((s) => s.name !== nextSpeaker)
    .map((s) => `・${s.name}（${providerLabel[s.provider] || s.name}）`).join("\n");
  const log = history.length
    ? history.map((h) => `${h.name}：${h.text}`).join("\n")
    : "（まだ誰も発言していない）";
  const roundNum = Math.floor(history.length / speakers.length) + 1;
  const stageHint = roundNum === 1
    ? "今は最初のラウンドです。お題に対する自分の視点・前提を出してください。"
    : roundNum === 2
    ? "2ラウンド目です。他の参加者の視点と自分の視点を統合し、合意できる点とまだズレている点を整理してください。"
    : "3ラウンド目以降です。そろそろ結論に収束させるフェーズ。具体的な実行案を提案し、他の参加者の案との折衷も検討してください。";

  const prompt = `あなたは ${meLabel} です。
今、複数社の AI が集まって、社内の経営判断に使える結論を出すための協働検討を行っています。

これはディベート（勝ち負けを決める競技）ではありません。3者で同じ目標——「お題に対する実行可能な結論」——に向かって、互いの視点を統合しながら詰めていく作業です。

お題：
「${topic}」

【現在のフェーズ】
${stageHint}

【スタンス】
- 直前の発言を踏まえて、議論を前進させる発言をする
- 同意できる点はそのまま同意し、足りない観点があれば補い、前提のずれがあれば整理する
- 反論のための反論はしない。違う視点を出すときは「なぜそれが重要か」と「どう統合できるか」も添える
- 抽象論や「ケースバイケース」「状況による」のような逃げは禁止。実行可能性まで踏み込む
- 議論が深まってきたら、合意できる結論を能動的に提案する

【厳格な情報原則】憶測禁止・根拠ベース
- 「だと思います」「一般的には」「肌感覚では」「〜と言われている」のような憶測・伝聞・一般論だけで主張するのは禁止
- 数字・統計・市場動向・他社事例・法制度・技術仕様などの事実に触れる場合は **必ず web 検索で1次情報を取りに行く**
- 検索した内容を引用するときは **本文中に「(出典: ◯◯)」または「(◯◯によれば〜)」と必ず出典名・サイト名を明記する**
- 根拠が見つからない論点については「裏付けが見つからないので断定はしない」と明示し、それを前提に発言する
- 他の参加者が出した数字や事実主張に違和感があれば、自分でも検索して裏取りする（賛同するにも反論するにも根拠ベースで）
- 自分の訓練データの中の知識だけで語らない。古い情報や記憶違いの可能性を常に疑う

【ツール】
Web検索ツールが使えます。上記の情報原則を守るため、事実に触れる発言は必ず先に検索してから組み立てるくらいの感覚で使ってください。検索結果の数字・出典が無いまま事実っぽく語るのは禁止です。

他の参加者:
${others}

これまでの発言:
${log}

あなた（${me.name}）の番です。100〜200字程度で簡潔に発言してください。名前プレフィックス・マークダウン・箇条書き記号は不要、自然な話し言葉で本文だけ。
発言:`;
  return { provider, prompt, roundNum };
}

function buildConclusionPrompt({ topic, speakers, history }) {
  const log = history.map((h) => `${h.name}：${h.text}`).join("\n") || "（発言なし）";
  const names = speakers.map((s) => s.name).join("・");
  const prompt = `お題「${topic}」について ${names} の3つのAIが検討しました。
議論を踏まえて、経営判断として実行できる結論を1つ提案してください。

形式:
【結論】何をやる / やらないか（1〜2文で断定的に）
【根拠】2〜3点
【実行上の注意点】1〜2点

プレーンテキスト、見出しは上記の【】記号付きで区切る。マークダウン記法は使わない。
全体で300〜500字。両論併記や「ケースバイケース」「状況による」のような逃げは禁止。

議論ログ:
${log}

回答:`;
  return { provider: "gemini", prompt };
}

// 既存 /api/debate（互換維持。フロントは新 /api/kaigi/* に移行する）
app.post("/api/debate", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { topic, speakers = [], history = [], nextSpeaker, summary } = req.body || {};
    if (!topic) return res.status(400).json({ error: "topic required" });
    if (!Array.isArray(speakers) || speakers.length < 2) {
      return res.status(400).json({ error: "speakers (2人以上) required" });
    }
    const { provider, prompt } = summary
      ? buildConclusionPrompt({ topic, speakers, history })
      : buildSpeakerPrompt({ topic, speakers, history, nextSpeaker });
    const { text: raw, modelUsed } = await callByProvider(provider, prompt, { web: !summary });
    const text = raw.trim().replace(/^[「『"']/, "").replace(/[」』"']$/, "");
    res.json({ text, modelUsed, provider });
  } catch (err) {
    console.error("debate error", err);
    const msg = String(err?.message || err);
    const isTransient = /\b(503|429|500)\b|UNAVAILABLE|overload|high demand/i.test(msg);
    res.status(err.status || (isTransient ? 503 : 500)).json({
      error: isTransient ? `AI が混雑中: ${msg.slice(0, 200)}` : msg,
    });
  }
});

// ─────────────────────────────
// kaigi: セッション永続化 + 自動進行 (Cloud Tasks)
// ─────────────────────────────
const KAIGI_TASKS_QUEUE = process.env.KAIGI_TASKS_QUEUE;
const KAIGI_TASKS_LOCATION = process.env.KAIGI_TASKS_LOCATION || "asia-northeast1";
const SERVICE_URL = process.env.SERVICE_URL; // 例: https://keihi-api-...run.app
let _tasksClient = null;
function getTasksClient() {
  if (_tasksClient) return _tasksClient;
  _tasksClient = new CloudTasksClient();
  return _tasksClient;
}
async function enqueueKaigiTick(sessionId, delaySec = 0) {
  if (!KAIGI_TASKS_QUEUE || !SERVICE_URL || !INTERNAL_TICK_SECRET || !FIREBASE_PROJECT_ID) {
    console.warn("[kaigi] tick enqueue skipped (KAIGI_TASKS_QUEUE/SERVICE_URL/INTERNAL_TICK_SECRET/FIREBASE_PROJECT_ID 未設定)");
    return null;
  }
  const client = getTasksClient();
  const parent = client.queuePath(FIREBASE_PROJECT_ID, KAIGI_TASKS_LOCATION, KAIGI_TASKS_QUEUE);
  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: `${SERVICE_URL}/api/internal/kaigi/tick`,
      headers: { "content-type": "application/json", "x-tick-secret": INTERNAL_TICK_SECRET },
      body: Buffer.from(JSON.stringify({ sessionId })).toString("base64"),
    },
  };
  if (delaySec > 0) {
    task.scheduleTime = { seconds: Math.floor(Date.now() / 1000) + delaySec };
  }
  const [resp] = await client.createTask({ parent, task });
  return resp.name;
}

async function loadSession(sessionId, userEmail) {
  const p = getPool();
  if (!p) throw new Error("DB not configured");
  const args = userEmail === "*" ? [sessionId] : [sessionId, userEmail];
  const where = userEmail === "*" ? "WHERE id=$1" : "WHERE id=$1 AND user_email=$2";
  const { rows } = await p.query(`SELECT * FROM kaigi_sessions ${where}`, args);
  if (!rows.length) throw Object.assign(new Error("not found"), { status: 404 });
  return rows[0];
}

async function advanceSession(sessionId, userEmail) {
  const p = getPool();
  const session = await loadSession(sessionId, userEmail);
  const speakers = session.speakers;
  const { rows: msgRows } = await p.query(
    `SELECT speaker, content, seq FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion ORDER BY seq ASC`,
    [sessionId]
  );
  const history = msgRows.map((m) => ({ name: m.speaker, text: m.content }));
  const nextSeq = msgRows.length;
  const nextSpeakerObj = speakers[nextSeq % speakers.length];
  const { provider, prompt, roundNum } = buildSpeakerPrompt({
    topic: session.topic,
    speakers,
    history,
    nextSpeaker: nextSpeakerObj.name,
  });
  const { text: raw, modelUsed } = await callByProvider(provider, prompt, { web: true });
  const text = raw.trim().replace(/^[「『"']/, "").replace(/[」』"']$/, "");
  const { rows: insRows } = await p.query(
    `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [sessionId, nextSpeakerObj.name, provider, text, modelUsed, roundNum, nextSeq]
  );
  await p.query("UPDATE kaigi_sessions SET updated_at=now() WHERE id=$1", [sessionId]);
  return {
    id: insRows[0].id,
    speaker: nextSpeakerObj.name,
    provider,
    content: text,
    modelUsed,
    roundNum,
    seq: nextSeq,
    createdAt: insRows[0].created_at,
  };
}

async function concludeSession(sessionId, userEmail) {
  const p = getPool();
  const session = await loadSession(sessionId, userEmail);
  const { rows: msgRows } = await p.query(
    `SELECT speaker, content FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion ORDER BY seq ASC`,
    [sessionId]
  );
  if (!msgRows.length) throw Object.assign(new Error("発言が無いと結論は出せません"), { status: 400 });
  const history = msgRows.map((m) => ({ name: m.speaker, text: m.content }));
  const { provider, prompt } = buildConclusionPrompt({
    topic: session.topic,
    speakers: session.speakers,
    history,
  });
  const { text: raw, modelUsed } = await callByProvider(provider, prompt, { web: false });
  const text = raw.trim();
  await p.query(
    `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_conclusion)
     VALUES ($1, '結論', $2, $3, $4, 0, -1, true)`,
    [sessionId, provider, text, modelUsed]
  );
  await p.query("UPDATE kaigi_sessions SET status='completed', updated_at=now() WHERE id=$1", [sessionId]);
  return { content: text, modelUsed, provider };
}

// 一覧
app.get("/api/kaigi/sessions", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT s.id, s.topic, s.status, s.auto_rounds_remaining, s.last_error, s.created_at, s.updated_at,
              (SELECT count(*)::int FROM kaigi_messages m WHERE m.session_id = s.id AND NOT m.is_conclusion) AS msg_count,
              EXISTS(SELECT 1 FROM kaigi_messages m WHERE m.session_id = s.id AND m.is_conclusion) AS has_conclusion
         FROM kaigi_sessions s
        WHERE s.user_email = $1
        ORDER BY s.updated_at DESC
        LIMIT 100`,
      [req.user.email]
    );
    res.json(rows);
  } catch (err) {
    console.error("kaigi list", err);
    res.status(500).json({ error: err.message });
  }
});

// 作成
app.post("/api/kaigi/sessions", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const { topic, speakers } = req.body || {};
  if (!topic || !Array.isArray(speakers) || speakers.length < 2) {
    return res.status(400).json({ error: "topic, speakers (2人以上) required" });
  }
  try {
    const { rows } = await p.query(
      `INSERT INTO kaigi_sessions (user_email, topic, speakers)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, topic, speakers, status, auto_rounds_remaining, created_at, updated_at`,
      [req.user.email, topic, JSON.stringify(speakers)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("kaigi create", err);
    res.status(500).json({ error: err.message });
  }
});

// 詳細＋メッセージ
app.get("/api/kaigi/sessions/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const session = await loadSession(req.params.id, req.user.email);
    const { rows: messages } = await p.query(
      `SELECT id, speaker, provider, content, model_used AS "modelUsed", round_num AS "roundNum", seq, is_conclusion AS "isConclusion", created_at AS "createdAt"
         FROM kaigi_messages WHERE session_id=$1 ORDER BY is_conclusion ASC, seq ASC, id ASC`,
      [req.params.id]
    );
    res.json({ session, messages });
  } catch (err) {
    console.error("kaigi detail", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 削除
app.delete("/api/kaigi/sessions/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rowCount } = await p.query(
      "DELETE FROM kaigi_sessions WHERE id=$1 AND user_email=$2",
      [req.params.id, req.user.email]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    console.error("kaigi delete", err);
    res.status(500).json({ error: err.message });
  }
});

// 次の1発言を生成して保存
app.post("/api/kaigi/sessions/:id/next", async (req, res) => {
  try {
    const msg = await advanceSession(req.params.id, req.user.email);
    res.json(msg);
  } catch (err) {
    console.error("kaigi next", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 結論生成
app.post("/api/kaigi/sessions/:id/conclude", async (req, res) => {
  try {
    const r = await concludeSession(req.params.id, req.user.email);
    res.json(r);
  } catch (err) {
    console.error("kaigi conclude", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// B: 自動進行開始（指定ラウンド数まで Cloud Tasks で chain dispatch）
app.post("/api/kaigi/sessions/:id/auto", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const rounds = Math.min(Math.max(parseInt(req.body?.rounds || "3", 10), 1), 10);
  try {
    const { rowCount } = await p.query(
      `UPDATE kaigi_sessions SET status='auto', auto_rounds_remaining=$1, last_error=NULL, updated_at=now()
         WHERE id=$2 AND user_email=$3`,
      [rounds, req.params.id, req.user.email]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    const taskName = await enqueueKaigiTick(Number(req.params.id), 0);
    res.json({ ok: true, rounds, taskQueued: !!taskName, note: taskName ? null : "Cloud Tasks 未設定のため enqueue されていません" });
  } catch (err) {
    console.error("kaigi auto", err);
    res.status(500).json({ error: err.message });
  }
});

// 自動進行を止める
app.post("/api/kaigi/sessions/:id/auto/stop", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rowCount } = await p.query(
      `UPDATE kaigi_sessions SET status='active', auto_rounds_remaining=0, updated_at=now()
         WHERE id=$1 AND user_email=$2`,
      [req.params.id, req.user.email]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 内部: Cloud Tasks コールバック → 1発言進める → 残ラウンドあれば次の tick を enqueue
app.post("/api/internal/kaigi/tick", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const session = await loadSession(sessionId, "*");
    if (session.status !== "auto") {
      console.log(`[tick] session ${sessionId} not in auto (${session.status}), stop`);
      return res.json({ stopped: true });
    }
    const speakers = session.speakers;
    const { rows: cntRows } = await p.query(
      `SELECT COUNT(*)::int AS n FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion`,
      [sessionId]
    );
    const seqBefore = cntRows[0].n;
    const seqInRound = seqBefore % speakers.length;

    await advanceSession(sessionId, "*");

    // 1ラウンド完了したら remaining --、0 になったら conclude
    if (seqInRound === speakers.length - 1) {
      const { rows: rRows } = await p.query(
        `UPDATE kaigi_sessions SET auto_rounds_remaining = auto_rounds_remaining - 1, updated_at=now()
           WHERE id=$1 RETURNING auto_rounds_remaining`,
        [sessionId]
      );
      if (rRows[0].auto_rounds_remaining <= 0) {
        await concludeSession(sessionId, "*");
        return res.json({ done: true });
      }
    }
    // 4秒空けて次の tick（連続 API 叩きの軽減）
    await enqueueKaigiTick(Number(sessionId), 4);
    res.json({ ok: true });
  } catch (err) {
    console.error("kaigi tick", err);
    try {
      await getPool().query(
        `UPDATE kaigi_sessions SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`,
        [sessionId, String(err.message || err).slice(0, 1000)]
      );
    } catch (e2) { /* swallow */ }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────
// Records
// ─────────────────────────────
app.get("/api/records", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, date::text AS date, store, total, category,
              work_type AS "workType", payment, buyer, site, memo,
              image_url AS "imageUrl", created_at AS "createdAt"
         FROM records
        ORDER BY date DESC, id DESC LIMIT 1000`
    );
    res.json(rows);
  } catch (err) {
    console.error("list error", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/records", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = req.body || {};
    const { rows } = await p.query(
      `INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.imageUrl || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("insert error", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/records/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = req.body || {};
    const { rowCount } = await p.query(
      `UPDATE records SET
         date=$1, store=$2, total=$3, category=$4, work_type=$5,
         payment=$6, buyer=$7, site=$8, memo=$9
       WHERE id=$10`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("update error", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/records/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query("DELETE FROM records WHERE id = $1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("delete error", err);
    res.status(500).json({ error: err.message });
  }
});

// Signed URL for viewing a receipt image (gs:// → temporary https)
app.get("/api/records/:id/image", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!storage) return res.status(503).json({ error: "Storage not configured" });
  try {
    const { rows } = await p.query("SELECT image_url FROM records WHERE id=$1", [req.params.id]);
    const gs = rows[0]?.image_url;
    if (!gs || !gs.startsWith("gs://")) return res.status(404).json({ error: "no image" });
    const [, , bucket, ...rest] = gs.split("/");
    const objectPath = rest.join("/");
    const [url] = await storage
      .bucket(bucket)
      .file(objectPath)
      .getSignedUrl({ action: "read", expires: Date.now() + 10 * 60 * 1000 });
    res.json({ url });
  } catch (err) {
    console.error("image url error", err);
    res.status(500).json({ error: err.message });
  }
});

if (DEV) {
  // Cloud Shell 即プレビュー用：本番(Firebase Hosting)と同じ構成を1プロセスで再現。
  //  - /api/**         → 上で定義済み（本番の Hosting rewrite と同一オリジン）
  //  - /__/firebase/init.json → 本番Hostingが配る Firebase 設定をローカルでも提供
  //  - それ以外        → リポジトリ root の apps/ 配下の静的ファイル（ランチャー & 各ミニアプリ）
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const webDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../.."
  );
  app.get("/__/firebase/init.json", (req, res) => {
    try {
      res.type("application/json").send(readFileSync(FIREBASE_INIT_JSON, "utf8"));
    } catch (e) {
      res.status(500).json({ error: "FIREBASE_INIT_JSON 未設定: " + e.message });
    }
  });
  // dev は cloudshell.dev ドメインで Firebase ログイン不可 → フロントに
  // ログインスキップを指示（サーバ側 /api も DEV でバイパス済み）。
  app.get("/config.js", (req, res) =>
    res.type("application/javascript")
       .send("window.API_BASE='';window.DEV_NO_AUTH=true;")
  );
  app.use(express.static(webDir, { extensions: ["html"] }));
  console.log(`[DEV] serving frontend from ${webDir}`);
} else {
  // 本番: フロントは Firebase Hosting が配信。本サービスは API 専用。
  app.get("/", (req, res) =>
    res.json({ service: "keihi-api", ui: "served by Firebase Hosting" })
  );
}

app.listen(PORT, () => console.log(`keihi-api listening on ${PORT} (DEV=${!!DEV})`));
