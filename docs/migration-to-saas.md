# keihi → claude-studio 移植手順書

新リポ（`claude-studio` 想定）の立ち上げ時、Claude Code にこのドキュメントを読ませて作業させる用の指示書。

## 前提条件

- 新規 private リポ `claude-studio` (or `banax-studio`) を GitHub Organization に作成済み
- 新リポを `git clone` 済み
- このリポ (`keikhi`) も同じマシンに clone してあって、参照可能
- Claude Code を新リポ側で起動

## 新リポでの最初の Claude Code 依頼文（コピペ用）

```
keihi リポ (../keikhi) を参考に、SaaS テンプレートとして claude-studio リポを構築して。
詳細手順は ../keikhi/docs/migration-to-saas.md を読んでから始めること。

最終的に欲しい構成：
- template/ : ユーザーが fork する想定のテンプレ部分（keihi をサニタイズしたもの）
- wizard/   : Wizard Web アプリ（Next.js + Cloud Run、後で実装）
- docs/     : 設計ドキュメント（saas-draft-v1.md をここに移動）
- README.md : 運営側用のリポ説明

template/ の中身は以下のルールで keihi から複製・改変する：
1. 個人情報・固有名詞を変数化（後述）
2. 業務固有アプリ（kaigi, seikyu, keihi2 等）は除外、汎用サンプルだけ残す
3. CLAUDE.md は §7 チェックリストと §2 名取プロフィールを削除、テンプレ用に汎用化
4. README.md / DEPLOY.md は新規ユーザー向けに書き直し

詳細は移植手順書を読んで判断して。
```

---

## 1. リポ初期構造

```
claude-studio/
├── README.md                    # 運営側用（このリポは何か）
├── LICENSE                      # MIT or Apache 2.0
├── .gitignore
├── template/                    # ユーザーが fork するテンプレ
│   ├── apps/
│   │   ├── index.html           # ランチャー（汎用化）
│   │   ├── config.js            # API_BASE プレースホルダ
│   │   ├── sample/              # 「最小サンプルアプリ」1つだけ同梱
│   │   │   ├── index.html
│   │   │   ├── README.md
│   │   │   ├── server/
│   │   │   ├── infra/
│   │   │   └── cloudbuild.yaml
│   │   └── _examples/           # README で紹介する追加サンプル（コメントアウトで同梱）
│   ├── infra/
│   │   ├── bootstrap.sh         # 汎用化版
│   │   ├── db.sh
│   │   └── deploy-hosting.sh
│   ├── firebase.json
│   ├── CLAUDE.md                # テンプレ版（個人情報削除、汎用ルール）
│   ├── DEPLOY.md                # テンプレ版
│   └── README.md                # 新規ユーザー向けスタートガイド
├── wizard/                      # Phase 1 で実装、最初は空でOK
│   └── README.md
└── docs/
    ├── saas-draft-v1.md         # ../keikhi/docs/saas-draft-v1.md を移動
    └── migration-to-saas.md     # このドキュメント
```

---

## 2. サニタイズ対象（必ず全て変数化 or 削除）

### 個人情報 / 固有名詞（grep して全置換）

| 元の値 | テンプレでの扱い |
|---|---|
| `info@banax.tokyo` | `<OWNER_EMAIL>` プレースホルダ |
| `konishi0221@gmail.com` | 削除 |
| `banaxart@gmail.com` | 削除 |
| `static-epigram-496002-v8` (GCP project ID) | `<PROJECT_ID>` |
| `keikhi-db` (Cloud SQL インスタンス) | `<DB_INSTANCE>` |
| `keihi-496002` (Hosting site) | `<HOSTING_SITE>` |
| `keihi-api` (Cloud Run service) | `<APP>-api` |
| `keikhi` (Artifact Registry / GitHub リポ名) | `<REPO_NAME>` |
| `banaxart-jpg/keikhi` (GitHub owner/repo) | `<GITHUB_OWNER>/<REPO_NAME>` |
| `BANAX`, `banax`, `BANAX OS` などの固有名詞 | 削除 or 一般化 |
| `名取`, `楓`, `小西` 等の人名 | 全削除 |
| `西新井焼肉屋`, `宇佐美別荘`, `倉庫改装`, `共通` (sites テーブルの初期値) | サンプル名（"現場A", "現場B"）or 空 |
| `keihi-run`, `admin-run`, `denki-zumen-run` (SA 名) | `<APP>-run` |

### 業務アプリ（テンプレからは除外）

`template/apps/` に含めないアプリ：
- `keihi/` 経費（業務固有過ぎる）
- `keihi2/` 経費2（業務固有）
- `kaigi/` AI 会議（残してもいい、ただし sample 扱い）
- `seikyu/` 請求書（業務固有）
- `cost/` AI コスト計算（残してもいい、認証だけのシンプル例として）
- `admin/` 管理ダッシュボード（除外）
- `denki-zumen/` 電気図面（除外）

