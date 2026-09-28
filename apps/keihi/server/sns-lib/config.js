// SNS MCP の設定は Secret Manager の 1 シークレット (既定名 sns-config) に JSON で置く。
// リポは public なので、トークン・API キー・ログイン情報はコードにも env にも書かない。
// Cloud Build の --set-secrets にも載せない (未作成の secret を載せると deploy が落ちるため)。
// 実行時に Secret Manager REST を直接読む。未作成なら MCP は 403 を返すだけで他アプリに影響なし。
//
// sns-config の形:
// {
//   "tokens":   { "<長いランダム文字列>": ["kenchiku"] },        // URL トークン → 触れるアカウント
//   "accounts": {
//     "kenchiku": {
//       "label": "建築CH",
//       "x":    { "handle": "kenchiku_ch", "consumer_key": "...", "consumer_secret": "...",
//                 "access_token": "...", "access_token_secret": "..." },
//       "note": { "urlname": "<note の ID (note.com/<ここ>)>" }
//     }
//   }
// }

import { google } from "googleapis";

const SECRET_NAME = (process.env.SNS_CONFIG_SECRET || "sns-config").trim();
const CACHE_MS = 5 * 60 * 1000;

let cached = null;
let cachedAt = 0;
let authClient = null;

async function getAuth() {
  if (authClient) return authClient;
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  authClient = await auth.getClient();
  return authClient;
}

async function readSecret() {
  // ローカル開発用: SNS_CONFIG_JSON があればそれを使う
  if (process.env.SNS_CONFIG_JSON) return JSON.parse(process.env.SNS_CONFIG_JSON);
  const project = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("project id が不明 (FIREBASE_PROJECT_ID 未設定)");
  const client = await getAuth();
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET_NAME}/versions/latest:access`;
  const { data } = await client.request({ url });
  return JSON.parse(Buffer.from(data.payload.data, "base64").toString("utf8"));
}

// 失敗時は null (= MCP 無効)。直近の成功値があればそれを使い続ける
export async function getSnsConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  try {
    const cfg = await readSecret();
    cached = { tokens: cfg.tokens || {}, accounts: cfg.accounts || {} };
    cachedAt = Date.now();
  } catch (e) {
    console.warn(`[sns] config (${SECRET_NAME}) を読めません:`, e.message);
    if (!cached) return null;
  }
  return cached;
}

// URL トークン → 許可アカウント一覧 (無効なら null)
export async function accountsForToken(token) {
  const cfg = await getSnsConfig();
  if (!cfg || !token) return null;
  const list = cfg.tokens[token];
  return Array.isArray(list) && list.length ? list : null;
}
