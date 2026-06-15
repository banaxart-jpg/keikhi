import { config } from "./config.js";

const base = config.oanda.baseUrl;
const acct = config.oanda.accountId;
const headers = {
  Authorization: `Bearer ${config.oanda.apiKey}`,
  "Content-Type": "application/json",
};

async function get(path) {
  const r = await fetch(`${base}${path}`, { headers });
  if (!r.ok) throw new Error(`OANDA GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OANDA POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// 直近 candleCount 本のローソク (mid 価格)
export async function fetchCandles(instrument, granularity, count) {
  const j = await get(
    `/v3/accounts/${acct}/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`
  );
  // OANDA は old → new の順で返す。new (最新) 順に整形して返す
  return (j.candles || [])
    .filter((c) => c.complete) // 進行中の足は不安定なので捨てる
    .map((c) => ({
      time: c.time,
      o: Number(c.mid.o),
      h: Number(c.mid.h),
      l: Number(c.mid.l),
      c: Number(c.mid.c),
      v: c.volume,
    }));
}

// 現在保有中の trade 数
export async function getOpenTradeCount(instrument) {
  const j = await get(`/v3/accounts/${acct}/openTrades`);
  return (j.trades || []).filter((t) => !instrument || t.instrument === instrument).length;
}

// 直近 24h で決済された trade のリスト (損益チェック用)
export async function fetchRecentClosedTrades(sinceIso) {
  const j = await get(`/v3/accounts/${acct}/trades?state=CLOSED&count=50`);
  const trades = j.trades || [];
  return trades.filter((t) => !sinceIso || t.closeTime >= sinceIso);
}

// pip 単位 (USD_JPY なら 0.01、EUR_USD なら 0.0001)
function pipSize(instrument) {
  return instrument.endsWith("_JPY") ? 0.01 : 0.0001;
}

// instrument の価格精度 (displayPrecision)
export async function getPricePrecision(instrument) {
  const j = await get(`/v3/accounts/${acct}/instruments`);
  const ins = (j.instruments || []).find((x) => x.name === instrument);
  return ins?.displayPrecision ?? (instrument.endsWith("_JPY") ? 3 : 5);
}

// 成行 + OCO (利確 / 損切) を 1 発で送る
// side: "LONG" | "SHORT"
export async function placeMarketWithOCO({
  instrument, side, units, takeProfitPips, stopLossPips,
}) {
  const tickers = await get(`/v3/accounts/${acct}/pricing?instruments=${instrument}`);
  const px = tickers.prices?.[0];
  if (!px) throw new Error("価格取得失敗");
  const mid = (Number(px.bids[0].price) + Number(px.asks[0].price)) / 2;
  const pip = pipSize(instrument);
  const precision = await getPricePrecision(instrument);
  const round = (v) => Number(v.toFixed(precision));
  const signedUnits = side === "LONG" ? Math.abs(units) : -Math.abs(units);
  const tpPrice = round(side === "LONG" ? mid + takeProfitPips * pip : mid - takeProfitPips * pip);
  const slPrice = round(side === "LONG" ? mid - stopLossPips * pip : mid + stopLossPips * pip);
  const body = {
    order: {
      type: "MARKET",
      instrument,
      units: String(signedUnits),
      timeInForce: "FOK",
      positionFill: "DEFAULT",
      takeProfitOnFill: { price: String(tpPrice) },
      stopLossOnFill: { price: String(slPrice) },
    },
  };
  const res = await post(`/v3/accounts/${acct}/orders`, body);
  return {
    orderId: res.orderCreateTransaction?.id,
    fillId: res.orderFillTransaction?.id,
    fillPrice: res.orderFillTransaction?.price ? Number(res.orderFillTransaction.price) : null,
    tp: tpPrice,
    sl: slPrice,
    raw: res,
  };
}

export async function getAccountSummary() {
  const j = await get(`/v3/accounts/${acct}/summary`);
  return j.account;
}
