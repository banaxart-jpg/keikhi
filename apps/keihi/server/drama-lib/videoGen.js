// カット動画生成: BytePlus ModelArk (Seedance 2.0) 接続。
// タスク作成 → ポーリングの非同期 API なので、こちらも「作る」「見る」を分けて export する。
// (Cloud Run のリクエストタイムアウト内で生成完了を待たない設計)
//
// 必要な env (Cloud Run に設定済み):
//   SEEDANCE_API_KEY   … ModelArk の API キー
//   SEEDANCE_BASE_URL  … 例: https://ark.ap-southeast.bytepluses.com/api/v3
//
// モデル ID は小西指示でハードコード (新モデルが出たらここを書き換えて push):
export const SEEDANCE_MODEL = "dreamina-seedance-2-0-fast-260128";

const API_KEY = process.env.SEEDANCE_API_KEY || process.env.SEADANCE_API_KEY || "";
const BASE_URL = (process.env.SEEDANCE_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "");

export function seedanceConfigured() {
  return !!API_KEY;
}

async function arkFetch(path, opts = {}) {
  const res = await fetch(BASE_URL + path, {
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
    throw new Error(`Seedance API: ${msg}`);
  }
  return body;
}

// 生成タスクを投げる。参照画像 (キャラの referenceImages / キービジュアル) で一貫性を担保。
// 戻り: { taskId, model }
export async function createCutVideoTask({ prompt, referenceImageUrls = [], durationSec = 8, model = SEEDANCE_MODEL }) {
  if (!API_KEY) throw new Error("SEEDANCE_API_KEY が未設定です");
  if (!prompt) throw new Error("プロンプトが未設定です");
  const content = [{ type: "text", text: prompt }];
  for (const url of referenceImageUrls.slice(0, 4)) {
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  const body = {
    model,
    content,
    ratio: "9:16",                                        // 縦型ショート固定
    duration: Math.max(4, Math.min(15, Math.round(durationSec))), // API の許容 4-15 秒
    resolution: "720p",
    watermark: false,
    generate_audio: false,                                // 音声はナレーション別録りのため生成しない
  };
  const r = await arkFetch("/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) });
  if (!r.id) throw new Error("Seedance API: task id が返りませんでした");
  return { taskId: r.id, model };
}

// タスク状況を見る。戻り: { status: "queued"|"running"|"succeeded"|"failed", videoUrl, error }
export async function getVideoTask(taskId) {
  if (!API_KEY) throw new Error("SEEDANCE_API_KEY が未設定です");
  const r = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(taskId)}`);
  const status = r.status || "unknown";
  return {
    status,
    videoUrl: r.content?.video_url || null,
    error: r.error?.message || (status === "failed" ? "生成に失敗しました" : null),
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
