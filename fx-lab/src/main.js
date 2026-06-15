import http from "node:http";
import { config } from "./config.js";
import { runTick } from "./trader.js";

const args = new Set(process.argv.slice(2));

function logResult(r) {
  const t = new Date().toISOString();
  if (r.placed) {
    console.log(`[${t}] PLACED ${r.side} fill=${r.fill_price} tp=${r.tp} sl=${r.sl} (${r.elapsed_ms}ms)`);
  } else if (r.skipped) {
    console.log(`[${t}] SKIP ${r.reason}`);
  } else {
    console.log(`[${t}] ?`, r);
  }
}

async function tickSafe() {
  try {
    const r = await runTick();
    logResult(r);
    return r;
  } catch (e) {
    console.error(`[${new Date().toISOString()}] tick ERROR:`, e?.stack || e?.message || e);
    return { error: String(e?.message || e) };
  }
}

// モード判定: --loop / PORT 指定 / その他 (1-shot)
if (args.has("--loop")) {
  console.log(`[fx-lab] loop mode: interval=${config.loop.intervalMs}ms instrument=${config.trade.instrument} env=${config.oanda.env}`);
  await tickSafe();
  setInterval(tickSafe, config.loop.intervalMs);
} else if (config.port > 0) {
  console.log(`[fx-lab] http mode: PORT=${config.port} instrument=${config.trade.instrument} env=${config.oanda.env}`);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/tick" && req.method === "POST") {
      const r = await tickSafe();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, instrument: config.trade.instrument, env: config.oanda.env }));
      return;
    }
    res.writeHead(404).end("not found");
  });
  server.listen(config.port);
} else {
  console.log(`[fx-lab] 1-shot mode (instrument=${config.trade.instrument} env=${config.oanda.env})`);
  const r = await tickSafe();
  process.exit(r.error ? 1 : 0);
}
