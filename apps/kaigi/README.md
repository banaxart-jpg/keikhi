# AI会議（/kaigi/）

Gemini / Claude / GPT の3つの AI で経営判断のお題を**協働検討**して結論を出すミニアプリ。
**会話は Cloud SQL に保存**されるので、途中でブラウザ閉じても再開可能。**Cloud Tasks 経由で閉じてる間も自動進行**できる。

## 使い方
- ランチャーから 🏛️ AI会議 をタップ
- 一覧画面でお題を入れて「この議題で会議を作る」
- 詳細画面の下部固定ボタン：
  - **もう1ラウンド** — 3者が1発言ずつ進む
  - **結論を出す** — 【結論】【根拠】【実行上の注意点】を生成
- 上段の細ボタン：
  - **次の1発言だけ** — 1人ずつ刻みたい時
  - **自動進行（3R→結論）** — Cloud Tasks に投げて閉じてる間も進む
  - **自動止める** — 自動進行中だけ表示
- 一覧画面に戻れば過去の会議が並んでる（最新100件）

## ラウンド進行
| Round | フェーズ |
|---|---|
| 1 | 各自の視点・前提を出す（探索） |
| 2 | 他者の視点と統合、合意点とズレを整理（収束） |
| 3+ | 具体的な実行案を提案、折衷検討（結論化） |

## 設計方針
ディベートではなく協働検討。3者で同じ目標——「実行可能な結論」——に向かって視点を統合する。

- 反論のための反論は禁止
- 違う視点を出すときは「なぜ重要か」「どう統合できるか」も添える
- 「ケースバイケース」「状況による」のような逃げ禁止
- **憶測禁止**: 数字・統計・他社事例・市場動向に触れるなら必ず web 検索で1次情報を取りに行く
- 引用時は本文中に「(出典: ◯◯)」と明記
- 根拠が無い論点は「裏付けがないので断定はしない」と明示

## サーバー API（`apps/keihi/server/index.js`）

| Method | Path | 内容 |
|---|---|---|
| GET    | `/api/kaigi/sessions`           | 自分のセッション一覧（最新100件） |
| POST   | `/api/kaigi/sessions`           | 新規セッション作成 `{topic, speakers}` |
| GET    | `/api/kaigi/sessions/:id`       | セッション詳細＋全メッセージ |
| DELETE | `/api/kaigi/sessions/:id`       | セッション削除 |
| POST   | `/api/kaigi/sessions/:id/next`  | 次の1発言を生成して保存 |
| POST   | `/api/kaigi/sessions/:id/conclude` | 結論を生成して保存（status=completed） |
| POST   | `/api/kaigi/sessions/:id/reset` | メッセージ全削除（セッションは残る、お題はそのまま） |
| POST   | `/api/kaigi/sessions/:id/auto`  | 自動進行開始 `{rounds: N}` → Cloud Tasks enqueue |
| POST   | `/api/kaigi/sessions/:id/auto/stop` | 自動進行を停止 |
| POST   | `/api/internal/kaigi/tick`      | 内部用 Cloud Tasks コールバック（x-tick-secret 認証） |

## モデル / web 検索
| AI | モデル | max_tokens | web 検索 |
|---|---|---|---|
| Gemini | `gemini-2.5-pro` | 2000 | `googleSearch` tool |
| Claude | `claude-opus-4-7` | 2000 | `web_search_20250305` (max_uses=3) |
| GPT    | `gpt-5` (Responses API) | 8000 | `web_search` (effort=medium、web無し時は minimal) |

各発言 300〜600字、結論は 600〜900字構造化（結論/根拠/立場の違い/注意点）。

## DB スキーマ
`apps/keihi/infra/schema.sql` に追加（冪等）。

- `kaigi_sessions(id, user_email, topic, speakers, status, auto_rounds_remaining, last_error, created_at, updated_at)`
- `kaigi_messages(id, session_id, speaker, provider, content, model_used, round_num, seq, is_conclusion, created_at)`

## 自動進行（Cloud Tasks）の仕組み
1. `POST /api/kaigi/sessions/:id/auto?rounds=3` で `status='auto'`, `auto_rounds_remaining=3`
2. Cloud Tasks queue `kaigi-tick` に1件 enqueue
3. Cloud Tasks が `POST /api/internal/kaigi/tick` を叩く（4秒間隔）
4. tick ハンドラ:
   - 1発言 advance（DB に保存）
   - 1ラウンド完了で `auto_rounds_remaining--`
   - まだ残ラウンド > 0 → 次の tick enqueue
   - 0 → 結論生成 → `status='completed'`
5. フロントは 5秒ごとにポーリングで新メッセージを取得

## 残課題
- [ ] web 検索の出典 URL を grounding metadata から取って UI に表示
- [ ] 自動進行完了時に FCM プッシュ通知
- [ ] 検討ログのエクスポート（Markdown / CSV）
