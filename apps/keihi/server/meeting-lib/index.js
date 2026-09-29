// 会議の文字起こし MCP (claude.ai カスタムコネクタ)。
// 接続 URL: https://<keihi-api の Cloud Run URL>/api/meeting/mcp/<token>  (token は meeting-config の tokens)
//
// 書くのはミニアプリ /gijiroku/ (REST、Firebase ログイン):
//   録音しながら 15 秒ごとの音声を POST → Gemini で文字起こしして即表示 (リアルタイム)
//   画面共有中は画面が変わったときだけ静止画 (JPEG) を POST → GCS に保存
// 読むのは claude.ai のチャット / Claude Code (MCP):
//   meeting_list / meeting_search / meeting_get で会話、meeting_frames で画面の静止画をそのまま見る
// 録音メモ (/rec/) の rec_memos も読み取り専用で一緒に見せる (id は "rec:<id>")。
//
// DB (Cloud SQL keikhi-db / keihi、初回アクセス時に自動作成): meetings / meeting_segments / meeting_frames
// 画面の静止画: gs://<RECEIPTS_BUCKET>/meeting/<id>/<frame id>.jpg
// トークンは Secret Manager の meeting-config にだけ置く (リポは public)。未作成なら 403 のみ。

import { google } from "googleapis";

const SECRET_NAME = (process.env.MEETING_CONFIG_SECRET || "meeting-config").trim();
const CACHE_MS = 5 * 60 * 1000;
const MAX_AUDIO_B64 = 12 * 1024 * 1024; // 1 チャンクの上限 (15 秒なら数百 KB)
const MAX_IMAGE_B64 = 4 * 1024 * 1024;

