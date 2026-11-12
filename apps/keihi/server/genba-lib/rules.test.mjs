// 運用ルール (genba_rule_get / genba_rule_set) の個人ルールと目次のテスト。
// 本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ。旧スキーマ (UNIQUE(topic, version)) の既存データから移る
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/rules.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 800) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

const db = new PGlite();
// 本番の sites は infra/schema.sql + index.js の ALTER (address / key_box / postal / done_at) でできる
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
// 旧スキーマの genba_rules (個人ルールが入る前): UNIQUE (topic, version)。ここに今ある共通ルールを入れておく
await db.exec(`CREATE TABLE genba_rules (id BIGSERIAL PRIMARY KEY, topic TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, updated_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (topic, version))`);
const long = (n, s) => (s + "。詳しい決まりがここに続く。").repeat(n);
const legacy = [
  ["基本", 1, "# 基本（全AI共通・最初に読む10行）2026/11/5 小西\n1. 結論から・日本語。\n2. 小西に作業を返さない。"],
  ["連絡先", 1, "旧い連絡先ルール"], ["連絡先", 2, "旧い連絡先ルール 2"], ["連絡先", 3, "旧い連絡先ルール 3"],
  ["連絡先", 4, "# 連絡先と共有・非公開 2026/11/5 整理（旧「共有と非公開の仕分け」を統合）\n## 人・会社\n- 名前が出たら genba_contact_find"],
  ["見積", 1, "見積 v1"], ["見積", 2, "見積 v2"], ["見積", 3, "見積の書き方（2026/10/15 小西決定）\n1. 1行の金額が10万円を超えるものは「一式」にしない。"],
  ["連絡文", 17, "# 連絡文（LINE・メールを送るとき）\n" + long(250, "挨拶はその日の最初の1通だけ")],
  ["タスク", 7, "# タスクと記録（Keihi）2026/11/5 整理\n" + long(200, "1行1件で書く")],
  ["応答", 7, "→「連絡文」に統合しました（11/5）。"],
  ["長い題名", 1, "# " + "あ".repeat(90) + "\n本文"],
];
for (const [t, v, b] of legacy) await db.query(`INSERT INTO genba_rules (topic, version, body, updated_by) VALUES ($1,$2,$3,'小西')`, [t, v, b]);

const pool = { query: (s, p) => db.query(s, p) };
const mk = () => createGenba({ getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); } });
let g = mk(), cache = {};
const tools = (by) => (cache[by] ||= g.tools(by));
const call = (by, name, args = {}) => { const t = tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西", N = "名取", MON = "LINE監視";
const get = (by, topic) => call(by, "genba_rule_get", topic === undefined ? {} : { topic });
const set = (by, o) => call(by, "genba_rule_set", o);
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const latestCommon = Object.values(Object.fromEntries(legacy.map(([t, v, b]) => [t, [v, b]]))).map(([, b]) => b);
const commonBytes = latestCommon.reduce((s, b) => s + b.length, 0);

// ───────────────────────── 1. マイグレーション (旧スキーマの既存データから)
let first = await get(S);                                                   // 初回: ensureSchema が走る
const cols = (await rows(`SELECT column_name FROM information_schema.columns WHERE table_name='genba_rules'`)).map((r) => r.column_name);
ok(["owner", "summary"].every((c) => cols.includes(c)) && ["id", "topic", "version", "body", "updated_by", "created_at"].every((c) => cols.includes(c)), "genba_rules に owner / summary が足され、既存の列は残る", cols);
ok((await rows(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='genba_rules'::regclass AND contype='u'`))[0].n === 0, "旧い UNIQUE (topic, version) は外れる (共通と個人で同じ版の番号を使えるように)");
ok((await rows(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='genba_rules' AND indexname='genba_rules_scope_ver_uq'`))[0].n === 1, "代わりに (topic, owner, version) の一意が付く");
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules`))[0].n === legacy.length && (await rows(`SELECT count(*)::int AS n FROM genba_rules WHERE owner IS NOT NULL`))[0].n === 0, "既存の行は全部残り、全部 共通 (owner なし)");
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules WHERE topic='連絡先'`))[0].n === 4 && (await rows(`SELECT body FROM genba_rules WHERE topic='見積' AND version=3`))[0].body.startsWith("見積の書き方"), "版の履歴も本文もそのまま");
await mk().ensureSchema();
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules`))[0].n === legacy.length, "2 回走らせても同じ (落ちない・増えない)");

// ───────────────────────── 2. 共通ルールは今まで通り
let r = await get(S, "連絡先");
ok(r.topic === "連絡先" && r.version === 4 && r.body.startsWith("# 連絡先と共有・非公開") && r.updated_by === S && r.at && r.scope === "共通" && r.personal === undefined && r.priority === undefined, "topic 指定 (共通だけ): topic / version / body / updated_by / at は今まで通り。個人の付記は無い", r);
r = await get(S, "存在しない");
ok(r.topic === "存在しない" && r.body === null && /まだ無い/.test(r.note), "無い topic は body=null");
r = await set(S, { topic: "見積", body: "見積 v4 (共通)" });
ok(r.topic === "見積" && r.version === 4 && r.scope === "共通" && r.owner === undefined && r.updated_by === S && r.created_at && /共通ルール/.test(r.note), "共通ルールの書き込みは今まで通り (版 3 → 4)・scope 省略 = 共通", r);
ok((await get(N, "見積")).body === "見積 v4 (共通)", "名取のトークンでも共通の最新版が読める");
r = await set(N, { topic: "見積", body: "見積 v5 (共通・名取が書いた)", scope: "共通" });
ok(r.version === 5 && r.scope === "共通" && r.updated_by === N, "scope=共通 を明示しても同じ (共通は今まで通り誰のトークンでも書ける)");
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules WHERE topic='見積'`))[0].n === 5, "版は積まれるだけ (見積: 5 行)");

