// つながり (log_links / entity_states / genba_graph / genba_graph_all / genba_state_*) のテスト。
// 本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ。日付は createGenba の today で差し替える
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/links.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
import { cautionText } from "./links.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 900) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

const db = new PGlite();
// 本番の sites は infra/schema.sql + index.js の ALTER (address / key_box / postal / done_at) でできる
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
const pool = { query: (s, p) => db.query(s, p) };
let clock = "2026-11-24";
const mk = () => createGenba({ getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); }, today: () => clock });
let g = mk(), cache = {};
const tools = (by) => (cache[by] ||= g.tools(by));
const call = (by, name, args = {}) => { const t = tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西", N = "名取";
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const add = (o, by = S) => call(by, "genba_log_add", o);
const find = (q) => call(S, "genba_contact_find", { query: q });
const graph = (o, by = S) => call(by, "genba_graph", o);
const linkKeys = (links) => (links || []).map((l) => `${l.type}:${l.name}:${l.role}`).sort();
const has = (links, type, name, role) => (links || []).some((l) => l.type === type && l.name === name && (!role || l.role === role));

// ───────────────────────── 0. 準備: 現場・連絡先・会社
for (const n of ["恵比寿ファーマーズチキン", "いちご", "行田屋2号店", "銀座博品館", "行田屋"]) await db.query(`INSERT INTO sites (name) VALUES ($1)`, [n]);
const up = (o) => call(S, "genba_contact_upsert", o);
const yokoyama = await up({ name: "横山", company: "BANAX設計部", role: "設計", trade: "設計" });
const junichi = await up({ name: "純一", company: "いちご運営", role: "客先" });
const tatsumi = await up({ name: "辰巳", company: "タツケン", role: "元請け" });
await up({ name: "名取", role: "社内" });
const kikuchi = await up({ name: "菊池", company: "大丁工業", role: "職人", aliases: ["バカボンさん"] });
await up({ name: "ギ", role: "職人", aliases: ["ギさん"] });                                      // 1 文字の名前は本文の照合に使わない
const takahashi = await up({ name: "高橋", company: "高橋工業", role: "業者", trade: "空調" });
await up({ name: "山田", company: "山田工務店", role: "職人", trade: "大工" });
await up({ name: "山田", company: "山田建設", role: "職人", trade: "解体" });
await up({ name: "鈴木", company: "鈴木電気", role: "職人", aliases: ["オート"] });
await up({ name: "佐藤", company: "佐藤塗装", role: "職人", aliases: ["オート"] });                // 同じ呼び名 (オート) が 2 人 → 本文の照合では決められない
await call(S, "genba_company_upsert", { name: "高橋工業", aliases: ["タカハシ工業"], role: "業者" });
await call(S, "genba_company_upsert", { name: "FLAT", aliases: ["ＦＬＡＴ"], role: "元請け" });
const siteId = async (n) => Number((await rows(`SELECT id FROM sites WHERE name=$1`, [n]))[0].id);
const [sEbisu, sIchigo, sGyoda, sGinza, sGyoda1] = await Promise.all(["恵比寿ファーマーズチキン", "いちご", "行田屋2号店", "銀座博品館", "行田屋"].map(siteId));
const iY = Number(yokoyama.id), iJ = Number(junichi.id), iTk = Number(takahashi.id);
const logCount = async () => (await rows(`SELECT count(*)::int AS n FROM genba_log`))[0].n;

// ───────────────────────── 1. マイグレーション
const cols = async (t) => (await rows(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t])).map((c) => c.column_name);
const llCols = await cols("log_links"), esCols = await cols("entity_states");
ok(["id", "log_id", "entity_type", "entity_id", "role", "auto", "created_at"].every((c) => llCols.includes(c)), "log_links の列: id / log_id / entity_type / entity_id / role / auto / created_at", llCols);
ok(["id", "entity_type", "entity_id", "kind", "body", "starts_on", "ends_on", "source_ref", "created_at", "voided_at"].every((c) => esCols.includes(c)), "entity_states の列: id / entity_type / entity_id / kind / body / starts_on / ends_on / source_ref / created_at / voided_at", esCols);
const l0 = await add({ site: "いちご", kind: "進捗", title: "準備の記録", body: "テスト" });
await throws(() => db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) VALUES ($1,'site',$2,'site',true)`, [l0.log.id, sIchigo]), /duplicate|unique/i, "同じ記録 × 同じ点は 1 本だけ (log_id × entity はユニーク)");
await throws(() => db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role) VALUES ($1,'room',1,'site')`, [l0.log.id]), /check|violat/i, "entity_type は contact / site / company だけ");
await throws(() => db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role) VALUES ($1,'contact',1,'boss')`, [l0.log.id]), /check|violat/i, "role は mentioned / sender / who / site だけ");
await throws(() => db.query(`INSERT INTO entity_states (entity_type, entity_id, kind, body) VALUES ('contact',1,'休み','x')`), /check|violat/i, "kind は 不在 / 繁忙 / NG日 / 注意 / その他 だけ");
ok((await rows(`SELECT value FROM genba_settings WHERE key='links_backfill_v2'`))[0].value.status === "done", "既存ログへの自動リンクは 1 度走って印が付く (空の DB では 0 件)");
await mk().ensureSchema();
ok(true, "2 回目のマイグレーションも落ちない");

// ───────────────────────── 2. 記録したら自動でリンクが張られる
// (合格条件 4)「純一さんと横山さんの日程調整」を記録 → 純一・横山・いちご に自動でつながる
let r = await add({ site: "いちご", kind: "次やること", title: "純一さんと横山さんの日程調整", body: "いちごの受付カウンターの打ち合わせ日を 2 人で決める", due_on: "2026-11-27", who: "名取" });
ok(has(r.links, "contact", "純一", "mentioned") && has(r.links, "contact", "横山", "mentioned") && has(r.links, "site", "いちご", "site") && has(r.links, "contact", "名取", "who"), "「純一さんと横山さんの日程調整」→ 純一・横山 (mentioned)・いちご (site)・名取 (who) に自動でつながる", r.links);
ok(r.links.every((l) => l.auto === true) && r.log.title === "純一さんと横山さんの日程調整" && r.log.id && r.site.name === "いちご" && r.duplicate === false, "返り値の links は auto=true。ログ・現場・duplicate は今まで通り", Object.keys(r));
const db1 = await rows(`SELECT entity_type, entity_id, role, auto FROM log_links WHERE log_id=$1 ORDER BY entity_type, entity_id`, [r.log.id]);
ok(db1.length === r.links.length && db1.every((x) => x.auto === true), "DB にも同じだけ入る (auto=true)", db1);
const logNote = r.log.id;
// さんの有無・かな/カナ・全角半角・会社の別名
r = await add({ site: "銀座博品館", kind: "進捗", title: "ばかぼんに電話", body: "ＦＬＡＴ とタカハシ工業の件。ばかぼん は夕方に折り返す", who: "名取" });
ok(has(r.links, "contact", "菊池", "mentioned") && has(r.links, "company", "FLAT", "mentioned") && has(r.links, "company", "高橋工業", "mentioned"), "かな・カナ・全角半角・「さん」の有無・会社の別名を吸収 (ばかぼん → 菊池 / ＦＬＡＴ → FLAT / タカハシ工業 → 高橋工業)", r.links);
r = await add({ site: "銀座博品館", kind: "進捗", title: "ギに送る", body: "ギさんにデータを送った。オートに確認する", who: "名取" });
ok(!has(r.links, "contact", "ギ") && !r.links.some((l) => l.type === "contact" && ["鈴木", "佐藤"].includes(l.name)), "2 文字未満の名前 (ギ) は対象外。同じ呼び名が 2 人にあるとき (オート) はどちらにも結ばない", r.links);
// 役割: sender (出どころの送り主) / who / site。同じ点が何通りかで出たら強い役割を残す
r = await add({ site: "いちご", kind: "進捗", title: "いちごの受付カウンター提案", body: "横山さんと打ち合わせた。いちごの納まりを確認", source_ref: "LINE:r1:m1", source: { channel: "LINE", room: "r1", sender: "横山", at: "2026-11-20T10:00:00Z" } });
ok(has(r.links, "contact", "横山", "sender") && r.links.filter((l) => l.name === "横山").length === 1 && has(r.links, "site", "いちご", "site"), "送り主 (source.sender) は sender。本文にも名前があっても 1 本だけ (強い役割)・自分の現場の名前が本文にあっても site のまま", r.links);
const dup = await add({ site: "いちご", kind: "進捗", title: "いちごの受付カウンター提案", body: "重複", source_ref: "LINE:r1:m1" });
ok(dup.duplicate === true && dup.links === undefined && (await rows(`SELECT count(*)::int AS n FROM log_links WHERE log_id=$1`, [r.log.id]))[0].n === r.links.length, "同じ source_ref の記録 (duplicate) は何も足さず、リンクも増えない");
// 現場: 行田屋2号店 と 行田屋 (最長一致)
r = await add({ site: "行田屋2号店", kind: "次やること", title: "行田屋2号店の看板を決める", body: "行田屋2号店の看板 A/B を横山さんに聞く", who: "横山", due_on: "2026-11-28" });
ok(has(r.links, "contact", "横山", "who") && has(r.links, "site", "行田屋2号店", "site") && !has(r.links, "site", "行田屋"), "「行田屋2号店」と書いて「行田屋」の現場と取り違えない (最長一致)", r.links);
r = await add({ site: "行田屋", kind: "進捗", title: "行田屋の件", body: "行田屋の下見" });
ok(has(r.links, "site", "行田屋", "site") && !has(r.links, "site", "行田屋2号店"), "「行田屋」だけなら行田屋 (2 号店には結ばない)");
// 手動: links:[{type, id か name}]
const before = await logCount();
await throws(() => add({ site: "いちご", kind: "進捗", title: "x", body: "y", links: [{ type: "room", name: "x" }] }), /type は/, "links の type が違えば、記録する前にエラー");
await throws(() => add({ site: "いちご", kind: "進捗", title: "x", body: "y", links: [{ type: "contact", name: "いない人XYZ" }] }), /見つからない/, "links の相手が見つからなければ、記録する前にエラー");
await throws(() => add({ site: "いちご", kind: "進捗", title: "x", body: "y", links: [{ type: "company", name: "FLAT", role: "who" }] }), /人にだけ/, "role=who は人にだけ");
await throws(() => add({ site: "いちご", kind: "進捗", title: "x", body: "y", links: [{ type: "contact", name: "山田" }] }), /候補が複数/, "同名が複数なら推測せず止まる");
ok((await logCount()) === before, "links が不正なときは記録も入らない");
r = await add({ site: "銀座博品館", kind: "決定", title: "什器図の確定", body: "什器の図面を確定する", topic: "什器", links: [{ type: "contact", id: iY }, { type: "company", name: "FLAT" }, { type: "contact", name: "辰巳", role: "who" }] });
ok(has(r.links, "contact", "横山", "mentioned") && has(r.links, "company", "FLAT", "mentioned") && has(r.links, "contact", "辰巳", "who") && r.links.filter((l) => l.type !== "site").every((l) => l.auto === false) && r.links.find((l) => l.type === "site").auto === true, "手で付けたリンクは auto=false で、返り値の links に出る (本文に名前が無くても付く)。現場は自動 (auto=true)", r.links);
const manualLog = r.log.id;
r = await add({ site: "銀座博品館", kind: "進捗", title: "横山さんに連絡", body: "横山さんに電話した", links: [{ type: "contact", id: iY, role: "who" }] });
ok(r.links.filter((l) => l.name === "横山").length === 1 && has(r.links, "contact", "横山", "who") && r.links.find((l) => l.name === "横山").auto === false, "自動で張れるものを手で付けたら、手のほうが優先 (auto=false)・1 本だけ", r.links);
// 既存の動き: 相手待ちの自動変換・重複ブロック・解決
r = await add({ site: "恵比寿ファーマーズチキン", kind: "次やること", title: "高橋工業の返事待ち", body: "室外機の置き場の返事が来たら横山さんに伝える", who: "高橋", due_on: "2026-11-27" });
ok(r.auto?.kind === "待ち" && r.log.kind === "待ち" && has(r.links, "contact", "高橋", "who") && has(r.links, "company", "高橋工業", "mentioned") && has(r.links, "contact", "横山", "mentioned"), "既存の動きは今まで通り (相手待ちの自動変換 auto=待ち)・リンクも付く", { auto: r.auto, links: r.links });
const waitId = r.log.id;
await throws(() => add({ site: "恵比寿ファーマーズチキン", kind: "次やること", title: "高橋工業の返事待ち", body: "同じ件" }), /重複かも/, "既存の「重複かも」のエラーも今まで通り");
// add_many
const many = await call(S, "genba_log_add_many", { site: "銀座博品館", items: [
  { kind: "進捗", title: "辰巳さんと横山さんの打ち合わせ", body: "什器の件" },
  { kind: "進捗", title: "辰巳さんに連絡", body: "図面を送った" },
] });
ok(many.added === 2 && many.results.every((x) => x.ok && Array.isArray(x.links) && x.links.length >= 2) && has(many.results[0].links, "contact", "辰巳") && has(many.results[0].links, "contact", "横山") && has(many.results[1].links, "contact", "辰巳"), "genba_log_add_many も各行にリンクが付く (返り値の results[].links)", many.results.map((x) => x.links));
// 失敗しても記録は残る
await db.query(`ALTER TABLE log_links RENAME TO log_links_tmp`);
r = await add({ site: "いちご", kind: "進捗", title: "リンク失敗のテスト", body: "横山さんの件" });
ok(r.log?.id && r.links === undefined && r.duplicate === false, "リンクを張れなくても記録は入る (既存の動きを止めない)", r);
await db.query(`ALTER TABLE log_links_tmp RENAME TO log_links`);
// 記録を直したら自動のリンクだけ張り直す
const fx = await add({ site: "いちご", kind: "進捗", title: "辰巳さんの件", body: "辰巳さんに確認", links: [{ type: "company", name: "FLAT" }] });
ok(has(fx.links, "contact", "辰巳", "mentioned"), "(準備) 辰巳さんの件");
await call(S, "genba_log_fix", { id: fx.log.id, title: "菊池さんの件", body: "菊池さんに確認" });
const afterFix = await rows(`SELECT l.entity_type, l.entity_id, l.role, l.auto FROM log_links l WHERE l.log_id=$1`, [fx.log.id]);
const fixNames = afterFix.map((x) => `${x.entity_type}:${x.entity_id}:${x.auto}`);
const autoPeople = afterFix.filter((x) => x.entity_type === "contact" && x.auto).map((x) => Number(x.entity_id));
ok(autoPeople.includes(Number(kikuchi.id)) && !autoPeople.includes(Number(tatsumi.id)) && afterFix.some((x) => x.entity_type === "company" && x.auto === false), "log_fix で本文を直すと自動のリンクを張り直す (菊池が付き、辰巳は外れる)・手で付けた FLAT は残る", fixNames);

// ───────────────────────── 3. 横山の記録を 4 つの現場に (合格条件 2 の下ごしらえ)
await add({ site: "恵比寿ファーマーズチキン", kind: "進捗", title: "室外機の置き場", body: "横山さんと屋上の置き場を確認した" });
await add({ site: "いちご", kind: "課題", title: "受付カウンターの納まり", body: "横山さんの図面と現場が合わない", who: "名取", due_on: "2026-11-26" });
const old = await add({ site: "銀座博品館", kind: "進捗", title: "昔の打ち合わせ", body: "横山さんと什器の打ち合わせ (古い)" });
await db.query(`UPDATE genba_log SET created_at = TIMESTAMP '2026-05-01 00:00:00+09' WHERE id=$1`, [old.log.id]);   // 200 日ほど前

// ───────────────────────── 4. 状態 (entity_states) の入力
await throws(() => call(S, "genba_state_set", { entity: "横山", kind: "休み", body: "x" }), /kind は/, "kind が 不在 / 繁忙 / NG日 / 注意 / その他 以外ならエラー");
await throws(() => call(S, "genba_state_set", { entity: "横山", kind: "繁忙", body: "" }), /body が必要/, "body が空ならエラー");
await throws(() => call(S, "genba_state_set", { entity: "横山", kind: "繁忙", body: "あ".repeat(301) }), /300 字/, "body 301 字はエラー");
await throws(() => call(S, "genba_state_set", { entity: "横山", kind: "繁忙", body: "x", starts_on: "11/24" }), /YYYY-MM-DD/, "日付の形が違えばエラー");
await throws(() => call(S, "genba_state_set", { entity: "横山", kind: "繁忙", body: "x", starts_on: "2026-11-29", ends_on: "2026-11-24" }), /前/, "ends_on が starts_on より前ならエラー");
await throws(() => call(S, "genba_state_set", { entity: "山田", kind: "注意", body: "x" }), /候補が複数/, "同名が複数なら止まる (候補を返す)");
await throws(() => call(S, "genba_state_set", { entity: "いない人XYZ", kind: "注意", body: "x" }), /見つからない/, "見つからなければエラー");
await throws(() => call(S, "genba_state_set", { entity: { id: 1 }, kind: "注意", body: "x" }), /type/, "id だけでは決められない (type も要る)");
// (合格条件 1) 横山に「繁忙・今週は動けない・11/24〜11/29」を入れると、genba_contact_find("横山") の先頭に注意が出る
const beforeFind = await find("横山");
ok(beforeFind.match.active_states.length === 0 && !/注意/.test(beforeFind.match.message_hint) && Array.isArray(beforeFind.match.linked_open), "(状態を入れる前) active_states は空・message_hint に注意なし。linked_open (配列) は付く");
const st = await call(S, "genba_state_set", { entity: "横山", kind: "繁忙", body: "今週は動けない", starts_on: "2026-11-24", ends_on: "2026-11-29" });
ok(st.state.id && st.state.kind === "繁忙" && st.state.body === "今週は動けない" && st.state.starts_on === "2026-11-24" && st.state.ends_on === "2026-11-29" && st.entity.name === "横山" && st.state.by === S && /active_states/.test(st.note), "状態を入れられる (繁忙・今週は動けない・11/24〜11/29)", st);
const fy = await find("横山");
ok(fy.match.active_states.length === 1 && fy.match.active_states[0].kind === "繁忙" && fy.match.active_states[0].ends_on === "2026-11-29", "genba_contact_find(\"横山\") の active_states に出る", fy.match.active_states);
ok(fy.match.message_hint.startsWith("注意: 横山さんは 11/24〜11/29 繁忙（今週は動けない）"), "message_hint の先頭に「注意: 横山さんは 11/24〜11/29 …」が付く", fy.match.message_hint.slice(0, 80));
ok(/小西に出す/.test(fy.match.message_hint) && /送る直前にそのルームの直近 5 件/.test(fy.match.message_hint), "注意のあとに、今まで通りの message_hint (直近 5 件を読む…) が続く");
ok(cautionText("横山", [{ starts_on: "2026-12-01", ends_on: null, kind: "不在", body: "出張" }]).startsWith("注意: 横山さんは 12/1〜 不在（出張）") && cautionText("横山", [{ starts_on: null, ends_on: "2026-12-05", kind: "NG日", body: "日曜" }, { starts_on: null, ends_on: null, kind: "注意", body: "朝は電話に出ない" }]).includes("〜12/5 NG日（日曜） / 期限なし 注意（朝は電話に出ない）"), "注意の書き方: 開始だけ・終了だけ・期限なし・複数");
const dupSt = await call(S, "genba_state_set", { entity: { type: "contact", id: iY }, kind: "NG日", body: "11/28 は先約", starts_on: "2026-11-28", ends_on: "2026-11-28", source_ref: "Plaud:1" });
const dupSt2 = await call(S, "genba_state_set", { entity: "contact:" + iY, kind: "NG日", body: "11/28 は先約", source_ref: "Plaud:1" });
ok(dupSt2.duplicate === true && dupSt2.state.id === dupSt.state.id && (await rows(`SELECT count(*)::int AS n FROM entity_states WHERE source_ref='Plaud:1'`))[0].n === 1, "同じ点・同じ source_ref は 2 回入らない (entity は {type,id} でも \"contact:12\" でも)");
ok((await find("横山")).match.active_states.length === 2, "状態が 2 つあれば 2 つ出る");
// 状態を取り消す
await call(S, "genba_state_void", { id: dupSt.state.id, reason: "間違い" });
ok((await find("横山")).match.active_states.length === 1 && (await rows(`SELECT voided_at FROM entity_states WHERE id=$1`, [dupSt.state.id]))[0].voided_at, "genba_state_void で出なくなる (消さずに隠す)");
await throws(() => call(S, "genba_state_void", { id: dupSt.state.id }), /取り消し済み/, "もう一度取り消すとエラー");
await throws(() => call(S, "genba_state_void", { id: 99999 }), /無い/, "存在しない id はエラー");
// 未来の状態 (これから始まる) も知らせる
const fut = await call(S, "genba_state_set", { entity: "辰巳", kind: "不在", body: "出張", starts_on: "2026-12-01", ends_on: "2026-12-03" });
const ft = (await find("辰巳")).match;
ok(ft.active_states[0].upcoming === true && /注意: 辰巳さんは 12\/1〜12\/3 不在（出張）/.test(ft.message_hint), "これから始まる状態は upcoming=true で出る (来週の NG をいま知らせる)");
// 他のツールの返り値 (find の候補が複数でも落ちない)
const ambiguous = await find("山田");
ok(ambiguous.match === null && ambiguous.candidates.length === 2 && ambiguous.candidates.every((c) => Array.isArray(c.active_states) && Array.isArray(c.linked_open)), "候補が複数のときも active_states / linked_open が付く (match=null は今まで通り)");

// ───────────────────────── 5. つながっている未解決の記録 (linked_open)
const lo = (await find("横山")).match.linked_open;
ok(lo.some((x) => x.id === Number(logNote) && x.role === "mentioned") && lo.some((x) => x.kind === "待ち" && x.role === "mentioned") && lo.every((x) => ["課題", "次やること", "待ち"].includes(x.kind)), "linked_open: 本文に名前が出る未解決 (次やること・待ち・課題) も含む。役割 (role) が付く", lo.map((x) => [x.id, x.kind, x.role]));
ok(!lo.some((x) => x.kind === "進捗" || x.kind === "決定") && lo.every((x) => x.title && x.at), "進捗・決定は入らない / 題と日付が付く");
await add({ site: "恵比寿ファーマーズチキン", kind: "解決", resolves_id: waitId, title: "室外機の置き場の返事が来た", body: "高橋工業から返事あり。横山さんに伝えた" });
ok(!(await find("横山")).match.linked_open.some((x) => x.id === waitId), "解決した記録は linked_open から消える");

// ───────────────────────── 6. genba_graph (合格条件 2・3)
let gr = await graph({ query: "横山" });
ok(Object.keys(gr)[0] === "active_states" && gr.active_states.length === 1 && /^注意: 横山さんは/.test(gr.warning), "genba_graph(\"横山\"): 今有効な状態が一番上 (active_states) + warning", Object.keys(gr));
ok(gr.entity.type === "contact" && gr.entity.name === "横山" && gr.entity.company === "BANAX設計部" && gr.entity.role === "設計", "基本情報");
const sitesOf = (list) => [...new Set(list.map((x) => x.site?.name).filter(Boolean))].sort();
const all4 = sitesOf([...gr.open_logs, ...gr.recent_logs]);
ok(["いちご", "行田屋2号店", "恵比寿ファーマーズチキン", "銀座博品館"].every((n) => all4.includes(n)), "(合格条件) 恵比寿・いちご・行田屋2号店・銀座博品館 の記録がまとめて出る", all4);
ok(gr.open_logs.length >= 3 && gr.open_logs.every((x) => ["課題", "次やること", "待ち"].includes(x.kind)) && gr.open_logs.every((x) => x.title && x.at && x.body.length <= 81), "つながっている未解決の記録 (open_logs): 種類・題・日付・本文の頭");
ok(gr.recent_logs.every((x) => !gr.open_logs.some((o) => o.id === x.id)) && gr.recent_logs.length >= 3, "直近の記録 (recent_logs) は open_logs と重ならない");
ok(!gr.recent_logs.some((x) => x.id === old.log.id), "days=60 より古い記録 (200 日前) は recent_logs に出ない");
ok(gr.open_logs.map((x) => x.due_on).filter(Boolean).every((d, i, a) => i === 0 || a[i - 1] <= d), "未解決は期限の近い順");
ok(gr.neighbors.sites.map((s) => s.name).includes("銀座博品館") && gr.neighbors.sites.every((s) => s.count >= 1) && gr.neighbors.people.some((p) => p.name === "辰巳") && gr.neighbors.companies.some((c) => c.name === "FLAT") && gr.neighbors.sites.map((s) => s.count).every((c, i, a) => i === 0 || a[i - 1] >= c), "1 段先の点: 一緒に出る人・現場・会社と件数 (多い順)", gr.neighbors);
ok(gr.depth === 1 && gr.days === 60 && gr.depth2 === undefined, "既定は depth=1・days=60 (depth2 は無い)");
const g2 = await graph({ query: "横山", depth: 2 });
ok(Array.isArray(g2.depth2) && g2.depth2.length > 0 && g2.depth2.every((d) => d.via.name && d.neighbors && !JSON.stringify(d.neighbors).includes('"横山"')), "depth=2: 2 段先 (via 付き)。中心の横山は入らない", g2.depth2?.slice(0, 1));
const g200 = await graph({ query: "横山", days: 365 });
ok(g200.recent_logs.some((x) => x.id === old.log.id), "days=365 なら 200 日前の記録も出る");
// 現場・会社からも引ける
const gs = await graph({ query: "いちご" });
ok(gs.entity.type === "site" && gs.entity.name === "いちご" && gs.neighbors.people.some((p) => p.name === "横山") && gs.neighbors.people.some((p) => p.name === "純一"), "現場の名前でも引ける (いちご → 横山・純一 が隣に出る)");
const gc = await graph({ entity: { type: "company", name: "高橋工業" } });
ok(gc.entity.type === "company" && gc.entity.name === "高橋工業" && [...gc.open_logs, ...gc.recent_logs].length >= 1, "会社も引ける (entity={type, name})");
const gid = await graph({ entity: { type: "contact", id: iJ } });
ok(gid.entity.name === "純一" && (await graph({ entity: `人:${iJ}` })).entity.id === iJ && (await graph({ entity: "contact:" + iJ })).entity.id === iJ, "entity は {type, id} でも文字列 (人:12 / contact:12) でもよい");
const gam = await graph({ query: "山田" });
ok(gam.ambiguous === true && gam.candidates.filter((c) => c.type === "contact").length === 2 && gam.candidates.some((c) => c.type === "company") && gam.candidates.every((c) => c.id && c.label) && gam.open_logs === undefined, "名前が複数の点に当たるときは ambiguous + candidates だけ (推測しない。人 2 人と、同じ名前の会社も候補に出る)", gam);
await db.query(`INSERT INTO sites (name) VALUES ('横山邸')`);
const gpick = await graph({ query: "横山" });
ok(gpick.entity?.type === "contact" && gpick.entity.name === "横山", "人の「横山」(完全一致) と現場の「横山邸」(前方一致) なら、完全一致の人を選ぶ");
await throws(() => graph({}), /query/, "query も entity も無ければエラー");
await throws(() => graph({ query: "いない人XYZ" }), /見つからない/, "見つからなければエラー");
// (合格条件 3) 日付を 11/30 にすると、その状態は出なくなる (ends_on 11/29 まで有効)
clock = "2026-11-29";
ok((await find("横山")).match.active_states.some((s) => s.ends_on === "2026-11-29") && (await graph({ query: "横山" })).active_states.length >= 1, "11/29 (ends_on の日) までは出る");
clock = "2026-11-30";
const f30 = (await find("横山")).match;
ok(f30.active_states.length === 0 && !/注意/.test(f30.message_hint), "(合格条件) 日付を 11/30 にすると、状態は active_states にも message_hint にも出ない", { states: f30.active_states, hint: f30.message_hint.slice(0, 40) });
const g30 = await graph({ query: "横山" });
ok(g30.active_states.length === 0 && g30.warning === undefined && g30.today === "2026-11-30", "genba_graph にも出ない (active_states 空・warning なし)");
ok((await call(S, "genba_graph_all", {})).nodes.find((n) => n.name === "横山" && n.type === "contact").state === false, "genba_graph_all の state も false になる");
ok((await rows(`SELECT count(*)::int AS n FROM entity_states WHERE entity_id=$1 AND entity_type='contact' AND voided_at IS NULL`, [iY]))[0].n >= 1, "期限が過ぎた状態は消えていない (返さないだけ)");
clock = "2026-11-24";

// ───────────────────────── 7. genba_status に状態
await call(S, "genba_state_set", { entity: "銀座博品館", kind: "NG日", body: "搬入は 11/27 だけ不可 (管理組合)", ends_on: "2026-11-27" });
const stt = await call(S, "genba_status", { site: "銀座博品館" });
ok(stt.active_states?.length === 1 && stt.active_states[0].kind === "NG日" && stt.people_states?.some((p) => p.contact.name === "横山" && p.states.length >= 1) && stt.people_states.some((p) => p.contact.name === "辰巳" && p.states[0].upcoming), "genba_status(site): その現場の状態 (active_states) と、関わる人 (この現場の who・送り主・登録済みの人) の状態 (people_states)", { a: stt.active_states, p: stt.people_states?.map((p) => p.contact.name) });
ok(["site", "today", "notes", "contacts", "last_update", "recent_progress", "open_issues", "todos", "waiting", "decisions", "counts"].every((k) => k in stt), "genba_status の今までの項目はそのまま");
const sti = await call(S, "genba_status", { site: "いちご" });
ok(!("active_states" in sti), "状態が無い現場では項目を足さない (今まで通りの返り値)");

// ───────────────────────── 8. genba_graph_all
const ga = await call(S, "genba_graph_all", {});
ok(ga.days === 60 && Array.isArray(ga.nodes) && Array.isArray(ga.edges) && ga.counts.nodes === ga.nodes.length, "genba_graph_all: nodes / edges を 1 回で返す");
const nY = ga.nodes.find((n) => n.name === "横山" && n.type === "contact"), nI = ga.nodes.find((n) => n.name === "いちご" && n.type === "site"), nF = ga.nodes.find((n) => n.name === "FLAT" && n.type === "company");
ok(nY && nI && nF && nY.key === `contact:${iY}` && nY.count >= 5 && nY.state === true && nI.count >= 4 && nI.state === false && nF.count >= 2 && ["contact", "site", "company"].every((t) => ga.nodes.some((n) => n.type === t)), "点: 人・現場・会社の全部。種類・名前・つながる記録の件数・有効な状態の有無", [nY, nI, nF]);
const eYI = ga.edges.find((e) => [e.a, e.b].sort().join() === [nY.key, nI.key].sort().join());
ok(eYI && eYI.count >= 3 && ga.edges.every((e) => e.count >= 1 && ga.nodes.some((n) => n.key === e.a) && ga.nodes.some((n) => n.key === e.b) && e.a !== e.b), "線: 2 つの点が一緒に出てくる記録の数 (横山 × いちご ≥ 3)。両端は nodes にある", eYI);
const eKeys = ga.edges.map((e) => [e.a, e.b].sort().join("|"));
ok(new Set(eKeys).size === eKeys.length, "線は 1 組に 1 本だけ");
ok(!ga.edges.some((e) => e.a.startsWith("contact:") && e.b.startsWith("contact:") && ga.nodes.find((n) => n.key === e.a)?.name === "オート"), "(呼び名が 2 人に付いた「オート」は結ばれていない)");
const gaOpen = await call(S, "genba_graph_all", { open_only: true });
ok(gaOpen.open_only === true && gaOpen.nodes.find((n) => n.key === nY.key).count < nY.count && gaOpen.nodes.find((n) => n.key === nY.key).count >= 2 && gaOpen.edges.length > 0, "open_only: 未解決の記録だけを数える (件数が減る)", [gaOpen.nodes.find((n) => n.key === nY.key).count, nY.count]);
await db.query(`UPDATE genba_log SET created_at = TIMESTAMP '2026-10-01 00:00:00+09' WHERE id=$1`, [logNote]);
const gaOld = await call(S, "genba_graph_all", { days: 30 });
ok(gaOld.nodes.find((n) => n.key === nY.key).count < nY.count, "days が短いと古い記録は数えない");
const gaOpenOld = await call(S, "genba_graph_all", { days: 1, open_only: true });
ok(gaOpenOld.nodes.find((n) => n.key === nY.key).count === gaOpen.nodes.find((n) => n.key === nY.key).count, "open_only のときは期間に関係なく未解決を全部数える");
await db.query(`UPDATE genba_log SET created_at = now() WHERE id=$1`, [logNote]);

// ───────────────────────── 9. 能力評価はグラフに出ない (genba_contact_find は今まで通り)
await call(S, "genba_contact_ability_set", { contact: iY, scores: { 力: 4, 信用: 5 }, reasons: { 力: "秘密の理由XYZ" }, note: "秘密のひとことXYZ" });
const secret = JSON.stringify([await graph({ query: "横山" }), await graph({ query: "横山", depth: 2 }), await call(S, "genba_graph_all", {}), await call(S, "genba_graph_all", { open_only: true }), await call(S, "genba_status", { site: "銀座博品館" })]);
ok(!/abilit|秘密の理由XYZ|秘密のひとことXYZ|ability_avg/.test(secret), "genba_graph / genba_graph_all (と genba_status) の返り値に能力評価は出ない");
const fab = (await find("横山")).match;
ok(fab.abilities?.length === 1 && fab.abilities[0].scores["力"] === 4 && fab.ability_avg["力"] === 4, "genba_contact_find の abilities は今まで通り (能力の機能は変わらない)");

// ───────────────────────── 10. バックフィル: 既存の全ログに自動リンク
// 今ある自動リンクを控えて、リンクを全部消し、(手で付けたものを 1 つ残して) 印を消す → 新しいプロセス相当で動かす
const snap = (await rows(`SELECT log_id, entity_type, entity_id, role FROM log_links WHERE auto=true ORDER BY log_id, entity_type, entity_id`)).map((x) => `${x.log_id}|${x.entity_type}|${x.entity_id}|${x.role}`);
const manualRows = await rows(`SELECT log_id, entity_type, entity_id, role FROM log_links WHERE auto=false ORDER BY log_id, entity_type, entity_id`);
const logsBefore = JSON.stringify(await rows(`SELECT id, kind, title, body, who, site_id, source, topic FROM genba_log ORDER BY id`));
// 昔から入っていたログ (リンクの仕組みの前に入ったもの) を直接入れる
await db.query(`INSERT INTO genba_log (site_id, kind, body, written_by, who, title) VALUES ($1,'進捗','純一さんと横山さんが来る (昔のログ)','小西','辰巳','昔のログ')`, [sIchigo]);
await db.query(`INSERT INTO genba_log (site_id, kind, body, written_by, source, title) VALUES ($1,'進捗','資料を送った (昔のログ 2)','小西',$2::jsonb,'昔のログ 2')`, [sGinza, JSON.stringify({ sender: "辰巳", room: "rx" })]);
await db.query(`DELETE FROM log_links`);
for (const m of manualRows) await db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) VALUES ($1,$2,$3,$4,false)`, [m.log_id, m.entity_type, m.entity_id, m.role]);
await db.query(`DELETE FROM genba_settings WHERE key='links_backfill_v2'`);
const nLogs = await logCount();
g = mk(); cache = {};
const bf0 = await call(S, "genba_links_backfill", {});                // 新しいプロセスの最初の呼び出し → ensureSchema の中で自動で 1 回走る
ok(bf0.status === "done" && bf0.logs === nLogs && bf0.inserted > 0 && Array.isArray(bf0.people) && Array.isArray(bf0.sites), "新しい版を最初に使ったとき、全ログに自動リンクが 1 回かかる (印 links_backfill_v2)", { status: bf0.status, logs: bf0.logs, nLogs, inserted: bf0.inserted });
const snap2 = (await rows(`SELECT log_id, entity_type, entity_id, role FROM log_links WHERE auto=true ORDER BY log_id, entity_type, entity_id`)).map((x) => `${x.log_id}|${x.entity_type}|${x.entity_id}|${x.role}`);
const newOnes = snap2.filter((x) => !snap.includes(x)), lostOnes = snap.filter((x) => !snap2.includes(x));
ok(lostOnes.length === 0 && newOnes.length > 0, "記録のときに張ったリンクは全部、バックフィルでも張られる (取りこぼしなし)・昔のログにも新しく張られる", { lost: lostOnes.slice(0, 5), n: newOnes.length });
const oldLog = (await rows(`SELECT id FROM genba_log WHERE title='昔のログ'`))[0].id, oldLog2 = (await rows(`SELECT id FROM genba_log WHERE title='昔のログ 2'`))[0].id;
const oldLinks = (await rows(`SELECT entity_type, entity_id, role, auto FROM log_links WHERE log_id=$1`, [oldLog])).map((x) => `${x.entity_type}:${x.entity_id}:${x.role}:${x.auto}`);
ok(oldLinks.includes(`contact:${iJ}:mentioned:true`) && oldLinks.includes(`contact:${iY}:mentioned:true`) && oldLinks.includes(`site:${sIchigo}:site:true`) && oldLinks.includes(`contact:${Number(tatsumi.id)}:who:true`), "昔のログ: 現場 (site)・who・本文の名前 (mentioned) に auto=true で張られる", oldLinks);
ok((await rows(`SELECT role FROM log_links WHERE log_id=$1 AND entity_type='contact' AND entity_id=$2`, [oldLog2, Number(tatsumi.id)]))[0]?.role === "sender", "送り主 (source.sender) は sender で張られる");
const manualAfter = await rows(`SELECT log_id, entity_type, entity_id, role FROM log_links WHERE auto=false ORDER BY log_id, entity_type, entity_id`);
ok(manualAfter.length === manualRows.length && manualRows.length >= 3 && JSON.stringify(manualAfter) === JSON.stringify(manualRows), "手で付けたリンク (auto=false) は残る");
ok(JSON.stringify(await rows(`SELECT id, kind, title, body, who, site_id, source, topic FROM genba_log WHERE title NOT LIKE '昔のログ%' ORDER BY id`)) === logsBefore, "ログの中身はバックフィルで変わらない (リンクを足すだけ)");
const pY = bf0.people.find((x) => x.name === "横山"), sI = bf0.sites.find((x) => x.name === "いちご");
ok(pY && pY.links >= 6 && sI && sI.links >= 4 && bf0.people.every((x, i, a) => i === 0 || a[i - 1].links >= x.links) && bf0.sites.length === 5, "人・現場ごとのリンク件数が出る (多い順)", { pY, sI, sites: bf0.sites.map((x) => x.name) });
const bfRead = await call(N, "genba_links_backfill", {});
ok(bfRead.status === "done" && bfRead.logs === nLogs, "結果は誰のトークンからも読める (印 links_backfill_v2 に残っている)");
await throws(() => call(N, "genba_links_backfill", { rerun: true }), /小西のトークン/, "かけ直しは小西のトークンからだけ");
const bf1 = await call(S, "genba_links_backfill", { rerun: true });
ok(bf1.status === "done" && bf1.inserted === 0 && (await rows(`SELECT count(*)::int AS n FROM log_links`))[0].n === snap2.length + manualRows.length, "かけ直しても 2 回入らない (inserted=0)");
g = mk(); cache = {};
await call(S, "genba_links_backfill", {});
ok((await rows(`SELECT count(*)::int AS n FROM log_links`))[0].n === snap2.length + manualRows.length, "新しいプロセスが何度来ても、印があるので走り直さない");
// 他のインスタンスが実行中の印は引き継がない / 3 分以上止まった印は次のリクエストが引き継ぐ (Cloud Run は背景で走らせると途中で止まるため)
await db.query(`DELETE FROM log_links WHERE auto=true`);
await db.query(`UPDATE genba_settings SET value='{"status":"running"}'::jsonb, updated_at=now() WHERE key='links_backfill_v2'`);
g = mk(); cache = {};
const busy = await call(N, "genba_links_backfill", {});
ok(busy.status === "running" && (await rows(`SELECT count(*)::int AS n FROM log_links WHERE auto=true`))[0].n === 0, "更新時刻が新しい「実行中」の印は、他のインスタンスが走っているので引き継がない", busy);
await db.query(`UPDATE genba_settings SET updated_at = now() - interval '4 minutes' WHERE key='links_backfill_v2'`);
g = mk(); cache = {};
const took = await call(N, "genba_links_backfill", {});
ok(took.status === "done" && (await rows(`SELECT count(*)::int AS n FROM log_links WHERE auto=true`))[0].n === snap2.length && (await rows(`SELECT count(*)::int AS n FROM log_links WHERE auto=false`))[0].n === manualRows.length, "3 分以上止まった「実行中」の印は、次のリクエストが引き継いで最後まで走る (手で付けたリンクは残る)", { status: took.status });
await db.query(`UPDATE genba_settings SET value='{"status":"failed","error":"x"}'::jsonb, updated_at = now() - interval '4 minutes' WHERE key='links_backfill_v2'`);
g = mk(); cache = {};
ok((await call(S, "genba_links_backfill", {})).status === "done", "失敗の印も、時間がたてば次のリクエストがやり直す");
await db.query(`DELETE FROM genba_settings WHERE key='links_backfill_v2'`);
await mk().ensureSchema();
ok((await rows(`SELECT count(*)::int AS n FROM genba_settings WHERE key='links_backfill_v2'`))[0].n === 0, "起動時の先読み (ensureSchema だけ) ではバックフィルを走らせない (リクエストの外では CPU が止まるため)");
g = mk(); cache = {};
await find("横山");
ok((await rows(`SELECT value->>'status' AS s FROM genba_settings WHERE key='links_backfill_v2'`))[0]?.s === "done", "つながりを使う最初のリクエスト (genba_contact_find) の中で走る");

