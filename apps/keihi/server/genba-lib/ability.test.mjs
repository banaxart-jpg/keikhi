// 連絡先の能力・条件・チーム (genba_contact_ability_* / genba_contact_condition_set) のテスト。
// 本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/ability.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
import { ABILITY_ITEMS, itemOf, parseScoreValue, parseScores, parseReasons, parseYN, parseCrew, applyOps, averages, INTERNAL_ONLY } from "./ability.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 800) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };
const thrown = (f, re, m) => { try { f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

const db = new PGlite();
// 本番の sites は infra/schema.sql + index.js の ALTER (address / key_box / postal / done_at) でできる
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
const pool = { query: (s, p) => db.query(s, p) };
const mk = () => createGenba({ getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); } });
let g = mk(), cache = {};
const tools = (by) => (cache[by] ||= g.tools(by));
const call = (by, name, args = {}) => { const t = tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西", N = "名取", MON = "LINE監視";
const up = (o) => call(S, "genba_contact_upsert", o);
const set = (by, contact, o = {}) => call(by, "genba_contact_ability_set", { contact, ...o });
const cond = (by, contact, o = {}) => call(by, "genba_contact_condition_set", { contact, ...o });
const find = (o = {}, by = S) => call(by, "genba_contact_ability_find", o);
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const ids = (x) => x.contacts.map((c) => c.id);
const nameSet = (x) => x.contacts.map((c) => c.name).sort().join(",");
const names = (...n) => n.sort().join(",");   // nameSet と同じ並び (文字コード順) で期待値を作る

// ───────────────────────── 0. 純粋関数
ok(ABILITY_ITEMS.length === 19 && ABILITY_ITEMS.map((i) => i.key).join() === "力,体力,現場の正確さ,現場のスピード,運転・移動,職人の仕切り,電話・交渉,段取り・日程,気づき・検討,図面・納まり,数字・書類,ネット手配,信用,理解力,説明力,腕の幅,急ぎ・融通,現場のきれいさ,単価", "能力は 19 項目 (指定の名前と順)");
ok(ABILITY_ITEMS.every((i) => i.hint) && /5＝安い/.test(ABILITY_ITEMS.find((i) => i.key === "単価").hint), "項目ごとの説明つき (単価は 5＝安い)");
ok(itemOf("運転移動")?.key === "運転・移動" && itemOf("急ぎ 融通")?.key === "急ぎ・融通" && itemOf("存在しない") === null, "項目名の表記ゆれ (・ / 空白) を吸収");
const sv = (v) => parseScoreValue({ key: "力" }, v);
ok(sv(4).score === 4 && sv("5").score === 5 && sv("unknown").unknown && sv("不明").unknown && sv(null).clear && sv(0).clear && sv("").clear, "点数: 1〜5 / unknown (不明) / null・0・\"\" = 未入力に戻す");
for (const bad of [6, -1, 4.5, "高い", true, [3], {}]) thrown(() => sv(bad), /1〜5/, `点数 ${JSON.stringify(bad)} はエラー`);
ok(parseYN(true) === "yes" && parseYN("はい") === "yes" && parseYN(false) === "no" && parseYN("いいえ") === "no" && parseYN("不明") === "unknown" && parseYN("unknown") === "unknown" && parseYN(null) === null, "はい / いいえ / 不明 / 未入力");
thrown(() => parseYN("たぶん", "night_ok"), /night_ok/, "はい・いいえ・不明以外はエラー");
ok(parseCrew(3) === 3 && parseCrew("4") === 4 && parseCrew(0) === 0 && parseCrew(null) === null && parseCrew("不明") === null, "人数: 整数 / 不明・未入力は null");
for (const bad of [-1, 100, 2.5, "多い", true]) thrown(() => parseCrew(bad), /crew_size/, `人数 ${JSON.stringify(bad)} はエラー`);
const base = { scores: {}, note: null, unknown_person: false };
let st = applyOps(base, { scoreOps: parseScores({ 力: 4, 体力: "unknown" }), reasonOps: parseReasons({ 力: "重い物を運ぶ" }), note: "ひとこと", unknownPerson: undefined });
ok(st.scores["力"].score === 4 && st.scores["力"].reason === "重い物を運ぶ" && st.scores["体力"].unknown === true && st.note === "ひとこと" && st.unknown_person === false, "書き換え: 点数・不明・理由・ひとこと");
st = applyOps(st, { scoreOps: parseScores({ 力: null }), reasonOps: new Map(), note: undefined, unknownPerson: undefined });
ok(!Number.isInteger(st.scores["力"].score) && st.scores["力"].reason === "重い物を運ぶ" && st.note === "ひとこと", "null は点数だけ未入力に戻す (理由・ひとことは残る)");
st = applyOps(st, { scoreOps: new Map(), reasonOps: parseReasons({ 力: "" }), note: undefined, unknownPerson: undefined });
ok(!("力" in st.scores), "点数も理由も無くなった項目は消える");
st = applyOps(st, { scoreOps: new Map(), reasonOps: new Map(), note: undefined, unknownPerson: true });
ok(st.unknown_person === true && Object.keys(st.scores).length === 0 && st.note === "ひとこと", "この人は知らない: 点数・理由を全部消す (ひとことは残る)");
st = applyOps(st, { scoreOps: parseScores({ 力: 3 }), reasonOps: new Map(), note: undefined, unknownPerson: undefined });
ok(st.unknown_person === false && st.scores["力"].score === 3, "後から点数を付けると 不明 は自動で外れる");
ok(JSON.stringify(averages([{ scores: { 力: { score: 5 }, 体力: { unknown: true }, 信用: { score: 4 } } }, { scores: { 力: { score: 3 }, 体力: { score: 2 } } }])) === JSON.stringify({ 力: 4, 体力: 2, 信用: 4 }), "平均は数値だけ (不明・未入力は数えない)");

// ───────────────────────── 1. 連絡先を作る (既存の upsert) → 既存のツールが今まで通り
const kubo = await up({ name: "久保木", company: "久保木工務店", trade: "大工", role: "職人", aliases: ["くぼちゃん"], phone: "090-0000-0001" });
const kamiji = await up({ name: "上地", company: "貴建", trade: "大工", role: "職人" });
const sakai = await up({ name: "酒井", company: "酒井電気", trade: "電気", role: "職人" });
const macha = await up({ name: "まちゃ", company: "井関クロス", trade: "クロス", role: "職人" });
const kato = await up({ name: "加藤くん", company: "貴建", trade: "大工", role: "職人" });
const tanaka = await up({ name: "田中", company: "田中商事", trade: "設計", role: "元請け" });
const naiso = await up({ name: "内装屋", trade: "内装", role: "業者" });
const y1 = await up({ name: "山田", company: "山田工務店", trade: "大工", role: "職人" });
const y2 = await up({ name: "山田", company: "山田建設", trade: "解体", role: "職人" });
ok(kubo.created && kubo.phone === "090-0000-0001" && kubo.aliases.includes("くぼちゃん") && kubo.role === "職人" && kubo.trade === "大工", "upsert の返り値: 既存の項目はそのまま", kubo);
ok(Array.isArray(kubo.abilities) && kubo.abilities.length === 0 && kubo.ability_avg === undefined && kubo.conditions.night_ok === null && kubo.conditions.crew_size === null && kubo.conditions.has_car === null && kubo.conditions.area === null && kubo.team.lead === null && kubo.team.members.length === 0, "能力・条件・チームは空の形で付く", { a: kubo.abilities, c: kubo.conditions, t: kubo.team });
const [iK, iU, iS, iM, iKa, iT, iN, iY1, iY2] = [kubo, kamiji, sakai, macha, kato, tanaka, naiso, y1, y2].map((x) => Number(x.id));

// ───────────────────────── 2. マイグレーション
const colsOf = async (t) => (await rows(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t])).map((c) => c.column_name);
const cc = await colsOf("genba_contacts"), rc = await colsOf("genba_contact_ratings");
ok(["night_ok", "crew_size", "has_car", "area", "team_lead_id"].every((c) => cc.includes(c)) && ["name", "name_key", "company", "trade", "role", "aliases", "channels", "phone", "email", "notes"].every((c) => cc.includes(c)), "genba_contacts に条件・チームの列が足され、既存の列は残る", cc);
ok(["contact_id", "rated_by", "scores", "note", "unknown_person", "rated_at"].every((c) => rc.includes(c)), "ratings テーブル: 付けた人・点数 (JSONB)・ひとこと・人まるごと不明・付けた日時", rc);
await throws(() => db.query(`UPDATE genba_contacts SET night_ok='たぶん' WHERE id=$1`, [iK]), /check|violat/i, "DB でも night_ok は yes / no / unknown だけ");
await throws(() => db.query(`UPDATE genba_contacts SET crew_size=-1 WHERE id=$1`, [iK]), /check|violat/i, "DB でも crew_size は 0 以上");
await throws(() => db.query(`INSERT INTO genba_contact_ratings (contact_id, rated_by) VALUES (999999, 'x')`), /foreign|violat/i, "存在しない連絡先には付けられない (FK)");
// 前の版 (13 列・0〜5) のテーブルがある DB: 中身を新しい形に写して、名前を変えて残す
await db.exec(`CREATE TABLE genba_contact_abilities (contact_id BIGINT NOT NULL REFERENCES genba_contacts(id) ON DELETE CASCADE, rated_by TEXT NOT NULL,
  power SMALLINT NOT NULL DEFAULT 0, stamina SMALLINT NOT NULL DEFAULT 0, site_accuracy SMALLINT NOT NULL DEFAULT 0, site_speed SMALLINT NOT NULL DEFAULT 0, driving SMALLINT NOT NULL DEFAULT 0,
  crew_lead SMALLINT NOT NULL DEFAULT 0, negotiation SMALLINT NOT NULL DEFAULT 0, planning SMALLINT NOT NULL DEFAULT 0, insight SMALLINT NOT NULL DEFAULT 0, drawings SMALLINT NOT NULL DEFAULT 0,
  numbers_docs SMALLINT NOT NULL DEFAULT 0, online_ordering SMALLINT NOT NULL DEFAULT 0, trust SMALLINT NOT NULL DEFAULT 0, note TEXT, rated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (contact_id, rated_by))`);
