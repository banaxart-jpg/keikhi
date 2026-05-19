# keikhi monorepo

`apps/<アプリ名>/` 配下に1アプリずつ並べていく Google Cloud サンドボックス。
`gcloud builds submit` 一発で変更を本番反映、admin ダッシュボードで Firebase Auth (Google ログイン) 経由でスマホからモニタ。

---

> ## 🚨 Claude への最重要指示：スマホ運用前提
>
> **このプロジェクトはスマホからの開発・運用がテーマ。ユーザーにターミナル / コマンドを叩かせない。**
>
> - ❌ ユーザーに `git pull` / `gcloud builds submit` / `git checkout` 等のコマンドを「実行してください」と依頼しない
> - ❌ 確認のためにコマンド結果を「貼ってください」と求めない（スマホでは手間）
> - ✅ コミット & プッシュは Claude 自身が完了させる
> - ✅ デプロイは Cloud Build トリガ（push → 自動デプロイ）で自動化し、ユーザーは結果URLを開くだけにする
> - ✅ どうしても手動操作が必要な場合は、その必要性をなくす方向（自動化）をまず検討・提案する
> - ✅ ユーザーへの最終的な動作確認依頼は「このURLを開いて試して」だけにする
>
> **🔴 デプロイに関わる作業をする前に、必ず [DEPLOY.md](DEPLOY.md) を最初から最後まで読むこと。**
> デプロイ構造・自動デプロイの仕組み・トリガ・各アプリの構成は全て DEPLOY.md に書いてある。
> 読まずにコマンドを案内したり構造を推測で語ることは禁止。
>
> 手動コマンドを案内しそうになったら立ち止まり、自動化で代替できないか先に考えること。

---

## 🌐 本番 URL

| アプリ | URL | アクセス方法 |
|--------|-----|------------|
| **admin ダッシュボード** | <https://static-epigram-496002-v8.web.app> | スマホブラウザで開く → Google ログイン (`info@banax.tokyo`) |
| keihi API (経費) | <https://keihi-api-jmzsz44nvq-an.a.run.app> | gcloud ID Token 付きで叩く（下記） |
| keikhi-admin Cloud Run (直叩き不可) | <https://keikhi-admin-734350696397.asia-northeast1.run.app> | Firebase Hosting 経由のみ |
| Firebase Console | <https://console.firebase.google.com/project/static-epigram-496002-v8> | 認証・Hosting管理 |
| GCP Console | <https://console.cloud.google.com/home/dashboard?project=static-epigram-496002-v8> | 全体管理 |
| 課金レポート | <https://console.cloud.google.com/billing/01DA00-93CCBF-AB55B7/reports?project=static-epigram-496002-v8> | コスト確認 |

### admin にスマホで初回ログイン

1. `https://static-epigram-496002-v8.web.app` を開く
2. 「Sign in with Google」→ `info@banax.tokyo` で承認
3. ダッシュボード表示

### keihi API を curl で叩く（要認証）

```bash
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" "https://keihi-api-jmzsz44nvq-an.a.run.app/health"
```

---

## 📦 現在のアプリ

| ディレクトリ              | サービス名        | 内容                              | 状態         |
|--------------------------|------------------|----------------------------------|--------------|
| `apps/keihi/`            | `keihi-api`      | 経費管理アプリ (Gemini + Cloud SQL) | 開発中       |
| `apps/admin/`            | `keikhi-admin`   | 管理ダッシュボード (Firebase Hosting+Auth) | 稼働中 ✅    |
| `apps/denki-zumen/`      | `denki-zumen-api`| 電気図面作成アプリ                 | 未着手 (枠)  |

## 🏗️ 共有スタック

| レイヤ       | リソース                                          |
|-------------|--------------------------------------------------|
| Hosting     | Firebase Hosting (`static-epigram-496002-v8.web.app`) |
| Auth        | Firebase Auth (Google プロバイダ)                 |
| API         | Cloud Run (`asia-northeast1`)                    |
| AI          | Gemini API (Secret Manager: `gemini-api-key`)    |
| DB          | Cloud SQL Postgres 15 (`keikhi-db`, 全アプリで共有・DBは別) |
| Storage     | Cloud Storage (アプリ毎に `<project>-<app>-receipts`) |
| Registry    | Artifact Registry (`keikhi`)                     |
| CI/CD       | Cloud Build (`gcloud builds submit` で手動)       |

---

## 🚀 デプロイ

### 全アプリ共通

```bash
gcloud builds submit \
  --config=apps/<アプリ名>/cloudbuild.yaml \
  --region=asia-northeast1 \
  .
```

### keihi (経費)

```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

### admin (ダッシュボード)

ログイン許可するメール指定 (`,` 区切りで複数可):

```bash
gcloud builds submit \
  --config=apps/admin/cloudbuild.yaml \
  --region=asia-northeast1 \
  --substitutions=_ALLOWED_EMAILS=info@banax.tokyo \
  .
