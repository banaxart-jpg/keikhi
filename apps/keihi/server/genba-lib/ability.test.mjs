// 連絡先の能力 (genba_contact_ability_*) のテスト。本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/ability.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
import { ABILITIES, abilityOf, parseScores, averages } from "./ability.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 700) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

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
const rows = async (sql, p) => (await db.query(sql, p)).rows;

// ───────────────────────── 0. 純粋関数
ok(ABILITIES.length === 13 && ABILITIES.map((a) => a.label).join() === "力,体力,現場の正確さ,現場のスピード,運転・移動,職人の仕切り,電話・交渉,段取り・日程,気づき・検討,図面・納まり,数字・書類,ネット手配,信用", "能力は 13 項目 (指定の名前と順)");
ok(abilityOf("運転移動")?.label === "運転・移動" && abilityOf("運転 ・ 移動")?.label === "運転・移動" && abilityOf("電話交渉")?.label === "電話・交渉" && abilityOf("存在しない") === null, "能力名の表記ゆれ (・ / 空白) を吸収");
ok(parseScores('{"力":3}')[0].value === 3 && parseScores({ 力: "4" })[0].value === 4, "scores は JSON 文字列・数字の文字列も受ける");
ok(JSON.stringify(averages([{ power: 5, trust: 4 }, { power: 3, trust: 0 }])) === JSON.stringify({ 力: 4, 信用: 4 }), "平均は 0 (未評価) を数えない", averages([{ power: 5, trust: 4 }, { power: 3, trust: 0 }]));

// ───────────────────────── 1. 連絡先 (既存の upsert) を作る → 既存のツールが今まで通り
const A = await up({ name: "山田", company: "山田工務店", trade: "大工", role: "職人", aliases: ["ヤマちゃん"], phone: "090-0000-0001" });
const B = await up({ name: "鈴木", company: "鈴木大工", trade: "大工", role: "職人" });
const C = await up({ name: "佐藤", company: "佐藤電気", trade: "電気", role: "職人" });
const D = await up({ name: "田中", company: "田中商事", trade: "設計", role: "元請け" });
const E = await up({ name: "高橋", company: "高橋内装", trade: "内装", role: "職人" });
const F = await up({ name: "伊藤", company: "伊藤塗装", trade: "塗装", role: "職人" });
const A2 = await up({ name: "山田", company: "山田建設", trade: "解体", role: "職人" });   // 同じ名前の別人 (あいまいさのテスト用)
ok(A.created && A.abilities?.length === 0 && A.ability_avg === undefined && A.aliases.includes("ヤマちゃん") && A.phone === "090-0000-0001" && A.role === "職人" && A.trade === "大工", "upsert の返り値: 既存の項目はそのまま、abilities は空", A);
ok(A.id !== A2.id, "同じ名前でも会社が違えば別人 (今まで通り)");

