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
import * as fxOanda from "./fx-lib/oanda.js";
import { buildChartSummary as fxBuildChart } from "./fx-lib/chart.js";
import { decideFromChart as fxDecide } from "./fx-lib/ai.js";
import { parseCandlesCsv as fxParseCsv } from "./fx-lib/csv.js";
import { runStrategy as fxRunStrategy, strategyList as fxStrategyList } from "./fx-lib/strategies.js";
import { recomputeEpisodeState, computeMissingInfo, cutIsReadyForGeneration } from "./drama-lib/state.js";
import { buildSystemPrompt as dramaBuildSystemPrompt, chatOnce as dramaChatOnce, analyzeChapter as dramaAnalyzeChapter } from "./drama-lib/gemini.js";
import {
  createCutVideoTask as dramaCreateVideoTask, getVideoTask as dramaGetVideoTask,
  generateCutVideoMock as dramaGenerateMock, seedanceConfigured as dramaSeedanceConfigured,
  SEEDANCE_MODEL as DRAMA_SEEDANCE_MODEL,
} from "./drama-lib/videoGen.js";
import { fetchAozoraText as dramaFetchAozora, splitChapters as dramaSplitChapters, searchAozoraCatalog as dramaSearchCatalog } from "./drama-lib/aozora.js";
import { analyzeWorkSetup as dramaAnalyzeWorkSetup, searchAozora as dramaSearchAozora } from "./drama-lib/gemini.js";
import { composeSeries as dramaComposeSeries, writeScript as dramaWriteScript, composeCuts as dramaComposeCuts } from "./drama-lib/gemini.js";
import { reviewGeneratedImage as dramaReviewImage } from "./drama-lib/gemini.js";
import { searchWebImages as dramaSearchWebImages } from "./drama-lib/websearch.js";
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// バージョン情報 (CORS の後、認証 middleware の前 = 公開エンドポイント)
app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION, buildId: BUILD_ID, startedAt: SERVER_STARTED_AT });
});