await db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by, power, trust, driving, note) VALUES ($1,'小西',4,5,3,'頼りになる'), ($1,'名取',2,0,0,NULL), ($2,'小西',0,0,0,'ひとことだけ')`, [iK, iU]);
g = mk(); cache = {};
await call(S, "genba_contact_list", {});                    // 新しいプロセス相当: ensureSchema が走り、前の版の中身が写される
const mig = await rows(`SELECT contact_id, rated_by, scores, note FROM genba_contact_ratings ORDER BY contact_id, rated_by`);
const m1 = mig.find((r) => Number(r.contact_id) === iK && r.rated_by === S), m2 = mig.find((r) => Number(r.contact_id) === iK && r.rated_by === N), m3 = mig.find((r) => Number(r.contact_id) === iU);
ok(mig.length === 3 && m1.scores["力"].score === 4 && m1.scores["信用"].score === 5 && m1.scores["運転・移動"].score === 3 && Object.keys(m1.scores).length === 3 && m1.note === "頼りになる", "前の版の点数が新しい形に移る (0 は未入力に)", m1);
ok(m2.scores["力"].score === 2 && Object.keys(m2.scores).length === 1 && m3.note === "ひとことだけ" && Object.keys(m3.scores).length === 0, "付けた人ごと・ひとことだけの行も移る");
ok(!(await rows(`SELECT to_regclass('genba_contact_abilities') AS t`))[0].t && (await rows(`SELECT count(*)::int AS n FROM genba_contact_abilities_v1`))[0].n === 3, "前のテーブルは消さずに名前を変えて残す (genba_contact_abilities_v1)");
g = mk(); cache = {}; await call(S, "genba_contact_list", {});
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_ratings`))[0].n === 3, "何度走らせても同じ (二重に写らない)");
const mkv = await call(S, "genba_contact_find", { query: "久保木" });
ok(mkv.match.abilities.length === 2 && mkv.match.abilities.find((x) => x.by === S).scores["力"] === 4, "写った点数が find の返り値に出る", mkv.match.abilities);
await db.query(`DELETE FROM genba_contact_ratings`);        // 以降のテストは空から

