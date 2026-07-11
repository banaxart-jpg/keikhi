# 設計質問（/sekkei-qa/）

図面や写真に印（ピン）を打って設計事務所に質問し、回答を管理するアプリ。
「ここの寸法を知りたい」を図面上のピン＋メモで投げ、設計屋さんが回答を書いて状態を進める。

## 使い方
- ランチャーから [設計質問] をタップ
- 右上「＋質問」→ **図面/写真/PDF を読み込む**（カメラ・写真・ファイル）。PDF は1ページ目を使用
- 「印を打つ」ON にして、画像の気になる場所を**タップ → ピン**。ピンに質問を書く（例：ここの寸法は？ / これでいい？）
- 「質問内容」に全体のメモを書く → **登録**。一覧タイトルは内容から **AI が自動生成**
- 一覧はステータス別タブ（**検討中 / 確認中 / 回答済み**）で絞り込み
- 設計屋さんは質問を開いて、ピンをタップ → **OK / NO のワンタップ**か、**自由入力の回答**（例：W1650）を記入
  - ピンの色: 未回答=青 / OK・回答あり=緑 / NO=赤

## 未読・確認済み（LINE の未読風）
- 設計屋さんが回答すると、その質問に **未読マーク**（赤ドット＋枠）が付く。一覧上部に「未読の回答 N 件」
- 質問を開くと上に「回答が届いています → **確認済みにする**」バナー。押すと未読マークが消える
- 「確認済み」はサーバーに記録するので **チームの誰が確認しても全員のマークが消える**（`ackSig` で判定）
- 新しい回答や回答の変更があると、また未読に戻る

## みんなで共有
- 経費・タスクと同じ **keihi-api (Cloud SQL)** に保存。ログインしていれば端末・人をまたいで共有
- 設計屋さんもログインすればそのまま回答できる（社外の人でもログイン可）。
  ログインしない相手なら、もらった回答をこちらでピンに転記する運用でもOK

## データ / API
- テーブル `sekkei_questions`（`pins` は `[{x,y,note,answer,verdict}]` の JSONB、x/y は画像内 0〜1 の相対座標、verdict は "OK"/"NO"/""）
- `ack_sig` 列 = 最後に「確認済み」にした時点の回答署名。現在の回答署名と食い違えば未読
- `GET/POST/PUT/DELETE /api/sekkei`、`GET /api/sekkei/:id/image`（画像は base64 で別取得）
- 確認済み: `PUT /api/sekkei/:id { ackSig }`
- `POST /api/sekkei/title`（Gemini で質問内容 → 短い見出し）
- 画像は縮小して DB に base64 保存（追加インフラ不要）。高解像度が要るなら将来 Storage 化

## 🏠 ランチャーのアイコンにも未読バッジを出す（小西用・任意）
アプリ内の未読マークはこのアプリだけで完結する。ランチャー（`apps/index.html`）の
**アプリアイコン上の赤バッジ**も出すなら、`fetchTechstudyBadge` と同じ場所に下記を足す
（ランチャー本体ロジックは小西管轄なので名取側では触っていない）:

```js
// apps/index.html の fetchTechstudyBadge に倣って追加
async function fetchSekkeiBadge() {
  try {
    const qs = await api("GET", "/api/sekkei");            // ランチャーの api() ラッパー
    const answered = (p) => p.verdict === "OK" || p.verdict === "NO" || (p.answer || "").trim() !== "";
    const sig = (pins) => (pins || []).filter(answered).map((p) => `${p.verdict||""}:${(p.answer||"").trim()}`).join("~");
    const unread = qs.filter((q) => { const s = sig(q.pins); return s !== "" && s !== (q.ackSig || ""); }).length;
    if (unread > 0) appBadges["sekkei-qa"] = String(unread);
    renderApps?.();
  } catch (_) {}
}
// onAuthStateChanged で fetchTechstudyBadge(user) を呼んでいる箇所の隣で fetchSekkeiBadge() も呼ぶ
```

## ファイル構成
- `index.html` — UI + マークアップ + ロジック（1ファイル完結）
- サーバー側は `apps/keihi/server/index.js` の `/api/sekkei*`

## 残課題 / 今後やりたいこと
- [ ] 自由描画（線・矢印・囲み）でのマークアップ
- [ ] 複数ページ PDF の全ページ対応
- [ ] 画像を後から差し替え / 追加
- [ ] 回答が付いたら質問者に通知（PWA + FCM）
- [ ] 画像の高解像度保存（Cloud Storage）