// ───────────────────────── 2. マイグレーション
let tb = await rows(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='genba_contact_abilities' ORDER BY ordinal_position`);
const colNames = tb.map((c) => c.column_name);
ok(["contact_id", "rated_by", "note", "rated_at", ...ABILITIES.map((a) => a.col)].every((c) => colNames.includes(c)), "テーブルに 13 項目 + 付けた人 + ひとこと + 付けた日時", colNames);
ok(ABILITIES.every((a) => { const c = tb.find((x) => x.column_name === a.col); return c.is_nullable === "NO" && /0/.test(c.column_default) && c.data_type === "smallint"; }), "13 項目は NOT NULL・既定 0 (= 未評価)・整数");
await throws(() => db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by, power) VALUES ($1, 'x', 6)`, [A.id]), /check|violat/i, "DB でも 0〜5 の外は入らない (6)");
await throws(() => db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by, trust) VALUES ($1, 'x', -1)`, [A.id]), /check|violat/i, "DB でも 0〜5 の外は入らない (-1)");
await throws(() => db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by) VALUES (999999, 'x')`), /foreign|violat/i, "存在しない連絡先には付けられない (FK)");
await db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by, power) VALUES ($1, 'テスト', 1)`, [E.id]);
await throws(() => db.query(`INSERT INTO genba_contact_abilities (contact_id, rated_by, power) VALUES ($1, 'テスト', 2)`, [E.id]), /duplicate|unique|primary/i, "同じ (連絡先, 付けた人) は 1 行だけ (PK)");
await db.query(`DELETE FROM genba_contact_abilities WHERE rated_by='テスト'`);
// 既にデータがある DB に後から入る: テーブルを落として、新しいプロセス相当 (別インスタンス) で動かす → 連絡先は無事・テーブルは作り直される
const before = await rows(`SELECT id, name, company, trade, role, aliases FROM genba_contacts ORDER BY id`);
await db.query(`DROP TABLE genba_contact_abilities`);
g = mk(); cache = {};
const again = await call(S, "genba_contact_list", {});
const after = await rows(`SELECT id, name, company, trade, role, aliases FROM genba_contacts ORDER BY id`);
ok(JSON.stringify(before) === JSON.stringify(after) && again.count === 7 && (await rows(`SELECT to_regclass('genba_contact_abilities') AS t`))[0].t, "既存の連絡先は無傷のまま、テーブルだけ作り直される (何度走らせても同じ)", again.count);
await mk().ensureSchema();                          // もう 1 回 (別インスタンス・同じ DB)
ok(true, "2 回目のマイグレーションも落ちない");

// ───────────────────────── 3. 登録のガード (set)
const idF = Number(F.id);
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 6 } }), /0〜5/, "6 はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: -1 } }), /0〜5/, "-1 はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 4.5 } }), /整数/, "小数はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: "高い" } }), /整数/, "数字でない値はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: null } }), /整数/, "null はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 腕力: 3 } }), /能力名が違う.*使える名前/, "知らない能力名はエラー (使える名前を返す)");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: {} }), /空/, "scores が空ならエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: "あいう" }), /形で渡す/, "scores が読めなければエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF }), /scores か note/, "scores も note も無ければエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 3 }, note: "あ".repeat(201) }), /200 字/, "ひとこと 201 字はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: "いない人XYZ", scores: { 力: 3 } }), /見つからない/, "存在しない連絡先はエラー");
await throws(() => call(S, "genba_contact_ability_set", { contact: "山田", scores: { 力: 3 } }), /候補が複数/, "同じ名前が複数なら推測せず止まる");
await throws(() => call(MON, "genba_contact_ability_set", { contact: idF, scores: { 力: 3 } }), /監視ジョブ/, "監視ジョブのトークンでは付けられない");
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_abilities`))[0].n === 0, "エラーのときは何も書かれない");

// ───────────────────────── 4. 書き込みと部分更新 (伊藤)
let r = await call(S, "genba_contact_ability_set", { contact: "伊藤", scores: { 力: 2, 体力: 3 }, note: "最初の印象" });
ok(r.contact.id === idF && r.ability.by === S && r.ability.scores["力"] === 2 && r.ability.scores["体力"] === 3 && r.ability.note === "最初の印象" && r.changed.length === 2 && r.changed[0].from === 0 && /社内用/.test(r.reminder), "書ける: 付けた人=小西 (トークンから)・変更の一覧・社内用の注意", r);
let row = (await rows(`SELECT * FROM genba_contact_abilities WHERE contact_id=$1 AND rated_by=$2`, [idF, S]))[0];
ok(row.power === 2 && row.stamina === 3 && row.trust === 0 && row.note === "最初の印象" && row.rated_at, "DB: 渡した項目だけ入り、他は 0 (未評価)・付けた日時が入る", row);
const t1 = new Date(row.rated_at).getTime();
r = await call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 4 } });
row = (await rows(`SELECT * FROM genba_contact_abilities WHERE contact_id=$1 AND rated_by=$2`, [idF, S]))[0];
ok(r.changed.length === 1 && r.changed[0].ability === "力" && r.changed[0].from === 2 && r.changed[0].to === 4 && row.stamina === 3 && row.note === "最初の印象" && new Date(row.rated_at).getTime() >= t1, "一部だけ渡すと他の項目・ひとことは今のまま (力 2→4)、日時は更新", r.changed);
r = await call(S, "genba_contact_ability_set", { contact: idF, scores: { 体力: 0 } });
ok(!("体力" in r.ability.scores) && r.ability.scores["力"] === 4, "0 を渡すと未評価に戻る (表示から消える)", r.ability);
r = await call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 4 } });
ok(r.changed.length === 0, "同じ点数を渡しても changed は空");
r = await call(S, "genba_contact_ability_set", { contact: idF, note: "" });
ok(r.ability.note === undefined && r.ability.scores["力"] === 4, "note だけ渡せる・\"\" でひとことを消せる", r.ability);
r = await call(S, "genba_contact_ability_set", { contact: idF, scores: '{"運転移動": "5"}' });
ok(r.ability.scores["運転・移動"] === 5, "scores が JSON 文字列・能力名の表記ゆれでも書ける", r.ability);
r = await call(S, "genba_contact_ability_set", { contact: idF, scores: { 力: 4 }, note: "あ".repeat(200) });
ok(r.ability.note.length === 200, "ひとこと 200 字ちょうどは書ける");

