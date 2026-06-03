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

## サーバー連携 / データフロー

```
Beds24 v2 ────(初回バックフィル / 日次差分)────▶ Cloud SQL `yado_bookings`
                                                            │
                  ┌─────────────────────────────────────────┘
                  ▼
           /api/yado/bookings (SQL から)       /api/yado/strategy (集計 + AI)
                  │                                 │
                  ▼                                 ▼
              フロント (カレンダー / サマリー / 戦略タブ)
```

Beds24 を毎回叩かず DB キャッシュ経由にすることで:
- レート制限を気にせずフロント連打 OK
- 過去全期間のクエリが SQL でラク (YoY 比較・月次推移を AI prompt に投入できる)
- レスポンス速い

### エンドポイント
- `GET /api/yado/bookings?from=&to=` — SQL から予約取得。空なら `{ needsBackfill: true }` を返す
- `POST /api/yado/backfill` (Firebase auth) — 指定範囲を Beds24 から全件取得→ DB upsert
- `POST /api/internal/yado/sync-bookings` (`x-tick-secret` ヘッダ) — 差分同期。Cloud Scheduler 日次起動
- `POST /api/yado/strategy` — Gemini に予約集計 + 施設情報 + 過去 12 ヶ月推移を渡して戦略生成
- `POST /api/yado/sync` — 取引シートへの同期

### env var (Cloud Run の env で管理)
- `MANCHIKAN_BEDS_KEY` — Beds24 v2 API token
- `MANCHIKAN_PROP_ID` — 物件 ID (満竹華庵 = 223365)
- `INTERNAL_TICK_SECRET` — Cloud Scheduler ↔ /api/internal/* の共有秘密 (kaigi と共用)

### 初回セットアップ（小西担当）
1. Cloud Run console で `MANCHIKAN_BEDS_KEY` を環境変数に登録 (`MANCHIKAN_PROP_ID=223365` は cloudbuild で固定済)
2. /yado/ を開くと「バックフィル実行」ボタンが出る → 1 回押すと過去 5 年〜未来 5 年を Beds24 から取得して DB に保存
3. Cloud Scheduler に日次同期ジョブを作成 (差分取り込み、深夜 03:00 JST):

```bash
SECRET=$(gcloud secrets versions access latest --secret=kaigi-tick-secret)
RUN_URL=$(gcloud run services describe keihi-api --region=asia-northeast1 --format='value(status.url)')

gcloud scheduler jobs create http yado-sync-daily \
  --location=asia-northeast1 \
  --schedule="0 3 * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="${RUN_URL}/api/internal/yado/sync-bookings" \
  --http-method=POST \
  --headers="x-tick-secret=${SECRET},content-type=application/json" \
  --message-body='{}'
```

cloudbuild.yaml は `--update-env-vars` 運用なので、deploy しても Console で設定した値は消えない。

### DB スキーマ (`yado_bookings`)
`apps/keihi/infra/schema.sql` 参照。サーバ起動時の `ensureSchema()` で冪等に CREATE される。
`modified_time` を upsert キーに使うので、Beds24 側でキャンセル/料金変更があっても次回同期で追従。

## 残課題 / 今後やりたいこと
- [ ] 部屋ごとの稼働率 (今は roomQty=1 前提)
- [ ] 周辺民泊の価格比較（外部スクレイピング or 手動入力）
- [ ] 価格戦略のシミュレーション（この値段にしたら何泊埋まるか）
- [ ] レビュー: 各 OTA の自動取得は API 制限で難しい → スクショ共有 → AI に解釈してもらう運用で当面継続
