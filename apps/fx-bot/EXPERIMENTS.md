# fx-bot 実験ログ

これまで試した戦略・最適化・バグ修正のすべてを時系列で記録。
何が動いて何がダメだったかを後で振り返れるようにするための memo。

---

## 実験 1: AI (Gemini Vision) で hot path 判定

**日時**: 2026-06-15 (初期)
**仮説**: チャート画像 + 指標を Gemini に見せて LONG/SHORT/PASS を返させれば prompt 次第で勝てる
**実装**: `apps/keihi/server/fx-lib/ai.js` の `decideFromChart`

### 問題
1. 1 tick あたり Gemini call が 1 回 → 遅延 (~3 秒)、コスト ($0.001/tick)
2. 同じ chart でも応答がブレる (temperature 由来、JSON 構造もたまに崩れる)
3. バックテストで 1000 予測 = 30 分 + $1.5
4. 判断根拠が完全にブラックボックス、再現性ゼロ

### 結論
**hot path に AI 入れるのは筋悪**。AI は最適化補助に格下げすべき。
→ 実験 2 へ

---

## 実験 2: 戦略フレームワークに切替 (決定的アルゴ + AI 最適化補助)

**日時**: 2026-06-15
**変更**: `apps/keihi/server/fx-lib/strategies.js` 新規作成
**実装**: 4 戦略を deterministic 関数で実装
- `ema_crossover`: EMA 短期 / 長期 のクロス
- `rsi_mean_revert`: RSI で逆張り
- `bb_breakout`: ボリンジャー突破
- `ai_vision`: 互換性のため旧 AI 戦略も残す (重い、参考用)

### 改善
- 1 tick = 1 ms 以下 (Gemini call ゼロ)
- 完全再現性 (同じ candle → 同じ判断)
- バックテストが秒で終わる (1000 予測 = 数秒)
- confidence は signal の強さから自動計算 (例: EMA separation pips、RSI 閾値超え量)

### 結論
アーキテクチャ的には大正解。「AI 判断するからアルゴ単純化したい」の user 指摘通り、
判断は決定的、AI は backtest 集計を眺めて param 提案するだけの構造に。
→ 実験 3 で実データ検証へ

---

## 実験 3: USD/JPY 日足 1 年で 4 戦略 × グリッドサーチ (バグあり)

**日時**: 2026-06-15
**データ**: Yahoo Finance USD/JPY 日足、2024-06-02 〜 2025-06-12 (267 日)
**設定**: 100 ランダムサンプル × 5 シード、TP=SL=50 pips、window=60 日、future=10 日
**スクリプト**: `/tmp/fx_optimize.mjs`

### 結果 (バグあり時点)
| 戦略 | best 勝率 | params |
|---|---|---|
| rsi_mean_revert | **71.4%** | period=5, os=15, ob=65 |
| bb_breakout | 64.7% | period=30, mult=1.5 |
| ema_crossover | (signals 20 未満) | 日足では cross 少なすぎ |

### Robustness 検証
- 前半 65.5% / 後半 64.2% で安定 → 「ホンモノっぽい」と一旦判断
- 一見、目標 60% 超えクリア

### 結論 (この時点)
**RSI(5, 15/65) で 65% 勝率**。コードのデフォルトを書き換える案 (A 案) を user に提案。
→ 実験 4 で user が「ガス代考慮?」と疑問提起

---

## 実験 4: コスト (スプレッド + スリッページ) 込み再評価

**日時**: 2026-06-15
**仮説**: cost 込みで 60% 割るのでは?
**スクリプト**: `/tmp/fx_with_cost.mjs`
**コスト想定**: round-trip 1 pip (= スプレッド 0.5 + スリッページ 0.5)

### 結果
| TP/SL | cost=0 | cost=1 | cost=2 |
|---|---|---|---|
| 50/50 | 65.5% | 63.5% | 63.5% |
| 30/60 | 71.2% | 69.7% | 69.7% |
| 100/100 | 59.2% | 57.9% | 55.1% |
| 20/50 | 74.7% | 74.7% | 74.7% |

cost が TP の 2-4% (50 pips に対して 1 pip) なら勝率への影響は微小。
20/50 はそもそも asymmetric なので勝率高だが avg pips が小さい。

### 結論 (この時点)
「**まだ 60% は超えてる**」と判断。Top9 候補 (rsi(7,30/70) TP100/SL100) も検証 → 66% で安定。
→ 実験 5 で user が「再現性低いんじゃない?」と更に疑問提起

