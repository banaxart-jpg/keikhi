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
- `POST /api/yado/refresh` (Firebase auth) — **ワンタップ同期**。初回は全期間バックフィル、以降は差分。
  画面上部の 🔄 ボタンから叩く想定。
- `POST /api/yado/backfill` (Firebase auth) — 指定範囲を Beds24 から全件取得 → DB upsert (明示的に範囲指定したい時)
- `POST /api/internal/yado/sync-bookings` (`x-tick-secret` ヘッダ) — 差分同期。Cloud Scheduler で自動化したい場合に使う (任意)
- `POST /api/yado/strategy` — Gemini に予約集計 + 施設情報 + 過去 12 ヶ月推移を渡して戦略生成
- `POST /api/yado/sync` — 取引シートへの同期 (Beds24 同期とは別物、命名紛らわしいが既存名維持)

### env var (Cloud Run の env で管理)
- `MANCHIKAN_BEDS_KEY` — Beds24 v2 API token
- `MANCHIKAN_PROP_ID` — 物件 ID (満竹華庵 = 223365)
- `INTERNAL_TICK_SECRET` — Cloud Scheduler ↔ /api/internal/* の共有秘密 (kaigi と共用)

### 初回セットアップ（小西担当）
1. Cloud Run console で `MANCHIKAN_BEDS_KEY` を環境変数に登録 (`MANCHIKAN_PROP_ID=223365` は cloudbuild で固定済)
2. /yado/ を開いて画面右上の **🔄 ボタンをタップ** → 初回は過去 5 年〜未来 5 年を Beds24 から取得して DB に保存 (5-30 秒)
3. 以降も同じボタンで差分同期できる。サーバ側で「last_sync_modified の有無」で全 / 差分を自動判定するので、ユーザはタップするだけで OK

cloudbuild.yaml は `--update-env-vars` 運用なので、deploy しても Console で設定した値は消えない。

### Cloud Scheduler で自動化したい場合 (任意、後回し可)
スマホからだとセットアップ面倒なので未実装デフォルト。/yado/ を毎日見る運用なら 🔄 ボタンで十分。
自動化したくなったら `/api/internal/yado/sync-bookings` (`x-tick-secret` 認証) を Cloud Scheduler の HTTP target にすれば動く。コマンド例は git ログ参照 (commit 69bdc67)。

### DB スキーマ (`yado_bookings`)
`apps/keihi/infra/schema.sql` 参照。サーバ起動時の `ensureSchema()` で冪等に CREATE される。
`modified_time` を upsert キーに使うので、Beds24 側でキャンセル/料金変更があっても次回同期で追従。

## 残課題 / 今後やりたいこと
- [ ] 部屋ごとの稼働率 (今は roomQty=1 前提)
- [ ] 周辺民泊の価格比較（外部スクレイピング or 手動入力）
- [ ] 価格戦略のシミュレーション（この値段にしたら何泊埋まるか）
- [ ] レビュー: 各 OTA の自動取得は API 制限で難しい → スクショ共有 → AI に解釈してもらう運用で当面継続
