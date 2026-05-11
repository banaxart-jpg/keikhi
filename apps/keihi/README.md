# keihi — 経費管理アプリ

領収書を写真撮って Gemini で読み取り、Cloud SQL に保存するモバイルWebアプリ。

## 構成

| レイヤ   | 中身                                                |
|---------|-----------------------------------------------------|
| Front   | `index.html` (現状: ローカル localStorage + Anthropic直叩き — Phase 2 で /api/* に切替予定) |
| API     | `server/` Node.js 20 + Express → Cloud Run (`keihi-api`) |
| AI      | Gemini API (`gemini-2.0-flash` デフォルト)          |
| DB      | Cloud SQL Postgres `keihi` (共有インスタンス `keikhi-db`) |
| 画像     | Cloud Storage `${PROJECT_ID}-keihi-receipts`        |
| Secrets | `gemini-api-key` (共有), `keihi-db-password`        |

## API

| Method | Path                | 説明                                    |
|--------|---------------------|----------------------------------------|
| GET    | `/health`           | 死活確認                                |
| POST   | `/api/scan`         | `{image, mimeType, sites:[]}` → 解析JSON |
| GET    | `/api/records`      | 一覧                                    |
| POST   | `/api/records`      | 登録                                    |
| DELETE | `/api/records/:id`  | 削除                                    |

## デプロイ

`apps/keihi/**` 配下を変更して push すると Cloud Build トリガが起動して自動デプロイされる。

手動デプロイ:
```bash
gcloud builds submit --config=apps/keihi/cloudbuild.yaml --region=asia-northeast1 .
```

## ローカル実行

```bash
cd apps/keihi/server
npm install
GEMINI_API_KEY=... npm run dev
```

DB と Storage の env 変数を空にしておけば、`/api/scan` だけ動かして確認できる。

## まだやってないこと (Phase 2 以降)

- [ ] `index.html` を Cloud Run の `/api/*` に繋ぎ替え（現状は Anthropic 直叩き）
- [ ] フロントエンドホスティング（Firebase Hosting or Cloud Run static）
- [ ] XSS脆弱性修正（`renderList()` の `innerHTML` エスケープ漏れ）
- [ ] 記録の編集機能
- [ ] メモ欄
- [ ] 購入者名を設定で変更可能に
