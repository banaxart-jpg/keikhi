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
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",
  RECEIPTS_BUCKET,
  SHEET_ID,
  INVOICE_SHEET_ID,
  DRIVE_FOLDER_ID,
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
// kotonoha/techstudy で他メンバーの進捗を閲覧できるオーナー (社長) のみのホワイトリスト。
// 従業員同士の比較は不可。env で上書き可。
const KOTONOHA_OWNER_EMAILS = new Set(
  (process.env.KOTONOHA_OWNER_EMAILS || "info@banax.tokyo,konishi0221@gmail.com")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

const app = express();
app.use(express.json({ limit: "20mb" }));

// バージョン情報 (デプロイ確認用) ※ 認証不要、CORS の後ろに置く必要あり
const APP_VERSION = process.env.APP_VERSION || "dev";
const BUILD_ID = process.env.BUILD_ID || "";
const SERVER_STARTED_AT = new Date().toISOString();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// バージョン情報 (CORS の後、認証 middleware の前 = 公開エンドポイント)
app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, buildId: BUILD_ID, startedAt: SERVER_STARTED_AT });
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
    // techstudy (kotonoha) だけは社外含む任意の Firebase 認証ユーザーに開放。
    // 他のミニアプリ (keihi/kaigi 等) は引き続き ALLOWED_EMAILS の社内限定。
    // techstudy (/kotonoha) と「現場一覧の GET」は社外 auth ユーザーにも開放。
    //   手配リスト (kaimono) が誰でも入れる仕様で、現場タブを構築するのに /sites
    //   の読み取りだけは要る (POST/DELETE は社内限定のまま)
    const isKotonoha = req.path.startsWith("/kotonoha/");
    const isPublicSitesRead = req.method === "GET" && req.path === "/sites";
    if (!isKotonoha && !isPublicSitesRead && allowList.length && !allowList.includes((decoded.email || "").toLowerCase())) {
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
// 共通の Google 認証クライアント (Sheets と Drive 両方のスコープ)
let googleAuthClient = null;
async function getGoogleAuth() {
  if (googleAuthClient) return googleAuthClient;
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  googleAuthClient = await auth.getClient();
  return googleAuthClient;
}
let sheetsApi = null;
async function getSheetsApi() {
  if (sheetsApi) return sheetsApi;
  sheetsApi = google.sheets({ version: "v4", auth: await getGoogleAuth() });
  return sheetsApi;
}
let driveApi = null;
async function getDriveApi() {
  if (driveApi) return driveApi;
  driveApi = google.drive({ version: "v3", auth: await getGoogleAuth() });
  return driveApi;
}

// 画像/PDF を Drive の指定フォルダにアップロードして「リンクを知ってる人は閲覧可」に。
// 失敗しても本体処理は止めない (null を返す)。
async function uploadToDrive(buffer, filename, mimeType) {
  if (!DRIVE_FOLDER_ID) return null;
  try {
    const drive = await getDriveApi();
    const created = await drive.files.create({
      requestBody: { name: filename, parents: [DRIVE_FOLDER_ID], mimeType },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    await drive.permissions.create({
      fileId: created.data.id,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true,
    });
    const url = created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`;
    console.log(`[drive] uploaded id=${created.data.id} name=${filename}`);
    return { id: created.data.id, url };
  } catch (e) {
    console.warn(`[drive] upload FAILED ${filename}: ${e.message}`);
    return null;
  }
}
const SHEET_HEADER = ["購入日", "購入者", "現場", "店舗", "金額", "費目", "工種", "支払方法", "メモ", "写真"];
// 短期キャッシュ (60秒)。タブ削除→再登録の整合性のため永続キャッシュは避ける。
const sheetEnsuredCache = new Map(); // key -> timestamp (ms)
const SHEET_ENSURED_TTL = 60_000;
async function ensureSheetTabGeneric(sheets, spreadsheetId, ym, header, dateCols = [], hiddenCols = []) {
  const key = `${spreadsheetId}:${ym}`;
  const cachedAt = sheetEnsuredCache.get(key);
  if (cachedAt && Date.now() - cachedAt < SHEET_ENSURED_TTL) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  let found = (meta.data.sheets || []).find((s) => s.properties && s.properties.title === ym);
  let sheetId;
  let isNew = !found;
  // 既存タブのヘッダーが今のフォーマットと違ったら、安全のため -old にリネームして新規作成
  if (found) {
    try {
      const a1 = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${ym}!A1:A1` });
      const firstCell = a1.data.values?.[0]?.[0];
      if (firstCell !== header[0]) {
        // 旧フォーマット → リネームして新規作成
        const oldTitle = `${ym}-old-${Date.now()}`;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{
            updateSheetProperties: {
              properties: { sheetId: found.properties.sheetId, title: oldTitle },
              fields: "title",
            },
          }] },
        });
        console.log(`[sheets] renamed legacy tab ${ym} → ${oldTitle} (header mismatch)`);
        found = null;
        isNew = true;
      }
    } catch (e) {
      console.warn(`[sheets] header check failed for ${ym}: ${e.message}`);
    }
  }
  if (isNew) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ym, index: 0, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ym}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [header] },
    });
  } else {
    sheetId = found.properties.sheetId;
  }
  if (sheetId != null && (dateCols.length || (isNew && hiddenCols.length))) {
    const requests = [];
    for (const col of dateCols) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    if (isNew) {
      for (const col of hiddenCols) {
        requests.push({
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: col, endIndex: col + 1 },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser",
          },
        });
      }
    }
    if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
  sheetEnsuredCache.set(key, Date.now());
}
async function ensureSheetTab(sheets, ym) {
  return ensureSheetTabGeneric(sheets, SHEET_ID, ym, SHEET_HEADER, [0]);
}
async function appendRecordToSheet(r) {
  if (!SHEET_ID) return;
  // 現場が未設定 (未 SORT) のレコードはシートに送らない
  if (!r.site) return;
  try {
    const sheets = await getSheetsApi();
    const ym = String(r.date || "").slice(0, 7) || "unknown";
    await ensureSheetTab(sheets, ym);
    // 「写真」セル: Drive URL (アプリ不要で見られる) を優先、無ければアプリ内ビューア
    const photoLinkUrl = r.driveUrl
      || (r.id ? `https://keihi-496002.web.app/keihi/?view=${r.id}` : "");
    const photoCell = photoLinkUrl ? `=HYPERLINK("${String(photoLinkUrl).replace(/"/g, '""')}","🧾")` : "";
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
// 月別×方向 (YYYY-MM-売上 / YYYY-MM-支払) のタブに append、年別サマリータブを自動更新
// 先頭の「ID」列はサマリー集計時に「同 ID は最新行を採用」するためのキー (画面では非表示)
const INVOICE_HEADER = ["ID", "発行日", "期限", "状態", "完了日", "振込先", "金額", "分類", "現場", "銀行", "支店", "種別", "口座番号", "名義", "メモ", "写真"];
const SUMMARY_HEADER = ["月", "売上合計", "入金済", "未入金", "支払合計", "支払済", "未払"];

async function appendInvoiceToSheet(r) {
  if (!INVOICE_SHEET_ID) return { skipped: true };
  try {
    const sheets = await getSheetsApi();
    const ym = String(r.issueDate || (r.createdAt || "").slice(0, 10) || "").slice(0, 7) || "unknown";
    const dirLbl = r.direction === "out" ? "売上" : "支払";
    const tabName = `${ym}-${dirLbl}`;
    // 月別×方向タブ。日付列 = 発行日(1), 期限(2), 完了日(4)、ID 列(0) を非表示
    await ensureSheetTabGeneric(sheets, INVOICE_SHEET_ID, tabName, INVOICE_HEADER, [1, 2, 4], [0]);
    const acc = r.account || {};
    const statusLbl = r.status === "paid"
      ? (r.direction === "out" ? "入金済" : "支払済")
      : (r.direction === "out" ? "未入金" : "未払い");
    // 「写真」セル: Drive URL (アプリ不要、税理士共有用) を優先、無ければアプリ内ビューア
    const photoLinkUrl = r.driveUrl
      || (r.imageUrl ? `https://keihi-496002.web.app/seikyu/?view=${encodeURIComponent(r.imageUrl)}` : "");
    const photoCell = photoLinkUrl
      ? `=HYPERLINK("${String(photoLinkUrl).replace(/"/g, '""')}","🧾")`
      : "";
    await sheets.spreadsheets.values.append({
      spreadsheetId: INVOICE_SHEET_ID,
      range: `${tabName}!A:P`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          r.id || "", r.issueDate || "", r.dueDate || "", statusLbl, r.paidAt || "",
          r.issuer || "", Number(r.total) || 0, r.category || "", r.site || "",
          acc.bank || "", acc.branch || "", acc.type || "", acc.number || "",
          acc.holder || "", r.memo || "", photoCell,
        ]],
      },
    });
    // 年別サマリーを更新 (失敗しても本体は成功扱い)
    const year = ym.slice(0, 4);
    if (/^\d{4}$/.test(year)) {
      await updateInvoiceSummary(sheets, year, ym).catch((e) => console.warn(`[invoice-sheets] summary update FAILED: ${e.message}`));
    }
    console.log(`[invoice-sheets] appended tab=${tabName} issuer=${r.issuer}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[invoice-sheets] FAILED: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// 年別サマリータブ (YYYY-サマリー) の対象月の行を更新
// SUMIFS 式をセルに埋め込むので、データ追加・状態変更があったら Sheets 側で
// 自動的に再計算される (サーバ側で値を読んで書き直す必要がない)
async function updateInvoiceSummary(sheets, year, ym) {
  const summaryTab = `${year}-サマリー`;
  await ensureSheetTabGeneric(sheets, INVOICE_SHEET_ID, summaryTab, SUMMARY_HEADER, []);
  const salesTab = `${ym}-売上`;
  const expTab = `${ym}-支払`;
  // 金額 = G, 状態 = D
  const sumAll = (t) => `IFERROR(SUM('${t}'!G2:G),0)`;
  const sumIf = (t, lbl) => `IFERROR(SUMIFS('${t}'!G:G,'${t}'!D:D,"${lbl}"),0)`;
  // 月セルは先頭にアポストロフィを付けて Sheets に文字列として保存させる
  // (USER_ENTERED は "2026-05" を日付シリアルに変換するため)
  const rowValues = [
    `'${ym}`,
    `=${sumAll(salesTab)}`,
    `=${sumIf(salesTab, "入金済")}`,
    `=${sumIf(salesTab, "未入金")}`,
    `=${sumAll(expTab)}`,
    `=${sumIf(expTab, "支払済")}`,
    `=${sumIf(expTab, "未払い")}`,
  ];
  const sumRes = await sheets.spreadsheets.values.get({
    spreadsheetId: INVOICE_SHEET_ID,
    range: `${summaryTab}!A:A`,
  });
  const monthCol = (sumRes.data.values || []).map((r) => r[0]);
  const rowIdx = monthCol.findIndex((m) => m === ym);
  if (rowIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: INVOICE_SHEET_ID,
      range: `${summaryTab}!A${rowIdx + 1}:G${rowIdx + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: INVOICE_SHEET_ID,
      range: `${summaryTab}!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    });
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