// ───────────────────────── 10b. 確認: 記録の「書く人」(who・送り主) が連絡先に読めているか
await add({ site: "いちご", kind: "進捗", title: "AI が整理", body: "書類を整理した", who: "AI" });
await add({ site: "いちご", kind: "進捗", title: "山田の件", body: "山田に連絡した", who: "山田" });
await add({ site: "銀座博品館", kind: "進捗", title: "知らない人から連絡", body: "資料が届いた", source_ref: "LINE:rz:m9", source: { channel: "LINE", room: "rz", sender: "知らない人さん" } });
await add({ site: "銀座博品館", kind: "決定", title: "看板は A 案", body: "横山さんと辰巳さんで A 案に決めた", topic: "看板", who: "名取" });
g = mk(); cache = {};
const chk = (await call(S, "genba_links_backfill", {})).check;
ok(chk && chk.coverage.logs > 10 && chk.coverage.linked > 0 && chk.coverage.by_kind["決定"].logs >= 2 && chk.coverage.by_kind["決定"].linked === chk.coverage.by_kind["決定"].logs, "確認 (check): 種類ごとのリンクの付き具合。決定もすべてリンクが付いている", chk.coverage);
const whoU = chk.who.unresolved;
ok(whoU.some((x) => x.who === "AI" && x.status === "none") && whoU.some((x) => x.who === "山田" && x.status === "ambiguous") && !whoU.some((x) => x.who === "名取" || x.who === "横山"), "who: 連絡先に当たらない名前 (AI = none)・同名で決められない名前 (山田 = ambiguous) が出る。名取・横山は読めている", whoU);
ok(chk.who.logs > chk.who.resolved && chk.who.resolved > 0, "who: 読めた件数 / 全部の件数", { logs: chk.who.logs, resolved: chk.who.resolved });
ok(chk.sender.unresolved.some((x) => x.sender === "知らない人さん") && chk.sender.resolved >= 1 && chk.sender.logs > chk.sender.resolved, "送り主: 連絡先に当たらない送り主が出る (読めた件数も)", chk.sender);
ok(chk.ambiguous_names.some((x) => x.name === "山田" && x.contacts.length === 2) && chk.ambiguous_names.some((x) => x.name === "オート"), "同名で決められない名前 (山田・同じ呼び名のオート) の一覧", chk.ambiguous_names);
ok(chk.backfill?.status === "done" && Array.isArray(chk.backfill.people) && chk.backfill.people.length > 0, "バックフィルの結果 (人・現場ごとのリンク件数) も一緒に出る");
const au3 = await call(S, "genba_audit", {});
ok(!("links_check" in au3), "genba_audit は、指定しなければ今まで通り (つながりの確認は出さない)");
const au4 = await call(S, "genba_audit", { links_check: true });
ok(au4.links_check?.coverage?.by_kind?.["決定"] && au4.links_check.who && au4.summary !== undefined && "open_tasks" in au4, "genba_audit(links_check=true): つながりの確認が付く。元の項目はそのまま", Object.keys(au4));

