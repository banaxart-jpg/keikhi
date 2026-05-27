import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Storage } from "@google-cloud/storage";
import { CloudTasksClient } from "@google-cloud/tasks";
import { google } from "googleapis";
import admin from "firebase-admin";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  RECEIPTS_BUCKET,
  SHEET_ID,
  INVOICE_SHEET_ID,
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
// trim() で改行・空白の混入（openssl rand を data-file=- で入れた時に末尾改行が
// 入りがち）を吸収する。
const INTERNAL_TICK_SECRET = (process.env.INTERNAL_TICK_SECRET || "").trim();
app.use("/api", async (req, res, next) => {
  if (req.path.startsWith("/internal/")) {
    const got = (req.headers["x-tick-secret"] || "").trim();
    if (!INTERNAL_TICK_SECRET || got !== INTERNAL_TICK_SECRET) {
      console.warn(`[internal] forbidden: secret present=${!!INTERNAL_TICK_SECRET} match=${got === INTERNAL_TICK_SECRET}`);
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

// ───── Google Sheets (経費レコードの自動書き込み) ─────
// SHEET_ID が設定されていればサーバから直接 Sheets API で行を append。
// ADC (Cloud Run の SA = keihi-run) で認証。SA をシートに編集者として共有する必要あり。
let sheetsApi = null;
async function getSheetsApi() {
  if (sheetsApi) return sheetsApi;
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsApi = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsApi;
}
const SHEET_HEADER = ["購入日", "購入者", "現場", "店舗", "金額", "費目", "工種", "支払方法", "メモ", "写真"];
const sheetEnsuredCache = new Set(); // key = "<spreadsheetId>:<tab>" 1 度ヘッダー作ったタブはキャッシュ
async function ensureSheetTabGeneric(sheets, spreadsheetId, ym, header) {
  const key = `${spreadsheetId}:${ym}`;
  if (sheetEnsuredCache.has(key)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  const exists = (meta.data.sheets || []).some((s) => s.properties && s.properties.title === ym);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ym, index: 0, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ym}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [header] },
    });
  }
  sheetEnsuredCache.add(key);
}
async function ensureSheetTab(sheets, ym) {
  return ensureSheetTabGeneric(sheets, SHEET_ID, ym, SHEET_HEADER);
}
async function appendRecordToSheet(r) {
  if (!SHEET_ID) return;
  // 現場が未設定 (未 SORT) のレコードはシートに送らない
  if (!r.site) return;
  try {
    const sheets = await getSheetsApi();
    const ym = String(r.date || "").slice(0, 7) || "unknown";
    await ensureSheetTab(sheets, ym);
    // 「写真」セルはアプリ内ビューアへの HYPERLINK
    const viewUrl = r.id ? `https://keihi-496002.web.app/keihi/?view=${r.id}` : "";
    const photoCell = viewUrl ? `=HYPERLINK("${String(viewUrl).replace(/"/g, '""')}","🧾")` : "";
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${ym}!A:J`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          r.date || "", r.buyer || "", r.site || "", r.store || "",
          Number(r.total) || 0, r.category || "", r.workType || "",
          r.payment || "", r.memo || "", photoCell,
        ]],
      },
    });
    console.log(`[sheets] appended id=${r.id} ym=${ym} site=${r.site}`);
  } catch (e) {
    console.warn(`[sheets] append FAILED id=${r.id}: ${e.message}`);
  }
}

// ───── 請求書 (seikyu) 用 Sheets append ─────
// クライアントから直接エンドポイントを叩く方式 (請求書は localStorage 管理で DB なし)。
const INVOICE_HEADER = ["方向", "発行日", "期限", "状態", "完了日", "発行元/請求先", "金額", "分類", "現場", "銀行", "支店", "種別", "口座番号", "名義", "メモ"];
async function appendInvoiceToSheet(r) {
  if (!INVOICE_SHEET_ID) return { skipped: true };
  try {
    const sheets = await getSheetsApi();
    const ym = String(r.issueDate || (r.createdAt || "").slice(0, 10) || "").slice(0, 7) || "unknown";
    await ensureSheetTabGeneric(sheets, INVOICE_SHEET_ID, ym, INVOICE_HEADER);
    const acc = r.account || {};
    const dir = r.direction === "out" ? "受取" : "支払";
    const statusLbl = r.status === "paid"
      ? (r.direction === "out" ? "入金済" : "支払済")
      : (r.direction === "out" ? "未入金" : "未払い");
    await sheets.spreadsheets.values.append({
      spreadsheetId: INVOICE_SHEET_ID,
      range: `${ym}!A:O`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          dir, r.issueDate || "", r.dueDate || "", statusLbl, r.paidAt || "",
          r.issuer || "", Number(r.total) || 0, r.category || "", r.site || "",
          acc.bank || "", acc.branch || "", acc.type || "", acc.number || "",
          acc.holder || "", r.memo || "",
        ]],
      },
    });
    console.log(`[invoice-sheets] appended ym=${ym} issuer=${r.issuer} dir=${dir}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[invoice-sheets] FAILED: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

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

// 請求書アプリ (seikyu) からのスプレッドシート連携 (INVOICE_SHEET_ID に append)
app.post("/api/invoice-sheet", async (req, res) => {
  const result = await appendInvoiceToSheet(req.body || {});
  res.json(result);
});

app.post("/api/scan", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { image, mimeType = "image/jpeg", sites = [], kind = "receipt", direction = "in" } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64) is required" });

    let imageUrl = null;
    // PDF は GCS にもアップロードしておく（後から見返せる用）
    // 保存に失敗しても AI 読取は続行（一覧の 🧾 アイコンが出ない不具合を切り分け易く）
    if (storage && RECEIPTS_BUCKET) {
      const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
      const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
      try {
        await storage
          .bucket(RECEIPTS_BUCKET)
          .file(key)
          .save(Buffer.from(image, "base64"), { contentType: mimeType, resumable: false });
        imageUrl = `gs://${RECEIPTS_BUCKET}/${key}`;
        console.log(`[scan] uploaded ${imageUrl} (${Buffer.from(image, "base64").length} bytes, ${mimeType})`);
      } catch (e) {
        console.warn(`[scan] GCS upload FAILED (bucket=${RECEIPTS_BUCKET}, key=${key}): ${e.code || ""} ${e.message}`);
      }
    } else {
      console.warn(`[scan] image not saved (storage=${!!storage}, bucket=${RECEIPTS_BUCKET || "(empty)"})`);
    }

    const today = new Date().toISOString().slice(0, 10);
    // kind="invoice" は請求書 / 払込票 / 通知書 のスキャン。
    //   direction="in" : 自社が受け取った請求書 → issuer = 発行元（取引先）
    //   direction="out": 自社が発行した請求書 → issuer = 宛先（取引先）
    // kind="receipt" (default) は既存の領収書スキャン。
    let prompt;
    if (kind === "invoice") {
      const accountFmt = `"account":{"bank":"銀行名（〇〇銀行 / ゆうちょ銀行 等。無ければ空文字）","branch":"支店名（〇〇支店 / 〇〇番号 等。無ければ空文字）","type":"普通 or 当座 or 貯蓄 or 振替 or 空文字","number":"口座番号（数字のみ、ハイフン除去）","holder":"口座名義（記載通り。カナでも漢字でも空文字でも）"}`;
      const siteFmt = `"site":"${sites.join(" or ") || "(空文字でOK)"}から最も近いものまたは空文字（建築現場名 / 工事名 / 案件名から判断）"`;
      if (direction === "out") {
        prompt = `画像/PDF は自社が発行した請求書です。全て検出して JSON のみ返してください。形式:
{"receipts":[{"issuer":"請求先（宛先の会社名・個人名。「株式会社」等は省略可）","total":請求金額の数値,"dueDate":"YYYY-MM-DD(入金期限。読めなければ空文字)","issueDate":"YYYY-MM-DD(発行日。読めなければ${today})","category":"工事代金 or その他",${siteFmt},${accountFmt},"memo":"工事名 / 件名 / 摘要を短く"}]}`;
      } else {
        prompt = `画像/PDF は自社が受け取った請求書 / 払込票 / 通知書です。全て検出して JSON のみ返してください。形式:
{"receipts":[{"issuer":"発行元（東京電力 / 東京ガス / 〇〇税務署 / 取引先名 等。「株式会社」等は省略可）","total":請求金額の数値,"dueDate":"YYYY-MM-DD(支払期限。読めなければ空文字)","issueDate":"YYYY-MM-DD(発行日。読めなければ${today})","category":"光熱費 or 通信費 or 税金 or 家賃 or 保険料 or 外注費 or 工事代金 or その他",${siteFmt},${accountFmt},"memo":"備考があれば短く（請求番号 / 使用期間 等）"}]}`;
      }
    } else {
      prompt = `画像内の領収書を全て検出してJSONのみ返してください。複数並んでいる場合は全部を要素にした配列にする。1枚しか無くても要素1の配列。形式:
{"receipts":[{"date":"YYYY-MM-DD(無ければ${today})","store":"店舗名","total":合計金額の数値,"category":"材料費 or 接待交際費 or ガソリン代 or 駐車場代 or 工具・備品 or 外注費 or その他","workType":"水道 or 電気 or 木工 or 塗装 or 左官 or 内装 or 外構 or 解体 or 設備 or その他","site":"${sites.join(" or ") || "(空文字でOK)"}から最も近いものまたは空文字"}]}`;
    }
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
      : (raw && (raw.store || raw.total || raw.date || raw.issuer)) ? [raw] : [];
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
// 安定確認済みのため最上位モデル（Pro / Opus / GPT-5）に戻し、出力長も拡張。
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEBATE_MAX_TOKENS = 2000;

async function callByProvider(provider, prompt, { web = true } = {}) {
  if (provider === "claude" && ANTHROPIC_API_KEY) {
    // Anthropic native web search (web_search_20250305)
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: DEBATE_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
        ...(web ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
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
    // GPT-5 (full) + web search。reasoning model なので max_output_tokens は
    // reasoning + visible の合算。effort 'medium' の余裕を見て 8000 確保。
    // 'minimal' は web_search と併用不可（API 制約）→ web ON 時は 'medium'。
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: "gpt-5",
        input: prompt,
        max_output_tokens: 8000,
        reasoning: { effort: web ? "medium" : "minimal" },
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
  // Gemini (本物 or 他 provider のフォールバック)。会社方針議論なので Pro 固定。
  const { result, modelUsed } = await callGeminiWithFallback(prompt, {
    primaryModel: "gemini-2.5-pro",
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
  // system note は会話に挟む。スピーチだけを round 計算に使う
  const speeches = history.filter((h) => !h.isSystemNote);
  const log = history.length
    ? history.map((h) => h.isSystemNote
        ? `（システム通知）${h.text}`
        : `${h.name}：${h.text}`).join("\n")
    : "（まだ誰も発言していない）";
  const roundNum = Math.floor(speeches.length / speakers.length) + 1;
  const stageHint = roundNum === 1
    ? "今は最初のラウンドです。お題に対する自分の視点・前提を出してください。"
    : roundNum === 2
    ? "2ラウンド目です。他の参加者の視点と自分の視点を統合し、合意できる点とまだズレている点を整理してください。"
    : "3ラウンド目以降です。そろそろお題への答えに収束させるフェーズ。前のラウンドで出た合意を踏まえて、お題への結論につながる発言をしてください。";

  const prompt = `あなたは ${meLabel} です。
今、複数社の AI が集まって、1つのお題について議論しています。目的は最後にお題に対する明確な答えを出すことです。

これはディベート（勝ち負けを決める競技）ではありません。3者で同じ目標——お題に対する根拠ある答え——に向かって、互いの視点を統合しながら詰めていく作業です。

お題：
「${topic}」

【お題に対する答えの形】
お題の問いに合わせて答えてください。お題から外れた一般論や、お題と無関係なマイクロアクションに脱線しないこと。
- 未来予測（「どうなるか」「どう進化するか」）→ 時系列で根拠ある状態を提示。「3年後/10年後はこうなる」と踏み込む
- 経営判断（「やるべきか」「投資すべきか」）→ 立場を明確にし、実行可能性とリスクまで踏み込む
- 比較（「A と B どっち」）→ どっちを選ぶか、なぜ
- 分析・考察（「なぜ」「どう捉えるべき」）→ 結論となる解釈を提示

【現在のフェーズ】
${stageHint}

【スタンス】
- 直前の発言を踏まえて、議論を前進させる
- 同意できる点はそのまま同意し、足りない観点があれば補い、前提のずれがあれば整理する
- 反論のための反論はしない。違う視点を出すときは「なぜそれが重要か」と「どう統合できるか」も添える
- 「ケースバイケース」「状況による」のような逃げは禁止
- 議論が深まってきたら、お題への答えを能動的に提案する

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

あなた（${me.name}）の番です。300〜600字程度で発言してください。論理を展開できる長さで。名前プレフィックス・マークダウン・箇条書き記号は不要、自然な話し言葉で本文だけ。
発言:`;
  return { provider, prompt, roundNum };
}

function buildConclusionPrompt({ topic, speakers, history }) {
  const names = speakers.map((s) => s.name).join("・");
  const log = history.length
    ? history.map((h) => h.isSystemNote
        ? `（システム通知）${h.text}`
        : `${h.name}：${h.text}`).join("\n")
    : "（発言なし）";
  const prompt = `あなたは、上記の議論には参加していない第三者の議事ファシリテーター AI です。
今、Anthropic の Claude、Google の Gemini、OpenAI の GPT という3つの AI がお題について議論を交わしました。
あなたの役割は、3者の発言を俯瞰し、お題の問いに対する答えを断定的に、**かつ業界外の読者でも1回で理解できる平易な言葉で**提示することです。議論には自分の意見を足さず、ログに書かれていることだけを根拠に、お題から外れない形でまとめてください。

読み手は経営者ですが、その業界の専門家とは限りません。業界用語・カタカナビジネス用語・英語略語は、初出時に必ず日本語で意味を補足するか、平易な言葉に言い換えてください。

お題：
「${topic}」

参加者: ${names}

議論ログ:
${log}

【お題に対する答えの形】
お題の性質を判定し、それに合わせた答えを出してください：
- 未来予測（「どうなるか」「どう進化するか」）→ 「◯◯年後はこうなる」と時系列で根拠ある状態を断定
- 経営判断（「やるべきか」「投資すべきか」「どう対応するか」）→ 「やる/やらない」を断定し実行プランまで
- 比較（「A と B どっち」）→ どちらを選ぶか、なぜ
- 分析・考察（「なぜ」「どう捉えるべき」）→ 結論となる解釈

お題が未来予測なのに「◯週間で何をやる」のようなマイクロアクションに着地させない。お題が経営判断なのに「業界はこうなる」みたいな展望で終わらせない。**お題の問いに直接答える**こと。

【出力形式】プレーンテキストで、見出しは下記の【】記号付きで厳密に区切る。マークダウン・箇条書き記号は使わない。

【ひと言結論】
50文字以内・1文。お題の問いに対する答えを「◯◯である」「◯◯になる」「◯◯すべき」と断定形で。新聞の見出しのように、お題を読まずとも何の答えかが分かる形。曖昧表現禁止。

【結論】
全体で 500〜700 字。読み手が忙しい中で読んでも理解できるよう、**段落を空行で 3〜4 つに区切って** 以下の流れで書く。各段落の冒頭にラベルや見出しは付けず、本文だけ書く。マークダウン・箇条書き記号は使わない。

第1段落（80〜120字）: 結論本体。ひと言結論を膨らませて「答え＋一番大事な根拠」を 2〜3 文で。
第2段落（180〜240字）: 根拠の詳細。議論で出た事実・出典・数値を引用して 3 つ程度の柱で示す。「(出典: ◯◯)」「(◯◯によれば〜)」を本文中に必ず織り込む。
第3段落（120〜180字）: 実行 / 前提条件 / 撤退ライン。お題が経営判断系なら具体的な実行ステップを書く。未来予測系なら「この結論が崩れる前提条件」を書く。
第4段落（任意・80〜120字）: 注意点や見落としやすいポイントがあれば追加。なくてもよい。

【3者の立場の違い / 未解決の論点】
合意しきれなかった点があれば 1〜2 文で。完全合意なら「無し」と1単語で書く。

ルール:
- 「ケースバイケース」「状況による」「検討が必要」のような逃げは禁止
- 議論ログで根拠が出ていない主張は結論に含めない
- 議論には自分の意見を足さない。ログを統合・整理するだけ
- お題から外れた一般論で水増ししない
- 必ず3つの【】見出しを順番通りに出力すること

【専門用語ルール】業界外の読者でも1回で理解できる文章にする
- カタカナビジネス用語・英語略語・業界専門用語（SaaS / ARR / PMF / マルチテナント / ロールアップ / コンベックス / 縦切り / クローズド / 一次データ / ライブショールーム など）は **初出時に必ずカッコで日本語の意味を補足する**。または平易な言葉に言い換える。
- 例: ❌「縦切り SaaS で連続エグジット」
  ✅「特定の業務に絞った月額課金型ソフト（SaaS）を作って育て、3〜7年で売却を繰り返す」
- 例: ❌「ARR 約6.6倍を目安に、ARR1〜3億円規模で10〜30億円レンジの売却」
  ✅「年間契約金額（ARR）の約6.6倍が売却額の目安。年間契約金額が1〜3億円のときに10〜30億円で売れる計算」
- 例: ❌「PMF を達成」
  ✅「『これは欲しい』と顧客が言う状態（PMF = プロダクト・マーケット・フィット）を作る」
- 一般的な「DX」「AI」「SaaS」程度なら一度説明すれば以降は略してよい。ただし1回は説明する。
- 「ブティック建設事業」「スマート旅館」のような造語が議論に出ていたら、結論側で「BANAXが造った言葉で言えば」「具体的には〜」と必ず1文で意味を説明する。
- 読み手は経営者だが、その業界の言葉を全部知っているとは限らない前提で書く。`;
  return { provider: "claude", prompt };
}

// ─────────────────────────────
// 議論履歴の圧縮（コンテキスト長対策）
// ─────────────────────────────
// お題（topic / topic_summary）は呼び出し側で必ずプロンプトに含めるので、
// ここでは履歴のみを扱う。直近2ラウンド以外（お題の詳細 system note や R1 を含む）
// をすべて要約して1つの system note に統合する。
async function maybeCompressHistory(history, speakerCount, topic) {
  const KEEP_RECENT = speakerCount * 2;  // 直近2ラウンド
  // 直近2R に加えて1ラウンド分の余裕があれば圧縮しない（3ラウンド未満の議論は無圧縮）
  if (history.length <= KEEP_RECENT + speakerCount) return history;

  const middle = history.slice(0, history.length - KEEP_RECENT);
  const tail = history.slice(history.length - KEEP_RECENT);
  if (!middle.length) return history;

  const middleText = middle.map((h) => h.isSystemNote
    ? `（システム通知）${h.text}`
    : `${h.name}：${h.text}`).join("\n");

  const prompt = `以下はあるお題についての議論のこれまでの部分です。長文の前提情報や各参加者の発言が含まれます。これを 500〜800 字で要約してください。

お題：「${topic}」

要約の要件:
- お題の前提・背景情報（人物像・略歴・状況など）で議論に必要な部分は保持する
- 各参加者がどの立場を取ったか、どんな根拠・出典・数値を出したかを保持
- 合意した点と意見が分かれた点を明示
- お題に直接関係しない雑談的な部分は削る
- 箇条書きや見出しは使わず、連続した文章で
- 「議論ログから読み取れる事実」だけを書く。要約者の意見は足さない

ログ:
${middleText}

要約:`;

  try {
    const { result } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 2500,
    });
    const summary = result.response.text().trim();
    return [
      {
        name: "司会",
        text: `[これまでの前提と議論の要約] ${summary}`,
        isSystemNote: true,
      },
      ...tail,
    ];
  } catch (e) {
    console.warn("[maybeCompressHistory] failed, falling back to truncation:", e.message);
    // 失敗時は古い部分を捨てる（落ちるよりまし）。直近2R + tail のみ。
    return [...tail];
  }
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
      // INTERNAL_TICK_SECRET は import 時に trim 済み
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
    `SELECT speaker, content, seq, is_system_note AS "isSystemNote"
       FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion AND NOT is_chat ORDER BY seq ASC`,
    [sessionId]
  );
  const rawHistory = msgRows.map((m) => ({ name: m.speaker, text: m.content, isSystemNote: m.isSystemNote }));
  // 次の speaker は「speech 数 % 3」で決める（system note は除外して順番計算）
  const speechCount = rawHistory.filter((h) => !h.isSystemNote).length;
  const nextSeq = msgRows.length;
  const nextSpeakerObj = speakers[speechCount % speakers.length];
  // 長文お題（略歴等）は topic_summary を優先使用、原文は履歴の system note 側にある
  const effectiveTopic = session.topic_summary || session.topic;
  // 長い議論はコンテキスト圧縮（直近2R は残し、それ以前を要約）
  const history = await maybeCompressHistory(rawHistory, speakers.length, effectiveTopic);
  const { provider, prompt, roundNum } = buildSpeakerPrompt({
    topic: effectiveTopic,
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
    `SELECT speaker, content, is_system_note AS "isSystemNote"
       FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion AND NOT is_chat ORDER BY seq ASC`,
    [sessionId]
  );
  const speeches = msgRows.filter((m) => !m.isSystemNote);
  if (!speeches.length) throw Object.assign(new Error("発言が無いと結論は出せません"), { status: 400 });
  const rawHistory = msgRows.map((m) => ({ name: m.speaker, text: m.content, isSystemNote: m.isSystemNote }));
  // 長文お題（略歴等）は topic_summary を優先使用
  const effectiveTopic = session.topic_summary || session.topic;
  // 結論生成時もコンテキスト圧縮（議論が長くなるとファシリテーターが落ちるため）
  const history = await maybeCompressHistory(rawHistory, session.speakers.length, effectiveTopic);
  const { provider, prompt } = buildConclusionPrompt({
    topic: effectiveTopic,
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
      `SELECT s.id, s.topic, s.topic_summary AS "topicSummary", s.status, s.auto_rounds_remaining, s.extension_count, s.last_error, s.created_at, s.updated_at,
              (SELECT count(*)::int FROM kaigi_messages m WHERE m.session_id = s.id AND NOT m.is_conclusion AND NOT m.is_system_note AND NOT m.is_chat) AS msg_count,
              EXISTS(SELECT 1 FROM kaigi_messages m WHERE m.session_id = s.id AND m.is_conclusion) AS has_conclusion,
              (SELECT LEFT(m.content, 500) FROM kaigi_messages m
                 WHERE m.session_id = s.id AND m.is_conclusion
                 ORDER BY m.created_at DESC LIMIT 1) AS conclusion_preview,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'id', m.id, 'content', LEFT(m.content, 800),
                  'createdAt', m.created_at
                ) ORDER BY m.created_at ASC)
                  FROM kaigi_messages m WHERE m.session_id = s.id AND m.is_conclusion),
                '[]'::json
              ) AS conclusions,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'content', LEFT(m.content, 400),
                  'createdAt', m.created_at
                ) ORDER BY m.created_at ASC)
                  FROM kaigi_messages m
                  WHERE m.session_id = s.id AND m.is_system_note
                    AND (m.content LIKE '%新しい議題%' OR m.content LIKE '%新議題%')),
                '[]'::json
              ) AS topic_changes
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

// 長いお題（略歴等）に対応: 「核の問い + 背景の要約」を Gemini Flash で生成
const LONG_TOPIC_THRESHOLD = 300;
async function summarizeTopicIfLong(topic) {
  if (!topic || topic.length <= LONG_TOPIC_THRESHOLD) return null;
  const sumPrompt = `次のお題は長文で、背景情報や前提条件を多く含みます。これから3つの AI がこのお題について議論するため、AI に渡すための「核となる問い」と「背景の要約」を抽出してください。

お題全文:
${topic}

出力形式 (厳密に従う、見出しは【】記号、マークダウン使わない):
【核の問い】
1〜2文で、AI が議論で答えるべき問いを抽出。お題から「何を聞いているのか」だけを取り出す。

【背景の要約】
400字以内で、議論で参照すべき前提・経歴・状況・条件を要約。固有名詞・数値・日付など重要な事実は保持する。要約者の意見は足さない。

出力:`;
  try {
    const { result } = await callGeminiWithFallback(sumPrompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 2000,
    });
    return result.response.text().trim();
  } catch (e) {
    console.warn("[summarizeTopic] failed:", e.message);
    return null;
  }
}

// 作成
app.post("/api/kaigi/sessions", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const { topic, speakers } = req.body || {};
  if (!topic || !Array.isArray(speakers) || speakers.length < 2) {
    return res.status(400).json({ error: "topic, speakers (2人以上) required" });
  }
  try {
    const topicSummary = await summarizeTopicIfLong(topic);
    const { rows } = await p.query(
      `INSERT INTO kaigi_sessions (user_email, topic, topic_summary, speakers)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, topic, topic_summary AS "topicSummary", speakers, status, auto_rounds_remaining, created_at, updated_at`,
      [req.user.email, topic, topicSummary, JSON.stringify(speakers)]
    );
    // 長文お題の原文は seq=0 の system note として履歴に挿入（圧縮対象になる）
    if (topicSummary) {
      await p.query(
        `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_system_note)
         VALUES ($1, '司会', 'system', $2, NULL, 0, 0, true)`,
        [rows[0].id, `[お題の詳細全文]\n${topic}`]
      );
    }
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
      `SELECT id, speaker, provider, content, model_used AS "modelUsed", round_num AS "roundNum", seq,
              is_conclusion AS "isConclusion", is_system_note AS "isSystemNote", is_chat AS "isChat",
              created_at AS "createdAt"
         FROM kaigi_messages WHERE session_id=$1 ORDER BY created_at ASC, id ASC`,
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

// リセット: メッセージ全削除、status を active に戻す（セッション自体は残す）
app.post("/api/kaigi/sessions/:id/reset", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rowCount } = await p.query(
      `UPDATE kaigi_sessions SET status='active', auto_rounds_remaining=0, last_error=NULL, updated_at=now()
         WHERE id=$1 AND user_email=$2`,
      [req.params.id, req.user.email]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    await p.query("DELETE FROM kaigi_messages WHERE session_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("kaigi reset", err);
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

// 延長: 結論に納得いかない時、議題を編集して（or そのまま）もう3ラウンド
app.post("/api/kaigi/sessions/:id/extend", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const rounds = Math.min(Math.max(parseInt(req.body?.rounds || "3", 10), 1), 10);
  const newTopic = typeof req.body?.newTopic === "string" ? req.body.newTopic.trim() : null;
  try {
    const session = await loadSession(req.params.id, req.user.email);
    const oldTopic = session.topic;
    const topicChanged = newTopic && newTopic !== oldTopic;

    if (topicChanged) {
      await p.query("UPDATE kaigi_sessions SET topic=$1 WHERE id=$2", [newTopic, req.params.id]);
    }

    // 会話履歴に system note を残して、次のラウンドの AI が認識できるようにする
    const { rows: cntRows } = await p.query(
      "SELECT COUNT(*)::int AS n FROM kaigi_messages WHERE session_id=$1",
      [req.params.id]
    );
    const noteText = topicChanged
      ? `ユーザーが先ほどの結論に納得していません。さらに議題を編集して再検討を求めています。旧議題:「${oldTopic}」→ 新議題:「${newTopic}」。この変更を踏まえて議論を続けてください。これまでの議論で出た論点・前提のうち、新議題にも使えるものは引き継ぎつつ、新しい角度で詰め直してください。`
      : `ユーザーが先ほどの結論に納得していません。議題は変わっていませんが、もう一度別の角度から3ラウンド深く検討し直してください。これまでの結論を繰り返すのではなく、別の前提・別の解決策・前回見落とした観点を意識的に出してください。`;

    await p.query(
      `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_system_note)
       VALUES ($1, '司会', 'system', $2, NULL, 0, $3, true)`,
      [req.params.id, noteText, cntRows[0].n]
    );

    await p.query(
      `UPDATE kaigi_sessions
         SET status='auto',
             auto_rounds_remaining=$1,
             extension_count=extension_count+1,
             last_error=NULL,
             updated_at=now()
       WHERE id=$2 AND user_email=$3`,
      [rounds, req.params.id, req.user.email]
    );
    const taskName = await enqueueKaigiTick(Number(req.params.id), 0);
    res.json({ ok: true, topicChanged, taskQueued: !!taskName });
  } catch (err) {
    console.error("kaigi extend", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────
// kaigi: 結論後のチャット (アシスタント AI = Gemini Flash と1対1で対話)
// ─────────────────────────────
app.post("/api/kaigi/sessions/:id/chat", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const userMsg = String(req.body?.message || "").trim();
  if (!userMsg) return res.status(400).json({ error: "message required" });
  try {
    const session = await loadSession(req.params.id, req.user.email);
    const { rows: history } = await p.query(
      `SELECT speaker, content, is_conclusion AS "isConclusion",
              is_system_note AS "isSystemNote", is_chat AS "isChat",
              created_at AS "createdAt"
         FROM kaigi_messages WHERE session_id=$1 ORDER BY created_at ASC, id ASC`,
      [req.params.id]
    );
    const debateLog = history.filter((h) => !h.isChat)
      .map((h) => h.isConclusion ? `【結論】\n${h.content}`
        : h.isSystemNote ? `（システム通知）${h.content}`
        : `${h.speaker}: ${h.content}`).join("\n\n");
    // チャットは「最新の結論より後に行われたもの」だけを文脈に含める。
    // 前ラウンドの結論直下で交わしたチャットは、そのラウンドで完結したものとして
    // 扱い、新しいラウンドのアシスタントには引き継がない（議論本体は引き継ぐ）。
    const conclTimes = history.filter((h) => h.isConclusion).map((h) => new Date(h.createdAt).getTime());
    const lastConclTime = conclTimes.length ? Math.max(...conclTimes) : 0;
    const chatLog = history.filter((h) => h.isChat && new Date(h.createdAt).getTime() > lastConclTime)
      .map((h) => `${h.speaker}: ${h.content}`).join("\n\n");

    const prompt = `あなたは経営者と1対1で対話するアシスタント AI (Gemini Flash) です。
役割は、3つの AI (Gemini, Claude, GPT) が行った議論と結論について、ユーザーが疑問を解消したり、補足情報を加えたり、次の議題を一緒に練ったりするのを手助けすることです。

【お題】
${session.topic_summary || session.topic}

【3者の議論と結論】
${debateLog || "（まだなし）"}

${chatLog ? `【これまでのアシスタントとのチャット】\n${chatLog}\n\n` : ""}【ユーザーの新しい発言】
${userMsg}

【返答の方針】
- ユーザーの発言・質問にまず直接答える
- 議論で出た内容や結論を根拠に答える。議論にない事実は推測で答えず「議論の中では触れられていない」と素直に言う
- ユーザーが自分のアイデアや視点・追加情報を話している時は、それを受け止めて掘り下げる質問や、議論で出た内容との関係を返す。先回りで議題を提案したりアドバイスを被せたりしない
- ユーザーが**明示的に**「次の議題はどうしよう」「次は何を議論すべき？」「議題候補出して」と聞いてきた時**だけ**、議論を踏まえて 1〜3 個の議題候補を提案する。それ以外は議題提案しない
- 平易な言葉で、業界用語は補足説明する
- 150〜250 字程度で簡潔に。長く語らない
- マークダウン記号は使わず自然な文章で
返答:`;

    const { result, modelUsed } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 1500,
    });
    const reply = result.response.text().trim();

    const { rows: uRows } = await p.query(
      `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_chat)
       VALUES ($1, 'あなた', 'user', $2, NULL, 0,
         (SELECT COALESCE(MAX(seq),-1)+1 FROM kaigi_messages WHERE session_id=$1),
         true)
       RETURNING id, created_at`,
      [req.params.id, userMsg]
    );
    const { rows: aRows } = await p.query(
      `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_chat)
       VALUES ($1, 'アシスタント', 'gemini', $2, $3, 0,
         (SELECT COALESCE(MAX(seq),-1)+1 FROM kaigi_messages WHERE session_id=$1),
         true)
       RETURNING id, created_at`,
      [req.params.id, reply, modelUsed]
    );
    await p.query("UPDATE kaigi_sessions SET updated_at=now() WHERE id=$1", [req.params.id]);
    res.json({
      user: { id: uRows[0].id, speaker: "あなた", content: userMsg, isChat: true, createdAt: uRows[0].created_at },
      assistant: { id: aRows[0].id, speaker: "アシスタント", provider: "gemini", content: reply, modelUsed, isChat: true, createdAt: aRows[0].created_at },
    });
  } catch (err) {
    console.error("kaigi chat", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// チャット履歴から次の議題を自動生成 → 第2ラウンド開始
app.post("/api/kaigi/sessions/:id/start-from-chat", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const rounds = Math.min(Math.max(parseInt(req.body?.rounds || "3", 10), 1), 10);
  try {
    const session = await loadSession(req.params.id, req.user.email);
    // 最新の結論以降のチャットだけを「今のラウンドのチャット」として扱う
    const { rows: lastConclRows } = await p.query(
      `SELECT created_at FROM kaigi_messages
         WHERE session_id=$1 AND is_conclusion=true
         ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    const lastConclTime = lastConclRows[0]?.created_at || new Date(0);
    const { rows: chatRows } = await p.query(
      `SELECT speaker, content FROM kaigi_messages
         WHERE session_id=$1 AND is_chat=true AND created_at > $2
         ORDER BY created_at ASC, id ASC`,
      [req.params.id, lastConclTime]
    );
    if (!chatRows.length) return res.status(400).json({ error: "最新ラウンドのチャットが空です。何か話してから押してください。" });
    const chatLog = chatRows.map((c) => `${c.speaker}: ${c.content}`).join("\n\n");

    const topicGenPrompt = `以下は、ある議題について 3 つの AI が議論して結論を出した後、ユーザーがアシスタント AI と次に何を議論すべきかを話し合った内容です。

【前のお題】
${session.topic_summary || session.topic}

【ユーザーとアシスタントのチャット】
${chatLog}

このチャットから、次のラウンドで議論すべき具体的なお題を 1 つ抽出してください。
- ユーザーが明示的に「次は X を議論したい」と言っていればそれを使う
- 明示されていなければ、チャットの流れから自然に導かれる議題を作る
- ユーザーがチャットで提供した追加情報や前提があれば、お題に組み込む

出力形式: お題本文だけを 1 つ。前置きや「次の議題は〜」のような枕詞は付けない。30〜200 字程度。`;

    const { result } = await callGeminiWithFallback(topicGenPrompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 1500,
    });
    const newTopic = result.response.text().trim();
    if (!newTopic) throw new Error("議題の生成に失敗しました");

    const oldTopic = session.topic;
    const newSummary = await summarizeTopicIfLong(newTopic);
    await p.query(
      `UPDATE kaigi_sessions SET topic=$1, topic_summary=$2 WHERE id=$3`,
      [newTopic, newSummary, req.params.id]
    );

    const oldTopicShort = oldTopic.length > 200 ? oldTopic.slice(0, 200) + "…" : oldTopic;
    const { rows: cntRows } = await p.query(
      "SELECT COUNT(*)::int AS n FROM kaigi_messages WHERE session_id=$1",
      [req.params.id]
    );
    const noteText = `ユーザーが前の結論についてアシスタントとチャットし、その内容から次の議題を抽出しました。これまでの議論と結論、そしてチャットで補強された前提を踏まえて新議題に取り組んでください。

【前のテーマ】
${oldTopicShort}

【チャットから生成された次の議題】
${newTopic}`;

    await p.query(
      `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_system_note)
       VALUES ($1, '司会', 'system', $2, NULL, 0, $3, true)`,
      [req.params.id, noteText, cntRows[0].n]
    );

    await p.query(
      `UPDATE kaigi_sessions SET status='auto', auto_rounds_remaining=$1, extension_count=extension_count+1, last_error=NULL, updated_at=now()
         WHERE id=$2`,
      [rounds, req.params.id]
    );
    const taskName = await enqueueKaigiTick(Number(req.params.id), 0);
    res.json({ ok: true, newTopic, taskQueued: !!taskName });
  } catch (err) {
    console.error("kaigi start-from-chat", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// cost アプリ用: ユーザー自身の kaigi 全メッセージのコスト集計用データを返す
app.get("/api/kaigi/messages-summary", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT m.provider, m.model_used AS "modelUsed", m.is_conclusion AS "isConclusion",
              m.is_system_note AS "isSystemNote", m.created_at AS "createdAt"
         FROM kaigi_messages m
         JOIN kaigi_sessions s ON m.session_id = s.id
        WHERE s.user_email = $1
        ORDER BY m.created_at DESC
        LIMIT 20000`,
      [req.user.email]
    );
    res.json(rows);
  } catch (err) {
    console.error("kaigi cost summary", err);
    res.status(500).json({ error: err.message });
  }
});

// 次の議題に進む（前回の結論を踏まえて新議題で再スタート）
app.post("/api/kaigi/sessions/:id/next-topic", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const newTopic = String(req.body?.newTopic || "").trim();
  if (!newTopic) return res.status(400).json({ error: "newTopic required" });
  const rounds = Math.min(Math.max(parseInt(req.body?.rounds || "3", 10), 1), 10);
  try {
    const session = await loadSession(req.params.id, req.user.email);
    const oldTopic = session.topic;
    const { rows: conclRows } = await p.query(
      `SELECT content FROM kaigi_messages WHERE session_id=$1 AND is_conclusion ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    const lastConclusion = conclRows[0]?.content || "(前回の結論なし)";

    // 新議題が長文なら要約版生成
    const newSummary = await summarizeTopicIfLong(newTopic);
    await p.query(
      `UPDATE kaigi_sessions SET topic=$1, topic_summary=$2 WHERE id=$3`,
      [newTopic, newSummary, req.params.id]
    );

    // 前回テーマと結論を引き継ぐ system note
    const oldTopicShort = oldTopic.length > 200 ? oldTopic.slice(0, 200) + "…" : oldTopic;
    const { rows: cntRows } = await p.query(
      "SELECT COUNT(*)::int AS n FROM kaigi_messages WHERE session_id=$1",
      [req.params.id]
    );
    const noteText = `ユーザーが前の議論を踏まえて次の議題に進めました。これまでの議論と前回の結論を前提知識として持ったまま、新しい議題に取り組んでください。前回の論点を一から再説明する必要はありません。前回の結論からスムーズに新議題に発展させてください。

【前のテーマ】
${oldTopicShort}

【前のテーマの結論】
${lastConclusion}

【新しい議題】
${newTopic}`;

    await p.query(
      `INSERT INTO kaigi_messages (session_id, speaker, provider, content, model_used, round_num, seq, is_system_note)
       VALUES ($1, '司会', 'system', $2, NULL, 0, $3, true)`,
      [req.params.id, noteText, cntRows[0].n]
    );

    await p.query(
      `UPDATE kaigi_sessions SET status='auto', auto_rounds_remaining=$1, extension_count=extension_count+1, last_error=NULL, updated_at=now()
         WHERE id=$2`,
      [rounds, req.params.id]
    );
    const taskName = await enqueueKaigiTick(Number(req.params.id), 0);
    res.json({ ok: true, taskQueued: !!taskName });
  } catch (err) {
    console.error("kaigi next-topic", err);
    res.status(err.status || 500).json({ error: err.message });
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
    // ラウンド計算は speech だけで（system_note は除外）
    const { rows: cntRows } = await p.query(
      `SELECT COUNT(*)::int AS n FROM kaigi_messages WHERE session_id=$1 AND NOT is_conclusion AND NOT is_system_note AND NOT is_chat`,
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
    // status='failed' に書き換えない（Cloud Tasks の retry に救わせる）。
    // 連続失敗を見たければ last_error と updated_at だけ更新しておく。
    try {
      await getPool().query(
        `UPDATE kaigi_sessions SET last_error=$2, updated_at=now() WHERE id=$1`,
        [sessionId, String(err.message || err).slice(0, 1000)]
      );
    } catch (e2) { /* swallow */ }
    res.status(err.status || 500).json({ error: err.message });
  }
});


// ─────────────────────────────
// kotonoha: 「Claude Code に指示するための語彙」を一問一答で学ぶアプリ
// ─────────────────────────────

// ジャンルマスタ (~600ジャンル × 13グループ) を起動時に読み込み。
// genres.json はリポジトリ管理の SoT、コードからは参照のみ。
let KOTONOHA_GENRES_DATA = null;
let KOTONOHA_GENRE_TO_GROUP = new Map(); // genre名 → group_id
let KOTONOHA_GENRE_TARGET = new Map();   // genre名 → target_count
try {
  const raw = fs.readFileSync(path.join(__dirname, "kotonoha-genres.json"), "utf8");
  KOTONOHA_GENRES_DATA = JSON.parse(raw);
  for (const g of KOTONOHA_GENRES_DATA.groups || []) {
    for (const gen of g.genres || []) {
      KOTONOHA_GENRE_TO_GROUP.set(gen.name, g.id);
      KOTONOHA_GENRE_TARGET.set(gen.name, gen.target_count || 10);
    }
  }
  console.log(`[kotonoha] loaded ${KOTONOHA_GENRE_TO_GROUP.size} genres / ${KOTONOHA_GENRES_DATA.groups?.length || 0} groups`);
} catch (e) {
  console.warn("[kotonoha] genres.json load failed:", e.message);
}

// ジャンルマスタ取得 (フロント用)
app.get("/api/kotonoha/genres", (req, res) => {
  if (!KOTONOHA_GENRES_DATA) return res.status(503).json({ error: "genres not loaded" });
  res.json(KOTONOHA_GENRES_DATA);
});

// ユーザー初期化 / 取得
async function ensureKotonohaUser(p, email) {
  const display = String(email).split("@")[0] || "user";
  const { rows } = await p.query(
    `INSERT INTO kotonoha_users (user_email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_email) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [email, display]
  );
  return rows[0];
}

// 弱ジャンル選択: バックグラウンド AI 生成のターゲットを決める
// HTML 実物デモを AI に作らせて DB に保存 (genre ごとに1つキャッシュ)。
// UI部品も、CSSプロパティ (z-index / position fixed / flex 等の挙動) も対応。
async function generateUiDemo(p, genre, groupId) {
  if (!genAI) return null;
  const kindHint = groupId === "css_layout"
    ? "CSS プロパティ / レイアウト技法の挙動を見せる。可能ならスライダー or ボタンで値を変えて挙動が変わる例にする/before-after の2例を並べる/動きをトグルする等で『何が変わるか』が一目で分かるようにする。"
    : "UI 部品の最小実物例。ユーザーが押す/触れる要素を最低1つ含める。";
  const prompt = `「${genre}」について、ユーザーが触って挙動を体感できる、独立した HTML スニペットを作って。

種類のヒント: ${kindHint}

要件:
- 完全な HTML 文書 (<!doctype html><html>...</html>)
- インライン CSS / JavaScript のみ (外部依存・CDN・<link>・外部画像 等は禁止)
- iframe (sandbox: allow-scripts allow-same-origin allow-popups allow-modals) 内で動く前提
- モバイル前提 (タッチ操作)、画面サイズ 360x280px くらい
- 派手すぎず最小限の例で「これが何か」が伝わる
- アクセント色は #6d28d9 (紫)。背景は #f5f5f7
- 冒頭に小さく「↓ 押してみて」「↓ 値を変えてみて」「↓ スクロールしてみて」等のヒント1行 (color:#888, font-size:12px)

★絶対守るルール (動作確認の罠):
- body と html に高さ指定する (例: html, body { height: 100%; margin: 0; })
- 浮く要素 (トースト/モーダル/FAB/ドロワー等) は \`position: fixed\` ではなく \`position: absolute\` を使う。body は \`position: relative\` にする
- transform を body / html に付けてはいけない (position fixed が壊れる)
- overflow: hidden を body に付ける (はみ出し防止)
- z-index, transition 等は要素自身に付ける
- 出現/消滅は opacity + transform で。display:none → display:flex の切り替えは avoid
- すべての onclick/JS が確実に発火するか脳内シミュレーションする (button id でアクセス、event listener も OK)
- HTML 内で </script> を書く場合は必ず <\\/script> にエスケープする (外側スクリプトを閉じないため)

HTML のみを返す。説明文や Markdown のコードブロック (\`\`\`) は不要。`;

  try {
    const { result } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 4000,
    });
    let html = (result.response.text() || "").trim();
    html = html.replace(/^```html?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!html.toLowerCase().includes("<html")) return null;
    await p.query(
      `INSERT INTO kotonoha_ui_demos (genre, group_id, demo_html)
       VALUES ($1, $2, $3)
       ON CONFLICT (genre) DO UPDATE SET demo_html = EXCLUDED.demo_html, updated_at = now()`,
      [genre, groupId || null, html]
    );
    console.log(`[kotonoha] ui demo generated for "${genre}"`);
    return html;
  } catch (e) {
    console.warn(`[kotonoha] ui demo gen failed for ${genre}:`, e.message);
    return null;
  }
}

async function pickWeakGenres(p, email, n) {
  try {
    const { rows } = await p.query(
      `SELECT q.genre,
              count(DISTINCT q.id) FILTER (WHERE pr.is_correct) AS uniq_correct
         FROM kotonoha_questions q
         LEFT JOIN kotonoha_progress pr
           ON pr.question_id = q.id AND pr.user_email = $1
        WHERE q.genre IS NOT NULL
        GROUP BY q.genre
        ORDER BY uniq_correct ASC, random()
        LIMIT $2`,
      [email, n * 3]
    );
    const fromDb = rows.map((r) => r.genre).slice(0, n);
    if (fromDb.length >= n) return fromDb;
    // DB ジャンルが少ない: マスタからランダムで補う
    const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys()).filter((g) => !fromDb.includes(g));
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return [...fromDb, ...all.slice(0, n - fromDb.length)];
  } catch (e) {
    console.warn("[kotonoha] pickWeakGenres failed:", e.message);
    return [];
  }
}

// AI で新しい問題を生成 (バックグラウンド呼出し or 明示呼出し)
// ジャンル指定すれば該当ジャンル、なしならジャンル空間からランダム選出。
async function generateKotonohaQuestion(p, { level, genre, excludeAnswers = [] }) {
  if (!genAI) return null;

  // ジャンル決定: 未指定なら全ジャンルからランダム
  let targetGenre = genre;
  if (!targetGenre && KOTONOHA_GENRE_TO_GROUP.size > 0) {
    const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys());
    targetGenre = all[Math.floor(Math.random() * all.length)];
  }
  const groupId = targetGenre ? KOTONOHA_GENRE_TO_GROUP.get(targetGenre) || null : null;
  // 旧 category 列にも互換のため group_id を流用
  const cat = groupId || "concept";
  // 基本は4択 (字面で recognize できれば OK の方針)。
  // 自由記述は概念がはっきり定まる場合のみ稀に。
  const type = Math.random() < 0.9 ? "choice" : "free";

  // 難易度別ガイド
  const diffGuide = level <= 2
    ? "完全初心者がこのジャンルに初めて触る想定。「そもそも〇〇って何のための道具?」「どんな時に必要?」レベル。専門用語禁止、例え話で説明。"
    : level <= 4
      ? "基本理解はある人向け。「いつ使うべき?」「どっち選ぶ?」「なぜ〇〇は△△より速い?」レベル。"
      : level <= 7
        ? "中級者向け。「仕組みは?」「もしも〇〇だったら何が起きる?」「歴史的にどう生まれた?」レベル。"
        : "上級者向け。実装トリック、エッジケース、トレードオフを問う。";

  const prompt = `「IT・技術」の学習問題を1問だけ作って。JSON のみ返す (他テキスト・コードブロック禁止)。

ジャンル: ${targetGenre || "(自由)"}
難易度: ${level} / 10 (${diffGuide})
形式: ${type === "choice" ? "4択" : "自由記述 (答えは1単語)"}

問題の型 (どれか):
- 概念「何のための道具?」
- いつ使う「シチュエーション → 適切な選択」
- なぜ「仕組み・理由」
- どっち「比較判断」
- もしも「思考実験」
- 歴史「誰が・なぜ生まれた」
※ 「Xを何と呼ぶ?」「英語何文字?」など単純名前暗記は禁止。

解説 (explanation) は3-5文。役割 + 判断軸 + へぇートリビア (例: 「Wi-Fi の語源は何の略でもない」「中本哲史は正体不明」)。

choice 注意: options は letter prefix 無しの自然な選択肢文。answer は options 内の文字列と完全一致 (letter "A" は禁止)。

既出の答え (重複禁止): ${excludeAnswers.slice(0, 15).join(", ")}

JSON のみ:
${type === "choice"
  ? '{"question":"…","options":["選択肢1","選択肢2","選択肢3","選択肢4"],"answer":"選択肢1","explanation":"…","claude_example":"「…」"}'
  : '{"question":"…","answer":"答え","keywords":["別表記"],"explanation":"…","claude_example":"「…」"}'}`;

  // 1回目失敗したら 1 回だけリトライ
  let j = null;
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    try {
      const { result } = await callGeminiWithFallback(prompt, {
        primaryModel: "gemini-2.5-flash",
        maxOutputTokens: 1500,
      });
      const text = (result.response.text() || "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { console.warn(`[kotonoha] gen no-json genre=${targetGenre} attempt=${attempt+1} text_len=${text.length}`); continue; }
      const parsed = JSON.parse(m[0]);
      if (!parsed.question || !parsed.answer || !parsed.explanation) {
        console.warn(`[kotonoha] gen incomplete genre=${targetGenre} attempt=${attempt+1}`);
        continue;
      }
      j = parsed;
    } catch (e) {
      console.warn(`[kotonoha] gen exception genre=${targetGenre} attempt=${attempt+1}:`, e.message);
    }
  }
  if (!j) return null;
  try {
    const { rows } = await p.query(
      `INSERT INTO kotonoha_questions
         (category, difficulty, type, question, options, answer, keywords, explanation, claude_example, source, genre, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', $10, $11) RETURNING *`,
      [
        cat,
        level,
        type,
        j.question,
        type === "choice" ? JSON.stringify(j.options || []) : null,
        j.answer,
        JSON.stringify(j.keywords || []),
        j.explanation,
        j.claude_example || "",
        targetGenre,
        groupId,
      ]
    );
    return rows[0];
  } catch (e) {
    console.warn("[kotonoha] generate failed:", e.message);
    return null;
  }
}

// セッション開始: 10 問選定して返す（answer は隠す）
// 方針: ユーザーのレベルに「近い」問題を優先 → 達成感重視。
// プールが薄ければバックグラウンドで AI 生成 (待たない)。
app.post("/api/kotonoha/sessions/start", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const user = await ensureKotonohaUser(p, req.user.email);
    const level = user.level;
    const focusGenre = req.body?.genre || null; // 集中セッション (ジャンル指定)

    // ─── 出題対象の整理 ───
    // マスター = 直近 MASTERY_LAST_N 回 (=3) が連続全部正解 (途中失敗でリセット)。
    // 適格 (eligible) =
    //   - 未回答、または
    //   - 未マスターで 4時間以上空いてる、または
    //   - マスター済みでも 30日以上空いてる (spaced repetition で再テスト)
    // 優先度 = 0(未回答) → 1(未マスターのリトライ) → 2(マスター古い再テスト)
    // 選択式優先 (字面で recognize できれば OK の方針)
    const SESSION_SIZE = 20;
    const MASTERY = MASTERY_LAST_N;
    const maxDiff = Math.min(10, level + 2);

    // 適格ルール (priority 並べ替えのみ、フィルタは難易度キャップのみ):
    //   priority 0 = 未回答 (最優先)
    //   priority 1 = 答えたが一度も正解してない (リトライ)
    //   priority 2 = 正解履歴あり & gap (50-100問) 経過済み (復習タイミング)
    //   priority 3 = 正解履歴あり & gap 未達 (緊急時のみ・最劣後)
    //   gap = (user 総回答数 - 直近正解位置)、min_gap は user×問題ID hash で 50-100 散らし
    const baseSelectSql = `
      WITH ranked AS (
        SELECT question_id, is_correct, answered_at,
               ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC) AS rn_q,
               ROW_NUMBER() OVER (ORDER BY answered_at) AS global_rn
          FROM kotonoha_progress
         WHERE user_email = $1
      ),
      mastered_q AS (
        SELECT question_id
          FROM ranked
         WHERE rn_q <= $2
         GROUP BY question_id
        HAVING count(*) >= $2 AND bool_and(is_correct)
      ),
      per_q AS (
        SELECT question_id,
               MAX(global_rn) FILTER (WHERE is_correct) AS last_correct_pos,
               MAX(answered_at) AS last_at
          FROM ranked
         GROUP BY question_id
      ),
      user_total AS (
        SELECT COUNT(*)::int AS total FROM ranked
      ),
      eligible AS (
        SELECT q.*,
               pq.last_at,
               (mq.question_id IS NOT NULL) AS is_mastered,
               CASE
                 WHEN pq.question_id IS NULL THEN 0
                 WHEN pq.last_correct_pos IS NULL THEN 1
                 WHEN ((SELECT total FROM user_total) - pq.last_correct_pos)
                      >= (50 + (abs(hashtextextended(q.id::text || $1, 0)) % 51))::int THEN 2
                 ELSE 3
               END AS priority
          FROM kotonoha_questions q
          LEFT JOIN per_q pq ON pq.question_id = q.id
          LEFT JOIN mastered_q mq ON mq.question_id = q.id
      )`;

    // ─── start は基本即返却。プール枯渇時のみ緊急同期生成 ───
    // 通常時は /sessions/end の wrap-up gen でプール 40 維持されてる前提。
    const debug = { freshBefore: 0, freshAfter: 0, syncGenAttempted: 0, syncGenSucceeded: 0 };
    try {
      const { rows: pcr } = await p.query(
        `${baseSelectSql}
         SELECT COUNT(*)::int AS n FROM eligible
          WHERE difficulty <= $3 AND priority <= 2
            ${focusGenre ? "AND genre = $4" : ""}`,
        focusGenre
          ? [req.user.email, MASTERY, maxDiff, focusGenre]
          : [req.user.email, MASTERY, maxDiff]
      );
      const freshCount = pcr[0]?.n || 0;
      debug.freshBefore = freshCount;
      debug.freshAfter = freshCount;
      // 緊急時のみ生成 (プール枯渇)
      if (freshCount < SESSION_SIZE) {
        const need = Math.min(SESSION_SIZE - freshCount + 4, 10);
        const { rows: ansRows } = await p.query(
          `SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 200`
        );
        const excludeAnswers = ansRows.map((r) => r.answer);
        let targets;
        if (focusGenre) {
          targets = Array(need).fill(focusGenre);
        } else {
          targets = await pickWeakGenres(p, req.user.email, need);
          if (targets.length < need) {
            const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys()).filter((g) => !targets.includes(g));
            for (let i = all.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [all[i], all[j]] = [all[j], all[i]];
            }
            targets.push(...all.slice(0, need - targets.length));
          }
        }
        console.log(`[kotonoha] emergency gen: fresh=${freshCount} need=${need}`);
        debug.syncGenAttempted = need;
        const results = await Promise.all(
          targets.slice(0, need).map((g) =>
            generateKotonohaQuestion(p, { level, genre: g, excludeAnswers })
              .catch((e) => { console.warn("[kotonoha] emergency gen failed:", g, e.message); return null; })
          )
        );
        debug.syncGenSucceeded = results.filter(Boolean).length;
        console.log(`[kotonoha] emergency gen succeeded ${debug.syncGenSucceeded}/${need}`);
        const { rows: pcr2 } = await p.query(
          `${baseSelectSql}
           SELECT COUNT(*)::int AS n FROM eligible
            WHERE difficulty <= $3 AND priority <= 2
              ${focusGenre ? "AND genre = $4" : ""}`,
          focusGenre
            ? [req.user.email, MASTERY, maxDiff, focusGenre]
            : [req.user.email, MASTERY, maxDiff]
        );
        debug.freshAfter = pcr2[0]?.n || 0;
      }
    } catch (e) {
      console.warn("[kotonoha] sync gen check skipped:", e.message);
    }

    let newRows = [];
    if (focusGenre) {
      const { rows } = await p.query(
        `${baseSelectSql}
         SELECT * FROM eligible
          WHERE genre = $3
          ORDER BY priority ASC,
                   (type = 'choice') DESC,
                   (source = 'generated') DESC,
                   difficulty ASC,
                   random()
          LIMIT $4`,
        [req.user.email, MASTERY, focusGenre, SESSION_SIZE]
      );
      newRows = rows;
    } else {
      const { rows } = await p.query(
        `${baseSelectSql},
         mastered_per_genre AS (
           SELECT q.genre,
                  count(DISTINCT q.id) FILTER (WHERE mq2.question_id IS NOT NULL) AS mastered
             FROM kotonoha_questions q
             LEFT JOIN mastered_q mq2 ON mq2.question_id = q.id
            WHERE q.genre IS NOT NULL
            GROUP BY q.genre
         )
         SELECT e.*, COALESCE(mpg.mastered, 0) AS genre_mastered
           FROM eligible e
           LEFT JOIN mastered_per_genre mpg ON mpg.genre = e.genre
          WHERE e.difficulty <= $3
          ORDER BY priority ASC,
                   genre_mastered ASC,
                   (e.type = 'choice') DESC,
                   e.created_at ASC,
                   random()
          LIMIT $4`,
        [req.user.email, MASTERY, maxDiff, SESSION_SIZE]
      );
      newRows = rows;
    }

    let questions = newRows;

    // (fill query は廃止: eligible CTE が priority 3 まで含めて全範囲をカバー)

    // UI部品 / CSS技法 の問題に demo_html を結合
    const demoGroups = new Set(["ui_parts", "css_layout"]);
    const uiGenres = [...new Set(questions.filter((q) => demoGroups.has(q.group_id) && q.genre).map((q) => q.genre))];
    const demoMap = new Map();
    if (uiGenres.length) {
      const { rows: dRows } = await p.query(
        `SELECT genre, demo_html FROM kotonoha_ui_demos WHERE genre = ANY($1::text[])`,
        [uiGenres]
      );
      for (const r of dRows) demoMap.set(r.genre, r.demo_html);
    }
    for (const q of questions) {
      if (demoMap.has(q.genre)) q.demo_html = demoMap.get(q.genre);
    }

    // 3) バックグラウンド AI 生成: ジャンル別未解答プールが薄ければ補充。
    //    レスポンスは待たない (fire-and-forget)。集中セッションならそのジャンルに集中生成。
    //    早期ユーザー (総回答 < 100) はより積極的に多ジャンル生成 (毎セッション新鮮さを確保)
    (async () => {
      try {
        const { rows: utr } = await p.query(`SELECT count(*)::int AS n FROM kotonoha_progress WHERE user_email = $1`, [req.user.email]);
        const userTotal = utr[0]?.n || 0;
        const genCount = focusGenre ? 1 : (userTotal < 100 ? 10 : 4);
        const targetGenres = focusGenre ? [focusGenre] : await pickWeakGenres(p, req.user.email, genCount);
        if (!targetGenres.length) return;
        const { rows: ansRows } = await p.query(
          `SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 200`
        );
        const excludeAnswers = ansRows.map((r) => r.answer);
        for (const g of targetGenres) {
          // 早期ユーザーは pool < 8、それ以降は < 5 で生成
          const threshold = userTotal < 100 ? 8 : 5;
          const { rows: poolRows } = await p.query(
            `SELECT count(*)::int AS n FROM kotonoha_questions
              WHERE genre = $1
                AND id NOT IN (SELECT question_id FROM kotonoha_progress WHERE user_email = $2)`,
            [g, req.user.email]
          );
          if ((poolRows[0]?.n || 0) >= threshold) continue;
          await generateKotonohaQuestion(p, { level, genre: g, excludeAnswers });
        }
      } catch (e) {
        console.warn("[kotonoha] bg generate skipped:", e.message);
      }
    })();

    // 4) UI / CSS demo 未生成なら背景で生成 (この回には間に合わなくても、次セッションで反映)
    (async () => {
      try {
        const demoQs = questions.filter((q) => demoGroups.has(q.group_id) && q.genre && !q.demo_html);
        const seen = new Set();
        for (const q of demoQs) {
          if (seen.has(q.genre)) continue;
          seen.add(q.genre);
          await generateUiDemo(p, q.genre, q.group_id);
        }
      } catch (e) {
        console.warn("[kotonoha] demo bg gen skipped:", e.message);
      }
    })();

    // クライアントに送る時は answer / keywords / explanation を隠す
    const safe = questions.map((q) => ({
      id: q.id,
      category: q.category,
      genre: q.genre,
      group_id: q.group_id,
      difficulty: q.difficulty,
      type: q.type,
      question: q.question,
      options: q.options,
      image_url: q.image_url,
      demo_html: q.demo_html || null,
    }));
    // 返却問題の priority 内訳もデバッグに追加
    const priorityBreakdown = questions.reduce((acc, q) => {
      const k = q.priority ?? "?";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    res.json({ level, genre: focusGenre, questions: safe, debug: { ...debug, priorityBreakdown } });
  } catch (err) {
    console.error("kotonoha start", err);
    res.status(500).json({ error: err.message });
  }
});

// 解答: 判定して結果と解説を返す
app.post("/api/kotonoha/answer", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const { question_id, user_answer } = req.body || {};
  if (!question_id) return res.status(400).json({ error: "question_id required" });
  try {
    const { rows: qRows } = await p.query(`SELECT * FROM kotonoha_questions WHERE id=$1`, [question_id]);
    if (!qRows.length) return res.status(404).json({ error: "question not found" });
    const q = qRows[0];
    const ua = String(user_answer || "").trim();

    let isCorrect = false;
    let aiReason = null;

    if (q.type === "choice") {
      isCorrect = ua === q.answer;
      // Fallback 1: AI が options に "A. xxx" 形式で answer に "A" だけ入れたパターン
      if (!isCorrect && /^[A-D]$/i.test(String(q.answer || "").trim())) {
        const letter = String(q.answer).trim().toUpperCase();
        if (ua.startsWith(letter + ".") || ua.startsWith(letter + ")") || ua.startsWith(letter + ":") || ua.startsWith(letter + " ")) {
          isCorrect = true;
        }
        // 逆: options 配列の index で照合 (A=0, B=1, ...)
        if (!isCorrect && Array.isArray(q.options)) {
          const idx = letter.charCodeAt(0) - "A".charCodeAt(0);
          if (q.options[idx] === ua) isCorrect = true;
        }
      }
      // Fallback 2: prefix "A. " などを除去して一致を見る (両方向)
      if (!isCorrect) {
        const stripPrefix = (s) => String(s || "").replace(/^[A-D][.\):：\s]+/i, "").trim();
        if (stripPrefix(ua) === stripPrefix(q.answer) && stripPrefix(ua) !== "") {
          isCorrect = true;
        }
      }
    } else {
      // free: まず厳密一致 / キーワード照合 / 最終的に AI 判定
      const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, "");
      if (norm(ua) === norm(q.answer)) {
        isCorrect = true;
      } else if (Array.isArray(q.keywords) && q.keywords.some((k) => norm(ua).includes(norm(k)) || norm(k).includes(norm(ua)))) {
        isCorrect = true;
      } else if (genAI && ua) {
        // AI 判定 (Gemini Flash)
        try {
          const judgePrompt = `次のユーザー回答が、正解と意味的に同じか判定してください。
ユーザーが日本語かカタカナか英語かに関わらず、概念として一致してれば正解。
全く違うものを答えたら不正解。

問題: ${q.question}
正解: ${q.answer}
正解として認める同義語: ${JSON.stringify(q.keywords || [])}
ユーザー回答: ${ua}

JSON でだけ返す (前置きや説明禁止):
{"correct": true|false, "reason": "1文の理由"}`;
          const { result } = await callGeminiWithFallback(judgePrompt, {
            primaryModel: "gemini-2.5-flash",
            maxOutputTokens: 500,
          });
          const text = (result.response.text() || "").trim();
          const m = text.match(/\{[\s\S]*\}/);
          if (m) {
            const j = JSON.parse(m[0]);
            isCorrect = !!j.correct;
            aiReason = j.reason || null;
          }
        } catch (e) {
          console.warn("[kotonoha] AI 判定失敗、不正解扱い:", e.message);
        }
      }
    }

    // 過去の attempts 数
    const { rows: attemptRows } = await p.query(
      `SELECT count(*)::int AS n FROM kotonoha_progress WHERE user_email=$1 AND question_id=$2`,
      [req.user.email, question_id]
    );
    const attempts = (attemptRows[0]?.n || 0) + 1;

    await p.query(
      `INSERT INTO kotonoha_progress (user_email, question_id, is_correct, user_answer, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.email, question_id, isCorrect, ua, attempts]
    );

    await p.query(
      `UPDATE kotonoha_users
          SET total_correct = total_correct + $1, total_answers = total_answers + 1, updated_at=now()
        WHERE user_email = $2`,
      [isCorrect ? 1 : 0, req.user.email]
    );

    res.json({
      is_correct: isCorrect,
      answer: q.answer,
      genre: q.genre,
      group_id: q.group_id,
      explanation: q.explanation,
      claude_example: q.claude_example,
      ai_reason: aiReason,
    });

    // ─── 正解ごとにバックグラウンドで AI が次の問題を1つ生成 (fire-and-forget) ───
    // リアルタイム感: 解くたびにプールが育つ → 次セッションが必ず新鮮
    if (isCorrect) {
      (async () => {
        try {
          const { rows: uRows } = await p.query(
            `SELECT level FROM kotonoha_users WHERE user_email=$1`,
            [req.user.email]
          );
          const userLevel = uRows[0]?.level || 1;
          const targetGenres = await pickWeakGenres(p, req.user.email, 1);
          if (!targetGenres.length) return;
          const { rows: ansRows } = await p.query(
            `SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 200`
          );
          const excludeAnswers = ansRows.map((r) => r.answer);
          await generateKotonohaQuestion(p, {
            level: userLevel,
            genre: targetGenres[0],
            excludeAnswers,
          });
        } catch (e) {
          console.warn("[kotonoha] per-answer gen skipped:", e.message);
        }
      })();
    }
  } catch (err) {
    console.error("kotonoha answer", err);
    res.status(500).json({ error: err.message });
  }
});

// セッション終了: 直近10件の正解率でレベル調整
app.post("/api/kotonoha/sessions/end", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: recent } = await p.query(
      `SELECT is_correct FROM kotonoha_progress
        WHERE user_email = $1 ORDER BY answered_at DESC LIMIT 20`,
      [req.user.email]
    );
    if (!recent.length) return res.json({ ok: true, levelChanged: false });
    const correctCount = recent.filter((r) => r.is_correct).length;
    const rate = correctCount / recent.length;
    const { rows: uRows } = await p.query(`SELECT level FROM kotonoha_users WHERE user_email=$1`, [req.user.email]);
    const oldLevel = uRows[0]?.level || 1;
    let newLevel = oldLevel;
    // 達成感重視: 70%超でレベルアップ、40%未満で1段下げ。
    // 「ちょうど飽きない」ゾーンを広く取る。
    if (rate >= 0.7 && oldLevel < 10) newLevel = oldLevel + 1;
    else if (rate < 0.4 && oldLevel > 1) newLevel = oldLevel - 1;
    if (newLevel !== oldLevel) {
      await p.query(`UPDATE kotonoha_users SET level=$1, last_session_at=now(), updated_at=now() WHERE user_email=$2`, [newLevel, req.user.email]);
    } else {
      await p.query(`UPDATE kotonoha_users SET last_session_at=now() WHERE user_email=$1`, [req.user.email]);
    }
    // ─── プール warm-up: 次セッション用に最大 12 問を sync 生成 ───
    // start を即返却にするための準備。end の時点なら数秒待たせても OK
    // (ユーザーは結果サマリを見るところ)。プール 40 未満ならその差を埋める。
    const POOL_TARGET = 40;
    const warmup = { freshBefore: 0, freshAfter: 0, genAttempted: 0, genSucceeded: 0 };
    try {
      const userLevel = newLevel;
      const maxDiff = Math.min(10, userLevel + 2);
      const { rows: poolRows } = await p.query(
        `WITH ranked AS (
           SELECT question_id, is_correct, answered_at,
                  ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC) AS rn_q,
                  ROW_NUMBER() OVER (ORDER BY answered_at) AS global_rn
             FROM kotonoha_progress
            WHERE user_email = $1
         ),
         per_q AS (
           SELECT question_id, MAX(global_rn) FILTER (WHERE is_correct) AS last_correct_pos
             FROM ranked GROUP BY question_id
         ),
         user_total AS (SELECT COUNT(*)::int AS total FROM ranked)
         SELECT COUNT(*)::int AS n FROM kotonoha_questions q
          LEFT JOIN per_q pq ON pq.question_id = q.id
         WHERE q.difficulty <= $2
           AND (
             pq.question_id IS NULL
             OR pq.last_correct_pos IS NULL
             OR ((SELECT total FROM user_total) - pq.last_correct_pos)
                >= (50 + (abs(hashtextextended(q.id::text || $1, 0)) % 51))::int
           )`,
        [req.user.email, maxDiff]
      );
      const freshNow = poolRows[0]?.n || 0;
      warmup.freshBefore = freshNow;
      warmup.freshAfter = freshNow;
      if (freshNow < POOL_TARGET) {
        const need = Math.min(POOL_TARGET - freshNow, 12);
        const { rows: ansRows } = await p.query(`SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 200`);
        const excludeAnswers = ansRows.map((r) => r.answer);
        let targets = await pickWeakGenres(p, req.user.email, need);
        if (targets.length < need) {
          const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys()).filter((g) => !targets.includes(g));
          for (let i = all.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [all[i], all[j]] = [all[j], all[i]];
          }
          targets.push(...all.slice(0, need - targets.length));
        }
        console.log(`[kotonoha] warmup gen: fresh=${freshNow} need=${need}`);
        warmup.genAttempted = need;
        const results = await Promise.all(
          targets.slice(0, need).map((g) =>
            generateKotonohaQuestion(p, { level: userLevel, genre: g, excludeAnswers })
              .catch((e) => { console.warn("[kotonoha] warmup gen failed:", g, e.message); return null; })
          )
        );
        warmup.genSucceeded = results.filter(Boolean).length;
        warmup.freshAfter = freshNow + warmup.genSucceeded;
      }
    } catch (e) {
      console.warn("[kotonoha] warmup skipped:", e.message);
    }

    res.json({ ok: true, oldLevel, newLevel, levelChanged: newLevel !== oldLevel, rate, warmup });
  } catch (err) {
    console.error("kotonoha end", err);
    res.status(500).json({ error: err.message });
  }
});

// 自分のステータス: ジャンル別進捗 + 最近覚えた言葉
// マスター = 直近 MASTERY_LAST_N 回 (=3) が連続全部正解 (途中失敗でリセット)
const MASTERY_LAST_N = 3;

// 連続日数 (Duolingo 型): 1日5問正解=アクティブ。
// 1日抜けても、次の日に 15問正解で前日も連続扱い (1回まで)。
const STREAK_DAILY_MIN = 5;
const STREAK_DOUBLE_MIN = 15;
async function computeKotonohaStreak(p, email) {
  const { rows } = await p.query(
    `SELECT (answered_at AT TIME ZONE 'Asia/Tokyo')::date AS day,
            count(*) FILTER (WHERE is_correct)::int AS correct_count
       FROM kotonoha_progress
      WHERE user_email = $1
        AND answered_at > now() - interval '90 days'
      GROUP BY day
      ORDER BY day DESC`,
    [email]
  );
  const fmt = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const byDay = new Map();
  for (const r of rows) {
    const ds = r.day instanceof Date ? fmt(r.day) : String(r.day).slice(0, 10);
    byDay.set(ds, Number(r.correct_count));
  }
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = fmt(nowJst);
  const todayCount = byDay.get(today) || 0;
  const prevDay = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return fmt(dt);
  };
  let walk = todayCount >= STREAK_DAILY_MIN ? today : prevDay(today);
  let streak = 0;
  let credit = 0;
  for (let i = 0; i < 90; i++) {
    const c = byDay.get(walk) || 0;
    if (c >= STREAK_DAILY_MIN) {
      streak++;
      credit = c >= STREAK_DOUBLE_MIN ? 1 : 0;
    } else if (credit > 0) {
      credit -= 1;
      streak++;
    } else {
      break;
    }
    walk = prevDay(walk);
  }
  return {
    streak,
    today_correct: todayCount,
    today_active: todayCount >= STREAK_DAILY_MIN,
    daily_min: STREAK_DAILY_MIN,
    double_min: STREAK_DOUBLE_MIN,
  };
}

// テスト生成: 1問だけ生成して結果 (成功/失敗 + 詳細) を返すデバッグ用
app.post("/api/kotonoha/test-gen", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const start = Date.now();
  try {
    if (!genAI) return res.json({ ok: false, error: "genAI not initialized (GEMINI_API_KEY?)" });
    const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys());
    const genre = all[Math.floor(Math.random() * all.length)];
    const { rows: uRows } = await p.query(`SELECT level FROM kotonoha_users WHERE user_email=$1`, [req.user.email]);
    const userLevel = uRows[0]?.level || 1;
    const { rows: ansRows } = await p.query(`SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 50`);
    const excludeAnswers = ansRows.map((r) => r.answer);
    const result = await generateKotonohaQuestion(p, { level: userLevel, genre, excludeAnswers });
    const elapsed = Date.now() - start;
    if (!result) return res.json({ ok: false, elapsed, genre, level: userLevel, error: "generateKotonohaQuestion returned null (Gemini failed or invalid JSON, see Cloud Run logs)" });
    return res.json({ ok: true, elapsed, genre, level: userLevel, question: result.question, answer: result.answer });
  } catch (e) {
    return res.json({ ok: false, elapsed: Date.now() - start, error: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") });
  }
});

// テスト生成: 1問だけ生成して結果 (成功/失敗 + 詳細) を返すデバッグ用 (旧)
async function buildKotonohaProgress(p, email) {
  // 進捗の見え方: 「ユニーク正解数 / target_count」をベースにする
  //   - 1回でも正解した unique 問題は 0.6 として加算 (一定の達成感)
  //   - 直近3連続正解した (mastered) 問題は 1.0 として加算 (フル習得)
  //   - 早期段階でもバーが伸びる + マスターしたら満タンに近づく設計
  const { rows: byGenre } = await p.query(
    `WITH ranked AS (
       SELECT question_id, is_correct,
              ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC) AS rn
         FROM kotonoha_progress
        WHERE user_email = $1
     ),
     mastered_q AS (
       SELECT question_id
         FROM ranked
        WHERE rn <= $2
        GROUP BY question_id
       HAVING count(*) >= $2 AND bool_and(is_correct)
     ),
     correct_q AS (
       SELECT DISTINCT question_id FROM kotonoha_progress
        WHERE user_email = $1 AND is_correct = true
     )
     SELECT q.genre, q.group_id,
            count(DISTINCT q.id) FILTER (WHERE cq.question_id IS NOT NULL) AS correct_uniq,
            count(DISTINCT q.id) FILTER (WHERE mq.question_id IS NOT NULL) AS mastered
       FROM kotonoha_questions q
       LEFT JOIN correct_q cq ON cq.question_id = q.id
       LEFT JOIN mastered_q mq ON mq.question_id = q.id
      WHERE q.genre IS NOT NULL
      GROUP BY q.genre, q.group_id`,
    [email, MASTERY_LAST_N]
  );
  const dbProg = new Map();
  for (const r of byGenre) {
    dbProg.set(r.genre, {
      correct_uniq: Number(r.correct_uniq || 0),
      mastered: Number(r.mastered || 0),
      group_id: r.group_id,
    });
  }
  const groups = [];
  for (const g of (KOTONOHA_GENRES_DATA?.groups || [])) {
    const genres = g.genres.map((gen) => {
      const target = gen.target_count || 10;
      const rec = dbProg.get(gen.name) || { correct_uniq: 0, mastered: 0 };
      // 進捗 = (正解問題 × 0.6 + マスター問題 × 0.4) / target
      // correct_uniq には mastered も含まれる前提なので、内訳は:
      //   未マスター正解 × 0.6 + マスター × 1.0 (=0.6+0.4)
      const partial = Math.max(0, rec.correct_uniq - rec.mastered);
      const score = partial * 0.6 + rec.mastered * 1.0;
      const pct = Math.min(100, Math.round((score / target) * 100));
      return {
        name: gen.name,
        target,
        correct: rec.correct_uniq,
        mastered: rec.mastered,
        pct,
      };
    });
    const totalT = genres.reduce((s, x) => s + x.target, 0);
    const totalScore = genres.reduce((s, x) => {
      const partial = Math.max(0, x.correct - x.mastered);
      return s + partial * 0.6 + x.mastered * 1.0;
    }, 0);
    groups.push({
      id: g.id, name: g.name, color: g.color,
      genres,
      pct: totalT ? Math.min(100, Math.round((totalScore / totalT) * 100)) : 0,
    });
  }
  return groups;
}

app.get("/api/kotonoha/me", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const user = await ensureKotonohaUser(p, req.user.email);
    const [groups, streak] = await Promise.all([
      buildKotonohaProgress(p, req.user.email),
      computeKotonohaStreak(p, req.user.email),
    ]);
    // プール統計 (デバッグ用)
    const { rows: poolRows } = await p.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE source = 'generated')::int AS generated,
         count(*) FILTER (WHERE source = 'seed')::int AS seed,
         count(*) FILTER (WHERE source = 'generated' AND created_at > now() - interval '1 hour')::int AS gen_last_hour
       FROM kotonoha_questions`
    );
    const pool = poolRows[0] || { total: 0, generated: 0, seed: 0, gen_last_hour: 0 };
    // 最近覚えた言葉: ジャンル名で集約 (概念ベース)。長文回答や letter-only な
    // 壊れ answer を chip にしないようにする。
    const { rows: recentWords } = await p.query(
      `SELECT
         COALESCE(NULLIF(q.genre, ''), q.answer) AS label,
         q.genre,
         q.group_id,
         MAX(pr.answered_at) AS answered_at
         FROM kotonoha_progress pr
         JOIN kotonoha_questions q ON q.id = pr.question_id
        WHERE pr.user_email = $1
          AND pr.is_correct = true
          AND char_length(COALESCE(NULLIF(q.genre, ''), q.answer)) BETWEEN 2 AND 24
        GROUP BY label, q.genre, q.group_id
        ORDER BY MAX(pr.answered_at) DESC
        LIMIT 12`,
      [req.user.email]
    );
    res.json({
      user,
      streak,
      groups,
      pool,
      recentWords: recentWords.slice(0, 12),
    });
  } catch (err) {
    console.error("kotonoha me", err);
    res.status(500).json({ error: err.message });
  }
});