// 起動時のスキーマ自動マイグレーション (新しい列の追加のみ。冪等)
let schemaMigrated = false;
async function ensureSchema() {
  if (schemaMigrated) return;
  const p = getPool();
  if (!p) return;
  try {
    await p.query("ALTER TABLE records ADD COLUMN IF NOT EXISTS drive_url TEXT");
    await p.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        from_email TEXT NOT NULL,
        to_email TEXT NOT NULL,
        priority INT NOT NULL DEFAULT 2,
        deadline DATE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaMigrated = true;
    console.log("[schema] migration ok: records.drive_url + tasks ensured");
  } catch (e) {
    console.warn(`[schema] migration warning: ${e.message}`);
  }
}
ensureSchema().catch(() => {});

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

// 任意の gs://... パスから 5 分有効の signed URL を発行。seikyu のシート連携で
// 写真リンクをアプリ内表示するために使う。認証経由のみ。
app.get("/api/image-signed", async (req, res) => {
  if (!storage) return res.status(503).json({ error: "storage not configured" });
  const gs = String(req.query.gs || "");
  if (!gs.startsWith("gs://")) return res.status(400).json({ error: "invalid gs path" });
  try {
    const [, , bucket, ...rest] = gs.split("/");
    const objectPath = rest.join("/");
    const [url] = await storage.bucket(bucket).file(objectPath).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 5 * 60 * 1000,
    });
    res.json({ url });
  } catch (err) {
    console.error("image-signed error", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────
// Tasks (task ミニアプリ用。小西↔名取の依頼ボード)
// ─────────────────────────────
app.get("/api/tasks", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "db not configured" });
  await ensureSchema();
  const me = (req.user?.email || "").toLowerCase();
  try {
    const { rows } = await p.query(
      `SELECT id, title, from_email AS "fromEmail", to_email AS "toEmail",
              priority, deadline, status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks
       WHERE LOWER(from_email) = $1 OR LOWER(to_email) = $1 OR to_email = 'both'
       ORDER BY status ASC, priority ASC, COALESCE(deadline, '9999-12-31') ASC, created_at DESC`,
      [me],
    );
    res.json({ tasks: rows, me });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tasks", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "db not configured" });
  await ensureSchema();
  const me = (req.user?.email || "").toLowerCase();
  const { title, toEmail, priority, deadline } = req.body || {};
  if (!title || !toEmail) return res.status(400).json({ error: "title and toEmail required" });
  const id = crypto.randomUUID();
  try {
    await p.query(
      `INSERT INTO tasks (id, title, from_email, to_email, priority, deadline)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, String(title).trim(), me, String(toEmail).toLowerCase(), Number(priority) || 2, deadline || null],
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/tasks/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "db not configured" });
  await ensureSchema();
  const me = (req.user?.email || "").toLowerCase();
  const body = req.body || {};
  // 指定されたフィールドだけ動的に SET。deadline は明示的に null を送れば「期限なし」
  const sets = [];
  const args = [req.params.id, me];
  const add = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if ("title" in body) add("title", String(body.title).trim());
  if ("toEmail" in body) add("to_email", String(body.toEmail).toLowerCase());
  if ("priority" in body) add("priority", Number(body.priority));
  if ("deadline" in body) add("deadline", body.deadline || null);
  if ("status" in body) add("status", String(body.status));
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at = NOW()");
  try {
    const { rowCount } = await p.query(
      `UPDATE tasks SET ${sets.join(", ")}
       WHERE id = $1 AND (LOWER(from_email) = $2 OR LOWER(to_email) = $2 OR to_email = 'both')`,
      args,
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "db not configured" });
  await ensureSchema();
  const me = (req.user?.email || "").toLowerCase();
  try {
    const { rowCount } = await p.query(
      `DELETE FROM tasks WHERE id = $1 AND (LOWER(from_email) = $2 OR LOWER(to_email) = $2 OR to_email = 'both')`,
      [req.params.id, me],
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/scan", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { image, mimeType = "image/jpeg", sites = [], kind = "receipt", direction = "in" } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64) is required" });

    let imageUrl = null;
    let driveUrl = null;
    const buf = Buffer.from(image, "base64");
    const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
    const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    // GCS にアップロード (本体ストレージ。失敗しても AI 読取は続行)
    if (storage && RECEIPTS_BUCKET) {
      try {
        await storage
          .bucket(RECEIPTS_BUCKET)
          .file(key)
          .save(buf, { contentType: mimeType, resumable: false });
        imageUrl = `gs://${RECEIPTS_BUCKET}/${key}`;
        console.log(`[scan] uploaded ${imageUrl} (${buf.length} bytes, ${mimeType})`);
      } catch (e) {
        console.warn(`[scan] GCS upload FAILED (bucket=${RECEIPTS_BUCKET}, key=${key}): ${e.code || ""} ${e.message}`);
      }
    } else {
      console.warn(`[scan] image not saved (storage=${!!storage}, bucket=${RECEIPTS_BUCKET || "(empty)"})`);
    }
    // Drive にもアップロード (税理士共有用。リンクを知ってる人は閲覧可)
    if (DRIVE_FOLDER_ID) {
      const dr = await uploadToDrive(buf, key.replace(/\//g, "_"), mimeType);
      if (dr) driveUrl = dr.url;
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
        prompt = `画像/PDF は自社（発行元、社名は無視してよい）が取引先に向けて発行した請求書です。全て検出して JSON のみ返してください。issuer には自社名ではなく「振込先＝請求書を受け取る取引先（顧客）の名前」を入れること。形式:
{"receipts":[{"issuer":"取引先（請求書の宛先・顧客名。自社名は絶対に入れない。「株式会社」等は省略可）","total":請求金額の数値,"dueDate":"YYYY-MM-DD(入金期限。読めなければ空文字)","issueDate":"YYYY-MM-DD(発行日。読めなければ${today})","category":"工事代金 or その他",${siteFmt},${accountFmt},"memo":"工事名 / 件名 / 摘要を短く"}]}`;
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
    res.json({ receipts, imageUrl, driveUrl, modelUsed });
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

// UI テンプレ適用グループ (汎用化のため content config に外出し)
const UI_TEMPLATE_GROUPS = new Set(KOTONOHA_GENRES_DATA?.ui_template_groups || []);
// ui_parts の中でも「これ知らなきゃ話にならない」基本セット。
// 初期 (= ユーザーの ui_parts unique 正解数 < UI_TIER1_THRESHOLD) は
// これだけ出題する。マスター済になったら全 ui_parts 解禁。
const UI_TIER1_THRESHOLD = 18; // tier1 を概ね一周したら次に進む目安
const UI_TIER1_GENRES = new Set([
  // 入力系 (フォーム部品)
  "テキスト入力 (input)","テキストエリア (textarea)","パスワード入力","数値入力",
  "検索バー","チェックボックス","ラジオボタン","スイッチ / トグル",
  "セレクト / ドロップダウン","ラベル",
  // ボタン
  "ボタン (Primary)","セカンダリボタン","アイコンボタン","送信ボタン",
  // ナビゲーション / 構造
  "ヘッダー / トップバー","フッター","タブ","ハンバーガーメニュー","戻るボタン",
  // フィードバック / 状態
  "モーダル","ダイアログ","トースト","ツールチップ",
  "プログレスバー","スピナー / ローダー","スケルトン",
  // 表示
  "カード","リスト / テーブル","アイコン","バッジ","アバター",
]);
const UI_TEMPLATE_GENRES_BY_GROUP = (() => {
  const m = new Map();
  for (const gid of UI_TEMPLATE_GROUPS) {
    const g = KOTONOHA_GENRES_DATA?.groups?.find((x) => x.id === gid);
    if (g) m.set(gid, g.genres.map((x) => x.name));
  }
  return m;
})();

// UI テンプレ問題を「この機能の名前はなんでしょう？」+ ジャンル名4択に統一
function buildUiPartsQuestion(q) {
  if (!q.group_id || !UI_TEMPLATE_GROUPS.has(q.group_id) || !q.genre) return q;
  const others = (UI_TEMPLATE_GENRES_BY_GROUP.get(q.group_id) || []).filter((n) => n !== q.genre);
  // ランダムに 3 個選ぶ
  const distractors = [];
  const pool = others.slice();
  while (distractors.length < 3 && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    distractors.push(pool.splice(idx, 1)[0]);
  }
  const options = [q.genre, ...distractors];
  // シャッフル
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return {
    ...q,
    question: "この機能の名前はなんでしょう？",
    options,
    type: "choice",
  };
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

// pickWeakGenres は ensureMinPool に統合済み (削除)

// AI で新しい問題を生成 (バックグラウンド呼出し or 明示呼出し)
// ジャンル指定すれば該当ジャンル、なしならジャンル空間からランダム選出。
// userEmail を渡すと「このユーザーがこのジャンルでどこまで理解してるか」を
// 計算して、深さに応じた問題を生成 (前提知識ゲート)。
// ============================================================
// kotonoha v3 (refactored): シンプルな depth ベース設計
// ============================================================
// 設計原則:
// 1. 全ユーザー共通の難易度進行 (depth 1-5 = ジャンル内の階段)
// 2. 出題条件: ジャンル内 unique 正解数 + 1 までの depth しか出ない
//    → VPC 0回正解の人には VPC depth 1 (入門) のみ
//    → VPC 1回正解で depth 1-2 が解放
//    → VPC 4回正解で depth 1-5 全部解放
// 3. 選定: (未回答 OR 不正解継続 OR 正解後50-100問経過) AND depth ゲート OK
//    → ORDER BY random() で完全シャッフル
// 4. 生成: pool < 30 のときだけ sessions/start で sync 生成 (max 8)
// 5. ユーザー個別 level / mastered / priority / maxDiff の概念は廃止

const KOTONOHA_DEPTH_GUIDE = {
  1: "完全初心者向け。「そもそも何の道具?」「身近な例えで言うと?」レベル。専門用語禁止、必要なら問題文で1行説明。",
  2: "基本特徴。「いつ使う?」「何が違う?」「身近なシーンでの例」レベル。",
  3: "用途と判断。「どっち選ぶ?」「なぜ〇〇は△△より速い?」レベル。",
  4: "応用。「もしも〇〇だったら何が起きる?」「歴史的にどう生まれた?」レベル。",
  5: "深い洞察。「設計判断の根拠」「トレードオフ」レベル。前提知識ゼロでも問題文だけで答えられること。",
};

// ユーザーが既に正解してるジャンル名のリスト (= 既知の概念)
async function getKnownGenres(p, email) {
  if (!email) return [];
  const { rows } = await p.query(
    `SELECT DISTINCT q.genre FROM kotonoha_progress pr
       JOIN kotonoha_questions q ON q.id = pr.question_id
      WHERE pr.user_email = $1 AND pr.is_correct AND q.genre IS NOT NULL`,
    [email]
  );
  return rows.map((r) => r.genre);
}

// AI で1問生成 (genre, depth, ユーザーの既知ジャンル指定)。失敗時は null。
async function generateQuestion(p, { genre, depth, excludeAnswers = [], knownGenres = [] }) {
  if (!genAI) return null;
  if (!genre) {
    const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys());
    if (!all.length) return null;
    genre = all[Math.floor(Math.random() * all.length)];
  }
  const groupId = KOTONOHA_GENRE_TO_GROUP.get(genre) || null;
  const cat = groupId || "concept";
  const d = Math.min(5, Math.max(1, depth || 1));
  const guide = KOTONOHA_DEPTH_GUIDE[d];

  const vocabLine = knownGenres.length
    ? `ユーザーが既に理解してる用語 (これらは問題内で使ってOK): ${knownGenres.slice(0, 80).join(", ")}`
    : "ユーザーはこの分野の用語をほぼ知らない。専門用語は使わず、身近な例えだけで問題を作る。";

  const subject = KOTONOHA_GENRES_DATA?.domain?.ai_subject || "学習対象";
  const triviaExamples = KOTONOHA_GENRES_DATA?.domain?.ai_trivia_examples || [];
  const triviaLine = triviaExamples.length
    ? `(例: ${triviaExamples.slice(0, 3).map((s) => `「${s}」`).join(" / ")})`
    : "";

  // prerequisites に使える master 名一覧 (同グループ全部 + 他グループ各6個ずつ)。
  // ここに無い名前を AI が書いても出題側で破棄されるので、有効候補を明示する。
  const sameGroupGenres = (KOTONOHA_GENRES_DATA?.groups || [])
    .find((gr) => gr.id === groupId)?.genres?.map((g) => g.name) || [];
  const otherGroupSamples = (KOTONOHA_GENRES_DATA?.groups || [])
    .filter((gr) => gr.id !== groupId)
    .flatMap((gr) => (gr.genres || []).slice(0, 6).map((g) => g.name));
  const prereqPool = [...new Set([...sameGroupGenres, ...otherGroupSamples])].filter((n) => n !== genre);
  const prereqLine = `prerequisites に書ける有効な名前リスト (この中の文字列を完全一致で書く。書いた名前で「ユーザーがその概念を知ってる」かサーバーが判定する。リスト外を書いても無視される):
${prereqPool.slice(0, 200).join(" / ")}`;

  const prompt = `「${subject}」の学習問題を1問作って。JSON のみ返す。

ジャンル: ${genre}
深さ: ${d}/5 (${guide})
形式: 4択

★絶対ルール (これ守らないと出題不可):
1. **「${genre}」という用語そのものを question 本文に必ず「${genre}」の形 (鉤括弧つき) で入れる**。
   良い例: 「「${genre}」って何のための道具？」「「${genre}」はどんな時に使う？」「「${genre}」の役割は次のうちどれ？」
   ダメな例 (用語を隠して概念だけ抽象化する):
     - 「データに間違いがないか調べるには？」 (genre 名なし)
     - 「インターネットで「住所」の役割をするものは何？」 (genre が IP アドレスなのに「住所」と言い換えてる)
   → 用語を隠して比喩で問うと、選択肢に同じ比喩を入れた瞬間「答えが質問にある」状態になる。
2. options は **「${genre}」の役割・働き・特徴** を日常語の動詞句で説明した短句。
   1つだけ ${genre} を正しく説明し、残り3つは「全然違うことをする道具の説明」にする。
3. **options に質問文の言い換えを入れない**。
   ダメな例: 質問「「${genre}」の役割は？」+ options に「${genre}」or「${genre} と同じ意味の言葉」
   ダメな例: 質問「ID アドレスは何の役目？」+ options に「インターネット上での住所」
   → 同義反復は出題として無価値。options は具体的な「何をする道具/概念か」を別の角度から説明する。
4. 4択は明確に違う概念の説明にする。「どっち優先？」「どちらの表現を…？」みたいに
   複数選択肢が同じくらい妥当になる問い方は禁止。一つの明確な正解が必要。

★★★i+1 ルール (最も重要・絶対遵守):★★★
1問に含めていい「ユーザーが知らない用語」は **今学んでる「${genre}」の 1 個だけ**。
2個以上の未知用語があると人間はやる気をなくす。即不採用。
だが「${genre}」自身は隠さず、堂々と question に書くこと (= 学習対象)。

${vocabLine}

具体ルール:
- 「${genre}」以外の未知用語 (クライアント / サーバー / プロセス / スレッド / 並行 / キャッシュ / プロビジョニング /
  スケーリング / メンテナンス 等で、ユーザー既知リストに無いもの) は
  question 本文 / options のどこにも絶対書かない
- options は日常語の役割説明で書く。
  良い例 (genre="ハッシュ" の場合): 「データを短い指紋に変える」/「画像を圧縮する」/「データを暗号で隠す」/「データを並べ替える」
  → どれが ${genre} の説明か明確に1つだけになるよう書く
- explanation だけは学習の場として関連用語 1-2 個まで使える (使うなら1行で意味を併記)
- どうしても他の専門用語が必要なら、それを使わず prerequisites に列挙して別問題で学ばせる

ルール:
- 暗記禁止。「役割は?」「なぜ使う?」「いつ使う?」型で。
- ★options は各「最大25文字以内」の短い句で。
- ★4択は一目で違いが分かる対比的な書き方
- question 本文は 80文字以内目安。短く、ハッキリ問う。「${genre}」を必ず含む。
- options は letter prefix なし
- answer は options 内の文字列と完全一致
- 解説 (explanation) は3-5文、役割 + 判断軸 + へぇートリビア ${triviaLine}
- 既出と被らない: ${excludeAnswers.slice(0, 15).join(", ")}

★prerequisites について (i+1 ゲートに直結):
- この問題を理解するのに必須の他ジャンル知識を 0-3 個列挙
- 「総称 (例: DB, ベクトル)」ではなく **マスターのジャンル名と完全一致** すること
- 例: depth=3 の「ベクトルDB (Pinecone等)」なら prerequisites=["RDB 基礎","エンベディング","セマンティック検索"] のように、リストにある名前を使う
- depth=1 (絶対基礎) は空配列でよい
${prereqLine}

JSON:
{"question":"…","options":["…","…","…","…"],"answer":"…","explanation":"…","claude_example":"「…」","prerequisites":["他ジャンル名1","他ジャンル名2"]}`;

  let j = null;
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    try {
      const { result } = await callGeminiWithFallback(prompt, {
        primaryModel: "gemini-2.5-flash-lite",
        maxOutputTokens: 4000,
      });
      const text = (result.response.text() || "").trim();
      if (!text) { console.warn(`[kotonoha] gen empty genre=${genre} d=${d} a=${attempt+1}`); continue; }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { console.warn(`[kotonoha] gen no-json genre=${genre} d=${d} a=${attempt+1}`); continue; }
      const parsed = JSON.parse(m[0]);
      if (!parsed.question || !parsed.answer || !parsed.explanation) {
        console.warn(`[kotonoha] gen incomplete genre=${genre} d=${d} a=${attempt+1}`);
        continue;
      }
      j = parsed;
    } catch (e) {
      console.warn(`[kotonoha] gen exception genre=${genre} d=${d} a=${attempt+1}: ${e.message}`);
    }
  }
  if (!j) return null;
  // prerequisites: 出題ゲートに使うので **master genre 名と完全一致** したものだけ残す。
  // - depth=1 は intro 扱いで空に強制 (誰にでも出る = foundational)
  // - 一致しないラベル (例: "DB" "ベクトル" 等の総称) は無視 (満たせないと永久ブロック)
  let prereqs = Array.isArray(j.prerequisites)
    ? j.prerequisites.filter((s) =>
        typeof s === "string" && s.length > 0 && s !== genre
        && KOTONOHA_GENRE_TO_GROUP.has(s)
      )
    : [];
  if (d === 1) prereqs = [];
  try {
    const { rows } = await p.query(
      `INSERT INTO kotonoha_questions
         (category, difficulty, type, question, options, answer, keywords, explanation, claude_example, source, genre, group_id, prerequisites)
       VALUES ($1, $2, 'choice', $3, $4, $5, '[]'::jsonb, $6, $7, 'generated', $8, $9, $10) RETURNING *`,
      [cat, d, j.question, JSON.stringify(j.options || []), j.answer, j.explanation, j.claude_example || "", genre, groupId, JSON.stringify(prereqs)]
    );
    console.log(`[kotonoha] gen OK genre=${genre} d=${d} answer="${j.answer}" prereq=${prereqs.join(",")}`);
    return rows[0];
  } catch (e) {
    console.warn("[kotonoha] insert failed:", e.message);
    return null;
  }
}

// フェーズ別に「優先して出題するグループ」を返す。
// Phase 1: 実用すぐ役立つ + Claude Code 指示で必要な語彙
//   - UI 部品名 (モーダル/トースト/FAB) → Claude Code に指示する語彙
//   - UI デザイン (タップ判定/余白/カード) → 同上
//   - CSS / レイアウト (position/flex/z-index) → 同上
//   - 開発フロー (Claude Code / Git / コードレビュー)
//   - エンジニア心得 (DRY/KISS/YAGNI = 設計方針)
//   - AI エージェント (Claude Code, プロンプト, MCP)
//   - IT 入門 (サーバー/OS/URL = 大前提)
// Phase 2: 基礎概念
//   - DB / API / AI 基礎 / アルゴリズム / 歴史
// Phase 3: 専門領域
//   - インフラ / セキュリティ / Web3 / 3D / 収益化 / wonders / BANAX OS
function pickPriorityGroups(correctCount) {
  const phases = KOTONOHA_GENRES_DATA?.phases || [];
  // 昇順想定。max_correct 未満で当てはまる最初の phase を採用。
  for (const ph of phases) {
    if (correctCount < (ph.max_correct ?? Infinity)) return ph.groups || null;
  }
  return null; // 全グループ解禁
}

// プール (現ユーザーが解ける問題) を計測。足りなければ sync gen で増やす。
async function ensureMinPool(p, email, target = 30) {
  const dbg = { freshBefore: 0, freshAfter: 0, genAttempted: 0, genSucceeded: 0 };
  try {
    // eligible count
    const { rows: pc } = await p.query(`
      WITH ranked AS (
        SELECT question_id, is_correct, ROW_NUMBER() OVER (ORDER BY answered_at) AS pos
          FROM kotonoha_progress WHERE user_email = $1
      ),
      up AS (
        SELECT question_id, MAX(pos) FILTER (WHERE is_correct) AS last_correct_pos
          FROM ranked GROUP BY question_id
      ),
      per_q AS (
        SELECT question_id, COUNT(*)::int AS attempts,
               COUNT(*) FILTER (WHERE is_correct)::int AS correct_count
          FROM kotonoha_progress WHERE user_email = $1 GROUP BY question_id
      ),
      mastered_q AS (
        SELECT question_id FROM per_q
         WHERE attempts >= 3 AND correct_count::float / attempts >= 0.85
      ),
      gc AS (
        SELECT q.genre, COUNT(DISTINCT q.id) AS n
          FROM kotonoha_questions q
          JOIN kotonoha_progress pr ON pr.question_id = q.id
         WHERE pr.user_email = $1 AND pr.is_correct AND q.genre IS NOT NULL
         GROUP BY q.genre
      ),
      ut AS (SELECT COUNT(*)::int AS total FROM ranked)
      SELECT COUNT(*)::int AS n FROM kotonoha_questions q
       LEFT JOIN up ON up.question_id = q.id
       LEFT JOIN gc ON gc.genre = q.genre
       WHERE (
         up.question_id IS NULL
         OR up.last_correct_pos IS NULL
         OR (
           ((SELECT total FROM ut) - up.last_correct_pos) >= 50 + (abs(hashtextextended(q.id::text || $1, 0)) % 50)::int
           AND q.id NOT IN (SELECT question_id FROM mastered_q)
         )
       )
       AND q.difficulty <= COALESCE(gc.n, 0) + 1
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(COALESCE(q.prerequisites, '[]'::jsonb)) AS prereq_g
          WHERE NOT EXISTS (SELECT 1 FROM gc WHERE gc.genre = prereq_g)
       )`,
      [email]
    );
    dbg.freshBefore = pc[0]?.n || 0;
    dbg.freshAfter = dbg.freshBefore;
    if (dbg.freshBefore >= target) return dbg;
    const need = Math.min(target - dbg.freshBefore, 8);
    // フェーズ判定
    const { rows: tcr } = await p.query(
      `SELECT COUNT(DISTINCT question_id)::int AS n FROM kotonoha_progress
        WHERE user_email = $1 AND is_correct`,
      [email]
    );
    const correctCount = tcr[0]?.n || 0;
    const priorityGroups = pickPriorityGroups(correctCount);

    // ★ジャンル選定ロジック (新)
    // 1. master (genres.json) からスコープ内の全ジャンルを取る
    // 2. 各ジャンルの「ユーザー正解数」と「他問題からの参照頻度」を引く
    // 3. 正解少ない順 → 参照頻度高い順 → random でソート
    // → DB に問題が無い「未着手ジャンル」も等しく candidates に入る
    const { rows: correctRows } = await p.query(`
      SELECT q.genre, COUNT(DISTINCT q.id) FILTER (WHERE pr.is_correct)::int AS correct
        FROM kotonoha_questions q
        LEFT JOIN kotonoha_progress pr ON pr.question_id = q.id AND pr.user_email = $1
       WHERE q.genre IS NOT NULL GROUP BY q.genre`,
      [email]
    );
    const { rows: freqRows } = await p.query(`
      WITH self AS (
        SELECT genre, COUNT(*)::int AS n FROM kotonoha_questions
         WHERE genre IS NOT NULL GROUP BY genre
      ),
      prereq AS (
        SELECT prereq AS genre, COUNT(*)::int AS n
          FROM kotonoha_questions q,
               jsonb_array_elements_text(COALESCE(q.prerequisites, '[]'::jsonb)) prereq
         GROUP BY prereq
      )
      SELECT COALESCE(s.genre, p.genre) AS genre,
             COALESCE(s.n, 0) + COALESCE(p.n, 0) AS total_freq
        FROM self s FULL OUTER JOIN prereq p ON s.genre = p.genre`);
    const correctByGenre = new Map(correctRows.map((r) => [r.genre, r.correct]));
    const freqByGenre = new Map(freqRows.map((r) => [r.genre, Number(r.total_freq)]));

    // ui_parts tier1 ゲート: 序盤は基本セットだけ gen 対象にする (出題側と整合)
    const { rows: uiCorrRows } = await p.query(
      `SELECT COUNT(DISTINCT q.id)::int AS n FROM kotonoha_questions q
         JOIN kotonoha_progress pr ON pr.question_id = q.id
        WHERE pr.user_email = $1 AND pr.is_correct AND q.group_id = 'ui_parts'`,
      [email]
    );
    const uiTier1Only = (uiCorrRows[0]?.n || 0) < UI_TIER1_THRESHOLD;

    // 全 master ジャンル (priorityGroups + tier1 でフィルタ) を candidates に
    const allCandidates = [];
    for (const g of (KOTONOHA_GENRES_DATA?.groups || [])) {
      if (priorityGroups && !priorityGroups.includes(g.id)) continue;
      for (const gen of g.genres) {
        if (uiTier1Only && g.id === "ui_parts" && !UI_TIER1_GENRES.has(gen.name)) continue;
        allCandidates.push({
          genre: gen.name,
          group_id: g.id,
          correct: correctByGenre.get(gen.name) || 0,
          freq: freqByGenre.get(gen.name) || 0,
        });
      }
    }
    // ソート: 正解少ない順 → 頻度高い順 → ランダム
    allCandidates.sort((a, b) => {
      if (a.correct !== b.correct) return a.correct - b.correct;
      if (a.freq !== b.freq) return b.freq - a.freq;
      return Math.random() - 0.5;
    });
    // 上位 need*3 から random で need 個ピックして偏りを減らす
    const pool = allCandidates.slice(0, Math.max(need * 4, 30));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    // 「正解 0 のジャンル (= 未着手)」を最低半分は確保
    const untouched = pool.filter((c) => c.correct === 0);
    const touched = pool.filter((c) => c.correct > 0);
    const untouchedQuota = Math.ceil(need * 0.6);
    let targets = [
      ...untouched.slice(0, untouchedQuota),
      ...touched.slice(0, need - Math.min(untouched.length, untouchedQuota)),
    ].slice(0, need).map((r) => ({ genre: r.genre, depth: Math.min(5, r.correct + 1) }));
    const { rows: ansRows } = await p.query(`SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 100`);
    const excludeAnswers = ansRows.map((r) => r.answer);
    const knownGenres = await getKnownGenres(p, email);
    dbg.genAttempted = targets.length;
    console.log(`[kotonoha] ensureMinPool: need=${need} knownGenres=${knownGenres.length} targets=`, targets.map((t) => `${t.genre}@d${t.depth}`).join(","));
    const results = await Promise.all(
      targets.map((t) => generateQuestion(p, { genre: t.genre, depth: t.depth, excludeAnswers, knownGenres })
        .catch((e) => { console.warn(`[kotonoha] gen err ${t.genre}:`, e.message); return null; }))
    );
    dbg.genSucceeded = results.filter(Boolean).length;
    dbg.freshAfter = dbg.freshBefore + dbg.genSucceeded;
  } catch (e) {
    console.warn("[kotonoha] ensureMinPool failed:", e.message);
  }
  return dbg;
}

// セッション開始: depth ゲート + 50-100問 gap + random で 20問選定。
// プール薄なら sync 生成して埋める。
// プールが薄ければバックグラウンドで AI 生成 (待たない)。
app.post("/api/kotonoha/sessions/start", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureKotonohaUser(p, req.user.email);
    const SESSION_SIZE = 20;
    const POOL_TARGET = 8; // 即スタート優先: 最小限だけ確保 (home の /me prewarm でほぼ満たされてる前提)。
                            // wipe-all 直後でも 1セッション組めるよう少し余裕を持つ。

    // プール不足なら sync 生成 (max 8問)
    const debug = await ensureMinPool(p, req.user.email, POOL_TARGET);

    // フェーズ判定 (序盤は IT 入門 + UI 部品 限定)
    const { rows: tcr2 } = await p.query(
      `SELECT COUNT(DISTINCT question_id)::int AS n FROM kotonoha_progress
        WHERE user_email = $1 AND is_correct`,
      [req.user.email]
    );
    const correctCount = tcr2[0]?.n || 0;
    const priorityGroups = pickPriorityGroups(correctCount);
    debug.phase = priorityGroups ? `${priorityGroups.length}グループ` : "全グループ";

    // 出題は new (未回答) + review (gap 経過) の 70:30 quota で取る
    // → 学習履歴がたまっても新規が常に多数派になり「復習で埋まる」事故を防ぐ
    const NEW_QUOTA = 14;
    const REVIEW_QUOTA = SESSION_SIZE - NEW_QUOTA; // 6
    const baseFilter = `
      WITH ranked AS (
        SELECT question_id, is_correct, ROW_NUMBER() OVER (ORDER BY answered_at) AS pos
          FROM kotonoha_progress WHERE user_email = $1
      ),
      up AS (
        SELECT question_id, MAX(pos) FILTER (WHERE is_correct) AS last_correct_pos
          FROM ranked GROUP BY question_id
      ),
      per_q AS (
        SELECT question_id,
               COUNT(*)::int AS attempts,
               COUNT(*) FILTER (WHERE is_correct)::int AS correct_count
          FROM kotonoha_progress
         WHERE user_email = $1
         GROUP BY question_id
      ),
      mastered_q AS (
        -- 「覚えた」= 3回以上挑戦 & 正解率 85%以上。復習プールから除外。
        SELECT question_id FROM per_q
         WHERE attempts >= 3 AND correct_count::float / attempts >= 0.85
      ),
      gc AS (
        SELECT q.genre, COUNT(DISTINCT q.id) AS n
          FROM kotonoha_questions q
          JOIN kotonoha_progress pr ON pr.question_id = q.id
         WHERE pr.user_email = $1 AND pr.is_correct AND q.genre IS NOT NULL
         GROUP BY q.genre
      ),
      ut AS (SELECT COUNT(*)::int AS total FROM ranked)`;
    // i+1: prerequisites に列挙された全ジャンルでユーザーが1個以上正解してないとブロック。
    // depth=1 の問題は prereq=[] なので常に通る (foundational)。
    // ui_parts は最初に基本セット (UI_TIER1_GENRES) だけ。マスター済になったら
    // tier2 (リサイズハンドル等の esoteric) も解禁。
    const { rows: uiCorrRows } = await p.query(
      `SELECT COUNT(DISTINCT q.id)::int AS n FROM kotonoha_questions q
         JOIN kotonoha_progress pr ON pr.question_id = q.id
        WHERE pr.user_email = $1 AND pr.is_correct AND q.group_id = 'ui_parts'`,
      [req.user.email]
    );
    const uiCorrect = uiCorrRows[0]?.n || 0;
    const uiTier1Only = uiCorrect < UI_TIER1_THRESHOLD;
    const tier1Arr = uiTier1Only ? [...UI_TIER1_GENRES] : null;
    const commonAnd = `
         AND q.difficulty <= COALESCE(gc.n, 0) + 1
         AND ($3::text[] IS NULL OR q.group_id = ANY($3::text[]))
         AND ($4::text[] IS NULL OR q.group_id <> 'ui_parts' OR q.genre = ANY($4::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(COALESCE(q.prerequisites, '[]'::jsonb)) AS prereq_g
            WHERE NOT EXISTS (SELECT 1 FROM gc WHERE gc.genre = prereq_g)
         )`;

    // 1) NEW: 未回答 (priority 0) または 一度も正解してない (priority 1)
    const runNewQuery = () => p.query(`
      ${baseFilter}
      SELECT q.*
        FROM kotonoha_questions q
        LEFT JOIN up ON up.question_id = q.id
        LEFT JOIN gc ON gc.genre = q.genre
       WHERE (up.question_id IS NULL OR up.last_correct_pos IS NULL)
         ${commonAnd}
       ORDER BY random()
       LIMIT $2`,
      [req.user.email, SESSION_SIZE, priorityGroups, tier1Arr]
    );
    let { rows: newRows } = await runNewQuery();

    // 2) REVIEW: 正解履歴あり & gap 経過 & まだ master 未達
    // 「覚えた」(= 3回以上 正解率85%) は復習対象から除外。よく使う語彙なら
    // 他問題の前提知識として自然に再登場するので、専用復習は不要。
    const { rows: reviewRows } = await p.query(`
      ${baseFilter}
      SELECT q.*
        FROM kotonoha_questions q
        JOIN up ON up.question_id = q.id
        LEFT JOIN gc ON gc.genre = q.genre
       WHERE up.last_correct_pos IS NOT NULL
         AND ((SELECT total FROM ut) - up.last_correct_pos) >= 50 + (abs(hashtextextended(q.id::text || $1, 0)) % 50)::int
         AND q.id NOT IN (SELECT question_id FROM mastered_q)
         ${commonAnd}
       ORDER BY random()
       LIMIT $2`,
      [req.user.email, SESSION_SIZE, priorityGroups, tier1Arr]
    );

    // ★ fallback: pool が壊滅的に薄ければ (NEW+REVIEW合計 0) もう一度ガッツリ gen して再 SELECT
    // wipe-all 直後や Gemini が初回失敗した時の救済路。同期で 10件まで再生成。
    if (newRows.length === 0 && reviewRows.length === 0) {
      console.warn(`[kotonoha] empty pool after initial select — retry ensureMinPool(10)`);
      const retry = await ensureMinPool(p, req.user.email, 10);
      debug.retry = retry;
      ({ rows: newRows } = await runNewQuery());
    }

    // 3) quota mix: NEW 多数派、REVIEW 補完
    let pickedNew = newRows.slice(0, NEW_QUOTA);
    let pickedReview = reviewRows.slice(0, REVIEW_QUOTA);
    // 片方が不足なら他方で補う
    if (pickedNew.length < NEW_QUOTA) {
      pickedReview = reviewRows.slice(0, REVIEW_QUOTA + (NEW_QUOTA - pickedNew.length));
    }
    if (pickedReview.length < REVIEW_QUOTA) {
      pickedNew = newRows.slice(0, NEW_QUOTA + (REVIEW_QUOTA - pickedReview.length));
    }
    let questions = [...pickedNew, ...pickedReview];
    // 出題順序はシャッフル (new と review が連続しないように)
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    questions = questions.slice(0, SESSION_SIZE);

    // UI demo: ハードコード集 (frontend UI_DEMOS) のみ。AI 生成 DB 行は壊れた
    // 描画が出るので一切 attach しない。hardcoded に無い ui_parts 問題は出題から外す。
    const demoGroups = new Set(["ui_parts"]);
    const uiGenres = [...new Set(questions.filter((q) => demoGroups.has(q.group_id) && q.genre).map((q) => q.genre))];
    let missingDemoGenres = [];
    if (uiGenres.length) {
      missingDemoGenres = uiGenres.filter((g) => !HARDCODED_UI_DEMO_GENRES.has(g));
      if (missingDemoGenres.length) {
        questions = questions.filter((q) => {
          if (!demoGroups.has(q.group_id) || !q.genre) return true;
          return HARDCODED_UI_DEMO_GENRES.has(q.genre);
        });
      }
    }

    const safe = questions.map((q) => {
      const transformed = buildUiPartsQuestion(q);
      return {
        id: transformed.id,
        category: transformed.category,
        genre: transformed.genre,
        group_id: transformed.group_id,
        difficulty: transformed.difficulty,
        type: transformed.type,
        question: transformed.question,
        options: transformed.options,
        image_url: transformed.image_url,
        demo_html: transformed.demo_html || null,
      };
    });
    res.json({ questions: safe, debug });

    // 【post-response background gen】レスポンス送信後、5問を並列で追加生成。
    // ユーザーがセッション中の間に DB に貯まる → 次回 start がさらに即座に。
    // Cloud Run CPU throttle で死ぬ可能性あるが、min-instances=0 でもセッション
    // 終了までの間 (= /answer リクエストが来る間) は CPU 動くのでだいたい走る。
    setImmediate(async () => {
      try {
        const { rows: ansRows } = await p.query(
          `SELECT answer FROM kotonoha_questions ORDER BY id DESC LIMIT 50`
        );
        const excludeAnswers = ansRows.map((r) => r.answer);
        const knownGenres = await getKnownGenres(p, req.user.email);
        // sessions/start で使ったジャンルと同じターゲット set を仮想生成
        const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys());
        const shuffled = all.slice();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const bgTargets = shuffled.slice(0, 5);
        await Promise.all(
          bgTargets.map((genre) => generateQuestion(p, { genre, depth: 1, excludeAnswers, knownGenres })
            .catch((e) => { console.warn(`[kotonoha] bg gen ${genre}:`, e.message); return null; }))
        );
        // UI デモは hardcoded のみ。AI 生成は廃止 (品質安定しないため)。
      } catch (e) {
        console.warn("[kotonoha] post-response bg gen skipped:", e.message);
      }
    });
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
      // UI 部品問題は「この機能の名前は?」+ ジャンル名4択に統一されてるので、
      // 比較対象は q.genre (DB の q.answer ではなく)
      if (q.group_id && UI_TEMPLATE_GROUPS.has(q.group_id) && q.genre) {
        isCorrect = ua === q.genre;
      } else {
        isCorrect = ua === q.answer;
      }
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
      answer: (q.group_id && UI_TEMPLATE_GROUPS.has(q.group_id) && q.genre) ? q.genre : q.answer,
      genre: q.genre,
      group_id: q.group_id,
      explanation: q.explanation,
      claude_example: q.claude_example,
      ai_reason: aiReason,
    });
    // per-answer fire-and-forget gen は廃止 (Cloud Run の CPU throttle で殺されるため)。
    // 生成は sessions/start で sync 実行する ensureMinPool に集約。
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
    if (rate >= 0.7) newLevel = oldLevel + 1;  // 上限なし、永久成長
    else if (rate < 0.4 && oldLevel > 1) newLevel = oldLevel - 1;
    if (newLevel !== oldLevel) {
      await p.query(`UPDATE kotonoha_users SET level=$1, last_session_at=now(), updated_at=now() WHERE user_email=$2`, [newLevel, req.user.email]);
    } else {
      await p.query(`UPDATE kotonoha_users SET last_session_at=now() WHERE user_email=$1`, [req.user.email]);
    }
    // コンテキスト一言: streak / 通算 / フェーズ境界 のうち一番ホットなものを選ぶ
    const streak = await computeKotonohaStreak(p, req.user.email).catch(() => null);
    const { rows: tcr } = await p.query(
      `SELECT COUNT(DISTINCT question_id)::int AS n FROM kotonoha_progress
        WHERE user_email = $1 AND is_correct`,
      [req.user.email]
    );
    const totalUniqCorrect = tcr[0]?.n || 0;
    const message = buildEndMessage({ oldLevel, newLevel, streak, totalUniqCorrect });
    res.json({
      ok: true,
      oldLevel,
      newLevel,
      levelChanged: newLevel !== oldLevel,
      rate,
      streak,
      totalUniqCorrect,
      message,
    });

    // 【post-response background gen】次セッション用にプール補充
    // res.json 後なので throttle で死ぬ可能性あるが、ユーザーが summary を眺めてる
    // 数秒の間に最低限走る (Cloud Run min-instances=0 でも CPU active)。
    setImmediate(async () => {
      try {
        await ensureMinPool(p, req.user.email, 8);
      } catch (e) {
        console.warn("[kotonoha] end bg gen skipped:", e.message);
      }
    });
  } catch (err) {
    console.error("kotonoha end", err);
    res.status(500).json({ error: err.message });
  }
});

