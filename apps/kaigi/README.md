# AI会議（/kaigi/）

Gemini / Claude / GPT の3つの AI で経営判断のお題を**協働検討**して結論を出すミニアプリ。

## 使い方
- ランチャーから 🏛️ AI会議 をタップ
- お題を入力（経営判断・組織方針など）
- 「検討スタート」で1ラウンド（3者が1発言ずつ）
  - ラウンドが進むほど結論に収束していく設計
- 「結論を出す」で【結論】【根拠】【実行上の注意点】の3点を出力
- 「リセット」で履歴クリア

## 設計方針
**ディベートではなく協働検討**。3者で同じ目標——「実行可能な結論」——に向かって視点を統合する。

- 反論のための反論は禁止
- 違う視点を出すときは「なぜ重要か」「どう統合できるか」も添える
- 「ケースバイケース」「状況による」のような逃げ禁止
- **憶測禁止**: 数字・統計・他社事例・市場動向に触れるなら必ず web 検索で1次情報を取りに行く
- 根拠が無い論点は「裏付けがないので断定はしない」と明示

## ラウンド進行
| Round | フェーズ |
|---|---|
| 1 | 各自の視点・前提を出す（探索） |
| 2 | 他者の視点と統合、合意点とズレを整理（収束） |
| 3+ | 具体的な実行案を提案、折衷検討（結論化） |

## 仕組み
- フロント: 1ラウンドごとに `POST /api/debate` を3回（speaker を順に変えて）
- サーバー: `keihi-api` の `callByProvider(provider, prompt, { web })` が provider に応じて分岐
  - `gemini`: `gemini-2.5-flash` + `googleSearch` tool（デバッグ中。Pro に戻す予定）
  - `claude`: `claude-haiku-4-5` + `web_search_20250305` tool（デバッグ中。Opus に戻す予定）
  - `gpt`: `gpt-5-mini` (Responses API) + `web_search` tool（デバッグ中。gpt-5 に戻す予定）
- キー未登録の provider は Gemini に自動フォールバック
- 発言生成時は web 検索 ON、結論生成時は OFF（既出ログの統合のみ）
- 結論生成は Gemini 固定で 300〜500字、構造化出力

## ファイル構成
- `index.html` — UI + ロジック
- API: `apps/keihi/server/index.js` の `/api/debate` + `callByProvider()`

## コスト感（web 検索追加分）
- Gemini grounding: 1,500 queries/day まで無料、超過後 $35/1000q
- Claude web_search: $10/1000 searches
- OpenAI web_search: $25/1000 searches

社内サンドボックス用途なら月数百円レベル。

## 残課題
- [ ] デバッグ完了後、最上位モデルに戻す（Gemini Pro / Claude Opus / GPT-5）
- [ ] web 検索の出典 URL を UI 側に表示（grounding metadata 取得）
- [ ] ストリーミング応答
- [ ] 検討ログを Cloud SQL に保存して見返せるように