// ───────────────────────── 5. 付けた人ごとに別の点数 (山田・鈴木・佐藤・高橋)
const idA = Number(A.id), idB = Number(B.id), idC = Number(C.id), idE = Number(E.id);
await call(S, "genba_contact_ability_set", { contact: idA, scores: { 力: 5, 信用: 4 }, note: "頼りになる" });
await call(S, "genba_contact_ability_set", { contact: idB, scores: { 力: 3, 信用: 5 } });
await call(S, "genba_contact_ability_set", { contact: idC, scores: { 力: 5, 信用: 5 } });
await call(S, "genba_contact_ability_set", { contact: idE, scores: { 力: 4 } });
r = await call(N, "genba_contact_ability_set", { contact: idA, scores: { 力: 3 }, note: "朝が遅い" });
ok(r.ability.by === N && r.ability.scores["力"] === 3 && r.raters.length === 2 && r.ability_avg["力"] === 4 && r.ability_avg["信用"] === 4, "名取は名取の点数として別に残る (小西の点数は変わらない)・平均が付く", r);
const mine = await rows(`SELECT rated_by, power, trust, note FROM genba_contact_abilities WHERE contact_id=$1 ORDER BY rated_by`, [idA]);
ok(mine.length === 2 && mine.find((x) => x.rated_by === S).power === 5 && mine.find((x) => x.rated_by === S).note === "頼りになる" && mine.find((x) => x.rated_by === N).power === 3 && mine.find((x) => x.rated_by === N).trust === 0, "DB: 2 行 (小西 力5 信用4 / 名取 力3)", mine);
await call(N, "genba_contact_ability_set", { contact: idE, scores: { 信用: 3 } });
const fe = await call(S, "genba_contact_find", { query: "高橋" });
ok(fe.match?.ability_avg["力"] === 4 && fe.match.ability_avg["信用"] === 3, "名取が力を付けていなくても (0)、小西の力 4 の平均は下がらない", fe.match?.ability_avg);