// セッション完了画面に出す「派手目の一言」を組み立てる。
// 優先度: レベルアップ大台 > 連続記録達成 > 連続記録あとちょっと > 通算ミルストーン > 既定。
// フロントは celebrateMsg を innerHTML で描画するので、ここで
// `<span class="icon">name</span>` を直接埋めて Material Symbols 表示。
const ICON_STAR  = `<span class="icon" style="color:#fbbf24;vertical-align:-0.18em;">stars</span>`;
const ICON_FIRE  = `<span class="icon" style="color:#f59e0b;vertical-align:-0.18em;">local_fire_department</span>`;
const ICON_SCHOOL= `<span class="icon" style="color:#6d28d9;vertical-align:-0.18em;">school</span>`;
const ICON_TGT   = `<span class="icon" style="color:#6d28d9;vertical-align:-0.18em;">my_location</span>`;
function buildEndMessage({ oldLevel, newLevel, streak, totalUniqCorrect }) {
  const leveledUp = newLevel > oldLevel;
  const milestoneLv = [5, 10, 15, 20, 30, 50, 75, 100];
  const streakMilestones = [3, 7, 14, 30, 60, 100, 200, 365];
  const totalMilestones = [10, 25, 50, 100, 200, 500, 1000];

  if (leveledUp && milestoneLv.includes(newLevel)) {
    return `${ICON_STAR} レベル ${newLevel} 到達!大台です`;
  }
  if (streak?.today_active && streakMilestones.includes(streak.streak)) {
    return `${ICON_FIRE} 連続 ${streak.streak} 日達成!`;
  }
  if (leveledUp) {
    return `${ICON_SCHOOL} レベル ${oldLevel} → ${newLevel} に上がった`;
  }
  if (streak && !streak.today_active && streak.streak > 0) {
    const need = Math.max(1, (streak.daily_min || 5) - (streak.today_correct || 0));
    return `今日あと ${need} 問正解で 連続 ${streak.streak + 1} 日`;
  }
  if (streak?.today_active) {
    const next = streakMilestones.find((m) => m > streak.streak);
    if (next && next - streak.streak <= 5) {
      return `あと ${next - streak.streak} 日で 連続 ${next} 日達成`;
    }
    if (streak.streak >= 1) {
      return `${ICON_FIRE} 連続 ${streak.streak} 日継続中`;
    }
  }
  if (totalMilestones.includes(totalUniqCorrect)) {
    return `${ICON_TGT} 通算 ${totalUniqCorrect} 語マスター`;
  }
  // 通算ミルストーンまであと少し
  const nextTotal = totalMilestones.find((m) => m > totalUniqCorrect);
  if (nextTotal && nextTotal - totalUniqCorrect <= 5) {
    return `あと ${nextTotal - totalUniqCorrect} 問で通算 ${nextTotal} 語`;
  }
  // 既定
  if (newLevel < oldLevel) return `基礎を一巡しよう`;
  return `お疲れさま！`;
}

