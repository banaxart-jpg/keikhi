# デプロイ構造 完全ガイド

> このドキュメントは「どういう構造でデプロイされるか」を全部書いたもの。
> プロジェクト方針：**スマホ運用前提・ユーザーにコマンドを叩かせない**。
> 結論を先に → 自動デプロイの仕組みは **すでにコード化済み**。
> 足りないのは **GitHub↔Cloud Build の初回接続（コンソールで1タップ、ターミナル不要）だけ**。

---

## 0. 一言まとめ

```
Claude が作業ブランチで作業 → main に push → トリガ発火 → 自動ビルド&デプロイ → ユーザーはURLを開くだけ
```

**トリガは作成済み**（手動でコンソール作成。`infra/bootstrap.sh` も同等の定義を持つ）：

| トリガ名 | リージョン | 発火条件 | 実行 |
|---------|-----------|---------|------|
| `keihi-api-deploy` | `global`（第1世代 GitHub App） | **`main` への push** で `apps/keihi/**` が変更 | keihi の build+deploy |

ブランチは **`main` のみ**（`^main$`）。Claude は作業ブランチ
`claude/development-session-*` で作業し、完了したら **`main` に push（fast-forward）して
リリース**する。ユーザーは GitHub も main も触らない。

---

## 1. 全体アーキテクチャ

```
┌─────────────┐     ①push      ┌──────────────┐
│   GitHub    │ ─────────────▶ │ Cloud Build  │  ②cloudbuild.yaml を実行
│  (banaxart- │   トリガ発火    │ (asia-NE1)   │
│  jpg/keikhi)│                └──────┬───────┘
└─────────────┘                       │
                          ┌───────────┼─────────────────┐
                          ▼           ▼                 ▼
                   ③Docker build  ④Cloud Run     ⑤Firebase Hosting
                   → Artifact Reg.   deploy         deploy
                                   (keihi-api)     (静的フロント配信)
                                       │                 │
                                       └──── ⑥ブラウザ ──┘
                                       OAuthトークン付きでAPIを叩く

   ⑦ユーザー：スマホで Hosting URL を開くだけ
```

### 共有スタック（全アプリ共通・1回だけ作成済み）

| レイヤ | リソース | 作成元 |
|--------|---------|--------|
| プロジェクト | `static-epigram-496002-v8` (番号 734350696397) | 手動 |
| Hosting | Firebase Hosting | `infra/bootstrap.sh` がAPI有効化 |
| Auth | Firebase Auth (Google プロバイダ) | Firebase Console で手動有効化 |
| API実行基盤 | Cloud Run (`asia-northeast1`) | bootstrap |
| AI | Gemini API（Secret: `gemini-api-key`） | bootstrap で投入 |
| DB | Cloud SQL Postgres 15 (`keikhi-db`, db-f1-micro) | bootstrap |
| Storage | Cloud Storage（アプリ毎 `<project>-<app>-receipts`） | bootstrap |
| イメージ置き場 | Artifact Registry (`keikhi`) | bootstrap |
| CI/CD | Cloud Build トリガ（GitHub連携） | bootstrap（接続のみ手動1回） |

---

## 2. アプリ別デプロイ構造

### 2-1. keihi（経費管理）= Cloud Run + Hosting の2段構成

**フロント = Firebase Hosting、バックエンド = Cloud Run**。1回の build で両方デプロイ。

| 項目 | 値 |
|------|----|
| Cloud Run サービス | `keihi-api`（`--no-allow-unauthenticated`＝直叩き不可） |
| Hosting サイト | `keihi-496002` → **https://keihi-496002.web.app** ←ユーザーが開くURL |
| ビルド定義 | `apps/keihi/cloudbuild.yaml` |
| ランタイムSA | `keihi-run@<project>.iam.gserviceaccount.com` |
| DB | Cloud SQL `keikhi-db` 内の `keihi` データベース |
| Storage | `<project>-keihi-receipts`（領収書画像） |
| Secrets | `gemini-api-key`, `keihi-db-password` |

#### `apps/keihi/cloudbuild.yaml` のステップ詳細

