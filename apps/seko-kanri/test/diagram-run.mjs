// 図解 (SVG) の生成を本番 API で確認する。
// 使い方: node apps/seko-kanri/test/diagram-run.mjs [--out <dir>]
// 各ケースの SVG を取得して、サニタイズ済み・viewBox あり・答えが図に書かれていない、を検査する。
// --out を渡すと SVG を保存する (見た目を目で確認したいとき)。
import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const outDir = opt("--out", fs.mkdtempSync(path.join(os.tmpdir(), "seko-diagram-")));
const ENDPOINT = opt("--endpoint", "https://keihi-api-734350696397.asia-northeast1.run.app/api/seko/debug-diagram/kx9m2seko7vqt4wp8zh");

const CASES = [
  {
    id: "network",
    question: "図に示すネットワーク工程表において、クリティカルパスの所要日数として正しいものはどれか。",
    options: ["14 日", "16 日", "18 日", "20 日"],
    answer: "18 日",
    spec: "作業 A〜F のアローダイアグラム。イベント番号を丸で示し、矢線の上に作業名、下に所要日数 (A=4, B=6, C=3, D=5, E=8, F=2) を書く。分岐と合流を各 1 箇所つくる。",
    forbid: ["クリティカルパス", "CP", "18"],
  },
  {
    id: "beam",
    question: "図に示す単純梁 AB の点 C に集中荷重 P が作用したとき、支点 A の反力の大きさとして正しいものはどれか。",
    options: ["2 kN", "3 kN", "4 kN", "6 kN"],
    answer: "4 kN",
    spec: "スパン 6m の単純梁。左支点 A (△)、右支点 B (△)、A から 2m の位置 C に下向きの集中荷重 P = 6kN の矢印。寸法線で 2m と 4m を示す。",
    forbid: ["4 kN", "反力 ="],
  },
  {
    id: "rebar",
    question: "図に示す鉄筋コンクリート梁の断面において、かぶり厚さを示す寸法はどれか。",
    options: ["a", "b", "c", "d"],
    answer: "a",
    spec: "RC 梁の断面図。主筋 4 本とあばら筋を描き、コンクリート表面から最も外側の鉄筋までの距離に寸法記号 a、主筋間の距離に b、梁幅に c、梁高さに d を付ける。",
    forbid: ["かぶり厚さ", "正解"],
  },
  {
    id: "orita-ban",
    question: "重ね形折板葺に関する記述として、最も不適当なものはどれか。",
    options: [
      "タイトフレームは下地材に隅肉溶接で取り付けた",
      "折板の重ね部はボルト @600mm 程度で締結した",
      "けらば部は変形防止材を入れ、折板の山ピッチで取り付けた",
      "棟包みは折板の下に差し込み、ボルトでとめずシーリングのみで固定した",
    ],
    answer: "棟包みは折板の下に差し込み、ボルトでとめずシーリングのみで固定した",
    spec: "重ね形折板葺の断面構成図。梁 (下地材) の上にタイトフレーム、その上に折板、山の重ね部の位置、けらば納まり、棟包みを描き、タイトフレーム・折板・重ね部・けらば・棟包みを引出線でラベルする。",
    forbid: ["シーリングのみ", "不適当"],
  },
  {
    id: "keiryou-tenjo",
    question: "軽量鉄骨天井下地に関する記述として、最も不適当なものはどれか。",
    options: ["吊りボルトは間隔 900mm 程度とした", "野縁受けの間隔は 1,200mm 程度とした", "野縁は 300mm 程度の間隔で取り付けた", "下地張りのある場合の野縁間隔を 360mm 程度とした"],
    answer: "野縁受けの間隔は 1,200mm 程度とした",
    spec: "軽量鉄骨天井下地の構成図 (断面)。スラブからインサート・吊りボルト・ハンガー・野縁受け・野縁・天井ボードの順に描き、それぞれを引出線でラベルする。吊りボルトと野縁の間隔寸法線を入れる。",
    forbid: ["1,200", "不適当"],
  },
  {
    id: "bar-chart",
    question: "図に示すバーチャート工程表において、3 月末時点の出来高累計として最も近いものはどれか。",
    options: ["30%", "45%", "60%", "75%"],
    answer: "60%",
    spec: "縦に工事 (仮設・躯体・仕上・設備)、横に 1〜5 月の月列。各工事の施工期間を横棒で示し、月列の下に各月の出来高 (%) を数値で書く。3 月の列に縦の基準線を引く。",
    forbid: ["60%", "出来高累計 ="],
  },
];

const fails = [];
const ok = (c, l) => { console.log((c ? "PASS" : "FAIL") + " " + l); if (!c) fails.push(l); };

for (const c of CASES) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: c.question, options: c.options, answer: c.answer, spec: c.spec }),
  });
  if (!res.ok) { ok(false, `${c.id}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); continue; }
  const j = await res.json();
  ok(j.ok === true, `${c.id}: SVG 生成 (${j.ms}ms, ${j.bytes}B)`);
  if (!j.svg) continue;
  fs.writeFileSync(path.join(outDir, c.id + ".svg"), j.svg);
  ok(/^<svg[\s\S]*<\/svg>$/.test(j.svg.trim()), `${c.id}: svg 要素のみ`);
  ok(/viewBox\s*=/.test(j.svg), `${c.id}: viewBox あり`);
  ok(!/<\s*(script|foreignObject|image|use)\b/i.test(j.svg), `${c.id}: 危険要素なし`);
  ok((j.svg.match(/<text/g) || []).length >= 3, `${c.id}: 文字が入っている (${(j.svg.match(/<text/g) || []).length} 個)`);
  const leaked = c.forbid.filter((w) => j.svg.includes(w));
  ok(leaked.length === 0, `${c.id}: 答えが図に出ていない${leaked.length ? " (漏れ: " + leaked.join(", ") + ")" : ""}`);
}

console.log("\nSVG: " + outDir);
console.log(fails.length ? "FAILURES: " + fails.join(" | ") : "ALL PASS");
process.exit(fails.length ? 1 : 0);