// ───────────────────────── 3. 条件 (condition_set)
await throws(() => cond(S, iK, {}), /のどれかが必要/, "条件が 1 つも無ければエラー");
await throws(() => cond(S, iK, { night_ok: "たぶん" }), /night_ok/, "night_ok が はい・いいえ・不明 以外ならエラー");
for (const bad of [-1, 100, 2.5, "多い"]) await throws(() => cond(S, iK, { crew_size: bad }), /crew_size/, `crew_size ${JSON.stringify(bad)} はエラー`);
await throws(() => cond(S, iK, { has_car: 3 }), /has_car/, "has_car が はい・いいえ・不明 以外ならエラー");
await throws(() => cond(S, iK, { area: "あ".repeat(101) }), /100 字/, "area 101 字はエラー");
await throws(() => cond(S, "いない人XYZ", { night_ok: true }), /見つからない.*ability_set/, "見つからない連絡先は作らない (作り方を案内)");
const nBefore = (await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n;
let cr = await cond(S, iK, { night_ok: true, crew_size: 2, has_car: true, area: "東京23区・埼玉南部" });
ok(cr.conditions.night_ok === true && cr.conditions.crew_size === 2 && cr.conditions.has_car === true && cr.conditions.area === "東京23区・埼玉南部" && cr.changed.length === 4 && cr.contact.id === iK && /社内用/.test(cr.reminder), "条件を書ける (変更の一覧つき)", cr);
let row = (await rows(`SELECT night_ok, crew_size, has_car, area, updated_by FROM genba_contacts WHERE id=$1`, [iK]))[0];
ok(row.night_ok === "yes" && row.crew_size === 2 && row.has_car === "yes" && row.area === "東京23区・埼玉南部" && row.updated_by === S, "DB: yes / 2 / yes / エリア・更新者", row);
cr = await cond(N, iK, { night_ok: "unknown" });
ok(cr.conditions.night_ok === "unknown" && cr.conditions.crew_size === 2 && cr.conditions.area === "東京23区・埼玉南部" && cr.changed.length === 1, "渡した項目だけ変わる (夜間 → 不明)。名取のトークンでも書ける (条件は連絡先に 1 つ)", cr);
cr = await cond(S, iK, { night_ok: false, crew_size: null, area: "" });
ok(cr.conditions.night_ok === false && cr.conditions.crew_size === null && cr.conditions.area === null && cr.conditions.has_car === true, "false は いいえ / null・\"\" は未入力に戻す", cr.conditions);
cr = await cond(S, iK, { night_ok: "はい", crew_size: "不明", has_car: "不明" });
ok(cr.conditions.night_ok === true && cr.conditions.crew_size === null && cr.conditions.has_car === "unknown", "「はい」「不明」の日本語も受ける", cr.conditions);
cr = await cond(S, iK, { night_ok: true });
ok(cr.changed.length === 0, "同じ値なら changed は空");
ok((await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n === nBefore, "condition_set は連絡先を増やさない");
await cond(S, iK, { night_ok: true, crew_size: 2, has_car: true, area: "東京23区・埼玉南部" });

// ───────────────────────── 4. 能力の書き込み (ability_set) のガード
await throws(() => set(S, iK, {}), /のどれかが必要/, "何も渡さなければエラー");
for (const bad of [6, -1, 4.5, "高い", true]) await throws(() => set(S, iK, { scores: { 力: bad } }), /1〜5/, `点数 ${JSON.stringify(bad)} はエラー`);
await throws(() => set(S, iK, { scores: { 腕力: 3 } }), /項目名が違う.*使える名前/, "知らない項目名はエラー (使える名前を返す)");
await throws(() => set(S, iK, { reasons: { 腕力: "x" } }), /項目名が違う/, "reasons の項目名が違えばエラー");
await throws(() => set(S, iK, { scores: { 力: 3 }, reasons: { 力: "あ".repeat(121) } }), /120 字/, "理由 121 字はエラー");
await throws(() => set(S, iK, { note: "あ".repeat(201) }), /200 字/, "ひとこと 201 字はエラー");
await throws(() => set(S, iK, { scores: "あいう" }), /形で渡す/, "scores が読めなければエラー");
await throws(() => set(S, iK, { scores: { 力: 3 }, unknown_person: true }), /一緒に渡せない/, "この人は知らない と点数は一緒に渡せない");
await throws(() => set(S, 999999, { scores: { 力: 3 } }), /ID 999999 が無い/, "存在しない ID はエラー (ID では新規に作らない)");
await throws(() => set(MON, iK, { scores: { 力: 3 } }), /監視ジョブ/, "監視ジョブのトークンでは付けられない");
await throws(() => set(S, "山田", { scores: { 力: 3 } }), /候補が複数.*ID か、team/, "同じ名前が複数なら推測せず止まる (候補を返す)");
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_ratings`))[0].n === 0 && (await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n === nBefore, "エラーのときは何も書かれず、連絡先も増えない");
const yy = await set(S, "山田", { scores: { 力: 3 }, trade: "大工" });
ok(yy.contact.id === iY1 && !yy.created, "同名が複数でも trade で絞れれば決まる (山田 + 大工)", yy.contact);

// ───────────────────────── 5. 点数・不明・理由・ひとこと・「この人は知らない」
let r = await set(S, iK, { scores: { 力: 4, 体力: "unknown", 信用: "5" }, reasons: { 力: "重い物をよく運んでいる", 信用: "約束を守る" }, note: "朝が早い" });
ok(r.ability.by === S && r.ability.scores["力"] === 4 && r.ability.scores["体力"] === "unknown" && r.ability.scores["信用"] === 5 && !("現場の正確さ" in r.ability.scores) && r.ability.reasons["力"] === "重い物をよく運んでいる" && r.ability.note === "朝が早い" && r.ability.unknown_person === false && r.ability.at, "書ける: 点数 / unknown (不明) / 理由 / ひとこと。付けた人=小西 (トークンから)。未入力の項目は出ない", r.ability);
ok(r.changed.length === 3 && r.changed.find((x) => x.item === "体力").to === "unknown" && r.changed.find((x) => x.item === "力").from === null && !r.created && /社内用/.test(r.reminder), "changed: 力 null→4・体力 null→unknown・信用 null→5", r.changed);
let raw = (await rows(`SELECT scores, note, unknown_person FROM genba_contact_ratings WHERE contact_id=$1 AND rated_by=$2`, [iK, S]))[0];
ok(raw.scores["力"].score === 4 && raw.scores["体力"].unknown === true && !("score" in raw.scores["体力"]) && raw.scores["信用"].score === 5 && raw.scores["力"].reason === "重い物をよく運んでいる" && !("現場の正確さ" in raw.scores), "DB: 未入力 (キー無し) と 不明 (unknown) と 点数 が区別して入る", raw.scores);
r = await set(S, iK, { scores: { 力: 3 } });
ok(r.changed.length === 1 && r.changed[0].from === 4 && r.changed[0].to === 3 && r.ability.scores["信用"] === 5 && r.ability.reasons["力"] === "重い物をよく運んでいる" && r.ability.note === "朝が早い", "一部だけ渡すと他の項目・理由・ひとことは今のまま (力 4→3)", r.changed);
r = await set(S, iK, { scores: { 力: null } });
ok(!("力" in r.ability.scores) && r.ability.reasons["力"] === "重い物をよく運んでいる", "null で点数だけ未入力に戻る (理由は残る)", r.ability);
r = await set(S, iK, { scores: { 信用: 0 } });
ok(!("信用" in r.ability.scores), "旧仕様の 0 も未入力に戻す扱い");
r = await set(S, iK, { reasons: { 力: "" } });
ok(!r.ability.reasons?.["力"], "理由を \"\" で消せる (点数が無ければ項目ごと消える)", r.ability);
r = await set(S, iK, { reasons: { 現場の正確さ: "点数はまだ付けない" } });
ok(r.ability.reasons["現場の正確さ"] === "点数はまだ付けない" && !("現場の正確さ" in r.ability.scores), "理由だけ先に書ける");
r = await set(S, iK, { note: "" });
ok(r.ability.note === undefined && r.ability.scores["体力"] === "unknown", "ひとことを \"\" で消せる");
r = await set(S, iK, { scores: { 運転移動: 5, 単価: 2 } });
ok(r.ability.scores["運転・移動"] === 5 && r.ability.scores["単価"] === 2, "項目名の表記ゆれ・後ろの項目 (単価) も書ける");
const all19 = Object.fromEntries(ABILITY_ITEMS.map((it, i) => [it.key, (i % 5) + 1]));
r = await set(S, iK, { scores: all19 });
ok(Object.keys(r.ability.scores).length === 19 && Object.entries(all19).every(([k, v]) => r.ability.scores[k] === v), "19 項目すべてに点数を付けられる");
// この人は知らない
r = await set(S, iU, { scores: { 力: 4 }, reasons: { 力: "見たことがある" }, note: "メモ" });
r = await set(S, iU, { unknown_person: true });
ok(r.ability.unknown_person === true && Object.keys(r.ability.scores).length === 0 && !r.ability.reasons && r.ability.note === "メモ", "「この人は知らない」: 点数・理由を消して人まるごと不明 (ひとことは残る)", r.ability);
let fu = await call(S, "genba_contact_find", { query: "貴建 上地" });
const upAb = (fu.match || fu.candidates?.find((c) => c.id === iU))?.abilities || [];
ok(upAb.length === 1 && upAb[0].unknown_person === true, "find の返り値にも「この人は知らない」が出る", upAb);
r = await set(S, iU, { scores: { 力: 3 } });
ok(r.ability.unknown_person === false && r.ability.scores["力"] === 3, "後から点数を付ければ 不明 は自動で外れる");
r = await set(S, iU, { unknown_person: true });
r = await set(S, iU, { unknown_person: false });
ok(r.ability.unknown_person === false, "unknown_person=false で戻せる");

// ───────────────────────── 6. 付けた人ごとに別の点数 + 平均
await set(S, iK, { scores: { 力: 5, 信用: 4, 体力: 4 }, reasons: { 力: "米袋を担いでいた" }, note: "頼りになる" });
r = await set(N, iK, { scores: { 力: 3, 体力: "unknown" }, reasons: { 力: "細身" }, note: "朝が遅い日もある" });
ok(r.ability.by === N && r.ability.scores["力"] === 3 && r.raters.length === 2 && r.ability_avg["力"] === 4 && r.ability_avg["信用"] === 4 && r.ability_avg["体力"] === 4, "名取は名取の点数として別に残る。平均は数値だけ (名取の体力 unknown は数えない)", r);
const two = await rows(`SELECT rated_by, scores, note FROM genba_contact_ratings WHERE contact_id=$1 ORDER BY rated_by`, [iK]);
ok(two.length === 2 && two.find((x) => x.rated_by === S).scores["力"].score === 5 && two.find((x) => x.rated_by === S).scores["力"].reason === "米袋を担いでいた" && two.find((x) => x.rated_by === N).scores["力"].score === 3 && two.find((x) => x.rated_by === N).scores["力"].reason === "細身", "DB: 小西と名取で別の行 (点数も理由もひとことも別)", two.map((x) => x.rated_by));
const fk = await call(S, "genba_contact_find", { query: "くぼちゃん" });
const fa = fk.match.abilities;
ok(fk.match.id === iK && fa.length === 2 && fa.some((x) => x.by === S && x.scores["力"] === 5 && x.reasons["力"] === "米袋を担いでいた" && x.note === "頼りになる") && fa.some((x) => x.by === N && x.scores["体力"] === "unknown" && x.note === "朝が遅い日もある"), "find: 付けた人ごとの点数・理由・ひとことが出る", fa);
ok(fk.match.ability_avg["力"] === 4 && fk.match.ability_avg["信用"] === 4 && fk.match.ability_avg["体力"] === 4 && fa.every((x) => x.at), "find: ability_avg (付けた人の平均) と付けた日時");
ok(fk.match.conditions.night_ok === true && fk.match.conditions.crew_size === 2 && fk.match.conditions.has_car === true && fk.match.conditions.area === "東京23区・埼玉南部" && fk.match.team.lead === null, "find: 条件 (夜間 OK・人数・車・エリア) とチームも付く", fk.match.conditions);
ok(fk.match.aliases.includes("くぼちゃん") && fk.match.phone === "090-0000-0001" && "message_hint" in fk.match && Array.isArray(fk.match.sites), "find: 既存の項目 (aliases / phone / message_hint…) も今まで通り");

// ───────────────────────── 7. 同時に書いても消し合わない (アーティファクトが連続で呼ぶ想定)
await Promise.all([
  set(S, iS, { scores: { 力: 5 } }), set(S, iS, { scores: { 体力: 3 } }), set(S, iS, { scores: { 信用: 5 } }), set(S, iS, { reasons: { 力: "重い" }, note: "同時" }),
]);
const cc4 = (await rows(`SELECT scores, note, rev FROM genba_contact_ratings WHERE contact_id=$1 AND rated_by=$2`, [iS, S]))[0];
ok(cc4.scores["力"].score === 5 && cc4.scores["体力"].score === 3 && cc4.scores["信用"].score === 5 && cc4.scores["力"].reason === "重い" && cc4.note === "同時" && cc4.rev >= 3, "4 つを同時に送っても全部残る (版が変わったら読み直してやり直す)", cc4);

// ───────────────────────── 8. 新規作成 (見つからなければ team と trade で職人として作る)
const nBefore2 = (await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n;
await throws(() => set(S, "新人くん", { scores: { 力: 3 }, team: "存在しない親方", trade: "大工" }), /見つからない/, "親方が登録されていなければ止まる");
ok((await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n === nBefore2 && (await rows(`SELECT count(*)::int AS n FROM genba_contact_ratings WHERE contact_id NOT IN (SELECT id FROM genba_contacts)`))[0].n === 0, "親方が無いときは連絡先も作らない");
let nw = await set(S, "ヒッキー", { scores: { 力: 4, 体力: "unknown" }, reasons: { 力: "米袋" }, team: "まちゃ", trade: "クロス" });
const hk = (await rows(`SELECT * FROM genba_contacts WHERE name='ヒッキー'`))[0];
ok(nw.created === true && nw.contact.trade === "クロス" && hk.role === "職人" && hk.trade === "クロス" && Number(hk.team_lead_id) === iM && hk.updated_by === S && !nw.warnings && nw.ability.scores["力"] === 4, "見つからない → 職人として新規作成 (team=まちゃ・trade=クロス)・そのまま点数も付く", nw);
const ginu = await set(S, "ギヌ", { scores: { 力: 2 }, team: "まちゃ", trade: "クロス" });
const iH = Number(hk.id), iG = Number(ginu.contact.id);
const again = await set(S, "ヒッキー", { scores: { 信用: 3 }, team: "まちゃ", trade: "クロス" });
ok(again.created === false && again.contact.id === iH && !again.warnings && (await rows(`SELECT count(*)::int AS n FROM genba_contacts WHERE name='ヒッキー'`))[0].n === 1, "2 回目は既存の人として扱う (重複して作らない)・同じ team なら警告なし", again);
const nolead = await set(S, "親方なしの人", { scores: { 力: 3 }, trade: "解体" });
ok(nolead.created && (await rows(`SELECT team_lead_id FROM genba_contacts WHERE id=$1`, [nolead.contact.id]))[0].team_lead_id === null, "team は省略できる (親方なしで作る)");
const diff = await set(S, iK, { scores: { 力: 5 }, team: "まちゃ", trade: "解体" });
ok(!diff.created && diff.warnings?.length === 2 && /team は変えていない/.test(diff.warnings.join()) && /trade は変えていない/.test(diff.warnings.join()) && (await rows(`SELECT team_lead_id, trade FROM genba_contacts WHERE id=$1`, [iK]))[0].trade === "大工", "既存の連絡先の team / trade は変えない (警告で伝える)", diff.warnings);
const kidsSon = await set(S, "加藤くんの息子", { scores: { 力: 3 }, team: "上地", trade: "大工" });
ok(kidsSon.created && kidsSon.contact.id !== iKa && kidsSon.warnings?.some((w) => /加藤くん/.test(w)) && (await call(S, "genba_contact_find", { query: "加藤くん" })).candidates.some((c) => c.id === iKa), "「加藤くんの息子」は「加藤くん」に化けず別の人として作る (近い名前を警告)", kidsSon.warnings);
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_ratings WHERE contact_id=$1`, [iKa]))[0].n === 0, "加藤くん本人には点数が付かない");
const strict = await set(S, "久保木さん", { scores: { "気づき・検討": 4 } });
ok(strict.contact.id === iK && !strict.created, "「さん」付きの呼び名は既存の人に当たる (新規作成にならない)", strict.contact);

