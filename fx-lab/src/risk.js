import { config } from "./config.js";
import { readTrades, countTradesToday } from "./log.js";

// 発注可否を判定。 reason は人間向けメモ。
export function shouldTrade({ decision, confidence }) {
  if (decision === "PASS") return { ok: false, reason: "AI が PASS" };
  if (confidence < config.trade.confidenceThreshold) {
    return { ok: false, reason: `confidence ${confidence.toFixed(2)} < 閾値 ${config.trade.confidenceThreshold}` };
  }
  const todayCount = countTradesToday();
  if (todayCount >= config.trade.maxTradesPerDay) {
    return { ok: false, reason: `1日上限 ${config.trade.maxTradesPerDay} に到達 (現在 ${todayCount})` };
  }
  if (config.trade.cooldownAfterLosses > 0) {
    const recent = readTrades(config.trade.cooldownAfterLosses);
    if (recent.length >= config.trade.cooldownAfterLosses) {
      const allLosses = recent.every((t) => Number(t.pnl) < 0);
      if (allLosses) {
        const lastAt = new Date(recent[recent.length - 1].at).getTime();
        const sinceMin = (Date.now() - lastAt) / 60000;
        if (sinceMin < config.trade.cooldownMinutes) {
          return {
            ok: false,
            reason: `連敗 ${recent.length} クールダウン中 (残り ${Math.round(config.trade.cooldownMinutes - sinceMin)} 分)`,
          };
        }
      }
    }
  }
  return { ok: true, units: config.trade.unitsPerTrade };
}
