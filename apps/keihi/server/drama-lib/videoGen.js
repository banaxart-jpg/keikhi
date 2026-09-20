// カット動画生成: BytePlus ModelArk (Seedance 2.0 系) 接続。
// タスク作成 → ポーリングの非同期 API なので、こちらも「作る」「見る」を分けて export する。
// (Cloud Run のリクエストタイムアウト内で生成完了を待たない設計)
//
// 必要な env (Cloud Run に設定済み):
//   SEEDANCE_API_KEY   … ModelArk の API キー
//   SEEDANCE_BASE_URL  … 例: https://ark.ap-southeast.bytepluses.com/api/v3
//
// リクエストの項目名は ModelArk のドキュメントに合わせている (推測で書かない):
//   Create a video generation task: docs.byteplus.com/en/docs/ModelArk/1520757
//   Retrieve a video generation task: docs.byteplus.com/en/docs/ModelArk/1521309
//   Dreamina Seedance 2.0 series tutorial: docs.byteplus.com/en/docs/ModelArk/2291680
// Seedance 2.0 系で使える項目 (2026-09 時点のドキュメント):
//   content[]: {type:"text", text} / {type:"image_url", image_url:{url}, role:"reference_image"}
//              / {type:"video_url", video_url:{url}, role:"reference_video"}
//              / {type:"audio_url", audio_url:{url}, role:"reference_audio"}
//     参照画像 1〜9 枚 (jpeg/png/webp/bmp/tiff/gif、30MB 未満、縦横 300〜6000px、比率 0.4〜2.5)
//     参照動画 最大 3 本・各 2〜15 秒・合計 15 秒以内 (mp4/mov、200MB 以内)
//     参照音声 最大 3 本・各 2〜15 秒・合計 15 秒以内 (wav/mp3、15MB 以内)。音声だけの入力は不可
//     first_frame / last_frame 役割と reference_* は混在不可
//   ratio: 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 | adaptive (既定 adaptive)
//   resolution: fast / mini は 480p | 720p (既定 720p)。2.0 (無印) は 1080p / 4k も可
//   duration: 4〜15 (整数秒) または -1。generate_audio / watermark / return_last_frame: boolean
//   (seed / camera_fixed / frames は 1.x 系のみで 2.0 系は非対応なので送らない)
// 取得 API の返り: status (queued|running|succeeded|failed|cancelled|expired)、content.video_url (24 時間有効)、
//   content.last_frame_url、usage.completion_tokens、resolution、ratio、duration、framespersecond
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 料金・画素数の設定 (drama-video-pricing.json)。読めなくても動く (コストが null になるだけ)
let PRICING = { usdJpy: 155, fps: 24, defaultModel: "dreamina-seedance-2-0-fast-260128", aliases: {}, models: {}, pixels: {} };
try {
  PRICING = { ...PRICING, ...JSON.parse(fs.readFileSync(path.join(__dirname, "..", "drama-video-pricing.json"), "utf8")) };
} catch (e) {
  console.warn("[videoGen] drama-video-pricing.json 読み込み失敗:", e.message);
}

// モデル ID は小西指示でハードコード (新モデルが出たら pricing.json を書き換えて push)。
// アカウントで開通済みのモデルが別 ID の場合は Cloud Run の env SEEDANCE_MODEL で上書きできる
// (未開通エラー: "has not activated the model ..." が出たらこれ)
export const SEEDANCE_MODEL = (process.env.SEEDANCE_MODEL || "").trim() || PRICING.defaultModel;
export const SEEDANCE_FPS = Number(PRICING.fps) || 24;
export const SEEDANCE_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
export const SEEDANCE_LIMITS = { images: 9, videos: 3, audios: 3, refMediaTotalSec: 15, durationMin: 4, durationMax: 15 };

const API_KEY = process.env.SEEDANCE_API_KEY || process.env.SEADANCE_API_KEY || "";
const BASE_URL = (process.env.SEEDANCE_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "");

export function seedanceConfigured() {
  return !!API_KEY;
}

// "mini" / "fast" / "2.0" のような別名を正式な ID に読み替える。未知の文字列はそのまま (開通済み ID の直指定用)
export function resolveSeedanceModel(name) {
  const s = String(name || "").trim();
  if (!s) return SEEDANCE_MODEL;
  const key = s.toLowerCase();
  return PRICING.aliases?.[key] || s;
}

export function seedanceModelInfo(model) {
  return PRICING.models?.[model] || null;
}

// 比率 × 解像度 → [幅, 高さ] (ドキュメントの Seedance 2.0 series 列)。adaptive は不明なので null
export function seedanceDims(ratio, resolution) {
  const r = PRICING.pixels?.[resolution]?.[ratio];
  return Array.isArray(r) ? { width: r[0], height: r[1] } : null;
}

// 動画トークン = 幅×高さ×fps×秒 / 1024
export function seedanceEstimateTokens({ width, height, fps = SEEDANCE_FPS, durationSec }) {
  if (!width || !height || !durationSec) return null;
  return Math.round((width * height * fps * durationSec) / 1024);
}

// トークン → 円。単価未設定のモデルは null
export function seedanceCost(model, tokens) {
  const info = seedanceModelInfo(model);
  const per1k = info?.usdPer1kTokens;
  if (!tokens || typeof per1k !== "number") return { usd: null, yen: null, usdPer1kTokens: per1k ?? null, usdJpy: PRICING.usdJpy };
  const usd = (tokens / 1000) * per1k;
  return { usd: Math.round(usd * 10000) / 10000, yen: Math.round(usd * PRICING.usdJpy), usdPer1kTokens: per1k, usdJpy: PRICING.usdJpy };
}

