// 期限 (due_on) の扱いのテスト: 「決まっている日だけ・なければ なるはや」。出どころ (due_source)・カレンダーの【なるはや】【目安】・監査の「なるはや一覧」・既存データの移行。
// 本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ。カレンダーは代役 (メモリ上)。
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/due.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 900) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

const db = new PGlite();
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
const pool = { query: (s, p) => db.query(s, p) };
const rows = async (sql, p) => (await db.query(sql, p)).rows;
await db.query(`INSERT INTO sites (name) VALUES ('入谷')`);

// 代役のカレンダー
const events = new Map(); let evSeq = 1;
const cal = { events: {
  list: async () => ({ data: { items: [...events.values()] } }),
  insert: async ({ requestBody }) => { const id = `ev${evSeq++}`; events.set(id, { id, status: "confirmed", ...requestBody }); return { data: { id } }; },
  patch: async ({ eventId, requestBody }) => { events.set(eventId, { ...events.get(eventId), ...requestBody }); return { data: events.get(eventId) }; },
  get: async ({ eventId }) => { const e = events.get(eventId); if (!e) { const err = new Error("gone"); err.code = 404; throw err; } return { data: e }; },
  delete: async ({ eventId }) => { events.delete(eventId); return {}; },
} };
const mk = () => createGenba({ getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); }, getCalendarApi: async () => cal });
let g = mk(), cache = {};
const tools = (by) => (cache[by] ||= g.tools(by));
const call = (by, name, args = {}) => { const t = tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西";
await g.ensureSchema();
await db.query(`INSERT INTO genba_settings (key, value, updated_by) VALUES ('task_calendar', '{"calendarId":"cal1","colors":{"小西":"8"}}'::jsonb, 'test') ON CONFLICT (key) DO NOTHING`);

const jst = (n = 0) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
const TODAY = jst(0), FUTURE = jst(10), PAST = jst(-5);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const add = (o, by = S) => call(by, "genba_log_add", { site: "入谷", kind: "次やること", force: true, ...o });
const evOf = (logId) => [...events.values()].find((e) => e.extendedProperties?.private?.keihiTaskId === String(logId));
const sync = () => g.syncTaskCalendar({ by: "テスト" });

// ───────── 1. 期限なし = なるはや。警告なしで入り、カレンダーの今日に【なるはや】で出る
const r1 = await add({ title: "平居さんへの回答を送る", body: "入谷の最終金額の件で回答する。日付は誰も決めていない" });
ok(r1.log.due_on === null && r1.log.due_source === undefined && !(r1.followups || []).some((f) => /期限/.test(f)), "(合格 1) 期限なしで入る。「期限を付けろ」の followups は出ない", r1.followups);
await sync();
const e1 = evOf(r1.log.id);
ok(e1 && e1.summary.startsWith("【なるはや】") && e1.start.date === TODAY, "(合格 1) タスクカレンダーの今日に【なるはや】で出る", e1 && { s: e1.summary, d: e1.start.date });

// ───────── 2. 目安 (ai_guess) は【目安】付き。言った日 (stated)・日程 (schedule) は付かない
const r2 = await add({ title: "目安の期限のタスク", body: "AI が目安で置いた", due_on: FUTURE, due_source: "ai_guess" });
const r2b = await add({ title: "言われた期限のタスク", body: "相手が言った", due_on: FUTURE, due_source: "stated" });
const r2c = await add({ title: "日程のタスク", body: "決まった日程", due_on: FUTURE, due_source: "schedule" });
const r2d = await add({ title: "過ぎた目安のタスク", body: "目安が過ぎた", due_on: PAST, due_source: "ai_guess" });
const r2e = await add({ title: "過ぎた期限のタスク", body: "言われた期限が過ぎた", due_on: PAST, due_source: "stated" });
await sync();
ok(r2.log.due_on === FUTURE && r2.log.due_source === "ai_guess" && evOf(r2.log.id).summary === "【目安】目安の期限のタスク" && evOf(r2.log.id).start.date === FUTURE, "(合格 2) ai_guess の期限は、カレンダーに【目安】付きで、その日付に出る", evOf(r2.log.id)?.summary);
ok(evOf(r2b.log.id).summary === "言われた期限のタスク" && evOf(r2c.log.id).summary === "日程のタスク" && r2b.log.due_source === "stated" && r2c.log.due_source === "schedule", "stated / schedule は【目安】が付かない (本当の期限)", [evOf(r2b.log.id).summary, evOf(r2c.log.id).summary]);
ok(evOf(r2d.log.id).summary === `【期限切れ ${md(PAST)}】【目安】過ぎた目安のタスク` && evOf(r2d.log.id).start.date === TODAY && evOf(r2e.log.id).summary === `【期限切れ ${md(PAST)}】過ぎた期限のタスク`, "過ぎた目安は【期限切れ】+【目安】、過ぎた本当の期限は【期限切れ】だけ (今日に出す)", [evOf(r2d.log.id).summary, evOf(r2e.log.id).summary]);

// ───────── 3. due_on を入れて due_source を省くとエラー (add / add_many / fix)
await throws(() => add({ title: "出どころ無し", body: "x", due_on: FUTURE }), /due_source が必須/, "(合格 3) due_on を入れて due_source を省くとエラー (genba_log_add)");
await throws(() => add({ title: "出どころ無し", body: "x", due_on: FUTURE, due_source: "unknown" }), /due_source は/, "due_source=unknown は新しく入れるときには使えない");
await throws(() => add({ title: "出どころ違い", body: "x", due_on: FUTURE, due_source: "てきとう" }), /due_source は/, "due_source が stated / schedule / ai_guess 以外ならエラー");
await throws(() => add({ title: "日付違い", body: "x", due_on: "来週", due_source: "stated" }), /YYYY-MM-DD/, "due_on が日付でも なるはや でもなければエラー");
const many = await call(S, "genba_log_add_many", { site: "入谷", items: [
  { kind: "次やること", title: "ガラスの発注数を数える", body: "a", due_on: FUTURE, due_source: "stated" },
  { kind: "次やること", title: "巾木の色を決めて連絡", body: "b", due_on: FUTURE },
  { kind: "次やること", title: "鍵の返却を済ませる", body: "c" },
] });
ok(many.added === 2 && many.failed === 1 && /due_source が必須/.test(many.results[1].error), "add_many: 出どころの無い 1 件だけエラー、ほかは入る", many.results.map((x) => x.ok ? "ok" : x.error));
await throws(() => call(S, "genba_log_fix", { id: r1.log.id, due_on: FUTURE }), /due_source が必須/, "genba_log_fix でも、due_on を入れて due_source を省くとエラー");
ok((await rows(`SELECT due_on FROM genba_log WHERE id=$1`, [r1.log.id]))[0].due_on === null, "エラーのときは、期限は変わらない");

// ───────── 4. 「なるはや」は空と同じ (エラーにしない)
const r4 = await add({ title: "なるはやと書かれた", body: "AI が なるはや と書いた", due_on: "なるはや", due_source: "ai_guess" });
ok(r4.log.due_on === null && r4.log.due_source === undefined && !(r4.followups || []).some((f) => /期限/.test(f)), "(任意) due_on=なるはや は 空 (null) で保存される。due_source は付かない", r4.log);
const r4b = await add({ title: "空文字の期限", body: "x", due_on: "", due_source: "stated" });
ok(r4b.log.due_on === null && r4b.log.due_source === undefined, "due_on が空文字でも、期限なし");
const r4c = await add({ title: "出どころだけ", body: "x", due_source: "stated" });
ok(r4c.log.due_on === null && r4c.log.due_source === undefined, "due_on が無ければ、due_source は付けない (無視)");
const fx1 = await call(S, "genba_log_fix", { id: r2.log.id, due_on: "なるはや" });
ok(fx1.log.due_on === null && fx1.log.due_source === undefined && fx1.before.due_on === FUTURE && fx1.before.due_source === "ai_guess", "genba_log_fix(due_on=なるはや) で期限を消す (出どころも消え、前の値は edits に残る)", fx1);
const fx2 = await call(S, "genba_log_fix", { id: r2b.log.id, due_on: "" });
ok(fx2.log.due_on === null && fx2.log.due_source === undefined, "genba_log_fix(due_on=空文字) でも期限を消す");

// ───────── 5. 直す: 目安 → 言われた日・出どころだけ直す
const r5 = await add({ title: "目安から本当の期限へ", body: "x", due_on: FUTURE, due_source: "ai_guess" });
await sync();
ok(evOf(r5.log.id).summary.startsWith("【目安】"), "(準備) 目安は【目安】付き");
const fx3 = await call(S, "genba_log_fix", { id: r5.log.id, due_on: jst(12), due_source: "stated" });
await sync();
ok(fx3.log.due_on === jst(12) && fx3.log.due_source === "stated" && evOf(r5.log.id).summary === "目安から本当の期限へ" && evOf(r5.log.id).start.date === jst(12), "目安を、言われた日 (stated) に直すと【目安】が外れて日付も動く", [fx3.log, evOf(r5.log.id).summary]);
const r5b = await add({ title: "出どころだけ直す", body: "x", due_on: FUTURE, due_source: "ai_guess" });
const fx4 = await call(S, "genba_log_fix", { id: r5b.log.id, due_source: "stated" });
ok(fx4.log.due_on === FUTURE && fx4.log.due_source === "stated" && fx4.before.due_source === "ai_guess", "出どころだけ直せる (due_on はそのまま)");
await throws(() => call(S, "genba_log_fix", { id: r1.log.id, due_source: "stated" }), /due_on があるときだけ/, "期限なしの行に出どころだけ付けるとエラー");

// ───────── 6. カレンダーで人が動かす・人が作る → stated
const r6 = await add({ title: "人が動かす", body: "x", due_on: FUTURE, due_source: "ai_guess" });
await sync();
const ev6 = evOf(r6.log.id);
events.set(ev6.id, { ...ev6, start: { date: jst(20) }, end: { date: jst(21) } });
const st6 = await sync();
const row6 = (await rows(`SELECT due_on, due_source FROM genba_log WHERE id=$1`, [r6.log.id]))[0];
ok(st6.due_changed >= 1 && row6.due_source === "stated" && String(row6.due_on.toISOString?.() || row6.due_on).startsWith(jst(20)) && evOf(r6.log.id).summary === "人が動かす", "カレンダーで人が日付を動かすと、人が決めた期限 (stated) になり、【目安】が外れる", { row6, st6, s: evOf(r6.log.id).summary });
events.set("human1", { id: "human1", status: "confirmed", summary: "人が作った予定", start: { date: jst(15) }, end: { date: jst(16) } });
await sync();
const imp = (await rows(`SELECT id, due_on, due_source FROM genba_log WHERE calendar_event='human1'`))[0];
ok(imp && imp.due_source === "stated", "人がカレンダーに作った予定を取り込んだ行は stated");

// ───────── 7. 監視ジョブの目録 (source_mark) は止めない: due_source が無ければ unknown で入れて知らせる
await call(S, "genba_source_add", { channel: "LINE", room: "r1" });
const sm = await call(S, "genba_source_mark", { channel: "LINE", room: "r1", cursor: { last_id: "m2", last_at: "2026-11-24T00:00:00Z" }, items: [
  { id: "m1", kind: "次やること", sender: "平居", at: "2026-11-24T00:00:00Z", gist: "回答する", title: "目録 A", body: "目録から", site: "入谷", due_on: FUTURE },
  { id: "m2", kind: "次やること", sender: "平居", at: "2026-11-24T00:01:00Z", gist: "送る", title: "目録 B", body: "目録から", site: "入谷", due_on: FUTURE, due_source: "stated" },
] });
const rowsSM = await rows(`SELECT title, due_source FROM genba_log WHERE title IN ('目録 A','目録 B') ORDER BY title`);
ok(!sm.errors?.length && rowsSM[0].due_source === "unknown" && rowsSM[1].due_source === "stated" && (sm.followups || []).some((f) => /due_source/.test(f)), "監視の目録: due_source が無い item も止めずに入る (unknown + followups で知らせる)。ある item はそのまま", { sm: sm.errors, rowsSM, f: sm.followups });

// ───────── 8. 監査: 期限なしは「なるはや一覧」。警告ではない
const au = await call(S, "genba_audit", {});
const asapIds = au.asap.map((x) => x.id);
ok(Array.isArray(au.asap) && asapIds.includes(r1.log.id) && asapIds.includes(r4.log.id) && !asapIds.includes(r2c.log.id) && au.asap_count === au.asap.length && au.asap.every((x) => x.due_on === undefined), "(合格 4) genba_audit が期限なしのタスクを なるはや一覧 (asap) として返す (作ったばかりのものも)", au.asap.map((x) => x.id));
ok(!("no_due" in au) && !/期限なし/.test(au.summary) && !(au.how_to_fix || []).some((x) => /^期限なし/.test(x)) && !/期限を付けて|期限を付けろ|due_on を付ける/.test(JSON.stringify(au)), "(合格 4) 「期限なし」の警告 (no_due・summary・how_to_fix) は無く、「期限を付けて」とは言わない");
ok(/警告ではない/.test(au.asap_note) && /期限を付けなくていい/.test(au.asap_note), "asap_note: 警告ではない・付けなくていい");
ok(au.overdue.some((x) => x.id === r2e.log.id && x.due_source === "stated") && au.overdue.some((x) => x.id === r2d.log.id && x.due_source === "ai_guess") && /期限切れ/.test(au.summary), "期限切れの監査は今まで通り (出どころも付く)");
ok((au.how_to_fix || []).some((x) => /ai_guess/.test(x) && /なるはや/.test(x)), "期限切れの対処に、目安が過ぎただけのものは なるはや に戻すと書いてある");

// ───────── 9. タスク一覧
const tk = await call(S, "genba_tasks", { who: undefined });
const tkMap = new Map(tk.tasks.map((t) => [t.id, t]));
ok(tkMap.get(r1.log.id).asap === true && tkMap.get(r1.log.id).due_on === null && tkMap.get(r2c.log.id).asap === undefined && tkMap.get(r2c.log.id).due_source === "schedule" && tkMap.get(r2e.log.id).overdue === true && tkMap.get(r2e.log.id).due_source === "stated", "genba_tasks: 期限なしは asap: true、期限ありは due_source つき");
const st = await call(S, "genba_status", { site: "入谷" });
ok(st.todos.some((x) => x.id === r2e.log.id && x.due_source === "stated") && st.todos.find((x) => x.id === r1.log.id).due_on === null, "genba_status の未解決 (todos) にも due_source が付く", st.todos.map((x) => [x.id, x.due_source]));

// ───────── 10. 説明文・手順書: 「due_on は必ず付ける」が残っていない。指示された文言が入っている
const ins = g.instructions, defs = Object.fromEntries(tools(S).map((t) => [t.name, t]));
ok(!/due_on は必ず付ける/.test(ins) && !/無いと毎日【なるはや】/.test(ins) && !/必ず付ける \(無いと/.test(ins), "(合格 5) instructions に「due_on は必ず付ける」が残っていない");
ok(/due_on は、相手か小西が言った日・決まっている日程があるときだけ付ける/.test(ins) && /決まっていなければ空にする/.test(ins) && /なるはや。タスクカレンダーの今日に【なるはや】で出続ける/.test(ins) && /AIが目安の日付を作らない/.test(ins), "instructions に、指示された書き方 (言った日・決まっている日程だけ / 決まっていなければ空 = なるはや / AI が目安の日付を作らない) が入っている");
const allDesc = Object.values(defs).map((t) => `${t.description} ${JSON.stringify(t.inputSchema)}`).join("\n");
ok(!/due_on は必ず/.test(allDesc) && !/期限を付ける\b/.test(allDesc) && /due_source/.test(defs.genba_log_add.description) && /due_source/.test(defs.genba_log_fix.description), "ツールの説明にも「必ず付ける」は無く、log_add / log_fix は due_source を説明している");
ok(["genba_log_add", "genba_log_fix"].every((n) => defs[n].inputSchema.properties.due_source?.enum.join() === "stated,schedule,ai_guess" && /なるはや|省略|空/.test(defs[n].inputSchema.properties.due_on.description)) && defs.genba_log_add.inputSchema.properties.due_source.description.includes("必須"), "due_source の引数 (stated / schedule / ai_guess) と、due_on の説明 (なるはや・空)");
ok(/なるはや一覧/.test(defs.genba_audit.description) && !/期限の無いタスク/.test(defs.genba_audit.description), "genba_audit の説明は「なるはや一覧」で、期限なしを警告として並べていない");

// ───────── 11. 既存データの移行 (一度だけ。期限は消さない・書き換えない)
const legacy = await db.query(`INSERT INTO genba_log (site_id, kind, body, written_by, due_on, title) VALUES ((SELECT id FROM sites LIMIT 1),'次やること','昔の期限つき','小西','2026-12-24','昔の期限つき') RETURNING id`);
const legacyNo = await db.query(`INSERT INTO genba_log (site_id, kind, body, written_by, title) VALUES ((SELECT id FROM sites LIMIT 1),'次やること','昔の期限なし','小西','昔の期限なし') RETURNING id`);
await db.query(`DELETE FROM genba_settings WHERE key='due_source_v1'`);
g = mk(); cache = {};
await g.ensureSchema();
const mg = (await rows(`SELECT id, due_on::text AS due_on, due_source FROM genba_log WHERE id = ANY($1::bigint[]) ORDER BY id`, [[legacy.rows[0].id, legacyNo.rows[0].id]]));
ok(mg[0].due_source === "unknown" && mg[0].due_on === "2026-12-24" && mg[1].due_source === null && mg[1].due_on === null, "(移行) 出どころの無い既存の期限は unknown になり、期限そのものは消えない。期限なしの行は NULL のまま", mg);
const marker = (await rows(`SELECT value FROM genba_settings WHERE key='due_source_v1'`))[0].value;
ok(marker.status === "done" && marker.marked_unknown >= 1, "移行の印 (due_source_v1) に結果が残る", marker);
// 一度だけ: 印が done なら、後から出どころの無い期限が入っても自動では書き換えない
await db.query(`UPDATE genba_log SET due_source=NULL WHERE id=$1`, [legacy.rows[0].id]);
g = mk(); cache = {};
await g.ensureSchema();
ok((await rows(`SELECT due_source FROM genba_log WHERE id=$1`, [legacy.rows[0].id]))[0].due_source === null, "移行は一度だけ (2 回目以降の起動では、書き換えない)");
const tkLegacy = await call(S, "genba_tasks", {});
ok(tkLegacy.tasks.find((t) => t.id === Number(legacy.rows[0].id))?.due_on === "2026-12-24", "出どころ不明の期限も、今まで通り期限として働く");
// 出どころ不明 (unknown) の期限は、カレンダーでは本当の期限と同じ (【目安】は付けない = 勝手に目安扱いにしない)
await db.query(`UPDATE genba_log SET due_source='unknown' WHERE id=$1`, [legacy.rows[0].id]);
await sync();
const evL = evOf(Number(legacy.rows[0].id));
ok(evL && !evL.summary.includes("【目安】") && evL.start.date === "2026-12-24", "unknown の期限は【目安】を付けない (自動で目安扱いにしない)", evL && evL.summary);

// ───────── 12. 既存の動き: 待ち・解決・カレンダー連携は変わらない
const w = await call(S, "genba_log_add", { site: "入谷", kind: "待ち", title: "平居さんの返事待ち", body: "最終金額の返事", who: "平居" });
ok(w.log.kind === "待ち" && w.log.due_on === null && !(w.followups || []).some((f) => /期限/.test(f)), "待ち は期限なしで今まで通り入る");
await sync();
ok(![...events.values()].some((e) => /平居さんの返事待ち/.test(e.summary || "")), "待ち はタスクカレンダーに出ない (今まで通り)");
const done = await call(S, "genba_log_add", { site: "入谷", kind: "解決", resolves_id: r1.log.id, body: "回答した", title: "回答済み" });
await sync();
ok(done.log.kind === "解決" && !evOf(r1.log.id), "解決するとカレンダーの予定は消える (今まで通り)");

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
