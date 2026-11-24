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

## MCP (`keihi_*`): 画面を開かずにチャットで経費を済ませる

チャットに領収書の画像を貼れば、AI が読んで登録まで終わらせる。統合コネクタ (`/api/mcp/<token>`) と、人ごとの genba の URL (`/api/genba/mcp/<token>`) の両方に載る。**購入者は呼び出したトークンの持ち主**で自動で入る (統合コネクタ = 小西。名取は名取用の URL)。実装は `server/expense-lib/index.js`、テストは `server/expense-lib/expense.test.mjs`。

**新しい登録の仕組みは作っていない。画面が通る処理をそのまま通す**: DB は `records` への同じ INSERT / UPDATE / DELETE、写真は GCS の `<今日>/<uuid>.jpg` (長辺 1200px・JPEG 品質 70 に縮小。`/api/scan` と同じ場所と形)、シートは `appendRecordToSheet` (経費記録スプレッドシートの月別タブ + 取引シート。写真セルは 🧾 → `?view=ID`)。`/api/records*` と `/api/scan` の GCS 保存も `expense-lib` の同じ関数を呼ぶ。OCR はサーバーでしない (AI が画像を読んで項目を埋めて渡す。Gemini を通さない)。

| ツール | 画面でできること |
|---|---|
| `keihi_receipt_add` | 撮影 → 確認 → 登録 (最大 30 件を 1 回で。重複は `duplicate: true` + 既存 ID、`force=true` で強制。返り値 = ID・閲覧 URL・シートのタブ名) |
| `keihi_receipt_upload_url` | 写真の渡し方 ①: 署名付き URL に `curl -X PUT` → `photo_ref` (6 時間有効。`PUT /api/keihi/upload/:token`、認証なし・署名で守る) |
| (`keihi_receipt_add` の `photo_base64`) | 写真の渡し方 ②: 外の URL に出られない環境の予備 (1 枚数 MB まで) |
| `keihi_receipt_hints` | 同じ店の過去の登録の傾向 (費目・工種・現場・支払方法) と選択肢・現場の一覧 |
| `keihi_receipt_list` / `keihi_receipt_get` | 「記録」画面 (現場・月などで絞った合計と件数つき) |
| `keihi_receipt_summary` | 合計・件数を 月 / 現場 / 費目 / 工種 / 支払方法 / 購入者 / 店舗 で集計 |
| `keihi_receipt_update` | 「記録を編集」 (渡した項目だけ変わる。写真の付け替えは AI 経由の追加機能) |
| `keihi_receipt_delete` | 「×」 (DB の行だけ消える。人に確認して `confirm=true`) |
| `keihi_receipt_photo` | 🧾 (10 分有効の閲覧 URL + 画像そのもの) |
| `keihi_receipt_export_csv` | 「CSV」 (同じ列・BOM つき) |
| `keihi_receipt_sheet_sync` | シートへの書き出し直し (シートに無い記録だけ足す。あれば行を DB の今の内容に合わせる。`dry_run` 可) |
| `keihi_receipt_sheet_dedupe` | シートに同じ記録の行が重複して入ってしまっている所を探して整理する (既定は探すだけ。下の「重複行の整理」を参照)。DB に同じ記録が複数ある所 (`db_duplicates`) も読むだけで出す |
| `keihi_sites` | 現場ボタンの一覧 (進行中が先。「共通」「会社」も現場) |

- 選択肢 (費目・工種・支払方法・購入者) は `index.html` の `<select>` / ボタンと同じ (テストで画面の HTML と突き合わせている)。「工具」「交際費」「PayPay」などの言い換えは画面の選択肢に寄せる
- 現場名は `genba_find` と同じ検索 (表記ゆれ・一部でも可)。見つからない / 複数ならエラーで返る
- **シートは 1 記録 = 1 行** (`server/expense-lib/sheets.js`): 登録・編集のたびに、記録の ID で今ある行を探して、あれば**その行を書き換え**、無ければ追記する (月別タブ = 写真セルの `?view=ID` か Drive の URL / 取引シート = ソース「領収書」+ 元 ID)。保存や現場ボタンを何回押しても行は増えない。以前は登録・編集のたびに「追記」していて、押した回数ぶん行が増えた (取引シートの重複防止もサーバーのメモリの中だけで、再起動で消えた)。同じ ID の保存は順番に処理する。シートを読めなかったときは追記しない。編集で購入日の月が変わったら、前の月のタブの行は新しい月に移す
- 登録 (`POST /api/records`) も、同じ写真・日付・店舗・金額・購入者がすでにあれば新しい記録を作らずその記録を返す (登録ボタンの連打・再送で増えない)
- **重複行の整理** (これまでの連打・再保存で増えてしまった分。`expense-lib/sheets.js` の `findDuplicates` / `removeDuplicates`、`index.js` の `dedupeRecordSheets`): 会計のシートの行を消すので、安全側に倒している
  - 同じ記録かどうか = 月別タブは写真セルの `?view=ID` (Drive の写真は Drive の URL + 購入日 + 店舗 + 金額。**1 枚の写真に別々の領収書が写っているものは URL が同じでも別の記録**) / 取引シートはソース=領収書 + 元 ID。宿など領収書以外の行は対象外
  - **中身が完全に同じ行**は、消しても情報が減らないので、新しい版を最初に使ったリクエスト (`keihi_*` のどれか) の中で**自動で 1 回だけ**消す (印 = `genba_settings` の `sheet_dedupe_v1`。複数インスタンスでも 1 つだけが走る。止まったら 3 分後に引き継ぐ。失敗は最大 4 回)
  - **中身が違う重複** (保存の合間に編集した古い版)・**購入日の月を直した古い行** (別の月のタブ) は自動では消さない。`keihi_receipt_sheet_dedupe` で数と場所を見て、確認してから `apply=true` (一番下 = 最後に書かれた行を残す。月をまたぐものは DB の今の月のタブを残す。消したあと残した行を DB の今の内容に合わせる)
  - **消す行は必ず先に「重複削除ログ」タブにコピー** (月別タブのスプレッドシート・取引シートそれぞれの中。日時・元のタブ・元の行・理由・残した行・中身)。コピーに失敗したら消さない。ログの行を元のタブの末尾に貼れば戻せる
  - 消す直前に、その行がまだ探したときと同じ中身か読み直す (違えば消さない = `skipped_changed`)。1 つのタブの半分以上 (小さいタブは 5 行まで) を消す計画は止める (`capped`)
  - 消すのは Google スプレッドシートの行だけ (記録 = DB は消さない)。DB の重複は `db_duplicates` に出るだけ
- 画面と同じ挙動 (そのまま): 削除はシートの行と写真を消さない (消した記録を「元に戻す」と、新しい ID で入り直すので、古い行が残る)
- 現場の追加・編集は経費アプリでなく現場アプリ (`genba_register`)。経費アプリの「スプレッドシート連携」(Apps Script の URL を端末に保存) は端末ごとの旧機能で、サーバーが同じことを常にやるので MCP には無い
- テスト: `ln -s <scratch>/node_modules apps/keihi/server/node_modules` (sharp) してから `PGLITE_PATH=… node apps/keihi/server/expense-lib/expense.test.mjs`

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