// ───────────────────────── 3. 個人ルール (scope=個人): 書く
await throws(() => set(S, { topic: "見積", body: "x", scope: "みんな" }), /scope は/, "scope が 共通 / 個人 以外ならエラー");
await throws(() => set(S, { topic: "", body: "x" }), /topic と body/, "topic が空ならエラー");
await throws(() => set(S, { topic: "見積", body: "" }), /topic と body/, "body が空ならエラー");
await throws(() => set(S, { topic: "見積", body: "x", scope: "個人", summary: "あ".repeat(61) }), /60 字まで/, "summary 61 字はエラー");
r = await set(S, { topic: "見積", body: "【小西の個人】見積は必ず私に先に見せる。", scope: "個人" });
ok(r.scope === "個人" && r.owner === S && r.version === 1 && r.topic === "見積" && /個人ルール \(小西\)/.test(r.note) && /個人を優先/.test(r.note), "個人ルール: owner = 呼び出したトークンの持ち主 (小西)。版は共通とは別に 1 から", r);
let own = await rows(`SELECT owner, version, body FROM genba_rules WHERE topic='見積' ORDER BY COALESCE(owner,''), version`);
ok(own.filter((x) => x.owner === null).length === 5 && own.filter((x) => x.owner === S).length === 1 && own.find((x) => x.owner === S).version === 1 && own.some((x) => x.owner === null && x.version === 1), "DB: 共通の版 1 と個人の版 1 が同じ topic に並ぶ (共通の行は 5 のまま)", own);
r = await set(N, { topic: "見積", body: "【名取の個人】金額は税抜で書く。", scope: "personal" });
ok(r.scope === "個人" && r.owner === N && r.version === 1, "名取の個人ルールは名取が owner。scope=\"personal\" でも通る (別名)", r);
r = await set(S, { topic: "小西メモ", body: "# 小西だけのメモ\n夜は返さない", scope: "個人", summary: "小西だけに効く連絡の決まり" });
ok(r.version === 1 && r.summary === "小西だけに効く連絡の決まり" && r.scope === "個人", "共通が無い topic にも個人ルールだけを書ける");