---

## 実験 5: look-ahead bias 監査 (致命傷発見)

**日時**: 2026-06-15
**user の指摘**: 「そんな簡単に 60% 超えるか? 何かミスってない?」
**監査対象**: シミュレーション関数のタイミング
**スクリプト**: `/tmp/fx_no_lookahead.mjs`

### 発見したバグ
```js
// バグあり版:
const window = candles.slice(i - WINDOW, i);  // candles[i-60..i-1] (= 正しい)
const future = candles.slice(i, i + FUTURE);  // candles[i..i+9]
const entry = candles[i].c;                   // ← 終値 (day i の最後)

// 問題:
// シグナル決定 = day i-1 末
// entry = day i 終値 → 間に 1 日丸ごと飛ばしてる
// future TP/SL チェック = candles[i] から → day i の高安 (= 既に過去) で TP/SL hit を判定
// = 「day i の中で起きた値動きをタダで貰ってる」
```

### 修正
```js
const entry = candles[i].o;   // day i 寄付 (シグナル後最初に取得可能な価格)
// future はそのまま (day i 寄付以降の値動きで TP/SL を判定)
// 加えて: 同バー TP+SL 両 touch → SL 優先 (pessimistic)
```

### 修正後の結果
| 戦略 | バグあり | バグ修正後 | 差 |
|---|---|---|---|
| rsi(5,15/65) TP50/SL50 | 65.5% | **49.0%** | **-16.5pt** |
| rsi(5,20/65) TP50/SL50 | 65.2% | 48.4% | -16.8pt |
| rsi(7,30/70) TP100/SL100 | 66.0% | 66.0% | 0pt |
| rsi(14,15/65) TP100/SL100 | 77.2% | 75.4% | -1.8pt |

TP=50 の戦略は bias で 16pt 持ち上げてた。TP=100 の戦略は (TP 広い分) bias の影響が小さかった。

### 残った 66% / 75% の正体
- **rsi(7,30/70)**: 前半 48% / 後半 69% → 後半に偏ってる、USD/JPY 下落 regime で SHORT 当たりまくった
- **rsi(14,15/65)**: signals 57 件すべて SHORT、LONG ゼロ → 「下げ相場で売っただけ」

= 真の edge ではなく **regime fit / 方向バイアス**。

### 結論
**日足 USD/JPY の simple TA 戦略に、look-ahead-free + コスト込みで 60% 超え edge は存在しない**。
学術コンセンサスと同じ。デフォルト書き換え (A 案) は **見送り**。
→ コードに同じ bug があったので server 側 backtest engine も修正してプッシュ (実験 6)

---

## 実験 6: server 側 backtest engine の bug 修正

**日時**: 2026-06-15
**コミット**: `v.80d9af0`
**修正内容**:
1. look-ahead bias 修正 (entry = day[i].open、future = day[i] 以降)
2. cost_pips カラム追加 (default 1.0 round-trip) → TP/SL 閾値と PnL に反映
3. 同バー TP+SL 両 touch → SL 優先 (pessimistic)
4. timeout PnL = 0 固定だったのを、最終 close と entry の差から計算 (cost 込み)
5. フロント: backtest モーダルに「想定コスト」入力欄追加

### 結論
これで初めて「正しいバックテストが回る」状態。今後の実験はすべてこの基盤の上で。
→ 実験 7 で user が「勝ってる人のやり方調べて」と依頼

---

## 実験 7: 勝ってる retail 戦略を調査 (未実装)

**日時**: 2026-06-15
**user 制約**: simple / 数値化できる / news 系は NG
**調査結果**: 3 候補 (参考: LuxAlgo / Quantified Strategies / Journal Plus / Mind Math Money)

### 候補 1: MTF (マルチタイムフレーム) アライメント
- D1 / H4 / H1 で EMA20 vs EMA50 の trend 方向を比較
- 全 3 つ同方向で揃ったら方向 OK、揃わなければ PASS
- 実測勝率: **3/3 揃い 55-65%、2/3 揃い 40-50%**

### 候補 2: ロンドンブレイクアウト (ORB)
- ロンドン開場 15 分の高安をマーク → breakout エントリー
- 実測勝率 50-65% (USD/JPY は range 狭く適性低)
- フェイクアウト多発

### 候補 3: ATR スケール TP/SL
- entry signal は何でもよい、TP=ATR×1.5、SL=ATR×1.0 で動的に
- 単独で勝率改善はせず、PF 改善に寄与

