#!/usr/bin/env node
// ローカル開発サーバ:
//  - apps/ を静的配信 (localhost:8080)
//  - /api/* と /config.js は本番 (Firebase Hosting) にプロキシ
//  - HTML はキャッシュ無効化 (毎回 fetch)
//
// 使い方:  node infra/dev-serve.js
//         → ブラウザで http://localhost:8080/seikyu/ 等を開く

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "apps");
const PORT = process.env.PORT || 8080;
const PROD = process.env.PROD_ORIGIN || "https://keihi-496002.web.app";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
  ".map":  "application/json",
};

async function proxyToProd(req, res) {
  const url = new URL(req.url, PROD);
  const upstream = PROD + url.pathname + url.search;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["accept-encoding"]; // 圧縮解除して簡単に
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fetch(upstream, {
      method: req.method,
      headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : body,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(buf);
    console.log(`  ↳ proxy ${r.status} ${req.method} ${req.url}`);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("proxy error: " + e.message);
    console.warn(`  ↳ proxy ERR ${req.url}: ${e.message}`);
  }
}

async function serveStatic(req, res) {
  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url.endsWith("/")) url += "index.html";
  const filePath = path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      // /seikyu/ 等: index.html を返す
      const idx = path.join(filePath, "index.html");
      const data = await readFile(idx);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate",
      });
      return res.end(data);
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": type,
      "cache-control": ext === ".html" ? "no-cache, no-store, must-revalidate" : "no-cache",
    });
    return res.end(data);
  } catch (e) {
    // ローカルに無ければ本番にプロキシ (config.js / static assets が本番だけにある場合)
    return proxyToProd(req, res);
  }
}

http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  // /config.js だけ本番プロキシ (Cloud Run URL / APP_VERSION を含む、build 時に生成される)
  // /__/ (Firebase Hosting internal auth) も本番プロキシ
  // /api/* はブラウザから直接 Cloud Run に (CORS 開いてる) → プロキシしない
  if (req.url === "/config.js" || req.url.startsWith("/__/")) {
    return proxyToProd(req, res);
  }
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`[dev-serve] ready → http://localhost:${PORT}/`);
  console.log(`[dev-serve] proxying /config.js, /__/* → ${PROD}`);
  console.log(`[dev-serve] /api/* はブラウザから直接 Cloud Run へ (CORS wildcard)`);
  console.log(`[dev-serve] apps/**/*.html を編集 → F5 で即反映\n`);
});