→ **最小サンプル**として、認証 + API 呼び出し + DB 書き込みの「Hello World 級」アプリを 1 個だけ新規作成して `template/apps/sample/` に入れる。

### CLAUDE.md からの削除対象

現 `CLAUDE.md` で以下のセクションは**テンプレ化時に削除**：

- §2 名取という人物（プロフィール全部）
- §3 名取モード（デフォルト）の振る舞い原則
- §5 小西用語辞書（社内向け）
- §7 名取の IT 習得チェックリスト（系統A・B 全部）— ※ 別商品化する想定なので別ファイルへ
- §9 他リポジトリとの関係（BANAX OS）
- §10 自己チェック（名取モード前提）

**残すセクション**（汎用ルールとして使える）:
- §0 セッション開始時の標準動作（fetch / pull の徹底）
- §0 push 前の衝突チェックルーチン
- §4 「小西モード」→「オーナーモード」と一般化して残す
- §6 スマホ運用前提（一般化）
- §8 触っちゃダメリスト（テンプレ用に書き直し、固有名詞除去）

### README.md / DEPLOY.md の書き直し

- 全 URL を `<PROJECT_ID>` プレースホルダ化
- 「BANAX」「名取」「楓」等の固有名詞削除
- 「初回セットアップ」を実際に動く形でステップ化
- 「Claude Code に依頼する時の定型句」セクションは残す

---

## 3. 汎用化対象（bootstrap.sh 等）

### `infra/bootstrap.sh`

現状はハードコードされた値が多数。以下を引数 or 環境変数化：

```bash
# 引数で受け取る（or env から読む）
PROJECT_ID="${PROJECT_ID:?required}"          # ユーザーの GCP プロジェクト
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:?required}"
REGION="${REGION:-asia-northeast1}"
HOSTING_SITE="${HOSTING_SITE:-${PROJECT_ID}-app}"
APP_NAME="${APP_NAME:-sample}"                # 最初のサンプルアプリ名
GITHUB_OWNER="${GITHUB_OWNER:?required}"
GITHUB_REPO="${GITHUB_REPO:?required}"
OWNER_EMAIL="${OWNER_EMAIL:?required}"        # ALLOWED_EMAILS の初期値
```

### `apps/<APP>/cloudbuild.yaml`

substitutions を全て変数化（既にやられてる部分も多いが、ハードコード残りを排除）：

```yaml
substitutions:
  _APP: sample              # アプリ名（テンプレでは sample）
  _REGION: asia-northeast1
  _SERVICE: ${_APP}-api
  _REPO: ${_APP}            # Artifact Registry リポ名
  _SA: ${_APP}-run
  _DB_INSTANCE: ${_APP}-db
  _DB_NAME: ${_APP}
  _BUCKET_SUFFIX: ${_APP}-receipts
  _INVOKER: user:${_OWNER_EMAIL}
  _ALLOWED_EMAILS: ${_OWNER_EMAIL}
  _HOSTING_SITE: ${_HOSTING_SITE}
```

`<OWNER_EMAIL>` 等のプレースホルダは bootstrap.sh で sed 置換しても OK、もしくは env から流し込む構成にする。

### `apps/<APP>/server/index.js`

特定アプリ固有のロジック（受領書 OCR、kaigi の議論、seikyu の請求書 OCR 等）は**全部削除**して、サンプル用に最小限の API だけ残す：

```js
// テンプレに残す最小 API
app.get("/health", ...)           // ヘルスチェック
app.use("/api", authMiddleware)   // Firebase Auth 認証
app.get("/api/records", ...)      // GET ダミー
app.post("/api/records", ...)     // POST ダミー
app.delete("/api/records/:id", ...) // DELETE ダミー
```

LLM 連携の `callByProvider` 関数も**汎用ヘルパー**として残してよい（OCR や複数 LLM 切替の参考実装として）。

### `apps/<APP>/infra/schema.sql`

最小限の `records` テーブル例だけ残す：

```sql
CREATE TABLE IF NOT EXISTS records (
  id BIGSERIAL PRIMARY KEY,
  user_email TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_user_idx ON records (user_email, created_at DESC);
```

業務固有テーブル（kaigi_sessions, kaigi_messages 等）は**削除**。

---

## 4. 移植作業のステップ（Claude Code への指示）

### Step 1: ファイルコピー（除外しながら）

```bash
# 新リポ ./claude-studio/template/ に keihi の中身を選択コピー
mkdir -p template/{apps,infra,docs}

# Copy: apps の中で残すもの
cp -r ../keikhi/apps/index.html       template/apps/
cp -r ../keikhi/apps/config.js        template/apps/
# サンプルアプリ用に新規作成 (keihi/cost/kaigi を参考に最小実装)
# → 既存 cost を sample にリネームしてコピーが楽

# Copy: インフラスクリプト
cp -r ../keikhi/infra/                template/infra/

# Copy: ルート設定
cp ../keikhi/firebase.json            template/
cp ../keikhi/.gitignore               template/

# Copy: ドキュメント（書き直し前提）
cp ../keikhi/README.md                template/README.md.original
cp ../keikhi/DEPLOY.md                template/DEPLOY.md.original
cp ../keikhi/CLAUDE.md                template/CLAUDE.md.original
```

