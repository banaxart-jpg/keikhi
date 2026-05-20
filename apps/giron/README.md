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
- サーバー: `keihi-api` の `callByProvider(provider, prompt, { web })` が provider に応じて分岐
  - `gemini`: `gemini-2.5-pro` + `googleSearch` tool（fallback 経由）
  - `claude`: `claude-opus-4-7` + `web_search_20250305` tool（要 ANTHROPIC_API_KEY）
  - `gpt`: `gpt-5` (Responses API) + `web_search` tool（要 OPENAI_API_KEY）
- キー未登録の provider は Gemini に自動フォールバック
- 発言生成時は web 検索 ON、まとめ時は OFF（既出ログの要約のみ）
- まとめは Gemini 固定で 600〜900字、論点/立場/結論を構造化出力

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

## コスト感（web 検索追加分）
- Gemini grounding: 1,500 queries/day まで無料、超過後 $35/1000q
- Claude web_search: $10/1000 searches（max_uses=3 で1発言あたり最大$0.03）
- OpenAI web_search: $25/1000 searches

社内サンドボックス用途なら月数百円レベル。

## 残課題
- [ ] Claude / GPT キー登録 → 本物の3者議論化
- [ ] web 検索の出典 URL を UI 側に表示（grounding metadata 取得）
- [ ] ストリーミング応答（タイピング感）
- [ ] 司会 AI を4体目に立てて論点抽出・脱線検知
- [ ] 議論ログを Cloud SQL に保存して見返せるように