1. **build** — `apps/keihi/server` を Docker build
   （`node:20-slim`、`npm install --omit=dev`、`CMD node index.js`、port 8080）
2. **push** — イメージを Artifact Registry (`<region>-docker.pkg.dev/<proj>/keikhi/keihi`) へ push（`:BUILD_ID` と `:latest`）
3. **deploy** — Cloud Run `keihi-api` にデプロイ
   - `--no-allow-unauthenticated`（ブラウザ直アクセス不可）
   - Cloud SQL 接続、Secret 注入（`GEMINI_API_KEY`, `DB_PASSWORD`）
   - 環境変数（`DB_USER/DB_NAME/DB_INSTANCE_CONNECTION_NAME/RECEIPTS_BUCKET`）
   - `--memory=512Mi --cpu=1 --min-instances=0 --max-instances=3`
4. **grant-invoker** — `user:info@banax.tokyo` に `roles/run.invoker` 付与し、
   Cloud Run の URL を取得して `apps/keihi/web/config.js` に
   `window.API_BASE='<url>';` として書き込む（フロントが叩く先）
5. **ensure-hosting-site** — Hosting サイト `keihi-496002` を冪等に作成
6. **deploy-hosting** — `firebase deploy --only hosting`（`apps/keihi/web` を配信）

#### 認証フロー（なぜ2段構成か）

Cloud Run は組織ポリシーで `allUsers` 公開不可。だから：

```
スマホ → Firebase Hosting (UI表示・静的)
         └ Googleログイン (info@banax.tokyo) で OAuthアクセストークン取得
           └ Authorization: Bearer <token> を付けて
             → Cloud Run keihi-api （認証済みリクエストとして実行）
```

`info@banax.tokyo` だけが `run.invoker` を持つので、このユーザーのトークンでのみAPIが通る。

### 2-2. admin（管理ダッシュボード）= Hosting のみ

| 項目 | 値 |
|------|----|
| Cloud Run | **なし**（`app.yaml` に `HAS_CLOUD_RUN: "false"`） |
| Hosting サイト | `static-epigram-496002-v8` → **https://static-epigram-496002-v8.web.app** |
| ビルド定義 | `apps/admin/cloudbuild.yaml`（`deploy-hosting` 1ステップのみ） |
| 中身 | 静的HTML + Firebase Auth + ブラウザから直接GCP APIを叩く |

`apps/admin/cloudbuild.yaml` は `firebase deploy --only hosting` だけ。Docker も Cloud Run も無い。

### 2-3. denki-zumen（電気図面）= 未着手の枠のみ

---

## 3. 自動デプロイ（Cloud Build トリガ）の仕組み

### 作成済みトリガ（`keihi-api-deploy`）

GitHub 接続は**第1世代 GitHub App**。第1世代トリガは **`global`** リージョンに作られる
（`asia-northeast1` 等のリージョン指定だと `INVALID_ARGUMENT` で失敗するので注意）。
コンソールで作成済み。`infra/bootstrap.sh` も同等の定義を持つ：

```
gcloud builds triggers create github \
  --name="keihi-api-deploy" \
  --repo-owner="banaxart-jpg" --repo-name="keikhi" \
  --branch-pattern='^main$' \
  --build-config="apps/keihi/cloudbuild.yaml" \
  --included-files="apps/keihi/**"
  # --region は付けない（第1世代＝global）
```

| トリガ名 | リージョン | 発火条件 | 実行 |
|---------|-----------|---------|------|
| `keihi-api-deploy` | `global` | **`main` への push** で `apps/keihi/**` が変更 | keihi の build+deploy |

- ビルド実行SA = `734350696397-compute@developer.gserviceaccount.com`
  （bootstrap.sh が必要ロールを付与済み：run.admin / artifactregistry.writer /
  firebasehosting.admin / firebase.admin / iam.serviceAccountUser ほか）
- `--included-files` により `apps/keihi/**` が変わった時だけ発火（無駄ビルドなし）
- ブランチは **`main` のみ**。`README.md` 等リポジトリ直下の変更ではデプロイは走らない

### 足りない唯一のもの：GitHub↔Cloud Build 初回接続