// ───────────────────────── 10c. 書く人の読み取り: 補足つきの名前・会社名の who (本番の読めなかった名前から)
await call(S, "genba_company_upsert", { name: "株式会社エアサポ", role: "業者" });
await up({ name: "平居史也", company: "FLAT", role: "職人" });
const w1 = await add({ site: "銀座博品館", kind: "進捗", title: "補足つきの担当 A", body: "転送された資料を確認した", who: "横山（辰巳さん転送）" });
ok(has(w1.links, "contact", "横山", "who"), "who「横山（辰巳さん転送）」は、補足を外して横山に読める", w1.links);
const w2 = await add({ site: "銀座博品館", kind: "進捗", title: "補足つきの送り主 B", body: "資料が届いた", source_ref: "LINE:rw:m1", source: { channel: "LINE", room: "rw", sender: "横山（辰巳さん転送）" } });
ok(has(w2.links, "contact", "横山", "sender"), "送り主「横山（辰巳さん転送）」も横山 (sender) に読める", w2.links);
const w3 = await add({ site: "銀座博品館", kind: "進捗", title: "同名の担当 C", body: "連絡した", who: "山田（ミリネグローバル）" });
ok(!(w3.links || []).some((l) => l.type === "contact" && l.name === "山田"), "同じ名前が 2 人いる山田は、補足つきでも決めつけない (リンクを張らない)", w3.links);
const w4 = await add({ site: "銀座博品館", kind: "進捗", title: "会社が担当 D", body: "見解を待っている", who: "エアサポ" });
ok(has(w4.links, "company", "株式会社エアサポ", "who"), "who が会社の名前 (エアサポ) なら、会社に who でつなぐ", w4.links);
const w5 = await add({ site: "銀座博品館", kind: "進捗", title: "名字だけの担当 E", body: "確認した", who: "平居" });
ok(!(w5.links || []).some((l) => l.name === "平居史也"), "名字だけ (平居) は、同じ名字の別人がいるかもしれないので推測しない", w5.links);
g = mk(); cache = {};
const chk2 = (await call(S, "genba_links_backfill", {})).check;
const who2 = chk2.who.unresolved;
ok(!who2.some((x) => x.who === "エアサポ" || x.who.startsWith("横山")) && who2.some((x) => x.who === "山田（ミリネグローバル）" && x.status === "ambiguous") && who2.some((x) => x.who === "平居" && x.status === "none"), "確認: 会社名・補足つきは読めた扱い。同名 (山田) は ambiguous、名字だけ (平居) は none のまま出る", who2);
ok(!chk2.sender.unresolved.some((x) => x.sender.startsWith("横山")), "確認: 補足つきの送り主も読めた扱い", chk2.sender);
const gaAll = await call(S, "genba_graph_all", {});
ok(gaAll.nodes.find((n) => n.type === "contact" && n.name === "横山")?.role === "設計" && gaAll.nodes.find((n) => n.type === "contact" && n.name === "名取")?.role === "社内" && gaAll.nodes.filter((n) => n.type !== "contact").every((n) => !("role" in n) || n.role === undefined), "genba_graph_all: 人の点に role (社内など) が付く。現場・会社には付けない");

