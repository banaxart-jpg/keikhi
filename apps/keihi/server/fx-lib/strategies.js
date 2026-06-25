// 決定的トレード戦略の定義集。AI を hot path から外す設計の核。
// 各戦略は decide(candles, params, instrument) → { decision, confidence, reasoning } を返す純粋関数。
//
// 共通インターフェース:
//   STRATEGIES[id] = {
//     name:         表示名
//     description:  1-2 文の説明
//     defaultParams: { ... } 初期値
//     paramSchema:  [{ key, label, min, max, step, type }] UI 自動生成用
//     decide:       (candles, params, instrument) => Result | Promise<Result>
//   }
// Result = { decision: "LONG"|"SHORT"|"PASS", confidence: 0-1, reasoning: string }
//
// AI 戦略だけは async + ctx.callGemini を受け取って Gemini 経由判定。

import { ema, rsi, atr, last } from "./indicators.js";

function pipSize(instrument) {
  return String(instrument || "").endsWith("_JPY") ? 0.01 : 0.0001;
}

function bollingerBands(closes, period = 20, mult = 2.0) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, x) => s + x, 0) / period;
    const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    out[i] = { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd, sd };
  }
  return out;
}

// ─── 戦略 1: EMA クロス (トレンドフォロー) ───
const ema_crossover = {
  name: "EMA クロス",
  description: "EMA 短期が EMA 長期を上抜けで LONG、下抜けで SHORT。トレンド相場向け。",
  defaultParams: { fast: 12, slow: 26, min_atr_pips: 3, conf_base: 0.7 },
  paramSchema: [
    { key: "fast", label: "EMA 短期", min: 3, max: 50, step: 1 },
    { key: "slow", label: "EMA 長期", min: 10, max: 200, step: 1 },
    { key: "min_atr_pips", label: "ATR 最小 (pips)", min: 0, max: 50, step: 0.5 },
    { key: "conf_base", label: "基本 confidence", min: 0.5, max: 0.95, step: 0.05 },
  ],
  decide(candles, params, instrument) {
    const p = { ...ema_crossover.defaultParams, ...params };
    const closes = candles.map((c) => c.c);
    const fastA = ema(closes, p.fast);
    const slowA = ema(closes, p.slow);
    const atrA = atr(candles, 14);
    if (fastA.length < 2 || slowA.length < 2) return pass("初期化中");
    const lf = last(fastA), pf = fastA[fastA.length - 2];
    const ls = last(slowA), ps = slowA[slowA.length - 2];
    const a = last(atrA);
    if (lf == null || ls == null || pf == null || ps == null) return pass("初期化中");
    const pip = pipSize(instrument);
    if (a != null && a / pip < p.min_atr_pips) return pass(`ATR 不足 (${(a/pip).toFixed(1)} < ${p.min_atr_pips} pips)`);
    const separationPips = Math.abs(lf - ls) / pip;
    const conf = Math.min(0.95, p.conf_base + Math.min(0.25, separationPips / 50));
    if (pf <= ps && lf > ls) {
      return { decision: "LONG", confidence: conf, reasoning: `EMA${p.fast} が EMA${p.slow} を上抜け (差 ${separationPips.toFixed(1)} pips)` };
    }
    if (pf >= ps && lf < ls) {
      return { decision: "SHORT", confidence: conf, reasoning: `EMA${p.fast} が EMA${p.slow} を下抜け (差 ${separationPips.toFixed(1)} pips)` };
    }
    return pass(`未クロス (fast=${lf.toFixed(3)}, slow=${ls.toFixed(3)})`);
  },
};