// ───────────────────────── 9. チーム (upsert の team)
await up({ name: "久保木", company: "久保木工務店", team: "上地" });
let kk = await call(S, "genba_contact_find", { query: "くぼちゃん" });
ok(kk.match.team.lead?.id === iU && kk.match.team.lead.name === "上地" && kk.match.phone === "090-0000-0001", "upsert の team で親方を付けられる (他の項目は今のまま)", kk.match.team);
let kam = await call(S, "genba_contact_list", { trade: "大工" });
const kamRow = kam.contacts.find((c) => c.id === iU);
ok(kamRow.team.members.some((m) => m.id === iK) && kamRow.team.members.some((m) => m.name === "加藤くんの息子") && kamRow.team.lead === null, "list: 親方の連絡先に members (子方) が出る", kamRow.team);
await throws(() => up({ name: "久保木", company: "久保木工務店", team: "久保木工務店" }), /自分自身/, "自分自身は親方にできない");
await throws(() => up({ name: "上地", company: "貴建", team: String(iK) }), /子方なので親方にできない/, "自分の子方を親方にはできない (ぐるぐる回る)");
await throws(() => up({ name: "久保木", company: "久保木工務店", team: "存在しない親方" }), /見つからない/, "親方が登録されていなければエラー");
let phoneOnly = await up({ name: "久保木", company: "久保木工務店", phone: "090-0000-9999" });
ok(phoneOnly.team.lead?.id === iU && phoneOnly.phone === "090-0000-9999" && phoneOnly.abilities.length === 2, "team を渡さない更新では親方も能力もそのまま", phoneOnly.team);
const cleared = await up({ name: "久保木", company: "久保木工務店", team: "" });
ok(cleared.team.lead === null, "team=\"\" でチームから外せる");
await up({ name: "久保木", company: "久保木工務店", team: "上地" });

