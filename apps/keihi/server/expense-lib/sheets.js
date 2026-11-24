// 経費の記録 ⇄ スプレッドシートの行。**1 記録 = 1 行**にする (同じ記録を何度保存しても行が増えない)。
//
// 以前は、登録・編集 (PUT) のたびに行を「追記」していた。現場ボタンを何回か押す / 保存を連打する = その回数ぶん行が増えた
// (取引シートの重複防止はサーバーのメモリの中だけで、再起動・複数インスタンスで消える)。
// ここでは、記録の ID で今ある行を探して、あれば**その行を書き換え**、無ければ追記する (upsert)。
//   月別タブ (経費記録スプレッドシート): 写真セル (J 列) の式に ?view=<ID> がある行 (Drive の写真なら Drive の URL がある行)
//   取引シート: ソース (L 列) が「領収書」で 元ID (M 列) が同じ行 (登録日 N 列は書き換えない)
// 同じ ID の保存は 1 つずつ順番に処理する (連打で同時に来ても、両方が「無い」と見て 2 行足さない)。
// 読み込みに失敗したときは追記しない (読めないまま足すと、重複の元になる)。
const MONTHLY_TAB = /^\d{4}-\d{2}$/;
const MISSING_TAB = /Unable to parse range|not found|Range \(.*\) exceeds/i;

// 写真セルの式 =HYPERLINK("…?view=123","🧾") から記録の ID (view=123 の 123。12 と 123 は別物)
export function recordIdOfCell(cell) {
  const m = String(cell ?? "").match(/[?&]view=(\d+)(?!\d)/);
  return m ? Number(m[1]) : null;
}
const driveUrlOfCell = (cell) => { const m = String(cell ?? "").match(/HYPERLINK\("((?:[^"]|"")+)"/); return m ? m[1].replace(/""/g, '"') : null; };

