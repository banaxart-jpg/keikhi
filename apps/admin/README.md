# admin — 管理ダッシュボード

`apps/*` 全体の状態とコストを Firebase Hosting 経由でモバイルから見るアプリ。

## 構成

```
スマホ
  ↓ https://<project>.web.app
Firebase Hosting (公開, 無料枠内)
  ├─ /        → 静的HTML (Google ログイン UI)
  └─ /api/**  → Cloud Run rewrite
       ↓ Hosting SA で invoker
     Cloud Run keikhi-admin
       ↓ Firebase ID Token 検証
     ↑ GCP API (Cloud Run / SQL / Storage / Build viewer)
```

## 機能

- 🚀 Cloud Run サービス一覧（状態 + URL + 最終デプロイ）
- 🐘 Cloud SQL インスタンス状態
- 📦 Cloud Storage バケット一覧
- 🔨 直近のビルド10件
- 💳 GCP 課金レポート / 予算ページへのディープリンク
- ✨ AI Studio / Vertex AI へのリンク
- 🔐 Google アカウントでログイン (Firebase Auth)

## 🔧 初回 Firebase セットアップ (一度きり)

bootstrap.sh が API は enable してくれるが、Firebase プロジェクトの紐付けは Console での手動操作が必要。

### 1. このGCPプロジェクトを Firebase に紐付け

👉 <https://console.firebase.google.com>

1. 「プロジェクトを追加」
2. **既存の GCP プロジェクト** で `static-epigram-496002-v8` を選ぶ
3. プランは「Spark (無料)」でOK
4. Analytics は不要なら無効化

### 2. Google サインインプロバイダを有効化

👉 <https://console.firebase.google.com/project/static-epigram-496002-v8/authentication/providers>

1. 「Get started」
2. 「Google」を選ぶ → 「Enable」
3. サポートメールに自分のGmailを設定
4. 「Save」

### 3. Hosting を有効化（site作成）

👉 <https://console.firebase.google.com/project/static-epigram-496002-v8/hosting/sites>

1. 「Get started」を押す
2. CLIインストール画面は飛ばしてOK（Cloud Build 側でやる）
3. デフォルトの `<project>.web.app` ドメインで作成される

### 4. Web アプリを登録（Firebase Auth の SDK 設定取得用）

👉 <https://console.firebase.google.com/project/static-epigram-496002-v8/overview>

1. 「ウェブアプリを追加」（`</>` アイコン）
2. ニックネーム: `admin`、Firebase Hosting も有効化
3. SDK 設定は自動取得されるのでメモ不要（`__/firebase/init.json` が自動配信される）

### 5. (Optional) ログイン許可メールを設定

サンドボックスなら制限不要だが、特定のメールしかログイン拒否したい場合は Cloud Build 引数で：

```bash
gcloud builds submit \
  --config=apps/admin/cloudbuild.yaml \
  --region=asia-northeast1 \
  --substitutions=_ALLOWED_EMAILS=you@gmail.com,colleague@gmail.com .
```

## デプロイ

`apps/admin/**` に変更があると Cloud Build トリガで自動デプロイ。手動で：

```bash
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 .
```

ビルドステップ：

1. Docker build → Artifact Registry push
2. Cloud Run へ `keikhi-admin` をデプロイ（`--no-allow-unauthenticated`）
3. Firebase Hosting に `server/public/` をデプロイ

完了後のURL：
- Hosting: `https://static-epigram-496002-v8.web.app/`
- Cloud Run: `https://keikhi-admin-xxx.a.run.app/` (Firebase経由のみ叩ける)

## API

| Method | Path                | 認証 | 説明                                 |
|--------|---------------------|------|------------------------------------|
| GET    | `/`                 | ❌   | ダッシュボード HTML                   |
| GET    | `/health`           | ❌   | 死活確認 + project/region              |
| GET    | `/api/config`       | ❌   | プロジェクト情報 (フォールバック用)      |
| GET    | `/api/me`           | ✅   | ログインユーザー情報                   |
| GET    | `/api/services`     | ✅   | Cloud Run サービス一覧                |
| GET    | `/api/sql`          | ✅   | Cloud SQL インスタンス一覧             |
| GET    | `/api/buckets`      | ✅   | Cloud Storage バケット一覧             |
| GET    | `/api/builds`       | ✅   | 直近のビルド                          |
| GET    | `/api/links`        | ✅   | GCPコンソールへのディープリンク         |

認証は **Firebase ID Token (Authorization: Bearer)** を見る。

## 必要な IAM (bootstrap が自動付与)

`admin-run@<project>` に：
- `roles/run.viewer` / `cloudsql.viewer` / `storage.objectViewer` / `cloudbuild.builds.viewer`
- `roles/logging.logWriter`

Hosting SA `service-<num>@gcp-sa-firebasehosting.iam.gserviceaccount.com` に：
- `roles/run.invoker` (keikhi-admin サービス限定)

## トラブルシュート

### `403 PERMISSION_DENIED` on /api/*
- Firebase ID Token を送ってない、または `ALLOWED_EMAILS` で弾かれてる
- ブラウザのコンソールでエラーを確認

### Hosting にアクセスしても404
- `firebase deploy --only hosting` が失敗してる
- Cloud Build ログを `apps/admin/cloudbuild.yaml` の deploy-hosting ステップで確認

### `Hosting SA がまだ作られてない` エラー
- 初回 Firebase Hosting 利用時に自動作成される。bootstrap.sh を再実行すれば invoker 権限が付く。

### ログイン後ループする
- Authorized domains に `<project>.web.app` が入ってない可能性。
  👉 <https://console.firebase.google.com/project/static-epigram-496002-v8/authentication/settings>
