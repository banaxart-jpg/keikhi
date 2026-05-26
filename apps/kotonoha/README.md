# ことのは（/kotonoha/）

Claude Code に指示するための **概念・用語の語彙**を一問一答で身につけるミニアプリ。
モーダル？ FAB？ ドロワー？ — 名前が分かれば指示できる、を 10問1セットで埋めていく。

## 使い方

- ランチャーから [🎓 ことのは] をタップ
- 「セッション開始」で 10問 出題（選択式 + 自由記述ミックス）
- 自由記述は AI（Gemini Flash）が意味で判定（日本語/英語/カタカナ表記揺れ吸収）
- 各問題の解答後に「解説 + Claude Code への指示例」が出る
- 10問終わると正答率に応じてレベル自動調整（≥80% で +1、<50% で −1）

## 出題ロジック（成長速度に合わせる）

- 過去30日でミスした問題を最大3問 + ユーザーのレベルに近い問題を残り
- 「ちょうど合う」（距離0）→「少し挑戦」（距離+1, +2）の順で並べる → 達成感重視
- セッション終了時、**正答率 70% 以上**でレベル+1、**40% 未満**で −1（広い「フロー」ゾーン）
- 出題プールが薄くなったらバックグラウンドで **AI（Gemini Flash）が新規問題を生成**
- カテゴリは 8 軸（ui / db / api / ai / infra / concept / project / prompt）まんべんなく

## メンバー進捗

- 同じプロジェクトに参加しているメンバーのレベルとカテゴリ別習熟度が見える
- ランキングや競争要素は無し
- 自分の進捗を見せたくない場合は設定で非公開化可能（`visible_to_peers=false`）

## ファイル構成

- `index.html` — UI + ロジック（ホーム / セッション / サマリの3ビュー）
- サーバー側: `apps/keihi/server/index.js` に `/api/kotonoha/*` エンドポイント
- DB: `kotonoha_questions` / `kotonoha_progress` / `kotonoha_users` 3テーブル
- シード: `apps/keihi/infra/kotonoha-seed.json`（初期35問）

## API エンドポイント

| Method | Path | 説明 |
|---|---|---|
| POST | `/api/kotonoha/sessions/start` | 10問取得（リトライ + 新規 + チャレンジ） |
| POST | `/api/kotonoha/answer` | 解答送信（AI 判定 + 進捗保存） |
| POST | `/api/kotonoha/sessions/end` | セッション終了（レベル再計算） |
| GET | `/api/kotonoha/me` | 自分の統計 |
| GET | `/api/kotonoha/peers` | 他メンバーの統計 |
| PUT | `/api/kotonoha/me/visibility` | 他メンバーへの公開設定切替 |

## 残課題 / 今後やりたいこと

- [ ] UI 系問題への画像添付（モーダル/FAB の見た目を画像で確認）
- [ ] カテゴリ別の弱点フォーカス出題モード
- [ ] AI 生成問題の品質モニタ（紛らわしい問題を間引く）
