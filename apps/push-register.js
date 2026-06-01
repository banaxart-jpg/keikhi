// Web Push (FCM) ハンドシェイク。
// サインイン済みユーザーのこのブラウザに対する registration token を取得して
// Firestore (fcm_tokens/{uid}/devices/{token}) に保存する。
//
// 実際に push を送るのはサーバ側 (firebase-admin の messaging().send で
// このトークンを宛先にする) で別途実装。ここでは「いつでも送れるよう
// 経路を握る」までを担当。
//
// 必要なもの:
//  - apps/firebase-messaging-sw.js (Service Worker)
//  - window.FCM_VAPID_KEY (apps/config.js で cloudbuild が埋め込む)
//  - Firebase Console で Cloud Messaging を有効化 + Web Push certs 生成

import {
  getMessaging, getToken, deleteToken, isSupported,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import {
  getFirestore, doc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Service Worker を /firebase-messaging-sw.js で登録 (FCM SDK が探す固定パス)。
// 既に登録済みなら same registration を返す。
async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
  if (existing) return existing;
  return navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
}

// メイン: 認証完了 user を受け取って FCM token を Firestore に保存する。
// 失敗しても黙って null 返す (ハンドシェイク未確立は致命じゃない)。
export async function registerPushForUser(fbApp, user) {
  try {
    if (!user || !window.FCM_VAPID_KEY) return null;
    if (!(await isSupported())) return null;  // Safari < 16.4 等
    // Notification API ない / 既に denied なら何もしない (ブラウザ強制 prompt 禁止)
    if (typeof Notification === "undefined" || Notification.permission === "denied") return null;
    // default のときだけ 1度 prompt。granted なら静かに先へ。
    if (Notification.permission === "default") {
      const p = await Notification.requestPermission();
      if (p !== "granted") return null;
    }
    const sw = await ensureServiceWorker();
    if (!sw) return null;
    const messaging = getMessaging(fbApp);
    const token = await getToken(messaging, {
      vapidKey: window.FCM_VAPID_KEY,
      serviceWorkerRegistration: sw,
    });
    if (!token) return null;
    // Firestore: fcm_tokens/{uid}/devices/{tokenHash} に保存。
    // 同じトークンを上書き保存 OK (updatedAt だけ更新)。
    const db = getFirestore(fbApp);
    const tokenId = await sha1(token); // doc id 長さ抑制
    await setDoc(doc(db, "fcm_tokens", user.uid, "devices", tokenId), {
      token,
      email: (user.email || "").toLowerCase(),
      ua: navigator.userAgent.slice(0, 200),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return token;
  } catch (e) {
    console.warn("[push] registerPushForUser failed:", e?.message || e);
    return null;
  }
}

async function sha1(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
