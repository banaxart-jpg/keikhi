# 施工管理2級（/seko-kanri/）

2級建築施工管理技士検定 (一次 + 二次) の対策ミニアプリ。
techstudy (= kotonoha) をフォーク・ローカライズしたもの。社内 (名取・小西) 専用。

## 試験目標
- **2026年11月8日 (日)**: 後期一次検定 + 二次検定 (同日実施)
- 小西: 一次 + 二次 のフル受験 (`exam_target = first_full`)
- 名取楓: 一次合格済 → 二次のみ (`exam_target = second_only`)

ホーム画面トップに常時「残り N 日」カウントダウン表示。

## 想定する出題
- **一次検定**: 建築学・施工・施工管理法・法規 の四肢択一
- **二次検定**: 経験論述 / 工程・品質・安全の記述問題 / 用語穴埋め

## techstudy との違い
- API パス: `/api/kotonoha/*` → `/api/seko/*`
- DB テーブル: `kotonoha_*` → `seko_*` (進捗データ完全分離 → 名取の techstudy 進捗はそのまま残る)
- ユーザーは初回に `exam_target` を選択 → 出題範囲を一次 / 二次でフィルタ
- AI 出題プロンプトは `seko-genres.json.domain.ai_subject` で施工管理ドメインに切替

## ファイル構成
- `index.html` — UI + ロジック (techstudy フォーク、API は `/api/seko/*`)
- `README.md` — これ
- (server 側) `apps/keihi/server/seko-genres.json` — 出題範囲マスタ
- (server 側) DB: `seko_questions` / `seko_progress` / `seko_users` / `seko_ui_demos`

## 記述問題の採点 (ルーブリック方式)
- 記述は Gemini が採点基準 (`SEKO_GRADE_RUBRIC` in server) で 0〜100 点を付け、**60 点以上で正解**
  (説明の正確さ / 留意点の具体性、一般論は低得点、誤記述は 0 点、模範解答と違う観点でも正しければ加点)
- 良い点 / 足りない点 / 誤り / 一言アドバイスを結果カードに表示。点数は `seko_progress.ai_score` に保存
- 呼び出しは 思考予算 0・temperature 0・maxOutputTokens 2500 (思考トークンで JSON が切れる事故の対策。同じ回答は同じ点)
- Gemini 不通時はキーワード一致率で点数化 (画面に「キーワード判定」と明記)

### 採点精度のテスト (本番 API を叩く)
```
node apps/seko-kanri/test/grade-run.mjs --repeat 3            # 全ケース、3 回回してブレも見る
node apps/seko-kanri/test/grade-run.mjs --only X --verbose    # 一部だけ、フィードバック全文
node apps/seko-kanri/test/grade-run.mjs --rubric my-rubric.txt --thinking 512 --model gemini-2.5-pro
```
- ケースと期待点数帯は `test/grade-cases.json` (満点級 / 部分 / 一般論 / 単語羅列 / 誤り / 別観点の正答 / 表記ゆれ / 問1新形式 …)
- エンドポイント `POST /api/seko/debug-grade/<SEKO_DEBUG_TOKEN>` は認証外・DB 書き込みなし。`rubric` / `model` / `thinking` / `temperature` を渡して採点基準を A/B できる
- 帯外があれば exit 1。基準を変えたら必ずこれを回してから push

## 残課題 / 今後やりたいこと
- [ ] 経験論述問題 (二次対策) の AI 採点
- [ ] 過去問データの拡充 (現状は AI 動的生成のみ)
- [ ] 学習計画 (試験日逆算で「今日の目標 N 問」表示)