// ─── 戦略 2: RSI 逆張り (レンジ相場) ───
const rsi_mean_revert = {
  name: "RSI 逆張り",
  description: "RSI が oversold 以下で LONG、overbought 以上で SHORT。レンジ相場向け。",
  defaultParams: { period: 14, oversold: 30, overbought: 70, conf_base: 0.7 },
  paramSchema: [
    { key: "period", label: "RSI 期間", min: 5, max: 50, step: 1 },
    { key: "oversold", label: "売られ過ぎ閾値", min: 10, max: 40, step: 1 },
    { key: "overbought", label: "買われ過ぎ閾値", min: 60, max: 90, step: 1 },
    { key: "conf_base", label: "基本 confidence", min: 0.5, max: 0.95, step: 0.05 },
  ],
  decide(candles, params, instrument) {
    const p = { ...rsi_mean_revert.defaultParams, ...params };
    const closes = candles.map((c) => c.c);
    const r = rsi(closes, p.period);
    const lr = last(r);
    if (lr == null) return pass("初期化中");
    if (lr < p.oversold) {
      const conf = Math.min(0.95, p.conf_base + (p.oversold - lr) / 100);
      return { decision: "LONG", confidence: conf, reasoning: `RSI=${lr.toFixed(1)} < ${p.oversold} で売られ過ぎ` };
    }
    if (lr > p.overbought) {
      const conf = Math.min(0.95, p.conf_base + (lr - p.overbought) / 100);
      return { decision: "SHORT", confidence: conf, reasoning: `RSI=${lr.toFixed(1)} > ${p.overbought} で買われ過ぎ` };
    }
    return pass(`RSI=${lr.toFixed(1)} ニュートラル`);
  },
};

// ─── 戦略 3: ボリンジャーバンド突破 (順張りモメンタム) ───
const bb_breakout = {
  name: "BB ブレイク",
  description: "終値が BB 上抜けで LONG、下抜けで SHORT。突破モメンタム向け。",
  defaultParams: { period: 20, mult: 2.0, conf_base: 0.7 },
  paramSchema: [
    { key: "period", label: "期間", min: 10, max: 60, step: 1 },
    { key: "mult", label: "標準偏差倍率", min: 1.0, max: 3.5, step: 0.1 },
    { key: "conf_base", label: "基本 confidence", min: 0.5, max: 0.95, step: 0.05 },
  ],
  decide(candles, params, instrument) {
    const p = { ...bb_breakout.defaultParams, ...params };
    const closes = candles.map((c) => c.c);
    const bb = bollingerBands(closes, p.period, p.mult);
    const lb = last(bb);
    const lc = last(closes);
    if (lb == null) return pass("初期化中");
    const pip = pipSize(instrument);
    if (lc > lb.upper) {
      const excessPips = (lc - lb.upper) / pip;
      const conf = Math.min(0.95, p.conf_base + Math.min(0.25, excessPips / 30));
      return { decision: "LONG", confidence: conf, reasoning: `終値 ${lc.toFixed(3)} が BB 上限 ${lb.upper.toFixed(3)} 突破 (${excessPips.toFixed(1)} pips)` };
    }
    if (lc < lb.lower) {
      const excessPips = (lb.lower - lc) / pip;
      const conf = Math.min(0.95, p.conf_base + Math.min(0.25, excessPips / 30));
      return { decision: "SHORT", confidence: conf, reasoning: `終値 ${lc.toFixed(3)} が BB 下限 ${lb.lower.toFixed(3)} 突破 (${excessPips.toFixed(1)} pips)` };
    }
    return pass(`バンド内 (close=${lc.toFixed(3)})`);
  },
};

// ─── 戦略 4: AI (Gemini Vision) ───
// hot path で Gemini を呼ぶ「重い」戦略。バックテストでも全 tick 課金になるので注意。
// ctx.callGemini と ctx.buildChartSummary を inject で受け取る。
const ai_vision = {
  name: "AI 判断",
  description: "Gemini にチャート概況を渡して LONG/SHORT/PASS 判断 (重いので参考用)。",
  defaultParams: { model: "gemini-2.5-flash" },
  paramSchema: [],
  async decide(candles, params, instrument, ctx) {
    if (!ctx?.callGemini || !ctx?.buildChartSummary || !ctx?.aiDecide) {
      return pass("AI 戦略には ctx.callGemini / buildChartSummary / aiDecide が必要");
    }
    const text = ctx.buildChartSummary(candles, instrument, ctx.granularity || "M5");
    try {
      const r = await ctx.aiDecide(ctx.callGemini, text);
      return r;
    } catch (e) {
      return pass("AI 判断失敗: " + (e.message || String(e)).slice(0, 100));
    }
  },
};

