# keikhi monorepo

`apps/<アプリ名>/` 配下に1アプリずつ並べていく Google Cloud サンドボックス。
`gcloud builds submit` 一発で変更を本番反映、admin ダッシュボードで Firebase Auth (Google ログイン) 経由でスマホからモニタ。

---

> ## 🎓 このプロジェクトの目的
>
> **このプロジェクトは「名取」がプログラミングを覚えるための練習場**。
> 真面目な業務アプリ（経費管理など）も動かしつつ、その横で名取が
> 自分の業務に役立つミニアプリを自由に作って学べる構造になっている。
>
> **困ったとき・分からないときは「小西」(info@banax.tokyo / konishi0221@gmail.com) に相談する。**
> 小西はこのプロジェクトのオーナー兼サポート役。
>
> - 名取は1個から、好きにミニアプリを足してOK（`apps/keihi/web/<id>/index.html` を作って APPS 配列に1行追加）
> - HTML / CSS / JavaScript の基本だけで始められるよう、`/cost/` などの既存アプリを **写経のお手本**として使ってOK
> - 失敗しても本番経費アプリには影響しない（各ミニアプリは独立）
>
> 学習を促すためのこだわり：
> - **Claude (AI) は名取に難しい言葉をそのまま投げない。例え話を必ず使って説明する**
>   - ❌「Cloud Run の IAM Policy で allUsers binding が…」
>   - ✅「Cloud Run っていうのは『お店』、IAM は『店の前のセキュリティガード』。今ガードが厳しすぎて誰も入れないから、『誰でも入っていいよ』って看板出すイメージ」
> - ターミナルを叩かなくても済む構造を維持（`main` に push すれば自動デプロイ）

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
> - ✅ **専門用語が出てきたら必ず例え話で言い直す**（プログラミング初学者の従業員にも分かるように）
>
> **🔴 デプロイに関わる作業をする前に、必ず [DEPLOY.md](DEPLOY.md) を最初から最後まで読むこと。**
> デプロイ構造・自動デプロイの仕組み・トリガ・各アプリの構成は全て DEPLOY.md に書いてある。
> 読まずにコマンドを案内したり構造を推測で語ることは禁止。
>
> 手動コマンドを案内しそうになったら立ち止まり、自動化で代替できないか先に考えること。

---

