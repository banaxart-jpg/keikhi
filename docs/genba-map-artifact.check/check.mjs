// 公開する地図のページ (docs/genba-map-artifact.html) を、本物のブラウザ (Chromium) で動かして確かめる。
// claude.ai の mcp capability の代わりに、make-fixture.mjs が作った本物の形の返り値を返す代役を入れる (合格条件: 「横山」を検索 → 点が強調され、右に注意と記録)
//   準備: npm i playwright d3@7.8.5 (Chromium が要る)  →  PGLITE_PATH=… node make-fixture.mjs  →  node check.mjs
//   環境変数: D3_PATH (既定 ./node_modules/d3/dist/d3.min.js)・FIXTURE (既定 ./fixture.json)・SHOTS (スクリーンショットの置き場。既定 ./shots)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.join(DIR, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const HERE = SHOTS;
const frag = fs.readFileSync(path.join(DIR, "..", "genba-map-artifact.html"), "utf8");
const doc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${frag}</body></html>`;
const fixture = fs.readFileSync(process.env.FIXTURE || path.join(DIR, "fixture.json"), "utf8");
const d3src = fs.readFileSync(process.env.D3_PATH || path.join(DIR, "node_modules/d3/dist/d3.min.js"), "utf8");
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 500) : ""); } };

const initScript = `
(() => {
  const FX = ${fixture};
  window.__calls = []; window.__inject = null; window.__mcpNull = ${"__MCPNULL__"};
  const SERVER = "自社MCP", ALLOWED = ["genba_graph_all", "genba_graph"];
  const err = (code, extra) => Object.assign(new Error(code), { code, message: code + " message", ...extra });
  const mock = {
    async callTool(server, tool, input, options) {
      window.__calls.push({ server, tool, input, options });
      await new Promise((r) => setTimeout(r, 30));
      if (server !== SERVER) throw err("server_not_connected");
      if (!ALLOWED.includes(tool)) throw err("not_in_manifest");
      const inj = window.__inject;
      if (inj && (!inj.tool || inj.tool === tool)) {
        if (inj.times != null) { if (inj.times <= 0) { window.__inject = null; } else { inj.times--; throw err(inj.code, inj.extra); } }
        else throw err(inj.code, inj.extra);
      }
      let obj;
      if (tool === "genba_graph_all") obj = FX.all[input.days + ":" + !!input.open_only];
      else obj = FX.one[input.entity.type + ":" + input.entity.id + ":" + input.days];
      if (!obj) throw err("tool_error", { message: "no fixture " + JSON.stringify(input) });
      return { content: [{ type: "text", text: JSON.stringify(obj) }], payload: obj };
    },
  };
  window.claude = { use: async (n) => (n === "mcp" && !window.__mcpNull ? mock : null) };
})();`;

const browser = await chromium.launch();
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, colorScheme: opts.scheme || "light", deviceScaleFactor: opts.dsf || 1 });
  await ctx.route(/cdnjs\.cloudflare\.com.*d3/, (r) => r.fulfill({ contentType: "application/javascript", body: d3src }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: "text/css", body: "" }));
  await ctx.route("http://page.test/", (r) => r.fulfill({ contentType: "text/html", body: doc }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(initScript.replace("__MCPNULL__", opts.mcpNull ? "true" : "false"));
  await page.goto("http://page.test/");
  return { ctx, page, errors };
}
const txt = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
const calls = (page) => page.evaluate(() => window.__calls);

// ── T1 読み込み
let { ctx, page, errors } = await open();
await page.waitForSelector(".node");
await page.waitForTimeout(1800);
const allFx = JSON.parse(fixture).all["60:false"];
const expectNodes = allFx.nodes.filter((n) => n.count > 0 || n.state).length;
ok((await page.$$(".node")).length === expectNodes && expectNodes === 20, `点 ${expectNodes} 個 (記録がある点 + 状態がある点) を描く`);
ok((await page.$$(".link")).length > 0 && await page.$eval("#gmsg", (e) => e.hidden), "線を描き、読み込み中の表示は消える");
ok((await page.$$(".node.t-contact circle.shape")).length > 0 && (await page.$$(".node.t-site rect.shape")).length > 0 && (await page.$$(".node.t-company rect.shape")).length > 0, "人は丸 (circle)・現場は四角 (rect)・会社はひし形");
ok((await page.$$(".node .ring")).length === allFx.nodes.filter((n) => n.state).length, "今の状態がある点は赤いリングで囲む");
const c0 = await calls(page);
ok(c0.length === 1 && c0[0].server === "自社MCP" && c0[0].tool === "genba_graph_all" && c0[0].input.days === 60 && c0[0].input.open_only === false, "最初の呼び出しは 自社MCP の genba_graph_all だけ (days=60, open_only=false)", c0);
await page.screenshot({ path: `${HERE}/01-idle-light.png` });

// ── T2 「横山」を検索 (合格条件)
await page.fill("#q", "横山");
await page.waitForSelector("#sugg:not([hidden]) li button");
const suggs = await txt(page, "#sugg li button");
ok(suggs.length >= 1 && suggs[0].includes("横山"), "検索欄に「横山」→ 候補の先頭が横山", suggs);
await page.press("#q", "Enter");
await page.waitForSelector(".node.sel");
await page.waitForSelector("#panel .state");
await page.waitForTimeout(700);
const selName = await page.$eval(".node.sel", (e) => e.getAttribute("aria-label"));
ok(/^人 横山/.test(selName), "横山さんの点が選ばれて強調される", selName);
const nDim = (await page.$$(".node.dim")).length, nLit = (await page.$$(".node:not(.dim)")).length;
const litNames = await page.$$eval(".node:not(.dim)", (els) => els.map((e) => e.getAttribute("aria-label").replace(/、.*/, "")));
ok(nDim > 0 && nLit >= 5 && litNames.some((n) => n.includes("いちご")) && litNames.some((n) => n.includes("銀座博品館")) && !litNames.some((n) => n.includes("入谷")), "その点と隣だけが濃く、ほかは薄くなる (入谷は薄い)", { nDim, nLit, litNames });
ok((await page.$$(".link.hot")).length > 0 && (await page.$$(".link.dim")).length > 0, "選んだ点につながる線だけ濃く、ほかは薄い");
const h2 = await page.$eval("#panel h2", (e) => e.textContent);
const stateTxt = await txt(page, "#panel .state");
ok(h2 === "横山" && stateTxt.length === 1 && stateTxt[0].includes("繁忙") && stateTxt[0].includes("今週は動けない") && stateTxt[0].includes("11/24〜11/29"), "右に、注意 (繁忙・今週は動けない・11/24〜11/29) が出る", { h2, stateTxt });
const order = await page.$eval("#panel", (p) => [...p.children].map((c) => c.className || c.tagName));
ok(order.indexOf("states") >= 0 && order.indexOf("states") < order.findIndex((c) => c === "H3"), "有効な状態はパネルの一番上 (記録より前)", order);
const recSites = await txt(page, "#panel .rec .r1");
ok(["いちご", "恵比寿ファーマーズチキン", "銀座博品館", "行田屋2号店"].every((n) => recSites.some((r) => r.includes(n))), "右に、4 現場の記録がまとまって出る", recSites.length);
const kinds = await txt(page, "#panel .rec .kind");
const firstClosed = kinds.findIndex((k) => !k.startsWith("未解決"));
ok(kinds.length >= 8 && kinds.slice(0, firstClosed < 0 ? kinds.length : firstClosed).every((k) => k.startsWith("未解決")) && kinds.some((k) => k.startsWith("未解決 待ち")), "未解決が先 (「未解決 待ち」など)・そのあとに直近の記録", kinds);
const chips = await txt(page, "#panel .chip");
ok(chips.some((c) => c.includes("銀座博品館")) && chips.some((c) => c.includes("辰巳")) && chips.every((c) => /\d+件/.test(c)), "よく一緒に出る人・現場 (件数つき) のチップ", chips);
const c1 = await calls(page);
const last = c1[c1.length - 1];
ok(last.tool === "genba_graph" && last.input.entity.type === "contact" && last.input.depth === 1 && last.input.days === 60, "パネルは genba_graph (entity=人の横山, days=60) を呼ぶ", last);
await page.screenshot({ path: `${HERE}/02-yokoyama-light.png` });

// ── T3 チップで移る / 空白で戻る
await page.click("#panel .chip:has-text('いちご')");
await page.waitForFunction(() => document.querySelector("#panel h2")?.textContent === "いちご" && document.querySelector("#panel .sub"));
ok((await page.$eval(".node.sel", (e) => e.getAttribute("aria-label"))).startsWith("現場 いちご"), "チップを押すとその点へ移る (いちご)");
ok((await txt(page, "#panel .sub"))[0].startsWith("現場"), "現場の基本情報 (現場)");
await page.mouse.click(640, 20 + 100);       // 図の空白
await page.waitForTimeout(100);
const idleH = await page.$eval("#panel h2", (e) => e.textContent);
const idleChips = await txt(page, "#panel .chip.warn");
ok(idleH.includes("点を押す") && idleChips.some((c) => c.includes("横山")) && idleChips.some((c) => c.includes("辰巳")) && (await page.$$(".node.dim")).length === 0, "空白を押すと選択が外れ、今の状態が出ている点 (横山・辰巳…) の一覧が出る", idleChips);

// ── T4 期間・未解決だけ・更新
await page.selectOption("#days", "120");
await page.waitForFunction(() => window.__calls.some((c) => c.tool === "genba_graph_all" && c.input.days === 120));
await page.check("#open");
await page.waitForFunction(() => window.__calls.some((c) => c.tool === "genba_graph_all" && c.input.open_only === true));
await page.waitForTimeout(500);
const nOpen = (await page.$$(".node")).length;
ok(nOpen > 0 && nOpen < expectNodes + 100, `期間 120 日・未解決だけ に変えると、その条件で読み直す (点 ${nOpen})`);
await page.uncheck("#open");
await page.selectOption("#days", "60");
await page.waitForTimeout(400);
await page.click("#reload");
await page.waitForFunction(() => window.__calls.some((c) => c.options && c.options.cache && c.options.cache.refresh));
ok(true, "更新ボタンは cache.refresh で読み直す");
const toolsUsed = [...new Set((await calls(page)).map((c) => c.tool))].sort();
ok(JSON.stringify(toolsUsed) === JSON.stringify(["genba_graph", "genba_graph_all"]), "呼ぶのは読み取り専用の 2 ツールだけ", toolsUsed);

// ── T5 ズーム・ドラッグ
const tr0 = await page.$eval("#svg > g", (g) => g.getAttribute("transform"));
await page.mouse.move(500, 400); await page.mouse.wheel(0, -400); await page.waitForTimeout(300);
const tr1 = await page.$eval("#svg > g", (g) => g.getAttribute("transform"));
ok(tr1 && tr1 !== tr0 && /scale\(1\.[0-9]+|scale\([2-9]/.test(tr1), "ホイールで拡大できる", { tr0, tr1 });
await page.click("#zfit"); await page.waitForTimeout(450);
const box = await page.$eval(".node.t-site", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const before = await page.$eval(".node.t-site", (e) => e.getAttribute("transform"));
await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 40, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.$eval(".node.t-site", (e) => e.getAttribute("transform"));
ok(before !== after && (await page.$$(".node.sel")).length === 0, "点をドラッグで動かせる (動かしただけでは選択されない)", { before, after });
// キーボード
await page.focus(".node.t-contact"); await page.keyboard.press("Enter");
await page.waitForSelector(".node.sel");
ok(true, "点にキーボードで入って Enter で選べる");
ok(!/能力|abilit/i.test(await page.evaluate(() => document.body.innerText)), "画面に能力評価は出ない");
ok(errors.length === 0, "ブラウザのエラーなし", errors);
await ctx.close();

// ── T6 エラーはコード別に出し分ける
const codes = [
  ["needs_reauth", "つなぎ直して", null], ["server_not_connected", "追加してから", null], ["not_in_manifest", "権限メニュー", null],
  ["approval_required", "「許可して読み込む」", "許可して読み込む"], ["server_unavailable", "少し待ってから", "もう一度"], ["tool_error", "message", "もう一度"],
];
for (const [code, snippet, btn] of codes) {
  const o = await open();
  await o.page.waitForSelector(".node");
  await o.page.evaluate((c) => { window.__inject = { tool: "genba_graph_all", code: c }; }, code);
  await o.page.click("#reload");
  await o.page.waitForSelector("#gmsg .errbox");
  const t = await o.page.$eval("#gmsg", (e) => e.innerText);
  const b = await o.page.$$eval("#gmsg .errbox button", (bs) => bs.map((x) => x.textContent));
  ok(t.includes(snippet) && (btn ? b.includes(btn) : b.length === 0), `エラー ${code}: コード別の文言${btn ? `と「${btn}」ボタン` : " (ボタンなし)"}`, { t: t.slice(0, 120), b });
  if (btn) { await o.page.evaluate(() => { window.__inject = null; }); await o.page.click("#gmsg .errbox button"); await o.page.waitForFunction(() => document.getElementById("gmsg").hidden); ok(true, `${code}: ボタンで読み直すと戻る`); }
  await o.ctx.close();
}
{ // 一時的な不通 (retryable) は 1 回だけ自動でやり直す
  const o = await open();
  await o.page.waitForSelector(".node");
  await o.page.evaluate(() => { window.__inject = { tool: "genba_graph_all", code: "server_unavailable", extra: { retryable: true, retryAfterMs: 50 }, times: 1 }; });
  const n0 = (await calls(o.page)).length;
  await o.page.click("#reload"); await o.page.waitForTimeout(1800);
  const n1 = (await calls(o.page)).length - n0;
  ok(n1 === 2 && await o.page.$eval("#gmsg", (e) => e.hidden), "retryable な不通は 1 回だけ自動でやり直し、戻れば表示を続ける", n1);
  await o.page.evaluate(() => { window.__inject = { tool: "genba_graph_all", code: "server_unavailable", extra: { retryable: true, retryAfterMs: 50 } }; });
  const m0 = (await calls(o.page)).length;
  await o.page.click("#reload"); await o.page.waitForTimeout(2200);
  ok((await calls(o.page)).length - m0 === 2 && (await o.page.$$("#gmsg .errbox")).length === 1, "やり直しても不通なら 2 回で止まり、ボタンを出す (無限に繰り返さない)");
  await o.ctx.close();
}
{ // パネルのエラーはパネルだけ
  const o = await open();
  await o.page.waitForSelector(".node"); await o.page.waitForTimeout(800);
  await o.page.evaluate(() => { window.__inject = { tool: "genba_graph", code: "tool_error" }; });
  await o.page.fill("#q", "横山"); await o.page.press("#q", "Enter");
  await o.page.waitForSelector("#panel .errbox");
  ok((await o.page.$$(".node")).length === 20 && (await o.page.$eval("#gmsg", (e) => e.hidden)), "パネルの読み込みが失敗しても、図はそのまま (失敗はパネルの中だけ)");
  await o.page.evaluate(() => { window.__inject = null; });
  await o.page.click("#panel .errbox button"); await o.page.waitForSelector("#panel .state");
  ok(true, "パネルのボタンで読み直せる");
  await o.ctx.close();
}
{ // コネクタが呼べない表示
  const o = await open({ mcpNull: true });
  await o.page.waitForSelector("#gmsg .box");
  ok((await o.page.$eval("#gmsg", (e) => e.innerText)).includes("コネクタを呼べません") && (await calls(o.page)).length === 0, "use(\"mcp\") が null のときは、呼ばずに案内だけ出す");
  await o.ctx.close();
}

// ── T7 スマホ幅・ダーク
{
  const o = await open({ viewport: { width: 390, height: 844 }, dsf: 2 });
  await o.page.waitForSelector(".node"); await o.page.waitForTimeout(1500);
  await o.page.fill("#q", "横山"); await o.page.press("#q", "Enter");
  await o.page.waitForSelector("#panel .state"); await o.page.waitForTimeout(900);
  const geo = await o.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, g: document.getElementById("graphWrap").getBoundingClientRect().bottom, p: document.getElementById("panel").getBoundingClientRect().top + window.scrollY }));
  ok(geo.sw <= geo.cw && geo.g <= geo.p + 2, "スマホ幅: 横にはみ出さず、図の下にパネルが縦に並ぶ", geo);
  await o.page.evaluate(() => window.scrollTo(0, 0));
  await o.page.screenshot({ path: `${HERE}/03-phone-top.png` });
  await o.page.evaluate(() => document.getElementById("panel").scrollIntoView());
  await o.page.screenshot({ path: `${HERE}/04-phone-panel.png` });
  ok(o.errors.length === 0, "スマホ幅でもブラウザのエラーなし", o.errors);
  await o.ctx.close();
}
{
  const o = await open({ scheme: "dark", dsf: 2 });
  await o.page.waitForSelector(".node"); await o.page.waitForTimeout(1600);
  await o.page.fill("#q", "横山"); await o.page.press("#q", "Enter");
  await o.page.waitForSelector("#panel .state"); await o.page.waitForTimeout(900);
  await o.page.screenshot({ path: `${HERE}/05-dark.png` });
  const bg = await o.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(bg === "rgb(18, 23, 28)", "ダーク: 背景はトークンの暗い色", bg);
  await o.ctx.close();
}
await browser.close();
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
