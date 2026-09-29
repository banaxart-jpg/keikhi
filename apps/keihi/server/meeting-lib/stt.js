// Google Cloud Speech-to-Text v2 (Chirp) で 15 秒チャンクを文字起こしする。
// 認証は Cloud Run のサービスアカウント (ADC)。speech.googleapis.com の有効化が前提。
// モデル / リージョンは候補を上から試し、通った組み合わせを覚えて次から先に使う。
// 全滅したら null を返す → 呼び出し側が Gemini に戻す。

import { google } from "googleapis";

// MEETING_STT="chirp_3@us" のように env で先頭に足せる
const CANDIDATES = [
  ...(process.env.MEETING_STT ? [process.env.MEETING_STT.trim()] : []),
  "chirp_3@us", "chirp_3@asia-northeast1", "chirp_2@us-central1", "long@asia-northeast1", "long@global",
].map((s) => { const [model, location] = s.split("@"); return { model, location, key: s }; });

const BAD_MS = 10 * 60 * 1000;
const bad = new Map();     // key → 失敗した時刻 (しばらく飛ばす)
let preferred = null;      // 最後に通った key
let authClient = null;
export let lastSttError = "";

async function client() {
  if (!authClient) {
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    authClient = await auth.getClient();
  }
  return authClient;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "";
}

async function recognizeWith({ model, location }, audioB64) {
  const project = projectId();
  if (!project) throw new Error("project id が不明");
  const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  const url = `https://${host}/v2/projects/${project}/locations/${location}/recognizers/_:recognize`;
  const c = await client();
  const { data } = await c.request({
    url, method: "POST",
    data: {
      config: {
        autoDecodingConfig: {},
        languageCodes: ["ja-JP"],
        model,
        features: { enableAutomaticPunctuation: true },
      },
      content: audioB64,
    },
    timeout: 60000,
  });
  return (data.results || [])
    .map((r) => r.alternatives?.[0]?.transcript || "")
    .map((t) => t.trim()).filter(Boolean).join("\n");
}

// 成功: { text, engine: "stt:chirp_3@us" }、全滅: null
export async function sttTranscribe(audioB64) {
  if (process.env.MEETING_STT === "off") return null;
  const order = [...CANDIDATES].sort((a, b) => (b.key === preferred) - (a.key === preferred));
  for (const cand of order) {
    const t = bad.get(cand.key);
    if (t && Date.now() - t < BAD_MS) continue;
    try {
      const text = await recognizeWith(cand, audioB64);
      preferred = cand.key; bad.delete(cand.key); lastSttError = "";
      return { text, engine: `stt:${cand.key}` };
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error?.message || e.message;
      lastSttError = `${cand.key}: ${status || ""} ${msg}`.slice(0, 300);
      console.warn(`[meeting/stt] ${lastSttError}`);
      // 一時的なエラー (429 / 5xx) は候補を潰さず、そのまま次を試す
      if (!(status === 429 || status >= 500)) bad.set(cand.key, Date.now());
    }
  }
  return null;
}