### 推奨
**MTF + ATR スケール** の組合せ。user 制約に最も合致 + 既存 EMA 計算流用可能。
→ 実験 8 で実装テストへ

---

## 実験 8: 真の MTF EMA Alignment + ATR スケール TP/SL の検証

**日時**: 2026-06-15
**仮説**: H1 / H4 / D1 の 3 timeframe で EMA20 vs EMA50 のトレンド方向が
        全て揃った時のみエントリーすれば 55-65% の勝率 (調査文献の通り)
**スクリプト**: `/tmp/fx_mtf_test.mjs`
**データ**: Yahoo Finance H1 USD/JPY、2024-06-25 〜 2026-06-15 (12060 H1 candles ≒ 1.4 年)
**集約**: H1 → H4 (4 本 OHLC) → D1 (24 本 OHLC)
**サンプル**: 200 random × 5 seeds = 1000、minIdx=1200 (D1 EMA50 必要)
**エントリー**: 3 TF 全揃いで方向決定、entry = h1[i].o (look-ahead-free)
**exit**: TP = ATR(14, H1) × tpMult、SL = ATR × slMult、cost=1 pip

### 結果

| fast/slow | TP×/SL× | 3揃% | 発火 | LONG/SHORT | 勝率 | avg net |
|---|---|---|---|---|---|---|
| 20/50 | 1.5/1.0 | 43% | 434 | 325/109 | 41.9% | +0.2 |
| 20/50 | 2.0/1.0 | 43% | 434 | 325/109 | 33.6% | -0.3 |
| 20/50 | 1.0/1.0 | 43% | 434 | 325/109 | 52.8% | +0.0 |
| 20/50 | 1.5/1.5 | 43% | 434 | 325/109 | **51.2%** | **+0.5** |
| 12/26 | 1.5/1.0 | 44% | 441 | 323/118 | 38.8% | -1.9 |
| 9/21 | 1.5/1.0 | 43% | 433 | 311/122 | 37.4% | -2.7 |
| 50/100 | 1.5/1.0 | 39% | 391 | 312/79 | 38.3% | -1.9 |

### 観察
1. 全構成で **LONG 比率 70-80%** (USD/JPY が 2024-25 で円安基調 → 3 TF 揃いやすい方向に偏り)
2. 文献の「55-65% 勝率」は出ず、**ベストでも 52.8%** (= ほぼランダム)
3. TP/SL の比率を変えると勝率は変動するが、avg net pips は ±2 pips 範囲 = エッジ無し
4. 「3 揃い 43%」= シグナル激減を期待してたが意外と頻発、フィルタとして弱い
5. 「align=2」は数学的に存在し得ない (3 ブール値だと 0, 1, 3 しかない、bug ではない)

### Best 構成
fast=20/slow=50/TP=ATR×1.5/SL=ATR×1.5、勝率 51.2%、avg +0.5 pips/trade、累計 +220 pips
→ **break-even すれすれ**、実弾運用には弱い

### 結論
**真の MTF EMA Alignment + ATR スケール TP/SL でも 60% edge は出ない** (USD/JPY 1.4 年データ)。

文献の「55-65%」は:
- 別通貨ペア (GBP/JPY 等のボラ高め) の結果
- entry をプルバック待ちにしてる (= retracement after alignment)
- 時間帯フィルタも併用 (London/NY 開場前後)

これらを足せば改善余地ある可能性。ただし「単純で数値化できる」要件から外れていく。

### 次の候補
- A. プルバック entry を追加 (alignment 確認後、EMA20 への戻りを待つ)
- B. 時間帯フィルタ (London/NY 開場後 3 時間のみエントリー許可)
- C. 通貨ペア変更 (USD/JPY → GBP/JPY 等)
- D. ML / 特徴量を組合せた decision tree への移行
- E. 諦めて 手書き bot から別アプローチへ

---

## 実験 9: 複合戦略 グリッドサーチ + robustness 再検証 (致命的な統計バイアス発覚)

**日時**: 2026-06-15
**仮説**: MTF にプルバック / 時間帯 / ボラ フィルタを重ねれば edge 出る
**通貨ペア**: USD/JPY、GBP/JPY、EUR/USD、GBP/USD (4 pair × H1 12000+ 本)
**スクリプト**: `/tmp/fx_combo.mjs`、`/tmp/fx_verify_fast.mjs`

