# admin — 管理ダッシュボード

`apps/*` 全体の状態とコストをまとめて見るアプリ。

## 機能

- 🚀 Cloud Run サービス一覧（状態 + URL + 最終デプロイ）
- 🐘 Cloud SQL インスタンス状態
- 📦 Cloud Storage バケット一覧
- 🔨 直近のビルド10件
- 💳 GCP 課金レポート / 予算ページへのディープリンク
- 📊 Cloud Run / SQL / Logs などコンソールへのワンタップリンク
- ✨ AI Studio / Vertex AI へのリンク

## API

| Method | Path                | 説明                                  |
|--------|---------------------|--------------------------------------|
| GET    | `/`                 | ダッシュボード HTML                   |
| GET    | `/health`           | 死活確認 + project/region              |
| GET    | `/api/services`     | Cloud Run v2 services API ラップ      |
| GET    | `/api/sql`          | SQL Admin instances API ラップ        |
| GET    | `/api/buckets`      | Cloud Storage buckets API ラップ      |
| GET    | `/api/builds`       | Cloud Build builds API ラップ         |
| GET    | `/api/links`        | プロジェクト固有のコンソール URL 一式  |

## 必要な IAM

`admin-run@<project>.iam.gserviceaccount.com` には bootstrap が以下を付与：

- `roles/run.viewer`
- `roles/cloudsql.viewer`
- `roles/storage.objectViewer` + `roles/storage.bucketViewer`
- `roles/cloudbuild.builds.viewer`

## アクセス

組織ポリシーで `allUsers` invoker が許可されない環境向けに、デフォルトでは authenticated required。

スマホから直接開きたい場合は：

1. 自分の Google アカウントを invoker に追加
   ```bash
   gcloud run services add-iam-policy-binding keikhi-admin \
     --region=asia-northeast1 \
     --member=user:あなた@gmail.com \
     --role=roles/run.invoker
   ```
2. ブラウザで URL を開くと Google のログイン画面 → 通る

それでも組織ポリシーで弾かれる場合は IAP か Firebase Auth を前段に置く必要あり（次フェーズ）。