// ───────────────────────── 6. find / list の返り値に能力が入る
const fA = await call(S, "genba_contact_find", { query: "ヤマちゃん" });
ok(fA.match?.id === idA && fA.match.abilities.length === 2 && fA.match.abilities.some((x) => x.by === S && x.scores["力"] === 5 && x.scores["信用"] === 4 && x.note === "頼りになる") && fA.match.abilities.some((x) => x.by === N && x.scores["力"] === 3) && fA.match.ability_avg["力"] === 4, "genba_contact_find: 付けた人ごとの abilities と ability_avg が付く", fA.match?.abilities);
ok(fA.match.abilities.every((x) => x.at) && !("体力" in fA.match.abilities[0].scores) && fA.match.aliases.includes("ヤマちゃん") && fA.match.phone === "090-0000-0001" && Array.isArray(fA.match.sites) && "message_hint" in fA.match, "find: 点数は 0 の項目を出さず、付けた日時あり。既存の項目 (aliases / phone / message_hint…) も残る");
const fD = await call(S, "genba_contact_find", { query: "田中商事" });
ok(fD.match?.abilities?.length === 0 && fD.match.ability_avg === undefined, "評価のない人は abilities=[] (ability_avg なし)", fD.match);
const fam = await call(S, "genba_contact_find", { query: "山田" });
ok(fam.match === null && fam.candidates.length === 2 && fam.candidates.every((x) => Array.isArray(x.abilities)), "find: 同名の複数候補は今まで通り match=null (candidates にも abilities)");
let ls = await call(S, "genba_contact_list", { trade: "大工" });
ok(ls.count === 2 && ls.contacts.every((x) => Array.isArray(x.abilities)) && ls.contacts.find((x) => x.id === idA).abilities.length === 2, "genba_contact_list: 絞り込みは今まで通り、abilities が付く", ls.count);
ls = await call(S, "genba_contact_list", { role: "元請け" });
ok(ls.count === 1 && ls.contacts[0].name === "田中", "list の role 絞り込みも今まで通り");
const ups = await up({ name: "山田", company: "山田工務店", phone: "090-0000-9999" });
ok(!ups.created && ups.phone === "090-0000-9999" && ups.abilities.length === 2, "upsert で連絡先を直しても能力は消えない", ups.abilities);
const als = await call(S, "genba_contact_alias_add", { contact: idA, alias: "親方" });
ok(als.abilities.length === 2 && als.added[0] === "親方", "alias_add の返り値も今まで通り (+ abilities)");

// ───────────────────────── 7. 能力で探す (find)
const ids = (x) => x.contacts.map((c) => c.id);
let q = await call(S, "genba_contact_ability_find", { min: { 力: 4 } });
ok(q.count === 4 && ids(q)[0] === idC && new Set(ids(q)).size === 4 && [idC, idA, idE, idF].every((i) => ids(q).includes(i)), "「力が 4 以上」: 佐藤 (5)・山田 (5と3→平均 4)・高橋 (4)・伊藤 (4) が入り、点数の高い順 (佐藤が先頭)", ids(q));
ok(!ids(q).includes(idB) && !ids(q).includes(Number(D.id)) && q.conditions.min["力"] === 4 && q.conditions.by === "付けた人の平均", "鈴木 (力 3)・評価のない田中は出ない。条件の読み取り (conditions) が返る", q.conditions);
q = await call(S, "genba_contact_ability_find", { min: { 信用: 4 }, trade: "大工" });
ok(JSON.stringify(ids(q)) === JSON.stringify([idB, idA]), "「信用 4 以上かつ大工」: 鈴木 (5)・山田 (4) だけ。電気の佐藤は職種で外れる", ids(q));
q = await call(S, "genba_contact_ability_find", { min: { 力: 4, 信用: 4 } });
ok(JSON.stringify(ids(q)) === JSON.stringify([idC, idA]), "複数条件は全部満たす人だけ (かつ)", ids(q));
ok(q.contacts[0].score_used.scores["力"] === 5 && q.contacts[0].abilities.length >= 1 && q.contacts[0].name === "佐藤" && "channels" in q.contacts[0], "各人に score_used・abilities と、連絡先の通常の項目が付く");
q = await call(S, "genba_contact_ability_find", { min: { 力: 4 }, by: "小西" });
ok(q.count === 4 && [idA, idC, idE, idF].every((i) => ids(q).includes(i)) && q.conditions.by === "小西" && q.contacts.find((c) => c.id === idA).score_used.scores["力"] === 5 && q.contacts.find((c) => c.id === idA).score_used.by === "小西", "by=小西: 小西の点数だけで見る (山田は 5。平均 4 ではない)", { ids: ids(q) });
q = await call(S, "genba_contact_ability_find", { min: { 力: 4 }, by: "名取" });
ok(q.count === 0, "by=名取: 名取の力は山田 3 だけ → 4 以上はいない", q.count);
q = await call(S, "genba_contact_ability_find", { min: { 力: 3 }, by: "名取" });
ok(ids(q).length === 1 && ids(q)[0] === idA, "by=名取 力 3 以上 → 山田だけ");
q = await call(S, "genba_contact_ability_find", { trade: "電気" });
ok(ids(q).join() === String(idC), "条件が職種だけでも、評価のある人だけ返る (電気 → 佐藤)", ids(q));
q = await call(S, "genba_contact_ability_find", { role: "職人" });
ok(q.count === 5 && !ids(q).includes(Number(D.id)) && !ids(q).includes(Number(A2.id)), "role=職人: 評価のある職人だけ (山田・鈴木・佐藤・高橋・伊藤)。評価のない職人は出ない", ids(q));
q = await call(S, "genba_contact_ability_find", {});
ok(q.count === 5, "条件が空なら評価のある人の一覧", q.count);
q = await call(S, "genba_contact_ability_find", { min: { 力: 1 }, limit: 2 });
ok(q.count === 2 && q.matched === 5, "limit が効く (matched は全体の件数)", { count: q.count, matched: q.matched });
q = await call(S, "genba_contact_ability_find", { min: { 力: 5 } });
ok(ids(q).join() === String(idC), "力 5 以上: 平均が 5 の人だけ (佐藤)。平均 4.0 の山田・4 の伊藤は入らない", ids(q));
await throws(() => call(S, "genba_contact_ability_find", { min: { 力: 0 } }), /1〜5/, "条件の 0 はエラー (未評価は条件にならない)");
await throws(() => call(S, "genba_contact_ability_find", { min: { 力: 6 } }), /1〜5/, "条件の 6 はエラー");
await throws(() => call(S, "genba_contact_ability_find", { min: { 腕力: 3 } }), /能力名が違う/, "条件の能力名が違えばエラー");
const nobody = await call(S, "genba_contact_ability_find", { min: { 信用: 5 }, trade: "存在しない職種" });
ok(nobody.count === 0 && nobody.matched === 0 && nobody.contacts.length === 0, "該当なしは空で返る (エラーにしない)");

