import { config } from "./config.js";
import { fetchCandles, placeMarketWithOCO, getOpenTradeCount, fetchRecentClosedTrades } from "./oanda.js";
import { buildChartSummary } from "./chart.js";
import { decideFromChart } from "./ai.js";
import { shouldTrade } from "./risk.js";
import { logDecision, logTrade, readTrades } from "./log.js";

// 1 tick = 観測 → AI 判断 → リスクチェック → 発注 → ログ
export async function runTick() {
  const startedAt = Date.now();
  const { instrument, granularity, candleCount, takeProfitPips, stopLossPips } = config.trade;

  // 直近に決済された trade の損益を取り込み (前回 tick 以降)
  // 「連敗クールダウン」判定のためのログ
  try {
    const lastTradeAt = readTrades(1)[0]?.at;
    const sinceIso = lastTradeAt || new Date(Date.now() - 86400000).toISOString();
    const closed = await fetchRecentClosedTrades(sinceIso);
    for (const t of closed) {
      logTrade({
        kind: "closed",
        instrument: t.instrument,
        side: Number(t.initialUnits) > 0 ? "LONG" : "SHORT",
        units: Math.abs(Number(t.initialUnits)),
        entry_price: Number(t.price),
        close_time: t.closeTime,
        pnl: Number(t.realizedPL || 0),
        oanda_id: t.id,
      });
    }
  } catch (e) { console.warn("[trader] closed trade poll failed:", e.message); }

  // 既に同 instrument の open position があるなら新規発注スキップ
  const open = await getOpenTradeCount(instrument);
  if (open > 0) {
    logDecision({ skip: true, reason: `既に open trade ${open} 件あり`, instrument });
    return { skipped: true, reason: "open position あり" };
  }

  // 観測
  const candles = await fetchCandles(instrument, granularity, candleCount);
  if (candles.length < 50) {
    return { skipped: true, reason: `candle 不足 (${candles.length}本)` };
  }
  const chartText = buildChartSummary(candles, instrument, granularity);

  // AI 判断
  let decision;
  try {
    decision = await decideFromChart(chartText);
  } catch (e) {
    logDecision({ error: "ai", message: e.message, instrument });
    return { skipped: true, reason: "AI 失敗: " + e.message };
  }
  logDecision({
    instrument,
    granularity,
    last_close: candles[candles.length - 1].c,
    decision: decision.decision,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  // リスクチェック
  const judge = shouldTrade(decision);
  if (!judge.ok) {
    return { skipped: true, reason: judge.reason, decision };
  }

  // 発注
  let order;
  try {
    order = await placeMarketWithOCO({
      instrument,
      side: decision.decision,
      units: judge.units,
      takeProfitPips,
      stopLossPips,
    });
  } catch (e) {
    logTrade({ kind: "order_failed", instrument, side: decision.decision, error: e.message });
    return { skipped: true, reason: "発注失敗: " + e.message, decision };
  }

  logTrade({
    kind: "opened",
    instrument,
    side: decision.decision,
    units: judge.units,
    fill_price: order.fillPrice,
    tp: order.tp,
    sl: order.sl,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    oanda_order_id: order.orderId,
    oanda_fill_id: order.fillId,
  });

  return {
    placed: true,
    side: decision.decision,
    fill_price: order.fillPrice,
    tp: order.tp,
    sl: order.sl,
    elapsed_ms: Date.now() - startedAt,
  };
}