// 他メンバーのステータス (並列バー用)
app.get("/api/kotonoha/peers", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: users } = await p.query(
      `SELECT user_email, display_name, level, total_correct, total_answers, last_session_at
         FROM kotonoha_users
        WHERE visible_to_peers = true AND user_email <> $1
        ORDER BY last_session_at DESC NULLS LAST`,
      [req.user.email]
    );
    const result = [];
    for (const u of users) {
      const [groups, streak, recentWords] = await Promise.all([
        buildKotonohaProgress(p, u.user_email),
        computeKotonohaStreak(p, u.user_email),
        p.query(
          `SELECT DISTINCT ON (q.id) q.answer, q.genre, q.group_id, pr.answered_at
             FROM kotonoha_progress pr
             JOIN kotonoha_questions q ON q.id = pr.question_id
            WHERE pr.user_email = $1 AND pr.is_correct = true
            ORDER BY q.id, pr.answered_at DESC`,
          [u.user_email]
        ).then((r) => r.rows),
      ]);
      result.push({
        display_name: u.display_name,
        level: u.level,
        total_correct: u.total_correct,
        total_answers: u.total_answers,
        last_session_at: u.last_session_at,
        streak,
        groups,
        recentWords: recentWords.sort((a, b) => new Date(b.answered_at) - new Date(a.answered_at)).slice(0, 5),
      });
    }
    res.json(result);
  } catch (err) {
    console.error("kotonoha peers", err);
    res.status(500).json({ error: err.message });
  }
});

// 自分の可視性切替
app.put("/api/kotonoha/me/visibility", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const visible = !!req.body?.visible;
  try {
    await p.query(
      `UPDATE kotonoha_users SET visible_to_peers = $1, updated_at=now() WHERE user_email = $2`,
      [visible, req.user.email]
    );
    res.json({ ok: true, visible });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const withImage = rows.filter((r) => r.imageUrl).length;
    console.log(`[records] GET returned ${rows.length} records, ${withImage} with imageUrl (latest 3: ${rows.slice(0, 3).map((r) => `id=${r.id} img=${r.imageUrl ? "yes" : "NO"}`).join(", ")})`);
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
    console.log(`[records] POST imageUrl=${r.imageUrl ? r.imageUrl.slice(0, 80) : "(none)"} store="${r.store}" total=${r.total}`);
    const { rows } = await p.query(
      `INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.imageUrl || null]
    );
    // 現場が設定されてればシートにも追記 (空なら未 SORT で送らない)
    appendRecordToSheet({ ...r, id: rows[0].id }).catch(() => {});
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
    // 編集後もシートに append (現場が空なら送らない)。重複は当面手動で削除
    appendRecordToSheet({ ...r, id: req.params.id }).catch(() => {});
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