### Step 2: サニタイズ（grep + sed）

```bash
# 個人情報の grep（事前確認用）
cd template
grep -rE 'info@banax\.tokyo|konishi0221|banaxart|static-epigram-496002-v8|keikhi-db|keihi-496002|banaxart-jpg|名取|楓|小西|西新井焼肉屋|宇佐美別荘|倉庫改装' .

# 置換実行（要バックアップ）
find . -type f \( -name "*.md" -o -name "*.yaml" -o -name "*.sh" -o -name "*.js" -o -name "*.html" -o -name "*.sql" \) \
  -exec sed -i \
  -e 's/info@banax\.tokyo/<OWNER_EMAIL>/g' \
  -e 's/static-epigram-496002-v8/<PROJECT_ID>/g' \
  -e 's/keikhi-db/<DB_INSTANCE>/g' \
  -e 's/keihi-496002/<HOSTING_SITE>/g' \
  -e 's/banaxart-jpg\/keikhi/<GITHUB_OWNER>\/<REPO_NAME>/g' \
  -e 's/keihi-run/<APP>-run/g' \
  {} \;
```

Claude Code は手作業で 1 ファイルずつ Edit する方が確実（sed が壊す可能性ある）。

### Step 3: CLAUDE.md / README.md / DEPLOY.md の書き直し

`.original` ファイルを参考に、テンプレ用に書き直し：
- 名取・楓・小西への言及全削除
- BANAX 固有の業務内容削除
- 育成チェックリストは `docs/learner-tracker-template.md` に別出し（将来商品化用）
- `<OWNER_EMAIL>`, `<PROJECT_ID>` 等のプレースホルダ説明を README 冒頭に追加

### Step 4: bootstrap.sh の汎用化

`infra/bootstrap.sh` を読み込んで、ハードコードを引数化。Claude Code に：

> bootstrap.sh を読んで、ハードコードされてる固有名詞（プロジェクト ID、メアド、リポ名、サービス名）を全て環境変数化または引数化して。引数は冒頭でバリデーション、`?required` で必須チェック。冒頭に Usage を出力する関数追加。

### Step 5: docs ファイルを移動

```bash
cp ../keikhi/docs/saas-draft-v1.md docs/
cp ../keikhi/docs/migration-to-saas.md docs/
```

### Step 6: 初回 commit

```bash
git add .
git commit -m "Initial commit: keihi リポをサニタイズして claude-studio テンプレ化"
git push origin main
```

### Step 7: 動作確認

別 GCP プロジェクトを作って、新リポの `template/infra/bootstrap.sh` を叩いて全環境が立ち上がるか確認。問題なければ Phase 0 完了。

---

## 5. Wizard 側の初期構造（Phase 1 で実装）

`wizard/` ディレクトリは Phase 0 では空でいい。Phase 1 開始時に Claude Code に以下を依頼：

```
wizard/ ディレクトリに Next.js 14 (App Router) の Web アプリを作って。
構成:
- pages: /, /signup, /setup/[step], /done
- backend: Cloud Run で Express server, gcloud SDK と GitHub API を叩く
- UI: フォーム入力 → 進捗バー → 完了画面
- 認証: Firebase Auth (Google) + GCP OAuth
詳細は docs/saas-draft-v1.md §3-2, §4-2 を参照。
```

---

## 6. 残課題（移植後に詰める）

- [ ] 個人情報の grep 漏れチェック（CI で grep 自動化推奨）
- [ ] `template/` の中身だけで本当に動くか別 GCP プロジェクトで動作確認
- [ ] LICENSE 決定（MIT / Apache 2.0 推奨）
- [ ] `claude-studio` という名前で商標調査
- [ ] LP ドメイン取得（claude-studio.jp / vibe-stack.jp 等の空き確認）
- [ ] CLAUDE.md の学習チェックリストを別商品化するかの判断
- [ ] 元 keihi リポへの依存切り（このドキュメント自体も移動）

---

## 7. 移植後の運用ルール

- 元の keihi リポ（このリポ）は **BANAX 内部の業務利用 + 楓ちゃんの学習場**として維持
- 新 claude-studio リポは**製品**として独立運用
- 元 keihi で出来た改善（プロンプト・ハマりポイント・UI 改善等）を新リポに反映するための **シンク手順**を別途用意（手動 or 半自動）
- 楓ちゃんが claude-studio リポを触る必要は基本ない（テンプレを使う側だが、新リポ自体は触らない）
