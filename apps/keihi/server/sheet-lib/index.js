// スプレッドシート (/sheet/) の保存と、AI が MCP で読み書きするためのツール (sheet_*)。
// 正本は Cloud SQL の sheet_books (1 ファイル = 1 行、中身は JSONB)。社内で全員共有 (records / tasks と同じ)。
// 画面は差分 (engine.js の diffBook) を PATCH で送り、サーバーは行ロックを取って今の中身に重ねる。
// AI のツールも同じ行ロックの中で書き換えるので、人と AI が同時に触っても消し合わない。version が上がると画面は数秒で取り込む。
// 数式の計算は engine.js (ブラウザと同じファイル) で行うので、AI が読む値と画面の値は同じになる。

import * as ENG from "./engine.js";

const ID_RE = /^[a-z0-9]{6,24}$/;
const MAX_BYTES = 8 * 1024 * 1024; // 1 ファイルの上限 (JSON)
const MAX_READ_CELLS = 5000;       // sheet_read で一度に返すセル数の上限

export function createSheetLib({ getPool, appUrl = "https://keihi-496002.web.app/sheet/" }) {
  const pool = () => { const p = getPool(); if (!p) throw new Error("DB not configured"); return p; };

  let schemaPromise = null;
  function ensureSchema() {
    schemaPromise ||= (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS sheet_books (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          data        JSONB NOT NULL,
          version     INT NOT NULL DEFAULT 1,
          created_by  TEXT,
          updated_by  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at  TIMESTAMPTZ
        )`);
    })().catch((e) => { schemaPromise = null; throw e; });
    return schemaPromise;
  }

  const bookUrl = (id) => `${appUrl}?book=${id}`;
  const metaOut = (r) => ({ id: r.id, name: r.name, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by || undefined });
  const fullOut = (r) => ({ ...metaOut(r), data: r.data });
  const cleanData = (d) => {
    const sheets = Array.isArray(d?.sheets) ? d.sheets.filter((s) => s && typeof s.id === "string") : [];
    if (!sheets.length) sheets.push(ENG.newSheet("シート1"));
    for (const s of sheets) { s.name = String(s.name || "シート"); s.cells = s.cells && typeof s.cells === "object" ? s.cells : {}; s.colW = s.colW && typeof s.colW === "object" ? s.colW : {}; s.rows = Number(s.rows) || ENG.DEF_ROWS; s.cols = Number(s.cols) || ENG.DEF_COLS; }
    return { sheets };
  };
  const tooBig = (data) => JSON.stringify(data).length > MAX_BYTES;

  async function create({ id, name, data, by }) {
    await ensureSchema();
    id = id && ID_RE.test(id) ? id : ENG.uid() + ENG.uid().slice(0, 4);
    const d = cleanData(data);
    if (tooBig(d)) throw httpErr(413, "大きすぎます (8MB まで)");
    const { rows } = await pool().query(
      `INSERT INTO sheet_books (id, name, data, created_by, updated_by) VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, String(name || "無題のスプレッドシート").slice(0, 200), d, by || null]);
    if (!rows[0]) throw httpErr(409, "同じ ID のファイルがあります");
    return rows[0];
  }

  // 行ロックを取って fn(data, row) で書き換え → version を上げて保存。fn の戻り値を result で返す
  async function mutate(id, by, fn) {
    await ensureSchema();
    const c = await pool().connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query("SELECT * FROM sheet_books WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!rows[0]) throw httpErr(404, "ファイルが見つかりません");
      const row = rows[0];
      const data = cleanData(row.data);
      const ctx = { name: row.name };
      const result = await fn(data, ctx);
      if (tooBig(data)) throw httpErr(413, "大きすぎます (8MB まで)");
      const { rows: out } = await c.query(
        `UPDATE sheet_books SET data=$2, name=$3, version=version+1, updated_by=$4, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, data, String(ctx.name || row.name).slice(0, 200), by || null]);
      await c.query("COMMIT");
      return { row: out[0], result };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  // ═══════════════ 画面用 REST (Firebase 認証の後ろに置く) ═══════════════
  function mountRoutes(app) {
    const wrap = (fn) => async (req, res) => {
      try { await fn(req, res); }
      catch (e) { res.status(e.status || 500).json({ error: e.message }); if (!e.status) console.warn("[sheet]", e); }
    };
    const who = (req) => (req.user && req.user.email) || null;

    app.get("/api/sheet/books", wrap(async (req, res) => {
      await ensureSchema();
      const { rows } = await pool().query("SELECT id, name, version, updated_at, updated_by FROM sheet_books WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500");
      res.json(rows.map(metaOut));
    }));
    app.post("/api/sheet/books", wrap(async (req, res) => {
      const b = req.body || {};
      res.json(fullOut(await create({ id: b.id, name: b.name, data: b.data, by: who(req) })));
    }));
    // ?v=今持っている version。変わっていなければ中身は返さない (数秒おきのポーリング用)
    app.get("/api/sheet/books/:id", wrap(async (req, res) => {
      await ensureSchema();
      const v = Number(req.query.v);
      const { rows } = await pool().query("SELECT * FROM sheet_books WHERE id=$1 AND deleted_at IS NULL", [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "ファイルが見つかりません" });
      if (v && rows[0].version === v) return res.json({ unchanged: true, version: v });
      res.json(fullOut(rows[0]));
    }));
    // { diff, name? } を今の中身に重ねる。返り値は重ねた後の全体
    app.patch("/api/sheet/books/:id", wrap(async (req, res) => {
      const b = req.body || {};
      const { row } = await mutate(req.params.id, who(req), (data, ctx) => {
        if (b.diff) ENG.applyDiff(data, b.diff);
        if (typeof b.name === "string" && b.name.trim()) ctx.name = b.name.trim();
      });
      res.json(fullOut(row));
    }));
    app.delete("/api/sheet/books/:id", wrap(async (req, res) => {
      await ensureSchema();
      await pool().query("UPDATE sheet_books SET deleted_at=now(), updated_by=$2 WHERE id=$1", [req.params.id, who(req)]);
      res.json({ ok: true });
    }));
  }

  // ═══════════════ MCP ツール ═══════════════
  // ファイルの指定は ID か名前 (完全一致 → 部分一致が 1 件だけなら採用)
  async function findBook(ref) {
    await ensureSchema();
    const t = String(ref || "").trim();
    if (!t) throw new Error("book (ファイルの ID か名前) を指定してください。sheet_list で一覧が見られます");
    const byId = await pool().query("SELECT * FROM sheet_books WHERE id=$1 AND deleted_at IS NULL", [t]);
    if (byId.rows[0]) return byId.rows[0];
    const { rows } = await pool().query("SELECT * FROM sheet_books WHERE deleted_at IS NULL AND (lower(name)=lower($1) OR name ILIKE '%' || $1 || '%') ORDER BY (lower(name)=lower($1)) DESC, updated_at DESC LIMIT 10", [t]);
    if (!rows.length) throw new Error(`「${t}」というファイルはありません。sheet_list で一覧を見るか、sheet_create で作ってください`);
    if (rows[0].name.toLowerCase() === t.toLowerCase() || rows.length === 1) return rows[0];
    throw new Error(`「${t}」に当てはまるファイルが複数あります: ${rows.map((r) => `${r.name} (${r.id})`).join(" / ")}。ID で指定してください`);
  }
  function pickSheet(data, ref) {
    if (ref === undefined || ref === null || ref === "") return data.sheets[0];
    const t = String(ref).trim();
    const s = data.sheets.find((x) => x.id === t) || data.sheets.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (!s) throw new Error(`シート「${t}」がありません。あるのは: ${data.sheets.map((x) => x.name).join(" / ")}`);
    return s;
  }
  // "シート2!A1:C3" のようにシート名込みで来ても受ける
  function splitRef(sheetArg, rangeArg) {
    const r = String(rangeArg || "").trim();
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(r);
    if (m) return { sheet: (m[1] ? m[1].replace(/''/g, "'") : m[2]).trim(), range: m[3] };
    return { sheet: sheetArg, range: r };
  }
  const jsonVal = (v) => (ENG.isErr(v) ? v.code : v);

  function readSheet(data, sh, rangeStr, { formulas = true, formatted = false } = {}) {
    const calc = ENG.createCalc(() => data.sheets);
    const rg = rangeStr ? ENG.parseRange(rangeStr, sh) : ENG.usedRange(sh);
    if (rangeStr && !rg) throw new Error(`範囲「${rangeStr}」が読めません (例: A1:D20, B:B, 3:5)`);
    if (!rg) return { sheet: sh.name, range: null, rows: [], note: "空のシートです" };
    let { c1, r1, c2, r2 } = rg;
    if (!rangeStr) { // 使っている範囲だけ
      const u = ENG.usedRange(sh); r2 = u.r2; c2 = u.c2;
    } else {
      const u = ENG.usedRange(sh, { valuesOnly: false });
      if (/^[A-Z$]+:[A-Z$]+$/i.test(rangeStr.trim())) r2 = Math.min(r2, u ? u.r2 : r1);
      if (/^\d+:\d+$/.test(rangeStr.trim())) c2 = Math.min(c2, u ? u.c2 : c1);
    }
    let truncated = false;
    const w = c2 - c1 + 1;
    if (w * (r2 - r1 + 1) > MAX_READ_CELLS) { r2 = r1 + Math.max(1, Math.floor(MAX_READ_CELLS / w)) - 1; truncated = true; }
    const rows = [], fx = {}, fmt = {};
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) {
        const k = ENG.key(c, r), cell = sh.cells[k], v = calc.value(sh, c, r);
        row.push(formatted && cell ? ENG.fmtValue(v, cell.s && cell.s.fmt) : jsonVal(v));
        if (formulas && cell && typeof cell.v === "string" && cell.v[0] === "=") fx[k] = cell.v;
        if (cell && cell.s && cell.s.fmt && !formatted) fmt[k] = cell.s.fmt;
      }
      rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every((v) => v === null || v === "")) rows.pop();
    return {
      sheet: sh.name, range: ENG.rangeName({ c1, r1, c2, r2 }),
      columns: Array.from({ length: w }, (_, i) => ENG.colName(c1 + i)), first_row: r1 + 1,
      rows, formulas: Object.keys(fx).length ? fx : undefined, formats: Object.keys(fmt).length ? fmt : undefined,
      truncated: truncated || undefined,
    };
  }
  const bookSummary = (row) => {
    const data = cleanData(row.data);
    return {
      id: row.id, name: row.name, url: bookUrl(row.id), updated_at: row.updated_at, updated_by: row.updated_by || undefined,
      sheets: data.sheets.map((s) => { const u = ENG.usedRange(s); return { name: s.name, used_range: u ? ENG.rangeName(u) : null }; }),
    };
  };
  const toRaw = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
  const parseAt = (s, what) => { const p = ENG.parseKey(String(s || "A1").replace(/\$/g, "")); if (!p) throw new Error(`${what}「${s}」が読めません (例: A1)`); return p; };

  const BOOK = { type: "string", description: "ファイルの ID か名前 (sheet_list で見られる)" };
  const SHEET = { type: "string", description: "シート (タブ) の名前。省略で最初のシート" };
  const VALUES = { type: "array", items: { type: "array", items: {} }, description: "2 次元配列 (行の配列)。= で始まる文字列は数式 (例 \"=SUM(B2:B10)\")。null や \"\" は空にする" };

  const tools = [
    {
      name: "sheet_list",
      description: "社内スプレッドシート (/sheet/ アプリ) のファイル一覧。各ファイルのシート名と使っている範囲も返す。Google スプレッドシートではなく自前のアプリの方",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { query: { type: "string", description: "名前の一部で絞る (省略で全部)" } } },
      handler: async (a) => {
        await ensureSchema();
        const q = String(a.query || "").trim();
        const { rows } = await pool().query(
          `SELECT * FROM sheet_books WHERE deleted_at IS NULL ${q ? "AND name ILIKE '%' || $1 || '%'" : ""} ORDER BY updated_at DESC LIMIT 100`, q ? [q] : []);
        return { count: rows.length, books: rows.map(bookSummary) };
      },
    },
    {
      name: "sheet_read",
      description: "シートの値を読む。数式は計算した結果を rows に、式そのものは formulas に返す。range 省略で使っている範囲全部",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          book: BOOK, sheet: SHEET,
          range: { type: "string", description: "A1:D20 / B:B / 3:5 など。'シート2!A1:B3' の形でも可。省略で使っている範囲" },
          formatted: { type: "boolean", description: "true で画面の表示どおりの文字列 (¥1,000 / 10% など)。既定は生の値" },
        },
        required: ["book"],
      },
      handler: async (a) => {
        const row = await findBook(a.book), data = cleanData(row.data);
        const { sheet, range } = splitRef(a.sheet, a.range);
        return { book: row.name, id: row.id, ...readSheet(data, pickSheet(data, sheet), range, { formatted: !!a.formatted }) };
      },
    },
    {
      name: "sheet_write",
      description: "セルに書き込む。start (左上) から values の 2 次元配列を並べる。開いている画面にも数秒で反映される。書いた範囲の計算結果を返す",
      inputSchema: {
        type: "object",
        properties: { book: BOOK, sheet: SHEET, start: { type: "string", description: "左上のセル (例 A1)。'シート2!B3' の形でも可。既定 A1" }, values: VALUES },
        required: ["book", "values"],
      },
      handler: async (a) => {
        if (!Array.isArray(a.values) || !a.values.length) throw new Error("values は 2 次元配列で");
        const ref = await findBook(a.book);
        const { sheet, range } = splitRef(a.sheet, a.start);
        const { row, result } = await mutate(ref.id, "AI", (data) => {
          const sh = pickSheet(data, sheet), at = parseAt(range || "A1", "start");
          const vals = a.values.map((r) => (Array.isArray(r) ? r : [r]));
          vals.forEach((r, i) => r.forEach((v, j) => ENG.setRaw(sh, at.c + j, at.r + i, toRaw(v))));
          const w = Math.max(...vals.map((r) => r.length));
          return { sheetId: sh.id, range: ENG.rangeName({ c1: at.c, r1: at.r, c2: at.c + w - 1, r2: at.r + vals.length - 1 }) };
        });
        const data = cleanData(row.data);
        return { ok: true, url: bookUrl(row.id), written: readSheet(data, data.sheets.find((s) => s.id === result.sheetId), result.range) };
      },
    },
    {
      name: "sheet_append_rows",
      description: "使っている範囲の一番下の次の行から rows を追記する (表に行を足すとき)",
      inputSchema: {
        type: "object",
        properties: { book: BOOK, sheet: SHEET, rows: VALUES, start_col: { type: "string", description: "書き始める列 (既定 A)" } },
        required: ["book", "rows"],
      },
      handler: async (a) => {
        if (!Array.isArray(a.rows) || !a.rows.length) throw new Error("rows は 2 次元配列で");
        const ref = await findBook(a.book);
        const { row, result } = await mutate(ref.id, "AI", (data) => {
          const sh = pickSheet(data, a.sheet), u = ENG.usedRange(sh);
          const r0 = u ? u.r2 + 1 : 0, c0 = a.start_col ? ENG.colIndex(String(a.start_col).replace(/[^A-Za-z]/g, "")) : 0;
          if (c0 < 0) throw new Error("start_col は A, B … の列名で");
          a.rows.forEach((r, i) => (Array.isArray(r) ? r : [r]).forEach((v, j) => ENG.setRaw(sh, c0 + j, r0 + i, toRaw(v))));
          const w = Math.max(...a.rows.map((r) => (Array.isArray(r) ? r.length : 1)));
          return { sheetId: sh.id, range: ENG.rangeName({ c1: c0, r1: r0, c2: c0 + w - 1, r2: r0 + a.rows.length - 1 }) };
        });
        const data = cleanData(row.data);
        return { ok: true, url: bookUrl(row.id), appended: readSheet(data, data.sheets.find((s) => s.id === result.sheetId), result.range) };
      },
    },
    {
      name: "sheet_clear",
      description: "範囲の値を消す (書式は残す)。with_format=true で書式も消す",
      inputSchema: { type: "object", properties: { book: BOOK, sheet: SHEET, range: { type: "string" }, with_format: { type: "boolean" } }, required: ["book", "range"] },
      handler: async (a) => {
        const ref = await findBook(a.book);
        const { sheet, range } = splitRef(a.sheet, a.range);
        let n = 0;
        await mutate(ref.id, "AI", (data) => {
          const sh = pickSheet(data, sheet), rg = ENG.parseRange(range, sh);
          if (!rg) throw new Error(`範囲「${range}」が読めません`);
          for (const k of Object.keys(sh.cells)) {
            const p = ENG.parseKey(k);
            if (p.c < rg.c1 || p.c > rg.c2 || p.r < rg.r1 || p.r > rg.r2) continue;
            if (a.with_format) delete sh.cells[k]; else ENG.setRaw(sh, p.c, p.r, "");
            n++;
          }
        });
        return { ok: true, cleared_cells: n };
      },
    },
    {
      name: "sheet_format",
      description: "範囲の見た目を変える。指定した項目だけ変わる (false / \"\" で解除)",
      inputSchema: {
        type: "object",
        properties: {
          book: BOOK, sheet: SHEET, range: { type: "string" },
          bold: { type: "boolean" }, italic: { type: "boolean" }, strike: { type: "boolean" },
          color: { type: "string", description: "文字色 #rrggbb" }, background: { type: "string", description: "塗りつぶし #rrggbb" },
          align: { type: "string", enum: ["", "left", "center", "right"] },
          number_format: { type: "string", enum: ENG.FORMATS.map((f) => f.id), description: "''=自動 / num=1,000.12 / num0=1,000 / dec2=小数2桁 / yen=¥1,000 / pct=10% / plain=そのまま" },
          column_width: { type: "number", description: "列幅 (px)。範囲の列すべてに" },
        },
        required: ["book", "range"],
      },
      handler: async (a) => {
        const ref = await findBook(a.book);
        const { sheet, range } = splitRef(a.sheet, a.range);
        const color = (x) => (x === "" ? "" : /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(x)) ? x : (() => { throw new Error(`色は #rrggbb で: ${x}`); })());
        const set = {};
        if (a.bold !== undefined) set.b = !!a.bold;
        if (a.italic !== undefined) set.i = !!a.italic;
        if (a.strike !== undefined) set.st = !!a.strike;
        if (a.color !== undefined) set.fc = color(a.color);
        if (a.background !== undefined) set.bg = color(a.background);
        if (a.align !== undefined) set.al = a.align;
        if (a.number_format !== undefined) set.fmt = a.number_format;
        await mutate(ref.id, "AI", (data) => {
          const sh = pickSheet(data, sheet), rg = ENG.parseRange(range, sh);
          if (!rg) throw new Error(`範囲「${range}」が読めません`);
          if (Object.keys(set).length) {
            const u = ENG.usedRange(sh, { valuesOnly: false });
            const r2 = /^[A-Z$]+:[A-Z$]+$/i.test(range.trim()) ? Math.min(rg.r2, Math.max(u ? u.r2 : 0, rg.r1)) : rg.r2; // 列まるごとは使っている行まで
            if ((rg.c2 - rg.c1 + 1) * (r2 - rg.r1 + 1) > 20000) throw new Error("範囲が広すぎます (2 万セルまで)");
            for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
              const k = ENG.key(c, r), cell = sh.cells[k] || {}, s = { ...(cell.s || {}), ...set };
              for (const p in s) if (s[p] === "" || s[p] === false || s[p] === undefined) delete s[p];
              if (Object.keys(s).length) cell.s = s; else delete cell.s;
              if (cell.v === undefined && !cell.s) delete sh.cells[k]; else sh.cells[k] = cell;
            }
          }
          if (a.column_width) for (let c = rg.c1; c <= rg.c2; c++) sh.colW[c] = Math.max(30, Math.min(800, Math.round(a.column_width)));
        });
        return { ok: true };
      },
    },
    {
      name: "sheet_rows_cols",
      description: "行・列の挿入/削除。数式の参照も自動でずれる (Google スプレッドシートと同じ)",
      inputSchema: {
        type: "object",
        properties: {
          book: BOOK, sheet: SHEET,
          op: { type: "string", enum: ["insert_rows", "delete_rows", "insert_cols", "delete_cols"] },
          at: { type: "string", description: "行は番号 (例 \"5\" = 5 行目の位置に挿入/5 行目から削除)、列は列名 (例 \"C\")" },
          count: { type: "number", description: "既定 1" },
        },
        required: ["book", "op", "at"],
      },
      handler: async (a) => {
        const ref = await findBook(a.book), n = Math.max(1, Math.min(1000, Math.round(a.count || 1)));
        const isRow = a.op.endsWith("rows");
        const at = isRow ? Number(a.at) - 1 : ENG.colIndex(String(a.at).replace(/[^A-Za-z]/g, ""));
        if (!(at >= 0)) throw new Error(isRow ? "at は 1 以上の行番号で" : "at は A, B … の列名で");
        await mutate(ref.id, "AI", (data) => { const sh = pickSheet(data, a.sheet); ENG[{ insert_rows: "insertRows", delete_rows: "deleteRows", insert_cols: "insertCols", delete_cols: "deleteCols" }[a.op]](data, sh, at, n); });
        return { ok: true };
      },
    },
    {
      name: "sheet_tab",
      description: "シート (タブ) の追加・名前変更・削除",
      inputSchema: {
        type: "object",
        properties: { book: BOOK, action: { type: "string", enum: ["add", "rename", "delete"] }, sheet: { type: "string", description: "対象のシート名 (add のときは新しい名前)" }, new_name: { type: "string", description: "rename の新しい名前" } },
        required: ["book", "action", "sheet"],
      },
      handler: async (a) => {
        const ref = await findBook(a.book);
        const name = String(a.sheet || "").trim();
        const { row } = await mutate(ref.id, "AI", (data) => {
          const exists = (n) => data.sheets.some((s) => s.name.toLowerCase() === n.toLowerCase());
          if (a.action === "add") { if (!name) throw new Error("sheet に名前を"); if (exists(name)) throw new Error(`「${name}」はもうあります`); data.sheets.push(ENG.newSheet(name)); }
          else if (a.action === "rename") { const nn = String(a.new_name || "").trim(); if (!nn) throw new Error("new_name を"); if (exists(nn)) throw new Error(`「${nn}」はもうあります`); ENG.renameSheet(data, pickSheet(data, name), nn); }
          else if (a.action === "delete") { if (data.sheets.length <= 1) throw new Error("最後のシートは消せません"); const sh = pickSheet(data, name); data.sheets.splice(data.sheets.indexOf(sh), 1); }
          else throw new Error("action は add / rename / delete");
        });
        return { ok: true, sheets: cleanData(row.data).sheets.map((s) => s.name) };
      },
    },
    {
      name: "sheet_create",
      description: "新しいスプレッドシートを作る。sheets で最初からシートと値を入れられる。返り値の url を人に渡せばそのまま開ける",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          sheets: { type: "array", description: "省略でシート1 だけ", items: { type: "object", properties: { name: { type: "string" }, values: VALUES }, required: ["name"] } },
        },
        required: ["name"],
      },
      handler: async (a) => {
        const sheets = (Array.isArray(a.sheets) && a.sheets.length ? a.sheets : [{ name: "シート1" }]).map((s) => {
          const sh = ENG.newSheet(String(s.name || "シート1"));
          (Array.isArray(s.values) ? s.values : []).forEach((r, i) => (Array.isArray(r) ? r : [r]).forEach((v, j) => ENG.setRaw(sh, j, i, toRaw(v))));
          return sh;
        });
        const row = await create({ name: a.name, data: { sheets }, by: "AI" });
        return { ok: true, ...bookSummary(row) };
      },
    },
    {
      name: "sheet_rename",
      description: "スプレッドシート (ファイル) の名前を変える",
      inputSchema: { type: "object", properties: { book: BOOK, new_name: { type: "string" } }, required: ["book", "new_name"] },
      handler: async (a) => {
        const ref = await findBook(a.book), nn = String(a.new_name || "").trim();
        if (!nn) throw new Error("new_name を");
        await mutate(ref.id, "AI", (data, ctx) => { ctx.name = nn; });
        return { ok: true, id: ref.id, name: nn };
      },
    },
  ];

  const instructions = [
    "sheet_*: 社内の自前スプレッドシート (/sheet/ アプリ、Google スプレッドシートとは別物)。人が画面で開いていても、書いた内容は数秒で画面に出る",
    "- まず sheet_list でファイルと各シートの使っている範囲を見る。ファイルは ID か名前で指定",
    "- 読むのは sheet_read (数式は計算結果を返す)。書くのは sheet_write / 表に行を足すなら sheet_append_rows",
    "- 合計などは値を計算して書くより数式で入れる (例 \"=SUM(C2:C20)\")。人が後で数字を直しても合計が追従する",
    "- 使える関数: " + ENG.FUNC_NAMES.join(", "),
    "- ファイルの削除は AI からはできない (画面から人がやる)",
  ].join("\n");

  return { tools, instructions, mountRoutes, ensureSchema };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
