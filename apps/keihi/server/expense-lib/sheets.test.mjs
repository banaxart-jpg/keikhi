// 経費の記録 ⇄ スプレッドシートの行 (sheets.js) のテスト。Google の代わりにメモリ上の偽のスプレッドシートを使う。
// 実行: node apps/keihi/server/expense-lib/sheets.test.mjs   (依存なし)
import { createRecordSheets, recordIdOfCell } from "./sheets.js";

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, x !== undefined ? JSON.stringify(x).slice(0, 700) : ""); } };

// ───────── 偽の Google Sheets API (rows[0] = 1 行目 = ヘッダー) ─────────
function fakeSheets() {
  const books = new Map();
  const book = (id) => { if (!books.has(id)) books.set(id, { tabs: new Map(), next: 1 }); return books.get(id); };
  const addTab = (id, title, header) => { const b = book(id); if (!b.tabs.has(title)) b.tabs.set(title, { sheetId: b.next++, rows: header ? [header] : [] }); return b.tabs.get(title); };
  const col = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range) => { const m = range.match(/^(.+)!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/); if (!m) throw new Error(`Unable to parse range: ${range}`); return { tab: m[1], c1: col(m[2]), r1: m[3] ? Number(m[3]) : 1, c2: m[4] ? col(m[4]) : col(m[2]), r2: m[5] ? Number(m[5]) : null }; };
  const tabOf = (id, tab, range) => { const t = book(id).tabs.get(tab); if (!t) throw new Error(`Unable to parse range: ${range}`); return t; };
  const stats = { gets: 0, updates: 0, appends: 0, deletes: 0 };
  let failGet = null;   // 読み込みを失敗させる (一時的な障害の再現)
  const setCells = (t, p, values) => values.forEach((vals, i) => { const row = (t.rows[p.r1 - 1 + i] ||= []); vals.forEach((v, j) => { row[p.c1 + j] = v; }); });
  const api = {
    spreadsheets: {
      get: async ({ spreadsheetId }) => ({ data: { sheets: [...book(spreadsheetId).tabs].map(([title, t]) => ({ properties: { title, sheetId: t.sheetId } })) } }),
      batchUpdate: async ({ spreadsheetId, requestBody }) => {
        for (const rq of requestBody.requests) {
          if (rq.deleteDimension) { stats.deletes++; const t = [...book(spreadsheetId).tabs.values()].find((x) => x.sheetId === rq.deleteDimension.range.sheetId); t.rows.splice(rq.deleteDimension.range.startIndex, 1); }
        }
        return {};
      },
      values: {
        get: async ({ spreadsheetId, range }) => {
          stats.gets++;
          if (failGet) throw new Error(failGet);
          const p = parse(range), t = tabOf(spreadsheetId, p.tab, range);
          const rows = t.rows.slice(p.r1 - 1, p.r2 ? p.r2 : undefined).map((r) => (r || []).slice(p.c1, p.c2 + 1));
          return { data: { values: rows.map((r) => { const x = [...r]; while (x.length && (x[x.length - 1] === undefined || x[x.length - 1] === "")) x.pop(); return x; }) } };
        },
        update: async ({ spreadsheetId, range, requestBody }) => { stats.updates++; const p = parse(range); setCells(tabOf(spreadsheetId, p.tab, range), p, requestBody.values); return {}; },
        append: async ({ spreadsheetId, range, requestBody }) => { stats.appends++; const p = parse(range); const t = tabOf(spreadsheetId, p.tab, range); for (const v of requestBody.values) t.rows.push([...v]); return {}; },
        batchUpdate: async ({ spreadsheetId, requestBody }) => { stats.updates++; for (const d of requestBody.data) { const p = parse(d.range); setCells(tabOf(spreadsheetId, p.tab, d.range), p, d.values); } return {}; },
      },
    },
  };
  return { api, addTab, tab: (id, title) => book(id).tabs.get(title), stats, failGet: (m) => { failGet = m; } };
}

