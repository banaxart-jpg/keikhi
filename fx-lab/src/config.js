import "dotenv/config";

function req(key) {
  const v = process.env[key];
  if (!v) throw new Error(`env "${key}" 必須`);
  return v;
}
function num(key, def) {
  const v = process.env[key];
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env "${key}" は数値が必要 (受信: ${v})`);
  return n;
}

const env = process.env.OANDA_ENV === "live" ? "live" : "practice";

export const config = {
  oanda: {
    apiKey: req("OANDA_API_KEY"),
    accountId: req("OANDA_ACCOUNT_ID"),
    env,
    baseUrl: env === "live"
      ? "https://api-fxtrade.oanda.com"
      : "https://api-fxpractice.oanda.com",
  },
  gemini: {
    apiKey: req("GEMINI_API_KEY"),
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  },
  trade: {
    instrument: process.env.INSTRUMENT || "USD_JPY",
    granularity: process.env.GRANULARITY || "M5",
    candleCount: num("CANDLE_COUNT", 100),
    unitsPerTrade: num("UNITS_PER_TRADE", 1),
    takeProfitPips: num("TAKE_PROFIT_PIPS", 10),
    stopLossPips: num("STOP_LOSS_PIPS", 10),
    maxTradesPerDay: num("MAX_TRADES_PER_DAY", 20),
    confidenceThreshold: num("CONFIDENCE_THRESHOLD", 0.7),
    cooldownAfterLosses: num("COOLDOWN_AFTER_LOSSES", 3),
    cooldownMinutes: num("COOLDOWN_MINUTES", 60),
  },
  loop: {
    intervalMs: num("TICK_INTERVAL_MS", 300000),
  },
  port: num("PORT", 0),
};