// ───────────────────────── 8. 名取のトークン・ツール定義・社内用の注意
q = await call(N, "genba_contact_ability_find", { min: { 信用: 5 } });
ok(q.count === 2 && q.contacts.every((c) => c.abilities.length >= 1), "名取のトークンでも探せる (社内用)", q.count);
const defs = Object.fromEntries(tools(S).map((t) => [t.name, t]));
ok(!!defs.genba_contact_ability_set && !!defs.genba_contact_ability_find && defs.genba_contact_ability_find.annotations?.readOnlyHint === true && !defs.genba_contact_ability_set.annotations?.readOnlyHint, "ツール 2 つが載る (find だけ readOnlyHint)");
ok(["genba_contact_ability_set", "genba_contact_ability_find", "genba_contact_find", "genba_contact_list"].every((n) => /本人・相手の会社への文面/.test(defs[n].description)), "4 つのツール説明すべてに「社内用・本人に送る文面に書かない」");
ok(ABILITIES.every((a) => defs.genba_contact_ability_set.description.includes(a.label)) && Object.keys(defs.genba_contact_ability_set.inputSchema.properties.scores.properties).length === 13, "set の説明と schema に 13 項目が出る");
ok(/連絡先の能力/.test(g.instructions) && /genba_contact_ability_find/.test(g.instructions), "手順書 (instructions) に能力の節が入る");
ok(!["genba_contact_upsert", "genba_contact_alias_add", "genba_contact_remove"].some((n) => /本人・相手の会社への文面/.test(defs[n].description)), "能力に関係しない既存ツールの説明は変えていない");

// ───────────────────────── 9. 連絡先を消すと能力も消える (既存の remove)
await throws(() => call(N, "genba_contact_remove", { contact: idF }), /小西/, "remove は今まで通り小西のトークンだけ");
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_abilities WHERE contact_id=$1`, [idF]))[0].n === 1, "名取が消せなかったので能力も残っている");
await call(S, "genba_contact_remove", { contact: idF });
ok((await rows(`SELECT count(*)::int AS n FROM genba_contact_abilities WHERE contact_id=$1`, [idF]))[0].n === 0 && (await rows(`SELECT count(*)::int AS n FROM genba_contacts`))[0].n === 6, "連絡先を消すと、その人の能力も一緒に消える (他の人は残る)");
q = await call(S, "genba_contact_ability_find", { role: "職人" });
ok(q.count === 4, "消えた人は find にも出ない", q.count);

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
