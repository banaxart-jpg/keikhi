# keikhi monorepo

`apps/<アプリ名>/` 配下に1アプリずつ並べていく Google Cloud サンドボックス。
push したら Cloud Build が走って、変更があったアプリだけ Cloud Run に自動デプロイされる。

## 現在のアプリ

| ディレクトリ              | 内容              | 状態         |
|--------------------------|-------------------|--------------|
| `apps/keihi/`            | 経費管理アプリ     | 開発中       |
| `apps/denki-zumen/`      | 電気図面作成アプリ | 未着手 (枠)  |

## 共有スタック

| レイヤ       | リソース                                          |
|-------------|--------------------------------------------------|
| AI          | Gemini API (Secret Manager: `gemini-api-key`)    |
| DB          | Cloud SQL Postgres 15 (`keikhi-db`, 全アプリで共有・DBは別) |
| Storage     | Cloud Storage (アプリ毎に `<project>-<app>-receipts`) |
| Registry    | Artifact Registry (`keikhi`)                     |
| Hosting     | Cloud Run (`<app>-api`)                          |
| CI/CD       | Cloud Build (`apps/<app>/**` push でトリガ)       |
| Region      | `asia-northeast1`                                |

---

## 🚀 初回セットアップ手順

### 1. Cloud Shell を開く

スマホ・PC どちらでも:
👉 <https://shell.cloud.google.com>

### 2. リポジトリを取得

```bash
git clone https://github.com/banaxart-jpg/keikhi.git
cd keikhi
```

### 3. GitHub を Cloud Build に接続（OAuth: 一度きり）

CLI ではできない。ブラウザでこのリンクを開いて `banaxart-jpg/keikhi` を接続:
👉 <https://console.cloud.google.com/cloud-build/triggers/connect>

### 4. ワンショット bootstrap を実行

```bash
export PROJECT_ID=<your-gcp-project-id>
./infra/bootstrap.sh
```

入力を求められるのは **Gemini API キーだけ**（[AI Studio](https://aistudio.google.com/apikey) で発行）。
入れたら Secret Manager に保存される → 以降は触らない。

bootstrap が一度通れば以下が出来上がる:

- ✅ 必要な API が全部 enable
- ✅ Artifact Registry `keikhi`
- ✅ Cloud SQL インスタンス `keikhi-db` (Postgres 15, db-f1-micro)
- ✅ 各アプリ毎に: Cloud Run サービス用 SA / DB / バケット / DBパスワード Secret
- ✅ 各アプリ毎に: Cloud Build トリガ（path-filtered で他アプリの変更では発火しない）
- ✅ Cloud Build SA に必要なロール

### 5. 初回デプロイ

bootstrap はトリガを作るだけ。最初の1回は手動で：

```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

以後は `git push` だけで自動デプロイ。

### 6. URL 確認

```bash
gcloud run services list --region=asia-northeast1
```

---

## 開発フロー

スマホ from Cloud Shell エディタ や GitHub Web UI でファイルを編集 → commit & push → 該当アプリだけ自動再デプロイ。

```bash
# 編集 → コミット → push
git add apps/keihi/
git commit -m "tweak scan prompt"
git push
# Cloud Build がトリガされて keihi-api だけ再デプロイされる
```

ビルド状況の確認:
```bash
gcloud builds list --region=asia-northeast1 --limit=5
```

---

## 新しいアプリを足すとき

1. `apps/<新アプリ名>/` を作る
2. `app.yaml` を `apps/keihi/app.yaml` から複製して名前を書き換え
3. `server/` (Dockerfile + index.js) を用意
4. `cloudbuild.yaml` を複製して `_APP=<新アプリ名>` に書き換え
5. `./infra/bootstrap.sh` をもう一度流す → リソース・トリガが追加される

---

## ファイル構成

```
keikhi/
├── README.md                   ← これ
├── .gitignore
├── infra/
│   └── bootstrap.sh            ← Cloud Shell で1回流す
└── apps/
    ├── keihi/                  ← 経費管理アプリ
    │   ├── app.yaml            ← bootstrap が読むメタ
    │   ├── cloudbuild.yaml     ← デプロイ手順
    │   ├── README.md
    │   ├── index.html          ← フロント (現状)
    │   ├── infra/schema.sql
    │   └── server/             ← Cloud Run コード
    │       ├── package.json
    │       ├── index.js
    │       ├── Dockerfile
    │       └── .dockerignore
    └── denki-zumen/            ← 電気図面アプリ (placeholder)
        ├── app.yaml
        └── README.md
```
