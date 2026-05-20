# keikhi monorepo

`apps/<アプリ名>/` 配下に1アプリずつ並べていく Google Cloud サンドボックス。
`main` に push すれば Cloud Build トリガで自動デプロイ → `https://keihi-496002.web.app` で公開。

---

## 🛠 このプロジェクトについて

業務に役立つミニアプリをスマホで運用するための社内サンドボックス。
経費管理 (`/keihi/`)、AIコスト計算 (`/cost/`) を皮切りに、各メンバーが必要なアプリを `apps/<id>/index.html` を1ファイル作るだけで追加できる。
各ミニアプリは独立してるので、新規追加・実験で他に影響しない。

インフラ・GCP 設定・デプロイ周りは **小西 (info@banax.tokyo / konishi0221@gmail.com)** が管理。

---

## 🤖 Claude Code への依頼の定型句

新しいミニアプリや修正を Claude Code に依頼するときは、最初に以下を伝える：

> **`README.md` と `DEPLOY.md` と `CLAUDE.md` を読んでから、〇〇を作って**

これで Claude Code がプロジェクト構成・デプロイ方法・コード規約を全部把握してから書いてくれる。
読まずに書き始めると変な構成になりがちなので、毎回これを言うのが安全。

---

## 🔄 main に push する手順（必ずこの順番で）

別セッション・別 clone の commit を巻き戻す事故を防ぐため、**push する前に必ず fetch して状態確認** する。

```bash
# 1. リモートを取得
git fetch origin main

# 2. 整合性チェック（"0	0" 期待）
git rev-list --left-right --count main...origin/main
#  "0	0" → 完全一致、push 不要
#  "N	0" → 自分が ahead N、そのまま push 可
#  "0	M" → remote が先行、まず pull
#  "N	M" → 分岐、rebase or merge してから

# 3. behind なら追従
git pull --ff-only origin main

# 4. push（main へ直 commit はせず、作業ブランチから fast-forward させる）
git push origin main
```

Claude Code が作業するときの実際の流れ：

```bash
# 作業ブランチで commit
git checkout claude/<session-branch>
git add ... && git commit -m "..."
git push origin claude/<session-branch>

# 必ず fetch → 整合確認 → main を fast-forward → main push
git fetch origin main
git rev-list --left-right --count main...origin/main   # behind 0 を確認
git checkout main
git merge --ff-only claude/<session-branch>
git push origin main
```

`main` への push が Cloud Build トリガを発火させて本番デプロイされる。

⚠️ **過去に1度 stale clone からの暴発で本番 Hosting が巻き戻った事故あり**。fetch を省略しない。

---

## 👥 開発のお約束

### 自由に編集してOK
- `apps/<id>/index.html` で新ミニアプリ作成（HTML/CSS/JS）
- 自分が作ったミニアプリの中身・スタイル全般
- ランチャー (`apps/index.html`) の `APPS` 配列に**自分のエントリを1行追加**
- 実装の参考：[`/cost/`](apps/cost/index.html)（静的のみで完結）、[`/keihi/`](apps/keihi/index.html)（認証＋API呼び出し）

### 🆕 AI を使うミニアプリを作るとき