### Step 1: random sampling グリッドサーチ
random 200 × 5 seeds = 1000 attempts でフィルタ通過後の集計:

| rank | pair | filter | TP/SL | sig | wr | avg net |
|---|---|---|---|---|---|---|
| 1 | EURUSD | MTF + vol(1.0x) | 1.5/1.5 | 200 | 53.0% | +2.1 |
| 4 | **USDJPY** | **MTF + time** | **1/1** | **132** | **56.1%** | **+1.5** |
| 6 | GBPJPY | MTF + pullback | 1.5/1.5 | 142 | 51.4% | +0.9 |

「USDJPY MTF + 時間帯 = 56.1% 勝率」が見えてきた → 検証へ

### Step 2: 全データ評価で本物か確認 (= sampling 外し)
ランダムじゃなく **全 h1 idx を順に評価**:

| variant | sig | 全期間 wr | 全期間 avg | 前半 wr | 後半 wr |
|---|---|---|---|---|---|
| London+NY UTC 7-15 | 1565 | 48.8% | -1.8 | 50.5% | 47.2% |
| London only | 787 | 46.0% | -2.9 | 49.7% | 42.7% |
| NY only | 778 | 51.5% | -0.7 | 51.2% | 51.8% |
| Tokyo open | 788 | 49.2% | -1.1 | **52.4% (+0.9)** | 46.1% (-3.0) |
| Off-hours | 1288 | 47.4% | -1.6 | **52.4% (+1.0)** | 42.7% (-4.1) |
| London+NY TP×1.5 | 1565 | 38.8% | -2.1 | 39.6% | 38.1% |
| London+NY TP×1.5/SL×0.8 | 1565 | 33.6% | -2.2 | 34.5% | 32.8% |

### 重大な発見: random sampling の統計バイアス
- random 132 signals で 56.1% → 全データ 1565 signals で **48.8%** に収束
- 信頼区間で言うと 132 件の 56% は 95% CI で [47.2%, 64.5%] → 50% を含む
- 全データ 1565 件で **真の値は 48.8% 程度** (= ランダム or 負け)

### 後半 (2025〜) で極端な LONG bias
ほぼ全 variant で 後半 LONG/SHORT ≒ 800/30 と異常な偏り。
USD/JPY ほぼ trending up regime → MTF alignment が本質的に「上昇追従だけ」になり
反対方向で死ぬ。

### 結論
**MTF + 時間帯 + ATR スケール、すべての通貨ペアで本物の edge 無し**。
random sampling で見えた「56%」は signals 数 100-200 の statistical artifact だった。

これも実験 5 の look-ahead bias と同じ「**統計バイアス系のミス**」。教訓:
- ✓ サンプリング後の集計を妄信しない、全データで再確認
- ✓ signals 数 200 未満は wr の信頼区間が広すぎる (±10pt 平気)
- ✓ regime fit は 前半/後半 split で必ず炙り出す

### 候補絞り直し
ここまでの実験で証明された事実:
- 単一指標 (RSI / EMA / BB) は edge 無し
- MTF alignment は edge 無し
- ATR スケール TP/SL は不利でも有利でもない
- 時間帯フィルタ単体では edge 出ない
- 通貨ペア替えても edge 出ない (USDJPY / GBPJPY / EURUSD / GBPUSD すべて)

= **retail simple TA の手筋はほぼ全滅**。残ってる選択肢:
- F. **mean reversion + ML**: 特徴量 (RSI, MACD, ATR, BB pos, time-of-day, day-of-week, prev N bars return) を 20 個くらい入れて simple classifier (logistic regression / random forest) を訓練、TimeSeriesSplit で正しく交差検証
- G. **ペアトレード** (USD/JPY と EUR/JPY の相関乖離) → これは元々統計裁定の領域
- H. **ニュース系** (NFP / 日銀) ← user 制約で却下
- I. **諦めて FX bot プロジェクト凍結** (= 学びとしてはここまでで十分)

→ 次は user 判断待ち。F (ML) 試すなら scikit-learn でやれば 1 日くらいで結果出る。

---

## 実験 10: lead-lag 相関分析 (USD 後追い通貨を探す)

**日時**: 2026-06-15
**user 仮説**: 「米ドルが先に動いて、後追いする通貨があったら、それに絞って取引すれば edge あるかも」
**スクリプト**: `/tmp/fx_leadlag.mjs`
**データ**: 11 通貨ペア (USD系・JPY系・cross) + DXY、H1 11559 candles (約 1.6 年、共通時刻のみ)
**手法**: H1 log return の Pearson 相関、lag 0/1/2/3/6/12 時間でクロス計算

