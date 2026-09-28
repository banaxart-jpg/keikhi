# SNS 発信 MCP（`/api/sns/mcp/<token>`）

X / note の投稿と、過去投稿・数字の記録だけを持つ薄い MCP。claude.ai のカスタムコネクタから使う。
文面づくり・口調・NG ルール・分析は各自の Claude（プロジェクト指示）側でやる。画面は持たない。

- 運用中アカウント: `kenchiku`（X `@kenchiku_ch`「建築CH」）。**社名は出さない匿名アカウント**として豆知識を発信。
  伸びたら社名に切り替える予定（アカウント名 `kenchiku` は内部キーなので、X の表示名を変えても設定は handle を直すだけ）
- 次は KTERAS をアカウント追加で載せる想定（`sns-config` に 1 アカウント + トークン追加）

## ツール

| ツール | 中身 | 課金 |
|---|---|---|
| `sns_accounts` | 使えるアカウントと設定状況 | なし |
| `x_post` | X に即時投稿（URL 入りは `allow_link: true` 必須） | $0.015/本、URL 入り $0.20/本 |
| `x_delete` | X の投稿を削除 | なし |
| `x_list` | 過去投稿を DB から（`refresh: true` で X から取り込み直し） | refresh 時 読み取り $0.005/件 |
| `note_draft` | note 記事の下書きを DB に保存（note へは手で貼る） | なし |
| `note_list` | note の公開記事（RSS から取り込み）+ 下書き | なし |
| `sns_stats` | 記録済みの数字の時系列（伸び率はチャット側で計算） | なし |
| `sns_snapshot` | 今の数字をすぐ記録 | 読み取り課金 |

note の自動投稿（headless）は未実装。keihi-api に Chromium を載せると他アプリまで巻き添えで落ちるので、
やるなら別 Cloud Run サービスで。

## DB（Cloud SQL keikhi-db / keihi、初回アクセス時に自動作成）

- `sns_posts` — 投稿・下書き（account / platform / external_id / status / title / body / url / posted_at）
- `sns_post_stats` — 投稿ごとの数字を**記録した時点の値で積み上げ**（表示・いいね・RP・返信・引用・ブックマーク）
- `sns_account_stats` — アカウントの日ごとのフォロワー数など

毎朝の記録: X は投稿後 7 日間は毎日、30 日までは週 1 回だけ数字を取る（読み取り課金を抑える）。

## セットアップ（Cloud Shell で 1 回だけ）

リポは public なので、**トークン・API キーは Secret Manager の `sns-config` にだけ置く**。
コード・env・cloudbuild.yaml には書かない（`--set-secrets` にも載せない。実行時に REST で読む）。
`sns-config` が無い / 読めない間は MCP が 403 を返すだけで、他アプリには影響しない。

### 1. X の API キー

1. developer.x.com に `@kenchiku_ch` でログイン → アプリ作成 → クレジットを購入（従量課金）
2. User authentication settings で **App permissions = Read and write** にする
   （**アクセストークン発行より先に**。後から変えたらトークンを再発行）
3. Keys and tokens で API Key / Secret（= consumer）と Access Token / Secret を発行

### 2. `sns-config` を作る

```bash
TOKEN=$(openssl rand -hex 24); echo "$TOKEN"   # コネクタ URL に使う。控えておく
cat > /tmp/sns-config.json <<EOF
{
  "tokens": { "$TOKEN": ["kenchiku"] },
  "accounts": {
    "kenchiku": {
      "label": "建築CH",
      "x": { "handle": "kenchiku_ch",
             "consumer_key": "…", "consumer_secret": "…",
             "access_token": "…", "access_token_secret": "…" },
      "note": { "urlname": "<note.com/ の後ろの ID>" }
    }
  }
}
EOF
gcloud secrets create sns-config --data-file=/tmp/sns-config.json && rm /tmp/sns-config.json
gcloud secrets add-iam-policy-binding sns-config \
  --member=serviceAccount:keihi-run@static-epigram-496002-v8.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

更新は `gcloud secrets versions add sns-config --data-file=…`（サーバー側は 5 分キャッシュ）。

### 3. コネクタ登録

claude.ai → 設定 → コネクタ → カスタムコネクタを追加:
`https://keihi-api-734350696397.asia-northeast1.run.app/api/sns/mcp/<TOKEN>`

### 4. 毎朝の記録（Cloud Scheduler）

`/api/internal/*` 共通の `x-tick-secret`（= `kaigi-tick-secret`）で守られている。

```bash
gcloud services enable cloudscheduler.googleapis.com
gcloud scheduler jobs create http sns-snapshot \
  --location=asia-northeast1 --schedule="53 6 * * *" --time-zone=Asia/Tokyo \
  --uri=https://keihi-api-734350696397.asia-northeast1.run.app/api/internal/sns/snapshot \
  --http-method=POST \
  --headers=x-tick-secret=$(gcloud secrets versions access latest --secret=kaigi-tick-secret)
```

## 漏れたら

トークンが漏れたら `sns-config` の `tokens` のキーを新しい値に差し替えて `versions add`。
コネクタ URL も差し替える。X のキーが漏れたら developer.x.com で再発行。
