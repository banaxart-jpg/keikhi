# keihi — 経費管理アプリ

レシートをスマホで撮影 → Gemini で OCR → 編集して Cloud SQL に保存。
モバイルWebアプリ。フロントは Firebase Hosting、バックエンドは Cloud Run。

## 構成

```
[iPhone/Android Browser]
        │
        ├─── 静的ファイル受け取り ──▶ Firebase Hosting
        │                              keihi-496002.web.app
        │                              ├ web/index.html         (ランチャー)
        │                              ├ web/keihi/index.html   (経費アプリ)
        │                              └ web/config.js          (Cloud Run URL注入済)
        │
        └─── /api/* 直接呼び出し ─────▶ Cloud Run keihi-api (直URL)
              Authorization: Bearer    https://keihi-api-734350696397.asia-northeast1.run.app
              <Firebase ID Token>      │
                                       ├ Express
                                       │   ├ verifyIdToken (Firebase Admin SDK)
                                       │   └ /api/* ルーティング
                                       │
                                       ├ Gemini API       (OCR)
                                       ├ Cloud SQL keihi  (records)
                                       └ Cloud Storage    (画像)
```

## なぜ Cloud Run か

Firebase Hosting は静的ファイル配信のみ。以下が要るので Cloud Run（or 同等のサーバ実行基盤）が必要：
- **Gemini API キー** をブラウザに露出させずに使う（OCR）
- **Cloud SQL Postgres** への書き込み
- **Cloud Storage** へのアップロード
- Firebase Admin SDK で `verifyIdToken` 実行

## なぜ Hosting の `/api/**` rewrite を使ってないか（重要）

通常 Firebase + Cloud Run の構成は `Hosting /api/** → Cloud Run` の同一オリジン rewrite だが、**このプロジェクトでは使えない**。

組織ポリシー `iam.allowedPolicyMemberDomains` がデフォルトで `banax.tokyo` ドメインのみ許可しており、Firebase Hosting のサービスエージェント
`service-<PROJECT_NUMBER>@gcp-sa-firebasehosting.iam.gserviceaccount.com`
（= `gcp-sa-firebasehosting` ドメイン）を IAM に追加できない。SA が IAM に登録されない → Hosting が Cloud Run を呼ぶ権限を持てない → 全 rewrite が 403 Forbidden になる。

そこでこのプロジェクトは：
- **Cloud Run を `allUsers` invoker で public 化** （誰でも到達できる）
- **Express 側の `admin.auth().verifyIdToken()`** が認証ゲート（実質的なセキュリティ）
- ブラウザは **Cloud Run URL を直接 fetch**（CORS allow `*`）

→ Hosting rewrite が動かない代替手段。**セキュリティは下がっていない**（認証は Express で必ず行われる）。

## API

| Method | Path                | 説明                                     |
|--------|---------------------|-----------------------------------------|
| GET    | `/health`           | 死活確認（認証不要）                      |
| POST   | `/api/scan`         | `{image, mimeType, sites:[]}` → 解析JSON |
| GET    | `/api/records`      | 一覧                                     |
| POST   | `/api/records`      | 登録                                     |
| DELETE | `/api/records/:id`  | 削除                                     |

`/api/*` 全部 `Authorization: Bearer <Firebase ID Token>` 必須（`DEV=1` 時のみバイパス）。
`ALLOWED_EMAILS` env で許可メールを絞れる（空なら全認証済みユーザー許可）。

## デプロイ

`apps/keihi/**` 配下の変更を `main` に push すれば Cloud Build トリガが自動デプロイ。

```
コード修正 → main に push → Cloud Build → Cloud Run + Firebase Hosting 反映
```

cloudbuild.yaml の流れ（後述のステップは全部冪等）：

1. **build** — Kaniko で `server/` を Docker build & push（差分キャッシュ）
2. **deploy** — Cloud Run `keihi-api` にデプロイ
3. **prep-config** — Cloud Run を `allUsers` + `info@banax.tokyo` で invoker 化、
   `gcloud run services describe` で URL 取得 → `web/config.js` に注入
4. **ensure-hosting-site** — Hosting site `keihi-496002` を冪等に作成
5. **deploy-hosting** — `firebase deploy --only hosting`

