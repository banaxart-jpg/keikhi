// 共通: Firebase Auth 初期化 + api() fetch ラッパー。
//
// 経費2 / 請求書 で 100% 同じだったブロックをこっちに集約。各アプリは
//
//   import { initAuthBoot, api, idToken, getFbAuth } from "/api-auth.js";
//   initAuthBoot({ returnPath: "/keihi2/", onReady: boot });
//
// で済む。signinOverlay の HTML 自体は各アプリに残す (アプリ名の文字が違うため)。
// このモジュールは #signinOverlay の show/hide と #signinErr へのエラー文字列だけ面倒見る。

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  onAuthStateChanged, signOut as fbSignOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { gateInternal } from "/internal-gate.js";

const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
let fbAuth = null;

export function getFbAuth() { return fbAuth; }

export async function idToken() {
  const u = fbAuth?.currentUser;
  return u ? await u.getIdToken() : null;
}

function showOverlay() {
  const el = document.getElementById("signinOverlay");
  if (el) el.style.display = "flex";
}
function hideOverlay() {
  const el = document.getElementById("signinOverlay");
  if (el) el.style.display = "none";
}

// returnPath: 未ログインで /?next=<returnPath> に飛ばすパス (例: "/keihi2/")
// onReady: 認証完了時に1回だけ呼ぶコールバック (= boot())
export async function initAuthBoot({ returnPath, onReady }) {
  if (window.DEV_NO_AUTH) {
    hideOverlay();
    onReady();
    return;
  }
  try {
    const cfg = await fetch("/__/firebase/init.json").then((r) => r.json());
    cfg.authDomain = location.hostname;
    fbAuth = getAuth(initializeApp(cfg));
    await setPersistence(fbAuth, browserLocalPersistence);
    gateInternal(fbAuth);
    let entered = false;
    onAuthStateChanged(fbAuth, async (user) => {
      if (user) {
        if (entered) return;
        entered = true;
        sessionStorage.removeItem("authBounce");
        hideOverlay();
        onReady();
        return;
      }
      if (sessionStorage.getItem("authBounce")) {
        showOverlay();
        return;
      }
      sessionStorage.setItem("authBounce", "1");
      location.replace("/?next=" + encodeURIComponent(returnPath));
    });
  } catch (e) {
    showOverlay();
    const errEl = document.getElementById("signinErr");
    if (errEl) errEl.textContent = "init失敗: " + e.message;
  }
}

// fetch ラッパー: ID Token 自動付与 + 401 で signinOverlay 表示 + エラーメッセージ抽出
export async function api(method, url, body) {
  const target = API_BASE + url;
  const opts = { method, headers: {} };
  const tok = await idToken();
  if (tok) opts.headers["Authorization"] = "Bearer " + tok;
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(target, opts);
  if (r.status === 401) {
    showOverlay();
    throw new Error("401 認証エラー");
  }
  if (!r.ok) {
    let raw = ""; try { raw = await r.text(); } catch {}
    let msg = ""; try { const j = JSON.parse(raw); if (j.error) msg = j.error; } catch {}
    throw new Error(msg || `HTTP ${r.status}`);
  }
  return r.status === 204 ? null : r.json();
}

export async function doSignOut() {
  if (fbAuth) await fbSignOut(fbAuth);
  location.reload();
}
