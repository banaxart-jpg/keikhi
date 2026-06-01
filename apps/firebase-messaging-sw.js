// Firebase Cloud Messaging Service Worker
// バックグラウンド (タブが閉じてる/裏にいる時) で push を受け取って OS 通知に変換。
//
// ※ Service Worker は /apps/firebase-messaging-sw.js の場所に置くこと
//    (= ホスティングのルート /firebase-messaging-sw.js になる)。
//    FCM SDK は固定でこのパスを探す。
//
// firebase config は /__/firebase/init.json を直接 fetch しても良いが、SW は
// 何度も呼ばれて重いので、ハードコード版を別途 importScripts する形にする。

importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

// Firebase Hosting のリザーブド URL から init を取って初期化
// (Service Worker 内では /__/firebase/init.json は同一オリジンなので使える)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

fetch("/__/firebase/init.json")
  .then((r) => r.json())
  .then((cfg) => {
    firebase.initializeApp(cfg);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage((payload) => {
      const { title, body, icon, click_action } = payload.notification || {};
      const data = payload.data || {};
      self.registration.showNotification(title || "通知", {
        body: body || "",
        icon: icon || "/icon.png",
        badge: "/icon.png",
        data: { url: click_action || data.url || "/" },
      });
    });
  })
  .catch((e) => console.warn("[fcm-sw] init failed:", e));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // 既に同じ URL を開いてるタブがあればフォーカス、なければ新規 open
      for (const c of clients) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
