# FX bot (/fx-bot/)

OANDA × Gemini で 1 通貨単位の AI 自動売買 (owner 専用)。
旧 `/fx-lab/` (Node スクリプト) をミニアプリ化したもの。

## できること
- 現在の口座残高 / 本日損益 / 維持率 をホームで一覧
- Bot ON/OFF トグル (Cloud Scheduler が 5 分毎に `/api/internal/fx/tick` を叩く想定)
- 「即実行」ボタンで手動 1 tick (動作確認用)
- 保有中ポジションを一覧、強制決済可
- 直近 30 件の AI 判断 (LONG/SHORT/PASS + confidence + 理由) を折り畳みで閲覧
- 直近 30 件の取引履歴 (建値/TP/SL/決済価格/損益) を折り畳みで閲覧
- 設定 (環境・通貨ペア・粒度・ロット・TP/SL・confidence 閾値・1 日上限・連敗クールダウン)
  を bottom-sheet モーダルで変更

## 環境変数 (Cloud Run 側で設定)
- `OANDA_API_KEY` — OANDA で発行した API token
- `OANDA_ACCOUNT_ID` — OANDA アカウント ID
- `FX_OWNER_EMAILS` — owner メアドのカンマ区切り (省略時は KOTONOHA_OWNER_EMAILS を流用)
- `INTERNAL_TICK_TOKEN` — Cloud Scheduler が `/api/internal/fx/tick` を叩く際の認証トークン

DB の `fx_settings.oanda_env` (`practice`/`live`) で接続先を切り替え。
**最初は必ず practice (デモ口座) で動作確認**。

## DB テーブル
- `fx_settings` (1 行のみ、グローバル設定)
- `fx_decisions` (AI 判断履歴、append-only)
- `fx_trades` (取引履歴 opened/closed/order_failed、append-only)

## サーバ側
- `apps/keihi/server/index.js` の `/api/fx/*` ルート群
- `apps/keihi/server/fx-lib/` に OANDA クライアント・指標計算・AI prompt を分割配置

## Cloud Scheduler 設定 (常時稼働)
```
gcloud scheduler jobs create http fx-bot-tick \
  --schedule="*/5 * * * *" \
  --uri="https://keihi-api-.../api/internal/fx/tick" \
  --http-method=POST \
  --headers="X-Internal-Token=$INTERNAL_TICK_TOKEN" \
  --location=asia-northeast1
```

## ファイル構成
- `index.html` — PWA 一式 (ホーム + 設定モーダル + サインイン overlay)
- `README.md` — これ

## AI 自動最適化ループ

直近 7 日のトレード成績 (勝率 / PF / 平均勝ち負け / 最大連敗 / 平均 confidence)
を Gemini に渡して、設定の調整案を生成。

- ホーム「AI 提案」ボタンで手動実行
- Cloud Scheduler から定期実行も可: `POST /api/internal/fx/optimize` (X-Internal-Token)
- 提案は `fx_optimizations` テーブルに保存、未適用のものはホームに自動表示
- 「適用」「却下」のいずれかを owner が選ぶ

### 自動適用モード (ガードレール付き)
設定モーダルで「AI 提案を自動適用」を ON にすると、次の安全条件を満たした
変更だけがその場で適用される:
- 数値変更は ±20% 以内のみ
- confidence_threshold は 0.5〜0.95 にクリップ
- TP/SL は 1〜100 pips にクリップ
- cooldown_minutes は 5〜720 分にクリップ
- units_per_trade は **減方向のみ** 自動適用 (増は手動でしか変えられない)
- oanda_env / instrument の変更は受理しない (安全フィールド)

## バックテスト (= 学習データを高速に貯める仕組み)

実弾を 1 ヶ月待たないとサンプル 100 件貯まらないが、バックテストなら
30 分で 1000 件貯められる。

### 仕組み
1. OANDA の過去 candle (最大 30 日 / 1 リクエスト 5000 本ページネーション) を取得
2. 50 本 window で walk-forward、N candle ごとに 1 回 AI に判断させる
3. 次の 12 本で TP/SL に当たったかをシミュレーション (本物の bot と同じロジック)
4. 全予測を `fx_backtest_predictions` に保存
5. 集計: 総勝率 / PF / **confidence 帯別の勝率** ← これが本命
6. 「AI 校正案を作る」ボタンで Gemini にバケット成績を渡し、最適な閾値・TP/SL の提案を生成

### confidence 帯別の勝率テーブル
バックテスト詳細画面で表示。「0.7-0.8 帯は勝率 62%、0.5-0.6 帯は 38%」みたいに
出てくれば、閾値 0.7 → 0.75 などの実データに基づく校正が可能。

### コストとリソース感
- 1 件のバックテスト: 数百〜1500 予測 ≒ Gemini 数百回 ≒ $0.5-1.5、30 分前後
- DB に予測を全部残すので後で別 prompt と比較できる
- 期間 30 日上限・sample rate 60 上限の入力 validation あり

### API
- POST /api/fx/backtest               新規実行 (background)
- GET  /api/fx/backtests              履歴一覧
- GET  /api/fx/backtest/:id           詳細 + 直近 100 予測
- POST /api/fx/backtest/:id/optimize  完了結果から AI 校正案生成

## 残課題
- 損益カーブの可視化 (sparkline チャート)
- 複数通貨ペア並行運用
- バックテストの prompt variant 比較 (同じ candle に別 prompt で AI 判定 → どちらが勝てるか)
