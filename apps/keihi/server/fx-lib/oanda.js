// OANDA v20 REST API クライアント (keihi-api 側、env からの key 取得は呼び元で行う)
// 全ての関数は { apiKey, accountId, baseUrl } の context を受け取る。

function buildHeaders(ctx) {
  return {
    Authorization: `Bearer ${ctx.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function get(ctx, path) {
  const r = await fetch(`${ctx.baseUrl}${path}`, { headers: buildHeaders(ctx) });
  if (!r.ok) throw new Error(`OANDA GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function post(ctx, path, body) {
  const r = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OANDA POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function put(ctx, path, body) {
  const r = await fetch(`${ctx.baseUrl}${path}`, {
    method: "PUT",
    headers: buildHeaders(ctx),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OANDA PUT ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function fetchCandles(ctx, instrument, granularity, count) {
  const j = await get(ctx,
    `/v3/accounts/${ctx.accountId}/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`
  );
  return (j.candles || [])
    .filter((c) => c.complete)
    .map((c) => ({
      time: c.time,
      o: Number(c.mid.o),
      h: Number(c.mid.h),
      l: Number(c.mid.l),
      c: Number(c.mid.c),
      v: c.volume,
    }));
}

export async function getOpenTrades(ctx, instrument) {
  const j = await get(ctx, `/v3/accounts/${ctx.accountId}/openTrades`);
  const all = j.trades || [];
  return instrument ? all.filter((t) => t.instrument === instrument) : all;
}

export async function fetchRecentClosedTrades(ctx, sinceIso) {
  const j = await get(ctx, `/v3/accounts/${ctx.accountId}/trades?state=CLOSED&count=50`);
  const trades = j.trades || [];
  return trades.filter((t) => !sinceIso || (t.closeTime && t.closeTime >= sinceIso));
}

function pipSize(instrument) {
  return instrument.endsWith("_JPY") ? 0.01 : 0.0001;
}

export async function getPricePrecision(ctx, instrument) {
  const j = await get(ctx, `/v3/accounts/${ctx.accountId}/instruments`);
  const ins = (j.instruments || []).find((x) => x.name === instrument);
  return ins?.displayPrecision ?? (instrument.endsWith("_JPY") ? 3 : 5);
}

export async function placeMarketWithOCO(ctx, {
  instrument, side, units, takeProfitPips, stopLossPips,
}) {
  const tickers = await get(ctx, `/v3/accounts/${ctx.accountId}/pricing?instruments=${instrument}`);
  const px = tickers.prices?.[0];
  if (!px) throw new Error("価格取得失敗");
  const mid = (Number(px.bids[0].price) + Number(px.asks[0].price)) / 2;
  const pip = pipSize(instrument);
  const precision = await getPricePrecision(ctx, instrument);
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
  const res = await post(ctx, `/v3/accounts/${ctx.accountId}/orders`, body);
  return {
    orderId: res.orderCreateTransaction?.id,
    fillId: res.orderFillTransaction?.id,
    fillPrice: res.orderFillTransaction?.price ? Number(res.orderFillTransaction.price) : null,
    tp: tpPrice,
    sl: slPrice,
    raw: res,
  };
}

// trade を即時クローズ (強制決済)
export async function closeTrade(ctx, tradeId) {
  return put(ctx, `/v3/accounts/${ctx.accountId}/trades/${tradeId}/close`, { units: "ALL" });
}

export async function getAccountSummary(ctx) {
  const j = await get(ctx, `/v3/accounts/${ctx.accountId}/summary`);
  return j.account;
}

// 指定 instrument の bid/ask/mid
// 期間指定で履歴 candle を全部取る (OANDA は 1 リクエスト 5000 本上限、ページネーション)
export async function fetchHistoricalCandles(ctx, instrument, granularity, fromIso, toIso) {
  const all = [];
  let from = fromIso;
  let safetyCounter = 0;
  while (safetyCounter++ < 50) {
    const j = await get(ctx,
      `/v3/accounts/${ctx.accountId}/instruments/${instrument}/candles?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toIso)}&granularity=${granularity}&price=M&count=5000`
    );
    const batch = (j.candles || []).filter((c) => c.complete).map((c) => ({
      time: c.time,
      o: Number(c.mid.o),
      h: Number(c.mid.h),
      l: Number(c.mid.l),
      c: Number(c.mid.c),
      v: c.volume,
    }));
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 5000) break;
    // 続きは最後の +1 秒から
    const lastT = new Date(batch[batch.length - 1].time).getTime();
    from = new Date(lastT + 1000).toISOString();
    if (new Date(from).getTime() >= new Date(toIso).getTime()) break;
  }
  return all;
}

export async function getCurrentPrice(ctx, instrument) {
  const j = await get(ctx, `/v3/accounts/${ctx.accountId}/pricing?instruments=${instrument}`);
  const px = j.prices?.[0];
  if (!px) throw new Error("price 取得失敗");
  return {
    bid: Number(px.bids[0].price),
    ask: Number(px.asks[0].price),
    mid: (Number(px.bids[0].price) + Number(px.asks[0].price)) / 2,
    time: px.time,
  };
}
