// Veo (Google Gemini API) の動画生成。Seedance が実在人物の顔を含む参照を拒否するため、
// 本人写真から実写動画を作る用途はこちらに回す。
//
// 項目名は公式ドキュメントに合わせている (推測で書かない):
//   ai.google.dev/gemini-api/docs/veo (parameters 表・REST 例)、ai.google.dev/gemini-api/docs/pricing
// 2026-10 時点の仕様:
//   POST {BASE}/models/{model}:predictLongRunning  (ヘッダ x-goog-api-key)
//   instances[0]: prompt / image / referenceImages: [{image, referenceType:"asset"}] (3.1 と 3.1 Fast のみ、最大 3)
//                 / lastFrame / video (拡張用)
//   画像オブジェクトの形はドキュメントと実 API で食い違う (2026-10 実測):
//     ドキュメントの curl 例は {inlineData:{mimeType,data}} だが、predictLongRunning に送ると
//     「`inlineData` isn't supported by this model [INVALID_ARGUMENT]」で弾かれる。
//     SDK (google-genai) は imageBytes を bytesBase64Encoded に変換して送る実装なので、
//     こちらは {bytesBase64Encoded, mimeType} を第一候補にし、INVALID_ARGUMENT で画像の形を
//     指摘されたら別の形で投げ直す (通った形はプロセス内で記憶)。env VEO_IMAGE_SHAPE で固定もできる
//   parameters: aspectRatio "16:9"|"9:16" / durationSeconds 4|6|8 (ドキュメントの表は "4" と引用符付きだが、
//               実 API は数値でないと「needs to be a number [INVALID_ARGUMENT]」になる。本番実測 2026-10。参照画像・1080p・4k は 8 固定)
//               / resolution "720p"|"1080p"|"4k" (Lite は 4k なし) / personGeneration (image-to-video は "allow_adult" のみ) / seed
//   GET {BASE}/{operation.name} → done:true で response.generateVideoResponse.generatedSamples[0].video.uri
//   動画のダウンロードも x-goog-api-key ヘッダ。サーバー保持は 2 日。音声は常にネイティブ生成 (オフ不可)。24fps
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let CFG = { usdJpy: 155, aliases: {}, veo: { defaultModel: "veo-3.1-generate-preview", durations: [4, 6, 8], aspectRatios: ["16:9", "9:16"], personGenerationImageToVideo: "allow_adult", maxReferenceImages: 3, fps: 24, pixels: {}, models: {} } };
try {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "drama-video-pricing.json"), "utf8"));
  CFG = { ...CFG, ...j, veo: { ...CFG.veo, ...(j.veo || {}) } };
} catch (e) {
  console.warn("[veoGen] drama-video-pricing.json 読み込み失敗:", e.message);
}

const API_KEY = (process.env.GEMINI_API_KEY || "").trim(); // 画像生成・審査と同じキー (Secret Manager → env)
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// 画像オブジェクトの形 (上のコメント参照)。順に試す
const IMAGE_SHAPES = {
  bytes: (img) => ({ bytesBase64Encoded: img.data, mimeType: img.mimeType || "image/png" }),
  inline: (img) => ({ inlineData: { mimeType: img.mimeType || "image/png", data: img.data } }),
  imageBytes: (img) => ({ imageBytes: img.data, mimeType: img.mimeType || "image/png" }),
};
let preferredShape = (process.env.VEO_IMAGE_SHAPE || "bytes").trim();
if (!IMAGE_SHAPES[preferredShape]) preferredShape = "bytes";
const shapeOrder = () => [preferredShape, ...Object.keys(IMAGE_SHAPES).filter((k) => k !== preferredShape)];
// 画像の形が原因のエラーか (それ以外のエラーで投げ直してはいけない)
const isImageShapeError = (msg) => /INVALID_ARGUMENT/.test(msg) && /(inlineData|bytesBase64Encoded|imageBytes|Unknown name "image"|image)/i.test(msg);

export const VEO_FPS = Number(CFG.veo.fps) || 24;
export const VEO_DEFAULT_MODEL = CFG.veo.defaultModel;

export function veoConfigured() {
  return !!API_KEY;
}

export function isVeoModel(model) {
  return /^veo-/.test(String(model || ""));
}

// "veo" / "veo-fast" / "veo-lite" → 正式 ID。既に veo- で始まるものはそのまま
export function resolveVeoModel(name) {
  const s = String(name || "").trim();
  if (!s) return VEO_DEFAULT_MODEL;
  return CFG.aliases?.[s.toLowerCase()] || s;
}

export function veoModelInfo(model) {
  return CFG.veo.models?.[model] || null;
}