// チャット挙動のデバッグ実行 (Claude Code 用)。Gemini を本当に呼ぶが:
//  - 履歴に書き込まない / ACTIONS は解析のみで実行しない (本物のデータを汚さない)
//  - 課金は kind debug_* で記録し、累計 ¥1000 でハードストップ (公開エンドポイントの保険)
//  - body: { message, episodeId?, quotedMessageId?, imageUrls?, withImages? }
const DRAMA_DEBUG_BUDGET_YEN = 1000;
app.post("/api/drama/inspect/:id/debug-chat", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    await ensureSchema();
    const { rows: spent } = await p.query(
      `SELECT COALESCE(SUM(cost_yen),0)::float AS y FROM drama_api_usage WHERE kind LIKE 'debug%'`
    );
    if (spent[0].y >= DRAMA_DEBUG_BUDGET_YEN) {
      return res.status(403).json({ error: `デバッグ予算 (¥${DRAMA_DEBUG_BUDGET_YEN}) を使い切りました`, spentYen: spent[0].y });
    }
    const b = req.body || {};
    const result = await dramaProcessChat(p, {
      projectId: req.params.id,
      episodeId: b.episodeId || null,
      message: String(b.message || ""),
      imageUrls: Array.isArray(b.imageUrls) ? b.imageUrls.slice(0, 2) : [],
      quotedMessageId: b.quotedMessageId || null,
      userMessageId: 9007199254740991,
      assistantMessageId: null,
      debug: { withImages: !!b.withImages },
    });
    const { rows: spentAfter } = await p.query(
      `SELECT COALESCE(SUM(cost_yen),0)::float AS y FROM drama_api_usage WHERE kind LIKE 'debug%'`
    );
    res.json({ ...result, debugBudget: { spentYen: spentAfter[0].y, capYen: DRAMA_DEBUG_BUDGET_YEN } });
  } catch (err) {
    console.error("[drama] debug-chat", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// デバッグ用のプロジェクト作成 (Claude Code 用・debug 予算内)。
// body: { query } (カタログ検索の 1 件目) または { url }。
// 作成 → AI 構造化 → 章解析まで一気通貫で実行し、アプリの一覧にも普通に出る。
app.post("/api/drama/inspect/create-from-aozora", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const { rows: spent } = await p.query(
      `SELECT COALESCE(SUM(cost_yen),0)::float AS y FROM drama_api_usage WHERE kind LIKE 'debug%'`
    );
    if (spent[0].y >= DRAMA_DEBUG_BUDGET_YEN) {
      return res.status(403).json({ error: `デバッグ予算 (¥${DRAMA_DEBUG_BUDGET_YEN}) を使い切りました`, spentYen: spent[0].y });
    }
    const b = req.body || {};
    let url = b.url;
    if (!url && b.query) {
      const hits = await dramaSearchCatalog(String(b.query).slice(0, 100), 1);
      url = hits[0]?.cardUrl;
    }
    if (!url) return res.status(400).json({ error: "query か url が必要です" });

    const result = await dramaImportFromAozora(p, {
      url, createdBy: "claude-debug", skipSetup: false, kindPrefix: "debug_",
    });

    // 章解析 (要約 + 出演 index) も全章実行
    const { rows: charRows } = await p.query(`SELECT name FROM drama_characters WHERE project_id=$1`, [result.id]);
    const knownCharacterNames = charRows.map((r) => r.name);
    const { rows: chapterRows } = await p.query(
      `SELECT id, number, title, content FROM drama_chapters WHERE project_id=$1 ORDER BY number`, [result.id]
    );
    const chapterResults = [];
    for (const ch of chapterRows) {
      try {
        const a = await dramaAnalyzeChapter(dramaTrackedGemini(result.id, "debug_chapter_analyze"), {
          projectTitle: result.title, author: result.author, chapter: ch, knownCharacterNames,
        });
        await p.query(
          `UPDATE drama_chapters SET summary=$1, character_names=$2, updated_at=now() WHERE id=$3`,
          [a.summary, JSON.stringify(a.characterNames), ch.id]
        );
        chapterResults.push({ number: ch.number, title: ch.title, summary: a.summary, characterNames: a.characterNames });
      } catch (e) {
        chapterResults.push({ number: ch.number, error: e.message });
      }
    }
    const { rows: spentAfter } = await p.query(
      `SELECT COALESCE(SUM(cost_yen),0)::float AS y FROM drama_api_usage WHERE kind LIKE 'debug%'`
    );
    res.status(201).json({ ...result, chapterAnalysis: chapterResults, debugBudget: { spentYen: spentAfter[0].y, capYen: DRAMA_DEBUG_BUDGET_YEN } });
  } catch (err) {
    console.error("[drama] debug create", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// チャット配線の dry-run (公開・read-only・Gemini 課金なし)。
// 「モデルに実際に何が渡るか」(画像枚数・基準画像・引用・メモ等) を返す。
// Claude Code が本番の配線をプッシュ後に検証する用。DB への書き込みは一切しない。
app.get("/api/drama/inspect/:id/chat-wiring", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const wiring = await dramaProcessChat(p, {
      projectId: req.params.id,
      episodeId: req.query.episodeId || null,
      message: String(req.query.message || "(配線確認)"),
      imageUrls: [],
      quotedMessageId: req.query.quotedMessageId || null,
      userMessageId: 9007199254740991, // 全履歴を対象に (実メッセージは挿入しない)
      assistantMessageId: null,
      dryRun: true,
    });
    res.json(wiring);
  } catch (err) {
    console.error("[drama] chat-wiring", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// auto-drama のデータ点検用 (Claude Code が curl で構造・粒度を確認する用の read-only JSON)。
// 認証なしで公開する代わりに: 原文 (著作権切れ) と制作メタデータのみ。
// チャットは件数だけ、参照画像は枚数だけ (URL は出さない)。
// ?chapter=<番号> でその章の本文も返す。
app.get("/api/drama/inspect/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const { rows: projRows } = await p.query(
      `SELECT id, title, author, world_setting AS "worldSetting", style_guide AS "styleGuide",
              ai_notes AS "aiNotes", jsonb_array_length(style_ref_images) AS "styleRefImageCount",
              length(COALESCE(source_text,'')) AS "sourceTextChars", created_at AS "createdAt"
         FROM drama_projects WHERE id=$1`,
      [req.params.id]
    );
    if (!projRows.length) return res.status(404).json({ error: "not found" });
    const { rows: characters } = await p.query(
      `SELECT id, name, reading, description, appearance_prompt AS "appearancePrompt",
              identity_tokens AS "identityTokens", jsonb_array_length(reference_images) AS "referenceImageCount", status
         FROM drama_characters WHERE project_id=$1 ORDER BY id`,
      [req.params.id]
    );
    const { rows: locations } = await p.query(
      `SELECT id, name, description, appearance_prompt AS "appearancePrompt",
              identity_tokens AS "identityTokens", jsonb_array_length(reference_images) AS "referenceImageCount", status
         FROM drama_locations WHERE project_id=$1 ORDER BY id`,
      [req.params.id]
    );
    const { rows: chapters } = await p.query(
      `SELECT number, title, length(content) AS "charCount", summary, character_names AS "characterNames"
         FROM drama_chapters WHERE project_id=$1 ORDER BY number`,
      [req.params.id]
    );
    let chapterContent = null;
    if (req.query.chapter) {
      const { rows: c } = await p.query(
        `SELECT number, title, content FROM drama_chapters WHERE project_id=$1 AND number=$2`,
        [req.params.id, Number(req.query.chapter)]
      );
      chapterContent = c[0] || null;
    }
    const { rows: episodes } = await p.query(
      `SELECT e.id, e.number, e.title, e.state, e.target_duration_sec AS "targetDurationSec",
              e.appearing_character_ids AS "appearingCharacterIds",
              (e.key_visual->>'url') IS NOT NULL AS "hasKeyVisual"
         FROM drama_episodes e WHERE e.project_id=$1 ORDER BY e.number`,
      [req.params.id]
    );
    for (const ep of episodes) {
      const { rows: cuts } = await p.query(
        `SELECT "order", duration_sec AS "durationSec", length(COALESCE(prompt,'')) AS "promptChars",
                character_ids AS "characterIds", jsonb_array_length(generations) AS "generationCount",
                selected_generation_index AS "selectedGenerationIndex",
                length(COALESCE(narration,'')) AS "narrationChars", subtitle
           FROM drama_cuts WHERE episode_id=$1 ORDER BY "order"`,
        [ep.id]
      );
      ep.cuts = cuts;
    }
    const { rows: inspectAssets } = await p.query(
      `SELECT id, name, note FROM drama_assets WHERE project_id=$1 ORDER BY id`, [req.params.id]
    );
    const { rows: chatCount } = await p.query(
      `SELECT COUNT(*)::int AS n FROM drama_chat_messages WHERE project_id=$1`, [req.params.id]
    );
    // ?chat=1 でチャット本文も返す (小西の明示要望。直近 100 件)
    let chat = null;
    if (req.query.chat) {
      const { rows: chatRows } = await p.query(
        `SELECT id, episode_id AS "episodeId", role, content, images, created_at AS "createdAt"
           FROM drama_chat_messages WHERE project_id=$1 ORDER BY id DESC LIMIT 100`,
        [req.params.id]
      );
      chat = chatRows.reverse();
    }
    const { rows: usage } = await p.query(
      `SELECT provider, COALESCE(SUM(cost_yen),0)::float AS "costYen", COUNT(*)::int AS calls
         FROM drama_api_usage WHERE project_id=$1 GROUP BY provider`,
      [req.params.id]
    );
    const chapterChars = chapters.map((c) => Number(c.charCount));
    res.json({
      project: projRows[0],
      stats: {
        chapterCount: chapters.length,
        chapterChars: chapterChars.length ? {
          avg: Math.round(chapterChars.reduce((a, b) => a + b, 0) / chapterChars.length),
          min: Math.min(...chapterChars),
          max: Math.max(...chapterChars),
        } : null,
        chatMessages: chatCount[0].n,
      },
      usage,
      characters,
      locations,
      assets: inspectAssets,
      chapters,
      chapterContent,
      episodes,
      chat,
    });
  } catch (err) {
    console.error("[drama] inspect", err);
    res.status(500).json({ error: err.message });
  }
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

// 任意のネストフォルダ (例: ["領収書", "2026-06"]) の Drive folder ID を取得 or 作成。
// 探索 → 無ければ作成 を階層分繰り返す。結果は instance ライフタイム中キャッシュ。
const driveFolderCache = new Map();   // join(/) → folderId
async function getOrCreateDriveSubfolder(pathParts) {
  if (!DRIVE_FOLDER_ID) return null;
  const parts = (pathParts || []).filter(Boolean);
  if (parts.length === 0) return DRIVE_FOLDER_ID;
  const key = parts.join("/");
  if (driveFolderCache.has(key)) return driveFolderCache.get(key);
  try {
    const drive = await getDriveApi();
    let parentId = DRIVE_FOLDER_ID;
    let cumulative = "";
    for (const name of parts) {
      cumulative = cumulative ? `${cumulative}/${name}` : name;
      if (driveFolderCache.has(cumulative)) {
        parentId = driveFolderCache.get(cumulative);
        continue;
      }
      // 探索
      const escaped = String(name).replace(/'/g, "\\'");
      const q = `name = '${escaped}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const res = await drive.files.list({
        q,
        fields: "files(id,name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });
      let folderId;
      if (res.data.files && res.data.files.length) {
        folderId = res.data.files[0].id;
      } else {
        const created = await drive.files.create({
          requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
          fields: "id",
          supportsAllDrives: true,
        });
        folderId = created.data.id;
        console.log(`[drive] created folder ${cumulative} id=${folderId}`);
      }
      driveFolderCache.set(cumulative, folderId);
      parentId = folderId;
    }
    return parentId;
  } catch (e) {
    console.warn(`[drive] subfolder ensure failed for ${key}: ${e.message}`);
    return DRIVE_FOLDER_ID;   // fallback: ルート
  }
}

// 後方互換: 旧 getOrCreateDriveMonthFolder (yyyymm 単体) は ["YYYY-MM"] にマップ
async function getOrCreateDriveMonthFolder(yyyymm) {
  return getOrCreateDriveSubfolder(yyyymm ? [yyyymm] : []);
}

// 画像/PDF を Drive の指定フォルダにアップロードして「リンクを知ってる人は閲覧可」に。
// 引数 yyyymmOrPath: 文字列 "YYYY-MM" (互換) or 配列 ["領収書", "2026-06"] (推奨)。
// 失敗しても本体処理は止めない (null を返す)。
async function uploadToDrive(buffer, filename, mimeType, yyyymmOrPath = null) {
  if (!DRIVE_FOLDER_ID) return null;
  try {
    const pathParts = Array.isArray(yyyymmOrPath)
      ? yyyymmOrPath
      : (yyyymmOrPath ? [yyyymmOrPath] : []);
    const parentId = pathParts.length ? await getOrCreateDriveSubfolder(pathParts) : DRIVE_FOLDER_ID;
    const drive = await getDriveApi();
    const created = await drive.files.create({
      requestBody: { name: filename, parents: [parentId], mimeType },
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
    console.log(`[drive] uploaded id=${created.data.id} name=${filename} folder=${yyyymm || "root"}`);
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
  // 「写真」セル: Drive URL (アプリ不要で見られる) を優先、無ければアプリ内ビューア
  const photoLinkUrl = r.driveUrl
    || (r.id ? `https://keihi-496002.web.app/keihi/?view=${r.id}` : "");
  const photoCell = photoLinkUrl ? `=HYPERLINK("${String(photoLinkUrl).replace(/"/g, '""')}","🧾")` : "";

  // 新「取引」シートに append (1 行 1 取引の統一フォーマット)。
  // ★ 現場が決まってから書き込む。経費2 のソート前 (site="") は書かない。
  // ソート完了時 PUT /api/records → 再度この関数が呼ばれ、site 入りで初めて記載される。
  // (refId による二重投入防止キャッシュがあるので、PUT で何度書き換えても 1 行のみ)
  if (r.site) {
    appendTx({
      date: r.date || "",
      type: "支出",
      category: r.site === "満竹華庵" ? "旅館" : "工事",
      subcategory: r.category || "",
      amount: Number(r.total) || 0,
      counterparty: r.store || "",
      site: r.site,
      status: "確定",
      paymentMethod: r.payment || "",
      memo: r.memo || "",              // メモは本文だけ (購入者/工種は専用列へ分離)
      buyer: r.buyer || "",            // → 「購入者」列
      workType: r.workType || "",      // → 「工種」列
      photoCell,
      source: "領収書",
      refId: r.id || "",
    }).catch(() => {});
  }

  // 旧フォーマットの月別タブにも引き続き書き込む (バックアップ・互換)
  if (!SHEET_ID) return;
  if (!r.site) return;
  try {
    const sheets = await getSheetsApi();
    const ym = String(r.date || "").slice(0, 7) || "unknown";
    await ensureSheetTab(sheets, ym);
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
  // 「写真」セル: Drive URL (アプリ不要、税理士共有用) を優先、無ければアプリ内ビューア
  const photoLinkUrl = r.driveUrl
    || (r.imageUrl ? `https://keihi-496002.web.app/seikyu/?view=${encodeURIComponent(r.imageUrl)}` : "");
  const photoCell = photoLinkUrl
    ? `=HYPERLINK("${String(photoLinkUrl).replace(/"/g, '""')}","🧾")`
    : "";

  // 新「取引」シートにも append。direction=out (送る) は売上、in (受け取った請求) は支出。
  // 完了日があればそれを日付に、無ければ発行日。状態は確定 / 未入金 / 未払い。
  const isOut = r.direction === "out";
  appendTx({
    date: r.paidAt || r.issueDate || "",
    type: isOut ? "収入" : "支出",
    category: r.site === "満竹華庵" ? "旅館" : "工事",
    subcategory: r.category || "",
    amount: Number(r.total) || 0,
    counterparty: r.issuer || "",
    site: r.site || "",
    status: r.status === "paid" ? "確定" : (isOut ? "未入金" : "未払い"),
    paymentMethod: "振込",
    memo: r.memo || "",
    photoCell,
    source: "請求書",
    refId: r.id || "",
  }).catch(() => {});

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

// ───── 統一取引シート (tx-sheet): 会社の金の動きを 1 タブに集約 ─────
// 領収書 (keihi) / 経費2 (keihi2) / 請求書 (seikyu) / 宿 (yado) からの全データを
// 1 行 1 取引で「取引」タブに append、月別/現場別/カテゴリ別 dashboard は SUMIFS+QUERY で
// Sheets 側が自動再計算する。月横並びを廃止して並び替え自由な形に。
const TX_SHEET_ID = (process.env.TX_SHEET_ID || "1MFeJCDurzRqQiJB3aeIjwNH9PRocZzNW_poOEfDJKAc").trim();
const TX_TAB = "取引";
const TX_HEADER = [
  "日付", "種別", "大分類", "小分類", "金額", "対象", "現場",
  "状態", "支払方法", "メモ", "写真", "ソース", "元ID", "登録日",
  "購入者", "工種",
];
// 列数が増えた時にヘッダー行を 1 回だけ書き直すためのフラグ (cold start ごと)
let txHeaderEnsured = false;
// JST (UTC+9) の YYYY-MM-DD を返す。Cloud Run のロケール非依存。
function jstTodayStr() {
  const t = new Date();
  const jst = new Date(t.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}
// 元ID 列 (M=12) の重複を避けるための簡易キャッシュ。再起動でリセットされるが
// 二重投入の主な原因は「短時間の連打」なので実用上は十分。
const txSeenRefIds = new Set();
// dashboard セットアップを cold start 後 1 回だけ走らせるためのフラグ。
let txDashboardsInit = false;

async function appendTx(r) {
  if (!TX_SHEET_ID) return { skipped: true };
  // 元ID で de-dup (短時間の二重投入対策)。
  if (r.refId && txSeenRefIds.has(`${r.source}:${r.refId}`)) {
    return { skipped: true, reason: "duplicate refId in cache" };
  }
  try {
    const sheets = await getSheetsApi();
    await ensureSheetTabGeneric(sheets, TX_SHEET_ID, TX_TAB, TX_HEADER, [0]);
    // 既存タブのヘッダー行が古い列数だった場合に備えて、cold start 後 1 回だけ
    // A1:N1 を最新ヘッダーで上書き (idempotent)
    if (!txHeaderEnsured) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: TX_SHEET_ID,
          range: `${TX_TAB}!A1:P1`,
          valueInputOption: "RAW",
          requestBody: { values: [TX_HEADER] },
        });
      } catch (e) { console.warn(`[tx] header ensure failed: ${e.message}`); }
      txHeaderEnsured = true;
    }
    // cold start 後の初回 append で dashboard タブも揃える (失敗しても本体は続行)
    if (!txDashboardsInit) {
      txDashboardsInit = true; // 先にフラグ立てて並行呼び出しでの多重実行を防ぐ
      ensureTxDashboards().catch((e) => {
        txDashboardsInit = false; // 失敗時は次回再挑戦できるよう戻す
        console.warn(`[tx] dashboard setup failed (continuing): ${e.message}`);
      });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: TX_SHEET_ID,
      range: `${TX_TAB}!A:P`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          r.date || "", r.type || "", r.category || "", r.subcategory || "",
          Number(r.amount) || 0, r.counterparty || "", r.site || "",
          r.status || "確定", r.paymentMethod || "", r.memo || "",
          r.photoCell || "", r.source || "", r.refId || "",
          r.registeredAt || jstTodayStr(),    // 登録日 (JST)
          r.buyer || "", r.workType || "",     // 購入者 / 工種 (メモから分離)
        ]],
      },
    });
    if (r.refId) txSeenRefIds.add(`${r.source}:${r.refId}`);
    // keiri ダッシュボードのキャッシュを無効化 (次の summary/year 呼び出しで再取得)
    keiriCache.fetchedAt = 0;
    keiriCache.rows = [];
    console.log(`[tx] appended source=${r.source} type=${r.type} amount=${r.amount} site=${r.site || "-"}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[tx] append FAILED: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// 月別 / 現場別 / カテゴリ別の3つの dashboard タブを作成 (idempotent)。
// データタブ「取引」が無ければ先に作る。
async function ensureTxDashboards() {
  if (!TX_SHEET_ID) throw new Error("TX_SHEET_ID not configured");
  const sheets = await getSheetsApi();
  await ensureSheetTabGeneric(sheets, TX_SHEET_ID, TX_TAB, TX_HEADER, [0]);

  // 1) 月別タブ: 1行=1ヶ月、12行プリフィル (2026 年)。日付セル A は 月初日。
  const MONTHLY_TAB = "月別";
  const MONTHLY_HEADER = [
    "月", "工事売上", "旅館売上", "その他収入", "収入合計",
    "工事原価", "旅館原価", "固定費", "光熱費", "その他支出", "支出合計", "利益",
  ];
  await ensureSheetTabGeneric(sheets, TX_SHEET_ID, MONTHLY_TAB, MONTHLY_HEADER, [0]);
  // 12 ヶ月分の行を投入 (既に行があれば上書きで OK = idempotent)
  const monthlyRows = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `2026-${String(m).padStart(2, "0")}-01`;
    const row = m + 1; // ヘッダー行が 1
    const f = (col) => `'${TX_TAB}'!${col}:${col}`;
    const range = `, ${f("A")}, ">="&$A${row}, ${f("A")}, "<"&EDATE($A${row},1)`;
    const sumByType = (typ) => `IFERROR(SUMIFS(${f("E")}${range}, ${f("B")}, "${typ}"),0)`;
    const sumByCat = (typ, cat) => `IFERROR(SUMIFS(${f("E")}${range}, ${f("B")}, "${typ}", ${f("C")}, "${cat}"),0)`;
    monthlyRows.push([
      ym,
      `=${sumByCat("収入", "工事")}`,
      `=${sumByCat("収入", "旅館")}`,
      `=${sumByType("収入")} - B${row} - C${row}`,
      `=B${row} + C${row} + D${row}`,
      `=${sumByCat("支出", "工事")}`,
      `=${sumByCat("支出", "旅館")}`,
      `=${sumByCat("支出", "固定費")}`,
      `=${sumByCat("支出", "光熱費")}`,
      `=${sumByType("支出")} - F${row} - G${row} - H${row} - I${row}`,
      `=F${row} + G${row} + H${row} + I${row} + J${row}`,
      `=E${row} - K${row}`,
    ]);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: TX_SHEET_ID,
    range: `${MONTHLY_TAB}!A2:L13`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: monthlyRows },
  });

  // 2) 現場別タブ: QUERY で動的に現場一覧 + 売上を集計
  const SITE_TAB = "現場別";
  const SITE_HEADER = ["現場別ダッシュボード（自動集計）"];
  await ensureSheetTabGeneric(sheets, TX_SHEET_ID, SITE_TAB, SITE_HEADER, []);
  await sheets.spreadsheets.values.update({
    spreadsheetId: TX_SHEET_ID,
    range: `${SITE_TAB}!A2`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[
      `=IFERROR(QUERY('${TX_TAB}'!A2:M, "SELECT G, SUM(E) WHERE G IS NOT NULL AND B='収入' GROUP BY G ORDER BY SUM(E) DESC LABEL G '現場', SUM(E) '売上'"), "データなし")`,
    ]] },
  });
  // 右側に「支出」も別 QUERY で並べる
  await sheets.spreadsheets.values.update({
    spreadsheetId: TX_SHEET_ID,
    range: `${SITE_TAB}!D2`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[
      `=IFERROR(QUERY('${TX_TAB}'!A2:M, "SELECT G, SUM(E) WHERE G IS NOT NULL AND B='支出' GROUP BY G ORDER BY SUM(E) DESC LABEL G '現場', SUM(E) '原価'"), "データなし")`,
    ]] },
  });

  // 3) カテゴリ別タブ: 大分類×小分類で件数+金額を出す。支出に絞る (経費の内訳が見たいケース)
  const CAT_TAB = "カテゴリ別";
  const CAT_HEADER = ["カテゴリ別ダッシュボード（支出・自動集計）"];
  await ensureSheetTabGeneric(sheets, TX_SHEET_ID, CAT_TAB, CAT_HEADER, []);
  await sheets.spreadsheets.values.update({
    spreadsheetId: TX_SHEET_ID,
    range: `${CAT_TAB}!A2`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[
      `=IFERROR(QUERY('${TX_TAB}'!A2:M, "SELECT C, D, COUNT(C), SUM(E) WHERE B='支出' GROUP BY C, D ORDER BY SUM(E) DESC LABEL C '大分類', D '小分類', COUNT(C) '件数', SUM(E) '金額'"), "データなし")`,
    ]] },
  });
}

// ───── 既存ヘルパー：年別サマリータブ (YYYY-サマリー) の対象月の行を更新 (旧請求書フォーマット) ─────
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
    // sites: /genba/ アプリ用に住所 + キーボックスメモを保持
    await p.query("ALTER TABLE sites ADD COLUMN IF NOT EXISTS address TEXT");
    await p.query("ALTER TABLE sites ADD COLUMN IF NOT EXISTS key_box TEXT");
    await p.query("ALTER TABLE sites ADD COLUMN IF NOT EXISTS postal TEXT");
    await p.query("ALTER TABLE sites ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ");
    // 「会社」サイト (オフィス・会社全般の手配/タスク用) を常時用意
    await p.query("INSERT INTO sites (name) VALUES ('会社') ON CONFLICT (name) DO NOTHING");
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
    // yado: Beds24 予約のローカルキャッシュ + 同期メタ
    await p.query(`
      CREATE TABLE IF NOT EXISTS yado_bookings (
        id            BIGINT PRIMARY KEY,
        property_id   INT,
        arrival       DATE NOT NULL,
        departure     DATE NOT NULL,
        nights        INT NOT NULL,
        channel       TEXT NOT NULL DEFAULT 'other',
        referer       TEXT,
        status        TEXT,
        price         INT NOT NULL DEFAULT 0,
        commission    INT NOT NULL DEFAULT 0,
        num_adult     INT NOT NULL DEFAULT 0,
        num_child     INT NOT NULL DEFAULT 0,
        country       TEXT,
        guest_name    TEXT,
        booking_time  TIMESTAMPTZ,
        modified_time TIMESTAMPTZ NOT NULL,
        raw_json      JSONB,
        synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS yado_bookings_arrival_idx ON yado_bookings (arrival)");
    await p.query("CREATE INDEX IF NOT EXISTS yado_bookings_modified_idx ON yado_bookings (modified_time)");
    await p.query("CREATE INDEX IF NOT EXISTS yado_bookings_channel_idx ON yado_bookings (channel)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS yado_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // seko-kanri (2級建築施工管理技士 対策): techstudy/kotonoha と同形の4テーブル。
    // 既存 kotonoha データに影響を出さないため完全に分離。
    await p.query(`
      CREATE TABLE IF NOT EXISTS seko_questions (
        id            BIGSERIAL PRIMARY KEY,
        category      TEXT NOT NULL,
        difficulty    INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
        type          TEXT NOT NULL CHECK (type IN ('choice', 'free')),
        question      TEXT NOT NULL,
        options       JSONB,
        answer        TEXT NOT NULL,
        keywords      JSONB,
        explanation   TEXT NOT NULL,
        claude_example TEXT,
        genre         TEXT,
        group_id      TEXT,
        exam_level    TEXT,                          -- '1ji' | '2ji'
        source        TEXT DEFAULT 'generated',
        prerequisites JSONB DEFAULT '[]'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS seko_q_genre_idx ON seko_questions (genre)");
    await p.query("CREATE INDEX IF NOT EXISTS seko_q_group_idx ON seko_questions (group_id)");
    await p.query("CREATE INDEX IF NOT EXISTS seko_q_exam_level_idx ON seko_questions (exam_level)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS seko_progress (
        id           BIGSERIAL PRIMARY KEY,
        user_email   TEXT NOT NULL,
        question_id  BIGINT NOT NULL REFERENCES seko_questions(id) ON DELETE CASCADE,
        is_correct   BOOLEAN NOT NULL,
        user_answer  TEXT,
        attempts     INTEGER NOT NULL DEFAULT 1,
        answered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS seko_p_user_idx ON seko_progress (user_email, answered_at DESC)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS seko_users (
        user_email      TEXT PRIMARY KEY,
        display_name    TEXT NOT NULL,
        level           INTEGER NOT NULL DEFAULT 1,
        total_correct   INTEGER NOT NULL DEFAULT 0,
        total_answers   INTEGER NOT NULL DEFAULT 0,
        visible_to_peers BOOLEAN NOT NULL DEFAULT true,
        exam_target     TEXT,                        -- 'first_full' | 'second_only'
        shubetsu        TEXT,                        -- 'kenchiku' | 'kutai' | 'shiage' (2級建築施工管理技士の受検種別)
        last_session_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // 既存テーブルに shubetsu カラム追加 (ALTER ... IF NOT EXISTS は PG 9.6+)
    await p.query(`ALTER TABLE seko_users ADD COLUMN IF NOT EXISTS shubetsu TEXT`);
    // seko_questions に image_url カラム追加 (図解が要る問題で AI 生成 SVG を data URI で保存)
    await p.query(`ALTER TABLE seko_questions ADD COLUMN IF NOT EXISTS image_url TEXT`);

    // fx-bot: OANDA 自動売買用テーブル
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_decisions (
        id            BIGSERIAL PRIMARY KEY,
        instrument    TEXT NOT NULL,
        granularity   TEXT NOT NULL,
        last_close    NUMERIC,
        decision      TEXT NOT NULL,        -- 'LONG' | 'SHORT' | 'PASS'
        confidence    NUMERIC,
        reasoning     TEXT,
        skipped       BOOLEAN NOT NULL DEFAULT false,
        skip_reason   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS fx_dec_created_idx ON fx_decisions (created_at DESC)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_trades (
        id              BIGSERIAL PRIMARY KEY,
        kind            TEXT NOT NULL,             -- 'opened' | 'closed' | 'order_failed'
        instrument      TEXT NOT NULL,
        side            TEXT,                      -- 'LONG' | 'SHORT'
        units           INTEGER,
        entry_price     NUMERIC,
        tp_price        NUMERIC,
        sl_price        NUMERIC,
        close_price     NUMERIC,
        pnl             NUMERIC,
        confidence      NUMERIC,
        reasoning       TEXT,
        oanda_order_id  TEXT,
        oanda_fill_id   TEXT,
        oanda_trade_id  TEXT,
        error           TEXT,
        opened_at       TIMESTAMPTZ,
        closed_at       TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS fx_tr_created_idx ON fx_trades (created_at DESC)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_settings (
        id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        bot_enabled         BOOLEAN NOT NULL DEFAULT false,
        oanda_env           TEXT NOT NULL DEFAULT 'practice',  -- 'practice' | 'live'
        instrument          TEXT NOT NULL DEFAULT 'USD_JPY',
        granularity         TEXT NOT NULL DEFAULT 'M5',
        candle_count        INTEGER NOT NULL DEFAULT 100,
        units_per_trade     INTEGER NOT NULL DEFAULT 1,
        take_profit_pips    NUMERIC NOT NULL DEFAULT 10,
        stop_loss_pips      NUMERIC NOT NULL DEFAULT 10,
        max_trades_per_day  INTEGER NOT NULL DEFAULT 20,
        confidence_threshold NUMERIC NOT NULL DEFAULT 0.7,
        cooldown_after_losses INTEGER NOT NULL DEFAULT 3,
        cooldown_minutes    INTEGER NOT NULL DEFAULT 60,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`INSERT INTO fx_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    // auto_apply_optimizations は後から追加 (既存 deploy のため IF NOT EXISTS)
    await p.query(`ALTER TABLE fx_settings ADD COLUMN IF NOT EXISTS auto_apply_optimizations BOOLEAN NOT NULL DEFAULT false`);
    // 戦略選択 (決定的アルゴ + パラメータ)。AI は ai_vision 戦略として 1 つの選択肢。
    await p.query(`ALTER TABLE fx_settings ADD COLUMN IF NOT EXISTS active_strategy TEXT NOT NULL DEFAULT 'ema_crossover'`);
    await p.query(`ALTER TABLE fx_settings ADD COLUMN IF NOT EXISTS strategy_params JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_optimizations (
        id              BIGSERIAL PRIMARY KEY,
        stats           JSONB,
        analysis        TEXT,
        suggestions     JSONB,
        reasoning       TEXT,
        applied         BOOLEAN NOT NULL DEFAULT false,
        applied_changes JSONB,
        applied_at      TIMESTAMPTZ,
        rejected        BOOLEAN NOT NULL DEFAULT false,
        rejected_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS fx_opt_created_idx ON fx_optimizations (created_at DESC)");

    // バックテスト: 過去 candle に対して AI 判断を再生 → 結果集計 → 設定校正
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_backtests (
        id                   BIGSERIAL PRIMARY KEY,
        instrument           TEXT NOT NULL,
        granularity          TEXT NOT NULL,
        from_time            TIMESTAMPTZ NOT NULL,
        to_time              TIMESTAMPTZ NOT NULL,
        tp_pips              NUMERIC NOT NULL,
        sl_pips              NUMERIC NOT NULL,
        confidence_threshold NUMERIC NOT NULL,
        sample_rate          INTEGER NOT NULL DEFAULT 5,    -- N candle ごとに 1 回判断
        status               TEXT NOT NULL DEFAULT 'queued', -- queued|fetching|running|done|error
        progress             INTEGER NOT NULL DEFAULT 0,
        candle_count         INTEGER,
        total_predictions    INTEGER,
        pass_count           INTEGER,
        long_count           INTEGER,
        short_count          INTEGER,
        trades_taken         INTEGER,
        wins                 INTEGER,
        losses               INTEGER,
        timeouts             INTEGER,      -- TP/SL どちらも当たらず時間切れ
        total_pnl_pips       NUMERIC,
        profit_factor        NUMERIC,
        win_rate             NUMERIC,
        conf_buckets         JSONB,        -- { "0.5-0.6": {n,w,l,wr,pnl}, ... }
        error                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at          TIMESTAMPTZ
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS fx_bt_created_idx ON fx_backtests (created_at DESC)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS fx_backtest_predictions (
        id            BIGSERIAL PRIMARY KEY,
        backtest_id   BIGINT NOT NULL REFERENCES fx_backtests(id) ON DELETE CASCADE,
        candle_time   TIMESTAMPTZ NOT NULL,
        decision      TEXT NOT NULL,
        confidence    NUMERIC,
        reasoning     TEXT,
        entry_price   NUMERIC,
        hit_tp        BOOLEAN,
        hit_sl        BOOLEAN,
        exit_price    NUMERIC,
        pnl_pips      NUMERIC,
        bars_to_exit  INTEGER,
        taken         BOOLEAN
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS fx_btp_bt_idx ON fx_backtest_predictions (backtest_id, candle_time)");
    // fx_backtests: 戦略 + パラメータを記録 (どの戦略を試したか後で見るため)
    await p.query(`ALTER TABLE fx_backtests ADD COLUMN IF NOT EXISTS strategy_name TEXT`);
    await p.query(`ALTER TABLE fx_backtests ADD COLUMN IF NOT EXISTS strategy_params JSONB`);
    // スプレッド + スリッページの想定コスト (round-trip pips)。デフォルト 1 pip
    await p.query(`ALTER TABLE fx_backtests ADD COLUMN IF NOT EXISTS cost_pips NUMERIC NOT NULL DEFAULT 1.0`);

    // 自動ドラマ作成 (auto-drama): 著作権切れ小説 → AI協調 → Seedance 動画生成のミニ制作アプリ
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_projects (
        id                  BIGSERIAL PRIMARY KEY,
        title               TEXT NOT NULL,
        author              TEXT,
        source_text         TEXT,
        world_setting       TEXT,
        style_guide         TEXT,
        default_video_model TEXT NOT NULL DEFAULT 'seedance-2.0-fast',
        created_by          TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_characters (
        id                BIGSERIAL PRIMARY KEY,
        project_id        BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        reading           TEXT,
        description       TEXT,
        appearance_prompt TEXT,
        identity_tokens   JSONB NOT NULL DEFAULT '[]'::jsonb,
        reference_images  JSONB NOT NULL DEFAULT '[]'::jsonb,
        status            TEXT NOT NULL DEFAULT 'draft',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_char_project_idx ON drama_characters (project_id)");
    // 場所 (シーン背景)。キャラと同じ構造: 識別子 + 参照画像で背景の統一性を担保する
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_locations (
        id                BIGSERIAL PRIMARY KEY,
        project_id        BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        description       TEXT,
        appearance_prompt TEXT,
        identity_tokens   JSONB NOT NULL DEFAULT '[]'::jsonb,
        reference_images  JSONB NOT NULL DEFAULT '[]'::jsonb,
        status            TEXT NOT NULL DEFAULT 'draft',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_loc_project_idx ON drama_locations (project_id)");
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_episodes (
        id                      BIGSERIAL PRIMARY KEY,
        project_id              BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        number                  INTEGER NOT NULL,
        title                   TEXT,
        source_range_start      INTEGER,
        source_range_end        INTEGER,
        target_duration_sec     INTEGER NOT NULL DEFAULT 60,
        key_visual              JSONB NOT NULL DEFAULT '{}'::jsonb,
        state                   TEXT NOT NULL DEFAULT 'key_visual',
        appearing_character_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_ep_project_idx ON drama_episodes (project_id)");
    // AI の制作メモ (長期記憶)。チャットの update_notes 操作で AI 自身が維持し、
    // 毎回システムプロンプトに注入される (作画の趣向・細かい設定・決定した方向性)
    await p.query(`ALTER TABLE drama_projects ADD COLUMN IF NOT EXISTS ai_notes TEXT`);
    // 作画基準画像 (URL 配列・最大2枚)。画像生成のたびに inlineData で渡して絵柄を寄せる
    await p.query(`ALTER TABLE drama_projects ADD COLUMN IF NOT EXISTS style_ref_images JSONB NOT NULL DEFAULT '[]'::jsonb`);
    // 制作資料 (人物対比図・美術ボード等)。名前で AI が参照し、画像生成時に同梱できる
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_assets (
        id         BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        note       TEXT,
        url        TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_assets_project_idx ON drama_assets (project_id)");
    // アニメ制作工程対応: シリーズ構成 (章→話の割当・緩急) と脚本を話単位で持つ
    await p.query(`ALTER TABLE drama_episodes ADD COLUMN IF NOT EXISTS chapter_numbers JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await p.query(`ALTER TABLE drama_episodes ADD COLUMN IF NOT EXISTS pacing TEXT`);   // 'compress'|'normal'|'stretch'
    await p.query(`ALTER TABLE drama_episodes ADD COLUMN IF NOT EXISTS focus TEXT`);    // この話の見せ場メモ
    await p.query(`ALTER TABLE drama_episodes ADD COLUMN IF NOT EXISTS script TEXT`);   // 話単位の脚本 (ナレーション+セリフ+ト書き)
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_cuts (
        id                        BIGSERIAL PRIMARY KEY,
        episode_id                BIGINT NOT NULL REFERENCES drama_episodes(id) ON DELETE CASCADE,
        "order"                   INTEGER NOT NULL,
        duration_sec              INTEGER NOT NULL DEFAULT 8,
        prompt                    TEXT,
        character_ids             JSONB NOT NULL DEFAULT '[]'::jsonb,
        generations               JSONB NOT NULL DEFAULT '[]'::jsonb,
        selected_generation_index INTEGER NOT NULL DEFAULT -1,
        narration                 TEXT,
        subtitle                  TEXT,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`CREATE INDEX IF NOT EXISTS drama_cut_ep_idx ON drama_cuts (episode_id, "order")`);
    // カットの撮影場所 (背景統一用)。既存テーブルへの後付けなので ALTER
    await p.query(`ALTER TABLE drama_cuts ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES drama_locations(id) ON DELETE SET NULL`);
    // 絵コンテ (動画生成前の静止画確認。承認なしに作画へ進まない実制作の流儀)
    await p.query(`ALTER TABLE drama_cuts ADD COLUMN IF NOT EXISTS storyboard_url TEXT`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_timelines (
        episode_id         BIGINT PRIMARY KEY REFERENCES drama_episodes(id) ON DELETE CASCADE,
        items               JSONB NOT NULL DEFAULT '[]'::jsonb,
        exported_video_url  TEXT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_chat_messages (
        id         BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        episode_id BIGINT REFERENCES drama_episodes(id) ON DELETE SET NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_chat_project_idx ON drama_chat_messages (project_id, created_at)");
    // チャットへの画像添付 (Firebase Storage の URL 配列)
    await p.query(`ALTER TABLE drama_chat_messages ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`);
    // 非同期処理ステータス ('pending' = Cloud Tasks で処理中の assistant 行)
    await p.query(`ALTER TABLE drama_chat_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done'`);
    // 引用返信 (「この画像の感じで作って」用)。引用先の画像は生成の最優先参照になる
    await p.query(`ALTER TABLE drama_chat_messages ADD COLUMN IF NOT EXISTS quoted_message_id BIGINT`);
    // 原作の章分割 (青空文庫 import で自動生成)。summary / character_names は AI 解析で埋まる
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_chapters (
        id              BIGSERIAL PRIMARY KEY,
        project_id      BIGINT NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
        number          INTEGER NOT NULL,
        title           TEXT,
        content         TEXT NOT NULL,
        summary         TEXT,
        character_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_chap_project_idx ON drama_chapters (project_id, number)");
    // API 使用量の記録 (プロジェクト別のコスト見える化。gemini はトークン実測、seedance は秒数から概算)
    await p.query(`
      CREATE TABLE IF NOT EXISTS drama_api_usage (
        id            BIGSERIAL PRIMARY KEY,
        project_id    BIGINT REFERENCES drama_projects(id) ON DELETE CASCADE,
        provider      TEXT NOT NULL,     -- 'gemini' | 'seedance'
        kind          TEXT NOT NULL,     -- 'chat' | 'chapter_analyze' | 'work_setup' | 'search' | 'video'
        model         TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        video_seconds NUMERIC,
        cost_yen      NUMERIC NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query("CREATE INDEX IF NOT EXISTS drama_usage_project_idx ON drama_api_usage (project_id, created_at DESC)");

    schemaMigrated = true;
    console.log("[schema] migration ok: records.drive_url + tasks + yado_bookings + seko_* + fx_* + drama_* ensured");
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
    seedance: dramaSeedanceConfigured(),
  });
});

// ─────────────────────────────
// Sites
// ─────────────────────────────
// sites の CRUD はランチャー「現場」アプリ (/genba/) からのみ利用される想定。
// 他ミニアプリ (keihi/keihi2/seikyu/kaimono/task) は GET のみ。
app.get("/api/sites", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const { rows } = await p.query(
      `SELECT id, name, address, key_box AS "keyBox", postal, done_at AS "doneAt"
         FROM sites
        ORDER BY (done_at IS NOT NULL) ASC,
                 CASE WHEN done_at IS NULL THEN id END ASC,
                 done_at DESC`
    );
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
  const address = (req.body?.address || "").trim() || null;
  const keyBox = (req.body?.keyBox || "").trim() || null;
  const postal = (req.body?.postal || "").trim() || null;
  try {
    await ensureSchema();
    const { rows } = await p.query(
      `INSERT INTO sites (name, address, key_box, postal) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET address=EXCLUDED.address, key_box=EXCLUDED.key_box, postal=EXCLUDED.postal
       RETURNING id, name, address, key_box AS "keyBox", postal`,
      [name, address, keyBox, postal]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("sites insert", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/sites/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const address = (req.body?.address || "").trim() || null;
  const keyBox = (req.body?.keyBox || "").trim() || null;
  const postal = (req.body?.postal || "").trim() || null;
  try {
    await ensureSchema();
    const { rows } = await p.query(
      `UPDATE sites SET name=$1, address=$2, key_box=$3, postal=$4 WHERE id=$5
       RETURNING id, name, address, key_box AS "keyBox", postal`,
      [name, address, keyBox, postal, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("sites update", err);
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

// 完了/再開の toggle。{ done: true } で done_at = NOW()、{ done: false } で NULL に。
app.patch("/api/sites/:id/done", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const done = req.body?.done === true;
  try {
    await ensureSchema();
    const { rows } = await p.query(
      `UPDATE sites SET done_at = ${done ? "NOW()" : "NULL"} WHERE id = $1
       RETURNING id, name, address, key_box AS "keyBox", postal, done_at AS "doneAt"`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("sites done toggle", err);
    res.status(500).json({ error: err.message });
  }
});

// 住所から郵便番号を調べる (現場アプリの自動入力用)。Gemini で安価にやれる。
// 返り値: { postal: "123-4567" } または { postal: "" } (判別不可)
app.post("/api/genba/lookup-postal", async (req, res) => {
  if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
  const address = String(req.body?.address || "").trim();
  if (!address) return res.json({ postal: "" });
  try {
    const prompt = `次の日本の住所の郵便番号 (7 桁、123-4567 形式) を答えてください。確実に分かる場合のみ。
住所: ${address}

回答は JSON で {"postal":"123-4567"} の形式。判別できない、または日本以外の住所の場合は {"postal":""} を返してください。
町名・番地・建物名まで完全に一致しなくても、町名レベルで特定できれば OK。`;
    const { result } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash-lite",   // 軽量モデルで十分
      maxOutputTokens: 64,
      jsonMode: true,
    });
    const text = result?.response?.text?.() || "";
    const parsed = parseLooseJson(text, { logErr: false });
    const postal = String(parsed?.postal || "").trim();
    // 形式チェック: 7 桁数字 (ハイフン任意)
    const m = postal.match(/(\d{3})-?(\d{4})/);
    res.json({ postal: m ? `${m[1]}-${m[2]}` : "" });
  } catch (e) {
    console.warn("[genba] postal lookup failed:", e.message);
    res.json({ postal: "" });
  }
});

// ─────────────────────────────
// Receipt scan (Gemini + GCS upload)
// ─────────────────────────────
// 503/UNAVAILABLE 等の過渡的エラーで指数バックオフ→別モデルへフォールバック。
// Gemini Flash は時々スパイクで詰まるので、ユーザーが「Retry」を押す前に
// サーバ側で吸収する。
// Gemini が返した文字列を JSON として parse する。多少壊れていても repair を試みる。
// 失敗時は null。logErr=true なら parse 失敗時に詳細をログ出力。
function parseLooseJson(text, { logErr = true } = {}) {
  if (!text) return null;
  let t = String(text).trim();
  // ```json ... ``` フェンスを剥がす
  t = t.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // 最初の { から最後の } まで切り出し
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) {
    if (logErr) console.warn("[json-parse] no JSON braces in response");
    return null;
  }
  let body = t.slice(s, e + 1);
  // 1回目: そのまま
  try { return JSON.parse(body); } catch (_) {}
  // 2回目: 末尾カンマ除去 ("key":"v",}/] → }/])
  try { return JSON.parse(body.replace(/,(\s*[}\]])/g, "$1")); } catch (_) {}
  // 3回目: スマートクオートを通常クオートに置換
  try {
    const fixed = body
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(fixed);
  } catch (e3) {
    if (logErr) console.warn(`[json-parse] all repair attempts failed: ${e3.message}\n--- body (first 400) ---\n${body.slice(0, 400)}\n--- body (last 200) ---\n${body.slice(-200)}`);
  }
  return null;
}

async function callGeminiWithFallback(content, { primaryModel, maxOutputTokens, useGoogleSearch, jsonMode } = {}) {
  const fallbackChain = [
    ...new Set([primaryModel || GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]),
  ];
  let lastErr;
  for (const name of fallbackChain) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const generationConfig = {};
        if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
        if (jsonMode) generationConfig.responseMimeType = "application/json";
        const m = genAI.getGenerativeModel({
          model: name,
          ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
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

// 過去にスキップされた請求書 PDF/画像 を GCS から引っ張って Drive へ移行。
// (以前は seikyu が source 未指定で default 'camera' 扱い → Drive スキップだった分の救済)
// フロント側で migration 要否を判定 → bills を items として送ってもらう。
// 各 item: { id, imageUrl ("gs://..."), mimeType?, issuer?, issueDate? }
// 返り値: { results: [{ id, ok, driveUrl?, error? }], ok, failed }
app.post("/api/seikyu/migrate-to-drive", async (req, res) => {
  if (!DRIVE_FOLDER_ID || !storage) {
    return res.status(503).json({ error: "Drive または GCS が設定されてません" });
  }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ results: [], ok: 0, failed: 0 });

  const results = [];
  let okCount = 0, failedCount = 0;
  for (const it of items) {
    const id = String(it?.id || "");
    const imageUrl = String(it?.imageUrl || "");
    if (!id || !imageUrl.startsWith("gs://")) {
      results.push({ id, ok: false, error: "imageUrl が gs:// で始まらない" });
      failedCount++;
      continue;
    }
    try {
      const m = imageUrl.match(/^gs:\/\/([^/]+)\/(.+)$/);
      if (!m) throw new Error("invalid gs:// URL");
      const [, bucket, key] = m;
      const [buffer] = await storage.bucket(bucket).file(key).download();
      const mimeType = String(it.mimeType || (key.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"));
      const yyyymm = String(it.issueDate || "").slice(0, 7) || new Date().toISOString().slice(0, 7);
      const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
      const fname = `${String(it.issuer || "invoice").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}_${id.slice(0, 8)}.${ext}`;
      // 月の中で direction によって「支払請求書」/「売上請求書」フォルダに振り分け
      const categoryFolder = String(it.direction || "in") === "out" ? "売上請求書" : "支払請求書";
      const dr = await uploadToDrive(buffer, fname, mimeType, [yyyymm, categoryFolder]);
      if (!dr) throw new Error("Drive upload returned null");
      results.push({ id, ok: true, driveUrl: dr.url });
      okCount++;
    } catch (e) {
      console.warn(`[seikyu-migrate] ${id} failed: ${e.message}`);
      results.push({ id, ok: false, error: e.message });
      failedCount++;
    }
  }
  res.json({ results, ok: okCount, failed: failedCount });
});

// ───── 新「取引」シートのセットアップ (4タブ作成 + dashboard 数式投入) ─────
// 1 回叩けば 月別/現場別/カテゴリ別 タブを idempotent に作成する。
app.post("/api/tx/setup", async (req, res) => {
  try {
    await ensureTxDashboards();
    res.json({ ok: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${TX_SHEET_ID}/edit` });
  } catch (e) {
    console.error("tx setup error", e);
    res.status(500).json({ error: e.message });
  }
});

// 取引シートへの汎用 append (手入力用、テスト用、固定費の月初テンプレ等から)
app.post("/api/tx/append", async (req, res) => {
  const result = await appendTx(req.body || {});
  if (result.ok) res.json(result);
  else res.status(500).json(result);
});

// 「取引」タブの既存行を更新 (経理 Phase 2 編集機能から)。
// refId + source で行を特定し、指定された fields だけを書き換える。
// 列マッピング: A=日付 B=種別 C=大分類 D=小分類 E=金額 F=対象 G=現場 H=状態 I=支払方法 J=メモ K=写真 L=ソース M=元ID
app.post("/api/tx/update", async (req, res) => {
  const { refId, source, fields = {} } = req.body || {};
  if (!refId || !source) return res.status(400).json({ error: "refId と source は必須" });
  if (!fields || typeof fields !== "object") return res.status(400).json({ error: "fields は object" });
  try {
    const sheets = await getSheetsApi();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: TX_SHEET_ID,
      range: `${TX_TAB}!A2:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const allRows = r.data.values || [];
    const idx = allRows.findIndex((row) =>
      String(row[12] || "") === String(refId) && String(row[11] || "") === String(source));
    if (idx < 0) return res.status(404).json({ error: `行が見つかりません (refId=${refId}, source=${source})` });
    const sheetRow = idx + 2;  // ヘッダー1行 + 0-indexed → 1-indexed
    const updated = [...(allRows[idx] || [])];
    while (updated.length < 14) updated.push("");
    const FIELD_TO_IDX = {
      date: 0, type: 1, category: 2, subcategory: 3, amount: 4,
      counterparty: 5, site: 6, status: 7, paymentMethod: 8, memo: 9,
    };
    for (const [k, v] of Object.entries(fields)) {
      const i = FIELD_TO_IDX[k];
      if (i == null) continue;
      updated[i] = k === "amount" ? (Number(v) || 0) : (v == null ? "" : String(v));
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: TX_SHEET_ID,
      range: `${TX_TAB}!A${sheetRow}:N${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [updated] },
    });
    keiriCache.fetchedAt = 0;
    keiriCache.rows = [];
    console.log(`[tx] updated row ${sheetRow} refId=${refId} source=${source} fields=${Object.keys(fields).join(",")}`);
    res.json({ ok: true, row: sheetRow });
  } catch (e) {
    console.error("[tx] update error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───── 銀行 CSV 取り込み (ginko ミニアプリから) ─────
// 現状は PayPay 銀行のフォーマットだけ対応。base64 で受信した CSV をデコードして
// 行配列に正規化、摘要文の正規表現で自動分類。フロントが per-row 編集 + 送信。
function ginkoDecodeCsv(buf) {
  // Node 20+ TextDecoder で UTF-8 を試して、置換文字が多すぎたら Shift-JIS にフォールバック
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const badChars = (text.match(/�/g) || []).length;
  if (badChars > 5) {
    try { text = new TextDecoder("shift_jis", { fatal: false }).decode(buf); }
    catch (_) { /* shift_jis 未対応環境は UTF-8 のまま */ }
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}
function ginkoParseCsvLine(line) {
  const cols = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === ',') { cols.push(cur); cur = ""; }
      else if (ch === '"') inQuote = true;
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}
function ginkoParseNum(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[,¥￥\s"]/g, "").trim();
  if (!cleaned || cleaned === "-") return 0;
  return Math.abs(Number(cleaned) || 0);
}
function ginkoNormalizeDate(s) {
  if (!s) return null;
  const cleaned = String(s).trim();
  let m = cleaned.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function ginkoHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
// 摘要文 → 大分類 / 小分類 / 対象 の推定 (マッチしないものは「未分類」)
function ginkoClassify(desc, type) {
  const PATTERNS = [
    [/給与|ｷｭｳﾖ|キュウヨ/i,        "固定費", "給料",   ""],
    [/利息|ﾘｿｸ/i,                  "その他", "利息",   "銀行"],
    [/airbnb|ｴｱﾋﾞ|エアビ/i,        "旅館",   "Airbnb", "Airbnb"],
    [/booking|ﾌﾞｯｸ|ブッキング/i,   "旅館",   "Booking.com", "Booking.com"],
    [/楽天|ﾗｸﾃﾝ/i,                 "旅館",   "楽天トラベル", "楽天トラベル"],
    [/じゃらん|ｼﾞｬﾗﾝ/i,            "旅館",   "じゃらん", "じゃらん"],
    [/google|ｸﾞ-ｸﾞ|ｸﾞｰｸﾞﾙ|グーグル/i, "固定費", "web", "googleworkspace"],
    [/adobe|ｱﾄﾞﾋﾞ|アドビ/i,         "固定費", "web", "adobe"],
    [/indeed|ｲﾝﾃﾞｨ|インディード/i,  "固定費", "web", "indeed"],
    [/openai|chatgpt|ｵ-ﾌﾟﾝai/i,    "固定費", "web", "chatGPT"],
    [/lolipop|ﾛﾘﾎﾟ|ロリポップ/i,   "固定費", "web", "ロリポップ"],
    [/家賃|ﾔﾁﾝ|ヤチン/i,            "固定費", "家賃", ""],
    [/保険|ﾎｹﾝ|ホケン/i,            "固定費", "保険", ""],
    [/年金|ﾈﾝｷﾝ|ネンキン/i,         "固定費", "保険", "年金"],
    [/tepco|ﾃﾎﾟｺ|電気|ﾃﾞﾝｷ|デンキ/i, "固定費", "光熱費", "電気"],
    [/ガス|ｶﾞｽ|tokyogas|東京ガス/i,  "固定費", "光熱費", "ガス"],
    [/水道|ｽｲﾄﾞ|スイドウ/i,         "固定費", "光熱費", "水道"],
    [/税|ｾﾞｲ|ゼイ/i,                "固定費", "税金", ""],
    [/自動車|ｼﾞﾄﾞｳｼｬ|車検|ｼｬｹﾝ/i,   "固定費", "車両費", ""],
    [/atm|ｴｰﾃｨｰｴﾑ|ATM|現金引出/i,  "経費",   "現金引出", ""],
    [/手数料|ﾃｽｳﾘｮｳ|テスウリョウ/i, "経費",   "手数料", "銀行手数料"],
    [/振込|ﾌﾘｺﾐ|フリコミ/i, type === "収入" ? "工事" : "経費", "振込", ""],
  ];
  for (const [re, cat, sub, cp] of PATTERNS) {
    if (re.test(desc)) return { category: cat, subcategory: sub, counterparty: cp };
  }
  return { category: type === "収入" ? "その他" : "未分類", subcategory: "未分類", counterparty: "" };
}

app.post("/api/ginko/parse", async (req, res) => {
  const { fileBase64, bank = "paypay" } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: "fileBase64 required" });
  try {
    const buf = Buffer.from(fileBase64, "base64");
    const text = ginkoDecodeCsv(buf);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return res.json({ rows: [], count: 0, warning: "ヘッダー1行とデータ0行" });

    const header = ginkoParseCsvLine(lines[0]);
    const idx = {
      // 1列日付 (例: みずほの「日付」、楽天の「取扱日」)
      date: header.findIndex((h) => /^(日付|年月日|取扱日|日)\s*$/.test(h)),
      // 3列日付 (PayPay銀行: 操作日(年), 操作日(月), 操作日(日))
      dateY: header.findIndex((h) => /日.*[(\(].*年.*[)\)]|^年$/.test(h)),
      dateM: header.findIndex((h) => /日.*[(\(].*月.*[)\)]|^月$/.test(h)),
      dateD: header.findIndex((h) => /日.*[(\(].*日.*[)\)]|^日$/.test(h)),
      desc: header.findIndex((h) => /摘要|内容|お取引内容/.test(h)),
      out:  header.findIndex((h) => /引出|出金|支払金額|お支払|お引出|お引落/.test(h)),
      in:   header.findIndex((h) => /預入|入金|預り|お預入|お預り/.test(h)),
      bal:  header.findIndex((h) => /残高/.test(h)),
      memo: header.findIndex((h) => /メモ|備考/.test(h)),
    };
    const has3ColDate = idx.dateY >= 0 && idx.dateM >= 0 && idx.dateD >= 0;
    if ((idx.date < 0 && !has3ColDate) || (idx.out < 0 && idx.in < 0)) {
      return res.status(400).json({ error: `CSV ヘッダーを認識できません: ${header.join(", ")}` });
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = ginkoParseCsvLine(lines[i]);
      if (cols.length < 2) continue;
      // 日付: 1列モード or 3列モード
      let isoDate = null;
      if (has3ColDate) {
        const y = String(cols[idx.dateY] || "").trim();
        const m = String(cols[idx.dateM] || "").trim();
        const d = String(cols[idx.dateD] || "").trim();
        if (/^\d{4}$/.test(y) && /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d)) {
          isoDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        }
      } else {
        isoDate = ginkoNormalizeDate(cols[idx.date]);
      }
      if (!isoDate) continue;
      const desc = (cols[idx.desc] || "").trim();
      const memoText = idx.memo >= 0 ? (cols[idx.memo] || "").trim() : "";
      const out = idx.out >= 0 ? ginkoParseNum(cols[idx.out]) : 0;
      const inn = idx.in  >= 0 ? ginkoParseNum(cols[idx.in])  : 0;
      const type = inn > 0 ? "収入" : "支出";
      const amount = inn > 0 ? inn : out;
      if (amount === 0) continue;
      const cls = ginkoClassify(desc, type);
      rows.push({
        date: isoDate,
        type,
        category: cls.category,
        subcategory: cls.subcategory,
        amount,
        counterparty: cls.counterparty || desc.slice(0, 60),
        site: "",
        status: "確定",
        paymentMethod: "口座振替",
        memo: memoText ? `${desc} / ${memoText}` : desc,
        source: `銀行(${bank})`,
        refId: `bank:${bank}:${isoDate}:${type === "収入" ? "in" : "out"}:${amount}:${ginkoHash(desc)}`,
        include: true,    // フロントのチェックボックス初期値
        // 原文表示用 (フロントで参照)
        rawDesc: desc,
      });
    }
    res.json({ rows, count: rows.length });
  } catch (e) {
    console.error("[ginko] parse error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ───── 経理ダッシュボード (keiri ミニアプリ) ─────
// 「取引」タブを読んで月別 KPI / 現場別 / カテゴリ別 / 月次推移を返す。
// 5 分キャッシュ。連打しても Sheets API を叩きすぎない。
const keiriCache = { fetchedAt: 0, rows: [] };
const KEIRI_TTL = 5 * 60 * 1000;

async function fetchAllTransactions(force = false) {
  if (!force && Date.now() - keiriCache.fetchedAt < KEIRI_TTL && keiriCache.rows.length) {
    return keiriCache.rows;
  }
  const sheets = await getSheetsApi();
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: TX_SHEET_ID,
    range: `${TX_TAB}!A2:N`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  // 各行: [日付, 種別, 大分類, 小分類, 金額, 対象, 現場, 状態, 支払方法, メモ, 写真, ソース, 元ID, 登録日]
  const rows = (r.data.values || []).map((row) => ({
    date: String(row[0] || "").slice(0, 10),
    type: row[1] || "",
    category: row[2] || "",
    subcategory: row[3] || "",
    amount: Number(row[4]) || 0,
    counterparty: row[5] || "",
    site: row[6] || "",
    status: row[7] || "",
    paymentMethod: row[8] || "",
    memo: row[9] || "",
    source: row[11] || "",
    refId: row[12] || "",
    registeredAt: String(row[13] || "").slice(0, 10),
  })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (r.type === "収入" || r.type === "支出") && r.amount > 0);
  keiriCache.fetchedAt = Date.now();
  keiriCache.rows = rows;
  return rows;
}

function ymToDateBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = new Date(y, m, 1);   // m is 1-12, JS month is 0-11; passing m gives next month
  const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
  return { start, end };
}
function subMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function aggregateMonth(allRows, ym) {
  const { start, end } = ymToDateBounds(ym);
  const monthRows = allRows.filter((r) => r.date >= start && r.date < end);
  let revenue = 0, expense = 0;
  for (const r of monthRows) {
    if (r.type === "収入") revenue += r.amount;
    else if (r.type === "支出") expense += r.amount;
  }
  return { count: monthRows.length, revenue, expense, profit: revenue - expense, rows: monthRows };
}

// (大分類, 小分類, 摘要) → 経理の「会計カテゴリ」(税理士提出ベースの分類) を返す。
// 支出のみ。収入は null。
const ACCOUNTING_CATEGORIES = [
  "給料", "家賃", "車両費", "保険料", "ネット系", "接待交際費",
  "材料費", "外注費", "雑費", "未分類",
];
function accountingCategoryOf(tx) {
  if (tx.type !== "支出") return null;
  const sub = String(tx.subcategory || "").trim();
  const cat = String(tx.category || "").trim();
  const memo = String(tx.memo || "") + " " + String(tx.counterparty || "");
  if (sub === "未分類" || cat === "未分類" || !sub) return "未分類";
  // 給料・人件費
  if (/^(給料|給与|人件費|報酬)$/.test(sub)) return "給料";
  // 家賃・地代
  if (/^(家賃|地代|賃料|テナント料)$/.test(sub)) return "家賃";
  // 車両費・ガソリン・燃料
  if (/^(車両費|ガソリン|燃料|車両|車検|自動車税|車ローン|駐車場)$/.test(sub)) return "車両費";
  // 保険料
  if (/^(保険|保険料|社会保険|労災)$/.test(sub)) return "保険料";
  // ネット系・通信費・サブスク
  if (/^(web|通信費|通信|ネット|サブスク|サブスクリプション|月額サービス)$/.test(sub)
      || /chatgpt|adobe|google|indeed|lolipop|ロリポップ|googleworkspace|netflix|amazon prime/i.test(memo)) return "ネット系";
  // 接待交際費
  if (/接待|交際|会食|親睦|懇親/.test(sub) || /接待|交際|会食/.test(memo)) return "接待交際費";
  // 材料費
  if (/^(材料|材料費|建材|資材)$/.test(sub)) return "材料費";
  // 外注費
  if (/^(外注費|外注|業務委託)$/.test(sub)) return "外注費";
  return "雑費";  // 税金・光熱費・その他全部
}

// 「現場」フィールドの正規化: 空 → "YYYY-MM 共通" (固定費/経費等の非現場アロケート用)。
// その他は値そのまま。
function normalizeSiteForKeiri(site, dateIso) {
  if (site && String(site).trim()) return String(site).trim();
  const ym = (dateIso || "").slice(0, 7);
  return ym ? `${ym} 共通` : "(現場なし)";
}

// 年単位の集計 (経理ダッシュボード Phase 1 用)。
// 返り値: { year, yearTotal, months[12], sites[] }
//   months[i] = { month, revenue (工事+旅館), revenueConstruction, revenueRyokan,
//                 expense, profit, categories: { 給料: amount, 家賃: amount, ... } }
//   sites[]   = { site, revenue, expense, profit, categories: { 売上: amount, 外注費: amount, ... } }
app.get("/api/keiri/year", async (req, res) => {
  const year = String(req.query.year || "").trim();
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: "year (YYYY) required" });
  try {
    const all = await fetchAllTransactions(req.query.force === "1");
    const yearStart = `${year}-01-01`;
    const yearEnd = `${Number(year) + 1}-01-01`;
    const yearRows = all.filter((r) => r.date >= yearStart && r.date < yearEnd);

    // 年トータル
    let yRev = 0, yExp = 0;
    for (const r of yearRows) {
      if (r.type === "収入") yRev += r.amount;
      else if (r.type === "支出") yExp += r.amount;
    }

    // 月別 (1-12 月、全部初期化 → データなしの月は 0 になる)
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, "0");
      const empty = {};
      for (const c of ACCOUNTING_CATEGORIES) empty[c] = { amount: 0, count: 0 };
      return {
        month: `${year}-${m}`,
        revenue: 0, revenueConstruction: 0, revenueRyokan: 0,
        expense: 0, profit: 0, count: 0,
        categories: empty,
      };
    });
    for (const r of yearRows) {
      const mi = parseInt(r.date.slice(5, 7), 10) - 1;
      const mo = months[mi];
      mo.count++;
      if (r.type === "収入") {
        mo.revenue += r.amount;
        if (r.category === "工事") mo.revenueConstruction += r.amount;
        else if (r.category === "旅館") mo.revenueRyokan += r.amount;
      } else if (r.type === "支出") {
        mo.expense += r.amount;
        const ac = accountingCategoryOf(r);
        if (ac) {
          mo.categories[ac].amount += r.amount;
          mo.categories[ac].count++;
        }
      }
    }
    for (const m of months) m.profit = m.revenue - m.expense;

    // 現場別 (空現場は "YYYY-MM 共通" に正規化、年間でユニーク集約)
    const siteAgg = {};   // site -> { revenue, expense, sub categories }
    const SITE_CATEGORIES = ["売上", "外注費", "材料費", "車両費", "雑費"];
    for (const r of yearRows) {
      const site = normalizeSiteForKeiri(r.site, r.date);
      if (!siteAgg[site]) {
        const sc = {};
        for (const c of SITE_CATEGORIES) sc[c] = { amount: 0, count: 0 };
        siteAgg[site] = { site, revenue: 0, expense: 0, count: 0, categories: sc };
      }
      const s = siteAgg[site];
      s.count++;
      if (r.type === "収入") {
        s.revenue += r.amount;
        s.categories["売上"].amount += r.amount;
        s.categories["売上"].count++;
      } else if (r.type === "支出") {
        s.expense += r.amount;
        const sub = String(r.subcategory || "").trim();
        if (sub === "外注費" || sub === "外注") {
          s.categories["外注費"].amount += r.amount;
          s.categories["外注費"].count++;
        } else if (sub === "材料") {
          s.categories["材料費"].amount += r.amount;
          s.categories["材料費"].count++;
        } else if (sub === "車両費") {
          s.categories["車両費"].amount += r.amount;
          s.categories["車両費"].count++;
        } else {
          s.categories["雑費"].amount += r.amount;
          s.categories["雑費"].count++;
        }
      }
    }
    const sites = Object.values(siteAgg).map((s) => ({ ...s, profit: s.revenue - s.expense }))
      .sort((a, b) => (b.revenue + b.expense) - (a.revenue + a.expense));

    res.json({
      year,
      yearTotal: { revenue: yRev, expense: yExp, profit: yRev - yExp, count: yearRows.length },
      months,
      sites,
      accountingCategories: ACCOUNTING_CATEGORIES,
      siteCategories: SITE_CATEGORIES,
      cachedAt: new Date(keiriCache.fetchedAt).toISOString(),
    });
  } catch (e) {
    console.error("[keiri] year error:", e);
    res.status(500).json({ error: e.message });
  }
});

// 月詳細用の取引一覧: 会計カテゴリ指定で絞れるよう accountingCategory パラメータを追加。
// 既存の category/subcategory フィルタは残しつつ accountingCategory が優先。
function filterByAccountingCategory(rows, accountingCategory) {
  if (!accountingCategory) return rows;
  return rows.filter((r) => accountingCategoryOf(r) === accountingCategory);
}

app.get("/api/keiri/summary", async (req, res) => {
  const month = String(req.query.month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) required" });
  try {
    const all = await fetchAllTransactions(req.query.force === "1");
    const cur = aggregateMonth(all, month);
    const prev = aggregateMonth(all, subMonths(month, 1));

    // 現場別 (収入/支出/粗利、収入降順)
    const siteMap = {};
    for (const r of cur.rows) {
      const s = r.site || "(現場なし)";
      if (!siteMap[s]) siteMap[s] = { site: s, revenue: 0, expense: 0, count: 0 };
      if (r.type === "収入") siteMap[s].revenue += r.amount;
      else siteMap[s].expense += r.amount;
      siteMap[s].count++;
    }
    const bySite = Object.values(siteMap)
      .map((s) => ({ ...s, profit: s.revenue - s.expense }))
      .sort((a, b) => (b.revenue + b.expense) - (a.revenue + a.expense));

    // カテゴリ別支出 (大分類×小分類)
    const catMap = {};
    for (const r of cur.rows) {
      if (r.type !== "支出") continue;
      const key = `${r.category} ${r.subcategory}`;
      if (!catMap[key]) catMap[key] = { category: r.category, subcategory: r.subcategory, amount: 0, count: 0 };
      catMap[key].amount += r.amount;
      catMap[key].count++;
    }
    const byCategory = Object.values(catMap).sort((a, b) => b.amount - a.amount);

    // ソース別 (どのアプリ経由か)
    const srcMap = {};
    for (const r of cur.rows) {
      const s = r.source || "(なし)";
      if (!srcMap[s]) srcMap[s] = { source: s, count: 0, in: 0, out: 0 };
      srcMap[s].count++;
      if (r.type === "収入") srcMap[s].in += r.amount;
      else srcMap[s].out += r.amount;
    }
    const bySource = Object.values(srcMap).sort((a, b) => b.count - a.count);

    // 過去 12 ヶ月推移
    const trend = [];
    for (let i = 11; i >= 0; i--) {
      const m = subMonths(month, i);
      const agg = aggregateMonth(all, m);
      trend.push({ month: m, revenue: agg.revenue, expense: agg.expense, profit: agg.profit, count: agg.count });
    }

    res.json({
      month,
      kpi: { revenue: cur.revenue, expense: cur.expense, profit: cur.profit, count: cur.count },
      prevKpi: { revenue: prev.revenue, expense: prev.expense, profit: prev.profit, count: prev.count },
      bySite, byCategory, bySource, trend,
      cachedAt: new Date(keiriCache.fetchedAt).toISOString(),
    });
  } catch (e) {
    console.error("[keiri] summary error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/keiri/transactions", async (req, res) => {
  const month = String(req.query.month || "").trim();
  const year = String(req.query.year || "").trim();
  if (!/^\d{4}-\d{2}$/.test(month) && !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: "month=YYYY-MM か year=YYYY のどちらか必須" });
  }
  const site = String(req.query.site || "");
  const category = String(req.query.category || "");
  const subcategory = String(req.query.subcategory || "");
  const accountingCategory = String(req.query.accountingCategory || "");
  const type = String(req.query.type || "");
  try {
    const all = await fetchAllTransactions(req.query.force === "1");
    let dateStart, dateEnd;
    if (month) {
      const b = ymToDateBounds(month);
      dateStart = b.start; dateEnd = b.end;
    } else {
      dateStart = `${year}-01-01`;
      dateEnd = `${Number(year) + 1}-01-01`;
    }
    let rows = all.filter((r) => r.date >= dateStart && r.date < dateEnd)
      .filter((r) => !category || r.category === category)
      .filter((r) => !subcategory || r.subcategory === subcategory)
      .filter((r) => !type || r.type === type);
    // 現場フィルタ: "YYYY-MM 共通" は空現場として扱う
    if (site) {
      rows = rows.filter((r) => normalizeSiteForKeiri(r.site, r.date) === site);
    }
    // 会計カテゴリ (給料/家賃/...) フィルタ
    if (accountingCategory) {
      rows = rows.filter((r) => accountingCategoryOf(r) === accountingCategory);
    }
    rows.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ソース指定で「取引」タブから行を一括削除。誤削除防止のためソースは whitelist のみ受付。
// 実装は「全行 fetch → 対象行を除外 → タブをクリア → 残りを書き戻す」のシンプルな
// rebuild 方式 (deleteDimension を 1 行ずつ呼ぶより速い・原子的)。
app.post("/api/tx/delete-by-source", async (req, res) => {
  const body = req.body || {};
  const source = String(body.source || "").trim();
  const month = String(body.month || "").trim();  // optional "YYYY-MM"
  // 削除可能なソース。誤削除事故を避けるため明示的 whitelist。
  // - 銀行系 / test / 手動 / ginko: 月指定不要 (全削除可)
  // - 固定費: 月指定必須 (毎月送信するので、月を絞らないと全部消えて事故る)
  const ALLOWED_PREFIXES = ["銀行(", "test", "手動", "ginko", "固定費"];
  const NEEDS_MONTH = ["固定費"];   // 全削除を許可しないソース
  const allowed = ALLOWED_PREFIXES.some((p) => source.startsWith(p));
  if (!allowed) {
    return res.status(400).json({ error: `削除不可のソース: "${source}" (whitelist 外)` });
  }
  const needsMonth = NEEDS_MONTH.some((p) => source.startsWith(p));
  if (needsMonth && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: `source="${source}" は month=YYYY-MM の指定が必要` });
  }
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: `month は YYYY-MM 形式` });
  }
  try {
    const sheets = await getSheetsApi();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: TX_SHEET_ID,
      range: `${TX_TAB}!A2:N`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const allRows = r.data.values || [];
    // 日付列 = A = index 0, ソース列 = L = index 11
    const matches = (row) => {
      if (String(row[11] || "") !== source) return false;
      if (month && !String(row[0] || "").startsWith(month)) return false;
      return true;
    };
    const keep = allRows.filter((row) => !matches(row));
    const deleted = allRows.length - keep.length;
    if (deleted === 0) return res.json({ deleted: 0, kept: keep.length, source, month: month || null });

    // データ範囲を一旦クリア → 残行を書き戻し (絶対範囲指定で SUMIFS / QUERY は不変)
    await sheets.spreadsheets.values.clear({
      spreadsheetId: TX_SHEET_ID,
      range: `${TX_TAB}!A2:N`,
    });
    if (keep.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: TX_SHEET_ID,
        range: `${TX_TAB}!A2:N`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: keep },
      });
    }
    // keiri のキャッシュを無効化 (次の summary 呼び出しで再取得)
    keiriCache.fetchedAt = 0;
    keiriCache.rows = [];
    // tx 二重投入防止キャッシュもクリア (削除した refId を再投入可能にするため)
    txSeenRefIds.clear();
    console.log(`[tx] deleted ${deleted} rows for source="${source}"${month ? " month=" + month : ""}, ${keep.length} kept`);
    res.json({ deleted, kept: keep.length, source, month: month || null });
  } catch (e) {
    console.error("[tx] delete-by-source error:", e);
    res.status(500).json({ error: e.message });
  }
});
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

// 既存の Cloud SQL タスクを Firestore に 1 回限り移行 (idempotent: 同じ id で
// merge:true 書き込みなので何回叩いても上書きされるだけ)。フロントが Firestore 化
// 後に「📥 移行」ボタンから呼ぶ。SQL 側は当面残す (バックアップ用、後で削除可)。
app.post("/api/tasks/migrate-to-firestore", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "db not configured" });
  await ensureSchema();
  try {
    const { rows } = await p.query("SELECT * FROM tasks ORDER BY created_at ASC");
    const fs = admin.firestore();
    let migrated = 0;
    for (const row of rows) {
      const deadline = row.deadline
        ? (row.deadline instanceof Date ? row.deadline.toISOString().slice(0, 10) : String(row.deadline).slice(0, 10))
        : null;
      await fs.collection("tasks").doc(row.id).set({
        title: row.title || "",
        fromEmail: (row.from_email || "").toLowerCase(),
        toEmail: (row.to_email || "").toLowerCase(),
        priority: Number(row.priority) || 2,
        deadline,
        status: row.status || "active",
        site: "",                                 // 既存は雑務扱いで初期化、後でユーザーが移動
        createdAt: row.created_at || new Date(),
        updatedAt: row.updated_at || new Date(),
      }, { merge: true });
      migrated++;
    }
    res.json({ ok: true, migrated, totalInSql: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───── 宿 (yado): 満竹華庵の Beds24 予約 + AI戦略 ─────
// Beds24 v2 API は token をヘッダで渡すだけのシンプル設計。トークン未設定なら
// sample 表示用のフラグを返してフロントが自前のサンプルを描く。
// env 名は MANCHIKAN_BEDS_KEY (新) を優先、BEDS24_API_TOKEN (旧) も互換で受ける。
// プロパティ ID も任意で渡せる (複数物件持つ場合に絞り込み)。
const BEDS24_API_TOKEN = (process.env.MANCHIKAN_BEDS_KEY || process.env.BEDS24_API_TOKEN || "").trim();
const MANCHIKAN_PROP_ID = (process.env.MANCHIKAN_PROP_ID || "").trim();
const BEDS24_BASE = "https://beds24.com/api/v2";

// 満竹華庵の施設プロフィール (AI 戦略 prompt 用、平文で OK)。
// 出典: https://manchikan.tokyo/ + Beds24 上の現運用情報。
// 公式サイトは情報やや古めの可能性あり (ベッド数・最大人数等)。
const MANCHIKAN_PROFILE = `
- 名称: 満竹華庵 (まんちかん)
- 所在地: 東京都江戸川区松島4丁目21-14
- アクセス: JR新小岩駅 徒歩10分 / 羽田空港 約65分 / 成田空港 約80分 (インバウンド動線上)
- エリア: 江戸川区下町、新小岩 (商店街・ラーメン名店多数、観光地より穴場志向)
- 形態: 古民家改装の一棟貸し (Beds24 上は「3ベッドルーム アパートメント」表記)
- 構成: 2 階建て約 56㎡ (1F 32㎡ / 2F 24㎡)
- 寝具 (公式): ダブルベッド 2 台 + 布団 4 セット
  ※ 公式サイト記載は古い可能性。Beds24 現運用は最大宿泊 9-11 名で運用中 (布団追加済の可能性)
- 設備: 室内檜風呂、エアコン、畳の間、ダイニング、フラットスクリーン TV、電気ケトル
- アメニティ: ドライヤー、浴衣、基礎化粧品、歯ブラシ、バスタオル
- ルール: 全室禁煙、ペット不可、駐車場なし、温浴のみ利用不可、食事提供なし
- コンセプト: 喧騒から離れた静寂、侘び寂び × 現代感性、下町古民家滞在
- ターゲット: グループ・ファミリー (定員大)、インバウンド主体
- 現掲載チャネル: Booking.com (genius rate 適用) / Airbnb (host fee 適用) / 自社直販なし
`.trim();

// bookings 配列から戦略 prompt 用の集計値を導出
function buildYadoMetrics(bookings) {
  const total = bookings.length;
  const totalGross = bookings.reduce((s, b) => s + (b.price || 0), 0);
  const totalCommission = bookings.reduce((s, b) => s + (b.commission || 0), 0);
  const totalNet = bookings.reduce((s, b) => s + (b.net || 0), 0);
  const totalNights = bookings.reduce((s, b) => s + (b.nights || 0), 0);
  const totalGuests = bookings.reduce((s, b) => s + (b.adult || 0) + (b.child || 0), 0);
  const adrGross = totalNights ? Math.round(totalGross / totalNights) : 0;
  const adrNet = totalNights ? Math.round(totalNet / totalNights) : 0;
  const netRate = totalGross ? Math.round(totalNet / totalGross * 1000) / 10 : 0;

  // チャネル別
  const byChannel = {};
  for (const b of bookings) {
    const c = b.channel || "other";
    if (!byChannel[c]) byChannel[c] = { gross: 0, commission: 0, net: 0, count: 0, nights: 0 };
    byChannel[c].gross += b.price || 0;
    byChannel[c].commission += b.commission || 0;
    byChannel[c].net += b.net || 0;
    byChannel[c].count += 1;
    byChannel[c].nights += b.nights || 0;
  }

  // 国別
  const countries = {};
  for (const b of bookings) {
    const c = (b.country || "??").toUpperCase() || "??";
    countries[c] = (countries[c] || 0) + 1;
  }

  // リードタイム分布 (0-3, 4-14, 15-30, 31-60, 61-90, 90+ 日)
  const lead = { d0_3: 0, d4_14: 0, d15_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, unknown: 0 };
  const leadDaysList = [];
  for (const b of bookings) {
    const l = b.leadDays;
    if (l == null) { lead.unknown++; continue; }
    leadDaysList.push(l);
    if (l <= 3) lead.d0_3++;
    else if (l <= 14) lead.d4_14++;
    else if (l <= 30) lead.d15_30++;
    else if (l <= 60) lead.d31_60++;
    else if (l <= 90) lead.d61_90++;
    else lead.d90plus++;
  }
  const avgLeadDays = leadDaysList.length
    ? Math.round(leadDaysList.reduce((s, x) => s + x, 0) / leadDaysList.length)
    : null;

  // 曜日別 ADR (各予約の price/nights を泊まる各曜日に分配して平均)
  const dowSum = [0,0,0,0,0,0,0];
  const dowN = [0,0,0,0,0,0,0];
  for (const b of bookings) {
    if (!b.arrival || !b.nights || !b.price) continue;
    const perNight = b.price / b.nights;
    const dt = new Date(b.arrival);
    for (let i = 0; i < b.nights; i++) {
      dowSum[dt.getDay()] += perNight;
      dowN[dt.getDay()] += 1;
      dt.setDate(dt.getDate() + 1);
    }
  }
  const adrByDow = dowSum.map((s, i) => dowN[i] ? Math.round(s / dowN[i]) : 0);

  return {
    total, totalGross, totalCommission, totalNet, totalNights, totalGuests,
    adrGross, adrNet, netRate,
    avgNights: total ? Math.round(totalNights / total * 10) / 10 : 0,
    avgGuests: total ? Math.round(totalGuests / total * 10) / 10 : 0,
    avgLeadDays,
    byChannel, countries, lead, adrByDow,
  };
}

// referer → 内部チャネルラベル (フロント側 normalizeChannel と同じ規則)。
function normalizeYadoChannel(referer) {
  const s = (referer || "").toLowerCase();
  if (s.includes("airbnb")) return "airbnb";
  if (s.includes("booking")) return "booking";
  if (s.includes("direct") || s.includes("website") || s.includes("自社") || s.includes("manual")) return "direct";
  return "other";
}

// Beds24 v2 の生 booking レコード → アプリ標準形 (DB 列名と整合)。
function mapBeds24Booking(b) {
  const arrival = (b.arrival || "").slice(0, 10);
  const departure = (b.departure || "").slice(0, 10);
  const nights = arrival && departure
    ? Math.round((new Date(departure) - new Date(arrival)) / 86400000)
    : 1;
  const referer = b.referer || b.apiSourceReferer || b.bookingSource || "";
  return {
    id: Number(b.id || b.bookId || 0),
    property_id: Number(b.propertyId) || null,
    arrival, departure, nights,
    channel: normalizeYadoChannel(referer),
    referer,
    status: b.status || "",
    price: Math.round(Number(b.price) || 0),
    commission: Math.round(Number(b.commission) || 0),
    num_adult: Number(b.numAdult) || 0,
    num_child: Number(b.numChild) || 0,
    country: (b.country2 || b.country || "").toUpperCase() || null,
    guest_name: [b.lastName, b.firstName].filter(Boolean).join(" ") || b.guestName || null,
    booking_time: b.bookingTime || null,
    modified_time: b.modifiedTime || b.bookingTime || new Date().toISOString(),
  };
}

// Beds24 v2 ページング取得: nextPageLink を辿って全件回収。
// modifiedFrom 指定なら「その時刻以降に変更されたもの」、arrivalFrom/arrivalTo 指定なら
// 「到着日が範囲内のもの」。両方指定可。
async function fetchBeds24All({ modifiedFrom, arrivalFrom, arrivalTo, maxPages = 50 } = {}) {
  if (!BEDS24_API_TOKEN) throw new Error("BEDS24 token not set");
  const params = new URLSearchParams({ includeInvoiceItems: "false" });
  if (arrivalFrom) params.set("arrivalFrom", arrivalFrom);
  if (arrivalTo) params.set("arrivalTo", arrivalTo);
  if (modifiedFrom) params.set("modifiedFrom", modifiedFrom);
  if (MANCHIKAN_PROP_ID) params.set("propertyId", MANCHIKAN_PROP_ID);
  let url = `${BEDS24_BASE}/bookings?${params}`;
  const all = [];
  for (let i = 0; i < maxPages; i++) {
    const r = await fetch(url, { headers: { token: BEDS24_API_TOKEN, accept: "application/json" } });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`beds24 ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    const data = Array.isArray(j) ? j : (j.data || j.bookings || []);
    all.push(...data);
    const next = j?.pages?.nextPageLink;
    if (!next) break;
    url = next;
  }
  return all;
}

// yado_bookings に upsert (id 衝突で UPDATE)。返り値: { upserted, latestModified }
async function upsertYadoBookings(rawRows) {
  const p = getPool();
  if (!p) throw new Error("DB not configured");
  await ensureSchema();
  let upserted = 0;
  let latestModified = null;
  for (const raw of rawRows) {
    const m = mapBeds24Booking(raw);
    if (!m.id || !m.arrival || !m.departure) continue;  // 不完全データはスキップ
    if (!latestModified || m.modified_time > latestModified) latestModified = m.modified_time;
    await p.query(`
      INSERT INTO yado_bookings (id, property_id, arrival, departure, nights, channel, referer,
        status, price, commission, num_adult, num_child, country, guest_name, booking_time,
        modified_time, raw_json, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
      ON CONFLICT (id) DO UPDATE SET
        property_id = EXCLUDED.property_id, arrival = EXCLUDED.arrival,
        departure = EXCLUDED.departure, nights = EXCLUDED.nights,
        channel = EXCLUDED.channel, referer = EXCLUDED.referer, status = EXCLUDED.status,
        price = EXCLUDED.price, commission = EXCLUDED.commission,
        num_adult = EXCLUDED.num_adult, num_child = EXCLUDED.num_child,
        country = EXCLUDED.country, guest_name = EXCLUDED.guest_name,
        booking_time = EXCLUDED.booking_time, modified_time = EXCLUDED.modified_time,
        raw_json = EXCLUDED.raw_json, synced_at = now()
    `, [
      m.id, m.property_id, m.arrival, m.departure, m.nights, m.channel, m.referer,
      m.status, m.price, m.commission, m.num_adult, m.num_child, m.country, m.guest_name,
      m.booking_time, m.modified_time, JSON.stringify(raw),
    ]);
    upserted++;
  }
  return { upserted, latestModified };
}

async function getYadoMeta(key) {
  const p = getPool();
  if (!p) return null;
  await ensureSchema();
  const r = await p.query("SELECT value FROM yado_meta WHERE key = $1", [key]);
  return r.rows[0]?.value || null;
}
async function setYadoMeta(key, value) {
  const p = getPool();
  if (!p) return;
  await ensureSchema();
  await p.query(`
    INSERT INTO yado_meta (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `, [key, value]);
}

// DB レコード → フロントが期待する形 (price/commission/net/leadDays/country/guestName)。
// raw_json の中から「詳細パネルで見たい運用情報」だけ抜き出して同梱。
// PII (email/phone/address) は出さない方針 (画面共有時のリスク回避)。
function rowToFrontend(row) {
  const price = row.price || 0;
  const commission = row.commission || 0;
  const bookedAt = row.booking_time ? new Date(row.booking_time).getTime() : null;
  const arrivedAt = row.arrival ? new Date(row.arrival).getTime() : null;
  const leadDays = (bookedAt && arrivedAt)
    ? Math.max(0, Math.floor((arrivedAt - bookedAt) / 86400000))
    : null;
  const raw = row.raw_json || {};
  return {
    id: String(row.id),
    arrival: row.arrival instanceof Date ? row.arrival.toISOString().slice(0, 10) : (row.arrival || "").slice(0, 10),
    departure: row.departure instanceof Date ? row.departure.toISOString().slice(0, 10) : (row.departure || "").slice(0, 10),
    nights: row.nights || 0,
    referer: row.referer || "",
    channel: row.channel || "other",
    price, commission,
    net: Math.max(0, price - commission),
    leadDays,
    country: row.country || "",
    adult: row.num_adult || 0,
    child: row.num_child || 0,
    guestName: row.guest_name || "",
    status: row.status || "",
    // 詳細パネル用 (非 PII のみ)
    bookingTime: row.booking_time ? new Date(row.booking_time).toISOString() : null,
    lang: raw.lang || "",
    flagText: raw.flagText || "",
    apiReference: raw.apiReference || "",
    comments: raw.comments || "",
    rateDescription: raw.rateDescription || "",
    apiMessage: raw.apiMessage || "",
  };
}

// 指定範囲 (arrival 期間とオーバーラップする予約) を SQL から取得。
async function queryYadoBookingsInRange(from, to) {
  const p = getPool();
  if (!p) return [];
  await ensureSchema();
  // 月跨ぎ予約も拾うので departure > from AND arrival < to の overlap 判定
  const r = await p.query(`
    SELECT * FROM yado_bookings
    WHERE departure > $1::date AND arrival < $2::date
      AND status != 'cancelled'
    ORDER BY arrival ASC
  `, [from, to]);
  return r.rows.map(rowToFrontend);
}

// 過去 N ヶ月分の月次サマリ (戦略 prompt の YoY 比較等で使用)。
async function getYadoMonthlySummary(monthsBack = 12) {
  const p = getPool();
  if (!p) return [];
  await ensureSchema();
  const r = await p.query(`
    SELECT
      to_char(arrival, 'YYYY-MM') AS month,
      COUNT(*)::int               AS bookings,
      SUM(nights)::int             AS total_nights,
      SUM(price)::int              AS gross,
      SUM(commission)::int         AS commission,
      SUM(price - commission)::int AS net,
      ROUND(AVG(price)::numeric, 0)::int AS avg_price
    FROM yado_bookings
    WHERE arrival >= (date_trunc('month', now()) - ($1::int || ' months')::interval)::date
      AND status != 'cancelled'
    GROUP BY month
    ORDER BY month ASC
  `, [monthsBack]);
  return r.rows;
}

// 過去 N ヶ月の全予約を取得 (戦略 prompt の集計用、24 ヶ月で数百件想定)
async function getYadoBookingsLastNMonths(monthsBack = 24) {
  const p = getPool();
  if (!p) return [];
  await ensureSchema();
  const r = await p.query(`
    SELECT * FROM yado_bookings
    WHERE arrival >= (date_trunc('month', now()) - ($1::int || ' months')::interval)::date
    ORDER BY arrival ASC
  `, [monthsBack]);
  return r.rows.map(rowToFrontend);
}

// 対象月の予約 (overlap 判定込み) を取得
async function getYadoBookingsForMonth(yyyymm) {
  const p = getPool();
  if (!p) return [];
  await ensureSchema();
  // yyyymm = "2026-06" の場合 → 月初〜翌月初の半開区間で overlap
  const r = await p.query(`
    SELECT * FROM yado_bookings
    WHERE departure > ($1 || '-01')::date
      AND arrival < (($1 || '-01')::date + interval '1 month')::date
      AND status != 'cancelled'
    ORDER BY arrival ASC
  `, [yyyymm]);
  return r.rows.map(rowToFrontend);
}

// 集計ヘルパー (rowToFrontend 形を入れ込んで諸統計を返す)
function summarizeYadoBookings(bookings) {
  if (!bookings.length) return null;
  const total = bookings.length;
  const gross = bookings.reduce((s, b) => s + (b.price || 0), 0);
  const commission = bookings.reduce((s, b) => s + (b.commission || 0), 0);
  const net = gross - commission;
  const nights = bookings.reduce((s, b) => s + (b.nights || 0), 0);
  const guests = bookings.reduce((s, b) => s + (b.adult || 0) + (b.child || 0), 0);
  return {
    total, gross, commission, net, nights, guests,
    adrGross: nights ? Math.round(gross / nights) : 0,
    adrNet: nights ? Math.round(net / nights) : 0,
    netRate: gross ? Math.round(net / gross * 1000) / 10 : 0,
  };
}

// 全期間の曜日別 ADR (sample 数が多くて信頼できる)
function dowAdrAllTime(bookings) {
  const sum = [0,0,0,0,0,0,0];
  const cnt = [0,0,0,0,0,0,0];
  for (const b of bookings) {
    if (!b.arrival || !b.nights || !b.price) continue;
    const per = b.price / b.nights;
    const dt = new Date(b.arrival);
    for (let i = 0; i < b.nights; i++) {
      sum[dt.getDay()] += per;
      cnt[dt.getDay()] += 1;
      dt.setDate(dt.getDate() + 1);
    }
  }
  return sum.map((s, i) => cnt[i] ? Math.round(s / cnt[i]) : 0);
}

// 国別 (件数 + gross 売上 + シェア%) ranking
function countryRanking(bookings, topN = 12) {
  const m = new Map();
  let totalCount = 0, totalGross = 0;
  for (const b of bookings) {
    const cc = (b.country || "??").toUpperCase() || "??";
    const cur = m.get(cc) || { count: 0, gross: 0 };
    cur.count += 1;
    cur.gross += b.price || 0;
    m.set(cc, cur);
    totalCount += 1;
    totalGross += b.price || 0;
  }
  const arr = [...m.entries()].map(([cc, v]) => ({
    cc, count: v.count, gross: v.gross,
    countShare: totalCount ? Math.round(v.count / totalCount * 1000) / 10 : 0,
    grossShare: totalGross ? Math.round(v.gross / totalGross * 1000) / 10 : 0,
  }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, topN);
}

// リードタイム分布
function leadHistogram(bookings) {
  const h = { d0_3: 0, d4_14: 0, d15_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, unknown: 0 };
  const ls = [];
  for (const b of bookings) {
    const l = b.leadDays;
    if (l == null) { h.unknown++; continue; }
    ls.push(l);
    if (l <= 3) h.d0_3++;
    else if (l <= 14) h.d4_14++;
    else if (l <= 30) h.d15_30++;
    else if (l <= 60) h.d31_60++;
    else if (l <= 90) h.d61_90++;
    else h.d90plus++;
  }
  const sorted = ls.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const avg = ls.length ? Math.round(ls.reduce((a, b) => a + b, 0) / ls.length) : null;
  return { hist: h, median, avg };
}

// チャネル別の集計 + 前月比トレンド
function channelSummary(bookings) {
  const m = {};
  for (const b of bookings) {
    const c = b.channel || "other";
    if (!m[c]) m[c] = { count: 0, gross: 0, commission: 0, net: 0, nights: 0 };
    m[c].count += 1;
    m[c].gross += b.price || 0;
    m[c].commission += b.commission || 0;
    m[c].net += b.net || 0;
    m[c].nights += b.nights || 0;
  }
  // share %
  const totalCount = bookings.length || 1;
  const totalGross = bookings.reduce((s, b) => s + (b.price || 0), 0) || 1;
  for (const c of Object.keys(m)) {
    m[c].countShare = Math.round(m[c].count / totalCount * 1000) / 10;
    m[c].grossShare = Math.round(m[c].gross / totalGross * 1000) / 10;
    m[c].netRate = m[c].gross ? Math.round(m[c].net / m[c].gross * 1000) / 10 : 0;
    m[c].adr = m[c].nights ? Math.round(m[c].gross / m[c].nights) : 0;
  }
  return m;
}

// キャンセル件数 (status = cancelled) のカウント (* 入れて取り直す)
async function getYadoCancellationStats(monthsBack = 12) {
  const p = getPool();
  if (!p) return { cancelled: 0, total: 0 };
  await ensureSchema();
  const r = await p.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
      COUNT(*)::int AS total
    FROM yado_bookings
    WHERE arrival >= (date_trunc('month', now()) - ($1::int || ' months')::interval)::date
  `, [monthsBack]);
  return r.rows[0] || { cancelled: 0, total: 0 };
}

// /api/yado/bookings: SQL から取得 (Beds24 直叩きやめ、ローカルキャッシュ経由)
app.get("/api/yado/bookings", async (req, res) => {
  const from = String(req.query.from || "").slice(0, 10);
  const to = String(req.query.to || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "from/to (YYYY-MM-DD) required" });
  }
  try {
    const bookings = await queryYadoBookingsInRange(from, to);
    // SQL 空 (まだバックフィル前) で Beds24 設定済なら、その旨を返す。
    // 完全 sample モード (BEDS24 未設定) との区別を付ける。
    if (bookings.length === 0) {
      if (!BEDS24_API_TOKEN) return res.json({ sample: true, bookings: [] });
      return res.json({ bookings: [], needsBackfill: true });
    }
    res.json({ bookings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/yado/backfill: 指定範囲を Beds24 から全件取得して SQL に upsert (Firebase auth)。
// 初回や、欠損があった時に手動で叩く想定。差分同期では拾えない範囲も埋める。
app.post("/api/yado/backfill", async (req, res) => {
  if (!BEDS24_API_TOKEN) return res.status(503).json({ error: "MANCHIKAN_BEDS_KEY not set" });
  const from = String(req.body?.from || req.query.from || "2020-01-01").slice(0, 10);
  const to = String(req.body?.to || req.query.to || "2035-12-31").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "from/to (YYYY-MM-DD) required" });
  }
  try {
    const raw = await fetchBeds24All({ arrivalFrom: from, arrivalTo: to });
    const { upserted, latestModified } = await upsertYadoBookings(raw);
    if (latestModified) {
      const cur = await getYadoMeta("last_sync_modified");
      if (!cur || latestModified > cur) await setYadoMeta("last_sync_modified", latestModified);
    }
    res.json({ ok: true, fetched: raw.length, upserted, from, to, latestModified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/yado/refresh: ワンタップ同期 (Firebase auth)。
// last_sync_modified が無ければ全期間バックフィル、あれば差分同期。フロントの
// 「🔄 同期」ボタンから叩く想定。Cloud Scheduler 使わなくてもこれだけで完結。
// (既存の /api/yado/sync は別目的 (取引シート同期) なので名前を分けてある)
app.post("/api/yado/refresh", async (req, res) => {
  if (!BEDS24_API_TOKEN) return res.status(503).json({ error: "MANCHIKAN_BEDS_KEY not set" });
  try {
    const lastSync = await getYadoMeta("last_sync_modified");
    let raw, kind;
    if (lastSync) {
      // 差分: 前回の最新 modifiedTime 以降
      raw = await fetchBeds24All({ modifiedFrom: lastSync });
      kind = "diff";
    } else {
      // 初回: 過去 5 年〜未来 5 年を arrival ベースで全部
      const y = new Date().getFullYear();
      raw = await fetchBeds24All({ arrivalFrom: `${y - 5}-01-01`, arrivalTo: `${y + 5}-12-31` });
      kind = "backfill";
    }
    const { upserted, latestModified } = await upsertYadoBookings(raw);
    if (latestModified && (!lastSync || latestModified > lastSync)) {
      await setYadoMeta("last_sync_modified", latestModified);
    }
    res.json({ ok: true, kind, fetched: raw.length, upserted, latestModified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /api/internal/yado/sync-bookings: 差分同期 (Cloud Scheduler が日次で叩く場合用、任意)。
// 認証は INTERNAL_TICK_SECRET ヘッダ (kaigi と同方式、auth middleware の /internal 分岐で済む)。
// last_sync_modified 以降に変更された予約 (= 新規 + 変更 + キャンセル) を全部拾う。
app.post("/api/internal/yado/sync-bookings", async (req, res) => {
  if (!BEDS24_API_TOKEN) return res.status(503).json({ error: "MANCHIKAN_BEDS_KEY not set" });
  try {
    let modifiedFrom = await getYadoMeta("last_sync_modified");
    // 初回 (meta 無し) は 30 日前から。バックフィル併用想定。
    if (!modifiedFrom) {
      modifiedFrom = new Date(Date.now() - 30 * 86400000).toISOString();
    }
    const raw = await fetchBeds24All({ modifiedFrom });
    const { upserted, latestModified } = await upsertYadoBookings(raw);
    if (latestModified && latestModified > modifiedFrom) {
      await setYadoMeta("last_sync_modified", latestModified);
    }
    res.json({ ok: true, fetched: raw.length, upserted, modifiedFrom, latestModified });
  } catch (e) {
    console.error("[yado-sync]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/yado/strategy", async (req, res) => {
  if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
  const { month, reviews = {} } = req.body || {};
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) required" });

  const today = new Date().toISOString().slice(0, 10);
  const yen = (n) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

  // ───── DB から全部引く (フロント payload には依存しない) ─────
  let targetMonth = [], last24 = [], monthlySummary = [], cancelStats = { cancelled: 0, total: 0 };
  try {
    [targetMonth, last24, monthlySummary, cancelStats] = await Promise.all([
      getYadoBookingsForMonth(month),
      getYadoBookingsLastNMonths(24),
      getYadoMonthlySummary(12),
      getYadoCancellationStats(12),
    ]);
  } catch (e) {
    return res.status(500).json({ error: "DB query failed: " + e.message });
  }

  // 対象月の集計 (KPI)
  const TM = summarizeYadoBookings(targetMonth) || { total:0, gross:0, commission:0, net:0, nights:0, guests:0, adrGross:0, adrNet:0, netRate:0 };
  // 部屋数 = 1 で固定 (満竹華庵は一棟貸し)。対象月の日数で稼働率算出。
  const [Y, M_] = month.split("-").map(Number);
  const daysInMonth = new Date(Y, M_, 0).getDate();
  const occupancyPct = Math.round(TM.nights / daysInMonth * 100);

  // 前年同月との比較 (= YoY)
  const prevYearMonth = `${Y - 1}-${String(M_).padStart(2, "0")}`;
  const lastYear = last24.filter((b) => {
    const ai = new Date(b.arrival), de = new Date(b.departure);
    const ms = new Date(Y - 1, M_ - 1, 1), me = new Date(Y - 1, M_, 1);
    return de > ms && ai < me;
  });
  const LY = summarizeYadoBookings(lastYear);
  const yoyLine = LY
    ? `${prevYearMonth}: ${LY.total}件 / ${LY.nights}泊 / gross ${yen(LY.gross)} / net ${yen(LY.net)} / ADR ${yen(LY.adrGross)} / 稼働率 ${Math.round(LY.nights / new Date(Y - 1, M_, 0).getDate() * 100)}%`
    : "(前年同月データなし)";

  // 全期間 (24 ヶ月) の信頼性高い曜日別 ADR
  const dowLabels = ["日","月","火","水","木","金","土"];
  const dowAdr = dowAdrAllTime(last24);
  const adrByDowStr = dowLabels.map((d, i) => `${d}${yen(dowAdr[i])}`).join(" / ");

  // 過去 12 ヶ月での「ターゲット国上位」「リードタイム傾向」「チャネル mix」
  const last12 = last24.filter((b) => {
    const m = b.arrival.slice(0, 7);
    return m >= `${Y}-${String(M_).padStart(2, "0")}` || m.localeCompare(`${Y - 1}-${String(M_).padStart(2, "0")}`) >= 0;
  });
  const countries = countryRanking(last12, 10);
  const countriesStr = countries.length
    ? countries.map((c) => `${c.cc}: ${c.count}件 (${c.countShare}%) / 売上 ${yen(c.gross)} (${c.grossShare}%)`).join("\n  ")
    : "(データなし)";
  const lead = leadHistogram(last12);
  const channels = channelSummary(last12);
  const channelsStr = Object.entries(channels)
    .map(([c, v]) => `${c}: ${v.count}件 (${v.countShare}%) / gross ${yen(v.gross)} / net ${yen(v.net)} / 手取り率 ${v.netRate}% / ADR ${yen(v.adr)}`)
    .join("\n  ");

  // 月次推移サマリ
  const monthlySummaryStr = monthlySummary.length
    ? monthlySummary.map((m) => {
        const adr = m.total_nights ? Math.round(m.gross / m.total_nights) : 0;
        return `${m.month}: ${m.bookings}件 / ${m.total_nights}泊 / gross ${yen(m.gross)} / net ${yen(m.net)} / ADR ${yen(adr)}`;
      }).join("\n  ")
    : "(過去データなし)";

  const cancelRate = cancelStats.total ? Math.round(cancelStats.cancelled / cancelStats.total * 1000) / 10 : 0;

  // 対象月の予約 (compact、PII 抜き) を AI へ
  const compact = targetMonth.map((b) => ({
    arr: b.arrival, dep: b.departure, ch: b.channel, n: b.nights,
    p: b.price, com: b.commission, net: b.net, lead: b.leadDays,
    cc: b.country, a: b.adult, c: b.child,
  }));

  // 貼り付けレビュー
  const trim = (s, n) => String(s || "").slice(0, n);
  const reviewBlock = (() => {
    const parts = [];
    if (reviews.airbnb)  parts.push(`[Airbnb のゲストレビュー]\n${trim(reviews.airbnb, 4000)}`);
    if (reviews.booking) parts.push(`[Booking.com のゲストレビュー]\n${trim(reviews.booking, 4000)}`);
    if (reviews.other)   parts.push(`[その他のレビュー / 口頭の声]\n${trim(reviews.other, 4000)}`);
    return parts.length ? `\n\n【貼り付けられたゲストレビュー (生データ)】\n${parts.join("\n\n")}` : "";
  })();

  const prompt = `あなたは満竹華庵 (江戸川区新小岩の一棟貸し古民家・インバウンド民泊) の経営アドバイザーです。
データは DB に保持された実績ベース。憶測でなく数字を引いて語ってください。

【施設プロフィール】
${MANCHIKAN_PROFILE}

【今日】${today} / 【対象月】${month} (月日数: ${daysInMonth})

【対象月の実績】
  - 予約: ${TM.total} 件 / 泊数: ${TM.nights} 泊 / 客延: ${TM.guests} 名
  - gross ${yen(TM.gross)} / 手数料 ${yen(TM.commission)} / net ${yen(TM.net)} (手取り率 ${TM.netRate}%)
  - ADR: gross ${yen(TM.adrGross)} / net ${yen(TM.adrNet)}
  - 稼働率: ${occupancyPct}% (定員 1 室 × ${daysInMonth} 日)
【前年同月比 (YoY)】
  ${prevYearMonth} (前年): ${yoyLine}
  → AI 自身が件数 / 売上 / ADR / 稼働率 の差分を計算して言及してください

【過去 12 ヶ月の月次推移】
  ${monthlySummaryStr}

【過去 12 ヶ月のチャネル別】
  ${channelsStr}
  (手取り率比較: Booking は commission ≈17-18%、Airbnb は host fee ≈15.5%、自社直販は手取り 100%)

【過去 12 ヶ月の国別 (件数上位 10)】
  ${countriesStr}

【過去 12 ヶ月のリードタイム】
  分布: ${JSON.stringify(lead.hist)} (中央値 ${lead.median ?? "—"} 日 / 平均 ${lead.avg ?? "—"} 日)

【全期間 (24 ヶ月) の曜日別 ADR】
  ${adrByDowStr}
  → サンプル数が多いので「金土プレミアムが効いてるか」「水木が安すぎないか」をこっちで判断

【キャンセル率 (過去 12 ヶ月)】 ${cancelStats.cancelled}/${cancelStats.total} (${cancelRate}%)

【対象月の予約一覧 (${compact.length} 件、PII 抜き)】
${JSON.stringify(compact)}${reviewBlock}

以下の流れで戦略を立ててください。Google 検索で当月の最新情報も取り入れて:

1. **対象月の現状診断** (YoY と過去推移を踏まえて、何が良くて何が悪いか)
2. **季節要因** (対象月の日本観光トレンド・連休・気候・インバウンド動向)
3. **周辺市場** (新小岩〜江戸川区下町の一棟貸し民泊の Airbnb / Booking.com 競合価格帯、近隣観光資源)
4. **円相場・世情** (ターゲット国のアウトバウンド動向)
5. **データから言えるパターン**:
   - チャネル mix と手取り率
   - リードタイム (中央値からの早割/直前割判断)
   - 国別構成 (上位 1-2 国の特化策)
   - 曜日別 ADR (週末プレミアム / 平日テコ入れ)
${reviewBlock ? "6. **貼り付けレビューから読める強み・改善点** (どのレビューが根拠か触れる)\n7." : "6."} **具体アクション (3-5 個、優先度順)**。各提案には必ず:
   - **なぜ効くか** (上の数字のどれを根拠にするか 1 行)
   - **概算インパクト** (¥/月 or 稼働率 %pt で、ざっくり)
   - **着手難易度** (低 / 中 / 高)

数字は ${yen(0)} 表記。「一般論」禁止、必ず「上の数字のどれそれを見ると…」と引いて。`;

  try {
    const { result, modelUsed } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 4096,
      useGoogleSearch: true,
    });
    const text = result?.response?.text?.() || "";
    res.json({ strategy: text, model: modelUsed, metrics: TM });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Beds24 の予約を「取引」シートに同期 (旅館売上として記録)。チャネル毎に行を分ける。
// 既に同期済みの予約は元ID で de-dup されるが、Cloud Run 再起動でキャッシュが
// 飛ぶので、シート側で「ソース=宿 AND 元ID」での重複除去を最終手段としておく想定。
// レビューのスクショ画像から Gemini Vision で本文だけを文字起こし。
// フロントが file → base64 で送ってくる。複数件あれば改行+「---」区切りで返す。
app.post("/api/yado/ocr-reviews", async (req, res) => {
  if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
  const { image, mimeType = "image/jpeg", channel = "" } = req.body || {};
  if (!image) return res.status(400).json({ error: "image required" });
  try {
    const chLabel = channel === "airbnb" ? "Airbnb"
                  : channel === "booking" ? "Booking.com"
                  : channel === "other" ? "楽天/じゃらん/Googleマップ 等"
                  : "ゲストレビュー";
    const prompt = `このスクリーンショットは ${chLabel} のゲストレビュー画面です。

抽出するもの:
- ゲストが書いたレビュー本文 (日本語・英語どちらでも)

除外するもの:
- 評価点数 (★ や 5.0 等の数字)
- 日付・予約期間
- ゲスト名・国旗・プロフィール写真
- ホストからの返信
- アプリのヘッダー・ボタン・タブ・メニュー
- 「もっと見る」「翻訳」などのリンク

出力形式:
- 1件のレビュー = 1段落
- 複数件あれば各レビューの間に空行
- 英語のレビューは「[原文]\\n(日本語訳: ...)」の形式
- 画像にレビュー本文が見当たらない場合は「(レビュー本文を検出できませんでした)」とだけ返す`;
    const { result } = await callGeminiWithFallback([
      { text: prompt },
      { inlineData: { data: image, mimeType } },
    ], { primaryModel: "gemini-2.5-flash", maxOutputTokens: 4096 });
    const text = result?.response?.text?.() || "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/yado/sync", async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "from/to required" });
  try {
    // 初回同期時に dashboard タブも一緒にセットアップ (idempotent)
    await ensureTxDashboards().catch((e) => console.warn(`[tx] dashboard setup failed (continuing): ${e.message}`));
    let bookings = [];
    if (BEDS24_API_TOKEN) {
      const propParam = MANCHIKAN_PROP_ID ? `&propertyId=${encodeURIComponent(MANCHIKAN_PROP_ID)}` : "";
    const url = `${BEDS24_BASE}/bookings?arrivalFrom=${from}&arrivalTo=${to}&includeInvoiceItems=false${propParam}`;
      const r = await fetch(url, { headers: { token: BEDS24_API_TOKEN, accept: "application/json" } });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: `beds24 ${r.status}: ${t.slice(0, 200)}` });
      }
      const j = await r.json();
      bookings = Array.isArray(j) ? j : (j.data || j.bookings || []);
    } else if (Array.isArray(req.body.bookings)) {
      // フロント側で取得済みの bookings をそのまま受け取って同期 (Beds24 トークンが
      // 未設定でも、ユーザーがフロントで取れたものをそのまま流せる経路を用意)
      bookings = req.body.bookings;
    }
    const today = new Date().toISOString().slice(0, 10);
    let count = 0;
    for (const b of bookings) {
      const referer = (b.referer || b.apiSourceReferer || b.bookingSource || "").toLowerCase();
      let ch = "その他";
      if (referer.includes("airbnb")) ch = "Airbnb";
      else if (referer.includes("booking")) ch = "Booking.com";
      else if (referer.includes("direct") || referer.includes("website") || referer.includes("自社")) ch = "自社サイト";
      const arr = (b.arrival || "").slice(0, 10);
      if (!arr) continue;
      const nights = b.arrival && b.departure
        ? Math.max(1, Math.round((new Date(b.departure) - new Date(b.arrival)) / 86400000))
        : 1;
      const result = await appendTx({
        date: arr,
        type: "収入",
        category: "旅館",
        subcategory: ch,
        amount: Number(b.price) || 0,
        counterparty: [b.lastName, b.firstName].filter(Boolean).join(" ") || b.guestName || ch,
        site: "満竹華庵",
        status: arr <= today ? "確定" : "予定",
        paymentMethod: ch === "自社サイト" ? "現地" : "振込",
        memo: `${nights}泊 大${b.numAdult || 0} 小${b.numChild || 0}`,
        photoCell: "",
        source: "宿",
        refId: String(b.id || b.bookId || ""),
      });
      if (result.ok) count++;
    }
    res.json({ ok: true, synced: count, total: bookings.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/scan", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    // 請求書 (kind=invoice) はデジタル管理 (紙の郵送ルートが無い) なので常に Drive 保存。
    // 領収書 (kind=receipt) は: camera は紙で税理士に郵送、library/file はデジタル → Drive 保存。
    const {
      image, mimeType = "image/jpeg", sites = [], kind = "receipt", direction = "in",
      source = "camera",     // "camera" | "library" | "file"
    } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64) is required" });
    const skipDrive = (kind === "receipt") && (source === "camera");

    let imageUrl = null;
    let driveUrl = null;
    const buf = Buffer.from(image, "base64");
    const ext = mimeType === "application/pdf" ? "pdf" : "jpg";
    const today = new Date().toISOString().slice(0, 10);
    const currentYm = today.slice(0, 7);
    const key = `${today}/${crypto.randomUUID()}.${ext}`;
    // GCS にアップロード (本体ストレージ。失敗しても AI 読取は続行)
    if (storage && RECEIPTS_BUCKET) {
      try {
        await storage
          .bucket(RECEIPTS_BUCKET)
          .file(key)
          .save(buf, { contentType: mimeType, resumable: false });
        imageUrl = `gs://${RECEIPTS_BUCKET}/${key}`;
        console.log(`[scan] uploaded ${imageUrl} (${buf.length} bytes, ${mimeType}, source=${source})`);
      } catch (e) {
        console.warn(`[scan] GCS upload FAILED (bucket=${RECEIPTS_BUCKET}, key=${key}): ${e.code || ""} ${e.message}`);
      }
    } else {
      console.warn(`[scan] image not saved (storage=${!!storage}, bucket=${RECEIPTS_BUCKET || "(empty)"})`);
    }
    // Drive にアップロード (税理士共有用、月別フォルダの中をカテゴリで分割)。カメラ撮影は skip。
    // フォルダ: YYYY-MM → 「領収書」 / 「支払請求書」 / 「売上請求書」
    if (DRIVE_FOLDER_ID && !skipDrive) {
      const categoryFolder = kind === "invoice"
        ? (direction === "out" ? "売上請求書" : "支払請求書")
        : "領収書";
      const dr = await uploadToDrive(buf, key.replace(/\//g, "_"), mimeType, [currentYm, categoryFolder]);
      if (dr) driveUrl = dr.url;
    }

    // today / currentYm は冒頭で既に算出済 (Drive 月別フォルダ用)
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
{"receipts":[{"date":"YYYY-MM-DD(無ければ${today})","store":"店舗名","total":合計金額の数値,"category":"材料費 or 接待交際費 or ガソリン代 or 駐車場代 or 工具・備品 or 外注費 or その他","workType":"水道 or 電気 or 木工 or 塗装 or 左官 or 内装 or 外構 or 解体 or 設備 or その他","site":"${sites.join(" or ") || "(空文字でOK)"}から最も近いものまたは空文字","payment":"現金 or カード or 電子マネー or 振込 (レシート上の支払欄から判定。CASH/現金/キャッシュ=現金、クレジット/CREDIT/カード名 (VISA/JCB/AMEX/楽天/三井住友 等)=カード、PayPay/Suica/iD/QUICPay/d払い/楽天Pay/メルペイ=電子マネー、銀行振込=振込。読めない / 不明なら空文字)"}]}`;
    }
    const { result, modelUsed } = await callGeminiWithFallback([
      prompt,
      { inlineData: { data: image, mimeType } },
    ], { jsonMode: true, maxOutputTokens: 4096 });
    const text = result.response.text();
    // JSON mode でも稀に余計な空白や trailing comma が残るので repair → parse の2段構え。
    // それでも壊れていたら parse position 周辺をログに出して原因を見える化。
    const raw = parseLooseJson(text);
    if (!raw) throw new Error("AI のJSON 出力を解析できませんでした (画像が不鮮明 / 文字認識失敗の可能性)");
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
// Denki Zumen (電気図面 → 品番・数量 抽出)
// Phase 1: 図面画像を投げて、品番 / 名称 / 数量 / カテゴリ / メーカー を JSON で返す。
// 既存の /api/scan と同じ Gemini Vision + jsonMode パターン。
// ─────────────────────────────
app.post("/api/zumen/scan", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { image, mimeType = "image/jpeg" } = req.body || {};
    if (!image) return res.status(400).json({ error: "image (base64) is required" });

    const prompt = `この電気設備図面を解析して、必要な器具・材料を JSON のみで返してください。
**JSON 以外のテキスト (説明文・前置き・コードフェンス等) を一切出力しないこと。**
凡例表・記号 (シンボル) と本図の両方を見て、図中に出てくる器具を全て拾い出します。
同じ品番がいくつ図中に出てくるかを数えて qty に入れてください。品番が読めなければ part_no は空文字。
記号 (◯, ▲, スイッチ記号, コンセント記号 等) と凡例の対応も読み取ること。
**もし図面が不鮮明・部分的・電気図面でない場合でも、エラー文ではなく {"items":[]} (空配列) を返すこと。**
形式:
{"items":[{
  "part_no":"品番 / 型番 (Panasonic WTC1031 等。読めなければ空文字)",
  "name":"器具名 (シングル片切スイッチ / コンセント / ダウンライト 等)",
  "maker":"メーカー (Panasonic / 神保電器 / 大光電機 等。読めなければ空文字)",
  "qty":数量の整数,
  "category":"照明器具 or スイッチ・コンセント or 分電盤 or 配線資材 or 弱電 or その他",
  "symbol":"図面上の記号があれば短文 (例: 〇 + 数字、片切スイッチ記号)。無ければ空文字",
  "note":"特記 (200V 専用 / 防雨 / 接地極付 / WHITE 等。無ければ空文字)"
}]}`;
    const { result, modelUsed } = await callGeminiWithFallback([
      prompt,
      { inlineData: { data: image, mimeType } },
    ], { jsonMode: true, maxOutputTokens: 16384 });
    const text = result.response.text();
    console.log(`[zumen/scan] model=${modelUsed} text.len=${text.length} head="${text.slice(0, 200).replace(/\s+/g, " ")}"`);
    const raw = parseLooseJson(text);
    if (!raw) {
      // raw text の頭をエラーに含めて、フロントで何が返ってきたか見えるようにする
      const head = text.slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`AI の出力を解析できませんでした (text.len=${text.length}, head="${head}")`);
    }
    const items = Array.isArray(raw?.items) ? raw.items : [];
    res.json({ items, modelUsed });
  } catch (err) {
    console.error("zumen scan error", err);
    const msg = String(err?.message || err);
    const isTransient = /\b(503|429|500)\b|UNAVAILABLE|overload|high demand/i.test(msg);
    res.status(isTransient ? 503 : 500).json({
      error: isTransient ? `Gemini が混雑中です。少し待って再実行してください: ${msg.slice(0, 200)}` : msg,
    });
  }
});

// 品番 → 製品情報 (これ何？)
// 既存の Gemini にメーカー・用途・仕様を聞くだけ。製品 DB は持たない。
app.post("/api/zumen/explain", async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ error: "GEMINI_API_KEY not configured" });
    const { partNo = "", name = "" } = req.body || {};
    const query = (partNo || name).trim();
    if (!query) return res.status(400).json({ error: "partNo or name is required" });
    const prompt = `電気設備の品番「${query}」について、現場の職人が発注前に確認したい情報を JSON のみで返してください。
推測になる項目は confidence を "low" にすること。実在しなければ exists=false。
形式:
{
  "exists": true|false,
  "maker": "メーカー名 (推測ならその旨)",
  "name": "正式品名",
  "category": "照明 / スイッチ / コンセント / 分電盤 / 配線資材 / 弱電 / その他",
  "summary": "1-2行で何の器具か",
  "spec": "電圧・電流・口数・色・防水等の主要スペックを箇条書き風に",
  "alt_parts": ["互換 or 同等品の型番があれば 0-3 個"],
  "confidence": "high|medium|low"
}`;
    const { result } = await callGeminiWithFallback(prompt, {
      jsonMode: true, maxOutputTokens: 1024, primaryModel: "gemini-2.5-flash",
    });
    const text = result.response.text();
    const parsed = parseLooseJson(text, { logErr: false }) || { exists: false };
    res.json(parsed);
  } catch (err) {
    console.error("zumen explain error", err);
    res.status(500).json({ error: String(err?.message || err) });
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


// ============================================================
// seko-kanri: 2級建築施工管理技士検定 対策 (techstudy/kotonoha フォーク)
// 既存 kotonoha との完全分離: テーブル seko_*、ジャンルマスタ seko-genres.json。
// AI 出題プロンプトは domain.ai_subject で施工管理ドメインへ。
// ユーザーは exam_target ('first_full' | 'second_only') を選んで出題範囲をフィルタ。
// ============================================================

let SEKO_GENRES_DATA = null;
let SEKO_GENRE_TO_GROUP = new Map();
let SEKO_GENRE_TARGET = new Map();
let SEKO_GROUP_BY_ID = new Map();        // group_id → group object (shubetsu_relevance 参照用)
try {
  const raw = fs.readFileSync(path.join(__dirname, "seko-genres.json"), "utf8");
  SEKO_GENRES_DATA = JSON.parse(raw);
  for (const g of SEKO_GENRES_DATA.groups || []) {
    SEKO_GROUP_BY_ID.set(g.id, g);
    for (const gen of g.genres || []) {
      SEKO_GENRE_TO_GROUP.set(gen.name, g.id);
      SEKO_GENRE_TARGET.set(gen.name, gen.target_count || 10);
    }
  }
  console.log(`[seko] loaded ${SEKO_GENRE_TO_GROUP.size} genres / ${SEKO_GENRES_DATA.groups?.length || 0} groups`);
} catch (e) {
  console.warn("[seko] genres.json load failed:", e.message);
}

// 起動時 seed sync: seko-seed.json の各問について、同じ question 文の seed が
// DB に既にあれば keywords/answer/explanation を UPDATE、無ければ INSERT する。
// → seed の編集 (keywords 追加・解説修正) がデプロイ毎に反映される。
// 既存ユーザーの progress (question_id への FK) は壊さない (id を維持)。
async function syncSekoSeed() {
  const p = getPool();
  if (!p) return;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "seko-seed.json"), "utf8");
    const seed = JSON.parse(raw);
    let updated = 0, inserted = 0;
    for (const q of seed.questions || []) {
      const qText = String(q.question || "").trim();
      if (!qText) continue;
      try {
        const upd = await p.query(
          `UPDATE seko_questions SET
             options = $1, answer = $2, keywords = $3, explanation = $4,
             genre = $5, group_id = $6, exam_level = $7, type = $8, difficulty = $9
           WHERE source = 'seed' AND question = $10`,
          [
            JSON.stringify(q.options || []),
            String(q.answer || "").trim(),
            JSON.stringify(q.keywords || []),
            String(q.explanation || "").trim(),
            q.genre,
            q.group_id,
            q.exam_level === "2ji" ? "2ji" : "1ji",
            q.type === "free" ? "free" : "choice",
            Number(q.difficulty) || 3,
            qText,
          ]
        );
        if (upd.rowCount > 0) {
          updated++;
        } else {
          await p.query(
            `INSERT INTO seko_questions
               (category, difficulty, type, question, options, answer, keywords, explanation,
                claude_example, genre, group_id, exam_level, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'seed')`,
            [
              q.group_id || "uncategorized",
              Number(q.difficulty) || 3,
              q.type === "free" ? "free" : "choice",
              qText,
              JSON.stringify(q.options || []),
              String(q.answer || "").trim(),
              JSON.stringify(q.keywords || []),
              String(q.explanation || "").trim(),
              q.claude_example || "",
              q.genre,
              q.group_id,
              q.exam_level === "2ji" ? "2ji" : "1ji",
            ]
          );
          inserted++;
        }
      } catch (e) { console.warn("[seko-seed] upsert failed:", e.message); }
    }
    console.log(`[seko-seed] sync done: +${inserted} new, ${updated} updated`);
  } catch (e) {
    console.warn("[seko-seed] load failed:", e.message);
  }
}
setTimeout(() => { syncSekoSeed().catch(() => {}); }, 3000);

// exam_target + shubetsu でユーザーに出題して良い group 一覧を返す。
// - exam_target='first_full' → 全 group (一次 + 二次)
// - exam_target='second_only' → 二次 group + 一次の「二次解答に効く復習 group」(法規・施工管理法・仕上工事・建築学)
//   (一次合格から時間が経ってる人向け。二次は一次知識の上に乗るので復習問題を 30% 程度混ぜる)
// - shubetsu の group.shubetsu_relevance フィルタは両 target 共通
const SEKO_REVIEW_GROUPS_FOR_2JI = new Set([
  "kanri_ho", "ho_ki", "shiko_shiage", "kenchiku_gaku", "kyotsu_setsubi",
]); // shubetsu によって shiage_relevance フィルタが二次掛けて適切な group だけ残る
function sekoGroupsForUser(examTarget, shubetsu) {
  const primary = [];
  const review = [];
  for (const g of SEKO_GENRES_DATA?.groups || []) {
    if (shubetsu) {
      const rel = Array.isArray(g.shubetsu_relevance) ? g.shubetsu_relevance : null;
      if (rel && !rel.includes(shubetsu)) continue;
    }
    if (examTarget === "second_only") {
      if (g.exam_level === "2ji") primary.push(g);
      else if (SEKO_REVIEW_GROUPS_FOR_2JI.has(g.id)) review.push(g);
    } else {
      primary.push(g);
    }
  }
  return { primary, review };
}

function sekoGenresForUser(examTarget, shubetsu) {
  const { primary, review } = sekoGroupsForUser(examTarget, shubetsu);
  const out = [];
  for (const g of primary) for (const gen of g.genres || []) out.push(gen.name);
  for (const g of review) for (const gen of g.genres || []) out.push(gen.name);
  return out;
}

const SHUBETSU_LABEL = {
  kenchiku: "建築 (建築一式)",
  kutai: "躯体 (鉄筋・鉄骨・コンクリート)",
  shiage: "仕上げ (内装・防水・タイル・塗装・建具)",
};

// バックグラウンド プリウォーム: ユーザーがホーム見てる間に問題プールを温める。
// 同時実行を防ぐためフラグで gate。1 ユーザー = 1 並行。
const _sekoPrewarmRunning = new Set();
async function prewarmSekoPool(p, user) {
  const examTarget = user.exam_target || "first_full";
  const shubetsu = user.shubetsu || null;
  const userLevel = user.level || 1;
  const allowedGenres = sekoGenresForUser(examTarget, shubetsu);
  if (!allowedGenres.length) return;
  // この (target, shubetsu) 組合せで近 1 時間内に何問生成済か
  const allowedGroupIds = [];
  for (const g of SEKO_GENRES_DATA?.groups || []) {
    if (examTarget === "second_only" && g.exam_level !== "2ji" && !SEKO_REVIEW_GROUPS_FOR_2JI.has(g.id)) continue;
    if (shubetsu) {
      const rel = Array.isArray(g.shubetsu_relevance) ? g.shubetsu_relevance : null;
      if (rel && !rel.includes(shubetsu)) continue;
    }
    allowedGroupIds.push(g.id);
  }
  const { rows: cnt } = await p.query(
    `SELECT COUNT(*)::int AS n FROM seko_questions
      WHERE genre = ANY($1::text[])
        AND (group_id = ANY($2::text[]) OR group_id IS NULL)
        AND created_at > now() - interval '7 days'`,
    [allowedGenres, allowedGroupIds]
  );
  const fresh = cnt[0]?.n || 0;
  const TARGET = 12;   // 直近 1 週間分のプール目標
  const need = Math.min(5, TARGET - fresh);
  if (need <= 0) return;
  const lock = `${user.user_email}::${examTarget}::${shubetsu || "_"}`;
  if (_sekoPrewarmRunning.has(lock)) return;
  _sekoPrewarmRunning.add(lock);
  try {
    const items = [];
    for (let i = 0; i < need; i++) {
      const g = allowedGenres[Math.floor(Math.random() * allowedGenres.length)];
      const groupId = SEKO_GENRE_TO_GROUP.get(g);
      const groupRow = SEKO_GROUP_BY_ID.get(groupId);
      let qtype = "choice";
      const dt = groupRow?.default_question_type;
      if (dt === "free") qtype = "free";
      else if (dt === "mixed") qtype = userLevel <= 2 ? "choice" : (Math.random() < 0.5 ? "choice" : "free");
      items.push({ genre: g, groupId, examLevel: groupRow?.exam_level || "1ji", qtype });
    }
    const gen = await generateSekoQuestionsBatch(p, items, shubetsu);
    console.log(`[seko] prewarm: +${gen.length} for ${lock}`);
  } finally {
    _sekoPrewarmRunning.delete(lock);
  }
}

async function ensureSekoUser(p, email) {
  const display = String(email).split("@")[0] || "user";
  const { rows } = await p.query(
    `INSERT INTO seko_users (user_email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_email) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [email, display]
  );
  return rows[0];
}

// AI で N 問まとめて生成して seko_questions に INSERT、行配列を返す。
// 大きすぎる応答は Gemini が JSON 切ったり time out するので、N>5 は分割並列で呼ぶ。
async function generateSekoQuestionsBatch(p, items, shubetsu) {
  if (!genAI) throw new Error("Gemini 未設定");
  if (!items.length) return [];
  // 5 問より多ければ 2 並列に分割
  if (items.length > 5) {
    const mid = Math.ceil(items.length / 2);
    const [a, b] = await Promise.allSettled([
      generateSekoQuestionsBatch(p, items.slice(0, mid), shubetsu),
      generateSekoQuestionsBatch(p, items.slice(mid), shubetsu),
    ]);
    const out = [];
    if (a.status === "fulfilled") out.push(...a.value);
    if (b.status === "fulfilled") out.push(...b.value);
    return out;
  }
  const subject = SEKO_GENRES_DATA?.domain?.ai_subject || "2級建築施工管理技士検定";
  const shubetsuLabel = shubetsu ? (SHUBETSU_LABEL[shubetsu] || shubetsu) : null;
  const lines = items.map((it, i) => {
    const grp = SEKO_GROUP_BY_ID.get(it.groupId);
    const lvl = it.examLevel === "2ji" ? "二次" : "一次";
    const typeLabel = it.qtype === "free"
      ? "記述式 (本試験の二次形式、選択肢なし)"
      : "四肢択一";
    return `[${i + 1}] 分野: ${grp?.name || it.groupId} / ジャンル: ${it.genre} / 試験: ${lvl} / 出題形式: ${typeLabel}`;
  }).join("\n");
  const shubetsuBlock = shubetsuLabel ? `
■ 受検種別: ${shubetsuLabel}
- 受験生はこの種別で受験する。ただし「分野: ...」「ジャンル: ...」で指定された論点を絶対に外してはいけない。
  指定が「建築学 (一般) / 採光・照明」なら採光・照明の問題を作る。「法規 / 建築基準法」なら建築基準法の問題を作る。
- 受検種別の情報は「現場での運用注意」と「解説末尾の一言コメント」だけに使う (= 出題論点を種別寄りに歪めない)。
- 解説の最後に「【${shubetsuLabel} の現場で】」と添えて、当該種別の現場での運用注意を 1 文加える。` : "";
  const prompt = `あなたは ${subject} の出題者。
${shubetsuBlock}
次の ${items.length} 件、それぞれ別の問題を作って:
${lines}

各問の方針:
- 受験生が現場で「これ知らなかった」と気づける頻出論点をひとつ。
- 細かすぎる数値より現場での意味・判断基準を優先。
- 出題形式は「出題形式」欄に従う:
  ・四肢択一: 「四つのうち最も不適当なものはどれか」「次のうち正しいものはどれか」型。options 4 つ、answer は正解の選択肢の文字列そのまま (A/B/C/D の記号不要)。type は "choice"。
  ・記述式: 本試験二次の形式。設問は短答記述 (例「鉄筋工事における配筋検査の留意事項を 2 つ簡潔に述べよ」「コンクリート打設時の留意点を 80 字程度で述べよ」)。options は null。answer には模範解答の要点 (50-150 字) を入れる。keywords に採点キーワード 3-5 個を入れる (これが含まれれば部分正解扱い)。type は "free"。
- 解説は 3-5 文。なぜ正解か、誤答はなぜ違うか (択一)、模範解答のポイント (記述)、現場の留意点を 1 文。

JSON 配列でだけ返す (前置きや説明禁止)。配列の長さは ${items.length} 件、入力順:
[
  {
    "category": "group_id",
    "difficulty": 3,
    "type": "choice" | "free",
    "question": "...",
    "options": ["...","...","...","..."] または null,
    "answer": "...",
    "keywords": ["..."],
    "explanation": "3-5 文",
    "claude_example": ""
  },
  ... (合計 ${items.length} 件)
]`;
  // 15 秒のハードタイムアウト + jsonMode で構造保証。
  const geminiP = callGeminiWithFallback(prompt, {
    primaryModel: "gemini-2.5-flash",
    maxOutputTokens: Math.min(5000, 600 + items.length * 500),
    jsonMode: true,
  });
  const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error("Gemini タイムアウト (15s)")), 15000));
  const { result } = await Promise.race([geminiP, timeoutP]);
  const text = (result.response.text() || "").trim();
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("AI レスポンスから JSON 配列取れず: " + text.slice(0, 100));
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error("配列ではない");
  const out = [];
  for (let i = 0; i < arr.length && i < items.length; i++) {
    const parsed = arr[i] || {};
    const it = items[i];
    // 図解は当面オフ (jsonMode で <svg> を string に詰めると Gemini が JSON 壊しがち)
    let imageUrl = null;
    try {
      const ins = await p.query(
        `INSERT INTO seko_questions
           (category, difficulty, type, question, options, answer, keywords, explanation,
            claude_example, genre, group_id, exam_level, source, image_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'generated',$13)
         RETURNING *`,
        [
          parsed.category || it.groupId,
          Number(parsed.difficulty) || 3,
          parsed.type === "free" ? "free" : "choice",
          String(parsed.question || "").trim(),
          JSON.stringify(parsed.options || []),
          String(parsed.answer || "").trim(),
          JSON.stringify(parsed.keywords || []),
          String(parsed.explanation || "").trim(),
          parsed.claude_example || "",
          it.genre,
          it.groupId,
          it.examLevel === "2ji" ? "2ji" : "1ji",
          imageUrl,
        ]
      );
      out.push(ins.rows[0]);
    } catch (e) {
      console.warn("[seko] insert failed for item", i, e.message);
    }
  }
  return out;
}

// ───── seko endpoints ─────

app.get("/api/seko/genres", (req, res) => {
  if (!SEKO_GENRES_DATA) return res.status(503).json({ error: "genres not loaded" });
  res.json(SEKO_GENRES_DATA);
});

// 学習進捗 (group / genre の正解 unique 数を集計)。
// examTarget / shubetsu に応じて、ユーザーに関係する group だけを返す。
async function buildSekoProgress(p, email, examTarget, shubetsu) {
  const { rows: correctRows } = await p.query(
    `SELECT q.group_id, q.genre, COUNT(DISTINCT q.id)::int AS unique_correct
       FROM seko_progress pr
       JOIN seko_questions q ON q.id = pr.question_id
      WHERE pr.user_email = $1 AND pr.is_correct
      GROUP BY q.group_id, q.genre`,
    [email]
  );
  const byGenre = new Map();
  for (const r of correctRows) byGenre.set(`${r.group_id}::${r.genre}`, r.unique_correct);

  // 表示対象の group を絞る (例: 仕上ユーザーの radar に「二次: 躯体」は出さない)
  const relevant = [];
  for (const g of (SEKO_GENRES_DATA?.groups || [])) {
    if (shubetsu) {
      const rel = Array.isArray(g.shubetsu_relevance) ? g.shubetsu_relevance : null;
      if (rel && !rel.includes(shubetsu)) continue;
    }
    if (examTarget === "second_only" && g.exam_level !== "2ji" && !SEKO_REVIEW_GROUPS_FOR_2JI.has(g.id)) continue;
    relevant.push(g);
  }

  const groups = relevant.map((g) => {
    const genres = (g.genres || []).map((gen) => ({
      name: gen.name,
      target: gen.target_count || 10,
      correct: byGenre.get(`${g.id}::${gen.name}`) || 0,
    }));
    const totT = genres.reduce((s, x) => s + x.target, 0);
    const totC = genres.reduce((s, x) => s + x.correct, 0);
    const pct = totT ? Math.round((totC / totT) * 100) : 0;
    return { id: g.id, name: g.name, color: g.color || "#9ca3af", exam_level: g.exam_level || null, genres, target: totT, correct: totC, pct };
  });
  return groups;
}

async function computeSekoStreak(p, email) {
  const SEKO_STREAK_DAILY_MIN = 5;
  // 直近 60 日で何日連続で 1 問以上正解しているか + 今日の活動状況
  const { rows } = await p.query(
    `SELECT (answered_at AT TIME ZONE 'Asia/Tokyo')::date AS d,
            COUNT(*) FILTER (WHERE is_correct)::int AS correct
       FROM seko_progress WHERE user_email = $1
      GROUP BY d ORDER BY d DESC LIMIT 60`,
    [email]
  );
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const ymd = (dt) => dt.toISOString().slice(0, 10);
  const todayStr = ymd(today);
  if (!rows.length) {
    return { streak: 0, today_active: false, today_correct: 0, daily_min: SEKO_STREAK_DAILY_MIN };
  }
  const byDate = new Map(rows.map((r) => [String(r.d), r.correct]));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    if ((byDate.get(ymd(d)) || 0) >= SEKO_STREAK_DAILY_MIN) streak++;
    else break;
  }
  const todayCorrect = byDate.get(todayStr) || 0;
  return {
    streak,
    today_active: todayCorrect >= SEKO_STREAK_DAILY_MIN,
    today_correct: todayCorrect,
    daily_min: SEKO_STREAK_DAILY_MIN,
  };
}

app.get("/api/seko/me", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const user = await ensureSekoUser(p, req.user.email);
    // バックグラウンドで問題プールを温める (ユーザーがホーム見てる ~5 秒で 5 問生成完了 → セッション開始即時)
    prewarmSekoPool(p, user).catch((e) => console.warn("[seko] prewarm failed:", e.message));
    const [groups, streak] = await Promise.all([
      buildSekoProgress(p, req.user.email, user.exam_target || "first_full", user.shubetsu || null),
      computeSekoStreak(p, req.user.email),
    ]);
    const { rows: poolRows } = await p.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE source = 'generated')::int AS generated,
              count(*) FILTER (WHERE source = 'seed')::int AS seed,
              count(*) FILTER (WHERE source = 'generated' AND created_at > now() - interval '1 hour')::int AS gen_last_hour
         FROM seko_questions`
    );
    const pool = poolRows[0] || { total: 0, generated: 0, seed: 0, gen_last_hour: 0 };
    // 直近 7 日の回答ペース (per_day 平均 + last7Correct)
    const { rows: paceRows } = await p.query(
      `SELECT
         COUNT(*)::int AS last7_answers,
         COUNT(*) FILTER (WHERE is_correct)::int AS last7_correct
         FROM seko_progress
        WHERE user_email = $1 AND answered_at > now() - interval '7 days'`,
      [req.user.email]
    );
    const pace = paceRows[0] || { last7_answers: 0, last7_correct: 0 };
    const { rows: learned } = await p.query(
      `SELECT q.genre AS label, MAX(pr.answered_at) AS answered_at, q.group_id, q.explanation
         FROM seko_progress pr
         JOIN seko_questions q ON q.id = pr.question_id
        WHERE pr.user_email = $1 AND pr.is_correct AND q.genre IS NOT NULL
        GROUP BY q.genre, q.group_id, q.explanation
        ORDER BY answered_at DESC
        LIMIT 60`,
      [req.user.email]
    );
    res.json({
      user,
      streak,
      groups,
      pool,
      recentWords: learned.slice(0, 12),
      learned,
      hasLauncherAccess: allowList.length === 0
        || allowList.includes(String(req.user.email || "").toLowerCase()),
      isOwner: KOTONOHA_OWNER_EMAILS.has(String(req.user.email || "").toLowerCase()),
      exam_target: user.exam_target || null,
      shubetsu: user.shubetsu || null,
      pace,
    });
  } catch (err) {
    console.error("seko me", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/seko/me/shubetsu", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const s = req.body?.shubetsu;
  if (!["kenchiku", "kutai", "shiage"].includes(s)) return res.status(400).json({ error: "shubetsu は kenchiku / kutai / shiage" });
  try {
    await p.query(
      `UPDATE seko_users SET shubetsu = $1, updated_at=now() WHERE user_email = $2`,
      [s, req.user.email]
    );
    res.json({ ok: true, shubetsu: s });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/seko/me/exam-target", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const t = req.body?.exam_target;
  if (t !== "first_full" && t !== "second_only") return res.status(400).json({ error: "exam_target は first_full / second_only" });
  try {
    await p.query(
      `UPDATE seko_users SET exam_target = $1, updated_at=now() WHERE user_email = $2`,
      [t, req.user.email]
    );
    res.json({ ok: true, exam_target: t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/seko/me/visibility", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const visible = !!req.body?.visible;
  try {
    await p.query(
      `UPDATE seko_users SET visible_to_peers = $1, updated_at=now() WHERE user_email = $2`,
      [visible, req.user.email]
    );
    res.json({ ok: true, visible });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MVP: ピア機能は後でちゃんと作る。最初は空配列で UI を出さない。
app.get("/api/seko/peers", (req, res) => res.json([]));
app.get("/api/seko/peer-learned", (req, res) => res.json({ learned: [] }));
// UI デモ系は施工管理では不要 (IT 部品のため)。空 / 無効を返す。
app.get("/api/seko/ui-demo-status", (req, res) => res.json({ pending: 0, total: 0, disabled: true }));
app.get("/api/seko/ui-demos-list", (req, res) => res.json([]));

// セッション開始: ユーザーの exam_target に合うジャンルから 10 問選ぶ。
// プール薄ければ inline で AI 生成して埋める (最大 4 問 / 30 秒タイムアウト)。
app.post("/api/seko/sessions/start", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const user = await ensureSekoUser(p, req.user.email);
    const examTarget = user.exam_target || "first_full";
    const shubetsu = user.shubetsu || null;
    const { primary: primaryGroups, review: reviewGroups } = sekoGroupsForUser(examTarget, shubetsu);
    const allowedGenres = sekoGenresForUser(examTarget, shubetsu);
    if (!allowedGenres.length) return res.status(503).json({ error: "出題対象ジャンルがありません。受検種別 / 出題範囲の設定を確認してください。" });
    const SESSION_SIZE = 10;

    // 集中セッション (genre 指定)
    const focus = (req.body?.genre || "").trim();
    const focusValid = focus && allowedGenres.includes(focus);

    const shuffle = (a) => { const c = a.slice(); for (let i = c.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [c[i],c[j]]=[c[j],c[i]]; } return c; };

    let targetGenres;
    if (focusValid) {
      targetGenres = [focus];
    } else {
      // ───── group 横断 均等配分アルゴリズム ─────
      // sessionSize を全 group に決定的に振り分ける quota 方式。
      // 1. baseQuota = floor(SESSION_SIZE / groupCount)
      // 2. 余り = SESSION_SIZE - baseQuota * groupCount
      // 3. group を達成度 (group_correct/group_target) 昇順でソート
      // 4. 上位「余り」個の group が +1 quota 獲得 → 達成度低い group が優先的に出る
      // 5. 各 group から quota 数だけ「target 未達順」のジャンルを pick
      // 合計が必ず SESSION_SIZE。group 数が SESSION_SIZE より多い場合は
      // 余り分の上位 group だけが quota=1 を貰い、下位は quota=0 (= 出題されない)。
      // = どんな group 数でも各セッションが「未達 group 中心に均等」に分散する。

      // 現在の達成数を group / genre 毎に集計
      const { rows: corRows } = await p.query(
        `SELECT q.group_id, q.genre, COUNT(DISTINCT q.id)::int AS n
           FROM seko_progress pr JOIN seko_questions q ON q.id = pr.question_id
          WHERE pr.user_email = $1 AND pr.is_correct
          GROUP BY q.group_id, q.genre`,
        [req.user.email]
      );
      const corMap = new Map();
      for (const r of corRows) corMap.set(`${r.group_id}::${r.genre}`, r.n);

      const allGroups = examTarget === "second_only"
        ? [...primaryGroups, ...reviewGroups]
        : primaryGroups;

      // 各 group の達成度を計算
      const groupStats = allGroups.map((g) => {
        const genres = (g.genres || []).map((x) => ({
          name: x.name,
          target: x.target_count || 10,
          got: corMap.get(`${g.id}::${x.name}`) || 0,
        }));
        const totT = genres.reduce((s, x) => s + x.target, 0);
        const totG = genres.reduce((s, x) => s + x.got, 0);
        const ratio = totT > 0 ? totG / totT : 1; // 全完了済は 1、未達は 0
        return { id: g.id, ratio, genres };
      });

      // 達成度昇順ソート (= 未達 group 優先)、tie ブレークは random
      groupStats.sort((a, b) => {
        if (a.ratio !== b.ratio) return a.ratio - b.ratio;
        return Math.random() - 0.5;
      });

      // 完全達成済 (ratio >= 1.0) は除外 → 残ったセッション枠を未達 group で使う
      // 全 group 達成済の場合のみフォールバックとして全 group を残す (= 復習モード)
      let activeStats = groupStats.filter((g) => g.ratio < 1.0);
      if (!activeStats.length) activeStats = groupStats;

      // quota 計算
      const N = activeStats.length;
      const baseQuota = Math.floor(SESSION_SIZE / N);
      const extra = SESSION_SIZE - baseQuota * N;

      // 各 group から quota 数だけジャンル取得 (group 内では target 未達順、tie は random)
      const pool = [];
      activeStats.forEach((g, idx) => {
        const quota = baseQuota + (idx < extra ? 1 : 0);
        if (quota <= 0) return;
        const sorted = g.genres.slice().sort((a, b) => {
          const ra = a.target > 0 ? a.got / a.target : 1;
          const rb = b.target > 0 ? b.got / b.target : 1;
          if (ra !== rb) return ra - rb;
          return Math.random() - 0.5;
        });
        for (const x of sorted.slice(0, quota)) pool.push(x.name);
      });

      // 順番もシャッフル (group 順だと体感「ブロックごとに出る」になるので)
      targetGenres = shuffle(pool);
      if (!targetGenres.length) targetGenres = allowedGenres;
    }

    // 直近 出題済の質問 ID (再出題を避けるため 50 件)
    const { rows: recentRows } = await p.query(
      `SELECT question_id FROM seko_progress WHERE user_email = $1
        ORDER BY answered_at DESC LIMIT 50`,
      [req.user.email]
    );
    const recentIds = new Set(recentRows.map((r) => r.question_id));

    // プールから候補を取る (古い種別違いを混ぜないよう、group_id でも shubetsu フィルタ)
    const allowedGroupIds = [];
    for (const g of SEKO_GENRES_DATA?.groups || []) {
      if (examTarget === "second_only" && g.exam_level !== "2ji") continue;
      if (shubetsu) {
        const rel = Array.isArray(g.shubetsu_relevance) ? g.shubetsu_relevance : null;
        if (rel && !rel.includes(shubetsu)) continue;
      }
      allowedGroupIds.push(g.id);
    }
    const { rows: pool } = await p.query(
      `SELECT * FROM seko_questions
        WHERE genre = ANY($1::text[])
          AND (group_id = ANY($2::text[]) OR group_id IS NULL)
        ORDER BY random()
        LIMIT 50`,
      [targetGenres, allowedGroupIds]
    );
    const fresh = pool.filter((q) => !recentIds.has(q.id));

    let picked = fresh.slice(0, SESSION_SIZE);

    // 足りなければ AI で 1 リクエストにまとめて生成 (~10 秒で N 問取れる)
    const need = SESSION_SIZE - picked.length;
    if (need > 0) {
      const items = [];
      const userLevel = user.level || 1;
      for (let i = 0; i < need; i++) {
        const g = targetGenres[Math.floor(Math.random() * targetGenres.length)];
        const groupId = SEKO_GENRE_TO_GROUP.get(g);
        const groupRow = SEKO_GROUP_BY_ID.get(groupId);
        // group の default_question_type と level で type 決定:
        //   - 'choice'/'free' は固定
        //   - 'mixed' は level<=2 で choice、>=3 で 50/50
        let qtype = "choice";
        const dt = groupRow?.default_question_type;
        if (dt === "free") qtype = "free";
        else if (dt === "choice") qtype = "choice";
        else if (dt === "mixed") {
          if (userLevel <= 2) qtype = "choice";
          else qtype = Math.random() < 0.5 ? "choice" : "free";
        }
        items.push({ genre: g, groupId, examLevel: groupRow?.exam_level || "1ji", qtype });
      }
      try {
        const gen = await generateSekoQuestionsBatch(p, items, shubetsu);
        picked.push(...gen);
      } catch (e) {
        console.warn("[seko] batch gen failed:", e.message);
      }
    }

    // 取れた数で開始 (最低 1 問あれば動く。503 で UX 止めない)
    if (!picked.length) {
      // 最後の手段: pool から exam_target/shubetsu 無視で取る
      const { rows: anyRows } = await p.query(
        `SELECT * FROM seko_questions ORDER BY random() LIMIT 5`
      );
      picked = anyRows;
    }
    if (!picked.length) {
      return res.status(503).json({
        error: "問題プールが空です。少し待って再試行 (バックグラウンドで生成中)。",
      });
    }

    res.json({
      total: picked.length,
      questions: picked.map((q) => ({
        id: q.id,
        category: q.category,
        difficulty: q.difficulty,
        type: q.type,
        question: q.question,
        options: q.options,
        genre: q.genre,
        group_id: q.group_id,
        exam_level: q.exam_level,
        image_url: q.image_url || null,
      })),
    });
  } catch (err) {
    console.error("seko sessions/start", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/seko/answer", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const { question_id, user_answer } = req.body || {};
  if (!question_id) return res.status(400).json({ error: "question_id required" });
  try {
    const { rows: qRows } = await p.query(`SELECT * FROM seko_questions WHERE id=$1`, [question_id]);
    if (!qRows.length) return res.status(404).json({ error: "question not found" });
    const q = qRows[0];
    const ua = String(user_answer || "").trim();

    let isCorrect = false;
    let aiReason = null;
    if (q.type === "choice") {
      isCorrect = ua === q.answer;
      if (!isCorrect && /^[A-D]$/i.test(String(q.answer || "").trim())) {
        const letter = String(q.answer).trim().toUpperCase();
        if (Array.isArray(q.options)) {
          const idx = letter.charCodeAt(0) - "A".charCodeAt(0);
          if (q.options[idx] === ua) isCorrect = true;
        }
      }
    } else {
      // 正規化: 全角空白除去 + 小文字化 + カタカナ揺れ吸収 (ヴァ→バ, ヴィ→ビ, ヴ→ブ等) + 半角化
      const norm = (s) => {
        let t = String(s || "").trim().toLowerCase();
        // 全角英数→半角
        t = t.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        // 空白除去
        t = t.replace(/\s+/g, "");
        // 句読点・記号除去
        t = t.replace(/[、。,.()()「」『』:;・]/g, "");
        // カタカナのヴ揺れ: ヴァヴィヴェヴォヴュ → バビベボビュ、ヴ→ブ
        t = t.replace(/ヴァ/g, "バ").replace(/ヴィ/g, "ビ").replace(/ヴェ/g, "ベ").replace(/ヴォ/g, "ボ").replace(/ヴュ/g, "ビュ").replace(/ヴ/g, "ブ");
        return t;
      };
      const normUa = norm(ua);
      if (normUa === norm(q.answer)) {
        isCorrect = true;
      } else if (Array.isArray(q.keywords) && q.keywords.length) {
        // キーワード hits: 2 個以上 or 25% 以上含めば正解扱い (部分得点で合格)。
        let hit = 0;
        for (const k of q.keywords) {
          const nk = norm(k);
          if (nk && normUa.includes(nk)) hit++;
        }
        const threshold = Math.max(2, Math.ceil(q.keywords.length * 0.25));
        if (hit >= threshold) isCorrect = true;
      }
      if (!isCorrect && genAI && ua) {
        try {
          const judgePrompt = `次のユーザー回答が、正解と意味的に同じか判定してください。
建築施工管理の文脈で、用語のゆらぎ・言い換えは正解として認めます。

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
          console.warn("[seko] AI 判定失敗:", e.message);
        }
      }
    }

    const { rows: attemptRows } = await p.query(
      `SELECT count(*)::int AS n FROM seko_progress WHERE user_email=$1 AND question_id=$2`,
      [req.user.email, question_id]
    );
    const attempts = (attemptRows[0]?.n || 0) + 1;
    await p.query(
      `INSERT INTO seko_progress (user_email, question_id, is_correct, user_answer, attempts)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.email, question_id, isCorrect, ua, attempts]
    );
    await p.query(
      `UPDATE seko_users
          SET total_correct = total_correct + $1, total_answers = total_answers + 1,
              last_session_at = now(), updated_at = now()
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
  } catch (err) {
    console.error("seko answer", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/seko/sessions/end", async (req, res) => {
  const p = getPool();
  if (!p) return res.json({ ok: true });
  try {
    // 直近 10 回答の正解率で簡易レベル調整 (≥70% → +1、<40% → -1、min 1)
    const { rows } = await p.query(
      `SELECT is_correct FROM seko_progress WHERE user_email = $1
        ORDER BY answered_at DESC LIMIT 10`,
      [req.user.email]
    );
    if (rows.length >= 5) {
      const acc = rows.filter((r) => r.is_correct).length / rows.length;
      let delta = 0;
      if (acc >= 0.7) delta = 1;
      else if (acc < 0.4) delta = -1;
      if (delta !== 0) {
        await p.query(
          `UPDATE seko_users SET level = GREATEST(1, level + $1), updated_at=now() WHERE user_email = $2`,
          [delta, req.user.email]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// オーナー専用: seko_questions プール全消し (デバッグ用)
app.post("/api/seko/wipe-all", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!KOTONOHA_OWNER_EMAILS.has(String(req.user.email || "").toLowerCase())) {
    return res.status(403).json({ error: "owner only" });
  }
  try {
    await p.query(`TRUNCATE seko_questions CASCADE`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// fx-bot: OANDA + Gemini で AI 自動売買 (1 通貨単位の実弾実験用)
// ============================================================
//
// Cloud Run env で OANDA_API_KEY / OANDA_ACCOUNT_ID を渡す。
// OANDA_ENV=practice/live は fx_settings テーブルで切替できる。
// owner だけが触れる (実弾飛ぶので)。
//
// ENDPOINTS
//  GET  /api/fx/status           - 口座サマリ + 直近 decisions / trades + 設定
//  POST /api/fx/tick             - 手動 tick (owner、即時 1 回判定)
//  POST /api/fx/toggle           - Bot ON/OFF
//  PUT  /api/fx/settings         - 設定変更
//  POST /api/fx/close/:tradeId   - open 中の trade を強制決済
//  POST /api/internal/fx/tick    - Cloud Scheduler 用 (X-Internal-Token 認証)
//
const FX_OWNER_EMAILS = new Set(
  String(process.env.FX_OWNER_EMAILS || process.env.KOTONOHA_OWNER_EMAILS || "")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);

function isFxOwner(email) {
  if (!email) return false;
  if (FX_OWNER_EMAILS.size === 0) return false;
  return FX_OWNER_EMAILS.has(String(email).toLowerCase());
}

function requireFxOwner(req, res) {
  if (!isFxOwner(req.user?.email)) {
    res.status(403).json({ error: "fx-bot は owner のみ" });
    return false;
  }
  return true;
}

async function fxLoadSettings(p) {
  const { rows } = await p.query(`SELECT * FROM fx_settings WHERE id = 1`);
  return rows[0] || {};
}

function fxOandaCtx(settings) {
  const apiKey = process.env.OANDA_API_KEY;
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!apiKey || !accountId) throw new Error("OANDA_API_KEY / OANDA_ACCOUNT_ID 未設定");
  const env = settings.oanda_env === "live" ? "live" : "practice";
  const baseUrl = env === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
  return { apiKey, accountId, env, baseUrl };
}

// 直近 N 件の trades (closed) を DB から
async function fxCountTradesToday(p) {
  const { rows } = await p.query(
    `SELECT count(*)::int AS n FROM fx_trades
      WHERE kind = 'opened' AND created_at >= date_trunc('day', now())`
  );
  return rows[0]?.n || 0;
}

async function fxRecentClosedPnls(p, n) {
  const { rows } = await p.query(
    `SELECT pnl, closed_at FROM fx_trades
      WHERE kind = 'closed' AND closed_at IS NOT NULL
      ORDER BY closed_at DESC LIMIT $1`,
    [n]
  );
  return rows;
}

async function fxRiskCheck(p, settings, { decision, confidence }) {
  if (decision === "PASS") return { ok: false, reason: "AI が PASS" };
  if (confidence < Number(settings.confidence_threshold || 0.7)) {
    return { ok: false, reason: `confidence ${confidence.toFixed(2)} < 閾値 ${settings.confidence_threshold}` };
  }
  const todayCount = await fxCountTradesToday(p);
  if (todayCount >= Number(settings.max_trades_per_day || 20)) {
    return { ok: false, reason: `1日上限 ${settings.max_trades_per_day} (今日 ${todayCount})` };
  }
  const n = Number(settings.cooldown_after_losses || 0);
  if (n > 0) {
    const recent = await fxRecentClosedPnls(p, n);
    if (recent.length >= n && recent.every((t) => Number(t.pnl) < 0)) {
      const lastAt = new Date(recent[0].closed_at).getTime();
      const sinceMin = (Date.now() - lastAt) / 60000;
      const cd = Number(settings.cooldown_minutes || 60);
      if (sinceMin < cd) {
        return { ok: false, reason: `連敗 ${n} クールダウン (残り ${Math.round(cd - sinceMin)} 分)` };
      }
    }
  }
  return { ok: true, units: Number(settings.units_per_trade || 1) };
}

// 1 tick: 観測 → AI → リスク → 発注 → DB ログ
async function runFxTick(p) {
  const settings = await fxLoadSettings(p);
  if (!settings.bot_enabled) return { skipped: true, reason: "Bot OFF" };
  const ctx = fxOandaCtx(settings);
  const instrument = settings.instrument || "USD_JPY";
  const granularity = settings.granularity || "M5";

  // 既に open のものがあれば skip
  const opens = await fxOanda.getOpenTrades(ctx, instrument);
  if (opens.length > 0) {
    const r = { skipped: true, reason: `open ${opens.length} 件あり` };
    await p.query(
      `INSERT INTO fx_decisions (instrument, granularity, skipped, skip_reason, decision)
       VALUES ($1, $2, true, $3, 'PASS')`,
      [instrument, granularity, r.reason]
    );
    return r;
  }

  // closed trade を DB に同期 (last closed 以降)
  try {
    const { rows: lastClosed } = await p.query(
      `SELECT closed_at FROM fx_trades WHERE kind='closed' ORDER BY closed_at DESC LIMIT 1`
    );
    const sinceIso = lastClosed[0]?.closed_at?.toISOString?.() || new Date(Date.now() - 86400000).toISOString();
    const closed = await fxOanda.fetchRecentClosedTrades(ctx, sinceIso);
    for (const t of closed) {
      const dup = await p.query(`SELECT 1 FROM fx_trades WHERE oanda_trade_id = $1`, [t.id]);
      if (dup.rowCount > 0) continue;
      await p.query(
        `INSERT INTO fx_trades (kind, instrument, side, units, entry_price, close_price, pnl,
                                 oanda_trade_id, opened_at, closed_at)
         VALUES ('closed', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          t.instrument,
          Number(t.initialUnits) > 0 ? "LONG" : "SHORT",
          Math.abs(Number(t.initialUnits)),
          Number(t.price),
          Number(t.averageClosePrice || t.price),
          Number(t.realizedPL || 0),
          t.id,
          t.openTime,
          t.closeTime,
        ]
      );
    }
  } catch (e) { console.warn("[fx] closed sync failed:", e.message); }

  // 観測
  const candles = await fxOanda.fetchCandles(ctx, instrument, granularity, Number(settings.candle_count || 100));
  if (candles.length < 50) return { skipped: true, reason: `candle 不足 ${candles.length}` };

  // 戦略で判断 (決定的アルゴ。ai_vision を選んだ時だけ Gemini を呼ぶ)
  const strategy = settings.active_strategy || "ema_crossover";
  const strategyParams = settings.strategy_params || {};
  const ctxStrat = {
    callGemini: callGeminiWithFallback,
    buildChartSummary: fxBuildChart,
    aiDecide: fxDecide,
    granularity,
  };
  const decision = await fxRunStrategy(strategy, candles, strategyParams, instrument, ctxStrat);
  const lastClose = candles[candles.length - 1].c;
  await p.query(
    `INSERT INTO fx_decisions (instrument, granularity, last_close, decision, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [instrument, granularity, lastClose, decision.decision, decision.confidence, decision.reasoning]
  );

  // リスクチェック
  const judge = await fxRiskCheck(p, settings, decision);
  if (!judge.ok) return { skipped: true, reason: judge.reason, decision };

  // 発注
  let order;
  try {
    order = await fxOanda.placeMarketWithOCO(ctx, {
      instrument,
      side: decision.decision,
      units: judge.units,
      takeProfitPips: Number(settings.take_profit_pips || 10),
      stopLossPips: Number(settings.stop_loss_pips || 10),
    });
  } catch (e) {
    await p.query(
      `INSERT INTO fx_trades (kind, instrument, side, units, error, confidence, reasoning)
       VALUES ('order_failed', $1, $2, $3, $4, $5, $6)`,
      [instrument, decision.decision, judge.units, e.message, decision.confidence, decision.reasoning]
    );
    return { skipped: true, reason: "発注失敗: " + e.message, decision };
  }
  await p.query(
    `INSERT INTO fx_trades (kind, instrument, side, units, entry_price, tp_price, sl_price,
                             confidence, reasoning, oanda_order_id, oanda_fill_id, opened_at)
     VALUES ('opened', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      instrument, decision.decision, judge.units,
      order.fillPrice, order.tp, order.sl,
      decision.confidence, decision.reasoning,
      order.orderId, order.fillId,
    ]
  );
  return {
    placed: true, side: decision.decision,
    fill_price: order.fillPrice, tp: order.tp, sl: order.sl,
    confidence: decision.confidence, reasoning: decision.reasoning,
  };
}

// ───── endpoints ─────

app.get("/api/fx/status", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const settings = await fxLoadSettings(p);
    let summary = null, openTrades = [];
    try {
      const ctx = fxOandaCtx(settings);
      summary = await fxOanda.getAccountSummary(ctx);
      openTrades = await fxOanda.getOpenTrades(ctx);
    } catch (e) { console.warn("[fx] OANDA status fetch failed:", e.message); }
    const { rows: decisions } = await p.query(
      `SELECT id, instrument, granularity, last_close, decision, confidence, reasoning,
              skipped, skip_reason, created_at
         FROM fx_decisions ORDER BY id DESC LIMIT 30`
    );
    const { rows: trades } = await p.query(
      `SELECT id, kind, instrument, side, units, entry_price, tp_price, sl_price,
              close_price, pnl, confidence, reasoning, oanda_trade_id, error,
              opened_at, closed_at, created_at
         FROM fx_trades ORDER BY id DESC LIMIT 30`
    );
    // 日次 PnL (直近 7 日)
    const { rows: dailyPnl } = await p.query(
      `SELECT date_trunc('day', closed_at AT TIME ZONE 'Asia/Tokyo')::date AS d,
              SUM(pnl)::numeric AS pnl, COUNT(*)::int AS n
         FROM fx_trades
        WHERE kind = 'closed' AND closed_at > now() - interval '7 days'
        GROUP BY d ORDER BY d DESC`
    );
    const { rows: optimizations } = await p.query(
      `SELECT id, analysis, suggestions, reasoning, applied, applied_changes,
              applied_at, rejected, rejected_at, created_at
         FROM fx_optimizations ORDER BY id DESC LIMIT 10`
    );
    res.json({ settings, summary, openTrades, decisions, trades, dailyPnl, optimizations });
  } catch (err) {
    console.error("[fx] status err:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fx/tick", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = await runFxTick(p);
    res.json(r);
  } catch (err) {
    console.error("[fx] tick err:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fx/toggle", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const enabled = !!req.body?.enabled;
  try {
    await p.query(`UPDATE fx_settings SET bot_enabled = $1, updated_at = now() WHERE id = 1`, [enabled]);
    res.json({ ok: true, bot_enabled: enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/fx/settings", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const b = req.body || {};
  // 許可されたフィールドだけ
  const allowed = {
    oanda_env: (v) => (v === "live" || v === "practice"),
    instrument: (v) => typeof v === "string" && v.length <= 16,
    granularity: (v) => typeof v === "string" && v.length <= 8,
    candle_count: (v) => Number.isInteger(v) && v >= 50 && v <= 500,
    units_per_trade: (v) => Number.isInteger(v) && v >= 1 && v <= 10000,
    take_profit_pips: (v) => typeof v === "number" && v > 0 && v <= 200,
    stop_loss_pips: (v) => typeof v === "number" && v > 0 && v <= 200,
    max_trades_per_day: (v) => Number.isInteger(v) && v >= 1 && v <= 200,
    confidence_threshold: (v) => typeof v === "number" && v >= 0 && v <= 1,
    cooldown_after_losses: (v) => Number.isInteger(v) && v >= 0 && v <= 20,
    cooldown_minutes: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
    auto_apply_optimizations: (v) => typeof v === "boolean",
    active_strategy: (v) => typeof v === "string" && /^[a-z_]+$/.test(v) && v.length <= 32,
    strategy_params: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  };
  const updates = [];
  const values = [];
  let i = 1;
  for (const [k, validator] of Object.entries(allowed)) {
    if (b[k] !== undefined && validator(b[k])) {
      updates.push(`${k} = $${i++}`);
      values.push(k === "strategy_params" ? JSON.stringify(b[k]) : b[k]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: "更新対象なし" });
  try {
    await p.query(
      `UPDATE fx_settings SET ${updates.join(", ")}, updated_at = now() WHERE id = 1`,
      values
    );
    const settings = await fxLoadSettings(p);
    res.json({ ok: true, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/fx/close/:tradeId", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const settings = await fxLoadSettings(p);
    const ctx = fxOandaCtx(settings);
    const r = await fxOanda.closeTrade(ctx, req.params.tradeId);
    res.json({ ok: true, raw: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── AI 自動最適化ループ ─────
// 直近 N トレードの成績を Gemini に分析させ、設定変更案を提案 → DB に保存。
// auto_apply_optimizations=true ならガードレール内で自動適用。

async function fxComputeStats(p) {
  const { rows: trades } = await p.query(
    `SELECT id, side, units, entry_price, close_price, pnl, confidence,
            opened_at, closed_at
       FROM fx_trades
      WHERE kind = 'closed' AND closed_at > now() - interval '7 days'
      ORDER BY closed_at DESC LIMIT 100`
  );
  if (!trades.length) return { count: 0 };
  const wins = trades.filter((t) => Number(t.pnl) > 0);
  const losses = trades.filter((t) => Number(t.pnl) < 0);
  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + Number(t.pnl), 0) / losses.length : 0;
  const pf = (losses.length === 0 || avgLoss === 0)
    ? null
    : Math.abs((avgWin * wins.length) / (avgLoss * losses.length));
  // 連続損失の最大長
  let maxConsLoss = 0, cur = 0;
  for (const t of [...trades].reverse()) {
    if (Number(t.pnl) < 0) { cur++; maxConsLoss = Math.max(maxConsLoss, cur); }
    else cur = 0;
  }
  // confidence の平均
  const avgConf = trades.filter((t) => t.confidence != null).length
    ? trades.reduce((s, t) => s + Number(t.confidence || 0), 0) / trades.length
    : null;
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,
    totalPnl,
    avgWin,
    avgLoss,
    profitFactor: pf,
    maxConsLoss,
    avgConfidence: avgConf,
    sampleTrades: trades.slice(0, 30).map((t) => ({
      side: t.side, units: t.units, pnl: Number(t.pnl),
      confidence: t.confidence != null ? Number(t.confidence) : null,
      closed_at: t.closed_at,
    })),
  };
}

async function runFxOptimize(p) {
  const settings = await fxLoadSettings(p);
  const stats = await fxComputeStats(p);
  if (stats.count < 10) {
    return { skipped: true, reason: `分析に必要なトレード数 (10件) に届かず (現在 ${stats.count} 件)` };
  }
  const prompt = `あなたは FX スキャル / デイトレ戦略の最適化アドバイザ。
直近トレードの成績から、現在の戦略設定の調整案を提案してください。

【現在の設定】
- confidence_threshold: ${settings.confidence_threshold} (AI 信頼度の発注閾値)
- take_profit_pips: ${settings.take_profit_pips}
- stop_loss_pips: ${settings.stop_loss_pips}
- units_per_trade: ${settings.units_per_trade}
- max_trades_per_day: ${settings.max_trades_per_day}
- cooldown_after_losses: ${settings.cooldown_after_losses}
- cooldown_minutes: ${settings.cooldown_minutes}

【直近 7 日の成績】
- 取引数: ${stats.count} (勝 ${stats.wins} / 負 ${stats.losses})
- 勝率: ${(stats.winRate * 100).toFixed(1)}%
- 通算損益: ${stats.totalPnl.toFixed(0)} 円
- 平均勝ち: ${stats.avgWin.toFixed(2)}
- 平均負け: ${stats.avgLoss.toFixed(2)}
- プロフィットファクター: ${stats.profitFactor?.toFixed(2) ?? "-"}
- 最大連敗: ${stats.maxConsLoss}
- 平均 confidence: ${stats.avgConfidence?.toFixed(2) ?? "-"}

【調整方針】
- 勝率 50% 未満なら confidence_threshold を上げる方向、RR を見直す
- 平均負けが平均勝ちより大きすぎるなら stop_loss を狭くするか take_profit を広く
- 最大連敗が 3 以上なら cooldown を強化
- 過剰トレードなら max_trades_per_day を下げる
- 提案は 1-3 個に絞り、変更幅は穏当に (±20% 程度)
- 自信のない提案や十分なデータ不足を感じたら suggestions を空 {} にしてよい

JSON でだけ返す (前置きや説明禁止):
{
  "analysis": "1-2 文で現状の評価",
  "suggestions": {
    "confidence_threshold": 0.75,   // 変更不要なら省略
    "take_profit_pips": 12,
    "stop_loss_pips": 8,
    "cooldown_after_losses": 3,
    "cooldown_minutes": 90,
    "max_trades_per_day": 15
  },
  "reasoning": "2-3 文でなぜこの変更案にしたか"
}`;
  let parsed;
  try {
    const { result } = await callGeminiWithFallback(prompt, {
      primaryModel: "gemini-2.5-flash",
      maxOutputTokens: 1500,
      jsonMode: true,
    });
    const text = (result.response.text() || "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI 応答 JSON 取れず");
    parsed = JSON.parse(m[0]);
  } catch (e) {
    return { error: e.message };
  }

  const suggestions = (parsed.suggestions && typeof parsed.suggestions === "object") ? parsed.suggestions : {};
  const ins = await p.query(
    `INSERT INTO fx_optimizations (stats, analysis, suggestions, reasoning)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [JSON.stringify(stats), String(parsed.analysis || "").slice(0, 1000),
     JSON.stringify(suggestions), String(parsed.reasoning || "").slice(0, 2000)]
  );
  const opt = ins.rows[0];

  // ガードレール付きで auto-apply
  let appliedChanges = null;
  if (settings.auto_apply_optimizations && Object.keys(suggestions).length) {
    appliedChanges = await fxApplyOptimizationSafe(p, settings, suggestions);
    if (appliedChanges && Object.keys(appliedChanges).length) {
      await p.query(
        `UPDATE fx_optimizations SET applied=true, applied_at=now(), applied_changes=$1 WHERE id=$2`,
        [JSON.stringify(appliedChanges), opt.id]
      );
    }
  }
  return { optimization: opt, appliedChanges };
}

// 自動適用時のセーフガード:
// - 数値は ±20% 以内のみ受理 (急変防止)
// - confidence_threshold: 0.5-0.95 にクリップ
// - units_per_trade は減方向のみ (増は手動)
// - oanda_env / instrument の変更は受理しない
async function fxApplyOptimizationSafe(p, cur, sug) {
  const applied = {};
  const numKey = (k, min, max) => {
    if (sug[k] == null) return;
    const newV = Number(sug[k]);
    const curV = Number(cur[k]);
    if (!Number.isFinite(newV) || !Number.isFinite(curV)) return;
    const bounded = Math.max(min, Math.min(max, newV));
    const within20pct = bounded >= curV * 0.8 && bounded <= curV * 1.2;
    if (within20pct && Math.abs(bounded - curV) / Math.max(1e-6, curV) > 0.02) {
      applied[k] = bounded;
    }
  };
  numKey("confidence_threshold", 0.5, 0.95);
  numKey("take_profit_pips", 1, 100);
  numKey("stop_loss_pips", 1, 100);
  numKey("cooldown_minutes", 5, 720);

  if (sug.cooldown_after_losses != null) {
    const v = Number(sug.cooldown_after_losses);
    if (Number.isInteger(v) && v >= 0 && v <= 10) applied.cooldown_after_losses = v;
  }
  if (sug.max_trades_per_day != null) {
    const v = Number(sug.max_trades_per_day);
    const cv = Number(cur.max_trades_per_day);
    if (Number.isInteger(v) && v >= 1 && v <= 100 && v <= cv * 1.2 && v >= cv * 0.8) {
      applied.max_trades_per_day = v;
    }
  }
  if (sug.units_per_trade != null) {
    // 減方向のみ自動適用
    const v = Math.floor(Number(sug.units_per_trade));
    if (v >= 1 && v < Number(cur.units_per_trade)) applied.units_per_trade = v;
  }

  if (!Object.keys(applied).length) return applied;

  const fields = Object.keys(applied);
  const values = fields.map((k) => applied[k]);
  const sets = fields.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await p.query(`UPDATE fx_settings SET ${sets}, updated_at = now() WHERE id = 1`, values);
  return applied;
}

app.post("/api/fx/optimize", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = await runFxOptimize(p);
    res.json(r);
  } catch (err) {
    console.error("[fx] optimize err:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fx/optimize/:id/apply", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(`SELECT * FROM fx_optimizations WHERE id = $1`, [req.params.id]);
    const opt = rows[0];
    if (!opt) return res.status(404).json({ error: "not found" });
    if (opt.applied) return res.status(400).json({ error: "既に適用済" });
    if (opt.rejected) return res.status(400).json({ error: "却下済" });
    const settings = await fxLoadSettings(p);
    const applied = await fxApplyOptimizationSafe(p, settings, opt.suggestions || {});
    await p.query(
      `UPDATE fx_optimizations SET applied=true, applied_at=now(), applied_changes=$1 WHERE id=$2`,
      [JSON.stringify(applied), opt.id]
    );
    res.json({ ok: true, applied });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/fx/optimize/:id/reject", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query(
      `UPDATE fx_optimizations SET rejected=true, rejected_at=now() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/internal/fx/optimize", async (req, res) => {
  const tok = req.get("X-Internal-Token") || "";
  if (!process.env.INTERNAL_TICK_TOKEN || tok !== process.env.INTERNAL_TICK_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = await runFxOptimize(p);
    res.json(r);
  } catch (err) {
    console.error("[fx] internal optimize err:", err);
    res.status(500).json({ error: err.message });
  }
});

// ───── バックテスト (過去 candle で AI 判断を再生) ─────
// AI の予測 → 次 N 本での TP/SL シミュレーション → conf bucket 別の win rate 集計。
// 学習データを「実弾を待たずに高速に貯める」目的。
function fxPipSize(instrument) {
  return instrument.endsWith("_JPY") ? 0.01 : 0.0001;
}

const _fxBacktestRunning = new Set();

async function runFxBacktest(p, btId, preloadedCandles) {
  if (_fxBacktestRunning.has(btId)) return;
  _fxBacktestRunning.add(btId);
  try {
    const { rows } = await p.query(`SELECT * FROM fx_backtests WHERE id=$1`, [btId]);
    const bt = rows[0];
    if (!bt) return;

    // candle: 引数で渡されてれば CSV 経路、無ければ OANDA API から取得
    let candles;
    if (preloadedCandles && preloadedCandles.length) {
      candles = preloadedCandles;
      await p.query(
        `UPDATE fx_backtests SET status='running', candle_count=$1 WHERE id=$2`,
        [candles.length, btId]
      );
    } else {
      const settings = await fxLoadSettings(p);
      const ctx = fxOandaCtx(settings);
      await p.query(`UPDATE fx_backtests SET status='fetching' WHERE id=$1`, [btId]);
      const fromIso = new Date(bt.from_time).toISOString();
      const toIso = new Date(bt.to_time).toISOString();
      candles = await fxOanda.fetchHistoricalCandles(ctx, bt.instrument, bt.granularity, fromIso, toIso);
      await p.query(
        `UPDATE fx_backtests SET status='running', candle_count=$1 WHERE id=$2`,
        [candles.length, btId]
      );
    }

    const WINDOW = 50;
    const FUTURE = 12;
    const SAMPLE = Math.max(1, Number(bt.sample_rate) || 5);
    const pip = fxPipSize(bt.instrument);
    const thresh = Number(bt.confidence_threshold);
    const tpPips = Number(bt.tp_pips);
    const slPips = Number(bt.sl_pips);

    let predictions = 0, pass = 0, longCnt = 0, shortCnt = 0;
    let taken = 0, wins = 0, losses = 0, timeouts = 0;
    let totalPnl = 0;
    const buckets = {}; // "0.5-0.6": { n, w, l, t, pnl }
    const recordBucket = (conf, hitTp, hitSl, tookIt, pnl) => {
      const b = Math.floor(Math.min(0.99, Math.max(0, conf)) * 10) / 10;
      const key = `${b.toFixed(1)}-${(b + 0.1).toFixed(1)}`;
      const slot = buckets[key] || (buckets[key] = { n: 0, w: 0, l: 0, t: 0, pnl: 0 });
      slot.n++;
      if (tookIt) slot.t++;
      if (tookIt && hitTp) slot.w++;
      if (tookIt && hitSl) slot.l++;
      if (tookIt) slot.pnl += pnl;
    };

    // walk forward
    const strategy = bt.strategy_name || "ema_crossover";
    const strategyParams = bt.strategy_params || {};
    const ctxStrat = {
      callGemini: callGeminiWithFallback,
      buildChartSummary: fxBuildChart,
      aiDecide: fxDecide,
      granularity: bt.granularity,
    };
    const costPips = Number(bt.cost_pips ?? 1.0);
    const halfCost = costPips / 2;
    for (let i = WINDOW; i < candles.length - FUTURE; i += SAMPLE) {
      // シグナル window = candles[i-WINDOW..i-1] (day i-1 末でシグナル決定)
      const window = candles.slice(i - WINDOW, i);
      // entry = candles[i].open (day i 寄り。シグナル後最初に入手可能な価格、look-ahead bias 回避)
      const entry = candles[i].o;
      // future = candles[i..i+FUTURE-1] (entry 後の値動き)
      const future = candles.slice(i, i + FUTURE);

      const decision = await fxRunStrategy(strategy, window, strategyParams, bt.instrument, ctxStrat);

      let hitTp = false, hitSl = false, exitPrice = null, barsToExit = null;
      // TP/SL 閾値: コスト分シフト (entry slip で SL は早めに、TP は遠めに)
      if (decision.decision === "LONG") {
        const tp = entry + (tpPips + halfCost) * pip;
        const sl = entry - (slPips - halfCost) * pip;
        for (let j = 0; j < future.length; j++) {
          const tpTouch = future[j].h >= tp;
          const slTouch = future[j].l <= sl;
          // 同バーで両方 → pessimistic に SL 優先
          if (tpTouch && slTouch) { hitSl = true; exitPrice = sl; barsToExit = j + 1; break; }
          if (tpTouch)            { hitTp = true; exitPrice = tp; barsToExit = j + 1; break; }
          if (slTouch)            { hitSl = true; exitPrice = sl; barsToExit = j + 1; break; }
        }
      } else if (decision.decision === "SHORT") {
        const tp = entry - (tpPips + halfCost) * pip;
        const sl = entry + (slPips - halfCost) * pip;
        for (let j = 0; j < future.length; j++) {
          const tpTouch = future[j].l <= tp;
          const slTouch = future[j].h >= sl;
          if (tpTouch && slTouch) { hitSl = true; exitPrice = sl; barsToExit = j + 1; break; }
          if (tpTouch)            { hitTp = true; exitPrice = tp; barsToExit = j + 1; break; }
          if (slTouch)            { hitSl = true; exitPrice = sl; barsToExit = j + 1; break; }
        }
      }
      // PASS は exit なし

      const wouldTake = decision.decision !== "PASS" && decision.confidence >= thresh;
      let pnlPips = 0;
      if (wouldTake) {
        taken++;
        if (hitTp) { wins++; pnlPips = tpPips - costPips; }
        else if (hitSl) { losses++; pnlPips = -slPips - costPips; }
        else {
          // 時間切れ: future 最終 close で決済 (cost 込み)
          timeouts++;
          const closeP = future[future.length - 1].c;
          const grossPips = decision.decision === "LONG"
            ? (closeP - entry) / pip
            : (entry - closeP) / pip;
          pnlPips = grossPips - costPips;
          exitPrice = closeP;
          barsToExit = future.length;
        }
        totalPnl += pnlPips;
      }
      if (decision.decision === "LONG") longCnt++;
      else if (decision.decision === "SHORT") shortCnt++;
      else pass++;
      recordBucket(decision.confidence, hitTp, hitSl, wouldTake, pnlPips);

      await p.query(
        `INSERT INTO fx_backtest_predictions
           (backtest_id, candle_time, decision, confidence, reasoning, entry_price,
            hit_tp, hit_sl, exit_price, pnl_pips, bars_to_exit, taken)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [btId, candles[i].time, decision.decision, decision.confidence,
         decision.reasoning?.slice(0, 500), entry,
         hitTp, hitSl, exitPrice, pnlPips, barsToExit, wouldTake]
      );

      predictions++;
      if (predictions % 50 === 0) {
        await p.query(`UPDATE fx_backtests SET progress=$1 WHERE id=$2`, [predictions, btId]);
      }
      // 決定的戦略は sleep 不要、AI 戦略のみ rate limit 緩和
      if (strategy === "ai_vision") await new Promise((r) => setTimeout(r, 50));
    }

    const wr = taken > 0 ? wins / taken : 0;
    const pf = losses > 0 ? (wins * tpPips) / (losses * slPips) : null;
    await p.query(
      `UPDATE fx_backtests SET
         status='done', progress=$1, total_predictions=$1,
         pass_count=$2, long_count=$3, short_count=$4,
         trades_taken=$5, wins=$6, losses=$7, timeouts=$8,
         total_pnl_pips=$9, win_rate=$10, profit_factor=$11,
         conf_buckets=$12, finished_at=now()
       WHERE id=$13`,
      [predictions, pass, longCnt, shortCnt, taken, wins, losses, timeouts,
       totalPnl, wr, pf, JSON.stringify(buckets), btId]
    );
  } catch (e) {
    console.error("[fx-bt] err:", e);
    await p.query(
      `UPDATE fx_backtests SET status='error', error=$1, finished_at=now() WHERE id=$2`,
      [String(e.message || e).slice(0, 500), btId]
    );
  } finally {
    _fxBacktestRunning.delete(btId);
  }
}

app.post("/api/fx/backtest", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const b = req.body || {};
  const instrument = (b.instrument || "USD_JPY").toUpperCase();
  const granularity = b.granularity || "M5";
  const tpPips = Math.max(1, Math.min(100, Number(b.tp_pips) || 10));
  const slPips = Math.max(1, Math.min(100, Number(b.sl_pips) || 10));
  const ct = Math.max(0, Math.min(1, Number(b.confidence_threshold) || 0.7));
  const sampleRate = Math.max(1, Math.min(60, Number(b.sample_rate) || 5));

  // データソース: CSV が来てればそれ、無ければ OANDA API
  let preloadedCandles = null;
  let fromTime, toTime;
  if (typeof b.csv === "string" && b.csv.trim()) {
    try {
      preloadedCandles = fxParseCsv(b.csv);
    } catch (e) {
      return res.status(400).json({ error: "CSV パース失敗: " + e.message });
    }
    if (preloadedCandles.length < 60) {
      return res.status(400).json({ error: `candle 不足 (${preloadedCandles.length} 行)。最低 60 行必要` });
    }
    if (preloadedCandles.length > 50000) {
      return res.status(400).json({ error: "candle 過多 (50000 行上限)" });
    }
    fromTime = new Date(preloadedCandles[0].time);
    toTime = new Date(preloadedCandles[preloadedCandles.length - 1].time);
  } else {
    const days = Math.max(1, Math.min(30, Number(b.days) || 7));
    toTime = new Date();
    fromTime = new Date(Date.now() - days * 86400000);
  }

  // 戦略選択
  const strategy = String(b.strategy || "ema_crossover");
  const stratParams = (b.strategy_params && typeof b.strategy_params === "object") ? b.strategy_params : {};
  const costPips = Math.max(0, Math.min(10, Number(b.cost_pips ?? 1.0)));

  // ai_vision の場合は sample_rate を最小 20 に強制 (コスト爆発防止)
  const effSample = strategy === "ai_vision" ? Math.max(20, sampleRate) : sampleRate;

  try {
    const ins = await p.query(
      `INSERT INTO fx_backtests
         (instrument, granularity, from_time, to_time, tp_pips, sl_pips,
          confidence_threshold, sample_rate, status, strategy_name, strategy_params, cost_pips)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11) RETURNING id`,
      [instrument, granularity, fromTime.toISOString(), toTime.toISOString(),
       tpPips, slPips, ct, effSample, strategy, JSON.stringify(stratParams), costPips]
    );
    const btId = Number(ins.rows[0].id);
    runFxBacktest(p, btId, preloadedCandles).catch((e) => console.error("[fx-bt] runner err:", e));
    res.json({ id: btId, status: "queued", source: preloadedCandles ? "csv" : "oanda", candles: preloadedCandles?.length, strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/fx/strategies", (req, res) => {
  if (!requireFxOwner(req, res)) return;
  res.json({ strategies: fxStrategyList() });
});

app.get("/api/fx/backtests", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, instrument, granularity, from_time, to_time, tp_pips, sl_pips,
              confidence_threshold, sample_rate, status, progress, candle_count,
              total_predictions, trades_taken, wins, losses, timeouts,
              total_pnl_pips, profit_factor, win_rate, conf_buckets,
              strategy_name, strategy_params, cost_pips,
              error, created_at, finished_at
         FROM fx_backtests ORDER BY id DESC LIMIT 20`
    );
    res.json({ backtests: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/fx/backtest/:id", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: btRows } = await p.query(`SELECT * FROM fx_backtests WHERE id=$1`, [req.params.id]);
    if (!btRows.length) return res.status(404).json({ error: "not found" });
    const { rows: preds } = await p.query(
      `SELECT candle_time, decision, confidence, entry_price, hit_tp, hit_sl,
              exit_price, pnl_pips, bars_to_exit, taken, reasoning
         FROM fx_backtest_predictions WHERE backtest_id=$1
        ORDER BY candle_time DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ backtest: btRows[0], predictions: preds });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// バックテスト結果を AI に投げて設定校正案を作る
app.post("/api/fx/backtest/:id/optimize", async (req, res) => {
  if (!requireFxOwner(req, res)) return;
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(`SELECT * FROM fx_backtests WHERE id=$1`, [req.params.id]);
    const bt = rows[0];
    if (!bt) return res.status(404).json({ error: "not found" });
    if (bt.status !== "done") return res.status(400).json({ error: "backtest 未完了" });
    const settings = await fxLoadSettings(p);

    const prompt = `バックテスト結果から、戦略設定の校正案を作ってください。

【バックテスト】
- 通貨ペア: ${bt.instrument}
- 粒度: ${bt.granularity}
- 期間: ${bt.from_time} 〜 ${bt.to_time}
- TP: ${bt.tp_pips} pips / SL: ${bt.sl_pips} pips
- 現在の confidence 閾値: ${bt.confidence_threshold}

【総合成績】
- 予測数: ${bt.total_predictions}
- 採用 (閾値以上): ${bt.trades_taken} / 勝 ${bt.wins} / 負 ${bt.losses} / 時間切れ ${bt.timeouts}
- 勝率: ${(Number(bt.win_rate) * 100).toFixed(1)}%
- PF: ${bt.profit_factor ?? "-"}
- 通算 pips: ${bt.total_pnl_pips}

【confidence bucket 別】
${JSON.stringify(bt.conf_buckets, null, 2)}

【現在の本番設定】
- confidence_threshold: ${settings.confidence_threshold}
- take_profit_pips: ${settings.take_profit_pips}
- stop_loss_pips: ${settings.stop_loss_pips}

【方針】
- conf_buckets の win rate が最も高い帯を読み取り、その閾値を提案する
- 全 bucket で win rate < 50% なら戦略を疑い "suggestions" を空 {} にして reasoning に明記
- TP/SL の比率: PF が低いなら TP を伸ばす or SL を狭める案を 1 つだけ
- 変更幅は ±20% 程度の穏当な範囲

JSON でだけ返す:
{
  "analysis": "結果の要約 (1-2 文)",
  "suggestions": {
    "confidence_threshold": 0.75,
    "take_profit_pips": 12,
    "stop_loss_pips": 8
  },
  "reasoning": "なぜこの校正案にしたか (2-3 文、bucket データ根拠を含める)"
}`;
    let parsed;
    try {
      const { result } = await callGeminiWithFallback(prompt, {
        primaryModel: "gemini-2.5-flash",
        maxOutputTokens: 1500,
        jsonMode: true,
      });
      const text = (result.response.text() || "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI 応答 JSON 取れず");
      parsed = JSON.parse(m[0]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    const suggestions = (parsed.suggestions && typeof parsed.suggestions === "object") ? parsed.suggestions : {};
    const ins = await p.query(
      `INSERT INTO fx_optimizations (stats, analysis, suggestions, reasoning)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [JSON.stringify({ source: "backtest", backtest_id: bt.id, win_rate: bt.win_rate, pf: bt.profit_factor, conf_buckets: bt.conf_buckets }),
       String(parsed.analysis || "").slice(0, 1000),
       JSON.stringify(suggestions),
       String(parsed.reasoning || "").slice(0, 2000)]
    );
    res.json({ optimization: ins.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cloud Scheduler 用 internal endpoint。X-Internal-Token で簡易認証。
app.post("/api/internal/fx/tick", async (req, res) => {
  const tok = req.get("X-Internal-Token") || "";
  if (!process.env.INTERNAL_TICK_TOKEN || tok !== process.env.INTERNAL_TICK_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const r = await runFxTick(p);
    res.json(r);
  } catch (err) {
    console.error("[fx] internal tick err:", err);
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

// ─────────────────────────────
// 自動ドラマ作成 (auto-drama)
// ─────────────────────────────

// ── API コスト記録 (プロジェクト別。料金改定時はここの定数を直す) ──
const DRAMA_USD_JPY = 155; // 概算レート
// Gemini 料金 (USD / 1M tokens): [input, output]
const DRAMA_GEMINI_PRICES = {
  "gemini-2.5-flash":      [0.30, 2.50],
  "gemini-2.5-flash-lite": [0.10, 0.40],
  "gemini-flash-latest":   [0.30, 2.50],
};
// Seedance 2.0 fast 720p: 動画トークン = 幅×高×fps×秒 / 1024。
// 720×1280×24fps → 21,600 tokens/秒。$5.6/1M tokens (保守側=高い方の掲示額) で概算。
// → 約 ¥19/秒、8 秒カットで ¥150 前後。
const DRAMA_SEEDANCE_TOKENS_PER_SEC = Math.round((720 * 1280 * 24) / 1024);
const DRAMA_SEEDANCE_USD_PER_1M = 5.6;

function dramaRecordUsage(row) {
  const p = getPool();
  if (!p) return;
  p.query(
    `INSERT INTO drama_api_usage (project_id, provider, kind, model, input_tokens, output_tokens, video_seconds, cost_yen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.projectId || null, row.provider, row.kind, row.model || null,
     row.inputTokens ?? null, row.outputTokens ?? null, row.videoSeconds ?? null, row.costYen || 0]
  ).catch((e) => console.warn("[drama] usage record failed:", e.message));
}

// callGeminiWithFallback 互換のラッパー: 呼んだ後にトークン実測からコストを記録する。
// drama-lib には「呼び出し関数を inject する」設計なので、これを渡すだけで全calls が追跡される。
function dramaTrackedGemini(projectId, kind) {
  return async (content, opts) => {
    const r = await callGeminiWithFallback(content, opts);
    try {
      const u = r.result?.response?.usageMetadata || {};
      const model = r.modelUsed || opts?.primaryModel || "gemini-2.5-flash";
      const [inP, outP] = DRAMA_GEMINI_PRICES[model] || DRAMA_GEMINI_PRICES["gemini-2.5-flash"];
      const inTok = u.promptTokenCount || 0;
      const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
      const costYen = ((inTok * inP + outTok * outP) / 1e6) * DRAMA_USD_JPY;
      dramaRecordUsage({ projectId, provider: "gemini", kind, model, inputTokens: inTok, outputTokens: outTok, costYen });
    } catch (_) {}
    return r;
  };
}

function dramaRecordSeedanceUsage(projectId, seconds, model) {
  const tokens = DRAMA_SEEDANCE_TOKENS_PER_SEC * seconds;
  const costYen = (tokens * DRAMA_SEEDANCE_USD_PER_1M / 1e6) * DRAMA_USD_JPY;
  dramaRecordUsage({ projectId, provider: "seedance", kind: "video", model, videoSeconds: seconds, costYen });
}

// 絵コンテ用の静止画生成 (Gemini image)。動画 ¥150 を撃つ前に ¥6 で構図確認する用。
// 旧 SDK が画像出力の generationConfig に対応していないため REST 直叩き。
const DRAMA_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const DRAMA_GEMINI_IMAGE_YEN = 6; // 1 枚 ≈ $0.039
// refParts: 絵柄を寄せるための参照画像 (inlineData 配列)。作画基準画像・添付画像・
// キャラ参照画像を渡す。文章だけで絵柄を再現させると毎回ガチャになるため必須。
// opts.refNote: 参照画像の扱いの指示 (既定は「絵柄基準としてそのまま使う」)
// opts.aspectRatio: "9:16" 等。テキストでの縦横指定は無視されがちなので API 設定で強制
async function dramaGenerateImage(prompt, refParts = [], opts = {}) {
  if (!GEMINI_API_KEY) throw new Error("Gemini not configured");
  const refNote = opts.refNote
    || "添付画像は絵柄・キャラデザインの基準。新しい絵柄を発明せず、添付のキャラクター・タッチ・線の質感・塗りをそのまま使って、指示のシーンに描き直すこと。ただし参照がキャラクターシートや資料の場合、そのレイアウト・枠・注釈文字・指示に関係ない他のキャラクターを画面に入れてはいけない (シートを作れという指示の場合を除く)。出力は指示された 1 シーンの画のみ";
  // 参照画像の合計サイズを制限 (base64 で ~8MB 超のペイロードは Gemini の
  // Internal error 率が跳ね上がる。優先度順に入るだけ入れて、超えた分は落とす)
  const MAX_REF_B64_CHARS = 8_000_000;
  const trimmedRefs = [];
  let refBytes = 0;
  for (const rp of refParts) {
    const len = rp.inlineData?.data?.length || 0;
    if (refBytes + len > MAX_REF_B64_CHARS) { console.warn("[drama] ref image dropped (size cap)"); continue; }
    refBytes += len;
    trimmedRefs.push(rp);
  }
  const text = trimmedRefs.length ? `${prompt}\n\n(${refNote})` : prompt;
  const generationConfig = { responseModalities: ["TEXT", "IMAGE"] };
  if (opts.aspectRatio) generationConfig.imageConfig = { aspectRatio: opts.aspectRatio };
  const body = JSON.stringify({
    contents: [{ parts: [{ text }, ...trimmedRefs] }],
    generationConfig,
  });

  // Gemini 画像 API は一過性の 500 (Internal error) がそこそこ出るため 3 回まで再試行
  // (テキスト側の callGeminiWithFallback と同じ流儀。実際にチャットで一発失敗が起きた)
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${DRAMA_GEMINI_IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "content-type": "application/json" }, body }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = j?.error?.message || `image gen HTTP ${res.status}`;
        const transient = /\b(500|503|429)\b|INTERNAL|UNAVAILABLE|overload|rate limit|Internal error/i.test(`${res.status} ${msg}`);
        if (!transient) throw Object.assign(new Error(msg), { permanent: true });
        lastErr = new Error(msg);
      } else {
        const parts = j.candidates?.[0]?.content?.parts || [];
        const img = parts.find((pp) => pp.inlineData?.data);
        if (img) return { data: img.inlineData.data, mimeType: img.inlineData.mimeType || "image/png" };
        // 画像なし応答 (テキストだけ返る等) も一過性のことがある → 再試行対象
        lastErr = new Error("画像が返りませんでした: " + (parts.find((pp) => pp.text)?.text || "").slice(0, 100));
      }
    } catch (e) {
      if (e.permanent) throw e;
      lastErr = e; // ネットワーク断等も再試行
    }
    if (attempt < 3) {
      const wait = 800 * 2 ** attempt;
      console.warn(`[drama] image gen attempt ${attempt} failed (${String(lastErr?.message).slice(0, 80)}), retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
// 状態は毎回 DB の実データから再計算して保存する (episode.state はキャッシュ扱い)。
async function dramaRecomputeState(p, episodeId) {
  const { rows } = await p.query(`SELECT key_visual AS "keyVisual" FROM drama_episodes WHERE id=$1`, [episodeId]);
  if (!rows.length) return;
  const { rows: cuts } = await p.query(
    `SELECT generations, selected_generation_index AS "selectedGenerationIndex" FROM drama_cuts WHERE episode_id=$1`,
    [episodeId]
  );
  const { rows: tl } = await p.query(
    `SELECT exported_video_url AS "exportedVideoUrl" FROM drama_timelines WHERE episode_id=$1`, [episodeId]
  );
  const newState = recomputeEpisodeState(rows[0], cuts, tl[0]);
  await p.query(`UPDATE drama_episodes SET state=$1 WHERE id=$2`, [newState, episodeId]);
}

app.get("/api/drama/projects", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const { rows } = await p.query(
      `SELECT p.id, p.title, p.author, p.world_setting AS "worldSetting", p.style_guide AS "styleGuide",
              p.default_video_model AS "defaultVideoModel", p.created_by AS "createdBy",
              p.created_at AS "createdAt", p.updated_at AS "updatedAt",
              COALESCE(u.cost, 0)::float AS "costYen"
         FROM drama_projects p
         LEFT JOIN (SELECT project_id, SUM(cost_yen) AS cost FROM drama_api_usage GROUP BY project_id) u
           ON u.project_id = p.id
        ORDER BY p.updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("[drama] projects list", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/drama/projects", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await ensureSchema();
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "title is required" });
    const { rows } = await p.query(
      `INSERT INTO drama_projects (title, author, source_text, world_setting, style_guide, default_video_model, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.title, b.author || null, b.sourceText || null, b.worldSetting || null, b.styleGuide || null,
       b.defaultVideoModel || "seedance-2.0-fast", req.user?.email || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[drama] project create", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/drama/projects/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, title, author, source_text AS "sourceText", world_setting AS "worldSetting",
              style_guide AS "styleGuide", default_video_model AS "defaultVideoModel", ai_notes AS "aiNotes",
              style_ref_images AS "styleRefImages",
              created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM drama_projects WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const { rows: characters } = await p.query(
      `SELECT id, name, reading, description, appearance_prompt AS "appearancePrompt",
              identity_tokens AS "identityTokens", reference_images AS "referenceImages", status
         FROM drama_characters WHERE project_id=$1 ORDER BY id`,
      [req.params.id]
    );
    const { rows: locations } = await p.query(
      `SELECT id, name, description, appearance_prompt AS "appearancePrompt",
              identity_tokens AS "identityTokens", reference_images AS "referenceImages", status
         FROM drama_locations WHERE project_id=$1 ORDER BY id`,
      [req.params.id]
    );
    const { rows: episodes } = await p.query(
      `SELECT id, number, title, source_range_start AS "sourceRangeStart", source_range_end AS "sourceRangeEnd",
              target_duration_sec AS "targetDurationSec", key_visual AS "keyVisual", state,
              appearing_character_ids AS "appearingCharacterIds",
              chapter_numbers AS "chapterNumbers", pacing, focus, updated_at AS "updatedAt"
         FROM drama_episodes WHERE project_id=$1 ORDER BY number`,
      [req.params.id]
    );
    const { rows: assets } = await p.query(
      `SELECT id, name, note, url FROM drama_assets WHERE project_id=$1 ORDER BY id`, [req.params.id]
    );
    res.json({ ...rows[0], characters, locations, episodes, assets });
  } catch (err) {
    console.error("[drama] project detail", err);
    res.status(500).json({ error: err.message });
  }
});

// プロジェクト削除: drama_* の子テーブルは全部 ON DELETE CASCADE なので 1 発で消える
// (キャラ・場所・エピソード・カット・章・チャット・usage)
app.delete("/api/drama/projects/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rowCount } = await p.query("DELETE FROM drama_projects WHERE id=$1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    console.error("[drama] project delete", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/drama/projects/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const { rowCount } = await p.query(
      `UPDATE drama_projects SET
         title=COALESCE($1,title), author=COALESCE($2,author), source_text=COALESCE($3,source_text),
         world_setting=COALESCE($4,world_setting), style_guide=COALESCE($5,style_guide),
         default_video_model=COALESCE($6,default_video_model), ai_notes=COALESCE($7,ai_notes),
         style_ref_images=COALESCE($8::jsonb,style_ref_images), updated_at=now()
       WHERE id=$9`,
      [b.title, b.author, b.sourceText, b.worldSetting, b.styleGuide, b.defaultVideoModel, b.aiNotes,
       b.styleRefImages !== undefined ? JSON.stringify((b.styleRefImages || []).slice(0, 2)) : null, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] project update", err);
    res.status(500).json({ error: err.message });
  }
});

// プロジェクトの API 使用量: 合計 + provider/kind 別 + 直近履歴
app.get("/api/drama/projects/:id/usage", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: byKind } = await p.query(
      `SELECT provider, kind, COUNT(*)::int AS calls,
              COALESCE(SUM(input_tokens),0)::int AS "inputTokens",
              COALESCE(SUM(output_tokens),0)::int AS "outputTokens",
              COALESCE(SUM(video_seconds),0)::float AS "videoSeconds",
              COALESCE(SUM(cost_yen),0)::float AS "costYen"
         FROM drama_api_usage WHERE project_id=$1
        GROUP BY provider, kind ORDER BY "costYen" DESC`,
      [req.params.id]
    );
    const { rows: recent } = await p.query(
      `SELECT provider, kind, model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              video_seconds AS "videoSeconds", cost_yen::float AS "costYen", created_at AS "createdAt"
         FROM drama_api_usage WHERE project_id=$1 ORDER BY id DESC LIMIT 30`,
      [req.params.id]
    );
    const totalYen = byKind.reduce((s, r) => s + r.costYen, 0);
    const byProvider = {};
    for (const r of byKind) byProvider[r.provider] = (byProvider[r.provider] || 0) + r.costYen;
    res.json({ totalYen, byProvider, byKind, recent });
  } catch (err) {
    console.error("[drama] usage", err);
    res.status(500).json({ error: err.message });
  }
});

// 青空文庫の作品検索。公式カタログ CSV (確定 URL) を優先し、
// カタログ取得に失敗した時だけ Gemini + Google 検索にフォールバック
// (LLM は実在しない図書カード番号を創作して 404 を出すことがあるため)。
// { query: "邪宗門" } → [{ title, author, cardUrl }]
app.post("/api/drama/aozora-search", async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: "query is required" });
    try {
      const results = await dramaSearchCatalog(String(query).slice(0, 100));
      return res.json({ results, source: "catalog" });
    } catch (e) {
      console.warn("[drama] catalog search failed, falling back to Gemini:", e.message);
    }
    if (!genAI) return res.status(503).json({ error: "検索できませんでした (カタログ取得失敗 + Gemini 未設定)" });
    const results = await dramaSearchAozora(dramaTrackedGemini(null, "search"), String(query).slice(0, 100));
    res.json({ results, source: "gemini" });
  } catch (err) {
    console.error("[drama] aozora-search", err);
    res.status(500).json({ error: err.message });
  }
});

// 青空文庫 URL からのプロジェクト全自動作成の本体:
//   1. 本文取得 (図書カード URL でも可) → タイトル・作者はページから自動
//   2. プロジェクト作成 + 全文保存 + 章分割
//   3. AI が本文から初期構造化: 時代背景・絵柄提案・主要キャラ/場所を下書き登録
// kindPrefix="debug_" で課金記録をデバッグ枠に付ける (通常ルートと debug ルートで共用)
async function dramaImportFromAozora(p, { url, createdBy = null, skipSetup = false, kindPrefix = "" }) {
  const { text, meta } = await dramaFetchAozora(url);
  if (!text || text.length < 100) { const e = new Error("本文が取得できませんでした"); e.status = 400; throw e; }

  const { rows } = await p.query(
    `INSERT INTO drama_projects (title, author, source_text, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [meta.title || "無題", meta.author || null, text, createdBy]
  );
  const projectId = rows[0].id;

  const chapters = dramaSplitChapters(text);
  for (const ch of chapters) {
    await p.query(
      `INSERT INTO drama_chapters (project_id, number, title, content) VALUES ($1,$2,$3,$4)`,
      [projectId, ch.number, ch.title, ch.content]
    );
  }

  let setup = { worldSetting: null, styleGuide: null, characters: [], locations: [] };
  let setupError = null;
  if (genAI && !skipSetup) {
    try {
      setup = await dramaAnalyzeWorkSetup(dramaTrackedGemini(projectId, kindPrefix + "work_setup"), {
        title: meta.title || "無題", author: meta.author, text,
      });
      await p.query(
        `UPDATE drama_projects SET world_setting=$1, style_guide=$2, updated_at=now() WHERE id=$3`,
        [setup.worldSetting, setup.styleGuide, projectId]
      );
      for (const c of setup.characters) {
        await p.query(
          `INSERT INTO drama_characters (project_id, name, reading, description, appearance_prompt, identity_tokens, status)
           VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
          [projectId, c.name, c.reading || null, c.description || null, c.appearancePrompt || null, JSON.stringify(c.identityTokens || [])]
        );
      }
      for (const l of setup.locations || []) {
        await p.query(
          `INSERT INTO drama_locations (project_id, name, description, appearance_prompt, identity_tokens, status)
           VALUES ($1,$2,$3,$4,$5,'draft')`,
          [projectId, l.name, l.description || null, l.appearancePrompt || null, JSON.stringify(l.identityTokens || [])]
        );
      }
    } catch (e) {
      console.warn("[drama] work setup analyze failed:", e.message);
      setupError = e.message;
    }
  }

  return {
    id: projectId,
    title: meta.title, author: meta.author,
    totalChars: text.length, chapterCount: chapters.length,
    chapters: chapters.map((c) => ({ number: c.number, title: c.title, charCount: c.content.length })),
    charactersCreated: setup.characters.map((c) => c.name),
    locationsCreated: (setup.locations || []).map((l) => l.name),
    worldSetting: setup.worldSetting, styleGuide: setup.styleGuide,
    setupError,
  };
}

app.post("/api/drama/projects/from-aozora", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { url, skipSetup } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });
    await ensureSchema();
    const result = await dramaImportFromAozora(p, {
      url, createdBy: req.user?.email || null, skipSetup: !!skipSetup,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error("[drama] from-aozora", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// AI 初期構造化を単体で実行: 保存済みの source_text から時代背景・絵柄・主要キャラを埋める。
// worldSetting / styleGuide は空欄のときだけ埋める (force=true で上書き)。
// キャラは同名が未登録のものだけ下書き追加。
app.post("/api/drama/projects/:id/analyze-setup", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const force = !!req.body?.force;
    const { rows } = await p.query(
      `SELECT title, author, source_text AS "sourceText", world_setting AS "worldSetting", style_guide AS "styleGuide"
         FROM drama_projects WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const proj = rows[0];
    if (!proj.sourceText) return res.status(400).json({ error: "原作テキストが未取り込みです" });

    const setup = await dramaAnalyzeWorkSetup(dramaTrackedGemini(req.params.id, "work_setup"), {
      title: proj.title, author: proj.author, text: proj.sourceText,
    });
    await p.query(
      `UPDATE drama_projects SET
         world_setting = CASE WHEN $1 OR world_setting IS NULL OR world_setting = '' THEN $2 ELSE world_setting END,
         style_guide   = CASE WHEN $1 OR style_guide   IS NULL OR style_guide   = '' THEN $3 ELSE style_guide   END,
         updated_at = now()
       WHERE id=$4`,
      [force, setup.worldSetting, setup.styleGuide, req.params.id]
    );
    const { rows: existing } = await p.query(`SELECT name FROM drama_characters WHERE project_id=$1`, [req.params.id]);
    const known = new Set(existing.map((r) => r.name));
    const created = [];
    for (const c of setup.characters) {
      if (known.has(c.name)) continue;
      await p.query(
        `INSERT INTO drama_characters (project_id, name, reading, description, appearance_prompt, identity_tokens, status)
         VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
        [req.params.id, c.name, c.reading || null, c.description || null, c.appearancePrompt || null, JSON.stringify(c.identityTokens || [])]
      );
      created.push(c.name);
    }
    const { rows: existingLocs } = await p.query(`SELECT name FROM drama_locations WHERE project_id=$1`, [req.params.id]);
    const knownLocs = new Set(existingLocs.map((r) => r.name));
    const locationsCreated = [];
    for (const l of setup.locations || []) {
      if (knownLocs.has(l.name)) continue;
      await p.query(
        `INSERT INTO drama_locations (project_id, name, description, appearance_prompt, identity_tokens, status)
         VALUES ($1,$2,$3,$4,$5,'draft')`,
        [req.params.id, l.name, l.description || null, l.appearancePrompt || null, JSON.stringify(l.identityTokens || [])]
      );
      locationsCreated.push(l.name);
    }
    res.json({ ok: true, worldSetting: setup.worldSetting, styleGuide: setup.styleGuide, charactersCreated: created, locationsCreated });
  } catch (err) {
    console.error("[drama] analyze-setup", err);
    res.status(500).json({ error: err.message });
  }
});

// 原作テキストの取り込み: { url } (青空文庫) または { text } (直接貼り付け)。
// 全文を drama_projects.source_text に保存しつつ、章に分割して drama_chapters を作り直す。
app.post("/api/drama/projects/:id/import-source", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { url, text: rawText } = req.body || {};
    let text = rawText;
    if (!text && url) ({ text } = await dramaFetchAozora(url));
    if (!text) return res.status(400).json({ error: "url か text のどちらかが必要です" });

    const { rowCount } = await p.query(
      `UPDATE drama_projects SET source_text=$1, updated_at=now() WHERE id=$2`,
      [text, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "not found" });

    const chapters = dramaSplitChapters(text);
    await p.query(`DELETE FROM drama_chapters WHERE project_id=$1`, [req.params.id]);
    for (const ch of chapters) {
      await p.query(
        `INSERT INTO drama_chapters (project_id, number, title, content) VALUES ($1,$2,$3,$4)`,
        [req.params.id, ch.number, ch.title, ch.content]
      );
    }
    res.json({
      ok: true,
      totalChars: text.length,
      chapterCount: chapters.length,
      chapters: chapters.map((c) => ({ number: c.number, title: c.title, charCount: c.content.length })),
    });
  } catch (err) {
    console.error("[drama] import-source", err);
    res.status(500).json({ error: err.message });
  }
});

// 章 index (content 抜き)。本文は GET /api/drama/chapters/:id で個別取得。
app.get("/api/drama/projects/:id/chapters", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, number, title, summary, character_names AS "characterNames", length(content) AS "charCount"
         FROM drama_chapters WHERE project_id=$1 ORDER BY number`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[drama] chapters list", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/drama/chapters/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, project_id AS "projectId", number, title, content, summary, character_names AS "characterNames"
         FROM drama_chapters WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[drama] chapter detail", err);
    res.status(500).json({ error: err.message });
  }
});

// 章の AI 解析: 各章の要約 + 出演キャラ名を Gemini で埋める (index 作成)。
// Firebase Hosting の rewrite が 60 秒で切れるため、1 リクエストで最大 limit 章 (既定5) まで
// しか処理せず { remaining } を返す。クライアントは remaining が 0 になるまでループで叩く。
// force=true は最初の呼び出しで全章の解析結果をリセットしてから始める。
app.post("/api/drama/projects/:id/chapters/analyze", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const limit = Math.max(1, Math.min(10, Number(req.body?.limit) || 5));
    if (req.body?.force) {
      await p.query(`UPDATE drama_chapters SET summary=NULL, character_names='[]'::jsonb WHERE project_id=$1`, [req.params.id]);
    }
    const { rows: projRows } = await p.query(`SELECT title, author FROM drama_projects WHERE id=$1`, [req.params.id]);
    if (!projRows.length) return res.status(404).json({ error: "not found" });
    const { rows: charRows } = await p.query(`SELECT name FROM drama_characters WHERE project_id=$1`, [req.params.id]);
    const knownCharacterNames = charRows.map((r) => r.name);
    const { rows: allChapters } = await p.query(
      `SELECT id, number, title, content, summary FROM drama_chapters WHERE project_id=$1 ORDER BY number`,
      [req.params.id]
    );
    if (!allChapters.length) return res.status(400).json({ error: "章がありません。先に原作テキストを取り込んでください" });

    const pending = allChapters.filter((ch) => !ch.summary);
    const batch = pending.slice(0, limit);
    const results = [];
    for (const ch of batch) {
      try {
        const a = await dramaAnalyzeChapter(dramaTrackedGemini(req.params.id, "chapter_analyze"), {
          projectTitle: projRows[0].title, author: projRows[0].author, chapter: ch, knownCharacterNames,
        });
        await p.query(
          `UPDATE drama_chapters SET summary=$1, character_names=$2, updated_at=now() WHERE id=$3`,
          [a.summary, JSON.stringify(a.characterNames), ch.id]
        );
        results.push({ number: ch.number, summary: a.summary, characterNames: a.characterNames });
      } catch (e) {
        console.warn(`[drama] chapter ${ch.number} analyze failed: ${e.message}`);
        results.push({ number: ch.number, error: e.message });
      }
    }
    const remaining = pending.length - batch.length;
    res.json({ ok: true, results, processed: batch.length, remaining, total: allChapters.length });
  } catch (err) {
    console.error("[drama] chapters analyze", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/drama/projects/:id/characters", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name is required" });
    const { rows } = await p.query(
      `INSERT INTO drama_characters (project_id, name, reading, description, appearance_prompt, identity_tokens, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, b.name, b.reading || null, b.description || null, b.appearancePrompt || null,
       JSON.stringify(b.identityTokens || []), b.status || "draft"]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[drama] character create", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/drama/characters/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val) => { fields.push(`${col}=$${i++}`); values.push(val); };
    if (b.name !== undefined) set("name", b.name);
    if (b.reading !== undefined) set("reading", b.reading);
    if (b.description !== undefined) set("description", b.description);
    if (b.appearancePrompt !== undefined) set("appearance_prompt", b.appearancePrompt);
    if (b.identityTokens !== undefined) set("identity_tokens", JSON.stringify(b.identityTokens));
    if (b.referenceImages !== undefined) set("reference_images", JSON.stringify(b.referenceImages));
    if (b.status !== undefined) set("status", b.status);
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    fields.push("updated_at=now()");
    values.push(req.params.id);
    const { rowCount } = await p.query(`UPDATE drama_characters SET ${fields.join(", ")} WHERE id=$${i}`, values);
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] character update", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/drama/characters/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query("DELETE FROM drama_characters WHERE id=$1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("[drama] character delete", err);
    res.status(500).json({ error: err.message });
  }
});

// 制作資料 (人物対比図・小物・美術ボード等)。手動アップロード用の CRUD
app.post("/api/drama/projects/:id/assets", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    if (!b.name || !b.url) return res.status(400).json({ error: "name と url が必要です" });
    const { rows } = await p.query(
      `INSERT INTO drama_assets (project_id, name, note, url) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, String(b.name).slice(0, 60), b.note ? String(b.note).slice(0, 300) : null, b.url]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[drama] asset create", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/drama/assets/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query("DELETE FROM drama_assets WHERE id=$1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("[drama] asset delete", err);
    res.status(500).json({ error: err.message });
  }
});

// 場所 (キャラと同じ CRUD 形)
app.post("/api/drama/projects/:id/locations", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: "name is required" });
    const { rows } = await p.query(
      `INSERT INTO drama_locations (project_id, name, description, appearance_prompt, identity_tokens, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.id, b.name, b.description || null, b.appearancePrompt || null,
       JSON.stringify(b.identityTokens || []), b.status || "draft"]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[drama] location create", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/drama/locations/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val) => { fields.push(`${col}=$${i++}`); values.push(val); };
    if (b.name !== undefined) set("name", b.name);
    if (b.description !== undefined) set("description", b.description);
    if (b.appearancePrompt !== undefined) set("appearance_prompt", b.appearancePrompt);
    if (b.identityTokens !== undefined) set("identity_tokens", JSON.stringify(b.identityTokens));
    if (b.referenceImages !== undefined) set("reference_images", JSON.stringify(b.referenceImages));
    if (b.status !== undefined) set("status", b.status);
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    fields.push("updated_at=now()");
    values.push(req.params.id);
    const { rowCount } = await p.query(`UPDATE drama_locations SET ${fields.join(", ")} WHERE id=$${i}`, values);
    if (!rowCount) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] location update", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/drama/locations/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    await p.query("DELETE FROM drama_locations WHERE id=$1", [req.params.id]);
    res.status(204).end();
  } catch (err) {
    console.error("[drama] location delete", err);
    res.status(500).json({ error: err.message });
  }
});

// ① シリーズ構成: 章一覧から話数割りを AI 提案 → episodes を一括作成。
// 緩急重視 (1章=1話にしない)。既に話がある場合は force=true で作り直し (既存の話とカットは消える)。
app.post("/api/drama/projects/:id/compose-series", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const { rows: projRows } = await p.query(
      `SELECT title, author, style_guide AS "styleGuide", world_setting AS "worldSetting", ai_notes AS "aiNotes"
         FROM drama_projects WHERE id=$1`, [req.params.id]);
    if (!projRows.length) return res.status(404).json({ error: "not found" });
    const { rows: chapters } = await p.query(
      `SELECT number, title, length(content) AS "charCount", summary FROM drama_chapters WHERE project_id=$1 ORDER BY number`,
      [req.params.id]
    );
    if (!chapters.length) return res.status(400).json({ error: "章がありません。先に原作を取り込んでください" });
    const { rows: existing } = await p.query(`SELECT COUNT(*)::int AS n FROM drama_episodes WHERE project_id=$1`, [req.params.id]);
    if (existing[0].n > 0 && !req.body?.force) {
      return res.status(409).json({ error: "既に話があります。作り直す場合は force を指定 (既存の話とカットは消えます)" });
    }
    const episodes = await dramaComposeSeries(dramaTrackedGemini(req.params.id, "compose_series"), {
      title: projRows[0].title, author: projRows[0].author, chapters,
      targetDurationSec: Number(req.body?.targetDurationSec) || 60,
      styleGuide: projRows[0].styleGuide, worldSetting: projRows[0].worldSetting, aiNotes: projRows[0].aiNotes,
    });
    if (req.body?.force) await p.query(`DELETE FROM drama_episodes WHERE project_id=$1`, [req.params.id]);

    // 出演キャラの自動設定: 割当章の出演 index (章解析の character_names) と
    // 登録済みキャラを名前で突き合わせる
    const { rows: chapNames } = await p.query(
      `SELECT number, character_names AS "characterNames" FROM drama_chapters WHERE project_id=$1`, [req.params.id]
    );
    const namesByChapter = new Map(chapNames.map((c) => [Number(c.number), c.characterNames || []]));
    const { rows: regChars } = await p.query(`SELECT id, name FROM drama_characters WHERE project_id=$1`, [req.params.id]);
    const nameMatch = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));

    for (const e of episodes) {
      const chapterCast = new Set();
      for (const n of e.chapterNumbers) for (const nm of (namesByChapter.get(Number(n)) || [])) chapterCast.add(nm);
      const appearing = regChars.filter((c) => [...chapterCast].some((nm) => nameMatch(c.name, nm))).map((c) => String(c.id));
      await p.query(
        `INSERT INTO drama_episodes (project_id, number, title, chapter_numbers, pacing, focus, appearing_character_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, e.number, e.title, JSON.stringify(e.chapterNumbers), e.pacing, e.focus, JSON.stringify(appearing)]
      );
    }
    res.json({ ok: true, episodeCount: episodes.length, episodes });
  } catch (err) {
    console.error("[drama] compose-series", err);
    res.status(500).json({ error: err.message });
  }
});

// ② 脚本: 割り当てられた章の本文から話単位の脚本を AI が書く (script に保存、編集可)
app.post("/api/drama/episodes/:id/write-script", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const script = await dramaRunWriteScript(p, req.params.id);
    res.json({ ok: true, script });
  } catch (err) {
    console.error("[drama] write-script", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ③ カット割り (絵コンテ設計): 脚本から 8 秒×N カットを AI が起こして一括作成。
// 既にカットがある場合は force=true で作り直し。
app.post("/api/drama/episodes/:id/compose-cuts", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const cutCount = await dramaRunComposeCuts(p, req.params.id, { force: !!req.body?.force });
    res.json({ ok: true, cutCount });
  } catch (err) {
    console.error("[drama] compose-cuts", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ③' 絵コンテ静止画: 動画 (¥150) の前に静止画 (¥6) で構図を確認するゲート
app.post("/api/drama/cuts/:id/storyboard", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT c.id, c.prompt, c.character_ids AS "characterIds", c.location_id AS "locationId",
              e.project_id AS "projectId"
         FROM drama_cuts c JOIN drama_episodes e ON e.id = c.episode_id WHERE c.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const cut = rows[0];
    if (!cut.prompt) return res.status(400).json({ error: "プロンプトが未設定です" });
    const { rows: projRows } = await p.query(
      `SELECT style_guide AS "styleGuide", style_ref_images AS "styleRefImages" FROM drama_projects WHERE id=$1`, [cut.projectId]
    );
    const { rows: characters } = await p.query(
      `SELECT id, name, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
         FROM drama_characters WHERE project_id=$1`, [cut.projectId]
    );
    const { rows: locations } = await p.query(
      `SELECT id, name, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
         FROM drama_locations WHERE project_id=$1`, [cut.projectId]
    );
    const cutChars = (cut.characterIds || [])
      .map((cid) => characters.find((c) => String(c.id) === String(cid)))
      .filter(Boolean);
    const charDesc = cutChars.map((c) => `${c.name} (${(c.identityTokens || []).join("、")})`).join(" / ");
    const loc = locations.find((l) => String(l.id) === String(cut.locationId));
    const prompt = `縦 9:16 のアニメ絵コンテ用静止画を 1 枚。
絵柄: ${projRows[0]?.styleGuide || "シネマティック"}
${charDesc ? `登場人物: ${charDesc}\n` : ""}${loc ? `場所: ${loc.name} (${(loc.identityTokens || []).join("、")})\n` : ""}シーン: ${cut.prompt}`;

    // 参照画像: 作画基準 → 登場キャラの参照 → 場所の参照 (最大4枚)
    const refUrls = [...(projRows[0]?.styleRefImages || []).slice(0, 2)];
    for (const c of cutChars) if ((c.referenceImages || []).length) refUrls.push(c.referenceImages[0].url);
    if (loc && (loc.referenceImages || []).length) refUrls.push(loc.referenceImages[0].url);
    const refParts = await dramaFetchImagePartsSafe(refUrls, 4);

    // 9:16 は API 設定で強制 (テキスト指示だけだと正方形が返りがち)
    const img = await dramaGenerateImage(prompt, refParts, { aspectRatio: "9:16" });
    dramaRecordUsage({ projectId: cut.projectId, provider: "gemini", kind: "storyboard", model: DRAMA_GEMINI_IMAGE_MODEL, costYen: DRAMA_GEMINI_IMAGE_YEN });

    let url;
    if (storage && RECEIPTS_BUCKET) {
      const ext = img.mimeType.includes("jpeg") ? "jpg" : "png";
      const key = `drama/storyboards/${cut.id}/${Date.now()}.${ext}`;
      await storage.bucket(RECEIPTS_BUCKET).file(key).save(Buffer.from(img.data, "base64"), { contentType: img.mimeType, resumable: false });
      [url] = await storage.bucket(RECEIPTS_BUCKET).file(key)
        .getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    } else {
      url = `data:${img.mimeType};base64,${img.data}`; // ローカル dev 用フォールバック
    }
    await p.query(`UPDATE drama_cuts SET storyboard_url=$1, updated_at=now() WHERE id=$2`, [url, req.params.id]);
    res.json({ ok: true, storyboardUrl: url });
  } catch (err) {
    console.error("[drama] storyboard", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/drama/projects/:id/episodes", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    if (!b.number) return res.status(400).json({ error: "number is required" });
    const { rows } = await p.query(
      `INSERT INTO drama_episodes (project_id, number, title, source_range_start, source_range_end, target_duration_sec, appearing_character_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, b.number, b.title || null, b.sourceRangeStart ?? null, b.sourceRangeEnd ?? null,
       b.targetDurationSec || 60, JSON.stringify(b.appearingCharacterIds || [])]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[drama] episode create", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/drama/episodes/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, project_id AS "projectId", number, title,
              source_range_start AS "sourceRangeStart", source_range_end AS "sourceRangeEnd",
              target_duration_sec AS "targetDurationSec", key_visual AS "keyVisual", state,
              appearing_character_ids AS "appearingCharacterIds",
              chapter_numbers AS "chapterNumbers", pacing, focus, script,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM drama_episodes WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const episode = rows[0];
    const { rows: cuts } = await p.query(
      `SELECT id, "order", duration_sec AS "durationSec", prompt, character_ids AS "characterIds",
              location_id AS "locationId", storyboard_url AS "storyboardUrl",
              generations, selected_generation_index AS "selectedGenerationIndex", narration, subtitle
         FROM drama_cuts WHERE episode_id=$1 ORDER BY "order"`,
      [req.params.id]
    );
    const { rows: timelineRows } = await p.query(
      `SELECT items, exported_video_url AS "exportedVideoUrl" FROM drama_timelines WHERE episode_id=$1`,
      [req.params.id]
    );
    const timeline = timelineRows[0] || { items: [], exportedVideoUrl: null };
    const { rows: projRows } = await p.query(
      `SELECT id, title, author, style_guide AS "styleGuide", world_setting AS "worldSetting" FROM drama_projects WHERE id=$1`,
      [episode.projectId]
    );
    const { rows: characters } = await p.query(
      `SELECT id, name, reading, status, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
         FROM drama_characters WHERE project_id=$1`,
      [episode.projectId]
    );
    const { rows: locations } = await p.query(
      `SELECT id, name, status, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
         FROM drama_locations WHERE project_id=$1`,
      [episode.projectId]
    );
    const missingInfo = computeMissingInfo({ project: projRows[0] || {}, characters, episode, cuts, locations });
    res.json({ ...episode, cuts, timeline, missingInfo });
  } catch (err) {
    console.error("[drama] episode detail", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/drama/episodes/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val) => { fields.push(`${col}=$${i++}`); values.push(val); };
    if (b.title !== undefined) set("title", b.title);
    if (b.sourceRangeStart !== undefined) set("source_range_start", b.sourceRangeStart);
    if (b.sourceRangeEnd !== undefined) set("source_range_end", b.sourceRangeEnd);
    if (b.targetDurationSec !== undefined) set("target_duration_sec", b.targetDurationSec);
    if (b.keyVisual !== undefined) set("key_visual", JSON.stringify(b.keyVisual));
    if (b.appearingCharacterIds !== undefined) set("appearing_character_ids", JSON.stringify(b.appearingCharacterIds));
    if (b.chapterNumbers !== undefined) set("chapter_numbers", JSON.stringify(b.chapterNumbers));
    if (b.pacing !== undefined) set("pacing", b.pacing);
    if (b.focus !== undefined) set("focus", b.focus);
    if (b.script !== undefined) set("script", b.script);
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    fields.push("updated_at=now()");
    values.push(req.params.id);
    const { rowCount } = await p.query(`UPDATE drama_episodes SET ${fields.join(", ")} WHERE id=$${i}`, values);
    if (!rowCount) return res.status(404).json({ error: "not found" });
    await dramaRecomputeState(p, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] episode update", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/drama/episodes/:id/cuts", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const { rows: existing } = await p.query(`SELECT COALESCE(MAX("order"),0) AS m FROM drama_cuts WHERE episode_id=$1`, [req.params.id]);
    const order = b.order ?? (Number(existing[0].m) + 1);
    const { rows } = await p.query(
      `INSERT INTO drama_cuts (episode_id, "order", duration_sec, prompt, character_ids, location_id, narration, subtitle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.params.id, order, b.durationSec || 8, b.prompt || null, JSON.stringify(b.characterIds || []),
       b.locationId || null, b.narration || null, b.subtitle || null]
    );
    await dramaRecomputeState(p, req.params.id);
    res.status(201).json({ id: rows[0].id, order });
  } catch (err) {
    console.error("[drama] cut create", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/drama/cuts/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    const set = (col, val) => { fields.push(`${col}=$${i++}`); values.push(val); };
    if (b.order !== undefined) set(`"order"`, b.order);
    if (b.durationSec !== undefined) set("duration_sec", b.durationSec);
    if (b.prompt !== undefined) set("prompt", b.prompt);
    if (b.characterIds !== undefined) set("character_ids", JSON.stringify(b.characterIds));
    if (b.locationId !== undefined) set("location_id", b.locationId || null);
    if (b.narration !== undefined) set("narration", b.narration);
    if (b.subtitle !== undefined) set("subtitle", b.subtitle);
    if (b.selectedGenerationIndex !== undefined) set("selected_generation_index", b.selectedGenerationIndex);
    if (!fields.length) return res.status(400).json({ error: "no fields to update" });
    fields.push("updated_at=now()");
    values.push(req.params.id);
    const { rows } = await p.query(
      `UPDATE drama_cuts SET ${fields.join(", ")} WHERE id=$${i} RETURNING episode_id AS "episodeId"`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    await dramaRecomputeState(p, rows[0].episodeId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] cut update", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/drama/cuts/:id", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(`DELETE FROM drama_cuts WHERE id=$1 RETURNING episode_id AS "episodeId"`, [req.params.id]);
    if (rows.length) await dramaRecomputeState(p, rows[0].episodeId);
    res.status(204).end();
  } catch (err) {
    console.error("[drama] cut delete", err);
    res.status(500).json({ error: err.message });
  }
});

// カットの動画生成をトリガー。登場キャラが確定 + 参照画像ありでない限り 409 で拒否する
// (「素材が揃うまで動画生成に進ませない」を実際にゲートする箇所)。
// Seedance は非同期 API なのでここではタスク作成まで。進捗/結果は下の /refresh で取る。
app.post("/api/drama/cuts/:id/generate", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows } = await p.query(
      `SELECT id, episode_id AS "episodeId", duration_sec AS "durationSec", prompt,
              character_ids AS "characterIds", location_id AS "locationId",
              generations, selected_generation_index AS "selectedGenerationIndex"
         FROM drama_cuts WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const cut = rows[0];
    const { rows: epRows } = await p.query(
      `SELECT project_id AS "projectId", key_visual AS "keyVisual" FROM drama_episodes WHERE id=$1`, [cut.episodeId]
    );
    if (!epRows.length) return res.status(404).json({ error: "episode not found" });
    const { rows: characters } = await p.query(
      `SELECT id, name, status, reference_images AS "referenceImages" FROM drama_characters WHERE project_id=$1`,
      [epRows[0].projectId]
    );
    const { rows: locations } = await p.query(
      `SELECT id, name, status, reference_images AS "referenceImages" FROM drama_locations WHERE project_id=$1`,
      [epRows[0].projectId]
    );
    const { ready, reasons } = cutIsReadyForGeneration(cut, characters, locations);
    if (!ready) return res.status(409).json({ error: "素材が揃っていません", reasons });

    // 参照画像: 登場キャラ + 場所 (背景) + キービジュアル (あれば)
    const referenceImageUrls = (cut.characterIds || [])
      .flatMap((cid) => characters.find((c) => String(c.id) === String(cid))?.referenceImages || [])
      .map((r) => r.url).filter(Boolean);
    const loc = locations.find((l) => String(l.id) === String(cut.locationId));
    if (loc) referenceImageUrls.push(...(loc.referenceImages || []).map((r) => r.url).filter(Boolean));
    if (epRows[0].keyVisual?.url) referenceImageUrls.push(epRows[0].keyVisual.url);

    const model = req.body?.model || DRAMA_SEEDANCE_MODEL;
    let generation;
    if (dramaSeedanceConfigured()) {
      const { taskId } = await dramaCreateVideoTask({
        prompt: cut.prompt, referenceImageUrls, durationSec: cut.durationSec, model,
      });
      // コスト記録はタスク作成時 (保守側=失敗しても計上。実課金は成功分のみなので過大方向)
      dramaRecordSeedanceUsage(epRows[0].projectId, Math.max(4, Math.min(15, Math.round(cut.durationSec || 8))), model);
      generation = {
        status: "queued", providerTaskId: taskId, videoUrl: null,
        prompt: cut.prompt, revisionNote: req.body?.revisionNote || "", model,
        createdAt: new Date().toISOString(),
      };
    } else {
      // ローカル/dev: キー無しならモックで即完了
      const mock = await dramaGenerateMock({ prompt: cut.prompt, durationSec: cut.durationSec, model });
      generation = {
        status: mock.status, videoUrl: mock.videoUrl, note: mock.note,
        prompt: cut.prompt, revisionNote: req.body?.revisionNote || "", model: mock.model,
        createdAt: new Date().toISOString(),
      };
    }
    const generations = [...(cut.generations || []), generation];
    const newIndex = (generation.status === "done" && cut.selectedGenerationIndex === -1)
      ? generations.length - 1 : cut.selectedGenerationIndex;
    await p.query(
      `UPDATE drama_cuts SET generations=$1, selected_generation_index=$2, updated_at=now() WHERE id=$3`,
      [JSON.stringify(generations), newIndex, req.params.id]
    );
    await dramaRecomputeState(p, cut.episodeId);
    res.json({ ok: true, generation, generations });
  } catch (err) {
    console.error("[drama] cut generate", err);
    res.status(500).json({ error: err.message });
  }
});

// 生成タスクの進捗確認 + 完了処理。フロントが数秒おきに叩く。
//  - succeeded: 動画を GCS に保存 (provider URL は 24h で切れるため)、署名 URL を videoUrl に
//  - 保存済みで URL が切れた時も、これを叩き直せば署名 URL を再発行する
app.post("/api/drama/cuts/:id/generations/:gi/refresh", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const gi = Number(req.params.gi);
    const { rows } = await p.query(
      `SELECT id, episode_id AS "episodeId", generations, selected_generation_index AS "selectedGenerationIndex"
         FROM drama_cuts WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    const cut = rows[0];
    const generations = [...(cut.generations || [])];
    const gen = generations[gi];
    if (!gen) return res.status(404).json({ error: "generation not found" });

    const signGcs = async (gsUrl) => {
      const [, , bucket, ...rest] = gsUrl.split("/");
      const [url] = await storage.bucket(bucket).file(rest.join("/"))
        .getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      return url;
    };

    if (gen.gcsUrl && storage) {
      // 保存済み → 署名 URL の再発行だけ
      gen.videoUrl = await signGcs(gen.gcsUrl);
    } else if (gen.providerTaskId && ["queued", "running"].includes(gen.status)) {
      const t = await dramaGetVideoTask(gen.providerTaskId);
      if (t.status === "succeeded" && t.videoUrl) {
        gen.status = "done";
        gen.videoUrl = t.videoUrl;
        // GCS に保存 (provider URL の期限切れ対策)。失敗しても provider URL で続行
        if (storage && RECEIPTS_BUCKET) {
          try {
            const vr = await fetch(t.videoUrl);
            if (vr.ok) {
              const buf = Buffer.from(await vr.arrayBuffer());
              const key = `drama/cuts/${cut.id}/${gen.providerTaskId}.mp4`;
              await storage.bucket(RECEIPTS_BUCKET).file(key).save(buf, { contentType: "video/mp4", resumable: false });
              gen.gcsUrl = `gs://${RECEIPTS_BUCKET}/${key}`;
              gen.videoUrl = await signGcs(gen.gcsUrl);
            }
          } catch (e) { console.warn("[drama] video GCS mirror failed:", e.message); }
        }
      } else if (t.status === "failed") {
        gen.status = "failed";
        gen.note = t.error || "生成に失敗しました";
      } else {
        gen.status = t.status === "unknown" ? gen.status : t.status; // queued/running
      }
    }

    let newIndex = cut.selectedGenerationIndex;
    if (gen.status === "done" && newIndex === -1) newIndex = gi;
    await p.query(
      `UPDATE drama_cuts SET generations=$1, selected_generation_index=$2, updated_at=now() WHERE id=$3`,
      [JSON.stringify(generations), newIndex, req.params.id]
    );
    await dramaRecomputeState(p, cut.episodeId);
    res.json({ ok: true, generation: gen, index: gi });
  } catch (err) {
    console.error("[drama] generation refresh", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/drama/episodes/:id/timeline", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const items = req.body?.items || [];
    await p.query(
      `INSERT INTO drama_timelines (episode_id, items, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (episode_id) DO UPDATE SET items=EXCLUDED.items, updated_at=now()`,
      [req.params.id, JSON.stringify(items)]
    );
    await dramaRecomputeState(p, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] timeline save", err);
    res.status(500).json({ error: err.message });
  }
});

// Phase1: 実際のカット結合 (ffmpeg 等) は未実装。採用テイクが全カット揃っていることを
// 確認した上で、代表カットの動画 URL を「書き出し結果」のプレースホルダーとして保存する。
app.post("/api/drama/episodes/:id/export", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rows: cuts } = await p.query(
      `SELECT "order", generations, selected_generation_index AS "selectedGenerationIndex"
         FROM drama_cuts WHERE episode_id=$1 ORDER BY "order"`,
      [req.params.id]
    );
    const missing = cuts.filter((c) => c.selectedGenerationIndex < 0 || !c.generations?.[c.selectedGenerationIndex]);
    if (!cuts.length || missing.length) {
      return res.status(409).json({ error: "採用テイクが未選択のカットがあります", missingCount: missing.length });
    }
    const placeholderUrl = cuts[0].generations[cuts[0].selectedGenerationIndex].videoUrl;
    await p.query(
      `INSERT INTO drama_timelines (episode_id, exported_video_url, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (episode_id) DO UPDATE SET exported_video_url=EXCLUDED.exported_video_url, updated_at=now()`,
      [req.params.id, placeholderUrl]
    );
    await dramaRecomputeState(p, req.params.id);
    res.json({ ok: true, exportedVideoUrl: placeholderUrl, note: "mock: 実結合パイプライン未実装のため代表カットの動画を書き出し結果としています" });
  } catch (err) {
    console.error("[drama] export", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/drama/projects/:id/chat", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const episodeId = req.query.episodeId || null;
    const { rows } = await p.query(
      episodeId
        ? `SELECT m.id, m.role, m.content, m.images, m.status, m.created_at AS "createdAt",
                  m.quoted_message_id AS "quotedMessageId",
                  q.content AS "quotedContent", q.images AS "quotedImages"
             FROM drama_chat_messages m
             LEFT JOIN drama_chat_messages q ON q.id = m.quoted_message_id
            WHERE m.project_id=$1 AND m.episode_id=$2 ORDER BY m.id`
        : `SELECT m.id, m.role, m.content, m.images, m.status, m.created_at AS "createdAt",
                  m.quoted_message_id AS "quotedMessageId",
                  q.content AS "quotedContent", q.images AS "quotedImages"
             FROM drama_chat_messages m
             LEFT JOIN drama_chat_messages q ON q.id = m.quoted_message_id
            WHERE m.project_id=$1 AND m.episode_id IS NULL ORDER BY m.id`,
      episodeId ? [req.params.id, episodeId] : [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[drama] chat history", err);
    res.status(500).json({ error: err.message });
  }
});

// メッセージの送信取消 (LINE 相当)。DB から消えるので AI の文脈からも消える
app.delete("/api/drama/chat/:messageId", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  try {
    const { rowCount } = await p.query(`DELETE FROM drama_chat_messages WHERE id=$1`, [req.params.messageId]);
    if (!rowCount) return res.status(404).json({ error: "message not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[drama] chat delete", err);
    res.status(500).json({ error: err.message });
  }
});

// 章 index (character_names) と登録キャラを名前で突き合わせて出演キャラ id を出す
async function dramaCastFromChapters(p, projectId, chapterNumbers) {
  const { rows: chapNames } = await p.query(
    `SELECT number, character_names AS "characterNames" FROM drama_chapters WHERE project_id=$1`, [projectId]
  );
  const namesByChapter = new Map(chapNames.map((c) => [Number(c.number), c.characterNames || []]));
  const { rows: regChars } = await p.query(`SELECT id, name FROM drama_characters WHERE project_id=$1`, [projectId]);
  const nameMatch = (a, b) => a && b && (a === b || a.includes(b) || b.includes(a));
  const cast = new Set();
  for (const n of chapterNumbers || []) for (const nm of (namesByChapter.get(Number(n)) || [])) cast.add(nm);
  return regChars.filter((c) => [...cast].some((nm) => nameMatch(c.name, nm))).map((c) => String(c.id));
}

// 脚本生成の本体 (ルートとチャット ACTIONS の両方から使う)
async function dramaRunWriteScript(p, episodeId) {
  const { rows: epRows } = await p.query(
    `SELECT id, project_id AS "projectId", number, title, target_duration_sec AS "targetDurationSec",
            chapter_numbers AS "chapterNumbers", pacing, focus
       FROM drama_episodes WHERE id=$1`,
    [episodeId]
  );
  if (!epRows.length) { const e = new Error("話が見つかりません"); e.status = 404; throw e; }
  const episode = epRows[0];
  const chapterNumbers = episode.chapterNumbers || [];
  if (!chapterNumbers.length) { const e = new Error("この話に章が割り当てられていません (シリーズ構成を先に)"); e.status = 400; throw e; }
  const { rows: projRows } = await p.query(
    `SELECT title, author, style_guide AS "styleGuide", world_setting AS "worldSetting", ai_notes AS "aiNotes"
       FROM drama_projects WHERE id=$1`, [episode.projectId]
  );
  const { rows: chapterRows } = await p.query(
    `SELECT number, title, content FROM drama_chapters WHERE project_id=$1 AND number = ANY($2::int[]) ORDER BY number`,
    [episode.projectId, chapterNumbers]
  );
  const { rows: characters } = await p.query(`SELECT id, name FROM drama_characters WHERE project_id=$1`, [episode.projectId]);
  const chapterTexts = chapterRows.map((c) => `【第${c.number}章 ${c.title}】\n${c.content}`).join("\n\n");
  const script = await dramaWriteScript(dramaTrackedGemini(episode.projectId, "write_script"), {
    title: projRows[0].title, author: projRows[0].author, styleGuide: projRows[0].styleGuide,
    worldSetting: projRows[0].worldSetting, aiNotes: projRows[0].aiNotes,
    episode, chapterTexts, characters,
  });
  await p.query(`UPDATE drama_episodes SET script=$1, updated_at=now() WHERE id=$2`, [script, episodeId]);
  return script;
}

// カット割り生成の本体 (ルートとチャット ACTIONS の両方から使う)
async function dramaRunComposeCuts(p, episodeId, { force = false } = {}) {
  const { rows: epRows } = await p.query(
    `SELECT id, project_id AS "projectId", number, title, target_duration_sec AS "targetDurationSec", pacing, focus, script
       FROM drama_episodes WHERE id=$1`,
    [episodeId]
  );
  if (!epRows.length) { const e = new Error("話が見つかりません"); e.status = 404; throw e; }
  const episode = epRows[0];
  if (!episode.script) { const e = new Error("脚本がまだありません (先に脚本を生成)"); e.status = 400; throw e; }
  const { rows: existing } = await p.query(`SELECT COUNT(*)::int AS n FROM drama_cuts WHERE episode_id=$1`, [episodeId]);
  if (existing[0].n > 0 && !force) {
    const e = new Error("既にカットがあります。作り直す場合は force を指定 (既存カットと生成履歴は消えます)");
    e.status = 409; throw e;
  }
  const { rows: projRows } = await p.query(
    `SELECT title, style_guide AS "styleGuide", world_setting AS "worldSetting", ai_notes AS "aiNotes"
       FROM drama_projects WHERE id=$1`, [episode.projectId]
  );
  const { rows: characters } = await p.query(`SELECT id, name FROM drama_characters WHERE project_id=$1`, [episode.projectId]);
  const { rows: locations } = await p.query(`SELECT id, name FROM drama_locations WHERE project_id=$1`, [episode.projectId]);
  const cuts = await dramaComposeCuts(dramaTrackedGemini(episode.projectId, "compose_cuts"), {
    title: projRows[0].title, styleGuide: projRows[0].styleGuide,
    worldSetting: projRows[0].worldSetting, aiNotes: projRows[0].aiNotes,
    episode, script: episode.script, characters, locations,
  });
  if (force) await p.query(`DELETE FROM drama_cuts WHERE episode_id=$1`, [episodeId]);
  const validCharIds = new Set(characters.map((c) => String(c.id)));
  const validLocIds = new Set(locations.map((l) => String(l.id)));
  const usedCharIds = new Set();
  let order = 1;
  for (const c of cuts) {
    const charIds = c.characterIds.filter((id) => validCharIds.has(id));
    charIds.forEach((id) => usedCharIds.add(id));
    await p.query(
      `INSERT INTO drama_cuts (episode_id, "order", duration_sec, prompt, character_ids, location_id, narration, subtitle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [episodeId, order++, c.durationSec, c.prompt, JSON.stringify(charIds),
       validLocIds.has(c.locationId) ? c.locationId : null, c.narration || null, c.subtitle || null]
    );
  }
  // 話の出演キャラをカットの実使用から自動更新 (既存の選択とマージ)
  const { rows: epCast } = await p.query(
    `SELECT appearing_character_ids AS "appearingCharacterIds" FROM drama_episodes WHERE id=$1`, [episodeId]
  );
  const merged = new Set([...(epCast[0]?.appearingCharacterIds || []).map(String), ...usedCharIds]);
  await p.query(`UPDATE drama_episodes SET appearing_character_ids=$1, updated_at=now() WHERE id=$2`,
    [JSON.stringify([...merged]), episodeId]);
  await dramaRecomputeState(p, episodeId);
  return cuts.length;
}

// ── チャット AI の設定操作 (CRUD)。<<<ACTIONS [...] ACTIONS>>> ブロックを実行する ──
// 対象: プロジェクト設定・制作メモ・キャラ・場所・エピソード + 生成ツール
// (generate_script / generate_cuts)。キャラ/場所は名前、話は話数で特定。
// 結果は日本語サマリで返してチャットに表示する。
// LLM が文字列リテラル内に生の改行を書きがち (メモの箇条書き等) なので、
// JSON.parse 前に文字列内の制御文字をエスケープする
function dramaEscapeCtrlInJsonStrings(s) {
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

async function dramaExecuteActions(p, projectId, actions, ctx = {}) {
  const applied = [];
  const strOr = (v, max) => (v === undefined || v === null) ? undefined : String(v).slice(0, max);
  const tokensOr = (v) => Array.isArray(v) ? JSON.stringify(v.map((s) => String(s).slice(0, 30)).slice(0, 6)) : undefined;
  // 数値リスト: "7,8" (カンマ区切り文字列) or [7,8]。文字列が基本 (数字だけの配列は
  // 検索グラウンディングが引用マーカーとして削るため、プロンプトで文字列を指示している)
  const numListOr = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、]/) : [])
    .map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n));
  const attached = ctx.attachedImageUrls || []; // 今回のメッセージの添付画像 URL
  for (const a of (actions || []).slice(0, 10)) {
    try {
      if (a.action === "update_project") {
        await p.query(
          `UPDATE drama_projects SET
             style_guide = COALESCE($1, style_guide),
             world_setting = COALESCE($2, world_setting),
             updated_at = now()
           WHERE id=$3`,
          [strOr(a.styleGuide, 500), strOr(a.worldSetting, 1000), projectId]
        );
        applied.push("プロジェクト設定を更新");
      } else if (a.action === "update_notes") {
        // AI がヘッダー行 (「制作メモ (…):」) ごと書き込みがちで、システムプロンプト側の
        // 見出しと二重になるため保存時に剥がす (本番の配線実測で発覚)
        const notes = (strOr(a.notes, 4000) || "").replace(/^制作メモ[^\n]*:\s*\n?/, "").trim();
        await p.query(`UPDATE drama_projects SET ai_notes=$1, updated_at=now() WHERE id=$2`, [notes, projectId]);
        applied.push("制作メモを更新");
      } else if (a.action === "create_character" && a.name) {
        await p.query(
          `INSERT INTO drama_characters (project_id, name, reading, description, appearance_prompt, identity_tokens, status)
           VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
          [projectId, strOr(a.name, 50), strOr(a.reading, 50) || null, strOr(a.description, 500) || null,
           strOr(a.appearancePrompt, 500) || null, tokensOr(a.identityTokens) || "[]"]
        );
        applied.push(`キャラ「${a.name}」を作成`);
      } else if (a.action === "update_character" && a.name) {
        const { rowCount } = await p.query(
          `UPDATE drama_characters SET
             reading = COALESCE($1, reading),
             description = COALESCE($2, description),
             appearance_prompt = COALESCE($3, appearance_prompt),
             identity_tokens = COALESCE($4::jsonb, identity_tokens),
             status = COALESCE($5, status),
             updated_at = now()
           WHERE project_id=$6 AND name=$7`,
          [strOr(a.reading, 50), strOr(a.description, 500), strOr(a.appearancePrompt, 500),
           tokensOr(a.identityTokens) || null, ["draft", "confirmed"].includes(a.status) ? a.status : null,
           projectId, strOr(a.name, 50)]
        );
        applied.push(rowCount ? `キャラ「${a.name}」を更新` : `キャラ「${a.name}」が見つからず更新失敗`);
      } else if (a.action === "delete_character" && a.name) {
        const { rowCount } = await p.query(`DELETE FROM drama_characters WHERE project_id=$1 AND name=$2`, [projectId, strOr(a.name, 50)]);
        applied.push(rowCount ? `キャラ「${a.name}」を削除` : `キャラ「${a.name}」が見つからず削除失敗`);
      } else if (a.action === "create_location" && a.name) {
        await p.query(
          `INSERT INTO drama_locations (project_id, name, description, appearance_prompt, identity_tokens, status)
           VALUES ($1,$2,$3,$4,$5,'draft')`,
          [projectId, strOr(a.name, 50), strOr(a.description, 500) || null,
           strOr(a.appearancePrompt, 500) || null, tokensOr(a.identityTokens) || "[]"]
        );
        applied.push(`場所「${a.name}」を作成`);
      } else if (a.action === "update_location" && a.name) {
        const { rowCount } = await p.query(
          `UPDATE drama_locations SET
             description = COALESCE($1, description),
             appearance_prompt = COALESCE($2, appearance_prompt),
             identity_tokens = COALESCE($3::jsonb, identity_tokens),
             status = COALESCE($4, status),
             updated_at = now()
           WHERE project_id=$5 AND name=$6`,
          [strOr(a.description, 500), strOr(a.appearancePrompt, 500),
           tokensOr(a.identityTokens) || null, ["draft", "confirmed"].includes(a.status) ? a.status : null,
           projectId, strOr(a.name, 50)]
        );
        applied.push(rowCount ? `場所「${a.name}」を更新` : `場所「${a.name}」が見つからず更新失敗`);
      } else if (a.action === "delete_location" && a.name) {
        const { rowCount } = await p.query(`DELETE FROM drama_locations WHERE project_id=$1 AND name=$2`, [projectId, strOr(a.name, 50)]);
        applied.push(rowCount ? `場所「${a.name}」を削除` : `場所「${a.name}」が見つからず削除失敗`);
      } else if (a.action === "create_episode" && a.number) {
        const chapterNumbers = numListOr(a.chapterNumbers);
        const appearing = await dramaCastFromChapters(p, projectId, chapterNumbers);
        await p.query(
          `INSERT INTO drama_episodes (project_id, number, title, chapter_numbers, pacing, focus, appearing_character_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [projectId, Number(a.number), strOr(a.title, 60) || null, JSON.stringify(chapterNumbers),
           ["compress", "normal", "stretch"].includes(a.pacing) ? a.pacing : "normal",
           strOr(a.focus, 300) || null, JSON.stringify(appearing)]
        );
        applied.push(`第${a.number}話を作成`);
      } else if (a.action === "update_episode" && a.number) {
        const chapterNumbers = (a.chapterNumbers !== undefined && a.chapterNumbers !== null)
          ? JSON.stringify(numListOr(a.chapterNumbers)) : undefined;
        const { rowCount } = await p.query(
          `UPDATE drama_episodes SET
             title = COALESCE($1, title),
             pacing = COALESCE($2, pacing),
             focus = COALESCE($3, focus),
             script = COALESCE($4, script),
             chapter_numbers = COALESCE($5::jsonb, chapter_numbers),
             updated_at = now()
           WHERE project_id=$6 AND number=$7`,
          [strOr(a.title, 60), ["compress", "normal", "stretch"].includes(a.pacing) ? a.pacing : null,
           strOr(a.focus, 300), strOr(a.script, 8000), chapterNumbers || null, projectId, Number(a.number)]
        );
        applied.push(rowCount ? `第${a.number}話を更新` : `第${a.number}話が見つからず更新失敗`);
      } else if (a.action === "delete_episode" && a.number) {
        const { rowCount } = await p.query(`DELETE FROM drama_episodes WHERE project_id=$1 AND number=$2`, [projectId, Number(a.number)]);
        applied.push(rowCount ? `第${a.number}話を削除` : `第${a.number}話が見つからず削除失敗`);
      } else if ((a.action === "confirm_character" || a.action === "confirm_location") && a.name) {
        // 「これで確定」: 対象の画像を参照画像として保存し、status を confirmed にする。
        // AI が "source" で対象を明示できる (引用画像を確定したい時に「最新の画像」を
        // 拾ってしまう事故の防止)。省略時は 生成 > 引用 > 添付 > 直近の会話 の優先順。
        const table = a.action === "confirm_character" ? "drama_characters" : "drama_locations";
        const label = a.action === "confirm_character" ? "キャラ" : "場所";
        const gen = ctx.generatedImageUrls || [];
        const recent = ctx.recentImageUrls || [];
        const quotedUrls = ctx.quotedImageUrls || [];
        const bySource = {
          generated: gen[gen.length - 1],
          quoted: quotedUrls[quotedUrls.length - 1],
          attached: attached[0],
          recent: recent[recent.length - 1],
        };
        const source = Object.hasOwn(bySource, a.source || "") ? a.source : null;
        if (source && !bySource[source]) {
          // source を明示したのに該当画像が無い → 別の画像を黙って拾わず失敗にする
          applied.push(`${label}「${a.name}」の確定失敗 (${source} の画像が見つかりません)`);
          continue;
        }
        const chosen = source
          || ["generated", "quoted", "attached", "recent"].find((k) => bySource[k]);
        const url = chosen && bySource[chosen];
        if (!url) { applied.push(`${label}「${a.name}」の確定失敗 (対象の画像が見つかりません)`); continue; }
        const srcLabel = { generated: "生成画像", quoted: "引用画像", attached: "添付画像", recent: "直近の画像" }[chosen];
        const { rows: found } = await p.query(
          `SELECT id, reference_images AS "referenceImages" FROM ${table} WHERE project_id=$1 AND name=$2`,
          [projectId, strOr(a.name, 60)]
        );
        if (!found.length) { applied.push(`${label}「${a.name}」が見つからず確定失敗`); continue; }
        const refs = [...(found[0].referenceImages || []), { url, kind: "full", note: "チャットで確定" }].slice(-4);
        await p.query(
          `UPDATE ${table} SET reference_images=$1, status='confirmed', updated_at=now() WHERE id=$2`,
          [JSON.stringify(refs), found[0].id]
        );
        applied.push(`${label}「${a.name}」を確定 (${srcLabel}を追加・参照画像 ${refs.length}枚)`);
      } else if ((a.action === "remove_character_image" || a.action === "remove_location_image") && a.name) {
        // 間違って確定した参照画像を外す。index は UI の並び順 (1 始まり)、"all" で全部
        const table = a.action === "remove_character_image" ? "drama_characters" : "drama_locations";
        const label = a.action === "remove_character_image" ? "キャラ" : "場所";
        const { rows: found } = await p.query(
          `SELECT id, reference_images AS "referenceImages" FROM ${table} WHERE project_id=$1 AND name=$2`,
          [projectId, strOr(a.name, 60)]
        );
        if (!found.length) { applied.push(`${label}「${a.name}」が見つからず画像削除失敗`); continue; }
        const refs = found[0].referenceImages || [];
        let next;
        if (a.index === "all") {
          next = [];
        } else {
          // 複数枚は "1,2" のカンマ区切り文字列 or 配列で受ける。1 アクションにまとめるのは
          // 別アクションに分けると 1 枚消すたびに番号がズレるため。文字列形式が基本なのは
          // [1,2] のような数字だけの配列を Gemini の検索グラウンディングが引用マーカーとして
          // 本文から削ってしまうため (実測)
          const idxs = (Array.isArray(a.index) ? a.index
            : typeof a.index === "string" ? a.index.split(/[,、]/)
            : [a.index]).map((v) => Number(String(v).trim()));
          const bad = idxs.find((n) => !Number.isInteger(n) || n < 1 || n > refs.length);
          if (bad !== undefined || !idxs.length) {
            applied.push(`${label}「${a.name}」の参照画像 ${JSON.stringify(a.index)} 枚目が見つかりません (現在 ${refs.length}枚・1始まり)`);
            continue;
          }
          const drop = new Set(idxs.map((n) => n - 1));
          next = refs.filter((_, i) => !drop.has(i));
        }
        await p.query(`UPDATE ${table} SET reference_images=$1, updated_at=now() WHERE id=$2`,
          [JSON.stringify(next), found[0].id]);
        applied.push(`${label}「${a.name}」の参照画像を削除 (残り ${next.length}枚)`);
      } else if (a.action === "set_style_reference") {
        if (!attached.length) { applied.push("基準画像の登録失敗 (このメッセージに画像が添付されていません)"); continue; }
        await p.query(`UPDATE drama_projects SET style_ref_images=$1, updated_at=now() WHERE id=$2`,
          [JSON.stringify(attached.slice(0, 2)), projectId]);
        applied.push(`作画基準画像を登録 (${Math.min(attached.length, 2)}枚)`);
      } else if (a.action === "clear_style_reference") {
        await p.query(`UPDATE drama_projects SET style_ref_images='[]'::jsonb, updated_at=now() WHERE id=$1`, [projectId]);
        applied.push("作画基準画像を解除");
      } else if (a.action === "save_asset" && a.name) {
        if (!attached.length) { applied.push(`資料「${a.name}」の保存失敗 (画像が添付されていません)`); continue; }
        for (const url of attached.slice(0, 2)) {
          await p.query(`INSERT INTO drama_assets (project_id, name, note, url) VALUES ($1,$2,$3,$4)`,
            [projectId, strOr(a.name, 60), strOr(a.note, 300) || null, url]);
        }
        applied.push(`資料「${a.name}」を保存`);
      } else if (a.action === "delete_asset" && a.name) {
        const { rowCount } = await p.query(`DELETE FROM drama_assets WHERE project_id=$1 AND name=$2`, [projectId, strOr(a.name, 60)]);
        applied.push(rowCount ? `資料「${a.name}」を削除` : `資料「${a.name}」が見つからず削除失敗`);
      } else if ((a.action === "generate_script" || a.action === "generate_cuts") && a.episodeNumber) {
        const { rows: epId } = await p.query(
          `SELECT id FROM drama_episodes WHERE project_id=$1 AND number=$2`, [projectId, Number(a.episodeNumber)]
        );
        if (!epId.length) {
          applied.push(`第${a.episodeNumber}話が見つからず${a.action === "generate_script" ? "脚本" : "カット"}生成失敗`);
        } else if (a.action === "generate_script") {
          await dramaRunWriteScript(p, epId[0].id);
          applied.push(`第${a.episodeNumber}話の脚本を生成`);
        } else {
          const n = await dramaRunComposeCuts(p, epId[0].id, { force: true });
          applied.push(`第${a.episodeNumber}話のカット割りを生成 (${n}カット)`);
        }
      } else {
        applied.push(`不明な操作: ${a.action || "(なし)"}`);
      }
    } catch (e) {
      console.warn(`[drama] action ${a.action} failed:`, e.message);
      applied.push(`${a.action} 失敗: ${e.message.slice(0, 80)}`);
    }
  }
  return applied;
}

// チャット添付画像: Firebase Storage の download URL からバイト列を取って
// Gemini の inlineData に変換する。https 限定 + 枚数/サイズ上限。
const DRAMA_CHAT_MAX_IMAGES = 4;
const DRAMA_CHAT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
async function dramaFetchImageParts(imageUrls, max = DRAMA_CHAT_MAX_IMAGES) {
  const parts = [];
  for (const url of (imageUrls || []).slice(0, max)) {
    if (url.startsWith("data:")) {
      // ローカル dev で生成した data URI もそのまま読めるように
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) parts.push({ inlineData: { data: m[2], mimeType: m[1] } });
      continue;
    }
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("画像 URL は https のみ");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`画像の取得に失敗: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > DRAMA_CHAT_MAX_IMAGE_BYTES) throw new Error("画像が大きすぎます (8MB まで)");
    const mimeType = r.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    parts.push({ inlineData: { data: buf.toString("base64"), mimeType } });
  }
  return parts;
}

// URL 群を inlineData に変換 (失敗した分は黙ってスキップ。参照画像用)
async function dramaFetchImagePartsSafe(imageUrls, max) {
  const parts = [];
  for (const url of (imageUrls || []).slice(0, max)) {
    try { parts.push(...await dramaFetchImageParts([url], 1)); } catch (e) {
      console.warn("[drama] ref image fetch skipped:", e.message);
    }
  }
  return parts;
}

// チャット処理の本体。同期ルートと Cloud Tasks ワーカーの両方から使う。
// 処理結果は assistantMessageId の行に書き込む (status: pending → done)。
// debug: { withImages: bool } を渡すと「本番同等の Gemini 呼び出しをするが、履歴に
// 書き込まず ACTIONS も実行しない」挙動テストモードになる (課金 kind は debug_ 接頭)
async function dramaProcessChat(p, { projectId, episodeId, message, imageUrls = [], quotedMessageId, userMessageId, assistantMessageId, dryRun = false, debug = null }) {
  const K = debug ? "debug_" : ""; // usage 記録の kind 接頭辞
  const timings = {};
  const t0 = Date.now();
  const { rows: projRows } = await p.query(
    `SELECT id, title, author, style_guide AS "styleGuide", world_setting AS "worldSetting",
            source_text AS "sourceText", ai_notes AS "aiNotes", style_ref_images AS "styleRefImages"
       FROM drama_projects WHERE id=$1`,
    [projectId]
  );
  if (!projRows.length) { const e = new Error("project not found"); e.status = 404; throw e; }
  const { rows: assets } = await p.query(
    `SELECT id, name, note, url FROM drama_assets WHERE project_id=$1 ORDER BY id`, [projectId]
  );
  const { rows: characters } = await p.query(
    `SELECT id, name, reading, status, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
       FROM drama_characters WHERE project_id=$1`,
    [projectId]
  );
  const { rows: chapters } = await p.query(
    `SELECT number, title, content, summary, character_names AS "characterNames", length(content) AS "charCount"
       FROM drama_chapters WHERE project_id=$1 ORDER BY number`,
    [projectId]
  );
  const { rows: locations } = await p.query(
    `SELECT id, name, status, identity_tokens AS "identityTokens", reference_images AS "referenceImages"
       FROM drama_locations WHERE project_id=$1`,
    [projectId]
  );
  let episode = null, cuts = [];
  if (episodeId) {
    const { rows: epRows } = await p.query(
      `SELECT id, number, title, key_visual AS "keyVisual", state, appearing_character_ids AS "appearingCharacterIds"
         FROM drama_episodes WHERE id=$1 AND project_id=$2`,
      [episodeId, projectId]
    );
    episode = epRows[0] || null;
    if (episode) {
      const { rows: cutRows } = await p.query(
        `SELECT id, "order", prompt, character_ids AS "characterIds", location_id AS "locationId", generations
           FROM drama_cuts WHERE episode_id=$1 ORDER BY "order"`,
        [episodeId]
      );
      cuts = cutRows;
    }
  }
  const missingInfo = computeMissingInfo({ project: projRows[0], characters, episode, cuts, locations });
  const systemPrompt = dramaBuildSystemPrompt({
    project: projRows[0], characters, episode, cuts, missingInfo, chapters, locations,
    aiNotes: projRows[0].aiNotes || "",
    styleRefCount: (projRows[0].styleRefImages || []).length,
    assets,
  });

  // 履歴: 今回の user メッセージ自身と pending 行は除外
  const { rows: history } = await p.query(
    episodeId
      ? `SELECT id, role, content, images FROM drama_chat_messages
           WHERE project_id=$1 AND episode_id=$2 AND id < $3 AND status='done' ORDER BY id DESC LIMIT 20`
      : `SELECT id, role, content, images FROM drama_chat_messages
           WHERE project_id=$1 AND episode_id IS NULL AND id < $2 AND status='done' ORDER BY id DESC LIMIT 20`,
    episodeId ? [projectId, episodeId, userMessageId] : [projectId, userMessageId]
  );
  history.reverse();

  // 直近の会話に出た画像 (ユーザー添付 + AI 生成) を古い順に最大 8 枚、AI に見せる。
  // 「前の画像とどう違う?」「前のここを直して」に加えて [画像再掲: k] で過去の画像を
  // そのまま返信に貼れるよう、URL と parts の並びを揃える (fetch 失敗分は両方から落とす)。
  // 新しい画像を優先しつつ合計 base64 ~12MB に抑える
  const recentChatImageUrls = history.flatMap((h) => h.images || []).slice(-8);
  const pickedHistory = [];
  let histB64 = 0;
  for (const url of [...recentChatImageUrls].reverse()) {
    try {
      const p = (await dramaFetchImageParts([url], 1))[0];
      if (!p) continue;
      if (histB64 + p.inlineData.data.length > 12_000_000) continue;
      histB64 += p.inlineData.data.length;
      pickedHistory.push({ url, part: p });
    } catch (e) { console.warn("[drama] history image fetch skipped:", e.message); }
  }
  pickedHistory.reverse(); // 古い順に戻す (番号ラベルと ctx の「最後の画像」判定を揃える)
  const historyImageUrls = pickedHistory.map((x) => x.url);
  const historyImageParts = pickedHistory.map((x) => x.part);

  // 引用返信: 引用先のメッセージ本文 + 画像は「この画像の感じで」の最優先参照
  let quoted = { text: "", parts: [], imageUrls: [] };
  if (quotedMessageId) {
    const { rows: qRows } = await p.query(
      `SELECT content, images FROM drama_chat_messages WHERE id=$1 AND project_id=$2`,
      [quotedMessageId, projectId]
    );
    if (qRows.length) {
      quoted.text = (qRows[0].content || "").slice(0, 300);
      quoted.imageUrls = (qRows[0].images || []).slice(0, 2);
      quoted.parts = await dramaFetchImagePartsSafe(quoted.imageUrls, 2);
    }
  }

  const imageParts = await dramaFetchImageParts(imageUrls);

  // dryRun: Gemini を呼ばず「モデルに実際に何が渡るか」の配線を返す。
  // プッシュ前の検証・本番の配線確認用 (参照画像の未配線みたいなバグを出荷前に潰す)。
  if (dryRun) {
    return {
      dryRun: true,
      systemPromptChars: systemPrompt.length,
      systemPromptHead: systemPrompt.slice(0, 400),
      historyMessages: history.length,
      historyImagesSent: historyImageParts.length,
      historyImageUrls,
      currentImagesSent: imageParts.length,
      quoted: { text: quoted.text, images: quoted.imageUrls.length },
      styleRefImages: (projRows[0].styleRefImages || []).length,
      assets: assets.map((a) => a.name),
      aiNotesChars: (projRows[0].aiNotes || "").length,
    };
  }

  timings.contextMs = Date.now() - t0;
  const tChat = Date.now();
  let reply = await dramaChatOnce(dramaTrackedGemini(projectId, K + "chat"), systemPrompt, history, message || "(画像を確認して)", imageParts, historyImageParts, quoted);
  timings.chatMs = Date.now() - tChat;
  const tImages = Date.now();

  // [画像生成: プロンプト] マーカーを検出したら実際に画像を作って返す (最大2枚)。
  // 生成後に AI 自身が意図どおりか審査し、NG なら修正プロンプトで作り直す (最大2回まで)。
  const generatedImages = [];
  // [画像再掲: k] = 会話の画像 k をそのまま返信に貼る (再生成しない・無料・劣化なし)。
  // モデルはマーカーの代わりにラベル「(会話の画像k)」を本文に書いてしまうことがある
  // (実測) ので、そちらも拾って画像を貼り、本文は読める文言に置き換える。
  // 番号が範囲外なら何もしない (それらしい別画像を勝手に出さないため)
  const attachReshow = (k) => {
    const url = historyImageUrls[Number(k) - 1];
    if (!url) return 0;
    let i = generatedImages.indexOf(url);
    if (i < 0) { generatedImages.push(url); i = generatedImages.length - 1; }
    return i + 1; // 添付での並び順 (1始まり)
  };
  reply = reply.replace(/\[画像再掲:\s*(?:会話の画像)?\s*(\d+)\s*\]/g, (m, k) => attachReshow(k) ? "" : m);
  reply = reply.replace(/[（(]会話の画像\s*(\d+)[）)]/g, (m, k) => {
    const n = attachReshow(k);
    return n ? `(添付${n}枚目)` : m;
  });
  // [登録画像: 名前 k] = キャラ/場所の参照画像 (画面の並び・1始まり、番号省略で最後の1枚)、
  // [資料画像: 名前] = 登録済み資料。会話の添付ウィンドウより古い確定済み画像を
  // 「もう一度見せて」に応えられるようにする (こちらも再生成なし)
  const attachUrl = (url) => { if (url && !generatedImages.includes(url)) generatedImages.push(url); return !!url; };
  reply = reply.replace(/\[登録画像:\s*([^\]]+?)(?:[\s　]+(\d+))?\s*\]/g, (m, name, k) => {
    const ent = [...characters, ...locations].find((x) => x.name === name.trim());
    const refs = ent?.referenceImages || [];
    const url = k ? refs[Number(k) - 1]?.url : refs[refs.length - 1]?.url;
    return attachUrl(url) ? "" : m;
  });
  reply = reply.replace(/\[資料画像:\s*([^\]]+?)\s*\]/g, (m, name) => {
    const a = assets.find((x) => x.name === name.trim());
    return attachUrl(a?.url) ? "" : m;
  });
  // [画像検索: 検索語1 / 検索語2 ...] = web (Wikimedia Commons / Openverse) から
  // 参考画像を探して出典付きで貼る。API キー不要・無料。1 返答 1 回まで。
  // 実測で分かっているモデルの癖への対策を全部ここに集約:
  //  - マーカーを書かず文章要約や [画像生成] で代用する → 依頼文から意図判定して検索
  //  - 検索語を日本語で書いて 0 件 → 英語クエリを起こして再検索
  const trySearch = async (queries, limit = 10) => {
    try { return await dramaSearchWebImages(queries, limit); } catch (e) {
      console.warn("[drama] web image search failed:", e.message);
      return [];
    }
  };
  // 候補タイトルを flash-lite に審査させ、依頼に本当に関連あるものだけ残す。
  // Commons のキーワード検索は字面一致で無関係な画像を平気で返す
  // (実測:「マリアののぼり」→ Mary Baker Eddy の 1868 年の新聞広告) ため、貼る前に必ず通す
  const vetResults = async (candidates) => {
    if (!candidates.length) return [];
    try {
      const { result } = await dramaTrackedGemini(projectId, K + "imgvet")(
        `ユーザーの依頼: ${(message || "").slice(0, 300)}\n` +
        `画像検索の候補 (タイトル — 出典):\n` +
        candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.source}`).join("\n") +
        `\n\n依頼の参考画像として本当に関連があるものの番号だけを JSON の数値配列で返す。` +
        `字面が似ているだけで無関係なもの (人名・新聞・別分野) は含めない。全部無関係なら []。`,
        { primaryModel: "gemini-2.5-flash-lite", maxOutputTokens: 300, jsonMode: true }
      );
      const t = (result.response.text() || "").trim();
      const arr = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
      const idx = (Array.isArray(arr) ? arr : []).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length);
      return idx.map((n) => candidates[n - 1]);
    } catch (e) {
      console.warn("[drama] imgvet failed:", e.message);
      return candidates; // 審査に失敗したら素通し (無いよりまし)
    }
  };
  const searchAndVet = async (queries) => (await vetResults(await trySearch(queries))).slice(0, 4);
  const appendSearchResults = (queries, found) => {
    for (const f of found) attachUrl(f.imageUrl);
    reply += `\n\n画像検索「${queries[0]}」: ${found.length}件 (画像の並び順)\n` +
      found.map((f, i) => `${i + 1}. ${(f.title || "無題").slice(0, 60)} — ${f.source}\n   ${f.pageUrl}`).join("\n");
  };
  // flash-lite で英語検索クエリを起こす。judgeIntent=true なら「画像を探す依頼か」の
  // 判定込み (違えば空配列が返る)
  const genSearchQueries = async (context) => {
    try {
      const { result } = await dramaTrackedGemini(projectId, K + "imgquery")(
        `${context}\n\n` +
        `Wikimedia Commons / Openverse で実在の参考画像を探すための検索クエリを、` +
        `具体的→広い の順で3案、JSON の文字列配列だけで返す。クエリは必ず英語 ` +
        `(日本の固有名詞のみローマ字可)・各2〜4語。美術・歴史資料なら時代や様式の用語を使う ` +
        `(例: "Madonna and Child nanban", "Virgin Mary Jesuit Japan", "processional banner")。` +
        `もし「web で参考画像を探してほしい」という依頼でなければ [] だけを返す。`,
        { primaryModel: "gemini-2.5-flash-lite", maxOutputTokens: 500, jsonMode: true }
      );
      const t = (result.response.text() || "").trim();
      const arr = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
      return (Array.isArray(arr) ? arr : []).map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 3);
    } catch (e) {
      console.warn("[drama] imgquery failed:", e.message);
      return [];
    }
  };
  const searchContext = `ユーザーの依頼: ${(message || "").slice(0, 300)}\nアシスタントの回答: ${reply.slice(0, 1200)}`;
  const webSearchM = reply.match(/\[画像検索:\s*([\s\S]*?)\]/);
  if (webSearchM) {
    reply = reply.replace(/\[画像検索:\s*[\s\S]*?\]/g, "").trim();
    let queries = webSearchM[1].split(/[/／]/).map((s) => s.trim().slice(0, 80)).filter(Boolean);
    let found = await searchAndVet(queries);
    if (!found.length) {
      // 0 件 or 全部無関係 → 英語クエリを起こして 1 回だけ再検索
      const eq = await genSearchQueries(`${searchContext}\n(検索語「${queries.join(" / ")}」では関連する画像が見つからなかった)`);
      if (eq.length) { const f2 = await searchAndVet(eq); if (f2.length) { queries = eq; found = f2; } }
    }
    if (found.length) appendSearchResults(queries, found);
    else reply += `\n\n(画像検索「${queries.join(" / ")}」: 依頼に合う画像が見つかりませんでした。欲しいイメージをもう少し具体的に言ってもらえると当たりやすいです)`;
  } else if (/探し|探して|検索し|見つけて/.test(message || "") && !generatedImages.length) {
    // マーカー無しの保険。画像を探す依頼かどうかの判定は flash-lite に任せる
    const eq = await genSearchQueries(searchContext);
    if (eq.length) {
      const found = await searchAndVet(eq);
      if (found.length) appendSearchResults(eq, found);
      // 誤発火の可能性があるので 0 件時は何も足さない
    }
  }
  // [引用: メッセージ番号] = LINE の返信のように過去メッセージを引用表示する。
  // 番号は会話ログの (#n)。履歴に無い番号は無視 (適当な引用を防ぐ)
  let replyQuotedMessageId = null;
  reply = reply.replace(/\[引用:\s*#?(\d+)\s*\]/g, (m, idStr) => {
    const id = Number(idStr);
    if (!replyQuotedMessageId && history.some((h) => Number(h.id) === id)) replyQuotedMessageId = id;
    return "";
  }).trim();
  // [画像生成: ...] = 新規生成 / [画像編集: ...] = 直前の画像 (引用 > 添付 > 会話の最後の画像) を編集
  let markers = [...reply.matchAll(/\[画像(生成|編集):\s*([\s\S]*?)\]/g)].slice(0, 2);
  const markerInfo = markers.map((m) => ({ mode: m[1], prompt: m[2].trim().slice(0, 300) }));
  if (debug && !debug.withImages) markers = []; // debug で画像不要なら生成をスキップ (マーカー情報は返す)
  // 参照画像 (絵柄を寄せる): 作画基準画像 → 今回の添付 → 名前が一致する資料/キャラ参照 (最大4枚)
  let styleRefParts = [];
  if (markers.length) {
    styleRefParts = await dramaFetchImagePartsSafe(projRows[0].styleRefImages || [], 2);
  }
  const imageRuns = []; // debug 用: 各マーカーの生成過程 (参照枚数・作り直し回数)
  for (const mk of markers) {
    try {
      const isEdit = mk[1] === "編集";
      let imgPrompt = mk[2].trim();
      // 編集対象:「これ」が指すもの = 引用画像 > 今回の添付 > 会話の最後の画像 (直前の生成物含む)
      let editBaseParts = [];
      if (isEdit) {
        const baseUrl = quoted.imageUrls[0] || imageUrls[0]
          || generatedImages[generatedImages.length - 1]
          || historyImageUrls[historyImageUrls.length - 1];
        if (baseUrl) editBaseParts = await dramaFetchImagePartsSafe([baseUrl], 1);
      }
      // 引用画像が最優先 (「この画像の感じで作って」)、次に基準画像・今回の添付
      const refParts = isEdit
        ? [...editBaseParts, ...styleRefParts]
        : [...quoted.parts, ...styleRefParts, ...imageParts.slice(0, 2)];
      if (!isEdit) {
        for (const a of assets) {
          if (refParts.length >= 4) break;
          if (a.name && imgPrompt.includes(a.name)) refParts.push(...await dramaFetchImagePartsSafe([a.url], 1));
        }
        for (const c of characters) {
          if (refParts.length >= 4) break;
          if (c.name && imgPrompt.includes(c.name) && (c.referenceImages || []).length) {
            refParts.push(...await dramaFetchImagePartsSafe([c.referenceImages[0].url], 1));
          }
        }
      }
      let img = null;
      let attempts = 0;
      let editInstruction = null; // 2回目以降は「前の画像の問題点だけ直す」編集モード (絵柄が保たれ収束が速い)
      const MAX_REMAKES = 2; // 初回 + 作り直し2回 = 最大3生成
      while (true) {
        if (editInstruction && img) {
          img = await dramaGenerateImage(
            `添付の 1 枚目の画像を修正してください。キャラクター・絵柄・構図は保ったまま、次の問題だけ直す: ${editInstruction}\n(元の意図: ${imgPrompt})`,
            [{ inlineData: { data: img.data, mimeType: img.mimeType } }, ...refParts.slice(0, 3)],
            { refNote: "1枚目が修正対象の画像。2枚目以降は絵柄・キャラデザインの基準。レイアウト・注釈文字・関係ない他キャラを持ち込まない" }
          );
        } else if (isEdit && editBaseParts.length) {
          img = await dramaGenerateImage(
            `添付の 1 枚目の画像を編集してください。キャラクター・絵柄・構図は保ったまま、次の指示だけ反映する: ${imgPrompt}`,
            refParts.slice(0, 4),
            { refNote: "1枚目が編集対象の画像。2枚目以降は絵柄の基準。編集対象のデザインを保ち、指示された変更だけ行う。レイアウト・注釈文字・関係ない他キャラを持ち込まない" }
          );
        } else {
          img = await dramaGenerateImage(imgPrompt, refParts.slice(0, 4));
        }
        dramaRecordUsage({ projectId, provider: "gemini", kind: K + "chat_image", model: DRAMA_GEMINI_IMAGE_MODEL, costYen: DRAMA_GEMINI_IMAGE_YEN });
        attempts++;
        if (attempts > MAX_REMAKES) break;
        try {
          const review = await dramaReviewImage(dramaTrackedGemini(projectId, K + "image_review"), {
            prompt: imgPrompt, styleGuide: projRows[0].styleGuide,
            imageBase64: img.data, mimeType: img.mimeType,
            styleRefParts,
          });
          if (review.ok) break;
          console.log(`[drama] image self-review NG (attempt ${attempts}): ${review.problems}`);
          editInstruction = [review.problems, review.revisedPrompt].filter(Boolean).join(" / ");
        } catch (e) {
          console.warn("[drama] image review failed, keeping image:", e.message);
          break;
        }
      }
      if (attempts > 1) reply += `\n(画像を自己チェックして ${attempts - 1} 回作り直しました)`;
      imageRuns.push({ mode: isEdit ? "編集" : "生成", refImagesUsed: refParts.length, attempts, editBaseFound: !isEdit || editBaseParts.length > 0 });
      if (storage && RECEIPTS_BUCKET) {
        const ext = img.mimeType.includes("jpeg") ? "jpg" : "png";
        const key = `drama/chat/${projectId}/${Date.now()}_${generatedImages.length}.${ext}`;
        await storage.bucket(RECEIPTS_BUCKET).file(key).save(Buffer.from(img.data, "base64"), { contentType: img.mimeType, resumable: false });
        const [url] = await storage.bucket(RECEIPTS_BUCKET).file(key)
          .getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
        generatedImages.push(url);
      } else {
        generatedImages.push(`data:${img.mimeType};base64,${img.data}`); // ローカル dev 用
      }
    } catch (e) {
      console.warn("[drama] chat image gen failed:", e.message);
      reply += `\n(画像生成に失敗: ${e.message})`;
    }
  }
  if (markers.length) reply = reply.replace(/\[画像(生成|編集):\s*[\s\S]*?\]/g, "").trim();

  timings.imagesMs = Date.now() - tImages;

  // <<<ACTIONS [...] ACTIONS>>> ブロック = AI による設定の CRUD。実行して結果を通知。
  // debug モードでは解析だけして実行しない (本物のデータを書き換えないため)
  let applied = [];
  let actionsParsed = null;
  let actionsRaw = null; // debug 用: parse 失敗の原因調査にモデルの生出力を返す
  // モデルが履歴の「⚙ 実行: …」(システムが付ける実行結果行) を真似て、ACTIONS を
  // 書かずに実行済みのフリをすることがある (実測)。偽の実行行は削る
  reply = reply.replace(/^⚙\s*実行:.*$/gm, "").trim();
  const actionsMatch = reply.match(/<<<ACTIONS([\s\S]*?)ACTIONS>>>/);
  if (actionsMatch) {
    actionsRaw = actionsMatch[1].trim().slice(0, 3000);
    reply = reply.replace(/<<<ACTIONS[\s\S]*?ACTIONS>>>/g, "").trim();
    try {
      const raw = actionsMatch[1].trim();
      const s = raw.indexOf("[");
      const e = raw.lastIndexOf("]");
      const jsonText = dramaEscapeCtrlInJsonStrings(raw.slice(s, e + 1)).replace(/,(\s*[}\]])/g, "$1");
      let actions;
      try {
        actions = JSON.parse(jsonText);
      } catch (e1) {
        // 検索グラウンディングが [1,2] 型の値を引用マーカーとして食うと "index":} のように
        // 値だけ消える。null で埋めて他のアクションは救う (該当アクションは実行時に失敗を通知)
        actions = JSON.parse(jsonText.replace(/:(\s*)([,}\]])/g, ": null$2"));
      }
      actionsParsed = actions;
      if (!debug) {
        applied = await dramaExecuteActions(p, projectId, actions, {
          attachedImageUrls: imageUrls,
          generatedImageUrls: generatedImages,
          recentImageUrls: historyImageUrls,
          quotedImageUrls: quoted.imageUrls,
        });
        if (applied.length) reply += `\n\n⚙ 実行: ${applied.join(" / ")}`;
      }
    } catch (e) {
      console.warn("[drama] actions parse failed:", e.message);
      reply += `\n(設定操作の解析に失敗: ${e.message.slice(0, 80)})`;
    }
  }

  // [メッセージ区切り] = LINE のように複数の吹き出しに分けて送る (最大 3 通)。
  // 画像と ⚙ 実行行は最後の吹き出しに付く
  let bubbles = reply.split(/\s*\[メッセージ区切り\]\s*/).map((s) => s.trim()).filter(Boolean);
  if (bubbles.length > 3) bubbles = [...bubbles.slice(0, 2), bubbles.slice(2).join("\n\n")];
  if (!bubbles.length) bubbles = [reply];
  reply = bubbles.join("\n\n"); // 戻り値・debug 表示用は結合したもの

  if (debug) {
    return {
      reply, images: generatedImages, markers: markerInfo, imageRuns, actionsParsed, actionsRaw,
      quotedMessageId: replyQuotedMessageId, bubbles: bubbles.length,
      timings, systemPromptChars: systemPrompt.length,
      historyImagesSent: historyImageParts.length, currentImagesSent: imageParts.length,
      quoted: { text: quoted.text, images: quoted.imageUrls.length },
      styleRefImages: (projRows[0].styleRefImages || []).length,
    };
  }

  const imagesJson = JSON.stringify(generatedImages);
  await p.query(
    `UPDATE drama_chat_messages
        SET content=$1, images=$2, status='done', quoted_message_id=COALESCE($4, quoted_message_id)
      WHERE id=$3`,
    [bubbles[0], bubbles.length > 1 ? "[]" : imagesJson, assistantMessageId, replyQuotedMessageId]
  );
  for (let i = 1; i < bubbles.length; i++) {
    await p.query(
      `INSERT INTO drama_chat_messages (project_id, episode_id, role, content, images, status)
       VALUES ($1,$2,'assistant',$3,$4,'done')`,
      [projectId, episodeId || null, bubbles[i], i === bubbles.length - 1 ? imagesJson : "[]"]
    );
  }
  return { reply, images: generatedImages, applied };
}

// Cloud Tasks への enqueue (kaigi と同じ queue を使う)。設定が無ければ null (= 同期処理へ)
async function enqueueDramaChatWork(payload) {
  if (!KAIGI_TASKS_QUEUE || !SERVICE_URL || !INTERNAL_TICK_SECRET || !FIREBASE_PROJECT_ID) return null;
  const client = getTasksClient();
  const parent = client.queuePath(FIREBASE_PROJECT_ID, KAIGI_TASKS_LOCATION, KAIGI_TASKS_QUEUE);
  const [resp] = await client.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: `${SERVICE_URL}/api/internal/drama/chat-work`,
        headers: { "content-type": "application/json", "x-tick-secret": INTERNAL_TICK_SECRET },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
    },
  });
  return resp.name;
}

// AI チャット: 現在の制作状態 (キャラ/章/エピソード/カット/不足情報) を毎回組み立てて渡す。
// 画像添付はクライアントが Firebase Storage に上げた URL を imageUrls で渡してくる。
// iOS Safari の fetch が 60 秒程度で切れる (Load failed) ため、処理は Cloud Tasks に
// 逃がして即返し {pendingId} → クライアントがポーリング。queue 未設定なら同期処理。
app.post("/api/drama/projects/:id/chat", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  if (!genAI) return res.status(503).json({ error: "Gemini not configured" });
  try {
    const { message, episodeId, imageUrls = [], quotedMessageId } = req.body || {};
    if (!message && !imageUrls.length) return res.status(400).json({ error: "message is required" });

    const { rows: userRows } = await p.query(
      `INSERT INTO drama_chat_messages (project_id, episode_id, role, content, images, quoted_message_id)
       VALUES ($1,$2,'user',$3,$4,$5) RETURNING id`,
      [req.params.id, episodeId || null, message || "", JSON.stringify(imageUrls.slice(0, DRAMA_CHAT_MAX_IMAGES)),
       quotedMessageId || null]
    );
    const { rows: asstRows } = await p.query(
      `INSERT INTO drama_chat_messages (project_id, episode_id, role, content, images, status)
       VALUES ($1,$2,'assistant','','[]','pending') RETURNING id`,
      [req.params.id, episodeId || null]
    );
    const job = {
      projectId: req.params.id, episodeId: episodeId || null,
      message: message || "", imageUrls: imageUrls.slice(0, DRAMA_CHAT_MAX_IMAGES),
      quotedMessageId: quotedMessageId || null,
      userMessageId: userRows[0].id, assistantMessageId: asstRows[0].id,
    };

    try {
      const taskName = await enqueueDramaChatWork(job);
      if (taskName) return res.json({ pendingId: asstRows[0].id });
    } catch (e) {
      console.warn("[drama] chat enqueue failed, falling back to sync:", e.message);
    }
    // Cloud Tasks が使えない環境 (ローカル等) は同期処理。
    // 失敗時も pending 行を孤児にしない (エラーを行に書いて返す)
    try {
      const result = await dramaProcessChat(p, job);
      res.json({ ...result, messageId: asstRows[0].id });
    } catch (e) {
      const msg = `(エラー: ${String(e.message || e).slice(0, 300)})`;
      await p.query(`UPDATE drama_chat_messages SET content=$1, status='done' WHERE id=$2`, [msg, asstRows[0].id]).catch(() => {});
      res.json({ reply: msg, images: [], applied: [], messageId: asstRows[0].id });
    }
  } catch (err) {
    console.error("[drama] chat", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Cloud Tasks からのコールバック (x-tick-secret 認証は /api middleware が処理)。
// 失敗も assistant 行に書いて 200 を返す (Cloud Tasks の自動リトライで二重処理させない)
app.post("/api/internal/drama/chat-work", async (req, res) => {
  const p = getPool();
  if (!p) return res.status(503).json({ error: "DB not configured" });
  const job = req.body || {};
  try {
    await dramaProcessChat(p, job);
  } catch (e) {
    console.error("[drama] chat-work failed:", e);
    try {
      await p.query(
        `UPDATE drama_chat_messages SET content=$1, status='done' WHERE id=$2`,
        [`(エラー: ${String(e.message || e).slice(0, 300)})`, job.assistantMessageId]
      );
    } catch (_) {}
  }
  res.json({ ok: true });
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
