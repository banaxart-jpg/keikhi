// カット動画生成の抽象インターフェース。プロバイダ差し替え可能な形にしておき、
// Seedance の正式 API 仕様 (エンドポイント/認証/パラメータ名) が確定次第ここを実装する。
// 現時点では公式ドキュメント未確認のため、既定はモック応答 (プレースホルダー動画を返す)。
//
// generateCutVideo() の入出力契約:
//   in:  { prompt, referenceImageUrls, durationSec, model }
//   out: { status: "done"|"failed", videoUrl, model, note }

const MOCK_VIDEO_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

async function generateMock({ prompt, durationSec, model }) {
  await new Promise((r) => setTimeout(r, 500));
  return {
    status: "done",
    videoUrl: MOCK_VIDEO_URL,
    model,
    note: `mock: 実際の動画生成 API 未接続のためプレースホルダーを返しています (prompt: ${String(prompt || "").slice(0, 60)}..., ${durationSec}秒)`,
  };
}

export async function generateCutVideo({ prompt, referenceImageUrls = [], durationSec = 8, model = "seedance-2.0-fast" }) {
  if (!prompt) return { status: "failed", videoUrl: null, model, note: "プロンプトが未設定です" };
  if (model.startsWith("seedance")) {
    // TODO: Seedance 公式 API 接続。参照画像 (referenceImageUrls) でキャラ一貫性を担保する想定。
    return generateMock({ prompt, durationSec, model });
  }
  return { status: "failed", videoUrl: null, model, note: `未対応の動画生成モデルです: ${model}` };
}