手動再デプロイ:
```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

緊急時の Hosting だけ手動デプロイ（Cloud Shell）:
```bash
cd apps/keihi
RUN_URL=$(gcloud run services describe keihi-api --region=asia-northeast1 --format='value(status.url)')
echo "window.API_BASE='$RUN_URL';" > web/config.js
firebase deploy --only hosting --project=static-epigram-496002-v8
```

## ローカル実行

Cloud Shell で本番と同一構成プレビュー：
```bash
bash infra/dev.sh keihi   # /__/firebase/init.json も配信、/api 同一オリジン
```

サーバ単体（OCR テストだけ）:
```bash
cd apps/keihi/server
npm install
GEMINI_API_KEY=... DEV=1 npm run dev
```

`DEV=1` で `verifyIdToken` バイパス、`req.user = { email: "dev@local" }` で素通り。

---

## 🚨 過去にハマったポイント（再発防止メモ）

### 1. `/api/*` が 403 Forbidden（Google 標準HTML）を返す

**症状**: ブラウザの Network タブで `/api/records` が 403、レスポンスが
`<h1>Error: Forbidden</h1>` 形式の HTML。

**原因**: Cloud Run の IAM から `allUsers` invoker が消えている、または
組織ポリシーが再有効化されてる。

**確認**:
```bash
gcloud run services get-iam-policy keihi-api \
  --region=asia-northeast1 --project=static-epigram-496002-v8
```
`allUsers - roles/run.invoker` の行が無ければそれ。

**修正**:
```bash
gcloud run services add-iam-policy-binding keihi-api \
  --region=asia-northeast1 --project=static-epigram-496002-v8 \
  --member=allUsers --role=roles/run.invoker
```

もし `FAILED_PRECONDITION: ... permitted customer` で蹴られたら組織ポリシーが復活している：
```bash
# 確認
gcloud org-policies describe iam.allowedPolicyMemberDomains \
  --project=static-epigram-496002-v8 --effective

# 上書き（要 roles/orgpolicy.policyAdmin — info@banax.tokyo は保持済）
cat > /tmp/policy.yaml <<'EOF'
name: projects/static-epigram-496002-v8/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
    - allowAll: true
EOF
gcloud org-policies set-policy /tmp/policy.yaml
sleep 180   # 反映に最大7分かかる（30秒では足りない）
```

### 2. iOS Safari で経費画面に飛ぶと「セッション期限切れ」/再ログイン要求

**症状**: iPhone でログイン後、ランチャーから「💴 経費」を押すと
ログイン画面に戻される or「セッション期限切れ」と出る。

**原因**: iOS Safari ITP が、Firebase Auth デフォルトの authDomain
`keihi-496002.firebaseapp.com` のストレージを「クロスサイト」と判定して
数日で消す。Hosting (`keihi-496002.web.app`) と異なるドメインだから。

**対策**（既に組み込み済み）: `web/index.html` と `web/keihi/index.html`
両方で `cfg.authDomain = location.hostname` を設定。これで認証フロー全体が
Hosting と同一オリジン (`keihi-496002.web.app`) 内に閉じる。

**注意**: この設定変更には **Google Cloud Console の OAuth クライアントに
リダイレクトURIの登録が必要**：
```
https://keihi-496002.web.app/__/auth/handler
```
登録場所: Cloud Console → APIs & Services → Credentials →
「Web client (auto created by Google Service)」→ 承認済みリダイレクトURI

無効だと `redirect_uri_mismatch` で蹴られる（Google のログイン画面で
「アクセスをブロック: このアプリのリクエストは無効です」が出る）。

### 3. Firebase Hosting の Cloud Run rewrite は機能しない（誘惑回避）

`firebase.json` に `/api/** → run` の rewrite を追加してデプロイすると
一見動きそうに見えるが、リクエストすると 403 が返る。理由は §1 の
組織ポリシーで Firebase Hosting SA が IAM に登録できないため。

無理に動かすには：
- 組織ポリシーに `gcp-sa-firebasehosting` ドメインの例外許可を追加（複雑）
- あるいは組織から脱退（さらに面倒）

現状の Cloud Run 直叩き構成を維持するのが正解。

### 4. Gemini API が「prepayment credits depleted」で 429

**症状**: `/api/scan` が `[GoogleGenerativeAI Error] ... 429 Too Many Requests`、
`Your prepayment credits are depleted` のメッセージ。

**原因**: AI Studio の prepay クレジット枯渇。

**対策**: 以下のどちらか
- AI Studio で課金設定: <https://ai.studio/projects>
- もしくは Google Cloud の billing アカウントを Generative Language API に
  リンクすれば prepay 関係なく従量課金で動く:
  <https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/metrics?project=static-epigram-496002-v8>

### 5. CORS preflight (OPTIONS) で失敗

Express は `*` 全許可（`server/index.js` 32-37行）。OPTIONS は 204 で
即返している。失敗してたら Cloud Run のプロセス自体が落ちているので、
Cloud Run のログを確認：

<https://console.cloud.google.com/run/detail/asia-northeast1/keihi-api/logs?project=static-epigram-496002-v8>

---

## 環境変数（Cloud Run）

| 変数 | 用途 |
|------|------|
| `GEMINI_API_KEY` | Gemini API キー（Secret Manager `gemini-api-key:latest`） |
| `GEMINI_MODEL` | デフォルト `gemini-2.0-flash` |
| `RECEIPTS_BUCKET` | レシート画像保存先バケット |
| `DB_USER` / `DB_NAME` / `DB_INSTANCE_CONNECTION_NAME` | Cloud SQL 接続 |
| `DB_PASSWORD` | Secret Manager `keihi-db-password:latest` |
| `FIREBASE_PROJECT_ID` | `verifyIdToken` のプロジェクト確認用 |
| `ALLOWED_EMAILS` | カンマ区切り。空なら全認証済みユーザー許可 |
| `DEV` | `1` で認証バイパス（Cloud Shell プレビュー専用） |

## 残課題

- [ ] `web/keihi/index.html` の `renderList()` で XSS 残り（`innerHTML` 直接代入）
- [ ] 記録の編集機能
- [ ] メモ欄
- [ ] 購入者を設定で変更可能に