// ───────────────────────── 10d. 名前の当て方: 別の言葉の一部には当てない (本番で「目黒信金」→大工の目黒さん、「タカケン」→たかさん、「株式会社」→現場「会社」と誤ってつながっていた)
await db.query(`INSERT INTO sites (name) VALUES ('会社'), ('共通')`);
await up({ name: "目黒 徹", role: "職人", trade: "大工", aliases: ["目黒さん"] });
await up({ name: "たかさん", company: "KTERAS", role: "客先", aliases: ["たかさん", "高さん", "TK", "KTERAS社長"] });
await up({ name: "吉河清人", role: "職人" });
await up({ name: "清人", role: "職人" });
await call(S, "genba_company_upsert", { name: "目黒信用金庫", aliases: ["目黒信金"], role: "業者" });
await call(S, "genba_company_upsert", { name: "貴建", role: "元請け" });
const mm = async (title, body, extra = {}) => (await add({ site: "銀座博品館", kind: "進捗", title, body, ...extra })).links;
let L = await mm("目黒信金から振替", "名取 11/9：目黒信金からPayPayへ100万円。上目黒支店のカードを返してもらう。小西は中目黒に戻る。14時以降は目黒なので");
ok(!has(L, "contact", "目黒 徹") && has(L, "company", "目黒信用金庫"), "「目黒信金」「上目黒」「中目黒」「目黒なので」では、大工の目黒さんにつなげない (会社の目黒信用金庫にはつなぐ)", L);
L = await mm("大工の目黒さんと電話", "Plaud 小西×目黒さん（目黒工務店・高麗さん紹介）。依頼候補を伝えた");
ok(has(L, "contact", "目黒 徹", "mentioned"), "「目黒さん」と書いてあれば、大工の目黒さんにつながる", L);
L = await mm("大工目黒徹さんのLINE", "LINE を共有した");
ok(has(L, "contact", "目黒 徹"), "フルネーム (目黒徹) は、前が漢字 (大工) でも「さん」付きならつながる", L);
L = await mm("タカケンさんのフローリング（貴建）", "タカケンさん11/9〜11 OK。入谷のフローリング");
ok(!has(L, "contact", "たかさん") && has(L, "company", "貴建"), "「タカケンさん」では、KTERAS のたかさんにつなげない。（貴建）は会社の貴建につなぐ", L);
L = await mm("たかさんと電話", "10/28 たかさんと電話、カメラテストの日を決める");
ok(has(L, "contact", "たかさん", "mentioned"), "「たかさん」と書いてあればつながる", L);
L = await mm("弁護士はタカさんに相談", "とりあえずタカさんに聞いてみる");
ok(has(L, "contact", "たかさん"), "「タカさん」(かな違い) もつながる (助詞のあとでも)", L);
L = await mm("AIからTKのLINEへ", "候補日を送った。KTERAS と TKB の件");
ok(!has(L, "contact", "たかさん"), "英字の短い呼び名 (TK) が単独で出ても、「さん」「社長」が付かなければつなげない", L);
L = await mm("TK社長と電話", "来週会う");
ok(has(L, "contact", "たかさん"), "「TK社長」は、たかさんにつながる", L);
L = await mm("株式会社エアサポとの契約", "会社のAI専用PCの設定。株式会社エアサポのグループへ送った");
ok(!L.some((l) => l.type === "site" && l.name === "会社"), "本文の「会社」「株式会社」では、現場「会社」につなげない", L);
L = await mm("高橋工業に確認", "高橋工業へ見積を依頼した");
ok(!has(L, "contact", "高橋") && has(L, "company", "高橋工業"), "「高橋工業」では、人の高橋さんにつなげない (会社の高橋工業にはつなぐ)", L);
L = await mm("高橋さんに確認", "見積の金額を聞いた");
ok(has(L, "contact", "高橋", "mentioned"), "「高橋さん」は人の高橋さんにつながる", L);
L = await mm("吉河清人さんに連絡", "吉河清人さんへ打合せの連絡をした");
ok(has(L, "contact", "吉河清人") && !has(L, "contact", "清人"), "「吉河清人さん」では、別の連絡先の「清人」にはつなげない (前が漢字)", L);
L = await mm("清人さんに連絡", "打合せの候補日を送る");
ok(has(L, "contact", "清人") && !has(L, "contact", "吉河清人"), "「清人さん」は清人につながる", L);
L = await mm("FLAT横山さんの図面", "BANAX設計部の横山さんから受け取った");
ok(has(L, "contact", "横山") && has(L, "company", "FLAT"), "「FLAT横山さん」: 英字の会社名のすぐ後ろに続く名前も、会社もつながる", L);
// 作り直し: 今の照合に当たらないリンクは外れ、手で付けたリンクは残る
const lBad = (await mm("作り直しの確認", "名取が確認した", { links: [{ type: "contact", name: "辰巳" }] }));
const badLog = (await rows(`SELECT id FROM genba_log WHERE title='作り直しの確認'`))[0].id;
await db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) SELECT $1,'contact',id,'mentioned',true FROM genba_contacts WHERE name='目黒 徹'`, [badLog]);
await db.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) SELECT $1,'contact',id,'mentioned',true FROM genba_contacts WHERE name='吉河清人'`, [badLog]);
const bfR = await call(S, "genba_links_backfill", { rerun: true });
const afterBad = (await rows(`SELECT entity_type, entity_id, auto FROM log_links WHERE log_id=$1`, [badLog])).map((x) => `${x.entity_type}:${x.entity_id}:${x.auto}`);
const idOf = async (n) => Number((await rows(`SELECT id FROM genba_contacts WHERE name=$1`, [n]))[0].id);
ok(bfR.status === "done" && bfR.removed >= 2 && !afterBad.includes(`contact:${await idOf("目黒 徹")}:true`) && !afterBad.includes(`contact:${await idOf("吉河清人")}:true`) && afterBad.includes(`contact:${Number(tatsumi.id)}:false`), "かけ直し: 今の照合に当たらない自動リンクは外れ、手で付けたリンク (辰巳) は残る", { removed: bfR.removed, afterBad });
const bfR2 = await call(S, "genba_links_backfill", { rerun: true });
ok(bfR2.inserted === 0 && bfR2.removed === 0, "もう一度かけても、増えも減りもしない", { inserted: bfR2.inserted, removed: bfR2.removed });

