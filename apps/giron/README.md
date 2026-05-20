# AI議論（/giron/）

Gemini / Claude / GPT の3つの AI にお題を投げて議論させるミニアプリ。

## 使い方
- ランチャーから 🗣️ AI議論 をタップ
- お題を入力
- 「議論スタート」で1ラウンド（3者が1発言ずつ）
- もう1回押すと次のラウンドが進む
- 「まとめる」で論点と結論を出す
- 「リセット」で履歴クリア

## 仕組み
- フロント: 1ラウンドごとに `POST /api/debate` を3回（speaker を順に変えて）
- サーバー: `keihi-api` の `callByProvider(provider, prompt)` が provider に応じて分岐
  - `gemini`: 既存の `callGeminiWithFallback`
  - `claude`: Anthropic Messages API（ANTHROPIC_API_KEY 必要）
  - `gpt`: OpenAI Chat Completions API（OPENAI_API_KEY 必要）
- キー未登録の provider は Gemini に自動フォールバック
- まとめは `summary: true` で議論ログ全体から200字以内で生成（モデルは Gemini 固定）

## 本物の3者議論に切り替える手順（キー入手後）
1. Secret 登録:
   ```bash
   echo -n "<openai key>"    | gcloud secrets create openai-api-key    --data-file=-
   echo -n "<anthropic key>" | gcloud secrets create anthropic-api-key --data-file=-
   ```
2. `apps/keihi/cloudbuild.yaml` の deploy ステップに env/secret 追加:
   ```
   --set-secrets=OPENAI_API_KEY=openai-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest
   ```
3. main push → Cloud Build → 自動でモデル別呼び出しが有効化される

## ファイル構成
- `index.html` — UI + ロジック
- API: `apps/keihi/server/index.js` の `/api/debate` + `callByProvider()`

## 残課題
- [ ] Claude / GPT キー登録 → 本物の3者議論化
- [ ] ストリーミング応答（タイピング感）
- [ ] 司会 AI を4体目に立てて論点抽出・脱線検知
- [ ] 議論ログを Cloud SQL に保存して見返せるように