const MONTHLY = "MONTHLY", TX = "TX", TXTAB = "取引";
const fs_ = fakeSheets();
const photoCell = (r) => { const u = r.driveUrl || (r.id ? `https://keihi-496002.web.app/keihi/?view=${r.id}` : ""); return u ? `=HYPERLINK("${u.replace(/"/g, '""')}","🧾")` : ""; };
const monthlyRow = (r) => [r.date || "", r.buyer || "", r.site || "", r.store || "", Number(r.total) || 0, r.category || "", r.workType || "", r.payment || "", r.memo || "", photoCell(r)];
const txFields = (r) => ({ date: r.date, type: "支出", category: r.site === "満竹華庵" ? "旅館" : "工事", subcategory: r.category, amount: Number(r.total) || 0, counterparty: r.store, site: r.site, status: "確定", paymentMethod: r.payment, memo: r.memo, buyer: r.buyer, workType: r.workType, photoCell: photoCell(r), source: "領収書", refId: r.id });
const txRow = (r) => [r.date || "", r.type || "", r.category || "", r.subcategory || "", Number(r.amount) || 0, r.counterparty || "", r.site || "", r.status || "確定", r.paymentMethod || "", r.memo || "", r.photoCell || "", r.source || "", r.refId || "", r.registeredAt || "2026-11-24", r.buyer || "", r.workType || ""];
const seen = new Set();
let txChanged = 0;
const logs = { log: () => {}, warn: () => {} };
const rs = createRecordSheets({
  getSheetsApi: async () => fs_.api, sheetId: MONTHLY, txSheetId: TX, txTab: TXTAB,
  ensureMonthlyTab: async (_s, ym) => { fs_.addTab(MONTHLY, ym, ["購入日", "購入者", "現場", "店舗", "金額", "費目", "工種", "支払方法", "メモ", "写真"]); },
  monthlyRow, appendMonthly: async (s, r) => s.spreadsheets.values.append({ spreadsheetId: MONTHLY, range: `${String(r.date).slice(0, 7)}!A:J`, requestBody: { values: [monthlyRow(r)] } }),
  txFields, txRow,
  appendTx: async (f) => { fs_.addTab(TX, TXTAB, ["日付", "種別"]); if (f.refId && seen.has(`${f.source}:${f.refId}`)) return { skipped: true, reason: "duplicate refId in cache" }; await fs_.api.spreadsheets.values.append({ spreadsheetId: TX, range: `${TXTAB}!A:P`, requestBody: { values: [txRow(f)] } }); if (f.refId) seen.add(`${f.source}:${f.refId}`); return { ok: true }; },
  forgetTx: (k) => seen.delete(k), onTxChanged: () => { txChanged++; }, log: logs,
});
const rec = (o) => ({ id: 1, date: "2026-11-05", buyer: "小西", site: "入谷", store: "コメリ", total: 1000, category: "材料費", workType: "木工", payment: "現金", memo: "", driveUrl: null, ...o });
const rowsOf = (id, tab) => (fs_.tab(id, tab)?.rows || []).slice(1);
const monthlyRows = (tab = "2026-11") => rowsOf(MONTHLY, tab);
const txRows = () => rowsOf(TX, TXTAB);

// ───────── 1. recordIdOfCell: 12 と 123 を取り違えない
ok(recordIdOfCell('=HYPERLINK("https://keihi-496002.web.app/keihi/?view=12","🧾")') === 12 && recordIdOfCell('=HYPERLINK("https://x/keihi/?view=123","🧾")') === 123 && recordIdOfCell('=HYPERLINK("https://drive.google.com/file/d/abc/view","🧾")') === null && recordIdOfCell("") === null && recordIdOfCell(undefined) === null, "写真セルから記録の ID を読む (12 と 123 は別。Drive の URL・空は null)");

// ───────── 2. 初回は両方に 1 行ずつ足す
let r1 = await rs.upsert(rec({ id: 1 }));
ok(r1.monthly.ok && r1.monthly.action === "appended" && r1.tx.ok && r1.tx.action === "appended" && r1.tab === "2026-11" && monthlyRows().length === 1 && txRows().length === 1, "初回: 月別タブと取引シートに 1 行ずつ足す", r1);
ok(monthlyRows()[0][3] === "コメリ" && monthlyRows()[0][9].includes("view=1") && txRows()[0][12] === 1 && txRows()[0][13] === "2026-11-24" && txRows()[0][14] === "小西", "足した中身 (店舗・写真セル view=ID・元 ID・登録日・購入者)");

// ───────── 3. 同じ記録を何回保存しても 1 行 (現場ボタンの連打・保存の連打の再現)
for (let i = 0; i < 5; i++) await rs.upsert(rec({ id: 1 }));
ok(monthlyRows().length === 1 && txRows().length === 1, "同じ記録を 5 回続けて保存しても、行は 1 行のまま (以前は押した回数ぶん増えた)");
const rEdit = await rs.upsert(rec({ id: 1, total: 1500, store: "コメリ 新店", site: "銀座博品館", memo: "直した", category: "工具・備品" }));
ok(rEdit.monthly.action === "updated" && rEdit.tx.action === "updated" && monthlyRows().length === 1 && txRows().length === 1 && monthlyRows()[0][4] === 1500 && monthlyRows()[0][3] === "コメリ 新店" && monthlyRows()[0][2] === "銀座博品館" && txRows()[0][4] === 1500 && txRows()[0][3] === "工具・備品" && txRows()[0][6] === "銀座博品館" && txRows()[0][9] === "直した", "編集は同じ行を書き換える (金額・店舗・現場・費目・メモが新しい内容に。以前は取引シートは古いまま)", { m: monthlyRows(), t: txRows() });
ok(txRows()[0][13] === "2026-11-24" && txRows()[0][12] === 1, "取引シートの登録日・元 ID は書き換えない");
ok(txChanged >= 1, "取引シートを書き換えたら keiri のキャッシュを捨てる");

