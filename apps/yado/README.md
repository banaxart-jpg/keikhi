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

Beds24 API トークンは `BEDS24_API_TOKEN` env var（Secret Manager 経由）で渡す。
未設定の場合はサンプル予約を返してフロントは「未設定です」の警告を表示する。

### Beds24 トークンの登録手順（小西担当）
```bash
# Secret Manager に登録
echo -n "<TOKEN>" | gcloud secrets create beds24-api-token --replication-policy=automatic --data-file=-

# apps/keihi/cloudbuild.yaml の --set-secrets 行に追記:
#   BEDS24_API_TOKEN=beds24-api-token:latest
# → main に push して再デプロイで反映
```

## 残課題 / 今後やりたいこと
- [ ] Beds24 API トークンを Secret Manager に登録
- [ ] 部屋ごとの稼働率
- [ ] 周辺民泊の価格比較（外部スクレイピング or 手動入力）
- [ ] 価格戦略のシミュレーション（この値段にしたら何泊埋まるか）