export function veoDims(aspectRatio, resolution) {
  const r = CFG.veo.pixels?.[resolution]?.[aspectRatio];
  return Array.isArray(r) ? { width: r[0], height: r[1] } : null;
}

// Seedance 向けの指定 (比率 6 種・480p・4〜15 秒) を Veo の対応値に寄せる。寄せた内容は adjustments で返す
export function normalizeVeoRequest({ aspectRatio = "9:16", resolution = "720p", durationSec = 8, model = VEO_DEFAULT_MODEL, hasReferenceImages = false, firstImagePortrait = null } = {}) {
  const adjustments = [];
  const info = veoModelInfo(model);

  // 比率: 16:9 / 9:16 のみ。縦長系は 9:16、横長系は 16:9。adaptive は開始画像の向きで決める
  let ratio = String(aspectRatio || "9:16");
  if (!CFG.veo.aspectRatios.includes(ratio)) {
    const portrait = ratio === "3:4" || (ratio === "adaptive" && firstImagePortrait === true);
    const to = portrait ? "9:16" : "16:9";
    adjustments.push(`aspectRatio ${ratio} は Veo 非対応 → ${to}`);
    ratio = to;
  }

  // 解像度: 480p は無い → 720p。Lite は 4k なし → 1080p
  let res = String(resolution || "720p").toLowerCase();
  const allowed = info?.resolutions || ["720p", "1080p", "4k"];
  if (!allowed.includes(res)) {
    const to = res === "480p" ? "720p" : (allowed.includes("1080p") ? "1080p" : "720p");
    adjustments.push(`resolution ${res} は ${info?.label || model} 非対応 → ${to}`);
    res = to;
  }

  // 尺: 4 / 6 / 8 に丸める (最近傍、同距離は長い方)
  const want = Number(durationSec) || 8;
  let dur = CFG.veo.durations.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) || (Math.abs(d - want) === Math.abs(best - want) && d > best) ? d : best), CFG.veo.durations[0]);
  if (dur !== want) adjustments.push(`durationSec ${want} は Veo 非対応 → ${dur} 秒 (4 / 6 / 8 のみ)`);
  // 参照画像あり・1080p・4k は 8 秒固定 (ドキュメント: Must be "8" when using reference images or with 1080p and 4k)
  if (dur !== 8 && (hasReferenceImages || res === "1080p" || res === "4k")) {
    adjustments.push(`${hasReferenceImages ? "参照画像あり" : res} のとき Veo は 8 秒固定 → ${dur} 秒を 8 秒に`);
    dur = 8;
  }
  return { aspectRatio: ratio, resolution: res, durationSec: dur, adjustments };
}

// 秒単価 × 秒 → USD / 円
export function veoCost(model, resolution, durationSec) {
  const info = veoModelInfo(model);
  const per = info?.usdPerSec?.[resolution];
  if (typeof per !== "number" || !durationSec) return { usd: null, yen: null, usdPerSec: per ?? null, usdJpy: CFG.usdJpy };
  const usd = per * durationSec;
  return { usd: Math.round(usd * 10000) / 10000, yen: Math.round(usd * CFG.usdJpy), usdPerSec: per, usdJpy: CFG.usdJpy };
}

async function veoFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "x-goog-api-key": API_KEY, ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const code = body?.error?.status || body?.error?.code;
    throw new Error(`Veo API: ${msg}${code ? ` [${code}]` : ""}`);
  }
  return body;
}

