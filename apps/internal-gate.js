// 社内 (info / konishi0221 / banaxart) 限定ミニアプリ用のクライアントサイド gate.
// 直リンクで /keihi/ などにアクセスされても、Firebase Auth state が確定したら
// 外部メールはランチャー (/) に弾き返す。
// API レイヤは既に ALLOWED_EMAILS で 403 を返すが、UI は素通りで「見える」ので
// 念のためフロント側でも非表示にする。
//
// 使い方: 各 ミニアプリの <script type="module"> の冒頭で
//   import { gateInternal } from "/internal-gate.js";
//   gateInternal(fbAuth);  // Firebase auth インスタンス渡す
// ... ではダメで、firebase-auth.js から onAuthStateChanged を import 済みの場所で
// インラインで使う方が確実。下の export はその helper。
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

export const INTERNAL_EMAILS = new Set([
  "info@banax.tokyo",
  "konishi0221@gmail.com",
  "banaxart@gmail.com",
]);

export function isInternalEmail(email) {
  return INTERNAL_EMAILS.has(String(email || "").toLowerCase());
}

// auth インスタンスに「外部メールならルート (/) にリダイレクト」フックを差す。
// 既存の onAuthStateChanged より先に呼ぶこと。
export function gateInternal(auth) {
  return onAuthStateChanged(auth, (user) => {
    if (user && !isInternalEmail(user.email)) {
      location.replace("/");
    }
  });
}