// ── 設定 (Secret Manager) ── 形: { "tokens": { "<長いランダム文字列>": "用途メモ" } }
let cfgCache = null, cfgAt = 0, authClient = null;
async function readConfig() {
  if (process.env.MEETING_CONFIG_JSON) return JSON.parse(process.env.MEETING_CONFIG_JSON);
  const project = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("project id が不明");
  if (!authClient) {
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    authClient = await auth.getClient();
  }
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET_NAME}/versions/latest:access`;
  const { data } = await authClient.request({ url });
  return JSON.parse(Buffer.from(data.payload.data, "base64").toString("utf8"));
}
async function tokenOk(token) {
  if (!token) return false;
  if (!cfgCache || Date.now() - cfgAt > CACHE_MS) {
    try { cfgCache = (await readConfig()).tokens || {}; cfgAt = Date.now(); }
    catch (e) { console.warn(`[meeting] config (${SECRET_NAME}) を読めません:`, e.message); if (!cfgCache) return false; }
  }
  return Object.prototype.hasOwnProperty.call(cfgCache, token);
}

const INSTRUCTIONS = [
  "会議・打ち合わせの文字起こし置き場。",
  "内容を聞かれたら meeting_list / meeting_search で探し、meeting_get で本文を読んでから答える。",
  "本文の [mm:ss] は会議開始からの経過時間。話者名は文字起こし AI の推定なので断定しない。",
  "画面共有していた会議は meeting_get の frames に静止画の一覧が出る。画面の話が出てきたら meeting_frames で該当時刻の画像を見る。",
  "id が rec: で始まるものは録音メモアプリの記録 (読み取り専用)。",
].join("\n");

const fmtTime = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
};

export function createMeeting({ getPool, createMcpHandler, callGemini, getStorage, bucket }) {
  const pool = () => {
    const p = getPool();
    if (!p) throw new Error("DB not configured");
    return p;
  };

  let schemaReady = false;
  async function ensureSchema() {
    if (schemaReady) return;
    const p = pool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        held_at TIMESTAMPTZ,
        participants TEXT NOT NULL DEFAULT '',
        memo TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS meeting_segments (
        id BIGSERIAL PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        part INT NOT NULL DEFAULT 1,           -- 何本目の音声 / テキストか
        start_sec INT NOT NULL DEFAULT 0,      -- 会議開始からの秒 (その part の先頭 = part_offset + チャンク位置)
        text TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'audio',  -- 'audio' | 'text'
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (meeting_id, part, start_sec)
      )`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS meeting_frames (
        id BIGSERIAL PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        at_sec INT NOT NULL DEFAULT 0,         -- 会議開始からの秒
        gcs_key TEXT NOT NULL,
        width INT, height INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS meeting_frames_idx ON meeting_frames (meeting_id, at_sec)`);
    await p.query(`CREATE INDEX IF NOT EXISTS meetings_held_idx ON meetings (COALESCE(held_at, created_at) DESC)`);
    schemaReady = true;
  }

  async function recRows(where = "", params = [], limit = 200) {
    try {
      const { rows } = await pool().query(
        `SELECT id, title, summary, transcript, duration, created_at FROM rec_memos ${where}
          ORDER BY created_at DESC LIMIT ${Number(limit) || 200}`, params);
      return rows;
    } catch { return []; } // rec_memos が無い環境でも落とさない
  }

  async function meetingText(id) {
    const { rows } = await pool().query(
      `SELECT part, start_sec, text, source FROM meeting_segments WHERE meeting_id=$1 ORDER BY part, start_sec`, [id]);
    return rows.map((r) => (r.source === "audio" ? `[${fmtTime(r.start_sec)}] ` : "") + r.text.trim()).filter(Boolean).join("\n\n");
  }

  async function nextPart(id) {
    const { rows } = await pool().query(`SELECT COALESCE(MAX(part),0)+1 AS n FROM meeting_segments WHERE meeting_id=$1`, [id]);
    return rows[0].n;
  }

  async function mustMeeting(id) {
    if (String(id).startsWith("rec:")) throw new Error("rec: の記録は読み取り専用です");
    const { rows } = await pool().query(`SELECT * FROM meetings WHERE id=$1`, [id]);
    if (!rows.length) throw new Error(`会議が見つかりません: ${id}`);
    return rows[0];
  }

  const gcs = () => {
    const st = getStorage?.();
    if (!st || !bucket) throw new Error("画像の保存先 (GCS) が未設定です");
    return st.bucket(bucket);
  };

  // ── 書き込み (アプリの REST から使う) ──
  async function transcribeChunk(m, { audio, mimeType, startSec, part }) {
    audio = String(audio || "").replace(/^data:[^,]*,/, "");
    if (!audio) throw new Error("audio が空です");
    if (audio.length > MAX_AUDIO_B64) throw new Error("音声チャンクが大きすぎます");
    part = Math.max(1, Number(part) || 1);
    startSec = Math.max(0, Math.round(Number(startSec) || 0));
    const prompt = [
      "次の日本語の会議音声 (リアルタイム録音の 15 秒ほどの断片) を文字起こししてください。",
      m.participants ? `参加者: ${m.participants}（声や呼びかけで分かるときだけ名前を使う）` : "",
      "話者が替わるところで改行する。話者名は確実に分かるときだけ行頭に「名前: 」を付ける。",
      "言いよどみ (えー、あのー) は省いてよいが、内容は要約せず話した通りに残す。",
      "断片なので文頭・文末が途中で切れていてもそのまま書く。聞き取れない箇所は（聞き取れず）とし、創作しない。",
      "無音・雑音だけなら何も出力しない。文字起こしテキストのみを出力 (前置き・見出し・記号・JSON 不要)。",
    ].filter(Boolean).join("\n");
    const { result } = await callGemini([
      { text: prompt },
      { inlineData: { data: audio, mimeType: String(mimeType || "audio/webm").split(";")[0] } },
    ], { primaryModel: "gemini-2.5-flash", maxOutputTokens: 4096, thinkingBudget: 0 });
    let text = String(result?.response?.text?.() || "").trim();
    if (/^(（?無音）?|（?聞き取れず）?)$/.test(text)) text = "";
    await pool().query(
      `INSERT INTO meeting_segments (meeting_id, part, start_sec, text, source) VALUES ($1,$2,$3,$4,'audio')
       ON CONFLICT (meeting_id, part, start_sec) DO UPDATE SET text = EXCLUDED.text, created_at = now()`,
      [m.id, part, startSec, text]);
    await pool().query(`UPDATE meetings SET updated_at = now() WHERE id=$1`, [m.id]);
    return { part, start_sec: startSec, text };
  }

  async function saveFrame(m, { image, atSec, width, height }) {
    const b64 = String(image || "").replace(/^data:[^,]*,/, "");
    if (!b64) throw new Error("image が空です");
    if (b64.length > MAX_IMAGE_B64) throw new Error("画像が大きすぎます");
    atSec = Math.max(0, Math.round(Number(atSec) || 0));
    const key = `meeting/${m.id}/${String(atSec).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await gcs().file(key).save(Buffer.from(b64, "base64"), { contentType: "image/jpeg", resumable: false });
    const { rows } = await pool().query(
      `INSERT INTO meeting_frames (meeting_id, at_sec, gcs_key, width, height) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [m.id, atSec, key, Number(width) || null, Number(height) || null]);
    await pool().query(`UPDATE meetings SET updated_at = now() WHERE id=$1`, [m.id]);
    return { id: Number(rows[0].id), at_sec: atSec };
  }

  async function frameList(id) {
    const { rows } = await pool().query(
      `SELECT id, at_sec, gcs_key FROM meeting_frames WHERE meeting_id=$1 ORDER BY at_sec, id`, [id]);
    return rows.map((r) => ({ id: Number(r.id), at_sec: r.at_sec, at: fmtTime(r.at_sec), gcs_key: r.gcs_key }));
  }

  async function frameBytes(key) {
    const [buf] = await gcs().file(key).download();
    return buf;
  }

  async function deleteMeeting(id) {
    const frames = await frameList(id).catch(() => []);
    await pool().query(`DELETE FROM meetings WHERE id=$1`, [id]);
    if (frames.length) {
      try {
        const b = gcs();
        await Promise.all(frames.map((f) => b.file(f.gcs_key).delete().catch(() => {})));
      } catch (e) { console.warn("[meeting] 静止画の削除をスキップ:", e.message); }
    }
  }

  async function createMeetingRow(a) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const heldAt = a.held_at && !isNaN(new Date(a.held_at)) ? new Date(a.held_at).toISOString() : new Date().toISOString();
    await pool().query(
      `INSERT INTO meetings (id, title, held_at, participants, memo) VALUES ($1,$2,$3,$4,$5)`,
      [id, String(a.title || "無題の会議").slice(0, 120), heldAt, String(a.participants || "").slice(0, 500), String(a.memo || "").slice(0, 5000)]);
    return id;
  }

  async function updateMeetingRow(id, a) {
    const heldAt = a.held_at && !isNaN(new Date(a.held_at)) ? new Date(a.held_at).toISOString() : null;
    await pool().query(
      `UPDATE meetings SET title = COALESCE($2, title), held_at = COALESCE($3, held_at),
              participants = COALESCE($4, participants), memo = COALESCE($5, memo), updated_at = now() WHERE id=$1`,
      [id, a.title != null ? String(a.title).slice(0, 120) : null, heldAt,
       a.participants != null ? String(a.participants).slice(0, 500) : null, a.memo != null ? String(a.memo).slice(0, 5000) : null]);
  }

  const str = { type: "string" };
  const tools = [
    {
      name: "meeting_list",
      description: "会議の一覧 (新しい順)。query を入れるとタイトル・参加者・本文で絞り込む。",
      inputSchema: { type: "object", properties: { query: str, limit: { type: "integer", description: "既定 30、最大 200" } } },
      handler: async (a) => {
        await ensureSchema();
        const limit = Math.min(200, Math.max(1, Number(a.limit) || 30));
        const q = String(a.query || "").trim();
        const like = `%${q}%`;
        const { rows } = await pool().query(
          `SELECT m.id, m.title, m.held_at, m.participants, m.memo, m.created_at, m.updated_at,
                  COUNT(s.id)::int AS segments, COALESCE(SUM(length(s.text)),0)::int AS chars,
                  COALESCE(MAX(s.start_sec),0)::int AS last_sec
             FROM meetings m LEFT JOIN meeting_segments s ON s.meeting_id = m.id
            ${q ? `WHERE m.title ILIKE $1 OR m.participants ILIKE $1 OR m.memo ILIKE $1
                   OR EXISTS (SELECT 1 FROM meeting_segments x WHERE x.meeting_id=m.id AND x.text ILIKE $1)` : ""}
            GROUP BY m.id ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT ${limit}`, q ? [like] : []);
        const recs = await recRows(q ? `WHERE title ILIKE $1 OR summary ILIKE $1 OR transcript ILIKE $1` : "", q ? [like] : [], limit);
        const list = [
          ...rows.map((r) => ({
            id: r.id, title: r.title, held_at: r.held_at || r.created_at, participants: r.participants,
            memo: r.memo, segments: r.segments, chars: r.chars, approx_minutes: Math.ceil((r.last_sec + 60) / 60) * (r.segments ? 1 : 0),
            source: "meeting", updated_at: r.updated_at,
          })),
          ...recs.map((r) => ({
            id: `rec:${r.id}`, title: r.title, held_at: r.created_at, chars: (r.transcript || "").length,
            approx_minutes: r.duration ? Math.ceil(r.duration / 60) : null, source: "rec",
          })),
        ];
        list.sort((x, y) => new Date(y.held_at) - new Date(x.held_at));
        return list.slice(0, limit);
      },
    },
    {
      name: "meeting_get",
      description: [
        "会議 1 件の文字起こし本文を返す。長いときは offset / max_chars で続きを読む (next_offset が null なら最後まで)。",
        "[mm:ss] は会議開始からの経過時間。frames は画面共有の静止画 (画面が変わった時刻)。中身は meeting_frames で見る。",
      ].join("\n"),
      inputSchema: {
        type: "object", required: ["id"],
        properties: { id: str, offset: { type: "integer" }, max_chars: { type: "integer", description: "既定 60000" } },
      },
      handler: async (a) => {
        await ensureSchema();
        const id = String(a.id || "");
        let meta, text;
        if (id.startsWith("rec:")) {
          const r = (await recRows(`WHERE id=$1`, [id.slice(4)], 1))[0];
          if (!r) throw new Error(`見つかりません: ${id}`);
          meta = { id, title: r.title, held_at: r.created_at, source: "rec", summary: r.summary };
          text = r.transcript || "";
        } else {
          const m = await mustMeeting(id);
          const frames = await frameList(id);
          meta = {
            id, title: m.title, held_at: m.held_at || m.created_at, participants: m.participants, memo: m.memo, source: "meeting",
            frames: frames.map((f) => ({ frame_id: f.id, at: f.at })),
          };
          text = await meetingText(id);
        }
        const offset = Math.max(0, Number(a.offset) || 0);
        const max = Math.min(200000, Math.max(1000, Number(a.max_chars) || 60000));
        const slice = text.slice(offset, offset + max);
        return { ...meta, total_chars: text.length, offset, next_offset: offset + max < text.length ? offset + max : null, transcript: slice };
      },
    },
    {
      name: "meeting_search",
      description: "全会議の本文から語句を探し、前後の文脈付きで返す。どの会議で話したか探すとき用。",
      inputSchema: { type: "object", required: ["query"], properties: { query: str, limit: { type: "integer", description: "既定 20" } } },
      handler: async (a) => {
        await ensureSchema();
        const q = String(a.query || "").trim();
        if (!q) throw new Error("query が空です");
        const limit = Math.min(100, Math.max(1, Number(a.limit) || 20));
        const like = `%${q}%`;
        const { rows } = await pool().query(
          `SELECT s.meeting_id, m.title, s.start_sec, s.source, s.text
             FROM meeting_segments s JOIN meetings m ON m.id = s.meeting_id
            WHERE s.text ILIKE $1 ORDER BY COALESCE(m.held_at, m.created_at) DESC, s.part, s.start_sec LIMIT ${limit}`, [like]);
        const snip = (t) => {
          const i = t.toLowerCase().indexOf(q.toLowerCase());
          return (i > 80 ? "…" : "") + t.slice(Math.max(0, i - 80), i + q.length + 120) + (i + q.length + 120 < t.length ? "…" : "");
        };
        const hits = rows.map((r) => ({ id: r.meeting_id, title: r.title, at: r.source === "audio" ? fmtTime(r.start_sec) : null, snippet: snip(r.text) }));
        for (const r of await recRows(`WHERE transcript ILIKE $1 OR summary ILIKE $1`, [like], limit)) {
          hits.push({ id: `rec:${r.id}`, title: r.title, at: null, snippet: snip(`${r.transcript || ""}\n${r.summary || ""}`) });
        }
        return hits.slice(0, limit);
      },
    },
    {
      name: "meeting_frames",
      description: [
        "会議中に共有された画面の静止画を返す (画像で見られる)。画面が変わったときだけ撮ってある。",
        "frame_ids で直接指定するか、from / to (\"mm:ss\" か秒) で時間帯を指定。1 回 max 枚 (既定 6、最大 12)。",
      ].join("\n"),
      inputSchema: {
        type: "object", required: ["id"],
        properties: {
          id: str, frame_ids: { type: "array", items: { type: "integer" } },
          from: { type: ["string", "integer"] }, to: { type: ["string", "integer"] }, max: { type: "integer" },
        },
      },
      handler: async (a) => {
        await ensureSchema();
        const m = await mustMeeting(a.id);
        const toSec = (v) => {
          if (v == null || v === "") return null;
          if (typeof v === "number") return v;
          const parts = String(v).split(":").map(Number);
          return parts.reduce((acc, n) => acc * 60 + (n || 0), 0);
        };
        let frames = await frameList(m.id);
        const total = frames.length;
        if (Array.isArray(a.frame_ids) && a.frame_ids.length) {
          const want = new Set(a.frame_ids.map(Number));
          frames = frames.filter((f) => want.has(f.id));
        } else {
          const from = toSec(a.from), to = toSec(a.to);
          if (from != null) frames = frames.filter((f) => f.at_sec >= from);
          if (to != null) frames = frames.filter((f) => f.at_sec <= to);
        }
        const max = Math.min(12, Math.max(1, Number(a.max) || 6));
        const picked = frames.slice(0, max);
        if (!picked.length) return `該当する静止画がありません (この会議の静止画は全 ${total} 枚)`;
        const content = [{ type: "text", text: `${m.title} の画面 ${picked.length} 枚 (該当 ${frames.length} 枚 / 全 ${total} 枚)` }];
        for (const f of picked) {
          content.push({ type: "text", text: `frame_id ${f.id} ・ [${f.at}]` });
          content.push({ type: "image", data: (await frameBytes(f.gcs_key)).toString("base64"), mimeType: "image/jpeg" });
        }
        if (frames.length > picked.length) {
          content.push({ type: "text", text: `続きあり: from を "${frames[picked.length].at}" にして呼ぶ` });
        }
        return { content };
      },
    },
    {
      name: "meeting_create",
      description: "新しい会議を作る (他ツールの文字起こしを貼り込む用)。返ってきた id に meeting_add_text で中身を足す。",
      inputSchema: {
        type: "object", required: ["title"],
        properties: { title: str, held_at: { type: "string", description: "ISO 8601 (省略時は今)" }, participants: str, memo: str },
      },
      handler: async (a) => {
        await ensureSchema();
        return { id: await createMeetingRow(a) };
      },
    },
    {
      name: "meeting_add_text",
      description: "会議に文字起こし済みのテキスト (他ツールの書き出し・手書きメモ) を 1 まとまり足す。",
      inputSchema: { type: "object", required: ["meeting_id", "text"], properties: { meeting_id: str, text: str } },
      handler: async (a) => {
        await ensureSchema();
        const m = await mustMeeting(a.meeting_id);
        const text = String(a.text || "").trim();
        if (!text) throw new Error("text が空です");
        if (text.length > 400000) throw new Error("テキストが長すぎます (40 万字まで)");
        const part = await nextPart(m.id);
        await pool().query(
          `INSERT INTO meeting_segments (meeting_id, part, start_sec, text, source) VALUES ($1,$2,0,$3,'text')`, [m.id, part, text]);
        await pool().query(`UPDATE meetings SET updated_at = now() WHERE id=$1`, [m.id]);
        return { meeting_id: m.id, part, chars: text.length };
      },
    },
    {
      name: "meeting_update",
      description: "会議のタイトル・日時・参加者・メモを直す (渡した項目だけ)。",
      inputSchema: {
        type: "object", required: ["id"],
        properties: { id: str, title: str, held_at: str, participants: str, memo: str },
      },
      handler: async (a) => {
        await ensureSchema();
        const m = await mustMeeting(a.id);
        await updateMeetingRow(m.id, a);
        return { id: m.id, ok: true };
      },
    },
    {
      name: "meeting_delete",
      description: "会議を文字起こしごと削除する (元に戻せない)。ユーザーが明示的に頼んだときだけ使う。",
      inputSchema: { type: "object", required: ["id"], properties: { id: str } },
      handler: async (a) => {
        await ensureSchema();
        const m = await mustMeeting(a.id);
        await deleteMeeting(m.id);
        return { id: m.id, deleted: true };
      },
    },
  ];

  // ── アプリ (/gijiroku/) 用 REST。/api の Firebase 認証 middleware の後ろに登録すること ──
  function registerRoutes(app) {
    const wrap = (fn) => async (req, res) => {
      try { await ensureSchema(); await fn(req, res); }
      catch (e) {
        const msg = String(e?.message || e);
        console.error("[meeting]", req.method, req.path, msg);
        const transient = /\b(503|429|500)\b|UNAVAILABLE|overload/i.test(msg);
        res.status(/見つかりません/.test(msg) ? 404 : transient ? 503 : 500).json({ error: transient ? "Gemini が混雑中です" : msg });
      }
    };
    app.get("/api/meeting", wrap(async (req, res) => {
      const { rows } = await pool().query(
        `SELECT m.id, m.title, m.held_at AS "heldAt", m.participants, m.updated_at AS "updatedAt",
                COUNT(DISTINCT s.id)::int AS segments, COALESCE(MAX(s.start_sec),0)::int AS "lastSec",
                (SELECT COUNT(*)::int FROM meeting_frames f WHERE f.meeting_id = m.id) AS frames
           FROM meetings m LEFT JOIN meeting_segments s ON s.meeting_id = m.id
          GROUP BY m.id ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT 300`);
      res.json(rows);
    }));
    app.post("/api/meeting", wrap(async (req, res) => {
      res.status(201).json({ id: await createMeetingRow(req.body || {}) });
    }));
    app.get("/api/meeting/:id", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      const { rows } = await pool().query(
        `SELECT part, start_sec AS "startSec", text, source FROM meeting_segments WHERE meeting_id=$1 ORDER BY part, start_sec`, [m.id]);
      const frames = (await frameList(m.id)).map((f) => ({ id: f.id, atSec: f.at_sec }));
      res.json({
        id: m.id, title: m.title, heldAt: m.held_at, participants: m.participants, memo: m.memo,
        segments: rows, frames,
      });
    }));
    app.put("/api/meeting/:id", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      await updateMeetingRow(m.id, req.body || {});
      res.json({ id: m.id, ok: true });
    }));
    app.delete("/api/meeting/:id", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      await deleteMeeting(m.id);
      res.status(204).end();
    }));
    app.post("/api/meeting/:id/audio", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      const b = req.body || {};
      res.json(await transcribeChunk(m, { audio: b.audio, mimeType: b.mimeType, startSec: b.startSec, part: b.part }));
    }));
    app.post("/api/meeting/:id/text", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      const text = String(req.body?.text || "").trim();
      if (!text) return res.status(400).json({ error: "text が空です" });
      const part = await nextPart(m.id);
      await pool().query(
        `INSERT INTO meeting_segments (meeting_id, part, start_sec, text, source) VALUES ($1,$2,0,$3,'text')`, [m.id, part, text.slice(0, 400000)]);
      await pool().query(`UPDATE meetings SET updated_at = now() WHERE id=$1`, [m.id]);
      res.status(201).json({ part });
    }));
    app.post("/api/meeting/:id/frame", wrap(async (req, res) => {
      const m = await mustMeeting(req.params.id);
      const b = req.body || {};
      res.status(201).json(await saveFrame(m, { image: b.image, atSec: b.atSec, width: b.width, height: b.height }));
    }));
    app.get("/api/meeting/:id/frame/:fid", wrap(async (req, res) => {
      const { rows } = await pool().query(
        `SELECT gcs_key FROM meeting_frames WHERE id=$1 AND meeting_id=$2`, [Number(req.params.fid) || 0, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "not found" });
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.end(await frameBytes(rows[0].gcs_key));
    }));
  }

  function mcpRoute() {
    const handler = createMcpHandler({ name: "meeting", instructions: INSTRUCTIONS, tools });
    return async (req, res) => {
      let ok = false;
      try { ok = await tokenOk(req.params.token); } catch { ok = false; }
      if (!ok) return res.status(403).json({ error: "forbidden" });
      return handler(req, res);
    };
  }

  return { mcpRoute, registerRoutes, tools, instructions: INSTRUCTIONS };
}