// ─── 戦略 5: キャリー保有 (構造的 yield 狙い、TA じゃない edge) ───
// 高金利通貨ペアの上昇トレンド中だけ LONG 保有。スワップ累積を狙う長期戦略。
// JPY クロス (USDJPY、AUDJPY 等) でレバ 25 倍想定。
// ★ TA で edge 出ず、キャリーは構造的 (金利差) で唯一見つかった edge。
//   1.25 年 backtest で 6 JPY クロス buy & hold 合算 +14754 pips、ただし
//   Max DD -5134 pips → 証拠金バッファ ≥10x 必須。granularity=D 推奨。
// SHORT は出さない (低金利通貨買い = 逆スワップで負ける)。
const carry_hold = {
  name: "キャリー保有",
  description: "JPY クロスの上昇トレンド中だけ LONG 保有、スワップ累積狙い。日足推奨。SL 余裕 + 大きい証拠金バッファ必須。",
  defaultParams: { fast: 20, slow: 50, min_sep_pips: 3 },
  paramSchema: [
    { key: "fast", label: "EMA 短期", min: 5, max: 100, step: 1 },
    { key: "slow", label: "EMA 長期", min: 20, max: 200, step: 1 },
    { key: "min_sep_pips", label: "最小 EMA 乖離 (pips)", min: 0, max: 100, step: 1 },
  ],
  decide(candles, params, instrument) {
    const p = { ...carry_hold.defaultParams, ...params };
    const closes = candles.map((c) => c.c);
    const fastA = ema(closes, p.fast);
    const slowA = ema(closes, p.slow);
    const lf = last(fastA);
    const ls = last(slowA);
    if (lf == null || ls == null) return pass("EMA 初期化中");
    const pip = String(instrument || "").endsWith("_JPY") ? 0.01 : 0.0001;
    const sepPips = (lf - ls) / pip;
    // EMA 上昇トレンドで一定以上の乖離があれば LONG
    if (sepPips > p.min_sep_pips) {
      const conf = Math.min(0.95, 0.7 + Math.min(0.25, sepPips / 50));
      return {
        decision: "LONG",
        confidence: conf,
        reasoning: `EMA${p.fast} が EMA${p.slow} の +${sepPips.toFixed(1)} pips、上昇トレンド継続中。スワップ累積を狙って LONG 保有。`,
      };
    }
    return pass(`EMA 乖離 ${sepPips.toFixed(1)} pips ≤ ${p.min_sep_pips}、trend 弱・反転リスク → 保有見送り`);
  },
};

function pass(reason) {
  return { decision: "PASS", confidence: 0, reasoning: reason || "" };
}

export const STRATEGIES = {
  ema_crossover,
  rsi_mean_revert,
  bb_breakout,
  carry_hold,
  ai_vision,
};

export function strategyList() {
  return Object.entries(STRATEGIES).map(([id, s]) => ({
    id, name: s.name, description: s.description,
    defaultParams: s.defaultParams,
    paramSchema: s.paramSchema || [],
  }));
}

export async function runStrategy(strategyId, candles, params, instrument, ctx) {
  const strat = STRATEGIES[strategyId];
  if (!strat) return { decision: "PASS", confidence: 0, reasoning: `未知の戦略: ${strategyId}` };
  try {
    const r = await strat.decide(candles, params || {}, instrument, ctx || {});
    if (!r || !["LONG", "SHORT", "PASS"].includes(r.decision)) {
      return { decision: "PASS", confidence: 0, reasoning: "不正な戦略返り値" };
    }
    return {
      decision: r.decision,
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
      reasoning: String(r.reasoning || "").slice(0, 500),
    };
  } catch (e) {
    return { decision: "PASS", confidence: 0, reasoning: "戦略例外: " + (e.message || String(e)).slice(0, 100) };
  }
}