// ───────────────────────── 4. 個人ルール: 読む (共通 + 自分の個人。他人のは返さない)
r = await get(S, "見積");
const iC = r.body.indexOf("見積 v5 (共通"), iM = r.body.indexOf("【個人ルール (小西)】"), iP = r.body.indexOf("【小西の個人】");
ok(iC === 0 && iM > iC && iP > iM && /個人ルール \(小西\)】共通ルールと食い違うときは、この個人ルールを優先する/.test(r.body), "小西: 共通の本文の後ろに個人が付き、「個人を優先」と明記される", r.body);
ok(r.scope === "共通+個人" && r.priority === "個人を優先" && r.version === 5 && r.personal.version === 1 && r.personal.updated_by === S && r.personal.at, "scope=共通+個人・priority・個人の版と更新者 (version は共通の版)", r);
ok(!r.body.includes("名取の個人") && !JSON.stringify(r).includes("名取の個人"), "小西 (管理者) にも名取の個人ルールは返らない");
r = await get(N, "見積");
ok(r.body.includes("見積 v5 (共通") === true && r.body.indexOf("【個人ルール (名取)】") > 0 && r.body.includes("【名取の個人】") && !r.body.includes("小西の個人") && r.scope === "共通+個人", "名取: 共通 + 名取の個人だけ。小西の個人は返らない", r.body);
r = await get(MON, "見積");
ok(r.scope === "共通" && r.personal === undefined && r.body === "見積 v5 (共通・名取が書いた)" && !r.body.includes("個人"), "個人ルールを持たないトークン (監視ジョブ) は共通だけ・付記なし");
r = await get(S, "小西メモ");
ok(r.scope === "個人" && r.body.startsWith("【個人ルール (小西)】\n# 小西だけのメモ") && r.version === 1 && r.personal === undefined && r.priority === undefined, "個人ルールだけの topic: 個人として返る (比べる共通が無いので priority なし)", r);
r = await get(N, "小西メモ");
ok(r.body === null && /まだ無い/.test(r.note) && !JSON.stringify(r).includes("夜は返さない"), "他人の個人ルールだけの topic は、名取には「まだ無い」(中身も出さない)");