### 結果 1: 同時刻 (lag 0) は極めて強相関 (= 市場効率的)

| target | DXY との lag 0 相関 |
|---|---|
| EUR/USD | -0.956 (ほぼ完全反相関) |
| GBP/USD | -0.824 |
| USD/CHF | +0.794 |
| NZD/USD | -0.694 |
| USD/JPY | +0.648 |
| AUD/USD | -0.629 |
| USD/CAD | +0.613 |
| CAD/JPY | +0.300 |

= DXY 動くと **同じバー** で全 USD ペアが完全反応済み

### 結果 2: lag 1〜12 ではほぼゼロ

DXY → 全 USD ペアの lag 1+ 時間相関は **すべて |0.03| 以下** = ノイズと区別不可能。

| pair | lag 1 | lag 2 | lag 3 | lag 6 | lag 12 |
|---|---|---|---|---|---|
| EUR/USD | +0.015 | +0.006 | +0.006 | +0.003 | -0.005 |
| USD/JPY | +0.014 | +0.001 | -0.000 | +0.001 | +0.002 |
| GBP/USD | +0.009 | +0.008 | +0.010 | +0.001 | +0.001 |

11 × 11 マトリクス全部 lag 1 で |相関| 最大値 +0.034 (audusd→eurjpy)。
**0.05 以上の lead-lag ペアは 1 つも存在しない**。

### 解釈
- DXY/USD の動きは **1 時間後には完全に price in** されてる
- = retail tier の H1 粒度ではアービトラージ済み
- HFT (microsecond レベル) なら lead-lag 取れるが retail 不可能
- 「**米ドル後追い通貨**」は存在しない (少なくとも H1 粒度では)

### 副次的な観察
- USD/CAD の lag 0 相関が +0.613 と JPY 系よりは弱め (CAD は原油の影響受ける)
- AUD/USD と NZD/USD は cross-correlation 高め (= コモディティ通貨セット)
- これら使ったペアトレード (cointegration) は可能性あり、ただし実装複雑

### 結論
**lead-lag アプローチでの edge は無い**。市場が予想以上に効率的。

### 残ってる選択肢
- F. ML approach (まだ未試)
- G. ペアトレード / cointegration (例: AUD/USD と NZD/USD の比率乖離) — 実装複雑だが retail で edge 残ってると言われる領域
- I. 凍結

→ user 判断待ち

---

## 実験 11: cointegration ベース統計裁定 + 機会主義的選択

**日時**: 2026-06-15
**user 提案**: 「lead-lag 駄目なら、通貨の縛りやめて、間違いなさそうな時に間違いなさそうな通貨買う」
**仮説**: 各通貨ペアの spread z-score を毎時計算、|z| 最大のペアだけ trade すれば edge ?
**スクリプト**: `/tmp/fx_pairarb.mjs`、`/tmp/fx_pair_v2.mjs`

### 手法
1. 11 通貨ペアの全期間 corr で「partner」を fix:
   - usdjpy ↔ cadjpy (corr +0.885)
   - gbpjpy ↔ eurjpy (+0.967)
   - eurusd ↔ usdchf (-0.974)
   - audusd ↔ audjpy (+0.860)
   - nzdusd ↔ usdcad (-0.832)
   等
2. 毎 H1: spread = log(A) - β·log(B) を rolling 200 本回帰で算出 (look-ahead-free)
3. spread z-score 計算
4. **opportunistic 選択**: 全 11 ペアの中で |z| 最大だけ取る
5. mean reversion (revert) or momentum (順張り) で entry、ATR スケール TP/SL

### 結果 1: mean reversion (戻る方向にベット)

| zT | TP/SL | sig | wr | avg net | total |
|---|---|---|---|---|---|
| 2.0 | 1/1.5 | 7799 | **60.0%** | -1.0 | -8123 |
| 2.0 | 1/1 | 7799 | 49.1% | -1.3 | -10324 |
| 3.0 | 1/1 | 1866 | 51.2% | -0.5 | -900 |
| 勝ち組 only (gbpjpy/cadjpy/usdchf) | 1/1 | 4351 | 52.0% | -0.7 | -2833 |

**60% 勝率出る (revert + TP1/SL1.5)** が、TP:SL の非対称で平均 -1.0 pips/trade = **コスト負け**。
60% × 1 ATR + 40% × -1.5 ATR = 0 pips (= 期待値ゼロ)、cost -1 pip 引いて損失。