// ───────── 4. 同時に来た保存 (連打で並行に届く) も 1 行
const before = fs_.stats.appends;
await Promise.all(Array.from({ length: 12 }, () => rs.upsert(rec({ id: 2, store: "同時 店", total: 222 }))));
ok(monthlyRows().filter((x) => x[3] === "同時 店").length === 1 && txRows().filter((x) => x[5] === "同時 店").length === 1 && fs_.stats.appends - before === 2, "同じ ID の保存が 12 件同時に来ても、行は月別・取引とも 1 行 (追記は 1 回ずつ)", { appends: fs_.stats.appends - before });
await Promise.all([rs.upsert(rec({ id: 3, store: "別 A", total: 1 })), rs.upsert(rec({ id: 4, store: "別 B", total: 2 }))]);
ok(monthlyRows().filter((x) => ["別 A", "別 B"].includes(x[3])).length === 2, "違う記録は並行でも、それぞれ 1 行ずつ入る");

// ───────── 5. ID の前方一致を取り違えない (view=1 と view=12)
await rs.upsert(rec({ id: 12, store: "十二 店", total: 12 }));
const r1b = await rs.upsert(rec({ id: 1, store: "コメリ 新店", total: 1500, site: "銀座博品館", memo: "直した", category: "工具・備品" }));
ok(r1b.monthly.action === "updated" && monthlyRows().filter((x) => x[3] === "十二 店").length === 1 && monthlyRows().find((x) => x[3] === "十二 店")[4] === 12, "ID 12 の行を、ID 1 の保存で書き換えない");

// ───────── 6. Drive の写真 (view=ID が無い) は Drive の URL で同じ行を見つける
const drive = "https://drive.google.com/file/d/AAA/view?usp=drivesdk";
await rs.upsert(rec({ id: 20, store: "Drive 店", total: 2000, driveUrl: drive }));
await rs.upsert(rec({ id: 20, store: "Drive 店", total: 2000, driveUrl: drive, memo: "二回目" }));
ok(monthlyRows().filter((x) => x[3] === "Drive 店").length === 1 && monthlyRows().find((x) => x[3] === "Drive 店")[8] === "二回目" && txRows().filter((x) => x[5] === "Drive 店").length === 1, "Drive の写真の記録も、保存し直しで行が増えず書き換わる");

// ───────── 7. 購入日の月を直したら、前の月のタブの行を外して新しい月に移す
await rs.upsert(rec({ id: 30, date: "2026-10-30", store: "月またぎ 店", total: 3030 }));
ok(monthlyRows("2026-10").filter((x) => x[3] === "月またぎ 店").length === 1, "(準備) 10 月のタブに入る");
const mv = await rs.upsert(rec({ id: 30, date: "2026-11-02", store: "月またぎ 店", total: 3030 }), { prevDate: "2026-10-30" });
ok(mv.monthly.action === "moved" && mv.tab === "2026-11" && monthlyRows("2026-10").filter((x) => x[3] === "月またぎ 店").length === 0 && monthlyRows("2026-11").filter((x) => x[3] === "月またぎ 店").length === 1 && txRows().filter((x) => x[5] === "月またぎ 店").length === 1 && txRows().find((x) => x[5] === "月またぎ 店")[0] === "2026-11-02", "購入日を別の月に直すと、前の月の行を外して新しい月に 1 行 (取引シートは同じ行の日付が変わる)", mv);

// ───────── 8. 現場が空 / 読めなかったとき
const sk = await rs.upsert(rec({ id: 40, site: "" }));
ok(sk.monthly.skipped && sk.tx.skipped && monthlyRows().every((x) => x[3] !== undefined) && !monthlyRows().some((x) => String(x[9]).includes("view=40")), "現場が空の記録はシートに書かない (今まで通り)");
const n0 = monthlyRows().length, t0 = txRows().length;
fs_.failGet("The service is currently unavailable.");
const fl = await rs.upsert(rec({ id: 1 }));
fs_.failGet(null);
ok(fl.monthly.ok === false && fl.tx.ok === false && monthlyRows().length === n0 && txRows().length === t0, "シートを読めなかった (一時的な障害) ときは追記しない = 重複の元を作らない", fl);
ok((await rs.upsert(rec({ id: 1 }))).monthly.ok === true && monthlyRows().length === n0, "障害が直ったあとの保存は、同じ行を書き換える (増えない)");

