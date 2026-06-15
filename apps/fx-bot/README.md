# FX bot (/fx-bot/)

OANDA × Gemini で 1 通貨単位の AI 自動売買 (owner 専用)。
旧 `/fx-lab/` (Node スクリプト) をミニアプリ化したもの。

## 設計の核

**売買判断は決定的アルゴ (戦略)、AI はパラメータ最適化担当**。
hot path から Gemini を外したので: 高速 / 再現性 / ブレない / コスト最小。
AI はバックテスト結果を眺めて「fast=12 → 10 に下げよう」みたいに提案する役。

## 戦略最適化に関する注意 (重要)

シンプルな TA 戦略 + 1 年データの最適化で「勝率 65%」みたいな数字が出る場合は
ほぼ確実に **look-ahead bias** か **regime fit** (= 後付けフィッティング)。

look-ahead bias の典型: シグナル算出に使った candle の高安を、entry 後の
TP/SL 判定にも流用する。本コードの backtest engine では:
- シグナル window = candles[i-WINDOW..i-1] (day i-1 末)
- entry = candles[i].open (day i 寄り、シグナル後最初に取得可能な価格)
- future = candles[i..i+FUTURE-1] (entry 後の値動きを TP/SL チェック)

これで「シグナルから entry までの 1 日分のサヤを無料で貰う」事故が防がれる。

加えて:
- 同バー内で TP と SL を両方触ったら **SL 優先 (pessimistic)** とみなす
- spread + slippage を round-trip cost_pips (デフォルト 1 pip) として TP/SL
  閾値をシフト、損益にも反映

これらを入れた上で「日足 USD/JPY の simple TA に 60% 越えの edge は無い」
というのが honest な結論 (学術コンセンサスと同じ)。エッジを探すなら:
- 複数指標の組合せ + 時間帯 / セッションフィルタ
- ニュースイベント回避 (NFP, 日銀, FOMC)
- ボラレジーム (ATR) でルール切替
- ML / ニューラル系へ移行
あたり。

## 内蔵戦略 (4 種、apps/keihi/server/fx-lib/strategies.js)

| ID | 名前 | 中身 |
|---|---|---|
| `ema_crossover` | EMA クロス | EMA 短期/長期 のクロスでトレンドフォロー (デフォルト) |
| `rsi_mean_revert` | RSI 逆張り | RSI 30 切で LONG、70 超で SHORT (レンジ向け) |
| `bb_breakout` | BB ブレイク | ボリンジャー上下抜けで順張りモメンタム |
| `ai_vision` | AI 判断 | Gemini にチャート渡して決める旧式 (重い、参考用) |

各戦略は paramSchema を持ち、UI に自動的にスライダー入力が生える。

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

### データソース 2 種類
1. **CSV アップロード** (推奨、API key 不要)
   - [HistData](http://www.histdata.com/) (無料、月次 M1 CSV)
   - [Dukascopy](https://www.dukascopy.com/swiss/english/marketwatch/historical/)
   - [Stooq](https://stooq.com/) 等から DL → モーダルに貼る or ファイル選択
   - 形式自動判定 (HistData セミコロン形式 / Dukascopy / ISO8601 等)
2. **OANDA API** (要 API key、Japan は本番口座 + Gold 限定で実質難しい)

### 仕組み
1. ヒストリカル candle を取得 (CSV パース or OANDA fetch)
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