// 生成を投げる。戻り: { operationName, model, request }
// startImage / referenceImages は { data: base64, mimeType } (Veo は inlineData で受ける。URL は受けない)
export async function createVeoTask({
  prompt,
  startImage = null,
  referenceImages = [],
  aspectRatio = "9:16",
  resolution = "720p",
  durationSec = 8,
  model = VEO_DEFAULT_MODEL,
  personGeneration,
  negativePrompt,
  seed,
} = {}) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY が未設定です");
  if (!prompt) throw new Error("プロンプトが未設定です");
  model = resolveVeoModel(model);
  const info = veoModelInfo(model);
  if (!CFG.veo.aspectRatios.includes(aspectRatio)) throw new Error(`Veo の aspectRatio は ${CFG.veo.aspectRatios.join(" / ")} (指定: ${aspectRatio})`);
  if (!CFG.veo.durations.includes(Number(durationSec))) throw new Error(`Veo の durationSec は ${CFG.veo.durations.join(" / ")} (指定: ${durationSec})`);
  if (info?.resolutions && !info.resolutions.includes(resolution)) throw new Error(`${info.label || model} の resolution は ${info.resolutions.join(" / ")} (指定: ${resolution})`);

  const refs = (referenceImages || []).filter((r) => r?.data).slice(0, CFG.veo.maxReferenceImages);
  const buildInstance = (shape) => {
    const mk = IMAGE_SHAPES[shape];
    const instance = { prompt: String(prompt) };
    if (startImage?.data) instance.image = mk(startImage);
    if (refs.length) instance.referenceImages = refs.map((r) => ({ image: mk(r), referenceType: "asset" }));
    return instance;
  };
  const hasImages = !!startImage?.data || refs.length > 0;
  // numberOfVideos は SDK の config にはあるが REST では「isn't supported by this model」になる (本番実測) ので送らない
  const parameters = {
    aspectRatio,
    durationSeconds: Number(durationSec),
    resolution,
  };
  // image-to-video / 参照画像ありは allow_adult のみ (text-to-video は allow_all のみ)
  parameters.personGeneration = personGeneration || (hasImages ? CFG.veo.personGenerationImageToVideo : "allow_all");
  if (negativePrompt) parameters.negativePrompt = String(negativePrompt);
  if (Number.isInteger(seed)) parameters.seed = seed;

  // 画像が無ければ形は関係ない。あれば通る形を順に試す。
  // さらに「`X` isn't supported by this model」はそのパラメータを落として投げ直す (ドキュメントと実 API の差分吸収。
  // 落としたものは droppedParams で返すので黙って消えない)
  const shapes = hasImages ? shapeOrder() : [preferredShape];
  const dropped = [];
  let r, usedShape = shapes[0], lastErr;
  outer: for (const shape of shapes) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const body = JSON.stringify({ instances: [buildInstance(shape)], parameters });
      try {
        r = await veoFetch(`${BASE_URL}/models/${encodeURIComponent(model)}:predictLongRunning`, { method: "POST", body });
        usedShape = shape;
        break outer;
      } catch (e) {
        lastErr = e;
        const unsupported = e.message.match(/`(\w+)` isn't supported/);
        if (unsupported && Object.prototype.hasOwnProperty.call(parameters, unsupported[1])) {
          console.warn(`[veoGen] parameter "${unsupported[1]}" not supported → dropping and retrying`);
          dropped.push(unsupported[1]);
          delete parameters[unsupported[1]];
          continue;
        }
        if (hasImages && isImageShapeError(e.message) && shape !== shapes[shapes.length - 1]) {
          console.warn(`[veoGen] image shape "${shape}" rejected (${e.message.slice(0, 90)}) → trying next`);
          continue outer;
        }
        throw e;
      }
    }
  }
  if (!r) throw lastErr || new Error("Veo API: 失敗");
  if (hasImages && usedShape !== preferredShape) { console.log(`[veoGen] image shape "${usedShape}" accepted; using it from now on`); preferredShape = usedShape; }
  if (!r.name) throw new Error("Veo API: operation name が返りませんでした");
  return {
    operationName: r.name, model, imageShape: hasImages ? usedShape : null, droppedParams: dropped,
    request: { aspectRatio, resolution, durationSec: Number(durationSec), personGeneration: parameters.personGeneration || null, startImage: !!startImage?.data, referenceImages: refs.length },
  };
}

// オペレーションの状態。戻り: { status: "running"|"succeeded"|"failed", videoUri, error }
export async function getVeoOperation(operationName) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY が未設定です");
  const r = await veoFetch(`${BASE_URL}/${operationName}`);
  if (!r.done) return { status: "running", videoUri: null, error: null };
  if (r.error) {
    return { status: "failed", videoUri: null, error: `${r.error.message || "生成に失敗しました"}${r.error.status ? ` [${r.error.status}]` : ""}` };
  }
  const gv = r.response?.generateVideoResponse || {};
  const uri = gv.generatedSamples?.[0]?.video?.uri || null;
  if (!uri) {
    const filtered = gv.raiMediaFilteredCount ? ` (安全フィルタで ${gv.raiMediaFilteredCount} 本除外: ${(gv.raiMediaFilteredReasons || []).join(" / ").slice(0, 200)})` : "";
    return { status: "failed", videoUri: null, error: "Veo から動画が返りませんでした" + filtered };
  }
  return { status: "succeeded", videoUri: uri, error: null };
}

// 生成動画のダウンロード (API キーのヘッダが要る。files の URI はリダイレクトする)
export async function downloadVeoVideo(videoUri) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY が未設定です");
  const r = await fetch(videoUri, { headers: { "x-goog-api-key": API_KEY }, redirect: "follow" });
  if (!r.ok) throw new Error(`Veo 動画のダウンロード失敗: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
