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
  let failAppendTab = null;   // このタブへの追記を失敗させる
  const setCells = (t, p, values) => values.forEach((vals, i) => { const row = (t.rows[p.r1 - 1 + i] ||= []); vals.forEach((v, j) => { row[p.c1 + j] = v; }); });
  const api = {
    spreadsheets: {
      get: async ({ spreadsheetId }) => ({ data: { sheets: [...book(spreadsheetId).tabs].map(([title, t]) => ({ properties: { title, sheetId: t.sheetId } })) } }),
      batchUpdate: async ({ spreadsheetId, requestBody }) => {
        for (const rq of requestBody.requests) {
          if (rq.addSheet) { addTab(spreadsheetId, rq.addSheet.properties.title); continue; }
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
        append: async ({ spreadsheetId, range, requestBody }) => { stats.appends++; const p = parse(range); if (failAppendTab && p.tab === failAppendTab) throw new Error("append failed");  const t = tabOf(spreadsheetId, p.tab, range); for (const v of requestBody.values) t.rows.push([...v]); return {}; },
        batchUpdate: async ({ spreadsheetId, requestBody }) => { stats.updates++; for (const d of requestBody.data) { const p = parse(d.range); setCells(tabOf(spreadsheetId, p.tab, d.range), p, d.values); } return {}; },
      },
    },
  };
  return { api, addTab, tab: (id, title) => book(id).tabs.get(title), stats, failGet: (m) => { failGet = m; }, failAppend: (t) => { failAppendTab = t; } };
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

// ───────── 11. 重複の行 (これまでに増えてしまった分) を探す
const dupId = 50;
const addMonthly = (o) => fs_.tab(MONTHLY, "2026-11").rows.push(monthlyRow(rec(o)));
const addTx = (o) => fs_.tab(TX, TXTAB).rows.push(txRow(txFields(rec(o))));
for (let i = 0; i < 4; i++) { addMonthly({ id: dupId, store: "連打 店", total: 5000, memo: `v${i}` }); addTx({ id: dupId, store: "連打 店", total: 5000, memo: `v${i}` }); }     // 中身が違う重複 (保存の合間に編集)
for (let i = 0; i < 3; i++) { addMonthly({ id: 52, store: "同じ 店", total: 5200, memo: "m" }); addTx({ id: 52, store: "同じ 店", total: 5200, memo: "m" }); }                // 中身が完全に同じ重複
for (let i = 0; i < 2; i++) addMonthly({ id: 51, store: "Drive 重複", total: 6000, driveUrl: "https://drive.google.com/file/d/DUP/view" });                                       // Drive の写真 (同じ URL・同じ中身)
// 1 枚の Drive の写真に別々の領収書が 2 枚 (URL は同じ。店舗・金額が違う = 別の記録) → 重複ではない
addMonthly({ id: 60, store: "1 枚に 2 枚 A", total: 100, driveUrl: "https://drive.google.com/file/d/SHARED/view" });
addMonthly({ id: 61, store: "1 枚に 2 枚 B", total: 200, driveUrl: "https://drive.google.com/file/d/SHARED/view" });
fs_.tab(TX, TXTAB).rows.push(["2026-11-01", "収入", "旅館", "", 9000, "宿の予約", "満竹華庵", "確定", "", "", "", "宿", "BK-1", "2026-11-01"], ["2026-11-01", "収入", "旅館", "", 9000, "宿の予約", "満竹華庵", "確定", "", "", "", "宿", "BK-1", "2026-11-01"]);   // 領収書以外 (宿) の同じ元 ID は触らない
const found = await rs.findDuplicates();
const gm = found.monthly.find((g) => g.id === dupId), gs = found.monthly.find((g) => g.id === 52), gd = found.monthly.find((g) => g.drive === "https://drive.google.com/file/d/DUP/view");
ok(gm && gm.count === 4 && gm.identical === false && gs && gs.count === 3 && gs.identical === true && gd && gd.count === 2 && gd.identical === true, "探す: 中身が違う重複 (identical: false) と、完全に同じ重複 (identical: true) が区別される", { gm, gs, gd });
ok(!found.monthly.some((g) => String(g.drive || "").includes("SHARED")), "1 枚の Drive の写真に別々の領収書 (店舗・金額が違う) が写っているときは、URL が同じでも重複にしない");
const gt = found.tx.find((g) => g.id === dupId), gts = found.tx.find((g) => g.id === 52);
ok(gt && gt.count === 4 && gt.identical === false && gts && gts.count === 3 && gts.identical === true && found.tx.length === 2 && !found.tx.some((g) => g.id === "BK-1"), "取引シートも同じ (宿など領収書以外は対象外。登録日が違うだけの行は同じ中身とみなす)", found.tx);
ok(found.checked.tabs >= 2 && found.checked.rows > 5, "確認した範囲 (タブ数・行数) も返る");
const m0 = monthlyRows().length, t0b = txRows().length;
const onlyOct = await rs.findDuplicates({ month: "2026-10" }); ok(onlyOct.monthly.length === 0 && onlyOct.checked.tabs === 1, "month で 1 つのタブだけ見られる");
ok(monthlyRows().length === m0 && txRows().length === t0b && !fs_.tab(MONTHLY, "重複削除ログ"), "探すだけでは 1 行も消さない・ログのタブも作らない");

// ───────── 12. 自動の整理 (onlyIdentical): 中身が完全に同じ行だけ消す。消す前にログへコピー
const auto = await rs.removeDuplicates(found, { onlyIdentical: true, now: () => "2026-11-24T10:00:00Z" });
ok(auto.monthly === 3 && auto.tx === 2 && auto.archived === 5 && auto.skipped_changed === 0 && auto.capped.length === 0, "自動の整理: 中身が完全に同じ重複だけ消す (月別 2 + 1 = 3 行・取引 2 行)", auto);
ok(monthlyRows().filter((x) => x[3] === "同じ 店").length === 1 && monthlyRows().filter((x) => x[3] === "Drive 重複").length === 1 && monthlyRows().filter((x) => x[3] === "連打 店").length === 4 && txRows().filter((x) => x[5] === "同じ 店").length === 1 && txRows().filter((x) => x[5] === "連打 店").length === 4, "中身が違う重複 (連打 店) は、自動では 1 行も消さない");
ok(monthlyRows().some((x) => x[3] === "1 枚に 2 枚 A") && monthlyRows().some((x) => x[3] === "1 枚に 2 枚 B") && txRows().filter((x) => x[11] === "宿").length === 2, "1 枚の写真に 2 枚の領収書・宿の行は消えない");
const logM = fs_.tab(MONTHLY, "重複削除ログ"), logT = fs_.tab(TX, "重複削除ログ");
ok(logM && logM.rows[0][0] === "削除した日時" && logM.rows.length === 1 + 3 && logM.rows[1][0] === "2026-11-24T10:00:00Z" && logM.rows[1][1] === "2026-11" && typeof logM.rows[1][2] === "number" && /同じ中身/.test(logM.rows[1][3]) && logM.rows.slice(1).some((r) => r.includes("同じ 店") && r.includes("5200")) && logM.rows.slice(1).some((r) => r.includes("Drive 重複")), "消した行は「重複削除ログ」タブに、日時・元のタブ・元の行・理由・残した行・中身つきで全部残る (月別)", logM.rows);
ok(logT && logT.rows.length === 1 + 2 && logT.rows[1][1] === "取引" && logT.rows[1].length >= 5 + 16, "取引シートのログには、A〜P の全列が残る", logT?.rows[1]);

// ───────── 13. 確認してからの整理: 中身が違う重複は一番下の行を残す。ログに残してから消す
const found2 = await rs.findDuplicates();
ok(found2.monthly.length === 1 && found2.monthly[0].id === dupId && found2.tx.length === 1, "自動の整理のあとに残るのは、中身が違う重複だけ (月別 1 グループ・取引 1 グループ)", found2);
const full = await rs.removeDuplicates(found2, { now: () => "2026-11-24T10:05:00Z" });
ok(full.monthly === 3 && full.tx === 3 && monthlyRows().filter((x) => x[3] === "連打 店").length === 1 && monthlyRows().find((x) => x[3] === "連打 店")[8] === "v3" && txRows().filter((x) => x[5] === "連打 店").length === 1 && txRows().find((x) => x[5] === "連打 店")[9] === "v3", "整理: 中身が違う重複は、一番下 (最後に書かれた = 一番新しい) の行を残して消す", { full });
ok(fs_.tab(MONTHLY, "重複削除ログ").rows.filter((r) => r[3] && /古い版/.test(r[3])).length === 3 && fs_.tab(MONTHLY, "重複削除ログ").rows.some((r) => r[0] === "2026-11-24T10:05:00Z" && r.includes("v0")), "古い版の行も、消す前にログに中身つきで残る");
const again = await rs.findDuplicates(); ok(again.monthly.length === 0 && again.tx.length === 0 && again.crossTab.length === 0, "整理のあとは、重複が 0");

// ───────── 14. 安全装置
// (a) ログにコピーできなかったら、消さない
for (let i = 0; i < 2; i++) addMonthly({ id: 70, store: "ログ失敗 店", total: 700, memo: "m" });
let f3 = await rs.findDuplicates({ month: "2026-11" });
fs_.failAppend("重複削除ログ");
await rs.removeDuplicates(f3, { onlyIdentical: true }).then(() => ok(false, "(a) ログに書けないとき、エラーになる"), (e) => ok(/append failed/.test(e.message) && monthlyRows().filter((x) => x[3] === "ログ失敗 店").length === 2, "ログにコピーできなかったら、消さずにエラーで止まる (行は 2 行のまま)", e.message));
fs_.failAppend(null);
// (b) 探したあと、消す前に行が変わっていたら、その行は消さない
f3 = await rs.findDuplicates({ month: "2026-11" });
const ri = fs_.tab(MONTHLY, "2026-11").rows.findIndex((r) => r[3] === "ログ失敗 店");
fs_.tab(MONTHLY, "2026-11").rows[ri][8] = "人が書き換えた";
const ch = await rs.removeDuplicates(f3, { onlyIdentical: true });
ok(ch.skipped_changed === 1 && ch.monthly === 0 && monthlyRows().filter((x) => x[3] === "ログ失敗 店").length === 2, "探したあと・消す前に、その行が書き換えられていたら消さない (skipped_changed)", ch);
// (c) 1 つのタブの半分以上を消す計画は止める
const f4 = await rs.findDuplicates({ month: "2026-11" });
fs_.tab(MONTHLY, "2026-11").rows[ri][8] = "m";
const tabRows = monthlyRows().length;
const many = { ...f4, monthly: [{ tab: "2026-11", id: 999, rows: Array.from({ length: tabRows }, (_, i) => i + 2), count: tabRows, identical: true, fps: Array.from({ length: tabRows }, (_, i) => `fp${i}`), sample: {} }], crossTab: [], tx: [] };
const cap = await rs.removeDuplicates(many, { onlyIdentical: true });
ok(cap.capped.length === 1 && cap.capped[0].tab === "2026-11" && cap.monthly === 0 && monthlyRows().length === tabRows, "1 つのタブの半分以上を消す計画は、何かおかしいので止める (capped)", cap);
// (d) 取引シートのログの列・宿の行は変わらない (上で確認済み)

// ───────── 15. 購入日の月を直した古い行 (別の月のタブにも同じ記録がある)
const A = rec({ id: 80, date: "2026-10-31", store: "月違い 店", total: 800 }), B = rec({ id: 80, date: "2026-11-02", store: "月違い 店", total: 800 });
fs_.addTab(MONTHLY, "2026-10", ["h"]);
fs_.tab(MONTHLY, "2026-10").rows.push(monthlyRow(A));
fs_.tab(MONTHLY, "2026-11").rows.push(monthlyRow(B));
const f5 = await rs.findDuplicates({ monthOf: async (ids) => new Map(ids.map((i) => [i, "2026-11"])) });
const ct = f5.crossTab.find((g) => g.id === 80);
ok(ct && ct.tabs.join() === "2026-10,2026-11" && ct.keepTab === "2026-11", "同じ記録が別の月のタブにもある所を見つける (DB の今の月 = 2026-11 を残す)", f5.crossTab);
const noAuto = await rs.removeDuplicates(f5, { onlyIdentical: true });
ok(noAuto.monthly === 1 && monthlyRows("2026-10").some((x) => x[3] === "月違い 店") && monthlyRows("2026-11").filter((x) => x[3] === "ログ失敗 店").length === 1, "自動の整理 (onlyIdentical) は、同じ中身の重複 (ID 70 の残り 1 つ) だけ消して、月をまたぐ古い行は消さない", { noAuto, tab10: monthlyRows("2026-10") });
const f5b = await rs.findDuplicates({ monthOf: async (ids) => new Map(ids.map((i) => [i, "2026-11"])) });   // 整理のあとは探し直す (古い計画では消さない)
const cross = await rs.removeDuplicates(f5b);
ok(cross.monthly === 1 && !monthlyRows("2026-10").some((x) => x[3] === "月違い 店") && monthlyRows("2026-11").some((x) => x[3] === "月違い 店") && fs_.tab(MONTHLY, "重複削除ログ").rows.some((r) => /購入日の月が変わる前/.test(r[3]) && r.includes("月違い 店")), "確認してからの整理では、前の月のタブの古い行を消して、今の月の行を残す (ログにも残る)", cross);
const f6 = await rs.findDuplicates({ monthOf: async () => new Map() });
ok(f6.crossTab.length === 0, "整理のあとは、月をまたぐ重複も 0");

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
