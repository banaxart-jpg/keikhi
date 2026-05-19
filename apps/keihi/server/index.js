import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Storage } from "@google-cloud/storage";
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
app.use("/api", async (req, res, next) => {
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
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const prompt = `領収書を読み取りJSONのみ返してください。\n{"date":"${today}","store":"","total":0,"category":"材料費 or 接待交際費 or ガソリン代 or 駐車場代 or 工具・備品 or 外注費 or その他","workType":"水道 or 電気 or 木工 or 塗装 or 左官 or 内装 or 外構 or 解体 or 設備 or その他","site":"${sites.join(" or ")}から最も近いものまたは空文字"}`;
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: image, mimeType } },
    ]);
    const text = result.response.text();
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("AI response did not contain JSON");
    const parsed = JSON.parse(text.slice(s, e + 1));
    res.json({ ...parsed, imageUrl });
  } catch (err) {
    console.error("scan error", err);
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
  //  - それ以外        → apps/keihi/web 配下の静的ファイル（ランチャー & 各ミニアプリ）
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const webDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../web"
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
