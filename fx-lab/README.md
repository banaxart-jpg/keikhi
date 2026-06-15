# fx-lab

OANDA + Gemini を使った micro-FX 自動売買の実験場。

## 何ができるか

- OANDA REST API で 1 通貨単位の FX を自動売買 (USD/JPY 等)
- 数分ごとに最新ローソク + 計算済インディケータ (EMA / RSI / ATR) を Gemini Flash に投げ、`LONG` / `SHORT` / `PASS` の判断を受ける
- 信頼度が閾値超えのときだけ成行 + 利確 / 損切 OCO で発注
- 全ての判断と取引を `data/trades.ndjson` に append-only でログ
- これを毎日眺めて「なぜ勝ったか / 負けたか」を改善ループに回す

## 立ち位置 (重要)

これは **思考実験 + 学習用** のミニ bot。本気で勝つためのものじゃない。
- まず 1 通貨単位 (損失最大数十円) で実弾運用
- 「AI に価格パターン読ませて意味あるか」を低コストで検証する
- 勝率・PF・最大 DD が見えてきたらサイズ up

## セットアップ

### 1. OANDA Japan or OANDA Practice の口座を開く
- 本気で運用する前にまず **practice 口座 (=デモ)** で動作確認
- 開設 → アカウント画面で API token を発行 (https://www.oanda.jp/account/tpa/personal_token)
- account ID もメモ (例: `001-001-xxxxxxxx-001`)

### 2. Gemini API Key を取る
- Google AI Studio (https://aistudio.google.com/app/apikey) で発行

### 3. ローカルで動かす

```bash
cd fx-lab
npm install
cp .env.sample .env
# .env を編集して OANDA_API_KEY / OANDA_ACCOUNT_ID / GEMINI_API_KEY を埋める
# OANDA_ENV=practice にしておけば実弾は飛ばない

# 1 回だけ tick (動作確認用)
node src/main.js

# 5 分毎にループ
node src/main.js --loop
```

### 4. Cloud Run + Cloud Scheduler (常時稼働させる場合)

`main.js` は PORT env がセットされてれば HTTP サーバとしても起動する。
- Cloud Run にデプロイ
- Cloud Scheduler で 5 分毎に `POST /tick` を叩く
- これで「家の PC 開けっぱなし」が要らない

## 設定 (.env)

| key | 説明 | 例 |
|---|---|---|
| `OANDA_API_KEY` | OANDA で発行した API token | `xxxxxx-yyyyyy` |
| `OANDA_ACCOUNT_ID` | OANDA アカウント ID | `001-001-1234567-001` |
| `OANDA_ENV` | `practice` (= demo) or `live` | `practice` |
| `GEMINI_API_KEY` | Google AI Studio の key | `AIzaSy...` |
| `INSTRUMENT` | 通貨ペア | `USD_JPY` |
| `GRANULARITY` | 足の粒度 | `M5` (5分足) |
| `UNITS_PER_TRADE` | 1 トレードのロット | `1` (= 1 通貨、最小) |
| `TAKE_PROFIT_PIPS` | 利確 (pips) | `10` |
| `STOP_LOSS_PIPS` | 損切 (pips) | `10` |
| `MAX_TRADES_PER_DAY` | 1 日上限 | `20` |
| `CONFIDENCE_THRESHOLD` | AI confidence の発注閾値 (0-1) | `0.7` |
| `TICK_INTERVAL_MS` | --loop モードのインターバル | `300000` (= 5 分) |
| `PORT` | HTTP モードでサーバが listen するポート (省略可) | `8080` |

## ファイル構成

```
fx-lab/
  src/
    config.js       # .env 読み込み + 検証
    oanda.js        # OANDA REST API クライアント (candle 取得 / 発注)
    indicators.js   # EMA / RSI / ATR 計算
    chart.js        # 価格データを「AI に読ませる形」に整形 (text mode)
    ai.js           # Gemini Flash 呼出 + JSON parse
    risk.js         # 1 日上限 / 連敗クールダウン / position size 計算
    log.js          # data/trades.ndjson への append-only
    trader.js       # 1 tick = 「観測 → AI 判断 → 発注 → ログ」の流れ
    main.js         # entry: --loop / HTTP / 1-shot を判別
  data/             # ログ置き場 (.ndjson)
```

## アーキの考え方

```
[5 分毎]
  OANDA: 直近 100 本のローソク取得
  ↓
  indicators.js: EMA20 / EMA50 / RSI14 / ATR14 を計算
  ↓
  chart.js: 「最近の価格動き + 各指標値」を AI 入力用テキストに整形
  ↓
  ai.js: Gemini Flash に投げて { decision, confidence, reasoning } を受ける
  ↓
  risk.js: 発注可否を判定 (1 日上限・連敗中・confidence 閾値)
  ↓ (OK なら)
  oanda.js: 成行 + OCO (利確 / 損切) で発注
  ↓
  log.js: 判断と発注結果を ndjson に追加
```

## 注意

- API token は絶対に commit しない (`.env` は gitignore 済)
- `OANDA_ENV=live` にした瞬間から実弾が飛ぶ。最初は必ず `practice` で動作確認
- レバ 25 倍は OANDA Japan の標準。`UNITS_PER_TRADE=1` なら USD/JPY で証拠金 6 円 / 全損リスク 6 円
- 国内業者の API は仕様変更が時々ある。`oanda.js` は最小限の wrapper なので、変わったらここを直す

## TODO

- [ ] 画像チャート生成 (chart.js を text → PNG モードへ拡張、chartjs-node-canvas)
- [ ] バックテスト (過去の candle データで AI 判断を再生 → 仮想損益)
- [ ] 複数通貨ペア並行運用
- [ ] ポジション保有時間ルール (時間切れで強制決済)
- [ ] Telegram / Slack 通知