// 自分のステータス: ジャンル別進捗 + 最近覚えた言葉

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

// seed 全削除 (= source='seed' を消す)。AI 生成プールが育ったら呼ぶ用
app.post("/api/kotonoha/wipe-seed", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const before = await p.query(`SELECT count(*)::int AS n FROM kotonoha_questions WHERE source = 'seed'`);
    await p.query(`DELETE FROM kotonoha_questions WHERE source = 'seed'`);
    const after = await p.query(`SELECT count(*)::int AS n FROM kotonoha_questions`);
    res.json({ ok: true, deleted: before.rows[0]?.n || 0, remaining: after.rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 全問題プール削除 (= kotonoha_questions 全消し)。手動リセット用。
// 進捗 (kotonoha_progress) は FK ON DELETE CASCADE で連動して消えるので owner 限定。
app.post("/api/kotonoha/wipe-all", async (req, res) => {
  const email = String(req.user?.email || "").toLowerCase();
  if (!KOTONOHA_OWNER_EMAILS.has(email)) return res.status(403).json({ error: "owner only" });
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const before = await p.query(`SELECT count(*)::int AS n FROM kotonoha_questions`);
    const beforeUi = await p.query(`SELECT count(*)::int AS n FROM kotonoha_ui_demos`);
    await p.query(`DELETE FROM kotonoha_questions`);
    // 旧 AI 生成 UI デモ (kotonoha_ui_demos) も掃除。今はもう参照しないが、残骸を消して
    // テーブルを空にしておく。
    await p.query(`DELETE FROM kotonoha_ui_demos`);
    console.log(`[kotonoha] wipe-all by ${req.user.email}: deleted ${before.rows[0]?.n} questions, ${beforeUi.rows[0]?.n} ui_demos`);
    res.json({ ok: true, deleted: before.rows[0]?.n || 0, deletedUiDemos: beforeUi.rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ui_parts デモは全てフロント側 (UI_DEMOS) にハードコード。
// このリストは frontend の UI_DEMOS のキー (alias 含む) と完全一致させること。
// AI 生成パスは廃止 (品質が安定しないため)。
const HARDCODED_UI_DEMO_GENRES = new Set([
  // 既存 11
  "モーダル","トースト","FAB","アコーディオン","ドロワー","タブ","ツールチップ",
  "プログレスバー","スケルトン","ハンバーガーメニュー","スイッチ",
  // 新規 (master genre 名と完全一致)
  "ダイアログ","スナックバー","セグメンテッドコントロール","ポップオーバー","バナー / アラート",
  "カード","リスト / テーブル","ボトムシート","コンテキストメニュー","オートコンプリート",
  "セレクト / ドロップダウン","スイッチ / トグル","スライダー","チップ / タグ","アバター",
  "バッジ","ブレッドクラム","ページネーション","ボトムナビゲーション","ボタン (Primary)",
  "セカンダリボタン","アイコンボタン","デンジャーボタン (削除色)","ゴーストボタン",
  "テキスト入力 (input)","テキストエリア (textarea)","パスワード入力","数値入力","検索バー",
  "日付ピッカー","時刻ピッカー","カラーピッカー","ファイル入力","画像アップロード",
  "カウンター入力 (- / +)","レンジスライダー (2点)","レーティング (★★★)","区切り線 (Divider)",
  "ステッパー","ステップ進捗 (ウィザード)","スピナー / ローダー","通知バッジ (赤丸)",
  "ヘッダー / トップバー","戻るボタン","カートアイコン","ブックマーク / お気に入り",
  "「いいね」ボタン","シェアボタン","コピーボタン","ユーザーメニュー (アバター展開)",
  "通知ベル (鐘)","ラベル","必須マーク (*)","アイコン","プレースホルダ","ヘルプテキスト",
  "クリアボタン (× 内蔵)","コードブロック","引用 (blockquote)","送信ボタン","ローディングボタン",
  "リンクボタン (テキストボタン)","ボタングループ","ラジオボタン","チェックボックス",
  "フォーム (送信)","フッター","メニュー (一般)","ロゴ (クリックでホーム)",
  "スクロールトップボタン","アンカーリンク (#)","カルーセル","画像ギャラリー",
  "ライトボックス (画像拡大)","動画プレイヤー","棒グラフ","円グラフ","折れ線グラフ",
  "ヒーローセクション",
  // alias 先 (frontend で同じ HTML にマップ済み)
  "ダイアログ (確認)","アラートダイアログ","ポップオーバー (位置寄せ)","スイッチ (ON/OFF)",
  "ドロップダウン (select)","ピッカー (日付 / 時刻)","プログレスインジケーター (確定/不定)",
  "ラジオボタン / チェックボックス",
]);

async function uiDemoStatus(p) {
  const uiPartsGroup = (KOTONOHA_GENRES_DATA?.groups || []).find((g) => g.id === "ui_parts");
  if (!uiPartsGroup) return null;
  const allGenres = uiPartsGroup.genres.map((g) => g.name);
  const inHardcoded = allGenres.filter((g) => HARDCODED_UI_DEMO_GENRES.has(g));
  const pending = allGenres.filter((g) => !HARDCODED_UI_DEMO_GENRES.has(g));
  return {
    total: allGenres.length,
    hardcoded: inHardcoded.length,
    inDb: 0, // 廃止
    pending: pending.length,
    pendingGenres: pending,
  };
}

// 旧 AI 生成エンドポイントは廃止。後方互換のため 410 を返す。
app.post("/api/kotonoha/gen-ui-demos", async (_req, res) => {
  res.status(410).json({ ok: false, error: "AI gen は廃止。デモは UI_DEMOS にハードコード追加してください。" });
});
app.post("/api/internal/kotonoha/gen-ui-demos", async (_req, res) => {
  // Cloud Tasks に残ってる再キューを止める no-op
  res.json({ ok: true, done: true, msg: "deprecated" });
});
app.post("/api/kotonoha/ui-demos/regenerate", async (_req, res) => {
  res.status(410).json({ ok: false, error: "再生成は廃止。UI_DEMOS を編集してください。" });
});

// 進捗確認 (owner): ハードコード網羅率を返す
app.get("/api/kotonoha/ui-demo-status", async (req, res) => {
  const email = String(req.user?.email || "").toLowerCase();
  if (!KOTONOHA_OWNER_EMAILS.has(email)) return res.status(403).json({ error: "owner only" });
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const status = await uiDemoStatus(p);
  res.json({ ...(status || {}), pendingGenres: status?.pendingGenres });
});

// ギャラリー: ハードコード分は frontend が知ってるので空配列を返す (互換)
app.get("/api/kotonoha/ui-demos-list", async (req, res) => {
  const email = String(req.user?.email || "").toLowerCase();
  if (!KOTONOHA_OWNER_EMAILS.has(email)) return res.status(403).json({ error: "owner only" });
  res.json([]);
});

// テスト生成: Gemini 直接呼び出し + 完全な問題生成、両方の結果を返す
app.post("/api/kotonoha/test-gen", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const out = { hasKey: !!GEMINI_API_KEY, hasGenAI: !!genAI };
  if (!genAI) return res.json({ ...out, ok: false, error: "genAI not initialized (GEMINI_API_KEY missing or invalid)" });

  // ① Gemini 直接呼び出し (最小プロンプト)
  const start1 = Date.now();
  try {
    const m = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", generationConfig: { maxOutputTokens: 4000 } });
    const r = await m.generateContent("Reply with exactly: ok");
    out.gemini = {
      ok: true,
      elapsed: Date.now() - start1,
      model: "gemini-2.5-flash-lite",
      text: (r.response.text() || "").slice(0, 200),
    };
  } catch (e) {
    out.gemini = {
      ok: false,
      elapsed: Date.now() - start1,
      error: e.message,
      code: e.status || e.code,
      stack: (e.stack || "").split("\n").slice(0, 3).join(" | "),
    };
    return res.json({ ...out, ok: false });
  }

  // ② 実際の問題生成
  const start2 = Date.now();
  try {
    const all = Array.from(KOTONOHA_GENRE_TO_GROUP.keys());
    const genre = all[Math.floor(Math.random() * all.length)];
    // ジャンル内正解数を見て depth 決定
    const { rows: gc } = await p.query(
      `SELECT COUNT(DISTINCT q.id) FILTER (WHERE pr.is_correct)::int AS n
         FROM kotonoha_questions q LEFT JOIN kotonoha_progress pr
         ON pr.question_id = q.id AND pr.user_email = $1
        WHERE q.genre = $2`,
      [req.user.email, genre]
    );
    const depth = Math.min(5, (gc[0]?.n || 0) + 1);
    const result = await generateQuestion(p, { genre, depth, excludeAnswers: [] });
    out.fullGen = {
      ok: !!result,
      elapsed: Date.now() - start2,
      genre,
      depth,
      answer: result?.answer,
    };
    return res.json({ ...out, ok: !!result });
  } catch (e) {
    out.fullGen = { ok: false, elapsed: Date.now() - start2, error: e.message };
    return res.json({ ...out, ok: false });
  }
});

async function buildKotonohaProgress(p, email) {
  // 進捗 = unique 正解数 / target_count (シンプル化)
  const { rows: byGenre } = await p.query(
    `SELECT q.genre, q.group_id,
            count(DISTINCT q.id) FILTER (WHERE pr.is_correct)::int AS correct_uniq
       FROM kotonoha_questions q
       LEFT JOIN kotonoha_progress pr ON pr.question_id = q.id AND pr.user_email = $1
      WHERE q.genre IS NOT NULL
      GROUP BY q.genre, q.group_id`,
    [email]
  );
  const dbProg = new Map(byGenre.map((r) => [r.genre, r.correct_uniq]));
  const groups = [];
  for (const g of (KOTONOHA_GENRES_DATA?.groups || [])) {
    const genres = g.genres.map((gen) => {
      const target = gen.target_count || 10;
      const correct = Math.min(dbProg.get(gen.name) || 0, target);
      return { name: gen.name, target, correct, pct: Math.round((correct / target) * 100) };
    });
    const totalT = genres.reduce((s, x) => s + x.target, 0);
    const totalScore = genres.reduce((s, x) => s + x.correct, 0);
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
    // 【ホーム prewarm】最初の数問を背景で生成しておく (~5秒)
    // ユーザーがホームを見てる間に終わるので、20問チャレンジ時に待ちが消える
    const prewarmPromise = ensureMinPool(p, req.user.email, 3)
      .catch((e) => { console.warn("[kotonoha] prewarm failed:", e.message); return null; });
    const [groups, streak] = await Promise.all([
      buildKotonohaProgress(p, req.user.email),
      computeKotonohaStreak(p, req.user.email),
    ]);
    // prewarm を max 4秒 だけ待つ (ホーム読込が長すぎないように)
    await Promise.race([prewarmPromise, new Promise((r) => setTimeout(r, 4000))]);
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
    // 覚えた言葉: ラベル単位で「3回以上挑戦 & 正解率 85%以上」が成立したものだけ。
    // よく出るラベルほど自然に attempts が増えて mastered になる仕組み。
    const { rows: learned } = await p.query(
      `WITH per_label AS (
         SELECT COALESCE(NULLIF(q.genre, ''), q.answer) AS label,
                COUNT(*)::int AS attempts,
                COUNT(*) FILTER (WHERE pr.is_correct)::int AS correct_count,
                MAX(pr.answered_at) AS last_seen
           FROM kotonoha_progress pr
           JOIN kotonoha_questions q ON q.id = pr.question_id
          WHERE pr.user_email = $1
            AND char_length(COALESCE(NULLIF(q.genre, ''), q.answer)) BETWEEN 2 AND 24
          GROUP BY COALESCE(NULLIF(q.genre, ''), q.answer)
       )
       SELECT pl.label, pl.last_seen AS answered_at, q2.group_id, q2.explanation
         FROM per_label pl
         CROSS JOIN LATERAL (
           SELECT q.group_id, q.explanation
             FROM kotonoha_questions q
            WHERE COALESCE(NULLIF(q.genre, ''), q.answer) = pl.label
            ORDER BY q.id DESC
            LIMIT 1
         ) q2
        WHERE pl.attempts >= 2 AND pl.correct_count::float / pl.attempts >= 0.85
        ORDER BY pl.last_seen DESC
        LIMIT 200`,
      [req.user.email]
    );
    res.json({
      user,
      streak,
      groups,
      pool,
      recentWords: learned.slice(0, 12),
      learned, // フルリスト (最大200件、explanation 付き)
      // 他のミニアプリ (keihi 等) にもアクセスできるユーザーかどうか。
      // false の場合、フロントは「← 戻る」(ランチャー行き) を隠す。
      hasLauncherAccess: allowList.length === 0
        || allowList.includes(String(req.user.email || "").toLowerCase()),
      // owner (社長) かどうか。wipe-all / UIデモ一括生成 等の管理操作を出すかの判定。
      isOwner: KOTONOHA_OWNER_EMAILS.has(String(req.user.email || "").toLowerCase()),
    });
  } catch (err) {
    console.error("kotonoha me", err);
    res.status(500).json({ error: err.message });
  }
});

// オーナー専用: 指定 user の覚えた語リスト (label-level mastery)。
// peer card クリック時に呼ばれる。
app.get("/api/kotonoha/peer-learned", async (req, res) => {
  const email = String(req.user?.email || "").toLowerCase();
  if (!KOTONOHA_OWNER_EMAILS.has(email)) return res.status(403).json({ error: "owner only" });
  const target = String(req.query?.email || "").toLowerCase();
  if (!target) return res.status(400).json({ error: "email required" });
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: learned } = await p.query(
      `WITH per_label AS (
         SELECT COALESCE(NULLIF(q.genre, ''), q.answer) AS label,
                COUNT(*)::int AS attempts,
                COUNT(*) FILTER (WHERE pr.is_correct)::int AS correct_count,
                MAX(pr.answered_at) AS last_seen
           FROM kotonoha_progress pr
           JOIN kotonoha_questions q ON q.id = pr.question_id
          WHERE pr.user_email = $1
            AND char_length(COALESCE(NULLIF(q.genre, ''), q.answer)) BETWEEN 2 AND 24
          GROUP BY COALESCE(NULLIF(q.genre, ''), q.answer)
       )
       SELECT pl.label, pl.last_seen AS answered_at, q2.group_id, q2.explanation
         FROM per_label pl
         CROSS JOIN LATERAL (
           SELECT q.group_id, q.explanation
             FROM kotonoha_questions q
            WHERE COALESCE(NULLIF(q.genre, ''), q.answer) = pl.label
            ORDER BY q.id DESC
            LIMIT 1
         ) q2
        WHERE pl.attempts >= 2 AND pl.correct_count::float / pl.attempts >= 0.85
        ORDER BY pl.last_seen DESC
        LIMIT 200`,
      [target]
    );
    res.json({ email: target, learned });
  } catch (err) {
    console.error("kotonoha peer-learned", err);
    res.status(500).json({ error: err.message });
  }
});

// 他メンバーのステータス: オーナー (社長) のみ閲覧可。
// 従業員同士は不可 — owner 以外は空配列固定 (visible_to_peers 設定は無視)。
app.get("/api/kotonoha/peers", async (req, res) => {
  const email = String(req.user?.email || "").toLowerCase();
  if (!KOTONOHA_OWNER_EMAILS.has(email)) return res.json([]);
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    // オーナーには visible_to_peers 関係なく全メンバー見せる (人事把握目的)
    const { rows: users } = await p.query(
      `SELECT user_email, display_name, level, total_correct, total_answers, last_session_at
         FROM kotonoha_users
        WHERE user_email <> $1
        ORDER BY last_session_at DESC NULLS LAST`,
      [email]
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
        user_email: u.user_email,
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

// (ランチャーのタイル並び/非表示は Firestore (launcher_prefs/{uid}) に保存。
//  別 DB に持つと整合変なので Firebase 側で完結させる。)


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
              image_url AS "imageUrl", drive_url AS "driveUrl", created_at AS "createdAt"
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
      `INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url, drive_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, created_at`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.imageUrl || null, r.driveUrl || null]
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
         payment=$6, buyer=$7, site=$8, memo=$9,
         drive_url=COALESCE($10, drive_url)
       WHERE id=$11`,
      [r.date, r.store, r.total, r.category, r.workType, r.payment, r.buyer, r.site, r.memo || "", r.driveUrl || null, req.params.id]
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