```

### ビルド状況確認

```bash
gcloud builds list --region=asia-northeast1 --limit=5
```

ログを覗く：
```bash
gcloud builds log <BUILD_ID> --region=asia-northeast1
```

---

## 🔧 よく使う運用コマンド

### DB に繋ぐ（パスワード不要）

```bash
./infra/db.sh keihi                                  # 対話 psql
./infra/db.sh keihi -c '\dt'                         # テーブル一覧
./infra/db.sh keihi -c "SELECT * FROM records LIMIT 5"
./infra/db.sh keihi < apps/keihi/infra/schema.sql    # スキーマ再適用
```

### Cloud Run サービス一覧

```bash
gcloud run services list --region=asia-northeast1
```

### Cloud SQL を止める（節約: 月$9浮く）

```bash
gcloud sql instances patch keikhi-db --activation-policy=NEVER
```

再開：
```bash
gcloud sql instances patch keikhi-db --activation-policy=ALWAYS
```

### Secret を確認・更新

```bash
gcloud secrets list
gcloud secrets versions access latest --secret=gemini-api-key
# ローテーション
echo -n "<新しいキー>" | gcloud secrets versions add gemini-api-key --data-file=-
```

### admin にログイン許可メール追加

`cloudbuild.yaml` の `_ALLOWED_EMAILS` を変えて再デプロイ：

```bash
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 \
  --substitutions=_ALLOWED_EMAILS=info@banax.tokyo,colleague@banax.tokyo .
```

---

## 📱 スマホからの開発フロー

1. ユーザーが要望を伝える
2. **Claude がコード修正 → commit → push まで完遂**（ユーザーは何もしない）
3. **Cloud Build トリガが自動でビルド&デプロイ**（`claude/*`・`main` への push で発火）
4. ユーザーは **<https://keihi-496002.web.app>** を開いて動作確認するだけ

トリガ定義は `infra/bootstrap.sh`（208–223行）に**コード化済み**。
唯一の前提＝**GitHub↔Cloud Build の初回接続**（ブラウザでスマホ可・1回だけ。
未接続なら手動 `gcloud builds submit` でフォールバック）。

📘 **デプロイ構造の全詳細は [DEPLOY.md](DEPLOY.md) 参照**（アーキテクチャ図・各ステップ・トリガ仕様・誤解整理を全部記載）。

---

## 🎯 初回セットアップ（既に完了済み・参考用）

新しい GCP プロジェクトで一から立ち上げる場合:

```bash
# 1. プロジェクト設定
gcloud config set project <NEW_PROJECT_ID>

# 2. API 一括enable
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com generativelanguage.googleapis.com aiplatform.googleapis.com \
  vision.googleapis.com documentai.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com \
  identitytoolkit.googleapis.com firestore.googleapis.com

# 3. リポジトリ clone
git clone -b claude/development-session-YI5ay https://github.com/banaxart-jpg/keikhi.git
cd keikhi

# 4. bootstrap (Cloud SQL, Storage, Secret, SA 等を作成)
./infra/bootstrap.sh

# 5. Firebase Console で手動: プロジェクトリンク・Google プロバイダ有効化・Hosting Get started
# 6. 初回デプロイ
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 \
  --substitutions=_ALLOWED_EMAILS=自分@example.com .
```

詳細は各アプリの `apps/<app>/README.md` 参照。

---

## 💰 想定コスト（サンドボックス運用）

| サービス | 月額 |
|---------|-----|
| Cloud SQL `db-f1-micro` | **約 $9 (≈1,300円)** ← 最大 |
| Cloud Run (min=0) | 数百円〜 |
| Cloud Storage / Artifact Registry | 数十円〜 |
| Firebase Hosting | 無料枠内 (10GB/月) |
| Firebase Auth | 無料枠内 (50,000 MAU/月) |
| Gemini API | 無料枠内 (AI Studio) |
| Cloud Build | 月120分まで無料 |

**合計: 月1,500〜2,500円** 程度。Cloud SQL を停止すれば数百円に下がる。

---

## 📂 ファイル構成

```
keikhi/
├── README.md                   ← これ
├── .gitignore
├── infra/
│   ├── bootstrap.sh            ← GCP リソース一括プロビジョン (idempotent)
│   └── db.sh                   ← パスワード不要 psql ラッパー
└── apps/
    ├── keihi/                  ← 経費管理アプリ
    │   ├── app.yaml            ← bootstrap が読むメタ
    │   ├── cloudbuild.yaml     ← デプロイ仕様
    │   ├── README.md
    │   ├── index.html          ← フロント (旧版: Anthropic 直叩き)
    │   ├── infra/schema.sql    ← Postgres スキーマ
    │   └── server/             ← Cloud Run コード
    ├── admin/                  ← 管理ダッシュボード
    │   ├── app.yaml
    │   ├── cloudbuild.yaml     ← Docker + Cloud Run + Firebase Hosting デプロイ
    │   ├── firebase.json       ← Hosting rewrite 設定
    │   ├── .firebaserc         ← プロジェクトID
    │   ├── README.md
    │   └── server/
    │       ├── index.js        ← Express + Firebase Auth verify
    │       ├── package.json
    │       └── public/         ← Hosting で配信される静的ファイル
    │           └── index.html
    └── denki-zumen/            ← 電気図面アプリ (placeholder)
```

---

## 🔗 各アプリの詳細

- [keihi (経費管理)](apps/keihi/README.md)
- [admin (ダッシュボード)](apps/admin/README.md)
- [denki-zumen (電気図面)](apps/denki-zumen/README.md)

## 🛠️ TODO / 残課題

- [ ] Cloud Build トリガの **GitHub初回接続**（コンソールで1タップ／詳細は [DEPLOY.md](DEPLOY.md) §3）— トリガ定義自体は実装済み
- [x] keihi を Cloud Run `/api/*` + Firebase Hosting 化（完了）
- [ ] keihi の XSS脆弱性修正 (renderList の innerHTML エスケープ)
- [ ] 記録の編集機能・メモ欄
- [ ] 電気図面アプリの仕様策定
- [ ] FCM プッシュ通知 (デプロイ完了通知など)