### 結果 2: momentum (順方向にベット)

| zT | TP/SL | sig | wr | avg net |
|---|---|---|---|---|
| 2.0 | 1/1 | 7799 | 46.6% | -2.1 |
| 2.0 | 1.5/1 | 7799 | 36.9% | -2.3 |
| 3.0 | 1/1 | 1866 | 45.1% | -2.9 |

momentum 方向は完全に死亡。spread 乖離は **mean reversion 寄り**だが reward が小さくコスト負け。

### Pair-level (best momentum config: zT=3 / TP=SL=ATR×1)
| pair | sig | wr | avg net |
|---|---|---|---|
| **usdcad** | 197 | **55.8%** | **+0.8** |
| usdjpy | 202 | 49.5% | +0.1 |
| nzdusd | 194 | 48.5% | -1.5 |
| その他 | ... | 40-48% | -1 〜 -6 |

USD/CAD だけ slightly positive。signals 197 / 1.4 年。**ただし他 10 ペアが負け** なので全体マイナス。
USD/CAD 単独でも +154 pips / 1.4 年 = 月 +10 pips ≒ 月 +1 円。
ノイズと区別不可能。

### 前後半 split (momentum |z|>3)
- 前半: 44.6% / -3.0 pips
- 後半: 46.1% / -2.6 pips
- → どっちもほぼ同じだけ負け = 安定的に edge 無い

### 結論

cointegration ベース統計裁定も **retail H1 粒度では edge 無し**。
- 60% 勝率は出るが TP/SL 非対称が打ち消す
- USD/CAD だけ slightly positive だが ノイズ範囲
- in-sample / out-of-sample で同じだけ負ける = regime fit ですらない、ただの負け

理論的考察:
- 統計裁定で edge 出すには通常 **両 leg simultaneously trading** が必要 (long A + short B)
- 単一 leg の trade では mean reversion 方向は当たるが reversion magnitude が cost を超えない
- = OANDA Japan retail にはアービトラージの余地が残ってない (HFT/banks が刈り取り済)

### 全実験 1-11 の総括 (= 学術コンセンサスの再現)

| アプローチ | 結果 |
|---|---|
| 単一指標 (RSI/EMA/BB) | edge 無し |
| MTF alignment | edge 無し |
| ATR スケール TP/SL | 中立 |
| 時間帯フィルタ | edge 無し |
| 通貨ペア変更 | 全 4 ペア edge 無し |
| lead-lag 後追い | 存在せず |
| 統計裁定 (cointegration) | edge 無し |

**retail H1 粒度の TA で edge を見つけることは事実上不可能**、を 11 実験で実証。
学術文献の通り。

### 残選択肢
- F. ML (overfitting 罠リスク高、実験 5/9/11 と同じパターンで死ぬ可能性大)
- **I. 凍結** ← 推奨

凍結する場合の収穫:
1. fx-bot ミニアプリ自体は完成 (UI / API / DB / backtest engine / 4 戦略 / AI 最適化ループ)
2. EXPERIMENTS.md = 「retail FX 戦略 検証実験記録」として価値ある
3. バックテスト作法の知見 (look-ahead bias / 統計バイアス / regime fit / コスト計上 / pessimistic 同バー両 touch) を実装に焼き込み済
4. 身銭ゼロで学術コンセンサスに到達

→ user 最終判断待ち

---

## メモ: バックテストの作法 (失敗から学んだこと)

1. **look-ahead bias check**: entry 価格は signal 算出後に取得可能な価格か?
2. **コスト計上**: spread + slippage 込みで TP/SL hit 判定する (閾値シフト + PnL から引く)
3. **同バー両 touch の扱い**: pessimistic に SL 優先 (現実の最悪を想定)
4. **timeout 時の PnL**: 0 ではなく実際の close 価格で評価
5. **in-sample / out-of-sample 分割**: 前半最適化 → 後半で確認 → 大差なければ本物
6. **LONG / SHORT 分けて見る**: regime 由来の片寄りを検知
7. **複数シード**: ランダムサンプリングのブレを観察
8. **絶対 signals 数**: 30 未満は判断材料にならない (= 単なる外れ値)

これ全部潰してからじゃないと「edge ある」と言えない。今回の RSI(5,15/65) 65% は
look-ahead bias で出てた嘘の数字 → 修正後 49% (= コイントス)。
