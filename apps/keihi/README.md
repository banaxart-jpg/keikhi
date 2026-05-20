# keihi — 経費管理アプリ (`/keihi/`)

レシートをスマホで撮影 → Gemini で OCR → 編集して Cloud SQL に保存。
フロントは Firebase Hosting (`apps/keihi/index.html`)、バックエンドは Cloud Run (`apps/keihi/server/`)。

## 構成

```
[iPhone/Android Browser]
        │
        ├─── 静的ファイル受け取り ──▶ Firebase Hosting
        │                              keihi-496002.web.app/keihi/
        │                              (apps/keihi/index.html)
        │
        └─── /api/* 直接呼び出し ─────▶ Cloud Run keihi-api
              Authorization: Bearer    https://keihi-api-734350696397.asia-northeast1.run.app
              <Firebase ID Token>      │
                                       ├ Express
                                       │   ├ verifyIdToken (Firebase Admin SDK)
                                       │   └ /api/* ルーティング
                                       ├ Gemini API       (OCR)
                                       ├ Cloud SQL keihi  (records)
                                       └ Cloud Storage    (画像)
```

ブラウザは `apps/config.js` の `window.API_BASE` を読んで Cloud Run 直叩き。
`config.js` は Cloud Build の `prep-config` ステップで生成される。

## なぜ Hosting の `/api/**` rewrite を使わないか

組織ポリシー `iam.allowedPolicyMemberDomains` が Firebase Hosting の Service Agent
(`gcp-sa-firebasehosting`) を IAM 登録から弾くため、通常の `Hosting /api/** → Cloud Run`
の rewrite が成立しない。代わりに Cloud Run を `allUsers` invoker で public 化し、
Express の `admin.auth().verifyIdToken()` が認証ゲートを担う。
**セキュリティは下がっていない**（認証は Express で必ず行われる）。

## API

| Method | Path | 説明 |
|---|---|---|
| GET | `/health` | 死活確認（認証不要） |
| POST | `/api/scan` | `{image, mimeType, sites:[]}` → 解析JSON |
| GET | `/api/records` | 一覧 |
| POST | `/api/records` | 登録 |
| DELETE | `/api/records/:id` | 削除 |

`/api/*` 全部 `Authorization: Bearer <Firebase ID Token>` 必須（`DEV=1` 時のみバイパス）。
`ALLOWED_EMAILS` env で許可メールを絞れる（空なら全認証済みユーザー許可）。

## ファイル構成

```
apps/keihi/
├── index.html          ← 経費 UI（HTML+CSS+JS）
├── README.md           ← これ
├── app.yaml            ← bootstrap が読むメタ
├── cloudbuild.yaml     ← デプロイ仕様（Docker→Cloud Run→Hosting）
├── server/             ← Cloud Run コード (Express)
│   ├── Dockerfile
│   ├── index.js
│   └── package.json
└── infra/
    └── schema.sql      ← Postgres スキーマ
```

Hosting 設定 (`firebase.json`) はプロジェクト root に。`public: "apps"` で
`apps/` 配下全体が配信され、`server/`・`infra/`・`cloudbuild.yaml`・
`*.md` は `ignore` で除外される。

## デプロイ

`apps/keihi/**` への push で Cloud Build トリガが自動発火。

cloudbuild.yaml の流れ：
1. **build** — Kaniko で `apps/keihi/server` を Docker build & push
2. **deploy** — Cloud Run `keihi-api` にデプロイ
3. **prep-config** — `allUsers` + `info@banax.tokyo` を invoker 化、Cloud Run URL を `apps/config.js` に注入
4. **ensure-hosting-site** — Hosting site `keihi-496002` を冪等に作成
5. **deploy-hosting** — `firebase deploy --only hosting`（プロジェクト root の `firebase.json` を使用）

### 手動 deploy（緊急時のみ）

`firebase deploy` 直接呼び出しは**禁止**（ローカル clone が古いと過去状態を本番に上書きするため）。手動 deploy は必ず以下のラッパー経由：

```bash
bash infra/deploy-hosting.sh
```

内部で `git fetch && git pull --ff-only origin main` してから `firebase deploy` する。

Cloud Run + Hosting 全体を再ビルドしたい場合：
```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

## ローカル実行

Cloud Shell で本番と同一構成プレビュー：
```bash
bash infra/dev.sh keihi
```

サーバ単体：
```bash
cd apps/keihi/server
npm install
GEMINI_API_KEY=... DEV=1 npm run dev
```

`DEV=1` で `verifyIdToken` バイパス、`req.user = { email: "dev@local" }` で素通り。

---

## 🚨 過去にハマったポイント（keihi 固有）

プロジェクト全体のインフラ系の罠（403 / iOS Safari ITP / Hosting rewrite が使えない理由 / 組織ポリシー）は **[DEPLOY.md §6](../../DEPLOY.md#6-過去にハマったポイント再発防止メモ)** に集約済。

ここには **keihi/Cloud Run 固有** のものだけ残す：

### A. Gemini API が「prepayment credits depleted」で 429

`/api/scan` が `[GoogleGenerativeAI Error] ... 429 Too Many Requests` を返す。AI Studio の prepay クレジット枯渇。

**対策**: どちらかで課金設定
- AI Studio: <https://ai.studio/projects>
- Cloud Console で billing アカウントを Generative Language API にリンク：
  <https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/metrics?project=static-epigram-496002-v8>

### B. `--set-env-vars` で `Bad syntax for dict arg: [konishi0221@gmail.com]`

`ALLOWED_EMAILS` 内のコンマが env var 区切り文字と衝突する。cloudbuild.yaml で `--set-env-vars=^||^...` で区切り文字を `||` に変更して回避済。新規環境変数で値にコンマを含めるときは同じ形式を維持すること。

### C. Gemini model が "no longer available to new users" で 404

`gemini-2.0-flash` などのモデル名は新規 billing アカウントでは無効化されている場合あり。`gemini-2.5-flash` を使う。サーバ側に retry + fallback（`gemini-2.5-flash-lite` → `gemini-flash-latest`）を実装済（`server/index.js` の `callGeminiWithFallback`）。

---

## 環境変数（Cloud Run）

| 変数 | 用途 |
|------|------|
| `GEMINI_API_KEY` | Gemini API キー（Secret Manager `gemini-api-key:latest`） |
| `GEMINI_MODEL` | デフォルト `gemini-2.5-flash` |
| `RECEIPTS_BUCKET` | レシート画像保存先バケット |
| `DB_USER` / `DB_NAME` / `DB_INSTANCE_CONNECTION_NAME` | Cloud SQL 接続 |
| `DB_PASSWORD` | Secret Manager `keihi-db-password:latest` |
| `FIREBASE_PROJECT_ID` | `verifyIdToken` のプロジェクト確認用 |
| `ALLOWED_EMAILS` | カンマ区切り。空なら全認証済みユーザー許可 |
| `DEV` | `1` で認証バイパス（Cloud Shell プレビュー専用） |

## 残課題

- [ ] `index.html` の `renderList()` で XSS 残り（`innerHTML` 直接代入）
- [ ] 記録の編集機能
- [ ] メモ欄
- [ ] 購入者を設定で変更可能に
