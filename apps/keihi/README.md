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

## デプロイ

`apps/keihi/**` への push で Cloud Build トリガが自動発火。

cloudbuild.yaml の流れ：
1. **build** — Kaniko で `apps/keihi/server` を Docker build & push
2. **deploy** — Cloud Run `keihi-api` にデプロイ
3. **prep-config** — `allUsers` + `info@banax.tokyo` を invoker 化、Cloud Run URL を `apps/config.js` に注入
4. **ensure-hosting-site** — Hosting site `keihi-496002` を冪等に作成
5. **deploy-hosting** — `firebase deploy --only hosting`（プロジェクト root の `firebase.json` を使用）

手動再デプロイ：
```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

緊急時の Hosting だけ手動デプロイ（Cloud Shell）：
```bash
RUN_URL=$(gcloud run services describe keihi-api --region=asia-northeast1 --format='value(status.url)')
echo "window.API_BASE='$RUN_URL';" > apps/config.js
firebase deploy --only hosting --project=static-epigram-496002-v8
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

## 🚨 過去にハマったポイント（再発防止メモ）

### 1. `/api/*` が 403 Forbidden（Google 標準HTML）を返す

**症状**: Network タブで `/api/records` が 403、レスポンスが
`<h1>Error: Forbidden</h1>` 形式の HTML。

**原因**: Cloud Run の IAM から `allUsers` invoker が消えている、または
組織ポリシーが再有効化された。

**確認**:
```bash
gcloud run services get-iam-policy keihi-api \
  --region=asia-northeast1 --project=static-epigram-496002-v8
```

**修正**:
```bash
gcloud run services add-iam-policy-binding keihi-api \
  --region=asia-northeast1 --project=static-epigram-496002-v8 \
  --member=allUsers --role=roles/run.invoker
```

組織ポリシーが復活している場合：
```bash
cat > /tmp/policy.yaml <<'EOF'
name: projects/static-epigram-496002-v8/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
    - allowAll: true
EOF
gcloud org-policies set-policy /tmp/policy.yaml
sleep 180   # 反映に最大7分
```

### 2. iOS Safari で経費画面に遷移すると「セッション期限切れ」

**原因**: iOS Safari ITP が Firebase Auth デフォルトの `authDomain`
(`keihi-496002.firebaseapp.com`) のストレージを「クロスサイト」判定で消す。

**対策**: `apps/keihi/index.html`（と `apps/index.html`）で
`cfg.authDomain = location.hostname` を設定。
認証フローを Hosting と同一オリジン (`keihi-496002.web.app`) に閉じる。

**前提**: Cloud Console の OAuth クライアントに
`https://keihi-496002.web.app/__/auth/handler` をリダイレクトURIとして手動登録済。

### 3. Firebase Hosting の Cloud Run rewrite は機能しない

`firebase.json` に `/api/** → run` の rewrite を追加すると 403 になる。
組織ポリシーで Firebase Hosting SA が IAM 登録できないため。
**Cloud Run 直叩き構成を維持するのが正解。**

### 4. Gemini API が「prepayment credits depleted」で 429

**対策**:
- AI Studio で課金設定：<https://ai.studio/projects>
- もしくは Cloud Console で billing アカウントを Generative Language API にリンク：
  <https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/metrics?project=static-epigram-496002-v8>

### 5. `--set-env-vars` で `Bad syntax for dict arg`

`ALLOWED_EMAILS` 内のコンマが env var 区切り文字と衝突する。
cloudbuild.yaml で `--set-env-vars=^||^...` で区切り文字を `||` に変更して回避済。

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