// ───────────────────────── 10. 条件を足す → 能力と条件で探す (ability_find)
await cond(S, iU, { night_ok: false, crew_size: 5, has_car: true, area: "東京" });
await cond(S, iS, { night_ok: true, crew_size: 1, has_car: "unknown" });
await cond(S, iM, { night_ok: true });
await cond(S, iH, { night_ok: true });
await cond(S, iN, { night_ok: true });                                         // 内装屋: 点数は無い (条件だけ)
await set(S, iU, { scores: { 力: 3, 信用: 5 } });
await set(S, iS, { scores: { 力: 5, 信用: 5 } });
await set(S, iM, { scores: { 力: 4 } });
let q = await find({ min: { 力: 4 }, night_ok: true });
ok(nameSet(q) === "ヒッキー,久保木,まちゃ,酒井".split(",").sort().join(",") && q.contacts[0].name === "酒井", "「力 4 以上で夜 OK」: 久保木 (平均 4)・酒井・まちゃ・ヒッキー。点数の高い順 (酒井が先頭)。上地 (力 3・夜 NG) は入らない", q.contacts.map((c) => c.name));
ok(q.conditions.min["力"] === 4 && q.conditions.night_ok === true && q.conditions.by === "付けた人の平均" && q.count === 4 && q.matched === 4, "条件の読み取り (conditions) が返る", q.conditions);
const hit = q.contacts.find((c) => c.id === iK);
ok(hit.abilities.length === 2 && hit.ability_avg["力"] === 4 && hit.score_used.scores["力"] === 4 && hit.conditions.night_ok === true && hit.team.lead.name === "上地", "複数人の点数は ability_avg (平均) と abilities (付けた人ごと) の両方が返る。conditions・team も付く", { avg: hit.ability_avg, n: hit.abilities.length });
q = await find({ min: { 力: 5 } });
ok(nameSet(q) === "酒井", "力 5 以上: 平均で見ると久保木 (5 と 3 → 4) は入らない", q.contacts.map((c) => c.name));
q = await find({ min: { 力: 5 }, by: "小西" });
ok(nameSet(q) === "久保木,酒井" && q.conditions.by === "小西" && q.contacts.find((c) => c.id === iK).score_used.scores["力"] === 5 && q.contacts.find((c) => c.id === iK).score_used.by === "小西" && q.contacts.find((c) => c.id === iK).abilities.length === 2, "by=小西: 小西の点数だけで見る (久保木は 5)。abilities には付けた人ごとが全員分出る", q.contacts.map((c) => c.name));
q = await find({ min: { 力: 5 }, by: "名取" });
ok(q.count === 0, "by=名取: 名取の 力 は 3 だけ → 5 以上はいない");
q = await find({ min: { 信用: 4 }, trade: "大工" });
ok(nameSet(q) === names("久保木", "上地") && q.contacts[0].name === "上地", "「信用 4 以上かつ大工」: 上地 (5)・久保木 (4)。電気の酒井は職種で外れる", q.contacts.map((c) => c.name));
q = await find({ min: { 力: 4, 信用: 4 } });
ok(nameSet(q) === "久保木,酒井", "複数の点数条件は全部満たす人だけ (かつ)", q.contacts.map((c) => c.name));
q = await find({ min: { 体力: 1 } });
ok(nameSet(q) === names("久保木", "酒井"), "体力 1 以上: 数値の点数がある人だけ (久保木・酒井)。不明 (unknown) だけのヒッキーは入らない", q.contacts.map((c) => c.name));
ok(q.contacts.find((c) => c.name === "久保木").abilities.some((a) => a.scores["体力"] === "unknown") && q.contacts.find((c) => c.name === "久保木").ability_avg["体力"] === 4, "久保木: 名取の「体力 unknown」は abilities に残り、平均 (4) には入らない");
q = await find({ team: "まちゃ" });
ok(nameSet(q) === "ギヌ,まちゃ,ヒッキー".split(",").sort().join(",") && q.conditions.team === "まちゃ", "team=まちゃ: 親方本人と子方", q.contacts.map((c) => c.name));
q = await find({ team: "まちゃ", min: { 力: 4 } });
ok(nameSet(q) === "まちゃ,ヒッキー".split(",").sort().join(","), "team と点数の組み合わせ (まちゃ・ヒッキー。ギヌは力 2)", q.contacts.map((c) => c.name));
q = await find({ night_ok: true });
ok(["久保木", "酒井", "まちゃ", "ヒッキー", "内装屋"].every((n) => q.contacts.some((c) => c.name === n)) && !q.contacts.some((c) => c.name === "上地"), "条件だけで探せる (点数が無い内装屋も入る)。夜 NG の上地は入らない", q.contacts.map((c) => c.name));
q = await find({ night_ok: false });
ok(nameSet(q) === "上地", "night_ok=false: 夜は NG の人");
q = await find({ has_car: "unknown", trade: "電気" });
ok(nameSet(q) === "酒井", "has_car=\"unknown\": 車が不明の人");
q = await find({ crew_min: 2 });
ok(nameSet(q) === names("久保木", "上地"), "crew_min=2: 連れて来られる人数が 2 以上 (人数が不明の人は入らない)", q.contacts.map((c) => c.name));
q = await find({ area: "埼玉" });
ok(nameSet(q) === "久保木", "area: 対応エリアに含まれる言葉");
q = await find({ role: "業者" });
ok(nameSet(q) === "内装屋", "role で絞れる (業者 = 内装屋)");
q = await find({});
ok(q.count >= 8 && !q.contacts.some((c) => c.name === "田中") && q.contacts.every((c) => c.abilities.length || c.conditions.night_ok !== null || c.conditions.crew_size !== null || c.conditions.has_car !== null || c.conditions.area), "条件が全部空なら、能力か条件が入っている人だけの一覧 (何も無い田中は出ない)", q.count);
q = await find({ min: { 力: 1 }, limit: 2 });
ok(q.count === 2 && q.matched > 2, "limit が効く (matched は全体の件数)", { count: q.count, matched: q.matched });
await throws(() => find({ min: { 力: 0 } }), /1〜5/, "min の 0 はエラー");
await throws(() => find({ min: { 力: "unknown" } }), /1〜5/, "min に unknown は使えない");
await throws(() => find({ min: { 腕力: 3 } }), /項目名が違う/, "min の項目名が違えばエラー");
await throws(() => find({ night_ok: "たぶん" }), /night_ok/, "night_ok が はい・いいえ・不明 以外ならエラー");
await throws(() => find({ team: "存在しない親方" }), /見つからない/, "team の親方が見つからなければエラー");
q = await find({ min: { 信用: 5 }, trade: "存在しない職種" });
ok(q.count === 0 && q.matched === 0, "該当なしは空で返る (エラーにしない)");
q = await find({ min: { 信用: 5 } }, N);
ok(nameSet(q) === "上地,酒井", "名取のトークンでも探せる (社内用)", q.contacts.map((c) => c.name));

