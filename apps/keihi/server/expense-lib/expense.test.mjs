// 経費 (keihi_* ツールと、画面 REST と共通の保存処理) のテスト。
// 本物の Postgres (pglite) の上で、expense-lib のツールをそのまま呼ぶ。GCS・スプレッドシートは代役 (中身を記録する)。
//
// 実行 (サーバーの package.json は変えない。pglite と sharp は一時的に別の場所へ入れる):
//   mkdir -p /tmp/pg && (cd /tmp/pg && npm init -y && npm i @electric-sql/pglite sharp)
//   ln -s /tmp/pg/node_modules apps/keihi/server/node_modules   # sharp を探させる (git 管理外)
//   PGLITE_PATH=/tmp/pg/node_modules/@electric-sql/pglite/dist/index.js node apps/keihi/server/expense-lib/expense.test.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createGenba } from "../genba-lib/index.js";
import { createExpense, CATEGORIES, WORK_TYPES, PAYMENTS, BUYERS, EXPENSE_INSTRUCTIONS } from "./index.js";
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : "@electric-sql/pglite");

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 900) : ""); } };
const throws = async (f, re, m) => { try { await f(); fail++; console.log("FAIL", m, "(no throw)"); } catch (e) { if (re.test(e.message)) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, e.message); } } };

// ───────── 準備: DB (infra/schema.sql の records と同じ) ・現場・代役
const db = new PGlite();
await db.exec(`CREATE TABLE sites (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), address TEXT, key_box TEXT, postal TEXT, done_at TIMESTAMPTZ)`);
await db.exec(`CREATE TABLE records (
  id BIGSERIAL PRIMARY KEY, date DATE NOT NULL, store TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '', work_type TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '', buyer TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', image_url TEXT, drive_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
for (const n of ["入谷", "銀座博品館", "共通", "会社", "勝どき", "勝どきタワマン"]) await db.query(`INSERT INTO sites (name) VALUES ($1)`, [n]);
await db.query(`UPDATE sites SET done_at = now() WHERE name='勝どきタワマン'`);
const pool = { query: (s, p) => db.query(s, p) };
const rows = async (sql, p) => (await db.query(sql, p)).rows;

const objects = new Map();    // "bucket/key" → { buf, contentType }
const storage = {
  bucket: (b) => ({
    file: (k) => ({
      save: async (buf, o) => { objects.set(`${b}/${k}`, { buf, contentType: o?.contentType }); },
      exists: async () => [objects.has(`${b}/${k}`)],
      download: async () => { const x = objects.get(`${b}/${k}`); if (!x) throw new Error("no such object"); return [x.buf]; },
      getSignedUrl: async (o) => [`https://signed.example/${b}/${k}?exp=${o.expires}`],
    }),
  }),
};
const sheetCalls = [], sheetOpts = [], syncCalls = [], dedupeCalls = [];
let sheetFail = false;
const appendRecordToSheet = async (r, o) => {
  sheetCalls.push(r); sheetOpts.push(o);
  const tab = String(r.date || "").slice(0, 7) || "unknown";
  if (sheetFail) return { tab, monthly: { ok: false, error: "boom", tab }, tx: { ok: true } };
  return { tab, monthly: { ok: true, tab }, tx: { ok: true } };
};
const dedupeSheets = async (o) => { dedupeCalls.push(o); return { applied: o.apply === true, extra_rows: 3, identical_extra_rows: 1, needs_review: { monthly_groups: 1, tx_groups: 0, cross_tab: 0 }, removed: { monthly: 1, tx: 0, skipped_changed: 0, capped: [], archived: 1 }, monthly: [{ tab: "2026-11", id: 5, rows: [4, 5, 6], count: 3, identical: false }], tx: [], cross_tab: [], checked: { tabs: 1, rows: 10 } }; };
const syncSheets = async (rs, o) => { syncCalls.push({ ids: rs.map((r) => Number(r.id)), ...o }); return rs.map((r) => ({ id: Number(r.id), tab: r.date.slice(0, 7), monthly: o.dryRun ? "missing" : "appended", tx: "exists" })); };

const BUCKET = "test-receipts", SECRET = "test-secret", PUBLIC = "https://api.example";
let clock = "2026-11-24";
let expense = null;
const genba = createGenba({
  getPool: () => pool, createMcpHandler: () => () => {}, getDriveApi: async () => { throw new Error("no drive"); }, today: () => clock,
  extra: { tools: (by) => expense.tools(by), instructions: EXPENSE_INSTRUCTIONS },
});
expense = createExpense({
  getPool: () => pool, getStorage: () => storage, bucket: BUCKET, publicUrl: PUBLIC, secret: SECRET, appUrl: "https://keihi-496002.web.app",
  findSites: (p, q, l) => genba.findSites(p, q, l), appendRecordToSheet, syncSheets, dedupeSheets, today: () => clock,
});
await genba.ensureSchema();
const call = (by, name, args = {}) => { const t = expense.tools(by).find((x) => x.name === name); if (!t) throw new Error("tool なし: " + name); return t.handler(args); };
const S = "小西", N = "名取";

const jpegTall = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#c8c8c8" } }).jpeg({ quality: 90 }).toBuffer();
const jpegTall2 = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: "#aab4c8" } }).jpeg({ quality: 90 }).toBuffer();
const pngAlpha = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
const b64 = (b) => b.toString("base64");
const dim = async (b) => { const m = await sharp(b).metadata(); return { w: m.width, h: m.height, format: m.format }; };