// ───────────────────────── 5. 版の履歴: 消さずに積む (個人も)
r = await set(S, { topic: "見積", body: "【小西の個人 v2】見積は私に先に見せる。金額は税込で。", scope: "個人" });
ok(r.version === 2, "個人ルールの 2 回目は版 2");
r = await get(S, "見積");
ok(r.body.includes("【小西の個人 v2】") && !r.body.includes("【小西の個人】見積は必ず") && r.personal.version === 2 && r.version === 5, "読むのは最新版だけ (個人 v2)。共通は変わらず v5");
own = await rows(`SELECT owner, version, body FROM genba_rules WHERE topic='見積' AND owner=$1 ORDER BY version`, [S]);
ok(own.length === 2 && own[0].body.includes("見積は必ず私に先に") && own[1].version === 2, "DB: 個人の v1 も残っている (上書き・削除なし)", own);
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules WHERE topic='見積' AND owner IS NULL`))[0].n === 5 && (await rows(`SELECT count(*)::int AS n FROM genba_rules WHERE topic='見積' AND owner=$1`, [N]))[0].n === 1, "共通 5 行・名取の個人 1 行は変わらない");
r = await set(S, { topic: "見積", body: "見積 v6 (共通)" });
ok(r.version === 6 && (await get(S, "見積")).personal.version === 2, "共通を更新しても個人の版は別に数える (共通 v6・個人 v2)");
ok((await rows(`SELECT count(*)::int AS n FROM genba_rules`))[0].n === legacy.length + 7, "ここまで書き込み 7 回 = 7 行増えただけ (追記だけ・行は減っていない)");

// ───────────────────────── 6. topic 省略 = 基本 + 目次だけ
const idx = await get(S);
ok(Object.keys(idx).sort().join() === "basic,general_notes,index,judgment_modes,note" && !("rules" in idx), "topic 省略: basic / index / note (+ 会社の決まり general_notes・判断ログのモード judgment_modes)。全文の rules は返さない", Object.keys(idx));
ok(idx.basic.topic === "基本" && idx.basic.body.startsWith("# 基本（全AI共通・最初に読む10行）") && idx.basic.scope === "共通" && idx.basic.version === 1, "basic = 「基本」の本文", idx.basic);
ok(idx.index.every((e) => e.topic && typeof e.summary === "string" && e.summary.length > 0 && Number.isInteger(e.version) && e.at && e.scope) && idx.index.every((e) => !("body" in e)), "目次: topic 名・1 行説明・版・更新日・scope。本文は入らない", idx.index.slice(0, 2));
ok(idx.index[0].topic === "基本" && idx.index[1].topic === "連絡先", "並びは 基本 → 連絡先 → ほか", idx.index.map((e) => e.topic));
const topics = idx.index.map((e) => e.topic);
ok(["基本", "連絡先", "見積", "連絡文", "タスク", "応答", "長い題名", "小西メモ"].every((t) => topics.includes(t)) && topics.length === 8 && new Set(topics).size === 8, "全 topic が 1 つずつ載る (小西は自分の個人だけの「小西メモ」も)", topics);
const bySummary = Object.fromEntries(idx.index.map((e) => [e.topic, e]));
ok(bySummary["基本"].summary === "基本（全AI共通・最初に読む10行）2026/11/5 小西" && bySummary["連絡先"].summary.startsWith("連絡先と共有・非公開 2026/11/5 整理") && !bySummary["連絡先"].summary.startsWith("#"), "1 行説明 (指定なし): 本文の最初の行から「# 」を外したもの", { a: bySummary["基本"].summary, b: bySummary["連絡先"].summary });
ok([...bySummary["長い題名"].summary].length === 61 && bySummary["長い題名"].summary.endsWith("…"), "長い 1 行目は 60 字で切って「…」", bySummary["長い題名"].summary.length);
ok(bySummary["応答"].summary === "→「連絡文」に統合しました（11/5）。", "統合済みの topic は「→…に統合しました」がそのまま説明になる");
ok(bySummary["連絡先"].version === 4 && bySummary["見積"].version === 6 && bySummary["連絡文"].version === 17, "版は topic ごとの最新 (共通の版)", [bySummary["連絡先"].version, bySummary["見積"].version]);
ok(bySummary["見積"].scope === "共通+個人" && bySummary["見積"].personal.version === 2 && bySummary["連絡先"].scope === "共通" && bySummary["連絡先"].personal === undefined && bySummary["小西メモ"].scope === "個人" && bySummary["小西メモ"].summary === "小西だけに効く連絡の決まり", "目次の scope: 共通 / 共通+個人 / 個人 (個人の版つき)・個人の指定説明", bySummary["見積"]);
const sz = JSON.stringify(idx).length;
ok(sz < commonBytes / 4 && commonBytes > 10000, `全文を返さないので小さい (共通ルールの本文 ${commonBytes} 字 → 返り値 ${sz} 字)`, { sz, commonBytes });
ok(/genba_rule_get\(topic\)/.test(idx.note) && Array.isArray(idx.judgment_modes) && Array.isArray(idx.general_notes), "note に本文の読み方。judgment_modes / general_notes は今まで通り付く");
// 名取から見た目次: 自分の個人 (見積) は付くが、小西の個人だけの topic は topic 名も出ない
const idxN = await get(N);
ok(!idxN.index.some((e) => e.topic === "小西メモ") && idxN.index.length === 7 && !JSON.stringify(idxN).includes("小西だけ") && !JSON.stringify(idxN).includes("夜は返さない") && idxN.index.find((e) => e.topic === "見積").scope === "共通+個人" && idxN.index.find((e) => e.topic === "見積").personal.version === 1, "名取の目次: 小西の個人だけの topic は topic 名・説明・中身とも出ない。見積は名取の個人 (版 1) が付く", idxN.index.map((e) => e.topic));
const idxM = await get(MON);
ok(idxM.index.length === 7 && idxM.index.every((e) => e.scope === "共通"), "個人ルールの無い監視ジョブには共通だけの目次");
ok(JSON.stringify(idxN).length < commonBytes / 4, "名取の目次も小さい");

// ───────────────────────── 7. 基本に個人ルール・summary の指定と引き継ぎ
r = await set(S, { topic: "基本", body: "【小西の個人】LINE は夜 9 時以降に送らない。", scope: "個人" });
let idx2 = await get(S);
ok(idx2.basic.scope === "共通+個人" && idx2.basic.priority === "個人を優先" && idx2.basic.body.startsWith("# 基本（全AI共通") && idx2.basic.body.includes("【個人ルール (小西)】") && idx2.basic.body.endsWith("夜 9 時以降に送らない。"), "basic にも個人が後ろに付く (個人を優先)", idx2.basic.body.slice(-120));
ok((await get(N)).basic.scope === "共通" && !(await get(N)).basic.body.includes("夜 9 時"), "名取の basic には小西の個人は付かない");
await set(S, { topic: "タスク", body: "# タスク v8\n本文", summary: "タスクと記録の書き方" });
let t = (await get(S)).index.find((e) => e.topic === "タスク");
ok(t.summary === "タスクと記録の書き方" && t.version === 8, "summary を指定すると目次に出る", t);
await set(S, { topic: "タスク", body: "# タスク v9\n本文を直した" });
t = (await get(S)).index.find((e) => e.topic === "タスク");
ok(t.summary === "タスクと記録の書き方" && t.version === 9, "次の版で summary を省略すると前の版のものを引き継ぐ", t);
await set(S, { topic: "タスク", body: "# タスク v10\n本文", summary: "  タスクの\n書き方 (新)  " });
t = (await get(S)).index.find((e) => e.topic === "タスク");
ok(t.summary === "タスクの 書き方 (新)" && t.version === 10, "summary を変えれば新しいものに。前後の空白・改行は整える", t.summary);
await set(S, { topic: "タスク", body: "【個人】タスクの個人ルール", scope: "個人", summary: "小西のタスク流儀" });
t = (await get(S)).index.find((e) => e.topic === "タスク");
ok(t.summary === "タスクの 書き方 (新)" && t.scope === "共通+個人", "個人の summary は共通の説明を書き換えない (共通を優先して表示)");
ok((await rows(`SELECT summary FROM genba_rules WHERE topic='タスク' AND owner=$1`, [S]))[0].summary === "小西のタスク流儀" && (await get(N)).index.find((e) => e.topic === "タスク").summary === "タスクの 書き方 (新)", "個人の summary は個人の行にだけ入り、名取には共通の説明が出る");

// ───────────────────────── 8. 他人の個人ルールは、どの読み方でも返らない
const everything = JSON.stringify([await get(N), await get(N, "見積"), await get(N, "基本"), await get(N, "タスク"), await get(N, "小西メモ"), await get(MON), await get(MON, "見積")]);
ok(!/小西の個人|小西だけ|夜 9 時|小西のタスク流儀|個人ルール \(小西\)|タスクの個人ルール/.test(everything), "名取・監視ジョブのどの読み方にも、小西の個人ルールは出ない");
const everythingS = JSON.stringify([await get(S), await get(S, "見積"), await get(S, "基本"), await get(S, "小西メモ")]);
ok(!/名取の個人|個人ルール \(名取\)/.test(everythingS), "小西 (管理者) の読み方にも、名取の個人ルールは出ない (既定では返さない)");
await set(N, { topic: "名取だけ", body: "名取だけの個人ルール", scope: "個人" });
ok((await get(S)).index.every((e) => e.topic !== "名取だけ") && (await get(S, "名取だけ")).body === null && (await get(N)).index.some((e) => e.topic === "名取だけ" && e.scope === "個人"), "名取の個人だけの topic: 小西の目次にも topic 指定にも出ず、名取には出る");

// ───────────────────────── 9. ツール定義・手順書
const defs = Object.fromEntries(tools(S).map((x) => [x.name, x]));
ok(defs.genba_rule_get.annotations?.readOnlyHint === true && !defs.genba_rule_set.annotations?.readOnlyHint, "rule_get は readOnlyHint・rule_set は書き込み");
const sp = defs.genba_rule_set.inputSchema;
ok(sp.required.join() === "topic,body" && sp.properties.scope.enum.join() === "共通,個人" && "summary" in sp.properties, "rule_set の引数: topic / body / scope (共通・個人) / summary");
ok(/「基本」の本文 \+ 全 topic の目次/.test(defs.genba_rule_get.description) && /個人を優先/.test(defs.genba_rule_get.description) && /他の人の個人ルールは/.test(defs.genba_rule_get.description) && /個人/.test(defs.genba_rule_set.description) && /消えない/.test(defs.genba_rule_set.description), "ツール説明: 目次だけ・個人を優先・他人のは返さない・版は消えない");
ok(/scope=個人/.test(g.instructions) && /基本」と運用ルールの目次/.test(g.instructions) && /topic を指定して本文を読む/.test(g.instructions), "手順書: 最初に 基本 + 目次を読み、必要な topic は指定して読む。個人ルールは scope=個人");

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