// ───────────────────────── 11. ツール定義・手順書・既存ツールの形
const defs = Object.fromEntries(tools(S).map((t) => [t.name, t]));
ok(["genba_state_set", "genba_state_void", "genba_graph", "genba_graph_all", "genba_links_backfill"].every((n) => defs[n]), "ツールが載る: genba_state_set / genba_state_void / genba_graph / genba_graph_all (+ genba_links_backfill)");
ok(defs.genba_graph.annotations?.readOnlyHint === true && defs.genba_graph_all.annotations?.readOnlyHint === true && !defs.genba_state_set.annotations?.readOnlyHint && !defs.genba_state_void.annotations?.readOnlyHint && !defs.genba_links_backfill.annotations?.readOnlyHint, "genba_graph / genba_graph_all は readOnlyHint。書くツールには付けない");
ok(["entity", "kind", "body", "starts_on", "ends_on", "source_ref"].every((k) => k in defs.genba_state_set.inputSchema.properties) && ["query", "entity", "depth", "days"].every((k) => k in defs.genba_graph.inputSchema.properties) && ["days", "open_only"].every((k) => k in defs.genba_graph_all.inputSchema.properties) && "links" in defs.genba_log_add.inputSchema.properties, "引数: state_set(entity, kind, body, starts_on, ends_on, source_ref) / graph(query, entity, depth, days) / graph_all(days, open_only) / log_add(links)");
ok(/active_states/.test(defs.genba_contact_find.description) && /linked_open/.test(defs.genba_contact_find.description), "genba_contact_find の説明に active_states / linked_open");
ok(/送る前は必ず genba_contact_find か genba_graph/.test(g.instructions) && /genba_state_set/.test(g.instructions) && /active_states/.test(g.instructions), "手順書: 送る前に genba_contact_find か genba_graph で引く・電話で出たら genba_state_set");
const lst = await call(S, "genba_contact_list", {});
ok(lst.contacts.every((c) => !("active_states" in c) && !("linked_open" in c)), "genba_contact_list の返り値は変えない (active_states / linked_open は find だけ)");

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