> ## 👥 名取向け：このプロジェクトの使い方ルール
>
> ### 自由にやっていいこと
>
> - `apps/keihi/web/<id>/index.html` で自分のミニアプリを作る（HTML/CSS/JS だけ）
> - 自分のミニアプリ内の機能追加・スタイル変更
> - ランチャー (`apps/keihi/web/index.html`) の `APPS` 配列に自分のアプリ1行追加
> - お手本：[`/cost/`](apps/keihi/web/cost/index.html)（AIコスト計算）を写経の出発点に使ってOK
>
> ### 🆕 新しくAIを使うミニアプリを作る場合の必須プロセス
>
> Gemini / GPT / Claude を使うアプリを作る前に、**必ず [/cost/](https://keihi-496002.web.app/cost/) の AIコスト計算アプリで月額コストを試算する**。
>
> - 想定リクエスト数・トークン数・画像枚数を入れて月額が許容範囲か確認
> - **月数千円を超えそうなら小西に相談**してから着手
> - こうすることで「作ったあと請求書見て青ざめる」事故を防ぐ
>
> ### 小西に依頼すること
>
> 以下は GCP の設定変更が必要で、ターミナル操作や gcloud コマンドが要る。
> **名取が自分でやろうとせず、小西に丸投げでOK**：
>
> - 新しい API を有効化（Vision API, Document AI など、まだ enable してないもの）
> - Cloud SQL に新しいテーブル / カラム追加
> - Secret Manager に新しい API キーを追加（OpenAI / Anthropic のキー等）
> - Cloud Run の設定変更（メモリ / CPU / env vars）
> - Firebase Auth の許可メール追加（`_ALLOWED_EMAILS`）
> - Firestore の初期化・セキュリティルール設定
> - IAM 権限・ロールの変更
>
> **「ターミナル叩く必要が出てきた」「自分じゃ分からなくなった」「Claude が gcloud コマンドを実行しろと言ってる」→ 迷わず小西に依頼**
> （info@banax.tokyo / konishi0221@gmail.com）
>
> ### 🔒 触っちゃダメなもの（小西のみ変更可）
>
> デプロイ・インフラ・全体構成のドキュメントは小西が管理。**名取が勝手に変えるとデプロイが止まる**：
>
> - **`README.md` （このファイル）全体**
> - **`DEPLOY.md` 全体**
> - **`infra/`** 配下すべて（`bootstrap.sh`, `db.sh`, `dev.sh`）
> - 各アプリの `cloudbuild.yaml`
> - 各アプリの `firebase.json`
> - 各アプリの `README.md` の「🚨 過去にハマったポイント」セクション
>
> 自分のアプリ (`apps/keihi/web/<自分のID>/`) の中身と、自分のアプリ専用 README は自由に書いてOK。

---

## 🧰 今このプロジェクトで使える GCP の機能（ミニアプリから呼べる）

「使える」＝API は有効化済み、すぐに使い始められる。何かしらの初期化が要るものは "△" を付けてある。

| サービス | 用途（例え話） | 状態 | 使い方 |
|---|---|---|---|
| **Firebase Auth** | 入口の受付係（誰が来たか確認） | ✅ 稼働中 | ランチャー経由で自動ログイン済 |
| **Firebase Hosting** | お店の看板・店内（静的ファイル配信） | ✅ 稼働中 | `apps/keihi/web/` の中身が自動配信される |
| **Cloud Run** | お店の厨房（サーバ側プログラム実行） | ✅ 稼働中 (`keihi-api`) | バックエンドが要るときに使う。**新しい Cloud Run を立てるのは小西** |
| **Cloud SQL (Postgres)** | 棚卸帳簿（行と列の表で整理されたデータ） | ✅ 稼働中 (`keikhi-db` / `keihi` DB) | バックエンド経由でクエリ。**新テーブル追加は小西** |
| **Cloud Storage** | 倉庫（ファイル/画像保存） | ✅ 稼働中 (`<project>-keihi-receipts` バケット) | バックエンド経由でアップロード |
| **Firestore** | メモ帳 (NoSQL、軽量データ向け) | △ API有効・DB未作成 | ブラウザから直接読み書き可。**DB初期化は小西** |
| **Gemini API** | 文章を読んだり画像を見たりするAI | ✅ 稼働中 (`gemini-2.5-flash`) | `keihi-api` の `/api/scan` を流用 or 新エンドポイント作成 |
| **Vertex AI** | Gemini と同等＋画像生成等の高機能版 | △ API有効・未使用 | バックエンド経由。**初回使用は小西と相談** |
| **Vision API** | 画像専用 OCR（Gemini より高速で安い場合あり） | △ API有効・未使用 | バックエンド経由。**初回使用は小西と相談** |
| **Document AI** | レシート / 請求書 / 名刺の専門パーサ | △ API有効・未使用 | 専門用紙の構造化に強い。**初回使用は小西と相談** |
| **Secret Manager** | 金庫（APIキー等の秘密情報の保管庫） | ✅ 稼働中 (`gemini-api-key`, `keihi-db-password`) | **新規追加は小西** |
| **Cloud Build** | 工場（コードからデプロイ） | ✅ 稼働中 | main に push すれば自動で動く |
| **Artifact Registry** | 倉庫（ビルド済みコンテナ） | ✅ 稼働中 (`keikhi` リポジトリ) | Cloud Build が自動で push |

凡例：
- ✅ そのまま使える
- △ API有効・本格使用には小西の初期化作業が必要

---

## 📁 ミニアプリ構造（ランチャー方式）

`https://keihi-496002.web.app` を **アプリランチャー（トップ＝アプリ選択画面）** とし、
ミニアプリをその下に **1アプリ1ディレクトリ** で量産していく。

```
apps/keihi/web/                ← Hosting 公開ルート（site: keihi-496002）
├── index.html                 ← ランチャー（トップ。アプリ選択 + 共通Googleログイン）
├── config.js                  ← Cloud Run URL（ビルド時に自動注入・/config.js で共有）
├── keihi/
│   └── index.html             ← 経費アプリ        → /keihi/
└── <新アプリID>/
    └── index.html             ← 新ミニアプリ      → /<新アプリID>/
```

| URL | 中身 |
|-----|------|
| `keihi-496002.web.app/` | ランチャー（アプリ選択画面） |
| `keihi-496002.web.app/keihi/` | 経費アプリ（領収書AI読取・Cloud Run `keihi-api` 連携） |
| `keihi-496002.web.app/<id>/` | 今後追加するミニアプリ |

### 新しいミニアプリの追加手順

1. `apps/keihi/web/<id>/index.html` を作る（**1アプリ＝1ディレクトリ**）
2. ランチャー `apps/keihi/web/index.html` の `APPS` 配列に1行追加
   （`{ id, name, icon, desc, path:"/<id>/" }`。`soon:true` で「準備中」表示）
3. main に push → 自動デプロイ → `keihi-496002.web.app/<id>/` で公開

### ルール

- **共通ログイン**：ランチャーで1回 Google ログイン → トークンは `localStorage`
  に保存され、同一オリジンの全ミニアプリで共有（各アプリは再ログイン不要）
- **バックエンドが要るアプリ**：必要なら専用 Cloud Run サービスを持てる
  （経費は `keihi-api`）。要らないアプリは静的のみでOK
- Hosting 公開ルートは現状 `apps/keihi/web/`（既存URL流用のため）。
  ディレクトリ名 `keihi` は歴史的経緯。新アプリは必ず自分の `<id>/` 配下に置く

---

## 🌐 本番 URL

| アプリ | URL | アクセス方法 |
|--------|-----|------------|
| **keihi 経費アプリ** | <https://keihi-496002.web.app> | スマホブラウザで開く → Google ログイン |
| **admin ダッシュボード** | <https://static-epigram-496002-v8.web.app> | スマホブラウザで開く → Google ログイン (`info@banax.tokyo`) |
| keihi API (Cloud Run 直URL) | <https://keihi-api-734350696397.asia-northeast1.run.app> | **public** (`allUsers` invoker)。Firebase IDトークン認証は Express 側で行う |
| keikhi-admin Cloud Run (直叩き不可) | <https://keikhi-admin-734350696397.asia-northeast1.run.app> | Firebase Hosting 経由のみ |
| Firebase Console | <https://console.firebase.google.com/project/static-epigram-496002-v8> | 認証・Hosting管理 |
| GCP Console | <https://console.cloud.google.com/home/dashboard?project=static-epigram-496002-v8> | 全体管理 |
| 課金レポート | <https://console.cloud.google.com/billing/01DA00-93CCBF-AB55B7/reports?project=static-epigram-496002-v8> | コスト確認 |

### admin にスマホで初回ログイン

1. `https://static-epigram-496002-v8.web.app` を開く
2. 「Sign in with Google」→ `info@banax.tokyo` で承認
3. ダッシュボード表示

### keihi API を curl で叩く

ヘルスチェック（認証不要）:
```bash
curl https://keihi-api-734350696397.asia-northeast1.run.app/health
```

認証必須エンドポイント（`/api/*`）はブラウザ経由が前提。Firebase ID トークン
（OAuth ID Token ではない）を `Authorization: Bearer <token>` で送る必要が
あるが、CLI から取るのは面倒なので、デバッグは Cloud Shell の `bash infra/dev.sh keihi`
で `DEV=1` バイパスを使うのが楽。

---

## 📦 現在のアプリ

| ディレクトリ              | サービス名        | 内容                              | 状態         |
|--------------------------|------------------|----------------------------------|--------------|
| `apps/keihi/`            | `keihi-api`      | 経費管理アプリ (Gemini + Cloud SQL) | 稼働中 ✅    |
| `apps/admin/`            | `keikhi-admin`   | 管理ダッシュボード (Firebase Hosting+Auth) | 稼働中 ✅    |
| `apps/denki-zumen/`      | `denki-zumen-api`| 電気図面作成アプリ                 | 未着手 (枠)  |

## 🚨 知っておくべき制約・落とし穴

このプロジェクトは普通の Firebase + Cloud Run 構成と**違う点**がいくつかある。
ハマる前に [`apps/keihi/README.md`](apps/keihi/README.md) §「過去にハマったポイント」と
[`DEPLOY.md`](DEPLOY.md) §6 を読むこと。要点：

1. **Firebase Hosting `/api/**` rewrite は使えない**。組織ポリシー
   `iam.allowedPolicyMemberDomains` が Firebase Hosting の Service Agent
   (`gcp-sa-firebasehosting` ドメイン) を IAM 登録から弾くため。代わりに
   Cloud Run を `allUsers` で public 化し、ブラウザは Cloud Run の絶対URLを
   直叩き（CORS）、Express の `verifyIdToken` で実認証
2. **OAuth リダイレクトURI** に `https://keihi-496002.web.app/__/auth/handler` の
   登録が Cloud Console で必須（iOS Safari ITP 回避で `authDomain` を Hosting と
   揃えるため）
3. **組織ポリシー上書き済**：`iam.allowedPolicyMemberDomains` をプロジェクト
   レベルで `allowAll` に上書きしている（さもないと `allUsers` も追加できない）。
   `info@banax.tokyo` の組織ポリシー管理者ロールに依存している

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
| CI/CD       | Cloud Build トリガ（`main` への push で自動デプロイ・設定済み） |

---

## 🚀 デプロイ方法（詳細）

> 📘 構造の全詳細・図・誤解整理は **[DEPLOY.md](DEPLOY.md)** に集約。ここは要点。

### 仕組み（自動デプロイ・これが通常運用）

Cloud Build トリガ `keihi-api-deploy` が **設定済み**：

| 項目 | 値 |
|------|----|
| トリガ名 | `keihi-api-deploy` |
| リージョン | `global`（第1世代 GitHub App） |
| 発火条件 | **`main` への push** かつ `apps/keihi/**` の変更 |
| 実行 | `apps/keihi/cloudbuild.yaml`（Docker→Cloud Run→Firebase Hosting） |
| ビルドSA | `734350696397-compute@developer.gserviceaccount.com` |

```
Claude が claude/development-session-* で作業 → commit → そのブランチに push
        → main を作業ブランチに fast-forward → main に push
              ↓ 自動（keihi-api-deploy 発火）
        Cloud Build が apps/keihi/cloudbuild.yaml を実行
              ↓ 自動
        Cloud Run (keihi-api) + Firebase Hosting (keihi-496002) に反映
              ↓
        ユーザー： https://keihi-496002.web.app を開くだけ
```

**ブランチは `main` のみ**（`^main$`）。Claude は作業完了後 `main` に
push してリリースする（main は作業ブランチの祖先＝fast-forward・履歴破壊なし）。
ユーザーが GitHub / main / ターミナルを触る必要はない。

### デプロイ状況の確認（スマホ・ブラウザで可）

ビルド履歴：
<https://console.cloud.google.com/cloud-build/builds?project=static-epigram-496002-v8>

最新ビルドが緑（成功）になったら反映完了。アプリ：
<https://keihi-496002.web.app>

### 手動デプロイ（フォールバック・通常は不要）

トリガが壊れた時や緊急時のみ。Cloud Shell で：

```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
gcloud builds list --region=asia-northeast1 --limit=5   # 状況確認
```

admin（Hosting のみ・トリガ未設定なので必要時手動）：

```bash
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 .
```

### トリガを作り直す場合（参考）

第1世代 GitHub App 接続。**`--region` は付けない（global）**：

```bash
gcloud builds triggers create github \
  --name=keihi-api-deploy \
  --repo-owner=banaxart-jpg --repo-name=keikhi \
  --branch-pattern='^main$' \
  --build-config=apps/keihi/cloudbuild.yaml \
  --included-files='apps/keihi/**'
```

`infra/bootstrap.sh`（208行付近）も同じ定義を冪等に再作成する。

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

## ⚡ デプロイ待ちゼロ：Cloud Shell 即プレビュー

UI/挙動の確認はデプロイ不要。**本番と同一コード・同一構成**を Cloud Shell の
1プロセスで起動し、Web プレビューでスマホからその場で確認できる。

```bash
bash infra/dev.sh keihi
```

→ Cloud Shell 上部 **「ウェブでプレビュー」→ ポート 8080** を開く
→ コード修正後は `Ctrl+C` → 再実行（数秒で再起動）

本番との同一性（`infra/dev.sh` が担保）：

| 要素 | dev (Cloud Shell) | 本番 |
|------|-------------------|------|
| API 経路 | 同一オリジン `/api/**` | Firebase Hosting rewrite `/api/**` |
| 認証 | 本物の Firebase ID トークン検証（同一コード） | 同左 |
| Firebase設定 | 本番Hostingの `init.json` をそのまま取得 | 同左 |
| DB | cloud-sql-proxy 経由で**本番と同じ Cloud SQL** | Cloud Run unix socket |
| Gemini/バケット | **本番と同じ** Secret / バケット | 同左 |

> サーバは `DEV=1` のときだけ静的フロント + `/__/firebase/init.json` も配信し、
> 本番(Cloud Run, API専用)と1ファイルで両対応。コード分岐は最小。

**フロー：** Claude が修正 push → 確認したい時は `bash infra/dev.sh keihi` で即確認 →
OK なら main に push（＝Cloud Build トリガで本番反映）。本番デプロイは
Kaniko レイヤキャッシュで差分のみビルド（[DEPLOY.md](DEPLOY.md)）。

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