// ───────── 9. シートから行が消えていたら、次の保存で足し直す
fs_.tab(TX, TXTAB).rows = fs_.tab(TX, TXTAB).rows.filter((r, i) => i === 0 || r[12] !== 1);
const re = await rs.upsert(rec({ id: 1 }));
ok(re.tx.action === "appended" && txRows().filter((x) => x[12] === 1).length === 1, "取引シートの行を手で消していたら、次の保存で 1 行足し直す (メモリの重複防止で飛ばさない)", re);

// ───────── 10. status (書き出し直しの前の確認)
const st = await rs.status([rec({ id: 1 }), rec({ id: 999, store: "無い" }), rec({ id: 41, site: "" }), rec({ id: 20, driveUrl: drive })]);
ok(st.get(1).monthly === "exists" && st.get(1).tx === "exists" && st.get(999).monthly === "missing" && st.get(999).tx === "missing" && st.get(41).monthly === "skipped" && st.get(20).monthly === "exists", "status: ある / 無い / 現場が空 (12 と 1 を取り違えない)", [...st]);

// ───────── 11. 重複の行 (これまでに増えてしまった分) を探して、整理する
const dupId = 50;
for (let i = 0; i < 4; i++) { fs_.tab(MONTHLY, "2026-11").rows.push(monthlyRow(rec({ id: dupId, store: "連打 店", total: 5000, memo: `v${i}` }))); fs_.tab(TX, TXTAB).rows.push(txRow(txFields(rec({ id: dupId, store: "連打 店", total: 5000, memo: `v${i}` })))); }
for (let i = 0; i < 2; i++) fs_.tab(MONTHLY, "2026-11").rows.push(monthlyRow(rec({ id: 51, store: "Drive 重複", total: 6000, driveUrl: "https://drive.google.com/file/d/DUP/view" })));
fs_.tab(TX, TXTAB).rows.push(["2026-11-01", "収入", "旅館", "", 9000, "宿の予約", "満竹華庵", "確定", "", "", "", "宿", "BK-1", "2026-11-01"], ["2026-11-01", "収入", "旅館", "", 9000, "宿の予約", "満竹華庵", "確定", "", "", "", "宿", "BK-1", "2026-11-01"]);   // 領収書以外 (宿) の同じ元 ID は触らない
const found = await rs.findDuplicates();
const gm = found.monthly.find((g) => g.id === dupId), gd = found.monthly.find((g) => g.drive === "https://drive.google.com/file/d/DUP/view"), gt = found.tx.find((g) => g.id === dupId);
ok(gm && gm.count === 4 && gm.tab === "2026-11" && gm.rows.length === 4 && gm.sample.store === "連打 店" && gd && gd.count === 2 && gt && gt.count === 4 && found.tx.length === 1 && found.monthly.length === 2, "重複を探す: 月別 (ID・Drive の URL)・取引シートで、同じ記録の行が複数ある所だけ出る (宿など領収書以外は対象外)", found);
ok(found.checked.tabs >= 2 && found.checked.rows > 5, "確認した範囲 (タブ数・行数) も返る");
const tabsBefore = monthlyRows().length, txBefore = txRows().length;
const onlyOct = await rs.findDuplicates({ month: "2026-10" }); ok(onlyOct.monthly.length === 0 && onlyOct.checked.tabs === 1, "month で 1 つのタブだけ見られる");
ok(monthlyRows().length === tabsBefore && txRows().length === txBefore, "探すだけでは 1 行も消さない");
const gone = await rs.removeDuplicates(found);
ok(gone.monthly === 4 && gone.tx === 3 && monthlyRows().filter((x) => x[3] === "連打 店").length === 1 && monthlyRows().find((x) => x[3] === "連打 店")[8] === "v3" && monthlyRows().filter((x) => x[3] === "Drive 重複").length === 1 && txRows().filter((x) => x[5] === "連打 店").length === 1 && txRows().find((x) => x[5] === "連打 店")[9] === "v3", "整理: 各グループで一番下 (最後に書かれた = 一番新しい) の行を残して、ほかを消す", { gone, m: monthlyRows().filter((x) => x[3] === "連打 店") });
ok(txRows().filter((x) => x[11] === "宿").length === 2 && monthlyRows().length === tabsBefore - 4 && txRows().length === txBefore - 3, "宿の行・ほかの記録の行は 1 行も消えない (消えたのは重複ぶんだけ)");
const again = await rs.findDuplicates(); ok(again.monthly.length === 0 && again.tx.length === 0, "整理のあとは、重複が 0");

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
