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

## 報酬設計 (続けたくなる仕掛け)
答えた瞬間に必ず何か返ってくる・積み上がったものは絶対に減らない・毎日戻る理由がある、の 3 点で組んでいる。

| 仕掛け | 中身 |
|---|---|
| XP | 択一正解 10 / 記述は点数比例 (100点=10, 60点=6)。**不正解や 0 点でも 1 以上もらえる**。XP は減らない |
| 初正解ボーナス | その問題を初めて正解したとき +5 |
| コンボ | 連続正解で XP 倍率 ×1.1 → 最大 ×2.0。正解音がコンボごとに音程を上げていく (ペンタトニック)。3 連続からデカ文字ポップ |
| クリティカル | 正解時 8% で XP 2 倍 + 金色フラッシュ + アルペジオ (変動報酬) |
| レベル | XP から算出するので**下がらない**。lv2=100, lv3=220, lv5=520, lv10=1620 XP。上がるとファンファーレ + 紙吹雪 + バーが金色に |
| 今日の日課 | 5 問正解でリングが閉じる。**跨いだ瞬間**にその場で演出 (セッション終了を待たない) |
| 連続日数 | 日課を達成した日が連続するとカウント。ホームに「あと N 問で連続 X 日目」= 失いたくない状態を見せる |
| 効果音 | WebAudio で合成 (音源ファイルなし)。ヘッダのスピーカーでミュート切替 (localStorage) |

- 出題の難易度 (mixed グループで記述が混ざる確率) は `level` を見ているので、XP が伸びると自然に記述が増える
- XP 導入前のユーザーは `total_correct * 10` で引き継ぎ済み (level が 1 に戻らないように)

### 演出のテスト (ブラウザ、本番 API 不要)
```
node apps/seko-kanri/test/fx-run.mjs
```
実 index.html を firebase / fetch / AudioContext スタブで起動し、コンボの音程上昇・XP バー・
クリティカル・レベルアップ・日課クリア・ミュート・サマリー集計・サーバー送信内容を検証する (36 項目)。

## 問題の画像 (実写 → 図のフォールバック)
用語や部材は「見た目と一緒に覚える」方が入るので、問題文の上に画像を出す。

1. **Web の実写** — 問題生成時に英語の検索語を出させ、Wikimedia Commons / Openverse で検索
   (ライセンス明示・API キー不要)。タイトル審査 → **画像そのものを Gemini に見せて**
   「対象が主題としてはっきり写っているか」を厳しく判定。通った 1 枚だけ採用し、出典を画面に表示
2. **SVG 生成図** — 実写が採れなければ AI に描かせる。viewBox 440x300、図形は中央、
   ラベルは左右の余白に白縁取りで配置。答えは図に書かせない
3. どちらも無理なら画像なし

実測 (2026-09): 実写の採用率は約 3 割。足場・防水・屋根・現場全景は写真が採れる。
野縁・スペーサー・タイル工法のような細かい部材は在庫が無く SVG に回る。
**画像確認を入れる前は誤採用があった** (「suspended ceiling」→ 駅の装飾天井、
「ceramic tile」→ 人物写真、「rebar spacer」→ 恐竜の骨格)。タイトル審査だけでは足りない。

生成はプリウォーム (バックグラウンド) のみで 1 回 6 問まで。セッション開始は待たせない。

### 画像のテスト
```
node apps/seko-kanri/test/diagram-run.mjs --out /tmp/dia   # SVG 生成 (6 ケース)
curl -X POST .../api/seko/debug-photo/<token> -d '{"question":"...","query":"scaffolding"}'  # 実写検索
```

## 残課題 / 今後やりたいこと
- [ ] 経験論述問題 (二次対策) の AI 採点
- [ ] 過去問データの拡充 (現状は AI 動的生成のみ)
- [ ] 学習計画 (試験日逆算で「今日の目標 N 問」表示)