// ───────── 1. 選択肢は画面 (apps/keihi/index.html) と完全に同じ
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"), "utf8");
const opts = (id) => [...(html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1]).matchAll(/<option>([^<]*)<\/option>/g)].map((m) => m[1]);
ok(JSON.stringify(opts("fCat")) === JSON.stringify(CATEGORIES), "費目の選択肢は画面と同じ (順番も)", { ui: opts("fCat"), lib: CATEGORIES });
ok(JSON.stringify(opts("fWork")) === JSON.stringify(WORK_TYPES), "工種の選択肢は画面と同じ", opts("fWork"));
ok(JSON.stringify([...html.matchAll(/data-pay="([^"]+)"/g)].map((m) => m[1])) === JSON.stringify(PAYMENTS), "支払方法の選択肢は画面と同じ");
ok(JSON.stringify([...html.matchAll(/data-buyer="([^"]+)"/g)].map((m) => m[1])) === JSON.stringify(BUYERS), "購入者の選択肢は画面と同じ");
const tl = expense.tools(S), def = Object.fromEntries(tl.map((t) => [t.name, t]));
const addProps = def.keihi_receipt_add.inputSchema.properties.receipts.items.properties;
ok(JSON.stringify(addProps.category.enum) === JSON.stringify(CATEGORIES) && JSON.stringify(addProps.work_type.enum) === JSON.stringify(WORK_TYPES) && JSON.stringify(addProps.payment.enum) === JSON.stringify(PAYMENTS), "ツールの enum も画面と同じ");

// ───────── 2. 1 枚を base64 の写真つきで登録 → DB・写真 (GCS)・シート・返り値
let r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-01", site: "入谷", store: "まいばすけっと", total: 346, category: "その他", work_type: "その他", payment: "現金", memo: "お茶代", photo_base64: b64(jpegTall) }] });
const a0 = r.results[0];
ok(r.added === 1 && r.failed === 0 && a0.ok && a0.id > 0 && a0.view_url === `https://keihi-496002.web.app/keihi/?view=${a0.id}` && a0.sheet.tab === "2026-11" && a0.sheet.ok, "登録: id・アプリの閲覧 URL (view=ID)・反映された月のタブ (2026-11)", r);
const row0 = (await rows(`SELECT * FROM records WHERE id=$1`, [a0.id]))[0];
ok(row0.date.toISOString().slice(0, 10) === "2026-11-01" && row0.store === "まいばすけっと" && row0.total === 346 && row0.category === "その他" && row0.work_type === "その他" && row0.payment === "現金" && row0.buyer === "小西" && row0.site === "入谷" && row0.memo === "お茶代" && row0.drive_url === null, "DB: 画面と同じ列に入る (購入者はトークンの持ち主 = 小西)", row0);
ok(/^gs:\/\/test-receipts\/2026-11-24\/[0-9a-f-]{36}\.jpg$/.test(row0.image_url), "写真の置き場は /api/scan と同じ形 (gs://<bucket>/<今日>/<uuid>.jpg)", row0.image_url);
const stored0 = objects.get(row0.image_url.replace("gs://", ""));
const d0 = await dim(stored0.buf);
ok(stored0.contentType === "image/jpeg" && d0.format === "jpeg" && Math.max(d0.w, d0.h) === 1200 && d0.w === 900 && d0.h === 1200 && stored0.buf.length < jpegTall.length, "写真は長辺 1200px の JPEG に縮小されて置かれる (画面と同じ)", { d0, bytes: stored0.buf.length });
ok(sheetCalls.length === 1 && sheetCalls[0].id === a0.id && sheetCalls[0].site === "入谷" && sheetCalls[0].buyer === "小西" && sheetCalls[0].workType === "その他" && sheetCalls[0].driveUrl === null && sheetCalls[0].memo === "お茶代", "シート: 画面と同じ appendRecordToSheet に同じ形のレコードが渡る (driveUrl なし = 写真セルは view=ID)", sheetCalls[0]);

// ───────── 3. 動作確認の 3 件: 入谷のまいばすけっと (11/1 ¥346 現金・11/12 ¥191 カード・11/17 ¥440 現金、メモ お茶代、費目 その他) を 1 回で
await db.query(`DELETE FROM records`); objects.clear(); sheetCalls.length = 0;
const three = [["2026-11-01", 346, "現金"], ["2026-11-12", 191, "カード"], ["2026-11-17", 440, "現金"]];
r = await call(S, "keihi_receipt_add", { receipts: three.map(([date, total, payment], i) => ({ date, site: "入谷", store: "まいばすけっと", total, category: "その他", payment, memo: "お茶代", photo_base64: b64(i === 1 ? pngAlpha : i === 0 ? jpegTall : jpegTall2) })) });
ok(r.added === 3 && r.failed === 0 && r.duplicates === 0 && r.results.every((x) => x.ok && x.view_url && x.sheet.tab === "2026-11"), "3 枚を 1 回で登録 (全部 11 月のタブ)", r);
const recs = await rows(`SELECT id, date::text AS date, total, payment, category, work_type, memo, buyer, site, store, image_url FROM records ORDER BY date`);
ok(JSON.stringify(recs.map((x) => [x.date, x.total, x.payment])) === JSON.stringify(three) && recs.every((x) => x.store === "まいばすけっと" && x.site === "入谷" && x.category === "その他" && x.memo === "お茶代" && x.buyer === "小西" && x.image_url?.startsWith("gs://")), "DB に 3 件 (日付・金額・支払方法・メモ・費目・現場・写真)", recs);
ok(sheetCalls.length === 3 && objects.size === 3 && [...objects.values()].every((o) => o.contentType === "image/jpeg"), "シートへ 3 回・写真は 3 枚 (PNG の透過も JPEG にして置く)");
const pngStored = await dim(objects.get(recs[1].image_url.replace("gs://", "")).buf);
ok(pngStored.format === "jpeg" && pngStored.w === 800 && pngStored.h === 600, "PNG (透過) も JPEG で、小さい画像は拡大しない", pngStored);

// ───────── 4. 重複防止 (同じ日付・店舗・金額)
r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-12", site: "入谷", store: "まいばすけっと", total: 191, category: "その他", photo_base64: b64(jpegTall) }] });
ok(r.added === 0 && r.duplicates === 1 && r.results[0].duplicate === true && r.results[0].id === recs[1].id && r.results[0].existing.store === "まいばすけっと", "同じ日付・店舗・金額は入れずに duplicate: true と既存の id", r);
ok((await rows(`SELECT count(*)::int AS n FROM records`))[0].n === 3 && objects.size === 3 && sheetCalls.length === 3, "重複のときは、DB・写真・シートのどれにも足さない");
r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-12", site: "入谷", store: "　まいばすけっと ", total: 191, category: "その他" }] });
ok(r.duplicates === 1, "店名の空白の違いは同じ店 (表記ゆれ)");
r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-12", site: "入谷", store: "まいばすけっと", total: 191, category: "その他", payment: "カード" }], force: true });
ok(r.added === 1 && r.duplicates === 0, "force=true なら重複でも入れる", r);
r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-12", site: "入谷", store: "まいばすけっと", total: 192, category: "その他" }, { date: "2026-11-12", site: "入谷", store: "まいばすけっと", total: 192, category: "その他" }] });
ok(r.added === 1 && r.duplicates === 1, "同じ呼び出しの中の重複も 1 件だけ入る", r);
await db.query(`DELETE FROM records WHERE total IN (192) OR id = $1`, [r.results[0].id]);
await db.query(`DELETE FROM records WHERE id NOT IN (SELECT id FROM (SELECT id FROM records ORDER BY id LIMIT 3) x)`);

// ───────── 5. 購入者はトークンの持ち主
r = await call(N, "keihi_receipt_add", { receipts: [{ date: "2026-11-02", site: "入谷", store: "コメリ", total: 1000, category: "材料費" }] });
ok((await rows(`SELECT buyer FROM records WHERE id=$1`, [r.results[0].id]))[0].buyer === "名取", "名取のトークンなら購入者は名取");
r = await call("LINE監視", "keihi_receipt_add", { receipts: [{ date: "2026-11-02", site: "入谷", store: "コメリ", total: 1001, category: "材料費" }] });
ok(!r.results[0].ok && /購入者を決められない/.test(r.results[0].error), "人でないトークン (LINE監視) は buyer の指定が要る", r.results[0]);
r = await call("LINE監視", "keihi_receipt_add", { buyer: "名取", receipts: [{ date: "2026-11-02", site: "入谷", store: "コメリ", total: 1001, category: "材料費" }] });
ok(r.results[0].ok && (await rows(`SELECT buyer FROM records WHERE id=$1`, [r.results[0].id]))[0].buyer === "名取", "buyer を渡せば入る (代わりに登録)");
r = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-11-02", site: "入谷", store: "コメリ", total: 1002, category: "材料費", buyer: "名取" }] });
ok((await rows(`SELECT buyer FROM records WHERE id=$1`, [r.results[0].id]))[0].buyer === "名取", "小西のトークンでも buyer=名取 で名取の分を登録できる");

// ───────── 6. 現場の表記ゆれ (共通・会社も可)
const siteOf = async (q) => { const x = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-05", site: q, store: "現場テスト店", total: 5000 + Math.floor(Math.random() * 1e6), category: "その他" }] }); return x.results[0]; };
for (const [q, want] of [["入谷", "入谷"], [" 入谷 ", "入谷"], ["共通", "共通"], ["会社", "会社"], ["銀座", "銀座博品館"], ["勝どき", "勝どき"], ["タワマン", "勝どきタワマン"]]) {
  const x = await siteOf(q);
  ok(x.ok && x.record.site === want, `現場「${q}」→ ${want}`, x);
}
const bad = await siteOf("存在しない現場");
ok(!bad.ok && /現場が見つからない/.test(bad.error) && /keihi_sites/.test(bad.error), "現場が見つからないときはエラー (keihi_sites で見るよう案内)", bad);

// ───────── 7. 項目の言い換えを画面の選択肢に寄せる / 不正は件ごとにエラー (他は止まらない)
r = await call(S, "keihi_receipt_add", { receipts: [
  { date: "2026/10/6", site: "入谷", store: "寄せテスト 1", total: "¥1,234", category: "工具", work_type: "電気工事", payment: "PayPay" },
  { date: "2026年10月7日", site: "入谷", store: "寄せテスト 2", total: 2345, category: "交際費", payment: "クレジット" },
  { date: "2026-10-08", site: "入谷", store: "寄せテスト 3", total: 3456, category: "ガソリン", payment: "銀行振込" },
  { date: "2026-10-09", site: "入谷", store: "寄せテスト 4", total: 4567, category: "駐車場", payment: "cash" },
] });
ok(r.added === 4 && r.results[0].record.category === "工具・備品" && r.results[0].record.work_type === "電気" && r.results[0].record.payment === "電子マネー" && r.results[0].record.total === 1234 && r.results[0].record.date === "2026-10-06" &&
  r.results[1].record.category === "接待交際費" && r.results[1].record.payment === "カード" && r.results[1].record.date === "2026-10-07" && r.results[2].record.category === "ガソリン代" && r.results[2].record.payment === "振込" && r.results[3].record.category === "駐車場代" && r.results[3].record.payment === "現金", "言い換えは画面の選択肢に寄せる (工具→工具・備品 / 交際費→接待交際費 / PayPay→電子マネー …)", r.results.map((x) => x.record || x.error));
const mixed = await call(S, "keihi_receipt_add", { receipts: [
  { date: "2026-10-10", site: "入谷", store: "混在 1", total: 100, category: "材料費" },
  { date: "2026-02-30", site: "入谷", store: "混在 2", total: 100, category: "材料費" },
  { date: "2026-10-10", site: "入谷", store: "混在 3", total: 0, category: "材料費" },
  { date: "2026-10-10", site: "入谷", store: "", total: 100, category: "材料費" },
  { date: "2026-10-10", site: "入谷", store: "混在 5", total: 100, category: "なんでも" },
  { date: "2026-10-10", site: "入谷", store: "混在 6", total: 100 },
  { date: "2026-10-10", site: "入谷", store: "混在 7", total: 100, category: "材料費", payment: "ビットコイン" },
  { date: "10/10", site: "入谷", store: "混在 8", total: 100, category: "材料費" },
  { date: "2026-10-10", site: "入谷", store: "混在 9", total: 100.5, category: "材料費" },
  { date: "2026-10-11", site: "入谷", store: "混在 10", total: 100, category: "材料費", photo_base64: "bm90IGFuIGltYWdl" },
  { date: "2026-10-12", site: "入谷", store: "混在 11", total: 100, category: "材料費", photo_ref: "x.y" },
  { date: "2026-10-13", site: "入谷", store: "混在 12", total: 100, category: "材料費" },
] });
ok(mixed.added === 2 && mixed.failed === 10 && mixed.results[0].ok && mixed.results[11].ok, "不正な件はエラーにして、ほかの件は入る (1 件の失敗で止まらない)", mixed.results.map((x) => x.ok ? "ok" : x.error));
ok(/実在しない日付/.test(mixed.results[1].error) && /1 円以上/.test(mixed.results[2].error) && /store/.test(mixed.results[3].error) && /費目は/.test(mixed.results[4].error) && /category/.test(mixed.results[5].error) && /支払方法は/.test(mixed.results[6].error) && /YYYY-MM-DD/.test(mixed.results[7].error) && /整数/.test(mixed.results[8].error) && /画像として読めなかった/.test(mixed.results[9].error) && /photo_ref が無効/.test(mixed.results[10].error), "エラーの文言: 日付・金額・店舗・費目・支払方法・年なし日付・小数・壊れた画像・不正な photo_ref");
ok((await rows(`SELECT count(*)::int AS n FROM records WHERE store LIKE '混在%'`))[0].n === 2, "エラーの件は DB に入らない (写真だけ置かれることもない)");
await throws(() => call(S, "keihi_receipt_add", { receipts: [] }), /receipts/, "receipts が空ならエラー");
await throws(() => call(S, "keihi_receipt_add", { receipts: Array.from({ length: 31 }, () => ({})) }), /30 件まで/, "31 件以上は分けるよう案内");
const noPhoto = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-14", site: "入谷", store: "写真なし店", total: 777, category: "材料費" }] });
ok(noPhoto.results[0].ok && noPhoto.results[0].record.has_photo === false && noPhoto.results[0].warnings.some((w) => /写真/.test(w)) && noPhoto.results[0].warnings.some((w) => /work_type/.test(w)) && noPhoto.results[0].warnings.some((w) => /payment/.test(w)), "写真なしでも登録できる (警告つき)。工種・支払方法の省略は画面の既定 (その他 / 現金)", noPhoto.results[0]);
const pdf = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-15", site: "入谷", store: "PDF店", total: 778, category: "材料費", photo_base64: b64(Buffer.from("%PDF-1.4 test")) }] });
ok(!pdf.results[0].ok && /PDF/.test(pdf.results[0].error), "PDF は写真として付けられない");
sheetFail = true;
const sf = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-16", site: "入谷", store: "シート失敗店", total: 779, category: "材料費" }] });
sheetFail = false;
ok(sf.results[0].ok && sf.results[0].sheet.ok === false && /error: boom/.test(sf.results[0].sheet.monthly_tab) && sf.results[0].warnings.some((w) => /keihi_receipt_sheet_sync/.test(w)), "シートへの反映に失敗しても DB には入り、やり直しの案内が出る", sf.results[0]);

// ───────── 8. 写真の渡し方 ①: 署名付き URL に PUT → photo_ref
const up = await call(S, "keihi_receipt_upload_url", { count: 3 });
ok(up.uploads.length === 3 && up.uploads.every((u) => u.upload_url.startsWith(`${PUBLIC}/api/keihi/upload/`) && /^curl -sS -X PUT/.test(u.curl) && u.photo_ref && u.upload_url.endsWith(u.photo_ref)), "upload_url: 枚数ぶんの URL と curl と photo_ref", up);
const put = async (token, body) => { const res = { code: 200, json(x) { this.body = x; return this; }, status(c) { this.code = c; return this; } }; await expense.uploadRoute()({ params: { token }, body }, res); return res; };
let beforeAdd = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-20", site: "入谷", store: "PUT 店", total: 1111, category: "材料費", photo_ref: up.uploads[0].photo_ref }] });
ok(!beforeAdd.results[0].ok && /まだ置かれていない/.test(beforeAdd.results[0].error), "PUT する前の photo_ref は、まだ置かれていないエラー", beforeAdd.results[0]);
let pr = await put(up.uploads[0].photo_ref, jpegTall);
ok(pr.code === 200 && pr.body.ok && pr.body.bytes_stored < pr.body.bytes_in, "PUT: 縮小して置く", pr.body);
ok((await put("bad.token", jpegTall)).code === 403 && (await put(up.uploads[1].photo_ref, Buffer.alloc(0))).code === 400 && (await put(up.uploads[1].photo_ref, Buffer.from("not image"))).code === 400, "PUT: 不正なトークン = 403 / 空・画像でない = 400");
const putKey = JSON.parse(Buffer.from(up.uploads[0].photo_ref.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).k;
ok(/^2026-11-24\/[0-9a-f-]{36}\.jpg$/.test(putKey) && objects.has(`${BUCKET}/${putKey}`) && (await dim(objects.get(`${BUCKET}/${putKey}`).buf)).h === 1200, "置き場は /api/scan と同じ形・縮小済み", putKey);
const withRef = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-20", site: "入谷", store: "PUT 店", total: 1111, category: "材料費", photo_ref: up.uploads[0].photo_ref }] });
ok(withRef.results[0].ok && (await rows(`SELECT image_url FROM records WHERE id=$1`, [withRef.results[0].id]))[0].image_url === `gs://${BUCKET}/${putKey}`, "photo_ref で登録: PUT した写真が records.image_url になる", withRef.results[0]);
const reuse = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-21", site: "入谷", store: "PUT 店 2", total: 1112, category: "材料費", photo_ref: up.uploads[0].photo_ref }] });
ok(!reuse.results[0].ok && /登録済み/.test(reuse.results[0].error), "同じ写真を別の呼び出しで使うと、登録済みエラー (二重登録の防止)", reuse.results[0]);
await put(up.uploads[2].photo_ref, jpegTall);
const shared = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-22", site: "入谷", store: "1 枚に 2 枚 A", total: 1201, category: "材料費", photo_ref: up.uploads[2].photo_ref }, { date: "2026-10-22", site: "入谷", store: "1 枚に 2 枚 B", total: 1202, category: "材料費", photo_ref: up.uploads[2].photo_ref }] });
const sh = await rows(`SELECT image_url FROM records WHERE id = ANY($1::bigint[])`, [shared.results.map((x) => x.id)]);
ok(shared.added === 2 && sh[0].image_url === sh[1].image_url, "1 枚の写真に領収書が 2 枚: 同じ呼び出しなら同じ写真を各件に付けられる", shared);
const sameB64 = b64(jpegTall);
const before = objects.size;
const sh2 = await call(S, "keihi_receipt_add", { receipts: [{ date: "2026-10-23", site: "入谷", store: "b64 A", total: 1301, category: "材料費", photo_base64: sameB64 }, { date: "2026-10-23", site: "入谷", store: "b64 B", total: 1302, category: "材料費", photo_base64: sameB64 }] });
ok(sh2.added === 2 && objects.size === before + 1, "同じ base64 は 1 回だけ置いて、2 件で共有する");
const expired = (() => { const body = Buffer.from(JSON.stringify({ k: "x/y.jpg", b: "小西", e: Date.now() - 1000 })).toString("base64"); return `${body}.00`; })();
ok((await put(expired, jpegTall)).code === 403, "期限切れ・署名違いのトークンは 403");

// ───────── 9. 一覧・検索・集計・CSV (画面の「記録」と同じ数字)
await db.query(`DELETE FROM records`);
const seed = [
  ["2026-11-01", "入谷", "まいばすけっと", 346, "その他", "その他", "現金", "小西", "お茶代"],
  ["2026-11-12", "入谷", "まいばすけっと", 191, "その他", "その他", "カード", "小西", "お茶代"],
  ["2026-11-17", "入谷", "まいばすけっと", 440, "その他", "その他", "現金", "小西", "お茶代"],
  ["2026-11-05", "銀座博品館", "コメリ", 12800, "材料費", "木工", "カード", "名取", "合板, \"A\" 材"],
  ["2026-10-30", "銀座博品館", "タイムズ", 1200, "駐車場代", "その他", "電子マネー", "名取", ""],
  ["2026-10-28", "共通", "ENEOS", 6000, "ガソリン代", "その他", "カード", "小西", ""],
];
for (const s of seed) await db.query(`INSERT INTO records (date, site, store, total, category, work_type, payment, buyer, memo, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[3] === 346 ? "gs://test-receipts/x/p.jpg" : null]);
let l = await call(S, "keihi_receipt_list", {});
ok(l.count === 6 && l.total === 346 + 191 + 440 + 12800 + 1200 + 6000 && l.records[0].date === "2026-11-17" && l.records[5].date === "2026-10-28", "list: 全件・新しい順 (購入日 → ID の降順)", l);
l = await call(S, "keihi_receipt_list", { site: "入谷", month: "2026-11" });
ok(l.count === 3 && l.total === 977 && l.label.includes("現場=入谷") && l.records.every((x) => x.site === "入谷" && x.view_url), "list: 現場 + 月の合計と件数 (画面の「入谷 / 2026年11月 合計」と同じ)", l);
l = await call(S, "keihi_receipt_list", { site: "銀座" }); ok(l.count === 2, "list: 現場の表記ゆれ (銀座 → 銀座博品館)");
l = await call(S, "keihi_receipt_list", { category: "駐車場", payment: "Suica" }); ok(l.count === 1 && l.records[0].store === "タイムズ", "list: 費目・支払方法の言い換え");
l = await call(S, "keihi_receipt_list", { q: "コメリ" }); ok(l.count === 1, "list: 店舗名で検索");
l = await call(S, "keihi_receipt_list", { q: "お茶" }); ok(l.count === 3, "list: メモで検索");
l = await call(S, "keihi_receipt_list", { q: "%" }); ok(l.count === 0, "list: % や _ は文字として検索 (全件ヒットしない)");
l = await call(S, "keihi_receipt_list", { has_photo: true }); ok(l.count === 1 && l.records[0].has_photo === true, "list: 写真ありだけ");
l = await call(S, "keihi_receipt_list", { from: "2026-11-01", to: "2026-11-12", min_total: 200 }); ok(l.count === 2 && l.total === 346 + 12800, "list: 期間 + 金額の下限", l);
l = await call(S, "keihi_receipt_list", { limit: 2, offset: 1, order: "total_desc" }); ok(l.returned === 2 && l.count === 6 && l.truncated === true && l.records[0].total === 6000, "list: limit / offset / 並び順 / truncated", l);
await throws(() => call(S, "keihi_receipt_list", { month: "11月" }), /YYYY-MM/, "list: 月の形が違えばエラー");
const g = await call(S, "keihi_receipt_get", { id: l.records[0].id }); ok(g.record.store === "ENEOS", "get: id から 1 件");
await throws(() => call(S, "keihi_receipt_get", { id: 999999 }), /見つからない/, "get: 無い id はエラー");
let sm = await call(S, "keihi_receipt_summary", { group_by: ["site"] });
ok(sm.count === 6 && sm.groups[0].site === "銀座博品館" && sm.groups[0].total === 14000 && sm.groups.find((x) => x.site === "入谷").total === 977, "summary: 現場別 (合計の多い順)", sm);
sm = await call(S, "keihi_receipt_summary", { group_by: ["month"] });
ok(sm.groups[0].month === "2026-11" && sm.groups[0].total === 346 + 191 + 440 + 12800 && sm.groups[1].month === "2026-10", "summary: 月別 (新しい月から)", sm);
sm = await call(S, "keihi_receipt_summary", { site: "入谷", group_by: ["category", "payment"] });
ok(sm.groups.length === 2 && sm.total === 977 && sm.groups.find((x) => x.payment === "カード")?.total === 191, "summary: 絞り込み + 2 つの軸", sm);
sm = await call(S, "keihi_receipt_summary", { month: "2026-11" }); ok(sm.count === 4 && sm.groups.length === 0, "summary: group_by なしなら合計と件数だけ");
await throws(() => call(S, "keihi_receipt_summary", { group_by: ["color"] }), /group_by/, "summary: 不正な軸はエラー");
const csv = await call(S, "keihi_receipt_export_csv", { site: "銀座博品館" });
ok(csv.csv.startsWith("﻿購入日,現場名,店舗名,金額,費目,工種,支払方法,購入者,メモ\n") && csv.rows === 2 && csv.csv.includes(`2026-11-05,銀座博品館,コメリ,12800,材料費,木工,カード,名取,"合板, ""A"" 材"`) && /^経費_2026-11-24\.csv$/.test(csv.filename), "CSV: 画面と同じ列・BOM・カンマと引用符のエスケープ", csv.csv);
const csvAll = await call(S, "keihi_receipt_export_csv", {}); ok(csvAll.rows === 6, "CSV: 絞り込みなしは全件");

// ───────── 10. 写真を見る / 修正 / 削除
const pid = (await rows(`SELECT id FROM records WHERE image_url IS NOT NULL`))[0].id;
objects.set(`test-receipts/x/p.jpg`, { buf: await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).jpeg().toBuffer(), contentType: "image/jpeg" });
const ph = await call(S, "keihi_receipt_photo", { id: pid });
const phJson = JSON.parse(ph.content[0].text);
ok(ph.content.length === 2 && phJson.url.startsWith("https://signed.example/test-receipts/x/p.jpg?exp=") && phJson.expires_in_min === 10 && ph.content[1].type === "image" && ph.content[1].mimeType === "image/jpeg" && ph.content[1].data.length > 100, "photo: 10 分の閲覧 URL と、画像そのもの (AI が読める)", { url: phJson.url, content: ph.content.map((c) => c.type) });
const phUrlOnly = await call(S, "keihi_receipt_photo", { id: pid, include_image: false }); ok(phUrlOnly.content.length === 1, "photo: include_image=false なら URL だけ");
const noPid = (await rows(`SELECT id FROM records WHERE image_url IS NULL`))[0].id;
await throws(() => call(S, "keihi_receipt_photo", { id: noPid }), /写真が無い/, "photo: 写真が無い記録はエラー");

sheetCalls.length = 0;
const target = (await rows(`SELECT id FROM records WHERE store='コメリ'`))[0].id;
let u = await call(S, "keihi_receipt_update", { id: target, total: 13000, memo: "合板 + 角材", category: "工具", site: "入谷" });
const after = (await rows(`SELECT * FROM records WHERE id=$1`, [target]))[0];
ok(u.ok && after.total === 13000 && after.memo === "合板 + 角材" && after.category === "工具・備品" && after.site === "入谷" && after.store === "コメリ" && after.payment === "カード" && after.buyer === "名取" && after.work_type === "木工" && u.record.total === 13000, "update: 渡した項目だけ変わる (言い換えも寄せる)。ほかはそのまま", after);
ok(sheetCalls.length === 1 && sheetCalls[0].id === target && sheetCalls[0].total === 13000 && sheetCalls[0].site === "入谷" && sheetOpts.at(-1)?.prevDate === "2026-11-05" && /行は増えない/.test(u.note) && !/手で消す/.test(u.note), "update: シートの同じ行を書き換える (編集前の購入日を渡す = 月が変わったら前の月の行が移る)。note は「行は増えない」", { call: sheetCalls[0], opts: sheetOpts.at(-1), note: u.note });
u = await call(S, "keihi_receipt_update", { id: target, photo_base64: b64(jpegTall) });
ok((await rows(`SELECT image_url FROM records WHERE id=$1`, [target]))[0].image_url?.startsWith("gs://test-receipts/2026-11-24/") && u.record.has_photo === true, "update: 写真を付け替えられる (追加機能)");
await throws(() => call(S, "keihi_receipt_update", { id: 999999, memo: "x" }), /見つからない/, "update: 無い id はエラー");
await throws(() => call(S, "keihi_receipt_update", { id: target, store: "" }), /store/, "update: 店舗を空にはできない");
const del0 = await call(S, "keihi_receipt_delete", { id: target });
ok(del0.deleted === false && del0.will_delete.id === target && (await rows(`SELECT 1 FROM records WHERE id=$1`, [target])).length === 1, "delete: confirm なしでは消さず、消す内容を返す");
const del1 = await call(S, "keihi_receipt_delete", { id: target, confirm: true });
ok(del1.deleted === true && (await rows(`SELECT 1 FROM records WHERE id=$1`, [target])).length === 0 && /シートの行と写真は残っている/.test(del1.note), "delete: confirm=true で DB の行を消す (写真とシートの行は残る = 画面と同じ)");
await throws(() => call(S, "keihi_receipt_delete", { id: target, confirm: true }), /見つからない/, "delete: 無い id はエラー");

// ───────── 11. ヒント・現場一覧・シート書き出し
const hn = await call(S, "keihi_receipt_hints", { stores: ["まいばすけっと", "未知の店"] });
ok(hn.by_store[0].past_count === 3 && hn.by_store[0].category[0].value === "その他" && hn.by_store[0].category[0].count === 3 && hn.by_store[0].suggest.category === "その他" && hn.by_store[0].suggest.consistent === true && hn.by_store[0].site[0].value === "入谷" && hn.by_store[0].payment[0].value === "現金" && hn.by_store[0].last.date === "2026-11-17", "hints: 同じ店の過去の傾向 (費目・現場・支払方法の件数と直近)", hn.by_store[0]);
ok(hn.by_store[1].past_count === 0 && /過去の登録なし/.test(hn.by_store[1].note), "hints: 過去に無い店は、その旨を返す");
ok(JSON.stringify(hn.choices.categories) === JSON.stringify(CATEGORIES) && hn.sites.includes("共通") && hn.sites.includes("会社") && hn.sites.indexOf("勝どきタワマン") === hn.sites.length - 1 && hn.overall.category.length > 0 && /費目の選び方/.test(hn.guide), "hints: 選択肢・現場の一覧 (完了は後ろ)・全体の傾向・選び方", hn.sites);
const stn = await call(S, "keihi_sites", {});
ok(stn.sites.length === 6 && stn.sites[stn.sites.length - 1].name === "勝どきタワマン" && stn.sites.at(-1).done === true && stn.sites.some((x) => x.name === "共通") && stn.sites.every((x) => !("keyBox" in x)), "sites: 画面の現場ボタンと同じ並び (完了は後ろ)。キーボックスは返さない", stn);
const sy = await call(S, "keihi_receipt_sheet_sync", { month: "2026-11", dry_run: true });
ok(sy.checked === 3 && syncCalls.at(-1).dryRun === true && sy.results.every((x) => x.monthly === "missing"), "sheet_sync: dry_run で足りない行を見る", sy);
const sy2 = await call(S, "keihi_receipt_sheet_sync", { ids: [pid] });
ok(sy2.appended === 1 && syncCalls.at(-1).ids[0] === pid, "sheet_sync: ids で書き出し直す");
await throws(() => call(S, "keihi_receipt_sheet_sync", {}), /ids か month/, "sheet_sync: 対象なしはエラー");

// ───────── 12. 画面 (REST) と共通の処理: 返す形・保存の形は今まで通り
const listed = await expense.listAll();
ok(listed.length >= 5 && ["id", "date", "store", "total", "category", "workType", "payment", "buyer", "site", "memo", "imageUrl", "driveUrl", "createdAt"].every((k) => k in listed[0]) && /^\d{4}-\d{2}-\d{2}$/.test(listed[0].date), "REST /api/records の返す形 (workType・imageUrl・date は文字列) は今まで通り");
const ins = await expense.insertRecord({ date: "2026-09-01", store: "REST 店", total: 10, category: "材料費", workType: "木工", payment: "現金", buyer: "小西", site: "入谷", memo: undefined, imageUrl: "gs://x/y.jpg", driveUrl: null });
ok(ins.id && ins.created_at, "REST: insertRecord は { id, created_at } を返す (201 の本文と同じ)");
ok(await expense.updateRecordRow(ins.id, { date: "2026-09-02", store: "REST 店 2", total: 11, category: "材料費", workType: "木工", payment: "現金", buyer: "小西", site: "入谷", memo: "m", driveUrl: null }) === 1 && await expense.updateRecordRow(999999, { date: "2026-09-02", store: "", total: 0, category: "", workType: "", payment: "", buyer: "", site: "" }) === 0, "REST: updateRecordRow は更新した行数を返す (0 なら 404)");
ok((await rows(`SELECT image_url FROM records WHERE id=$1`, [ins.id]))[0].image_url === "gs://x/y.jpg", "REST: 編集では写真の URL を変えない (画面と同じ)");
ok(await expense.getImageGsUrl(ins.id) === "gs://x/y.jpg" && (await expense.signedReadUrl("gs://b/k/e.jpg")).includes("signed.example/b/k/e.jpg"), "REST: 写真の閲覧 URL");
await expense.deleteRecordRow(ins.id);
ok((await rows(`SELECT 1 FROM records WHERE id=$1`, [ins.id])).length === 0, "REST: deleteRecordRow");
const put0 = await expense.putReceiptObject(Buffer.from("x"), "image/jpeg"); const put1 = await expense.putReceiptObject(Buffer.from("x"), "application/pdf");
ok(/^gs:\/\/test-receipts\/2026-11-24\/[0-9a-f-]{36}\.jpg$/.test(put0.imageUrl) && put0.key.endsWith(".jpg") && put1.key.endsWith(".pdf"), "/api/scan と共通の置き場 (jpg / pdf)");

// ───────── 12b. 画面の登録ボタンの連打・再送で記録が増えない (REST の insertRecord)
const base = { date: "2026-09-20", store: "連打 店", total: 777, category: "材料費", workType: "木工", payment: "現金", buyer: "小西", site: "入谷", memo: "", imageUrl: "gs://x/dup.jpg", driveUrl: null };
const i1 = await expense.insertRecord(base);
const i2 = await expense.insertRecord({ ...base });
const i3 = await expense.insertRecord({ ...base });
ok(i1.existed === undefined && i2.existed === true && i3.existed === true && i2.id === i1.id && i3.id === i1.id && (await rows(`SELECT count(*)::int AS n FROM records WHERE image_url='gs://x/dup.jpg'`))[0].n === 1, "同じ写真・日付・店舗・金額・購入者の登録を 3 回送っても、記録は 1 件 (2 回目以降は最初の記録を返す)", { i1, i2, i3 });
const i4 = await expense.insertRecord({ ...base, total: 778 });
const i5 = await expense.insertRecord({ ...base, store: "別の店" });
ok(i4.id !== i1.id && i5.id !== i1.id && i4.existed === undefined && i5.existed === undefined, "1 枚の写真に別々の領収書 (金額や店舗が違う) なら、別の記録として入る");
const i6 = await expense.insertRecord({ ...base, imageUrl: null }), i7 = await expense.insertRecord({ ...base, imageUrl: null });
ok(i6.id !== i7.id, "写真が無い登録は、今まで通り (そのまま入る。同じ写真かどうかを見られない)");
const i8 = await expense.insertRecord({ ...base }, { allowDuplicate: true });
ok(i8.id !== i1.id, "allowDuplicate (MCP の force) なら、同じ内容でも作る");
const meta = await expense.getRecordMeta(i1.id);
ok(meta.date === "2026-09-20" && meta.driveUrl === null && await expense.getRecordMeta(999999) === null, "getRecordMeta: 編集前の購入日・Drive の URL (無い id は null)");
await db.query(`DELETE FROM records WHERE store IN ('連打 店', '別の店')`);

// ───────── 12c. シートの重複整理ツール (探すだけが既定。消すのは apply=true)
const dd0 = await call(S, "keihi_receipt_sheet_dedupe", {});
ok(dedupeCalls.at(-1).apply === false && dd0.applied === false && dd0.extra_rows === 3 && dd0.identical_extra_rows === 1 && dd0.needs_review.monthly_groups === 1 && /消していない/.test(dd0.note) && /確認が要る所 1 件/.test(dd0.note) && dd0.monthly[0].rows.join() === "4,5,6", "dedupe: 既定は探すだけ (apply=false)。消していないと明記して、確認が要る数と重複の場所を返す", dd0);
ok(Array.isArray(dd0.db_duplicates) && dd0.auto_backfill?.status === "done", "dedupe: DB の重複 (db_duplicates) と、自動の整理の結果 (auto_backfill) も一緒に返る", { db: dd0.db_duplicates, auto: dd0.auto_backfill });
const dd1 = await call(S, "keihi_receipt_sheet_dedupe", { month: "2026-11", apply: true });
ok(dedupeCalls.at(-1).apply === true && dedupeCalls.at(-1).month === "2026-11" && dedupeCalls.at(-1).onlyIdentical === false && dd1.applied === true, "dedupe: apply=true と month を渡して整理する (中身が違う重複も、確認したあとなので対象)", dedupeCalls.at(-1));
await call(S, "keihi_receipt_sheet_dedupe", { apply: true, only_identical: true });
ok(dedupeCalls.at(-1).onlyIdentical === true, "dedupe: only_identical=true なら、中身が完全に同じ行だけ");
await throws(() => call(S, "keihi_receipt_sheet_dedupe", { month: "11月" }), /YYYY-MM/, "dedupe: month の形が違えばエラー");
ok(/人に見せて/.test(def.keihi_receipt_sheet_dedupe.description) && /apply=true/.test(def.keihi_receipt_sheet_dedupe.description) && /一番下/.test(def.keihi_receipt_sheet_dedupe.description) && /重複削除ログ/.test(def.keihi_receipt_sheet_dedupe.description) && /完全に同じ/.test(def.keihi_receipt_sheet_dedupe.description) && /1 記録 = 1 行/.test(EXPENSE_INSTRUCTIONS.join("\n")) && /重複削除ログ/.test(EXPENSE_INSTRUCTIONS.join("\n")), "dedupe の説明: 自動で消すのは完全に同じ行だけ・ログに残す・まず探すだけ → 人に見せて OK → apply=true。どの行を残すか。手順書にも");

// ───────── 12d. シートの重複の自動整理 (新しい版を最初に使ったとき 1 回だけ。中身が完全に同じ行だけ)
const marker = async () => (await rows(`SELECT value, updated_at FROM genba_settings WHERE key='sheet_dedupe_v1'`))[0];
const firstAuto = dedupeCalls[0];
ok(firstAuto && firstAuto.apply === true && firstAuto.onlyIdentical === true && firstAuto.month === undefined, "最初のツール呼び出しで、自動の整理が 1 回走る (apply=true・onlyIdentical=true = 完全に同じ行だけ)", firstAuto);
ok(dedupeCalls.filter((c) => c.onlyIdentical === true && c.apply === true && c.month === undefined).length === 2, "自動の整理は 1 回だけ (そのあとのツール呼び出しでは走らない。数えているのは、自動の 1 回 + only_identical を明示した上の 1 回)");
const mk = (await marker()).value;
ok(mk.status === "done" && mk.removed.monthly === 1 && mk.needs_review.monthly_groups === 1 && /重複削除ログ/.test(mk.note), "結果が印 (sheet_dedupe_v1) に残る (消した数・確認が要る数)", mk);
// 失敗したときのやり直し (別のインスタンスで)
const mkExpense = (dedupe) => createExpense({ getPool: () => pool, getStorage: () => storage, bucket: BUCKET, publicUrl: PUBLIC, secret: SECRET, findSites: (p, q, l) => genba.findSites(p, q, l), appendRecordToSheet, syncSheets, dedupeSheets: dedupe, today: () => clock });
await db.query(`DELETE FROM genba_settings WHERE key='sheet_dedupe_v1'`);
let tries = 0;
const failing = mkExpense(async () => { tries++; throw new Error("sheets down"); });
const callF = (name, args = {}) => failing.tools(S).find((x) => x.name === name).handler(args);
await callF("keihi_sites");
const mf = (await marker()).value;
ok(tries === 1 && mf.status === "failed" && /sheets down/.test(mf.error) && mf.attempts === 1, "自動の整理が失敗したら、印は failed (ツール自体は動く)", mf);
await callF("keihi_sites");
ok(tries === 1, "failed のあと 3 分以内は、やり直さない (毎回シートを叩かない)");
for (let n = 2; n <= 5; n++) {
  await db.query(`UPDATE genba_settings SET updated_at = now() - interval '4 minutes' WHERE key='sheet_dedupe_v1'`);
  const again = mkExpense(async () => { tries++; throw new Error("sheets down"); });
  await again.tools(S).find((x) => x.name === "keihi_sites").handler({});
}
ok(tries === 4 && (await marker()).value.attempts === 4, "失敗は最大 4 回までやり直す (それ以上は、毎回シートを叩かない)", { tries, m: (await marker()).value });
// 止まった (running のまま 3 分以上) 印は、次のリクエストが引き継ぐ
await db.query(`UPDATE genba_settings SET value='{"status":"running","attempts":1}'::jsonb, updated_at = now() - interval '4 minutes' WHERE key='sheet_dedupe_v1'`);
let taken = 0;
await mkExpense(async () => { taken++; return { removed: { monthly: 0, tx: 0 }, extra_rows: 0, identical_extra_rows: 0, needs_review: { monthly_groups: 0, tx_groups: 0, cross_tab: 0 } }; }).tools(S).find((x) => x.name === "keihi_sites").handler({});
ok(taken === 1 && (await marker()).value.status === "done", "止まった印 (running のまま 3 分以上) は、次のリクエストが引き継いで最後まで走る");
await db.query(`UPDATE genba_settings SET value='{"status":"running","attempts":1}'::jsonb, updated_at = now() WHERE key='sheet_dedupe_v1'`);
let dup = 0;
await mkExpense(async () => { dup++; return {}; }).tools(S).find((x) => x.name === "keihi_sites").handler({});
ok(dup === 0, "ほかのインスタンスが実行中 (3 分以内) なら、走らせない (同時に 2 つ走らない)");
await db.query(`UPDATE genba_settings SET value='{"status":"done"}'::jsonb WHERE key='sheet_dedupe_v1'`);
let afterDone = 0;
await mkExpense(async () => { afterDone++; return {}; }).tools(S).find((x) => x.name === "keihi_sites").handler({});
ok(afterDone === 0, "done の印があれば、新しいインスタンスも走らせない");

// ───────── 12e. DB の重複の検出 (読むだけ)
await db.query(`DELETE FROM records`);
for (let i = 0; i < 3; i++) await db.query(`INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url) VALUES ('2026-09-30','DB 重複 店',900,'材料費','木工','現金','小西','入谷','','gs://x/dbdup.jpg')`);
await db.query(`INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo, image_url) VALUES ('2026-09-30','DB 重複 店',901,'材料費','木工','現金','小西','入谷','','gs://x/dbdup.jpg')`);   // 同じ写真でも金額が違う = 別の領収書
await db.query(`INSERT INTO records (date, store, total, category, work_type, payment, buyer, site, memo) VALUES ('2026-09-30','写真なし',5,'材料費','木工','現金','小西','入谷','')`);
const ddb = await call(S, "keihi_receipt_sheet_dedupe", {});
ok(ddb.db_duplicates.length === 1 && ddb.db_duplicates[0].count === 3 && ddb.db_duplicates[0].ids.length === 3 && ddb.db_duplicates[0].total === 900 && ddb.db_duplicates[0].store === "DB 重複 店", "db_duplicates: 同じ写真・日付・店舗・金額・購入者の記録が複数ある所だけ出る (金額が違う・写真なしは対象外)", ddb.db_duplicates);
ok((await rows(`SELECT count(*)::int AS n FROM records`))[0].n === 5, "DB の記録は 1 件も消さない (読むだけ)");

// ───────── 13. ツールの定義・説明文・手順書 (どの AI が読んでも同じように使える)
const names = tl.map((t) => t.name);
ok(["keihi_receipt_add", "keihi_receipt_upload_url", "keihi_receipt_hints", "keihi_receipt_list", "keihi_receipt_get", "keihi_receipt_summary", "keihi_receipt_update", "keihi_receipt_delete", "keihi_receipt_photo", "keihi_receipt_export_csv", "keihi_receipt_sheet_sync", "keihi_receipt_sheet_dedupe", "keihi_sites"].every((n) => names.includes(n)) && new Set(names).size === names.length && names.length === 13, "ツール 13 個: 登録・アップロード URL・ヒント・一覧・詳細・集計・編集・削除・写真・CSV・シート書き出し・シート重複整理・現場一覧", names);
const RO = ["keihi_receipt_hints", "keihi_receipt_list", "keihi_receipt_get", "keihi_receipt_summary", "keihi_receipt_photo", "keihi_receipt_export_csv", "keihi_sites"];
ok(RO.every((n) => def[n].annotations?.readOnlyHint === true) && ["keihi_receipt_add", "keihi_receipt_update", "keihi_receipt_delete", "keihi_receipt_sheet_sync", "keihi_receipt_sheet_dedupe", "keihi_receipt_upload_url"].every((n) => !def[n].annotations?.readOnlyHint), "読むだけのツールだけ readOnlyHint (書くツールには付けない)");
ok(["keihi_receipt_add", "keihi_receipt_upload_url", "keihi_receipt_hints"].every((n) => /チャットに領収書の画像が貼られたら/.test(def[n].description)), "登録まわりの説明に「チャットに領収書の画像が貼られたら…」が入る (add / upload_url / hints)");
ok(["keihi_receipt_add", "keihi_receipt_hints"].every((n) => /費目の選び方/.test(def[n].description) && /工種の選び方/.test(def[n].description) && /過去の登録に合わせる|同じ店の過去の登録/.test(def[n].description)), "説明に 費目・工種の選び方と「過去の登録の傾向に合わせる」が入る");
ok(/photo_ref/.test(def.keihi_receipt_add.description) && /photo_base64/.test(def.keihi_receipt_add.description) && /重複/.test(def.keihi_receipt_add.description) && /OCR はサーバーでしない/.test(def.keihi_receipt_add.description), "add の説明: 写真の 2 通りの渡し方・重複防止・OCR はサーバーでしない");
ok(def.keihi_receipt_add.inputSchema.properties.receipts.maxItems === 30 && def.keihi_receipt_add.inputSchema.properties.receipts.items.required.join() === "date,site,store,total,category", "add の引数: 最大 30 件・必須は 日付 / 現場 / 店舗 / 金額 / 費目");
ok(EXPENSE_INSTRUCTIONS.join("\n").includes("keihi_receipt_add") && /画面を開かせない/.test(EXPENSE_INSTRUCTIONS[0]), "手順書: 領収書の画像が貼られたら登録まで終わらせる");

// ───────── 14. genba に載る (人ごとの URL と統合コネクタ。購入者は by で決まる)
const gt = genba.tools("名取");
ok(names.every((n) => gt.some((t) => t.name === n)) && gt.filter((t) => t.name === "keihi_receipt_list")[0].annotations?.readOnlyHint === true, "genba.tools(by) に keihi_* が一緒に載る (readOnlyHint も残る)");
ok(genba.instructions.includes("■ 経費 (keihi_*)") && genba.tools("小西").length === genba.tools("名取").length, "genba の手順書に経費が載る");
const viaGenba = await gt.find((t) => t.name === "keihi_receipt_add").handler({ receipts: [{ date: "2026-09-10", site: "入谷", store: "genba 経由", total: 90, category: "その他" }] });
ok((await rows(`SELECT buyer FROM records WHERE id=$1`, [viaGenba.results[0].id]))[0].buyer === "名取", "genba.tools('名取') 経由で登録すると購入者は名取");

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.close?.();
process.exit(fail ? 1 : 0);
