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

## 残課題 / 今後やりたいこと
- [ ] 経験論述問題 (二次対策) の AI 採点
- [ ] 過去問データの拡充 (現状は AI 動的生成のみ)
- [ ] 学習計画 (試験日逆算で「今日の目標 N 問」表示)
