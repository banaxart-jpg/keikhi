import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Storage } from "@google-cloud/storage";
import pg from "pg";
import crypto from "node:crypto";

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.0-flash",
  RECEIPTS_BUCKET,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_INSTANCE_CONNECTION_NAME,
  PORT = 8080,
} = process.env;

const app = express();
app.use(express.json({ limit: "20mb" }));

// --- CORS (sandbox: open to all; tighten later) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Lazy clients ---
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const storage = RECEIPTS_BUCKET ? new Storage() : null;

let pool = null;
function getPool() {
  if (pool) return pool;
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

// --- Receipt scan: parse with Gemini, optionally upload to GCS ---
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

// --- Records CRUD ---
app.get("/api/records", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      "SELECT id, date, store, total, category, work_type AS \"workType\", payment, buyer, site, memo, image_url AS \"imageUrl\", created_at AS \"createdAt\" FROM records ORDER BY date DESC, id DESC LIMIT 500"
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

app.listen(PORT, () => console.log(`keikhi-api listening on ${PORT}`));