`gcloud builds triggers create github` は、対象 GitHub リポジトリが
Cloud Build に**接続済み**である必要がある。未接続だと bootstrap.sh は
スキップして接続用URLを表示する（220–222行）。

この接続は **OAuth 認可**なので、ターミナルではなく**ブラウザ（スマホ可）で1回タップ**するだけ：

> **手順（スマホでOK・1回だけ）**
> 1. `https://console.cloud.google.com/cloud-build/triggers/connect?project=static-epigram-496002-v8` を開く
> 2. 「リポジトリを接続」→ GitHub (Cloud Build GitHub App) を選択
> 3. `banaxart-jpg/keikhi` を選んで承認
> 4. 完了。以後トリガは自動作成可能になる

**接続・トリガとも作成済み。** トリガはコンソールで手動作成した
（`keihi-api-deploy` / global / `^main$` / `apps/keihi/cloudbuild.yaml`）。

### 運用フロー（確定版）

```
1. ユーザーが要望を伝える
2. Claude が claude/development-session-* で作業 → commit → そのブランチに push
3. Claude が main を作業ブランチ HEAD に fast-forward → main に push
                          ↓ 自動
4. keihi-api-deploy トリガ発火（main への push かつ apps/keihi/** 変更時）
                          ↓ 自動
5. apps/keihi/cloudbuild.yaml 実行（Docker→Cloud Run→Hosting）
                          ↓
6. ユーザー：https://keihi-496002.web.app を開くだけ
```

- main は作業ブランチの祖先なので **fast-forward 可能＝履歴破壊なし・安全**
- ユーザーが GitHub / main / ターミナルを触る場面は**ゼロ**
- Claude は「main に push したらリリースされる」と認識して作業すること

---

## 4. 手動デプロイ（接続前の暫定 / フォールバック）

トリガ接続が済むまでの間、または緊急時のみ。**通常運用では不要**。

```
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 .
```

ビルド状況：

```
gcloud builds list --region=asia-northeast1 --limit=5
```

---

## 5. リソース一覧（デプロイで触れるもの）

| 種別 | 名前 | リージョン/場所 |
|------|------|----------------|
| Cloud Run | `keihi-api` | asia-northeast1 |
| Firebase Hosting | `keihi-496002`（keihi front） | global |
| Firebase Hosting | `static-epigram-496002-v8`（admin） | global |
| Artifact Registry | `keikhi`（Dockerリポジトリ） | asia-northeast1 |
| Cloud SQL | `keikhi-db`（Postgres 15, db-f1-micro） | asia-northeast1 |
| Cloud Storage | `<project>-keihi-receipts` | asia-northeast1 |
| Secret Manager | `gemini-api-key`, `keihi-db-password` | global |
| Service Account | `keihi-run@…`（keihiランタイム） | — |
| Cloud Build Trigger | `keihi-api-deploy`, `keikhi-admin-deploy` | asia-northeast1 |

---

## 6. よくある誤解の整理

| 誤解 | 実際 |
|------|------|
| 「Cloud Run にデプロイしてないの？」 | keihi は **Cloud Run と Hosting の両方**に1回でデプロイ |
| 「Cloud Run の URL を開けばいい」 | 直叩き不可（401）。**Hosting の URL を開く** |
| 「push できてないのでは？」 | push 済み。`git ls-remote` で実体確認可能 |
| 「自動デプロイは未設定」 | トリガ定義は **コード化済み**。GitHub接続だけが未完 |
| 「毎回コマンドが必要」 | 接続後は **push だけ**で自動。コマンド不要 |

---

## 7. このプロジェクトの開発フロー（あるべき姿）

1. ユーザーが要望を伝える
2. Claude がコード修正 → コミット → **push まで完遂**
3. Cloud Build トリガが自動でビルド&デプロイ（接続後）
4. ユーザーは **https://keihi-496002.web.app** を開いて動作確認するだけ

ユーザーがターミナル / `git` / `gcloud` を叩く必要はない。
（唯一の例外＝GitHub↔Cloud Build 初回接続。これもブラウザ操作でスマホ可・1回限り）
