// X API v2 の薄いクライアント。自分のアカウントだけ触るので OAuth 1.0a (ユーザーコンテキスト) の
// 4 点セット (consumer key/secret + access token/secret) で署名する。依存を増やさず node:crypto で実装。
//
// 料金 (2026 時点・従量課金): 投稿 $0.015/本、リンク入り投稿 $0.20/本、読み取り $0.005/件。
// 読み取りは件数課金なので、取り込み系は必要なときだけ叩く。

import crypto from "node:crypto";

const API = "https://api.x.com/2";

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url, creds) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.consumer_key,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.access_token,
    oauth_version: "1.0",
  };
  // JSON ボディは署名対象外。クエリと oauth_* だけ
  const params = [...u.searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params)].join("&");
  const key = `${enc(creds.consumer_secret)}&${enc(creds.access_token_secret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

async function call(creds, method, path, { query, body } = {}) {
  if (!creds?.consumer_key || !creds?.access_token) throw new Error("X の API キーが未設定です (sns-config)");
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: {
      Authorization: authHeader(method, u.toString(), creds),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = json?.detail || json?.title || json?.errors?.[0]?.message || text.slice(0, 300);
    throw new Error(`X API ${res.status}: ${detail}`);
  }
  return json;
}

export const hasLink = (text) => /https?:\/\/\S+/i.test(text || "");

export async function xPost(creds, { text, replyTo }) {
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
  const r = await call(creds, "POST", "/tweets", { body });
  return r.data; // { id, text }
}

export async function xDelete(creds, id) {
  const r = await call(creds, "DELETE", `/tweets/${encodeURIComponent(id)}`);
  return r?.data?.deleted === true;
}

export async function xMe(creds) {
  const r = await call(creds, "GET", "/users/me", { query: { "user.fields": "public_metrics,username" } });
  return r.data; // { id, username, public_metrics: { followers_count, following_count, tweet_count } }
}

const TWEET_FIELDS = "created_at,public_metrics";

// 自分の最近の投稿 (手動投稿も含めて取り込む用)。max は 5〜100
export async function xUserTweets(creds, userId, max = 20) {
  const r = await call(creds, "GET", `/users/${userId}/tweets`, {
    query: { max_results: Math.min(100, Math.max(5, max)), "tweet.fields": TWEET_FIELDS, exclude: "retweets" },
  });
  return r?.data || [];
}

// ID 指定でまとめて数字を取る (最大 100 件)
export async function xTweetsByIds(creds, ids) {
  if (!ids.length) return [];
  const r = await call(creds, "GET", "/tweets", { query: { ids: ids.slice(0, 100).join(","), "tweet.fields": TWEET_FIELDS } });
  return r?.data || [];
}
