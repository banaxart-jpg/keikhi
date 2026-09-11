// 本番の採点 API にテストケースを投げて、期待点数帯に入るかを測る。
// 使い方: node seko-grade-run.mjs [--rubric rubric.txt] [--model gemini-2.5-pro] [--repeat 3] [--only Q1]
import fs from "fs";
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const rubric = opt("--rubric") ? fs.readFileSync(opt("--rubric"), "utf8") : undefined;
const model = opt("--model");
const repeat = Number(opt("--repeat", 1));
const only = opt("--only");
const thinking = opt("--thinking") != null ? Number(opt("--thinking")) : undefined;
const temperature = opt("--temperature") != null ? Number(opt("--temperature")) : undefined;
const concurrency = Number(opt("--concurrency", 2));
const ENDPOINT = opt("--endpoint", "https://keihi-api-734350696397.asia-northeast1.run.app/api/seko/debug-grade/kx9m2seko7vqt4wp8zh");

const spec = JSON.parse(fs.readFileSync(new URL("./grade-cases.json", import.meta.url), "utf8"));
let cases = spec.cases.filter((c) => !only || c.id.startsWith(only)).map((c) => ({
  id: c.id, ...spec.questions[c.q], user_answer: c.user_answer,
}));
const bands = Object.fromEntries(spec.cases.map((c) => [c.id, { band: c.band, label: c.label }]));

const runs = [];
for (let r = 0; r < repeat; r++) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cases, rubric, model, thinking, temperature, concurrency }) });
  if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1); }
  const j = await res.json();
  runs.push(j.results);
  console.error(`run ${r + 1}/${repeat}: ${Date.now() - t0}ms, model=${j.model}`);
}

// 集計: ケースごとに各 run の score、帯内か、ばらつき
let pass = 0, total = 0;
const rows = [];
for (const c of cases) {
  const scores = runs.map((rr) => rr.find((x) => x.id === c.id)).map((x) => (x && typeof x.score === "number") ? x.score : null);
  const { band, label } = bands[c.id];
  const valid = scores.filter((s) => s !== null);
  const inBand = valid.filter((s) => s >= band[0] && s <= band[1]).length;
  const ok = valid.length > 0 && inBand === valid.length;
  total++; if (ok) pass++;
  const spread = valid.length > 1 ? Math.max(...valid) - Math.min(...valid) : 0;
  const last = runs[runs.length - 1].find((x) => x.id === c.id);
  rows.push({ id: c.id, label, band: `${band[0]}-${band[1]}`, scores: scores.join("/"), spread, ok, src: last?.feedback?.source, ms: last?.ms,
    raw: (last && (last.error || (last.feedback?.source !== "ai" && last.raw))) ? `error=${last.error || ""} raw=${String(last.raw || "").slice(0, 300)}` : "",
    fb: last?.feedback ? `good=${JSON.stringify(last.feedback.good)} missing=${JSON.stringify(last.feedback.missing)} wrong=${JSON.stringify(last.feedback.wrong)} advice=${last.feedback.advice}` : (last?.error || "") });
}
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id.padEnd(14)} ${r.label.padEnd(8)} band ${r.band.padEnd(7)} got ${String(r.scores).padEnd(10)} spread ${String(r.spread).padEnd(3)} ${r.src} ${r.ms}ms`);
  if (!r.ok || args.includes("--verbose")) { console.log("      " + r.fb); if (r.raw) console.log("      " + r.raw); }
}
console.log(`\n${pass}/${total} in band`);
process.exit(pass === total ? 0 : 1);
