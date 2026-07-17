# 名刺（/meishi/）

名刺を撮ると AI（Gemini）が氏名・会社・連絡先を読み取って、連絡先一覧にするアプリ。

## 使い方
- ランチャーから [名刺] をタップ
- 右上「追加」→ 「名刺を撮る」or「選ぶ」→ **AI が自動で項目を埋める**
- 読み取り結果を確認・修正して **登録**（AI が間違えたらその場で直せる）
- 一覧は名前・会社で検索。タップで詳細
- 詳細から **電話 / メール / 地図** にワンタップ（`tel:` `mailto:` Google マップ）

## みんなで共有
- 経費・タスクと同じ **keihi-api (Cloud SQL)** に保存。ログインしていれば端末・人をまたいで共有
- 名刺画像もサーバーに保存（縮小 base64）。詳細で元の名刺を見返せる

## データ / API
- テーブル `meishi_cards`（name/kana/company/department/job_title/phone/mobile/email/url/postal/address/memo + image_data）
- `GET/POST/PUT/DELETE /api/meishi`、`GET /api/meishi/:id/image`
- `POST /api/meishi/scan`（名刺画像 → Gemini で構造化抽出。保存はせず結果だけ返す）
- 既存の Gemini を流用するので **追加の API キーは不要**

## ファイル構成
- `index.html` — UI + ロジック（1ファイル完結）
- サーバー側は `apps/keihi/server/index.js` の `/api/meishi*`

## 残課題 / 今後やりたいこと
- [ ] 端末の連絡先アプリに書き出し（vCard / .vcf ダウンロード）
- [ ] 会社ごとにグループ表示
- [ ] 複数名刺をまとめて一括スキャン
- [ ] QR コード（電子名刺）の読み取り