export function createRecordSheets({
  getSheetsApi, sheetId, txSheetId, txTab,
  ensureMonthlyTab,       // (sheets, ym) → 月別タブが無ければ作る
  monthlyRow,             // (record) → 月別タブの 1 行 (A〜J)
  appendMonthly,          // (sheets, record) → 月別タブの末尾に 1 行足す (今までの追記と同じ)
  txFields,               // (record) → appendTx に渡すオブジェクト
  txRow,                  // (txFields) → 取引シートの 1 行 (A〜P の 16 個)
  appendTx,               // (txFields) → 取引シートに足す { ok | skipped | error } (今までの追記と同じ)
  forgetTx = () => {},    // (key) → appendTx のメモリ上の重複防止から外す
  onTxChanged = () => {}, // 取引シートを書き換えたあと (keiri のキャッシュを捨てる)
  log = console,
}) {
  const ymOf = (d) => String(d || "").slice(0, 7) || "unknown";

  // ───────── 同じ ID の保存は順番に ─────────
  const tails = new Map();
  function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    tails.set(key, next);
    next.then(() => {}, () => {}).finally(() => { if (tails.get(key) === next) tails.delete(key); });
    return next;
  }

  // ───────── 月別タブ ─────────
  async function readMonthly(sheets, tab) {
    let v;
    try {
      v = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A2:J`, valueRenderOption: "FORMULA" });
    } catch (e) {
      if (MISSING_TAB.test(String(e.message))) return [];   // タブがまだ無い = 行も無い
      throw e;                                                // 読めなかった (一時的な失敗など) は追記に進まない
    }
    return (v.data.values || []).map((cells, i) => {
      const j = String(cells[9] ?? "");
      return { row: i + 2, cells, id: recordIdOfCell(j), drive: driveUrlOfCell(j) };
    });
  }
  const matchMonthly = (rows, r) => rows.filter((x) => (r.id != null && x.id != null && Number(x.id) === Number(r.id)) || (r.driveUrl && x.drive && x.drive === r.driveUrl));
  async function deleteRows(spreadsheetId, tab, rowNumbers) {
    if (!rowNumbers.length) return 0;
    const sheets = await getSheetsApi();
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    const sh = (meta.data.sheets || []).find((s) => s.properties && s.properties.title === tab);
    if (!sh) return 0;
    const requests = [...new Set(rowNumbers)].sort((a, b) => b - a).map((row) => ({ deleteDimension: { range: { sheetId: sh.properties.sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row } } }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    return requests.length;
  }
  async function upsertMonthly(r, { prevDate } = {}) {
    const ym = ymOf(r.date);
    if (!sheetId) return { skipped: true, reason: "SHEET_ID 未設定", tab: ym };
    if (!r.site) return { skipped: true, reason: "現場が空", tab: ym };
    try {
      const sheets = await getSheetsApi();
      await ensureMonthlyTab(sheets, ym);
      const hit = matchMonthly(await readMonthly(sheets, ym), r);
      if (hit.length) {
        const row = hit[0].row;
        await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${ym}!A${row}:J${row}`, valueInputOption: "USER_ENTERED", requestBody: { values: [monthlyRow(r)] } });
        log.log(`[sheets] updated id=${r.id} ym=${ym} row=${row}`);
        return { ok: true, tab: ym, action: "updated", row, extra_rows: hit.length > 1 ? hit.length - 1 : undefined };
      }
      // 編集で購入日の月が変わった: 前の月のタブにある行は外して、新しい月に足す (両方に残さない)
      let moved = false;
      const prevYm = prevDate ? ymOf(prevDate) : null;
      if (prevYm && prevYm !== ym && MONTHLY_TAB.test(prevYm)) {
        const old = matchMonthly(await readMonthly(sheets, prevYm), r);
        if (old.length) { await deleteRows(sheetId, prevYm, old.map((x) => x.row)); moved = true; }
      }
      await appendMonthly(sheets, r);
      log.log(`[sheets] appended id=${r.id} ym=${ym} site=${r.site}${moved ? ` (moved from ${prevYm})` : ""}`);
      return { ok: true, tab: ym, action: moved ? "moved" : "appended" };
    } catch (e) {
      log.warn(`[sheets] upsert FAILED id=${r.id}: ${e.message}`);
      return { ok: false, error: e.message, tab: ym };
    }
  }

  // ───────── 取引シート ─────────
  async function readTx(sheets) {
    let v;
    try {
      v = await sheets.spreadsheets.values.get({ spreadsheetId: txSheetId, range: `${txTab}!A2:P` });
    } catch (e) {
      if (MISSING_TAB.test(String(e.message))) return [];
      throw e;
    }
    return (v.data.values || []).map((cells, i) => ({ row: i + 2, cells, source: cells[11], id: cells[12] })).filter((x) => x.source === "領収書" && x.id != null && x.id !== "");
  }
  async function upsertTx(r) {
    if (!txSheetId) return { skipped: true, reason: "TX_SHEET_ID 未設定" };
    if (!r.site) return { skipped: true, reason: "現場が空" };
    try {
      const sheets = await getSheetsApi();
      const fields = txFields(r);
      const hit = (await readTx(sheets)).filter((x) => String(x.id) === String(r.id));
      if (hit.length) {
        const row = hit[0].row, vals = txRow(fields);
        // 登録日 (N 列) は最初に入れた日のまま。ほかを今の内容に合わせる
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: txSheetId,
          requestBody: { valueInputOption: "USER_ENTERED", data: [
            { range: `${txTab}!A${row}:M${row}`, values: [vals.slice(0, 13)] },
            { range: `${txTab}!O${row}:P${row}`, values: [vals.slice(14, 16)] },
          ] },
        });
        onTxChanged();
        log.log(`[tx] updated source=領収書 id=${r.id} row=${row}`);
        return { ok: true, action: "updated", row, extra_rows: hit.length > 1 ? hit.length - 1 : undefined };
      }
      forgetTx(`領収書:${r.id}`);   // メモリの重複防止があると、シートから消えた行を足し直せない
      const res = await appendTx(fields);
      return res && res.ok ? { ...res, action: "appended" } : res;
    } catch (e) {
      log.warn(`[tx] upsert FAILED id=${r.id}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // ───────── 登録・編集のたびに: 取引シートと月別タブに「この記録の行」を作る / 直す ─────────
  // 返り値 { tab, monthly, tx } (今までと同じ形。action = appended / updated / moved が付く)
  function upsert(r, opts = {}) {
    const run = async () => {
      const txP = upsertTx(r);
      const monthly = await upsertMonthly(r, opts);
      const tx = await txP;
      return { tab: monthly.tab || ymOf(r.date), monthly, tx };
    };
    return r.id != null ? withLock(String(r.id), run) : run();
  }

  // ───────── 書き出し直しの前に: どの行がシートにあるか (読むだけ) ─────────
  // 返り値: Map(記録 ID → { monthly: "exists" | "missing", tx: "exists" | "missing" | "skipped" })
  async function status(records) {
    const sheets = await getSheetsApi();
    const out = new Map();
    const tx = txSheetId ? await readTx(sheets) : null;
    const txIds = tx ? new Set(tx.map((x) => String(x.id))) : null;
    const monthlyCache = new Map();
    for (const r of records) {
      const ym = ymOf(r.date), res = { monthly: "skipped", tx: "skipped" };
      if (r.site) {
        if (txIds) res.tx = txIds.has(String(r.id)) ? "exists" : "missing";
        if (sheetId) {
          if (!monthlyCache.has(ym)) monthlyCache.set(ym, await readMonthly(sheets, ym));
          res.monthly = matchMonthly(monthlyCache.get(ym), r).length ? "exists" : "missing";
        }
      }
      out.set(Number(r.id), res);
    }
    return out;
  }

  // ───────── 同じ記録の行が 2 つ以上ある所を探す / 整理する ─────────
  // 方針 (会計のシートの行を消すので、安全側に倒す):
  //  ・同じ記録かどうか = 月別タブは 写真セルの ?view=ID (Drive の写真は「Drive の URL + 購入日 + 店舗 + 金額」。1 枚の写真に別々の領収書が写っているときは URL が同じでも別の記録) / 取引シートは ソース=領収書 + 元 ID
  //  ・中身が完全に同じ行 (identical) は、消しても情報が 1 つも減らない → 自動の整理 (onlyIdentical) の対象
  //  ・中身が違う行 (保存の合間に編集した = 古い版) は、確認してから消す (一番下 = 最後に書かれた = 一番新しい行を残す)
  //  ・消す前に、消す行を全部「重複削除ログ」タブにコピーする (コピーに失敗したら消さない)。消す直前に、その行がまだ同じ中身か読み直す
  //  ・1 つのタブの半分以上を消す計画になったら止める (何かおかしい)
  const LOG_TAB = "重複削除ログ";
  const LOG_HEADER = ["削除した日時", "元のタブ", "元の行", "理由", "残した行", "内容 (A 列から順に)"];
  const norm = (c) => String(c ?? "").trim();
  const fp = (cells, cols) => JSON.stringify(cols.map((i) => norm(cells[i])));
  const MONTHLY_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const TX_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15];      // 登録日 (N 列) は比べない

  async function monthlyTabs(sheets) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" });
    return (meta.data.sheets || []).map((s) => s.properties.title).filter((t) => MONTHLY_TAB.test(t)).sort();
  }
  // 返り値 { monthly: [{ tab, id | drive, rows, count, identical, sample }], crossTab: [{ id, tabs, keepTab? }], tx: [...], checked }。読むだけ
  // monthOf = async (ids) => Map(記録 ID → "YYYY-MM") (DB の今の購入日の月)。あれば、同じ記録が別の月のタブにもある所 (購入日の月を直した古い行) を、今の月のタブだけ残す対象にする
  async function findDuplicates({ month, monthOf } = {}) {
    const sheets = await getSheetsApi();
    const out = { monthly: [], crossTab: [], tx: [], checked: { tabs: 0, rows: 0 }, _rowCounts: {} };
    if (sheetId) {
      const tabs = month ? [month] : await monthlyTabs(sheets);
      const where = new Map();    // 記録 ID → [{ tab, row }] (タブをまたぐ重複を見る)
      for (const tab of tabs) {
        const rows = await readMonthly(sheets, tab);
        out.checked.tabs++; out.checked.rows += rows.length; out._rowCounts[tab] = rows.length;
        const groups = new Map();
        for (const x of rows) {
          const key = x.id != null ? `id:${x.id}` : x.drive ? `drive:${x.drive}|${norm(x.cells[0])}|${norm(x.cells[3])}|${norm(x.cells[4])}` : null;
          if (!key) continue;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(x);
          if (x.id != null) { if (!where.has(x.id)) where.set(x.id, []); where.get(x.id).push({ tab, row: x.row, fp: fp(x.cells, MONTHLY_COLS) }); }
        }
        for (const [key, list] of groups) {
          if (list.length < 2) continue;
          const c = list[list.length - 1].cells;
          out.monthly.push({
            tab, ...(key.startsWith("id:") ? { id: Number(key.slice(3)) } : { drive: key.slice(6).split("|")[0] }),
            rows: list.map((x) => x.row), count: list.length,
            fps: list.map((x) => fp(x.cells, MONTHLY_COLS)),
            identical: new Set(list.map((x) => fp(x.cells, MONTHLY_COLS))).size === 1,
            sample: { date: c[0], buyer: c[1], site: c[2], store: c[3], total: c[4] },
          });
        }
      }
      const multi = [...where].filter(([, locs]) => new Set(locs.map((l) => l.tab)).size > 1);
      if (multi.length) {
        const months = monthOf ? await monthOf(multi.map(([id]) => id)) : new Map();
        for (const [id, locs] of multi) {
          const keepTab = months.get(id);
          out.crossTab.push({ id, tabs: [...new Set(locs.map((l) => l.tab))], locations: locs, ...(keepTab && locs.some((l) => l.tab === keepTab) ? { keepTab } : {}) });
        }
      }
    }
    if (txSheetId) {
      const rows = await readTx(sheets);
      out.checked.tx_rows = rows.length; out._rowCounts[txTab] = rows.length;
      const groups = new Map();
      for (const x of rows) { const k = String(x.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
      for (const [k, list] of groups) {
        if (list.length < 2) continue;
        const c = list[list.length - 1].cells;
        out.tx.push({ id: Number(k), rows: list.map((x) => x.row), count: list.length, fps: list.map((x) => fp(x.cells, TX_COLS)), identical: new Set(list.map((x) => fp(x.cells, TX_COLS))).size === 1, sample: { date: c[0], site: c[6], store: c[5], total: c[4] } });
      }
    }
    return out;
  }
  const groupsToDelete = (found, onlyIdentical) => {
    const plan = [];   // { spreadsheetId, tab, row, keep, reason, cols }
    for (const g of found.monthly) {
      if (onlyIdentical && !g.identical) continue;
      const keep = g.rows[g.rows.length - 1], keepFp = g.fps[g.fps.length - 1];
      g.rows.slice(0, -1).forEach((row, i) => plan.push({ spreadsheetId: sheetId, tab: g.tab, row, fp: g.fps[i], keep, keepFp, cols: MONTHLY_COLS, reason: g.identical ? "同じ中身の重複" : "古い版 (最後に書かれた行を残した)" }));
    }
    if (!onlyIdentical) {
      for (const g of found.crossTab) {
        if (!g.keepTab) continue;
        for (const l of g.locations.filter((x) => x.tab !== g.keepTab)) plan.push({ spreadsheetId: sheetId, tab: l.tab, row: l.row, fp: l.fp, keep: null, cols: MONTHLY_COLS, reason: `購入日の月が変わる前の古い行 (今は ${g.keepTab} のタブ)` });
      }
    }
    for (const g of found.tx) {
      if (onlyIdentical && !g.identical) continue;
      const keep = g.rows[g.rows.length - 1], keepFp = g.fps[g.fps.length - 1];
      g.rows.slice(0, -1).forEach((row, i) => plan.push({ spreadsheetId: txSheetId, tab: txTab, row, fp: g.fps[i], keep, keepFp, cols: TX_COLS, reason: g.identical ? "同じ中身の重複" : "古い版 (最後に書かれた行を残した)" }));
    }
    return plan;
  }
  async function ensureLogTab(sheets, spreadsheetId) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    if ((meta.data.sheets || []).some((s) => s.properties && s.properties.title === LOG_TAB)) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: LOG_TAB, gridProperties: { frozenRowCount: 1 } } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${LOG_TAB}!A1`, valueInputOption: "RAW", requestBody: { values: [LOG_HEADER] } });
  }
  // 重複の行を消す。onlyIdentical = true なら中身が完全に同じ行だけ (自動の整理)。返り値 = 消した行数・止めた理由
  async function removeDuplicates(found, { onlyIdentical = false, now = () => new Date().toISOString() } = {}) {
    const sheets = await getSheetsApi();
    const plan = groupsToDelete(found, onlyIdentical);
    const result = { monthly: 0, tx: 0, skipped_changed: 0, capped: [], archived: 0 };
    const bySheetTab = new Map();
    for (const x of plan) { const k = `${x.spreadsheetId}|${x.tab}`; if (!bySheetTab.has(k)) bySheetTab.set(k, []); bySheetTab.get(k).push(x); }
    for (const [, items] of bySheetTab) {
      const { spreadsheetId, tab } = items[0];
      const total = (found._rowCounts && found._rowCounts[tab]) || 0;
      // 半分以上を消す計画は止める (何かおかしい)。行が少ないタブは割合で見られないので、5 行までは許す
      if (total && items.length > Math.max(5, total / 2)) { result.capped.push({ tab, rows_to_delete: items.length, rows: total }); continue; }
      // 消す直前に読み直して、まだ同じ中身の行だけを対象にする (読んだあとに行がずれていたら消さない)
      const isTx = spreadsheetId === txSheetId && tab === txTab;
      const fresh = isTx ? await readTx(sheets) : await readMonthly(sheets, tab);
      const byRow = new Map(fresh.map((x) => [x.row, x]));
      const cols = items[0].cols;
      const sure = [];
      for (const it of items) {
        const nowRow = byRow.get(it.row), keepRow = it.keep != null ? byRow.get(it.keep) : null;
        const same = nowRow && fp(nowRow.cells, cols) === it.fp;                                   // 消す行は、探したときと同じ中身か
        const keepOk = it.keep == null || (keepRow && fp(keepRow.cells, cols) === it.keepFp);       // 残す行も、まだそこにあるか
        if (!same || !keepOk) { result.skipped_changed++; continue; }
        sure.push({ ...it, cells: nowRow.cells });
      }
      if (!sure.length) continue;
      // 先に「重複削除ログ」にコピー。失敗したら消さない (throw)
      await ensureLogTab(sheets, spreadsheetId);
      const stamp = now();
      await sheets.spreadsheets.values.append({
        spreadsheetId, range: `${LOG_TAB}!A:F`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
        requestBody: { values: sure.map((x) => [stamp, tab, x.row, x.reason, x.keep != null ? x.keep : "", ...x.cells.slice(0, isTx ? 16 : 10).map((c) => String(c ?? ""))]) },
      });
      result.archived += sure.length;
      const n = await deleteRows(spreadsheetId, tab, sure.map((x) => x.row));
      if (isTx) { result.tx += n; onTxChanged(); } else result.monthly += n;
    }
    return result;
  }

  return { upsert, status, findDuplicates, removeDuplicates, readMonthly, readTx };
}