// ───────────────────────── 11. list・ツール定義・社内用の注意
const lst = await call(S, "genba_contact_list", {});
ok(lst.contacts.every((c) => Array.isArray(c.abilities) && c.conditions && c.team && Array.isArray(c.team.members)), "genba_contact_list: 全員に abilities・conditions・team が付く", lst.count);
ok(lst.contacts.find((c) => c.id === iM).team.members.map((m) => m.name).sort().join() === "ギヌ,ヒッキー", "list: まちゃの子方 (ヒッキー・ギヌ)");
const lt = await call(S, "genba_contact_list", { role: "元請け" });
ok(lt.count === 1 && lt.contacts[0].name === "田中" && lt.contacts[0].abilities.length === 0, "list の role 絞り込みは今まで通り (田中 = 何も付いていない)");
const defs = Object.fromEntries(tools(S).map((t) => [t.name, t]));
ok(["genba_contact_ability_set", "genba_contact_condition_set", "genba_contact_ability_find"].every((n) => defs[n]) && defs.genba_contact_ability_find.annotations?.readOnlyHint === true && !defs.genba_contact_ability_set.annotations?.readOnlyHint && !defs.genba_contact_condition_set.annotations?.readOnlyHint, "ツール 3 つが載る (find だけ readOnlyHint)");
ok(["genba_contact_ability_set", "genba_contact_condition_set", "genba_contact_ability_find", "genba_contact_find", "genba_contact_list"].every((n) => /本人・相手の会社・社外への文面/.test(defs[n].description)) && INTERNAL_ONLY.includes("理由"), "5 つのツール説明すべてに「能力・理由は社内用。本人や社外への文面に引用しない」");
const sp = defs.genba_contact_ability_set.inputSchema;
ok(Object.keys(sp.properties.scores.properties).length === 19 && Object.entries(sp.properties.scores.properties).every(([k, v]) => v.description.includes(itemOf(k).hint)) && ["contact", "scores", "reasons", "note", "unknown_person", "team", "trade"].every((k) => k in sp.properties) && sp.required.join() === "contact", "set の引数: contact / scores (19 項目・説明つき) / reasons / note / unknown_person / team / trade");
ok(["contact", "night_ok", "crew_size", "has_car", "area"].every((k) => k in defs.genba_contact_condition_set.inputSchema.properties) && ["min", "night_ok", "has_car", "crew_min", "area", "trade", "role", "team", "by", "limit"].every((k) => k in defs.genba_contact_ability_find.inputSchema.properties), "condition_set / find の引数がそろっている");
ok(ABILITY_ITEMS.every((it) => defs.genba_contact_ability_set.description.includes(it.key)) && "team" in defs.genba_contact_upsert.inputSchema.properties, "set の説明に全項目名。upsert に team の引数が増えた");
ok(/連絡先の能力・条件・チーム/.test(g.instructions) && /genba_contact_condition_set/.test(g.instructions) && /夜 OK/.test(g.instructions), "手順書 (instructions) に節が入る");

// ───────────────────────── 12. 連絡先を消したとき
await up({ name: "親方X", trade: "大工", role: "職人" });
await up({ name: "子Y", trade: "大工", role: "職人", team: "親方X" });
await set(S, "子Y", { scores: { 力: 3 } });
const iX = Number((await rows(`SELECT id FROM genba_contacts WHERE name='親方X'`))[0].id), iYc = Number((await rows(`SELECT id FROM genba_contacts WHERE name='子Y'`))[0].id);
await throws(() => call(N, "genba_contact_remove", { contact: iX }), /小西/, "remove は今まで通り小西のトークンだけ");
await call(S, "genba_contact_remove", { contact: iX });
ok((await rows(`SELECT team_lead_id FROM genba_contacts WHERE id=$1`, [iYc]))[0].team_lead_id === null && (await call(S, "genba_contact_find", { query: "子Y" })).match.team.lead === null, "親方を消すと、子方は親方なしに戻る (連絡先は残る)");
await call(S, "genba_contact_remove", { contact: iYc });
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_ratings WHERE contact_id=$1`, [iYc]))[0].n === 0, "連絡先を消すと、その人の点数も一緒に消える");

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
