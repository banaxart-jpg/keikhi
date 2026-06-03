# 宿（/yado/）

満竹華庵の予約ダッシュボード。Beds24 から予約データを読んできて、カレンダー / 売上 / 稼働率 / 戦略提案を出す。

## 使い方
- ランチャーから [🏯 宿] をタップ
- カレンダータブで月のスケジュールを色分け表示
  - 🔴 Airbnb
  - 🔵 Booking.com
  - 🟢 自社サイト
  - ⚪ その他（電話・直接など）
- サマリータブで当月の売上・稼働率を確認
- 戦略タブで「どうやって宿泊数増やすか」のAI提案を生成

## ファイル構成
- `index.html` — UI + ロジック（Vue 3、CDN）
- `icon.svg` — アイコン（cloudbuild で PNG に変換）

## サーバー連携
keihi-api に以下のエンドポイントを追加：
- `GET /api/yado/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD` — Beds24 からの予約一覧
- `POST /api/yado/strategy` — Gemini を呼んで戦略提案を生成（Google Search grounding 有）

Beds24 API への接続用 env var (Cloud Run の env で管理):
- `MANCHIKAN_BEDS_KEY` — Beds24 v2 API token
- `MANCHIKAN_PROP_ID` — 物件 ID (数値)。空なら token スコープ全件

`MANCHIKAN_BEDS_KEY` 未設定の場合はサンプル予約を返してフロントは「未設定です」の警告を表示する。

### Beds24 鍵 / 物件 ID の登録手順（小西担当）
Cloud Console の Cloud Run → keihi-api → 新しいリビジョンの編集とデプロイ →
変数とシークレット → 環境変数 で `MANCHIKAN_BEDS_KEY`, `MANCHIKAN_PROP_ID` を追加。

cloudbuild.yaml は `--update-env-vars` を使ってるので、deploy しても Console で
設定した値は消えない (一度入れたら以降の deploy で保持される)。

## 残課題 / 今後やりたいこと
- [ ] 部屋ごとの稼働率
- [ ] 周辺民泊の価格比較（外部スクレイピング or 手動入力）
- [ ] 価格戦略のシミュレーション（この値段にしたら何泊埋まるか）