自分で先に [`/cost/`](https://keihi-496002.web.app/cost/) で月額の目安を見ておくと安心。
**Gemini はすでに動いている**ので、使うだけなら追加設定不要。

OpenAI / Claude など**新しい AI 提供元**を使いたいときは APIキー登録が必要なので、その時だけ小西に「キー入れて」って言って。

### 小西がやる範囲（技術的にスマホからできないこと）

「許可をもらう」じゃなくて、**ターミナル操作が必要だから小西側でしかできない**ってだけ：

- 新しい API の有効化（Vision API, Document AI など）
- Cloud SQL に新しいテーブル / カラム追加
- Secret Manager に新しい API キー追加（OpenAI / Anthropic 等）
- Cloud Run の設定変更（メモリ / CPU / env vars）
- Firebase Auth の許可メール追加
- Firestore の初期化・セキュリティルール設定
- IAM 権限・ロールの変更

**先に自分でやってみて詰まったら相談**でOK。事前許可は要らない。

### ✏️ 誰でも編集 OK
- **`apps/<自分のID>/` 配下すべて**（`index.html`, `README.md`, etc.）— 完全自由
- ランチャー (`apps/index.html`) の `APPS` 配列に**自分のアプリの行を1つ追加**
- このファイル (`README.md`) の自由テキスト部分（自分のミニアプリの説明追加、「📦 現在のアプリ」表への追記など）

### 🔒 小西管轄（編集は小西のみ）

デプロイ・GCP 構成と密結合してるので、勝手に変えるとデプロイが止まる：

- `DEPLOY.md`、`CLAUDE.md`、プロジェクト root の `firebase.json`
- `infra/` 配下すべて（`bootstrap.sh`, `db.sh`, `dev.sh`）
- 各アプリの `cloudbuild.yaml`
- `apps/keihi/README.md`（keihi 全体の構成・過去ハマりポイント記載）
- このファイル (`README.md`) のうち、**「🚨 知っておくべき制約・落とし穴」「🚀 デプロイ」「🔧 よく使う運用コマンド」「🏗️ 共有スタック」「💰 想定コスト」「🎯 初回セットアップ」「📂 ファイル構成」** のセクション
- ランチャー (`apps/index.html`) の **APPS 配列以外（スタイル・ロジック・他人のエントリ）**

### 📝 新ミニアプリ作成時のルール

`apps/<id>/` を作るときは **同じディレクトリに README.md も必ず1枚置く**。最小テンプレ：

```md
# <アプリ名>（/<id>/）

何のアプリか1-2行で。

## 使い方
- ランチャーから <icon> をタップ
- 〇〇する

## ファイル構成
- `index.html` — UI + ロジック

## 残課題
- [ ] 〇〇
```

Claude Code に新ミニアプリを依頼するときは、index.html と一緒に README.md も書いてもらうこと。

---

## 💻 ミニアプリ実装レシピ（クックブック）

新ミニアプリを作る時の最頻出パターン集。

### A. 認証もAPIも要らないアプリ（電卓・チェックリスト等）

`apps/<id>/index.html` を1ファイル書くだけ。参考実装：[`/cost/`](apps/cost/index.html)。

```html
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>マイアプリ</title></head>
<body>
  <h1>こんにちは</h1>
  <button onclick="alert('クリックされた')">ボタン</button>
</body>
</html>
```

最後にランチャー (`apps/index.html`) の `APPS` 配列に1行追加：

```js
{ id: "myapp", name: "マイアプリ", icon: "🎯", desc: "説明", path: "/myapp/" },
```

### B. ログインしてるユーザーのメールを取りたい

ランチャーで Firebase Auth が共通ログイン済み（localStorage 共有）。各ミニアプリでは取得し直し：

```html
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const cfg = await fetch("/__/firebase/init.json").then(r => r.json());
cfg.authDomain = location.hostname;   // iOS Safari ITP 対策（必須）
const auth = getAuth(initializeApp(cfg));

onAuthStateChanged(auth, (user) => {
  if (!user) { location.href = "/"; return; }  // 未ログインならランチャーへ
  document.body.textContent = "こんにちは " + user.email;
});
</script>
```

### C. バックエンド (Cloud Run) を認証付きで叩きたい

`<script src="/config.js"></script>` で `window.API_BASE` が読まれる（Cloud Build が注入済み）。
そこに Firebase ID トークンをつけて fetch。

```html
<script src="/config.js"></script>
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const cfg = await fetch("/__/firebase/init.json").then(r => r.json());
cfg.authDomain = location.hostname;
const auth = getAuth(initializeApp(cfg));

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "/"; return; }

  const token = await user.getIdToken();           // ← 認証トークン取得
  const res = await fetch(window.API_BASE + "/api/records", {
    headers: { Authorization: "Bearer " + token } // ← これで Express が通す
  });
  const data = await res.json();
  console.log(data);
});
</script>
```

### D. `window.API_BASE` って何？

Cloud Run（バックエンドの URL）が入った変数。

- 値の例: `https://keihi-api-734350696397.asia-northeast1.run.app`
- どこで決まる: Cloud Build の `prep-config` ステップが、デプロイ時の Cloud Run URL を `apps/config.js` に注入
- なぜ要る: 開発環境・本番環境・将来サービス名変更があっても、HTMLを書き換えずに済む
- 使い方: `<script src="/config.js"></script>` を読み込めば `window.API_BASE` が定義される

### E. 画像を撮ってアップロードしたい

`<input type="file" accept="image/*" capture="environment">` でスマホカメラ起動。Base64 にして送る。詳細は経費アプリ (`apps/keihi/index.html` の `handleFile()` あたり) を参照。

---

## 🧰 今このプロジェクトで使える GCP の機能

「使える」＝API は有効化済みですぐに使い始められる。初期化が要るものは "△" 印。

| サービス | 用途（例え話） | 状態 | 使い方 |
|---|---|---|---|
| **Firebase Auth** | 入口の受付係（誰が来たか確認） | ✅ 稼働中 | ランチャー経由で自動ログイン済 |
| **Firebase Hosting** | お店の看板・店内（静的ファイル配信） | ✅ 稼働中 | `apps/` 配下が自動配信される（`firebase.json` の ignore で server/infra 等は除外） |
| **Cloud Run** | お店の厨房（サーバ側プログラム実行） | ✅ 稼働中 (`keihi-api`) | バックエンドが要るとき。**新規構築は小西** |
| **Cloud SQL (Postgres)** | 棚卸帳簿（行と列の表で整理されたデータ） | ✅ 稼働中 (`keikhi-db` / `keihi` DB) | バックエンド経由でクエリ。**新テーブル追加は小西** |
| **Cloud Storage** | 倉庫（ファイル/画像保存） | ✅ 稼働中 (`<project>-keihi-receipts` バケット) | バックエンド経由でアップロード |
| **Firestore** | メモ帳 (NoSQL、軽量データ向け) | △ API有効・DB未作成 | ブラウザ直接読み書き可。**DB初期化は小西** |
| **Gemini API** | 文章を読んだり画像を見たりするAI | ✅ 稼働中 (`gemini-2.5-flash`) | `keihi-api` の `/api/scan` を流用 or 新エンドポイント |
| **Vertex AI** | Gemini と同等＋画像生成等の高機能版 | △ API有効・未使用 | **初回使用は小西と相談** |
| **Vision API** | 画像専用 OCR（Gemini より安い場合あり） | △ API有効・未使用 | **初回使用は小西と相談** |
| **Document AI** | レシート / 請求書 / 名刺の専門パーサ | △ API有効・未使用 | **初回使用は小西と相談** |
| **Secret Manager** | 金庫（APIキー等の秘密情報保管） | ✅ 稼働中 (`gemini-api-key`, `keihi-db-password`) | **新規追加は小西** |
| **Cloud Build** | 工場（コードからデプロイ） | ✅ 稼働中 | main に push すれば自動で動く |
| **Artifact Registry** | 倉庫（ビルド済みコンテナ） | ✅ 稼働中 (`keikhi` リポジトリ) | Cloud Build が自動で push |

---

## 📁 ミニアプリ構造（ランチャー方式）

```
apps/                          ← Hosting 公開ルート（site: keihi-496002）
├── index.html                 ← ランチャー（アプリ選択 + 共通Googleログイン）→ /
├── config.js                  ← Cloud Run URL（ビルド時に自動注入）
├── keihi/                     ← 経費アプリ        → /keihi/
│   ├── index.html
│   ├── README.md
│   ├── server/                ← Cloud Run コード（Hosting 配信から除外）
│   ├── infra/                 ← schema.sql 等（同上）
│   └── cloudbuild.yaml        ← デプロイ仕様（同上）
├── cost/                      ← AIコスト計算      → /cost/
│   ├── index.html
│   └── README.md
└── <新アプリID>/
    ├── index.html
    └── README.md
```

| URL | 中身 |
|-----|------|
| `keihi-496002.web.app/` | ランチャー（アプリ選択画面） |
| `keihi-496002.web.app/keihi/` | 経費アプリ |
| `keihi-496002.web.app/cost/` | AIコスト計算 |
| `keihi-496002.web.app/<id>/` | 今後追加するミニアプリ |

### 新しいミニアプリの追加手順

1. `apps/<id>/index.html` と `apps/<id>/README.md` を作る（**1アプリ＝1ディレクトリ**）
2. ランチャー `apps/index.html` の `APPS` 配列に1行追加
   （`{ id, name, icon, desc, path:"/<id>/" }`。`soon:true` で「準備中」表示）
3. main に push → 自動デプロイ → `keihi-496002.web.app/<id>/` で公開

### ルール

- **共通ログイン**：ランチャーで1回 Google ログイン → `localStorage` 永続化で同一オリジンの全ミニアプリで共有
- **バックエンドが要るアプリ**：必要なら専用 Cloud Run サービスを持てる（経費は `keihi-api`）。サーバコードは `apps/<id>/server/` 配下に
- 静的のみのアプリは `apps/<id>/index.html` 1ファイルだけで完結

---

## 🌐 本番 URL

| アプリ | URL |
|--------|-----|
| **keihi 経費アプリ** | <https://keihi-496002.web.app> |
| **AIコスト計算** | <https://keihi-496002.web.app/cost/> |
| **admin ダッシュボード** | <https://static-epigram-496002-v8.web.app> |
| keihi API (Cloud Run 直URL) | <https://keihi-api-734350696397.asia-northeast1.run.app> |
| Firebase Console | <https://console.firebase.google.com/project/static-epigram-496002-v8> |
| GCP Console | <https://console.cloud.google.com/home/dashboard?project=static-epigram-496002-v8> |
| 課金レポート | <https://console.cloud.google.com/billing/01DA00-93CCBF-AB55B7/reports?project=static-epigram-496002-v8> |
| Cloud Build 履歴 | <https://console.cloud.google.com/cloud-build/builds?project=static-epigram-496002-v8> |

---

## 📦 現在のアプリ

| ディレクトリ | サービス名 | 内容 | 状態 |
|---|---|---|---|
| `apps/keihi/` | `keihi-api` | 経費管理（領収書OCR） | 稼働中 ✅ |
| `apps/cost/` | （静的のみ） | AIコスト計算機 | 稼働中 ✅ |
| `apps/admin/` | `keikhi-admin` | 管理ダッシュボード | 稼働中 ✅ |
| `apps/denki-zumen/` | `denki-zumen-api` | 電気図面作成 | 未着手 |

---

## 🚨 知っておくべき制約・落とし穴（小西向け）

このプロジェクトは普通の Firebase + Cloud Run 構成と**違う点**がいくつかある。
詳細は [`apps/keihi/README.md`](apps/keihi/README.md) §「過去にハマったポイント」と [`DEPLOY.md`](DEPLOY.md) §6 参照。

1. **Firebase Hosting `/api/**` rewrite は使えない** — 組織ポリシー `iam.allowedPolicyMemberDomains` が Firebase Hosting の Service Agent を IAM から弾くため。代わりに Cloud Run を `allUsers` で public 化、Express の `verifyIdToken` で認証
2. **OAuth リダイレクトURI** に `https://keihi-496002.web.app/__/auth/handler` の登録必須（iOS Safari ITP 回避で `authDomain = location.hostname` してるため）
3. **組織ポリシー上書き済** — `iam.allowedPolicyMemberDomains` をプロジェクトレベルで `allowAll` に上書き。`info@banax.tokyo` の組織ポリシー管理者ロールに依存

---

## 🏗️ 共有スタック

| レイヤ | リソース |
|---|---|
| Hosting | Firebase Hosting (`keihi-496002.web.app`, `static-epigram-496002-v8.web.app`) |
| Auth | Firebase Auth (Google プロバイダ) |
| API | Cloud Run (`asia-northeast1`) |
| AI | Gemini API (Secret Manager: `gemini-api-key`) |
| DB | Cloud SQL Postgres 15 (`keikhi-db`, 全アプリで共有・DBは別) |
| Storage | Cloud Storage (アプリ毎に `<project>-<app>-receipts`) |
| Registry | Artifact Registry (`keikhi`) |
| CI/CD | Cloud Build トリガ（`main` push で自動デプロイ） |

---

## 🚀 デプロイ（小西向け）

> 構造の全詳細は **[DEPLOY.md](DEPLOY.md)** に集約。

### 仕組み（通常運用）

```
コード修正 → main に push → Cloud Build トリガ発火 → Docker build → Cloud Run 反映 → Hosting 反映
                                                      ↓
                                          ユーザーは https://keihi-496002.web.app を開くだけ
```

| トリガ | 発火条件 | 実行 |
|---|---|---|
| `keihi-api-deploy` | `main` への push（ファイルフィルタなし＝main 全変更で発火） | `apps/keihi/cloudbuild.yaml` |

### 手動デプロイ（緊急時のみ）

`firebase deploy --only hosting` を**直接打つのは禁止**。ローカル clone が古いと過去状態を本番に上書きする（過去に事故発生）。手動 deploy は必ずラッパー経由：

```bash
bash infra/deploy-hosting.sh
```

内部で `git fetch && git pull --ff-only origin main` してから deploy する。stale clone からの暴発を構造的にブロック。

Cloud Run（バックエンド）含めて全体ビルドし直したいとき：

```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
gcloud builds submit --config=apps/admin/cloudbuild.yaml --region=asia-northeast1 .
```

---

## 🔧 よく使う運用コマンド（小西向け）

### DB に繋ぐ（パスワード不要）
```bash
./infra/db.sh keihi                                  # 対話 psql
./infra/db.sh keihi -c '\dt'                         # テーブル一覧
./infra/db.sh keihi < apps/keihi/infra/schema.sql    # スキーマ再適用
```

### Cloud SQL 停止（節約: 月$9浮く）
```bash
gcloud sql instances patch keikhi-db --activation-policy=NEVER
gcloud sql instances patch keikhi-db --activation-policy=ALWAYS   # 再開
```

### Secret ローテーション
```bash
echo -n "<新キー>" | gcloud secrets versions add gemini-api-key --data-file=-
```

### 許可メール追加
```bash
gcloud run services update keihi-api \
  --region=asia-northeast1 \
  --update-env-vars=ALLOWED_EMAILS=info@banax.tokyo,konishi0221@gmail.com,新人@gmail.com
```

---

## ⚡ Cloud Shell 即プレビュー（デプロイ待ちゼロ）

```bash
bash infra/dev.sh keihi
```

→ Cloud Shell 上部「ウェブでプレビュー」→ ポート 8080。本番と同一の Cloud SQL / Secret / バケットに繋がる。

---

## 💰 想定コスト（月額・サンドボックス運用）

| サービス | 月額 |
|---------|-----|
| Cloud SQL `db-f1-micro` | 約 $9 (≈1,300円) ← 最大 |
| Cloud Run (min=0) | 数百円〜 |
| Cloud Storage / Artifact Registry | 数十円〜 |
| Firebase Hosting / Auth | 無料枠内 |
| Gemini API | 従量課金（200枚OCRで数円） |
| Cloud Build | 月120分まで無料 |

**合計: 月1,500〜2,500円** 程度。Cloud SQL を停止すれば数百円に下がる。

---

## 📂 ファイル構成

```
keikhi/
├── README.md                   ← これ
├── DEPLOY.md                   ← デプロイ詳細（小西のみ変更可）
├── CLAUDE.md                   ← Claude Code 用設定（小西のみ変更可）
├── firebase.json               ← Hosting 設定（public: "apps"）
├── infra/
│   ├── bootstrap.sh            ← GCP リソース一括プロビジョン
│   ├── db.sh                   ← パスワード不要 psql ラッパー
│   └── dev.sh                  ← Cloud Shell 即プレビュー
└── apps/                       ← Hosting 公開ルート
    ├── index.html              ← ランチャー → /
    ├── config.js               ← Cloud Run URL（自動注入）
    ├── keihi/                  ← 経費アプリ → /keihi/
    │   ├── index.html
    │   ├── README.md
    │   ├── cloudbuild.yaml     ← デプロイ仕様（Cloud Run + Hosting）
    │   ├── infra/schema.sql    ← Postgres スキーマ
    │   └── server/             ← Cloud Run コード (Express)
    ├── cost/                   ← AIコスト計算 → /cost/
    │   ├── index.html
    │   └── README.md
    ├── admin/                  ← 管理ダッシュボード（別 Hosting site）
    └── denki-zumen/            ← 電気図面アプリ (placeholder)
```

---

## 🔗 各アプリの詳細
- [keihi (経費管理)](apps/keihi/README.md)
- [admin (ダッシュボード)](apps/admin/README.md)
- [denki-zumen (電気図面)](apps/denki-zumen/README.md)

## 🛠️ TODO / 残課題
- [ ] Cloud Build トリガの **GitHub初回接続**（詳細は [DEPLOY.md](DEPLOY.md) §3）
- [x] keihi を Cloud Run 直叩き構成に移行（完了）
- [x] AIコスト計算ミニアプリ追加（完了）
- [ ] keihi の XSS脆弱性修正 (`renderList()` の `innerHTML` エスケープ)
- [ ] 電気図面アプリの仕様策定
- [ ] FCM プッシュ通知（デプロイ完了通知など）
