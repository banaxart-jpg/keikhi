// 判断ログ (genba_judgment_*) のテスト。本物の Postgres (pglite) の上で、genba の MCP ツールをそのまま呼ぶ
//
// 実行 (サーバーの package.json は変えない。pglite は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/genba-lib/judgment.test.mjs
import { pathToFileURL } from "node:url";
import { createGenba } from "./index.js";
import { similarity } from "./judgment.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 600) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

const db = new PGlite();
// 本番の sites は infra/schema.sql + index.js の ALTER (address / key_box / postal / done_at) でできる
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
const pool = { query: (s, p) => db.query(s, p) };
const mk = () => createGenba({ getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); } });
let g = mk(), cache = {};
const tools = (by) => (cache[by] ||= g.tools(by));
const call = (by, name, args = {}) => { const t = tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西", N = "名取";
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

// 登録して答える (results の順に 1 件ずつ)。返り値は id の配列
let seq = 0;
async function seed(category, results, { by = S, extra = {} } = {}) {
  const ids = [];
  for (const result of results) {
    seq++;
    const r = await call(N, "genba_judgment_add", { category, situation: `${category} 案件${seq} 搬入日の変更について業者から連絡`, ai_prediction: "了承の返事を送る", ai_confidence: 0.9, ...extra });
    ids.push(r.id);
    if (result) await call(S, "genba_judgment_resolve", { id: r.id, decision: result === "一致" ? "了承の返事を送った" : "電話で話した", result });
  }
  return ids;
}
const stat = async (by, category, args = {}) => (await call(by, "genba_judgment_stats", { category, ...args })).categories.find((c) => c.category === category);

// ───────────────────────── 1. マイグレーション・ツールの登録
await call(S, "genba_rule_get");                    // ensureSchema (初回)
await mk().ensureSchema();                          // 2 回目 (別インスタンス・同じ DB): 何度走らせても落ちない
const reg = await db.query(`SELECT to_regclass('judgment_log') AS a, to_regclass('judgment_policy') AS b`);
ok(reg.rows[0].a && reg.rows[0].b, "judgment_log / judgment_policy ができる (2 回走らせても落ちない)", reg.rows[0]);
const names = tools(S).map((t) => t.name);
const J = ["genba_judgment_add", "genba_judgment_resolve", "genba_judgment_similar", "genba_judgment_stats", "genba_judgment_policy_get", "genba_judgment_policy_set"];
ok(J.every((n) => names.includes(n)) && names.includes("genba_log_add") && names.includes("genba_rule_get") && names.includes("genba_audit"), "6 ツールが載り、既存のツールも残っている", names.filter((n) => /judgment/.test(n)));
const ro = Object.fromEntries(tools(S).map((t) => [t.name, !!t.annotations?.readOnlyHint]));
ok(ro.genba_judgment_similar && ro.genba_judgment_stats && ro.genba_judgment_policy_get && !ro.genba_judgment_add && !ro.genba_judgment_resolve && !ro.genba_judgment_policy_set, "読むだけの 3 つだけ readOnlyHint", ro);
ok(/判断ログ/.test(g.instructions) && /genba_judgment_add/.test(g.instructions), "手順書に判断ログの節が入る");
const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='judgment_log'`)).rows.map((r) => r.column_name);
ok(["id", "created_at", "site_id", "category", "situation", "source_ref", "ai_prediction", "ai_confidence", "basis_ids", "decision", "result", "reason", "related_log_id", "auto_sent", "is_private", "by"].every((c) => cols.includes(c)), "指定の列がそろっている", cols);

// ───────────────────────── 2. genba_rule_get のモード一覧 (既存の返り値は変わらない)
let rg = await call(S, "genba_rule_get");
ok(Array.isArray(rg.index) && "basic" in rg && "general_notes" in rg && Array.isArray(rg.judgment_modes), "rule_get (topic 省略): 基本 + 目次。general_notes はそのまま、judgment_modes が付く (運用ルールの目次化は rules.test.mjs)", Object.keys(rg));
ok(rg.judgment_modes.length === 8 && rg.judgment_modes.every((m) => m.mode === "確認あり") && rg.judgment_modes[0].category === "日程の返事", "標準の 8 種類が全部 確認あり", rg.judgment_modes.map((m) => m.category + ":" + m.mode));
rg = await call(S, "genba_rule_get", { topic: "存在しない" });
ok(rg.body === null && !("judgment_modes" in rg), "topic 指定の返り値は今まで通り");

// ───────────────────────── 3. 登録 (add)
await throws(() => call(S, "genba_judgment_add", { category: "", situation: "x", ai_prediction: "y", ai_confidence: 0.5 }), /category/, "category が空ならエラー");
await throws(() => call(S, "genba_judgment_add", { category: "日程の返事", situation: "x", ai_prediction: "y", ai_confidence: 1.5 }), /0〜1/, "確信度が 1 を超えるとエラー");
await throws(() => call(S, "genba_judgment_add", { category: "日程の返事", situation: "x", ai_prediction: "y" }), /0〜1/, "確信度が無いとエラー");
await throws(() => call(S, "genba_judgment_add", { category: "日程の返事", situation: "x", ai_prediction: "y", ai_confidence: 0.5, basis_ids: ["a"] }), /basis_ids/, "basis_ids が数値でないとエラー");
await throws(() => call(S, "genba_judgment_add", { category: "日程の返事", situation: "x", ai_prediction: "y", ai_confidence: 0.5, site: "存在しない現場XYZ" }), /現場が見つからない/, "存在しない現場はエラー");
await throws(() => call(N, "genba_judgment_add", { category: "日程の返事", situation: "x", ai_prediction: "y", ai_confidence: 0.5, is_private: true }), /小西/, "名取は is_private で登録できない");
const first = await call(N, "genba_judgment_add", { category: "日程の返事", situation: "電気屋から、来週の火曜に配線の下見に行きたいと連絡が来た", ai_prediction: "火曜 10 時で OK と返す", ai_confidence: 0.8, source_ref: "LINE:room1:msg1" });
ok(Number.isInteger(first.id) && first.mode === "確認あり" && Array.isArray(first.similar) && first.similar.length === 0 && /まだ無い/.test(first.note), "登録: id・mode=確認あり・似た過去はまだ無い", first);
let row = (await db.query(`SELECT * FROM judgment_log WHERE id=$1`, [first.id])).rows[0];
ok(row.by === N && row.result === "未回答" && row.decision === null && row.auto_sent === false && row.is_private === false && Number(row.ai_confidence) === 0.8 && row.site_id === null, "by はトークンから (名取)・未回答・decision null・site null", row);
const dup = await call(S, "genba_judgment_add", { category: "日程の返事", situation: "別の文面", ai_prediction: "z", ai_confidence: 0.1, source_ref: "LINE:room1:msg1" });
ok(dup.duplicate === true && dup.id === first.id, "同じ source_ref は重複登録しない (既存の id を返す)", dup);
ok((await db.query(`SELECT count(*)::int AS n FROM judgment_log WHERE source_ref='LINE:room1:msg1'`)).rows[0].n === 1, "DB にも 1 行だけ");

// site / related_log_id / basis_ids
await db.query(`INSERT INTO sites (name) VALUES ('浅草ビル')`);
const lg = await call(S, "genba_log_add", { site: "浅草ビル", kind: "進捗", title: "判断ログのテスト用", body: "テスト", who: "小西" });
const logId = Number(lg.id ?? lg.log?.id ?? lg.added?.id ?? lg.ids?.[0]);
const wsite = await call(S, "genba_judgment_add", { category: "仕様・範囲", situation: "浅草ビルの巾木の高さを 60 から 75 に変えたいと言われた", ai_prediction: "追加費用の確認が先", ai_confidence: 0.6, site: "浅草ビル", related_log_id: logId, basis_ids: [first.id] });
row = (await db.query(`SELECT * FROM judgment_log WHERE id=$1`, [wsite.id])).rows[0];
ok(row.site_id != null && Number(row.related_log_id) === logId && Array.isArray(row.basis_ids) && Number(row.basis_ids[0]) === first.id, "site・related_log_id・basis_ids が入る", { logId, row });
await throws(() => call(S, "genba_judgment_add", { category: "仕様・範囲", situation: "x", ai_prediction: "y", ai_confidence: 0.5, related_log_id: 999999 }), /related_log_id/, "存在しない related_log_id はエラー");
ok((await call(S, "genba_judgment_add", { category: "雑務", situation: "現場に紐づかない雑務の件", ai_prediction: "やる", ai_confidence: 0.5, site: "会社" })).id > 0, "新しい種類 (雑務) も入れられる・site=会社 は紐づけなし");

// ───────────────────────── 4. 回答 (resolve)
await throws(() => call(N, "genba_judgment_resolve", { id: first.id, decision: "x", result: "一致" }), /小西/, "回答は小西のトークンだけ (名取は不可)");
await throws(() => call(S, "genba_judgment_resolve", { id: first.id, decision: "x", result: "たぶん" }), /result/, "result が選択肢外ならエラー");
await throws(() => call(S, "genba_judgment_resolve", { id: first.id, decision: "", result: "一致" }), /decision/, "decision が空ならエラー");
await throws(() => call(S, "genba_judgment_resolve", { id: 999999, decision: "x", result: "一致" }), /無い/, "存在しない id はエラー");
let rs = await call(S, "genba_judgment_resolve", { id: first.id, decision: "水曜の午前に変えて返した", result: "不一致", reason: "火曜は別現場で埋まっていた" });
ok(rs.judgment.result === "不一致" && rs.judgment.decision === "水曜の午前に変えて返した" && rs.judgment.reason === "火曜は別現場で埋まっていた" && !rs.demoted && rs.mode === "確認あり", "回答: decision / result / reason が入る (確認ありなので降格はなし)", rs);
row = (await db.query(`SELECT * FROM judgment_log WHERE id=$1`, [first.id])).rows[0];
ok(row.resolved_at && row.resolved_by === S, "回答の時刻と回答者が残る", row);
rs = await call(S, "genba_judgment_resolve", { id: first.id, decision: "水曜の午前に変えて返した", result: "部分一致" });
ok(rs.judgment.result === "部分一致", "もう一度呼べば上書きできる");

// ───────────────────────── 5. 似た過去の判断 (add の返り値 / similar)
ok(similarity("搬入日の変更", "搬入日を金曜に変更したい") > 0.12 && similarity("搬入日の変更", "支払いの催促") < 0.12, "あいまい検索: 近い文は高く、無関係は低い");
for (let i = 0; i < 7; i++) {
  const r = await call(N, "genba_judgment_add", { category: "業者への依頼", situation: `業者への依頼 ${i} 内装の搬入日を木曜から金曜へ変更してほしい`, ai_prediction: "了承", ai_confidence: 0.7 });
  await call(S, "genba_judgment_resolve", { id: r.id, decision: `金曜で了承 ${i}`, result: "一致" });
}
await seed("お礼・了解", ["一致"]);
const withSim = await call(N, "genba_judgment_add", { category: "業者への依頼", situation: "搬入日を金曜に変更したいと内装業者から連絡が来た", ai_prediction: "金曜で了承", ai_confidence: 0.8 });
ok(withSim.similar.length === 5 && withSim.similar.every((s) => s.category === "業者への依頼" && s.decision), "add: 同じ category の過去の判断を最大 5 件", withSim.similar.map((s) => s.id));
const simIds = withSim.similar.map((s) => s.id);
ok(simIds.every((id, i) => i === 0 || id < simIds[i - 1]), "add の similar は新しい順", simIds);
ok(!withSim.similar.some((s) => s.id === withSim.id), "いま登録した自分自身は入らない");
const openOnly = await call(N, "genba_judgment_add", { category: "業者への依頼", situation: "搬入日を金曜に変更したいと内装業者から連絡が来た (未回答の同文)", ai_prediction: "了承", ai_confidence: 0.8 });
ok(!openOnly.similar.some((s) => s.id === withSim.id), "答えの付いていない判断は材料に出ない");

// similar ツール: 新しい判断ほど上
const old = await call(N, "genba_judgment_add", { category: "金額・支払い", situation: "請求書の支払いを来月末に延ばしてほしいと言われた", ai_prediction: "断る", ai_confidence: 0.6 });
await call(S, "genba_judgment_resolve", { id: old.id, decision: "延ばしてよい", result: "不一致" });
await db.query(`UPDATE judgment_log SET created_at = now() - interval '200 days' WHERE id=$1`, [old.id]);
const neu = await call(N, "genba_judgment_add", { category: "金額・支払い", situation: "請求書の支払いを来月末に延ばしてほしいと言われた", ai_prediction: "延ばす", ai_confidence: 0.6 });
await call(S, "genba_judgment_resolve", { id: neu.id, decision: "延ばしてよい", result: "一致" });
let sm = await call(S, "genba_judgment_similar", { query: "請求書の支払い 延ばして", category: "金額・支払い" });
ok(sm.count === 2 && sm.judgments[0].id === neu.id && sm.judgments[1].id === old.id && sm.judgments[0].similarity >= 0.12, "similar: 同じ似ている度なら新しい判断が上", sm.judgments.map((j) => [j.id, j.similarity]));
sm = await call(S, "genba_judgment_similar", { query: "支払い", limit: 1 });
ok(sm.count === 1 && sm.judgments[0].id === neu.id, "similar: limit が効く", sm);
sm = await call(S, "genba_judgment_similar", { category: "業者への依頼", limit: 3 });
ok(sm.count === 3 && sm.judgments[0].id > sm.judgments[1].id, "similar: query 省略は category だけで新しい順", sm.judgments.map((j) => j.id));
sm = await call(S, "genba_judgment_similar", { site: "浅草ビル" });
ok(sm.count === 0, "similar: site で絞れる (浅草ビルの答え済みはまだ無い)", sm);
await call(S, "genba_judgment_resolve", { id: wsite.id, decision: "追加費用を確認してから返した", result: "一致" });
sm = await call(S, "genba_judgment_similar", { site: "浅草ビル" });
ok(sm.count === 1 && sm.judgments[0].id === wsite.id && sm.judgments[0].site === "浅草ビル", "similar: 浅草ビルの判断が出て site 名が付く", sm);
sm = await call(S, "genba_judgment_similar", { query: "まったく関係のない配管の話題ゼロ" });
ok(sm.count === 0, "similar: 似ていなければ出ない", sm);

// ───────────────────────── 6. 統計と昇格候補
await seed("お礼・了解", Array(19).fill("一致"));              // 先の 1 件と合わせて 20 連続
let st = await stat(S, "お礼・了解");
ok(st.total === 20 && st.matched === 20 && st.match_rate === 1 && st.streak === 20 && st.last_mismatch_on === null && st.promotion_candidate === true && /昇格候補/.test(st.promotion_note), "20 連続一致・一致率 100% → 昇格候補", st);
const all = await call(S, "genba_judgment_stats", {});
ok(all.promotion_candidates?.includes("お礼・了解") && all.categories.some((c) => c.category === "日程の返事"), "stats 全体: promotion_candidates に載る / 他の種類も並ぶ", all.promotion_candidates);
ok((await call(S, "genba_judgment_policy_get")).policies.find((p) => p.category === "お礼・了解").mode === "確認あり", "昇格候補が出ても勝手には切り替わらない (確認あり のまま)");

await seed("書類", Array(19).fill("一致"));
st = await stat(S, "書類");
ok(st.total === 19 && st.streak === 19 && !st.promotion_candidate && /あと 1 件/.test(st.promotion_note), "19 連続は候補にならない (あと 1 件)", st);

await seed("金額・支払い", ["一致", "一致", "不一致", "一致"]);   // (neu 一致 / old 不一致 / wsite の外) + 上の 2 件
st = await stat(S, "金額・支払い");
ok(st.mismatched === 2 && st.streak === 1 && st.last_mismatch_on === today && !st.promotion_candidate, "不一致が混ざると連続は切れる・最後の不一致の日が出る", st);

await seed("社内への伝言", ["不一致", ...Array(20).fill("一致")]);   // 21 件: 一致率 20/21 = 95.2%
st = await stat(S, "社内への伝言");
ok(st.total === 21 && st.streak === 20 && st.match_rate === 0.952 && st.promotion_candidate === true, "一致率 95.2% ・ 連続 20 → 候補 (境界: 95% 以上)", st);
await call(S, "genba_judgment_policy_set", { category: "社内への伝言", mode: "確認あり", threshold: 0.99 });
st = await stat(S, "社内への伝言");
ok(!st.promotion_candidate && /一致率 95% → 99% 以上/.test(st.promotion_note), "threshold を 0.99 にすると候補から外れる (種類ごとの目安)", st);

await seed("その他", ["部分一致", ...Array(20).fill("一致")]);
st = await stat(S, "その他");
ok(st.partial === 1 && st.matched === 20 && st.streak === 20 && st.match_rate === 0.952, "部分一致は一致率に入らない (連続は一致だけ)", st);

// (新しい種類で: 仕様・範囲 には今日の一致が 1 件あるので、40 日前だけの 20 連続は別の種類で確かめる)
const ids = await seed("図面の確認", Array(20).fill("一致"));
await db.query(`UPDATE judgment_log SET resolved_at = now() - interval '40 days' WHERE id = ANY($1::bigint[])`, [ids]);
st = await stat(S, "図面の確認");
ok(st.streak === 20 && st.total === 0 && st.match_rate === null && !st.promotion_candidate && /直近 30 日の答えが無い/.test(st.promotion_note), "40 日前の 20 連続は 直近 30 日の条件を満たさない", st);
st = (await call(S, "genba_judgment_stats", { category: "図面の確認", days: 60 })).categories.find((c) => c.category === "図面の確認");
ok(st.total >= 20 && st.promotion_candidate === true, "days=60 に広げれば数える", st);

const open = (await call(S, "genba_judgment_stats", {})).categories.find((c) => c.category === "日程の返事");
ok(open.unanswered === 0 || open.unanswered >= 0, "未回答の数も出る (日程の返事)", open);

// ───────────────────────── 7. モード切替 (policy_set) と自動降格
await throws(() => call(N, "genba_judgment_policy_set", { category: "お礼・了解", mode: "事後報告" }), /小西/, "policy_set は小西のトークンだけ");
await throws(() => call(S, "genba_judgment_policy_set", { category: "お礼・了解", mode: "勝手に送る" }), /mode/, "mode が選択肢外ならエラー");
await throws(() => call(S, "genba_judgment_policy_set", { category: "お礼・了解", mode: "事後報告", threshold: 2 }), /0〜1/, "threshold が範囲外ならエラー");
await throws(() => call(S, "genba_judgment_policy_set", { category: "", mode: "事後報告" }), /category/, "category が空ならエラー");
const ps = await call(S, "genba_judgment_policy_set", { category: "お礼・了解", mode: "事後報告" });
ok(ps.mode === "事後報告" && ps.threshold === 0.95, "お礼・了解 を 事後報告 に (小西の OK 後)", ps);
rg = await call(N, "genba_rule_get");
ok(rg.judgment_modes.find((m) => m.category === "お礼・了解").mode === "事後報告" && rg.judgment_modes.find((m) => m.category === "書類").mode === "確認あり", "rule_get のモード一覧に反映 (名取のトークンでも見える)", rg.judgment_modes.map((m) => m.category + ":" + m.mode));
const pg = await call(N, "genba_judgment_policy_get");
ok(pg.policies.find((p) => p.category === "お礼・了解").mode === "事後報告" && pg.policies.find((p) => p.category === "お礼・了解").changed_by === S, "policy_get: モードと変えた人", pg.policies[0]);
const auto = await call(N, "genba_judgment_add", { category: "お礼・了解", situation: "資材が届いたとお礼の連絡が来た", ai_prediction: "了解の返事", ai_confidence: 0.97, auto_sent: true });
ok(auto.mode === "事後報告" && /確認なしで送ってよい/.test(auto.how), "事後報告の種類は add の返り値 mode=事後報告", auto);
row = (await db.query(`SELECT auto_sent FROM judgment_log WHERE id=$1`, [auto.id])).rows[0];
ok(row.auto_sent === true, "auto_sent が残る");
rs = await call(S, "genba_judgment_resolve", { id: auto.id, decision: "了解の返事でよかった", result: "一致" });
ok(!rs.demoted && rs.mode === "事後報告", "事後報告中でも 一致 なら そのまま", rs);
const auto2 = await call(N, "genba_judgment_add", { category: "お礼・了解", situation: "追加の依頼を含むお礼が来た", ai_prediction: "了解の返事", ai_confidence: 0.9, auto_sent: true });
rs = await call(S, "genba_judgment_resolve", { id: auto2.id, decision: "依頼の部分は別に返すべきだった", result: "不一致", reason: "お礼のつもりが依頼だった" });
ok(rs.demoted?.category === "お礼・了解" && rs.demoted.from === "事後報告" && rs.demoted.to === "確認あり" && rs.mode === "確認あり" && /確認あり に戻した/.test(rs.note), "事後報告で 不一致 が 1 件 → 自動で 確認あり に戻る", rs);
const after = (await call(S, "genba_judgment_policy_get")).policies.find((p) => p.category === "お礼・了解");
ok(after.mode === "確認あり" && /自動/.test(after.changed_by) && new RegExp(String(auto2.id)).test(after.note), "policy_get に反映・降格の理由 (どの判断か) が残る", after);
ok((await call(S, "genba_rule_get")).judgment_modes.find((m) => m.category === "お礼・了解").mode === "確認あり", "rule_get にも反映");
st = await stat(S, "お礼・了解");
ok(st.mode === "確認あり" && st.streak === 0 && st.last_mismatch_on === today && !st.promotion_candidate, "stats: 連続は 0 に戻り、最後の不一致の日が出る", st);
const x2 = await call(N, "genba_judgment_add", { category: "お礼・了解", situation: "また別のお礼", ai_prediction: "了解", ai_confidence: 0.9 });
rs = await call(S, "genba_judgment_resolve", { id: x2.id, decision: "違う", result: "不一致" });
ok(!rs.demoted && rs.mode === "確認あり", "確認あり中の 不一致 は降格の対象外 (すでに確認あり)", rs);
// 新しい種類の policy_set
const np = await call(S, "genba_judgment_policy_set", { category: "請求の催促", mode: "確認あり", threshold: 0.9 });
ok(np.threshold === 0.9 && (await call(S, "genba_judgment_policy_get")).policies.some((p) => p.category === "請求の催促" && p.threshold === 0.9), "新しい種類にも policy を持てる (標準 8 種類の後ろに並ぶ)");

// ───────────────────────── 8. 24 時間以上 未回答 → genba_audit
const fresh = await call(N, "genba_judgment_add", { category: "日程の返事", situation: "さっき来た日程の連絡 (まだ新しい)", ai_prediction: "OK", ai_confidence: 0.7 });
const stale = await call(N, "genba_judgment_add", { category: "日程の返事", situation: "昨日来た日程の連絡 (24 時間以上前)", ai_prediction: "OK", ai_confidence: 0.7 });
await db.query(`UPDATE judgment_log SET created_at = now() - interval '30 hours' WHERE id=$1`, [stale.id]);
let au = await call(S, "genba_audit", {});
ok(Array.isArray(au.judgment_unanswered) && au.judgment_unanswered.some((j) => j.id === stale.id && j.hours >= 30) && !au.judgment_unanswered.some((j) => j.id === fresh.id), "audit: 24 時間以上の未回答だけ出る (新しいのは出ない)", au.judgment_unanswered);
ok(/判断が未回答 \d+/.test(au.summary) && au.how_to_fix.some((h) => /判断が未回答/.test(h)), "audit の summary と how_to_fix に出る", au.summary);
await call(S, "genba_judgment_resolve", { id: stale.id, decision: "OK を返した", result: "一致" });
au = await call(S, "genba_audit", {});
ok(!au.judgment_unanswered?.some((j) => j.id === stale.id), "回答すれば audit から消える");

// ───────────────────────── 9. 小西だけの判断 (is_private)
const pv = await call(S, "genba_judgment_add", { category: "お礼・了解", situation: "友人からの私的なお礼とお誘い 秘密の件", ai_prediction: "ありがとうと返す", ai_confidence: 0.6, is_private: true, source_ref: "LINE:priv:1" });
await call(S, "genba_judgment_resolve", { id: pv.id, decision: "ありがとうと返した", result: "一致" });
const pvOpen = await call(S, "genba_judgment_add", { category: "日程の返事", situation: "私的な飲み会の日程の連絡 秘密", ai_prediction: "行く", ai_confidence: 0.5, is_private: true });
await db.query(`UPDATE judgment_log SET created_at = now() - interval '48 hours' WHERE id=$1`, [pvOpen.id]);
const mineSim = await call(S, "genba_judgment_similar", { query: "友人からの私的なお礼" });
ok(mineSim.judgments.some((j) => j.id === pv.id && j.private === true), "小西には private の判断が見える (private: true の印つき)", mineSim);
const hisSim = await call(N, "genba_judgment_similar", { query: "友人からの私的なお礼" });
ok(!hisSim.judgments.some((j) => j.id === pv.id), "名取の similar には出ない", hisSim);
ok(!(await call(N, "genba_judgment_similar", { category: "お礼・了解", limit: 30 })).judgments.some((j) => j.id === pv.id), "名取の category 一覧にも出ない");
const hisAdd = await call(N, "genba_judgment_add", { category: "お礼・了解", situation: "友人からの私的なお礼とお誘い 秘密の件についての連絡", ai_prediction: "返す", ai_confidence: 0.5 });
ok(!hisAdd.similar.some((j) => j.id === pv.id), "名取が add したときの similar にも出ない", hisAdd.similar.map((s) => s.id));
const meAdd = await call(S, "genba_judgment_add", { category: "お礼・了解", situation: "友人からの私的なお礼とお誘い 秘密の件についての連絡 小西側", ai_prediction: "返す", ai_confidence: 0.5 });
ok(meAdd.similar.some((j) => j.id === pv.id), "小西が add したときの similar には出る", meAdd.similar.map((s) => s.id));
const stMine = await stat(S, "お礼・了解"), stHis = await stat(N, "お礼・了解");
ok(stMine.total === stHis.total + 1, "stats: 小西は private を数え、名取は数えない", { mine: stMine.total, his: stHis.total });
const hisAll = await call(N, "genba_judgment_stats", {});
ok(hisAll.categories.every((c) => c.unanswered >= 0) && !JSON.stringify(hisAll).includes("秘密"), "名取の stats に private の中身は出ない");
const auHis = await call(N, "genba_audit", {}), auMine = await call(S, "genba_audit", {});
ok(!auHis.judgment_unanswered?.some((j) => j.id === pvOpen.id) && auMine.judgment_unanswered?.some((j) => j.id === pvOpen.id), "audit: private の未回答は名取に出ず、小西には出る", { his: auHis.judgment_unanswered, mine: auMine.judgment_unanswered?.map((j) => j.id) });
const hisDup = await call(N, "genba_judgment_add", { category: "お礼・了解", situation: "x", ai_prediction: "y", ai_confidence: 0.5, source_ref: "LINE:priv:1" });
ok(hisDup.duplicate === true && hisDup.id === undefined && hisDup.judgment === undefined, "名取が private と同じ source_ref を入れても、中身も id も返さない", hisDup);

// ───────────────────────── 10. 既存の動きが変わっていない
const lg2 = await call(S, "genba_log_add", { site: "浅草ビル", kind: "進捗", title: "判断ログ後も記録できる", body: "テスト", who: "小西" });
ok(lg2 && !lg2.error, "既存: genba_log_add は今まで通り動く", lg2);
const au2 = await call(S, "genba_audit", {});
ok(au2.summary && "open_tasks" in au2 && "monitor" in au2, "既存: audit の元の項目は残っている", Object.keys(au2));

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
