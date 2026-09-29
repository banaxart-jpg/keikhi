# 会議の文字起こし MCP（meeting-lib）

アプリ `/gijiroku/` が書き、claude.ai のチャットが MCP で読む。

## ツール（統合コネクタ `/api/mcp/<token>` に入っている）

| ツール | 中身 |
|---|---|
| `meeting_list` | 会議一覧（録音メモ /rec/ の記録も `rec:<id>` で混ざる） |
| `meeting_get` | 本文（`[mm:ss]` 付き）と静止画の一覧。長いときは offset で続き |
| `meeting_search` | 全会議の本文から語句検索 |
| `meeting_frames` | 画面共有の静止画を画像で返す（時間帯 or frame_id 指定、1 回 12 枚まで） |
| `meeting_create` / `meeting_add_text` / `meeting_update` / `meeting_delete` | 他ツールの文字起こしの取り込み・編集 |

## REST（Firebase ログイン、アプリ用）
`GET/POST /api/meeting`、`GET/PUT/DELETE /api/meeting/:id`、`POST /api/meeting/:id/audio|text|frame`、`GET /api/meeting/:id/frame/:fid`

## DB / 保存先
- Cloud SQL: `meetings` / `meeting_segments` / `meeting_frames`（初回アクセスで自動作成）
- 静止画: `gs://<RECEIPTS_BUCKET>/meeting/<id>/…jpg`（会議削除で一緒に消す）

## 統合コネクタ（index.js の `/api/mcp/:token`）
- 会議 / sheets / 現場写真 / drama / SNS のツールを 1 本に束ねたもの。新しい MCP はここに足せば URL を登録し直さなくていい
- token は `INTERNAL_TICK_SECRET` から HMAC で導出（`KEIHI_MCP_TOKEN` があれば優先）。新しい secret は不要
- URL の確認: ログインして `GET /api/mcp-connector`（アプリの「Claude につなぐ」）
- `INTERNAL_TICK_SECRET` を入れ替えると URL も変わる → コネクタを登録し直す
- 旧 URL（`/api/sheets|drama|photos|sns/mcp/...`）はそのまま動く

## 文字起こしエンジン（stt.js）
- Google Cloud Speech-to-Text v2。`chirp_3@us` → `chirp_3@asia-northeast1` → `chirp_2@us-central1` → `long@…` の順に試し、通った組み合わせを覚える
- 全滅（API 未有効化・権限など）なら Gemini 2.5 flash に戻る。アプリに「Gemini で文字起こし中」と出るのが目印
- 前提: プロジェクトで `speech.googleapis.com` が有効、Cloud Run のサービスアカウントに Speech の権限
- env: `MEETING_STT=chirp_3@us` で先頭候補を固定、`MEETING_STT=off` で STT を使わない
- 料金の目安: Chirp 3 は 1 分 約 $0.016（1 時間の会議で約 $1）