async function arkFetch(pathname, opts = {}) {
  const res = await fetch(BASE_URL + pathname, {
    ...opts,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    const code = body?.error?.code ? ` [${body.error.code}]` : "";
    throw new Error(`Seedance API: ${msg}${code}`);
  }
  return body;
}

// 生成タスクを投げる。参照画像 (キャラの referenceImages / キービジュアル) で一貫性を担保。
// 戻り: { taskId, model, request: { ratio, resolution, duration, refs } }
export async function createCutVideoTask({
  prompt,
  referenceImageUrls = [],
  referenceVideoUrls = [],
  referenceAudioUrls = [],
  durationSec = 8,
  model = SEEDANCE_MODEL,
  ratio = "9:16",
  resolution = "720p",
  generateAudio = false,
  returnLastFrame = false,
  watermark = false,
} = {}) {
  if (!API_KEY) throw new Error("SEEDANCE_API_KEY が未設定です");
  if (!prompt) throw new Error("プロンプトが未設定です");
  model = resolveSeedanceModel(model);
  const info = seedanceModelInfo(model);

  if (!SEEDANCE_RATIOS.includes(ratio)) throw new Error(`aspectRatio は ${SEEDANCE_RATIOS.join(" / ")} のいずれか (指定: ${ratio})`);
  if (!SEEDANCE_RESOLUTIONS.includes(resolution)) throw new Error(`resolution は ${SEEDANCE_RESOLUTIONS.join(" / ")} のいずれか (指定: ${resolution})`);
  if (info?.resolutions && !info.resolutions.includes(resolution)) {
    throw new Error(`${info.label || model} は resolution ${info.resolutions.join(" / ")} のみ対応 (指定: ${resolution})。1080p は model: "2.0" (dreamina-seedance-2-0-260128) を使う`);
  }
  const images = (referenceImageUrls || []).filter(Boolean);
  const videos = (referenceVideoUrls || []).filter(Boolean);
  const audios = (referenceAudioUrls || []).filter(Boolean);
  if (images.length > SEEDANCE_LIMITS.images) throw new Error(`参照画像は最大 ${SEEDANCE_LIMITS.images} 枚 (指定: ${images.length})`);
  if (videos.length > SEEDANCE_LIMITS.videos) throw new Error(`参照動画は最大 ${SEEDANCE_LIMITS.videos} 本 (指定: ${videos.length})`);
  if (audios.length > SEEDANCE_LIMITS.audios) throw new Error(`参照音声は最大 ${SEEDANCE_LIMITS.audios} 本 (指定: ${audios.length})`);
  if (audios.length && !images.length && !videos.length) {
    throw new Error("Seedance 2.0 系は音声だけの参照に対応していない。参照画像か参照動画を 1 つ以上つける");
  }

  const content = [{ type: "text", text: prompt }];
  for (const url of images) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  for (const url of videos) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  for (const url of audios) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });

  const duration = Math.max(SEEDANCE_LIMITS.durationMin, Math.min(SEEDANCE_LIMITS.durationMax, Math.round(durationSec)));
  const body = {
    model,
    content,
    ratio,
    duration,
    resolution,
    watermark: !!watermark,
    generate_audio: !!generateAudio,
    return_last_frame: !!returnLastFrame,
  };
  const r = await arkFetch("/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) });
  if (!r.id) throw new Error("Seedance API: task id が返りませんでした");
  return {
    taskId: r.id, model,
    request: { ratio, resolution, duration, refs: { images: images.length, videos: videos.length, audios: audios.length } },
  };
}

// タスク状況を見る。
// 戻り: { status: "queued"|"running"|"succeeded"|"failed"|"cancelled"|"expired"|"unknown",
//         videoUrl, lastFrameUrl, error, usage: { completionTokens, totalTokens }, resolution, ratio, duration, fps }
export async function getVideoTask(taskId) {
  if (!API_KEY) throw new Error("SEEDANCE_API_KEY が未設定です");
  const r = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(taskId)}`);
  const status = r.status || "unknown";
  const errMsg = r.error?.message ? `${r.error.message}${r.error.code ? ` [${r.error.code}]` : ""}` : null;
  return {
    status,
    videoUrl: r.content?.video_url || null,
    lastFrameUrl: r.content?.last_frame_url || null,
    error: errMsg || (status === "failed" ? "生成に失敗しました" : status === "expired" ? "タスクが期限切れになりました" : status === "cancelled" ? "タスクがキャンセルされました" : null),
    usage: {
      completionTokens: Number.isFinite(Number(r.usage?.completion_tokens)) ? Number(r.usage.completion_tokens) : null,
      totalTokens: Number.isFinite(Number(r.usage?.total_tokens)) ? Number(r.usage.total_tokens) : null,
    },
    resolution: r.resolution || null,
    ratio: r.ratio || null,
    duration: Number.isFinite(Number(r.duration)) ? Number(r.duration) : null,
    fps: Number.isFinite(Number(r.framespersecond)) ? Number(r.framespersecond) : null,
  };
}

// ───── ローカル/dev 用モック (SEEDANCE_API_KEY 未設定時のフォールバック) ─────
const MOCK_VIDEO_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

export async function generateCutVideoMock({ prompt, durationSec = 8, model = SEEDANCE_MODEL }) {
  if (!prompt) return { status: "failed", videoUrl: null, model, note: "プロンプトが未設定です" };
  await new Promise((r) => setTimeout(r, 500));
  return {
    status: "done",
    videoUrl: MOCK_VIDEO_URL,
    model: model + " (mock)",
    note: `mock: SEEDANCE_API_KEY 未設定のためプレースホルダー動画 (${durationSec}秒指定)`,
  };
}
