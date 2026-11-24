// 本物の genba-lib (pglite) で、地図の画面に流す genba_graph_all / genba_graph の返り値 (fixture.json) を作る。check.mjs が使う
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node make-fixture.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createGenba } = await import(new URL("../../apps/keihi/server/genba-lib/index.js", import.meta.url).href);
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_PATH).href);
const db = new PGlite();
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
let clock = "2026-11-24";
const g = createGenba({ getPool: () => ({ query: (s, p) => db.query(s, p) }), createMcpHandler: () => () => {}, getDriveApi: async () => null, today: () => clock });
const call = (name, args = {}, by = "小西") => g.tools(by).find((t) => t.name === name).handler(args);
for (const n of ["恵比寿ファーマーズチキン", "いちご", "行田屋2号店", "銀座博品館", "勝どき", "入谷"]) await db.query(`INSERT INTO sites (name) VALUES ($1)`, [n]);
const people = [["横山", "BANAX設計部", "設計"], ["純一", "いちご運営", "客先"], ["辰巳", "タツケン", "元請け"], ["名取", null, "社内"], ["小西", null, "社内"], ["菊池", "大丁工業", "職人"], ["高橋", "高橋工業", "業者"], ["浦部", "浦部空調", "業者"], ["リッキー", "ダイノック", "職人"], ["城戸", "城戸製作所", "業者"], ["齊木", "さくら仮設", "業者"], ["平居", "FLAT", "元請け"]];
for (const [name, company, role] of people) await call("genba_contact_upsert", { name, company: company || undefined, role });
await call("genba_company_upsert", { name: "FLAT", role: "元請け" });
const add = (o) => call("genba_log_add", o);
const L = [
  { site: "恵比寿ファーマーズチキン", kind: "待ち", title: "高橋工業の室外機置き場の返事待ち", body: "返事が来たら横山さんに伝える", who: "高橋", due_on: "2026-11-27" },
  { site: "恵比寿ファーマーズチキン", kind: "待ち", title: "横山さんから空調の図面1枚待ち", body: "電話で依頼。浦部さんとの飛び込み位置の打合せ用", who: "横山" },
  { site: "恵比寿ファーマーズチキン", kind: "進捗", title: "室外機の置き場", body: "横山さんと浦部さんで屋上の置き場を確認した" },
  { site: "いちご", kind: "次やること", title: "純一さんと横山さんの日程調整", body: "受付カウンターの打ち合わせ日を 2 人で決める", due_on: "2026-11-26", who: "名取" },
  { site: "いちご", kind: "待ち", title: "横山さんにいちご設計の返事待ち", body: "12/19 オープン目標。図面とデザイン案のスケジュールを質問", who: "横山" },
  { site: "いちご", kind: "進捗", title: "いちご 受付カウンターの提案", body: "純一さんから「是非よろしく」", source_ref: "LINE:r1:m1", source: { channel: "LINE", room: "r1", sender: "純一", at: "2026-11-21T06:09:00Z" } },
  { site: "行田屋2号店", kind: "待ち", title: "横山さん：サインも27日同時施工できるか", body: "27日に同時施工で調整を、と送信", who: "横山" },
  { site: "行田屋2号店", kind: "課題", title: "行田屋2号店の看板の写真が見つからない", body: "FLAT の平居さんにも確認する", who: "小西", due_on: "2026-11-12" },
  { site: "行田屋2号店", kind: "進捗", title: "行田屋の看板 A/B", body: "横山さんに聞く", who: "名取" },
  { site: "銀座博品館", kind: "待ち", title: "外まわり看板10枚のデザインデータを待つ", body: "11/24 BANAX設計部で横山さんに依頼。リッキーさん施工は12/10ごろ", who: "横山", due_on: "2026-11-30" },
  { site: "銀座博品館", kind: "待ち", title: "日除幕・暖簾かけの内容を横山さんから待ち", body: "見積に反映する", who: "横山" },
  { site: "銀座博品館", kind: "決定", title: "什器図の確定", body: "辰巳さんと横山さんで確認。城戸さんへ送る", topic: "什器" },
  { site: "銀座博品館", kind: "進捗", title: "辰巳さんに連絡", body: "図面を送った。リッキーさんにも共有", who: "名取" },
  { site: "銀座博品館", kind: "次やること", title: "城戸さんに什器の見積を依頼", body: "辰巳さんの図面が確定したら", who: "小西", due_on: "2026-12-02" },
  { site: "勝どき", kind: "進捗", title: "管理組合の書類", body: "平居さんに送付", who: "名取" },
  { site: "入谷", kind: "課題", title: "足場解体日の連絡待ち", body: "齊木さんから連絡が来る", who: "小西", due_on: "2026-11-18" },
  { site: "入谷", kind: "進捗", title: "平居さんと打ち合わせ", body: "FLAT の工程を確認", who: "小西" },
];
for (const l of L) await add(l);
await call("genba_state_set", { entity: "横山", kind: "繁忙", body: "今週は動けない", starts_on: "2026-11-24", ends_on: "2026-11-29" });
await call("genba_state_set", { entity: "辰巳", kind: "不在", body: "出張", starts_on: "2026-12-01", ends_on: "2026-12-03" });
await call("genba_state_set", { entity: "銀座博品館", kind: "NG日", body: "搬入は 11/27 だけ不可", ends_on: "2026-11-27" });
// 画面が見る組み合わせを作る
const out = { all: {}, one: {} };
for (const days of [30, 60, 120]) for (const open of [false, true]) out.all[`${days}:${open}`] = await call("genba_graph_all", { days, open_only: open });
const nodes = out.all["60:false"].nodes;
for (const n of nodes) for (const days of [30, 60, 120]) out.one[`${n.key}:${days}`] = await call("genba_graph", { entity: { type: n.type, id: n.id }, days, depth: 1 });
fs.writeFileSync(path.join(process.env.OUT || HERE, "fixture.json"), JSON.stringify(out));
const a = out.all["60:false"];
console.log("nodes", a.nodes.length, "linked", a.counts.linked_nodes, "edges", a.edges.length, "states", a.nodes.filter((n) => n.state).map((n) => n.name).join(","));
console.log("横山", JSON.stringify(Object.keys(out.one).filter((k) => k.endsWith(":60")).slice(0, 3)));
const y = nodes.find((n) => n.name === "横山");
const gy = out.one[`${y.key}:60`];
console.log("横山 keys", Object.keys(gy).join(","), "open", gy.open_logs.length, "recent", gy.recent_logs.length, "sites", [...new Set([...gy.open_logs, ...gy.recent_logs].map((r) => r.site?.name))].join("/"));
console.log("abilities in json?", /abilit/.test(JSON.stringify(out)));
