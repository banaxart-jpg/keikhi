// スプレッドシート (/sheet/) の数式エンジン + データ操作。ブラウザとサーバーで同じものを使う。
// - サーバー: sheet-lib/index.js が import (MCP で AI が読むときの計算・行列の挿入削除)
// - ブラウザ: keihi-api の GET /sheet-engine.js でこのファイルをそのまま配信 → /sheet/ が import
// Node 専用の API は使わない (ブラウザでも動くこと)。
//
// データの形 (book.data): { sheets: [{ id, name, cells: { A1: { v: "入力そのまま", s: { b, i, st, fc, bg, al, fmt } } }, colW: { 0: 120 }, rows, cols }] }
// v は人が打った文字列そのまま ("=SUM(A1:A3)" / "1,500" / "¥300" / "ねじ")。値はここで計算する。

export const DEF_COLS = 26, DEF_ROWS = 100, DEF_W = 100;

// ── セル番地 ──
export const colName = (c) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
export const colIndex = (s) => { let n = 0; for (const ch of String(s).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
export const key = (c, r) => colName(c) + (r + 1);
export const parseKey = (k) => { const m = /^([A-Z]+)(\d+)$/.exec(String(k).toUpperCase()); return m ? { c: colIndex(m[1]), r: +m[2] - 1 } : null; };
// "A1:C5" / "A1" / "B:B" → { c1, r1, c2, r2 } (行・列の上限は sheet で丸める)
export function parseRange(a1, sheet) {
  const t = String(a1 || "").trim().toUpperCase().replace(/\$/g, "");
  let m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(t);
  if (m) {
    const A = { c: colIndex(m[1]), r: +m[2] - 1 }, B = m[3] ? { c: colIndex(m[3]), r: +m[4] - 1 } : A;
    return { c1: Math.min(A.c, B.c), r1: Math.min(A.r, B.r), c2: Math.max(A.c, B.c), r2: Math.max(A.r, B.r) };
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) { const a = colIndex(m[1]), b = colIndex(m[2]); return { c1: Math.min(a, b), r1: 0, c2: Math.max(a, b), r2: Math.max(0, (sheet?.rows || DEF_ROWS) - 1) }; }
  m = /^(\d+):(\d+)$/.exec(t);
  if (m) { const a = +m[1] - 1, b = +m[2] - 1; return { c1: 0, r1: Math.min(a, b), c2: Math.max(0, (sheet?.cols || DEF_COLS) - 1), r2: Math.max(a, b) }; }
  return null;
}
export const rangeName = ({ c1, r1, c2, r2 }) => (c1 === c2 && r1 === r2 ? key(c1, r1) : `${key(c1, r1)}:${key(c2, r2)}`);

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clone = (o) => JSON.parse(JSON.stringify(o));
export function newSheet(name, id = uid()) { return { id, name, cells: {}, colW: {}, rows: DEF_ROWS, cols: DEF_COLS }; }

// ── エラー値 ──
export class FErr { constructor(code) { this.code = code; } toString() { return this.code; } toJSON() { return this.code; } }
export const E = { DIV0: new FErr("#DIV/0!"), VALUE: new FErr("#VALUE!"), REF: new FErr("#REF!"), NAME: new FErr("#NAME?"), NA: new FErr("#N/A"), ERR: new FErr("#ERROR!"), NUM: new FErr("#NUM!") };
export const isErr = (v) => v instanceof FErr;

// 入力文字列 → 値 (数式以外)。fmt は「1,500 と打ったら数値表示」みたいな自動書式
export function parseLiteral(raw) {
  if (raw === "" || raw == null) return { v: null };
  const t = String(raw).trim();
  if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t) };
  let m;
  if ((m = /^([-+]?)[¥￥]\s?([\d,]*\.?\d+)$/.exec(t))) return { v: +(m[1] + m[2].replace(/,/g, "")), fmt: "yen" };
  if ((m = /^([-+]?[\d,]*\.?\d+)\s?%$/.exec(t))) return { v: +m[1].replace(/,/g, "") / 100, fmt: "pct" };
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { v: +t.replace(/,/g, ""), fmt: "num" };
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return { v: +t };
  return { v: String(raw) };
}

// ═══════════════════ 数式 ═══════════════════
const SHEET_PREFIX = String.raw`('(?:[^']|'')+'|[^\s!'"(),+\-*/&=<>^:;%{}]+)!`;
function tokenize(src) {
  const toks = []; let i = 0;
  const refRe = new RegExp(`^(?:${SHEET_PREFIX})?(\\$?[A-Za-z]{1,3}\\$?\\d+)(?::(\\$?[A-Za-z]{1,3}\\$?\\d+))?`);
  const colRangeRe = new RegExp(`^(?:${SHEET_PREFIX})?\\$?([A-Za-z]{1,3}):\\$?([A-Za-z]{1,3})(?![\\w(])`);
  const unq = (s) => (s ? s.replace(/^'|'$/g, "").replace(/''/g, "'") : null);
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    if (/^#REF!/i.test(rest)) throw E.REF;
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < src.length) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += src[j++]; }
      if (j >= src.length) throw E.ERR;
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    let m;
    if ((m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(rest))) { toks.push({ t: "num", v: +m[0] }); i += m[0].length; continue; }
    if ((m = colRangeRe.exec(rest))) { toks.push({ t: "colrange", sheet: unq(m[1]), a: m[2].toUpperCase(), b: m[3].toUpperCase() }); i += m[0].length; continue; }
    if ((m = refRe.exec(rest)) && !/^[\w(]/.test(rest.slice(m[0].length))) {
      toks.push({ t: "ref", sheet: unq(m[1]), a: m[2].replace(/\$/g, "").toUpperCase(), b: m[3] ? m[3].replace(/\$/g, "").toUpperCase() : null });
      i += m[0].length; continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) { toks.push({ t: "id", v: m[0].toUpperCase() }); i += m[0].length; continue; }
    if ((m = /^(<=|>=|<>|[-+*/^&=<>(),:;%])/.exec(rest))) { toks.push({ t: "op", v: m[0] === ";" ? "," : m[0] }); i += m[0].length; continue; }
    throw E.ERR;
  }
  return toks;
}

// 再帰下降パーサ + 評価器。ctx = { ref(tok), colrange(tok) }
function evaluate(src, ctx) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
  const eat = (v) => { if (!isOp(v)) throw E.ERR; p++; };
  const h = { num, str, scalar };

  function num(v) {
    if (isErr(v)) throw v;
    if (v && v.range) { if (v.range.length === 1 && v.range[0].length === 1) return num(v.range[0][0]); throw E.VALUE; }
    if (v == null || v === "") return 0;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    const lit = parseLiteral(String(v)); if (typeof lit.v === "number") return lit.v;
    throw E.VALUE;
  }
  function str(v) {
    if (isErr(v)) throw v;
    if (v && v.range) { if (v.range.length === 1 && v.range[0].length === 1) return str(v.range[0][0]); throw E.VALUE; }
    if (v == null) return "";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") return fmtAuto(v);
    return String(v);
  }
  function scalar(v) { if (v && v.range) { if (v.range.length === 1 && v.range[0].length === 1) return v.range[0][0]; throw E.VALUE; } return v; }

  function expr() { return compare(); }
  function compare() {
    let l = concat();
    while (peek() && peek().t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v)) { const op = toks[p++].v; const r = concat(); l = cmp(scalar(l), scalar(r), op); }
    return l;
  }
  function concat() { let l = add(); while (isOp("&")) { p++; const r = add(); l = str(l) + str(r); } return l; }
  function add() { let l = mul(); while (isOp("+") || isOp("-")) { const op = toks[p++].v; const r = mul(); l = op === "+" ? num(l) + num(r) : num(l) - num(r); } return l; }
  function mul() {
    let l = pow();
    while (isOp("*") || isOp("/")) { const op = toks[p++].v; const r = pow(); if (op === "*") l = num(l) * num(r); else { const d = num(r); if (d === 0) throw E.DIV0; l = num(l) / d; } }
    return l;
  }
  function pow() { let l = unary(); while (isOp("^")) { p++; const r = unary(); l = Math.pow(num(l), num(r)); } return l; }
  function unary() { if (isOp("-")) { p++; return -num(unary()); } if (isOp("+")) { p++; return num(unary()); } return postfix(); }
  function postfix() { let v = primary(); while (isOp("%")) { p++; v = num(v) / 100; } return v; }
  function primary() {
    const t = toks[p++];
    if (!t) throw E.ERR;
    if (t.t === "num" || t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") { const v = expr(); eat(")"); return v; }
    if (t.t === "ref") return ctx.ref(t);
    if (t.t === "colrange") return ctx.colrange(t);
    if (t.t === "id") {
      if (isOp("(")) {
        p++; const args = [];
        if (!isOp(")")) {
          do { if (isOp(",") || isOp(")")) args.push(undefined); else args.push(lazyArg()); } while (isOp(",") && ++p);
        }
        eat(")");
        const fn = FUNCS[t.v];
        if (!fn) throw E.NAME;
        return fn(args, h);
      }
      if (t.v === "TRUE") return true;
      if (t.v === "FALSE") return false;
      throw E.NAME;
    }
    throw E.ERR;
  }
  // IF / IFERROR 用: 引数のエラーは投げずに包んでおき、使われたときだけ投げる
  function lazyArg() {
    try { return { ok: expr() }; }
    catch (e) {
      if (!isErr(e)) throw e;
      let depth = 0; // 残りのトークンを括弧の深さで読み飛ばす
      while (p < toks.length) {
        const t = toks[p];
        if (t.t === "op" && t.v === "(") depth++;
        else if (t.t === "op" && t.v === ")") { if (depth === 0) break; depth--; }
        else if (t.t === "op" && t.v === "," && depth === 0) break;
        p++;
      }
      return { err: e };
    }
  }
  const v = expr();
  if (p < toks.length) throw E.ERR;
  return v;
}

export function cmp(a, b, op) {
  if (isErr(a)) throw a; if (isErr(b)) throw b;
  const norm = (x) => (x == null ? "" : x);
  a = norm(a); b = norm(b);
  let r;
  if (typeof a === "number" && typeof b === "number") r = a - b;
  else if (typeof a === "boolean" || typeof b === "boolean") { const x = typeof a === "boolean" ? 2 : typeof a === "string" ? 1 : 0, y = typeof b === "boolean" ? 2 : typeof b === "string" ? 1 : 0; r = x === y ? (a === b ? 0 : a ? 1 : -1) : x - y; }
  else if (typeof a === "string" && typeof b === "string") { const x = a.toLowerCase(), y = b.toLowerCase(); r = x < y ? -1 : x > y ? 1 : 0; }
  else if (a === "" || b === "") { r = a === "" ? (b === "" || b === 0 ? 0 : -1) : (a === 0 ? 0 : 1); }
  else r = typeof a === "number" ? -1 : 1;
  return { "=": r === 0, "<>": r !== 0, "<": r < 0, ">": r > 0, "<=": r <= 0, ">=": r >= 0 }[op];
}

// ── 関数 ──
function argVal(a) { if (a === undefined) return undefined; if (a.err) throw a.err; return a.ok; }
function flat(args) { // 範囲を展開した値の配列 (範囲内の空白・文字列も含む)
  const out = [];
  for (const a of args) {
    const v = argVal(a);
    if (v && v.range) { for (const row of v.range) for (const x of row) out.push({ v: x, fromRange: true }); }
    else out.push({ v, fromRange: false });
  }
  return out;
}
function nums(args, h) { // 数値だけ (範囲内の文字列・空白は無視、直接指定は数値化)
  const out = [];
  for (const { v, fromRange } of flat(args)) {
    if (isErr(v)) throw v;
    if (fromRange) { if (typeof v === "number") out.push(v); }
    else if (v !== undefined) out.push(h.num(v));
  }
  return out;
}
function makeCrit(c) {
  if (isErr(c)) throw c;
  if (typeof c === "number" || typeof c === "boolean") return (v) => v === c;
  const m = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(String(c ?? ""));
  const op = m[1] || "=", rhsRaw = m[2];
  const rhs = rhsRaw === "" ? "" : parseLiteral(rhsRaw).v;
  if (typeof rhs === "string" && (op === "=" || op === "<>") && /[*?]/.test(rhs)) {
    const re = new RegExp("^" + rhs.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return (v) => (op === "=") === re.test(v == null ? "" : String(v));
  }
  return (v) => {
    if (isErr(v)) return false;
    if (typeof rhs === "number" && typeof v !== "number") return op === "<>";
    return cmp(v, rhs, op);
  };
}
function rangeArg(a) { const v = argVal(a); if (v && v.range) return v.range; return [[v]]; }
function roundTo(x, d, mode) { const f = Math.pow(10, d); const y = x * f; const r = mode === "up" ? Math.sign(y) * Math.ceil(Math.abs(y) - 1e-9) : mode === "down" ? Math.trunc(y) : Math.sign(y) * Math.round(Math.abs(y) + 1e-9); return r / f; }
const jstNow = () => new Date(Date.now() + (9 * 60 + new Date().getTimezoneOffset()) * 60000);

export const FUNCS = {
  SUM: (a, h) => nums(a, h).reduce((s, x) => s + x, 0),
  AVERAGE: (a, h) => { const n = nums(a, h); if (!n.length) throw E.DIV0; return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a, h) => { const n = nums(a, h); return n.length ? Math.min(...n) : 0; },
  MAX: (a, h) => { const n = nums(a, h); return n.length ? Math.max(...n) : 0; },
  PRODUCT: (a, h) => nums(a, h).reduce((s, x) => s * x, 1),
  COUNT: (a) => flat(a).filter(({ v, fromRange }) => typeof v === "number" || (!fromRange && v !== undefined && typeof parseLiteral(String(v)).v === "number")).length,
  COUNTA: (a) => flat(a).filter(({ v }) => v !== null && v !== undefined && v !== "").length,
  COUNTBLANK: (a) => flat(a).filter(({ v }) => v === null || v === "").length,
  IF: (a, h) => { const c = h.scalar(argVal(a[0])); if (typeof c === "string") throw E.VALUE; return h.num(c) ? (a[1] === undefined ? true : argVal(a[1])) : (a[2] === undefined ? false : argVal(a[2])); },
  IFERROR: (a) => { if (a[0] && a[0].err) return a[1] === undefined ? "" : argVal(a[1]); const v = argVal(a[0]); if (isErr(v)) return argVal(a[1]); return v; },
  IFS: (a, h) => { for (let i = 0; i + 1 < a.length; i += 2) if (h.num(h.scalar(argVal(a[i])))) return argVal(a[i + 1]); throw E.NA; },
  AND: (a, h) => flat(a).every(({ v }) => (v == null || v === "" ? true : !!h.num(v))),
  OR: (a, h) => flat(a).some(({ v }) => (v == null || v === "" ? false : !!h.num(v))),
  NOT: (a, h) => !h.num(h.scalar(argVal(a[0]))),
  ROUND: (a, h) => roundTo(h.num(argVal(a[0])), a[1] ? h.num(argVal(a[1])) : 0),
  ROUNDUP: (a, h) => roundTo(h.num(argVal(a[0])), a[1] ? h.num(argVal(a[1])) : 0, "up"),
  ROUNDDOWN: (a, h) => roundTo(h.num(argVal(a[0])), a[1] ? h.num(argVal(a[1])) : 0, "down"),
  INT: (a, h) => Math.floor(h.num(argVal(a[0]))),
  ABS: (a, h) => Math.abs(h.num(argVal(a[0]))),
  MOD: (a, h) => { const x = h.num(argVal(a[0])), y = h.num(argVal(a[1])); if (y === 0) throw E.DIV0; return x - y * Math.floor(x / y); },
  SQRT: (a, h) => { const x = h.num(argVal(a[0])); if (x < 0) throw E.NUM; return Math.sqrt(x); },
  POWER: (a, h) => Math.pow(h.num(argVal(a[0])), h.num(argVal(a[1]))),
  CONCATENATE: (a, h) => flat(a).map(({ v }) => h.str(v)).join(""),
  CONCAT: (a, h) => flat(a).map(({ v }) => h.str(v)).join(""),
  TEXTJOIN: (a, h) => { const d = h.str(argVal(a[0])), skip = !!h.num(argVal(a[1])); return flat(a.slice(2)).map(({ v }) => h.str(v)).filter((s) => !(skip && s === "")).join(d); },
  LEN: (a, h) => h.str(argVal(a[0])).length,
  UPPER: (a, h) => h.str(argVal(a[0])).toUpperCase(),
  LOWER: (a, h) => h.str(argVal(a[0])).toLowerCase(),
  TRIM: (a, h) => h.str(argVal(a[0])).trim().replace(/\s+/g, " "),
  LEFT: (a, h) => h.str(argVal(a[0])).slice(0, a[1] ? h.num(argVal(a[1])) : 1),
  RIGHT: (a, h) => { const s = h.str(argVal(a[0])), n = a[1] ? h.num(argVal(a[1])) : 1; return n ? s.slice(-n) : ""; },
  MID: (a, h) => { const s = h.str(argVal(a[0])), st = h.num(argVal(a[1])), n = h.num(argVal(a[2])); return s.substr(st - 1, n); },
  SUBSTITUTE: (a, h) => h.str(argVal(a[0])).split(h.str(argVal(a[1]))).join(h.str(argVal(a[2]))),
  TODAY: () => { const d = jstNow(); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; },
  NOW: () => { const d = jstNow(); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; },
  SUMIF: (a) => { const r = rangeArg(a[0]), f = makeCrit(argVal(a[1])), s = a[2] ? rangeArg(a[2]) : r; let t = 0; r.forEach((row, i) => row.forEach((v, j) => { if (f(v)) { const x = s[i] && s[i][j]; if (typeof x === "number") t += x; } })); return t; },
  COUNTIF: (a) => { const r = rangeArg(a[0]), f = makeCrit(argVal(a[1])); let n = 0; r.forEach((row) => row.forEach((v) => { if (f(v)) n++; })); return n; },
  AVERAGEIF: (a) => { const r = rangeArg(a[0]), f = makeCrit(argVal(a[1])), s = a[2] ? rangeArg(a[2]) : r; let t = 0, n = 0; r.forEach((row, i) => row.forEach((v, j) => { if (f(v)) { const x = s[i] && s[i][j]; if (typeof x === "number") { t += x; n++; } } })); if (!n) throw E.DIV0; return t / n; },
  SUMIFS: (a) => { const s = rangeArg(a[0]); const cs = []; for (let i = 1; i + 1 < a.length; i += 2) cs.push([rangeArg(a[i]), makeCrit(argVal(a[i + 1]))]); let t = 0; s.forEach((row, i) => row.forEach((x, j) => { if (typeof x === "number" && cs.every(([r, f]) => f(r[i] && r[i][j]))) t += x; })); return t; },
  COUNTIFS: (a) => { const cs = []; for (let i = 0; i + 1 < a.length; i += 2) cs.push([rangeArg(a[i]), makeCrit(argVal(a[i + 1]))]); if (!cs.length) return 0; let n = 0; cs[0][0].forEach((row, i) => row.forEach((_, j) => { if (cs.every(([r, f]) => f(r[i] && r[i][j]))) n++; })); return n; },
  VLOOKUP: (a, h) => {
    const k = h.scalar(argVal(a[0])), r = rangeArg(a[1]), ci = h.num(argVal(a[2])), approx = a[3] === undefined ? true : !!h.num(argVal(a[3]));
    if (ci < 1 || ci > (r[0] || []).length) throw E.REF;
    if (!approx) { for (const row of r) if (cmp(row[0], k, "=")) return row[ci - 1]; throw E.NA; }
    let hit = null; for (const row of r) { if (row[0] == null) continue; if (cmp(row[0], k, "<=")) hit = row; else break; }
    if (!hit) throw E.NA; return hit[ci - 1];
  },
  HLOOKUP: (a, h) => {
    const k = h.scalar(argVal(a[0])), r = rangeArg(a[1]), ri = h.num(argVal(a[2])), approx = a[3] === undefined ? true : !!h.num(argVal(a[3]));
    if (ri < 1 || ri > r.length) throw E.REF;
    const head = r[0];
    if (!approx) { const j = head.findIndex((v) => cmp(v, k, "=")); if (j < 0) throw E.NA; return r[ri - 1][j]; }
    let hit = -1; head.forEach((v, j) => { if (v != null && cmp(v, k, "<=")) hit = j; }); if (hit < 0) throw E.NA; return r[ri - 1][hit];
  },
  INDEX: (a, h) => { const r = rangeArg(a[0]); let i = h.num(argVal(a[1])), j = a[2] ? h.num(argVal(a[2])) : 1; if (r.length === 1 && a[2] === undefined) { j = i; i = 1; } const row = r[i - 1]; if (!row || j < 1 || j > row.length) throw E.REF; return row[j - 1]; },
  MATCH: (a, h) => { const k = h.scalar(argVal(a[0])), r = rangeArg(a[1]).flat(), t = a[2] === undefined ? 1 : h.num(argVal(a[2])); if (t === 0) { const i = r.findIndex((v) => cmp(v, k, "=")); if (i < 0) throw E.NA; return i + 1; } let hit = -1; r.forEach((v, i) => { if (v != null && cmp(v, k, t > 0 ? "<=" : ">=")) hit = i; }); if (hit < 0) throw E.NA; return hit + 1; },
  ISBLANK: (a, h) => { const v = h.scalar(argVal(a[0])); return v == null || v === ""; },
  ISNUMBER: (a, h) => typeof h.scalar(argVal(a[0])) === "number",
  ISTEXT: (a, h) => typeof h.scalar(argVal(a[0])) === "string",
  ISERROR: (a) => !!(a[0] && a[0].err) || isErr(a[0] && a[0].ok),
  RAND: () => Math.random(),
  RANDBETWEEN: (a, h) => { const lo = Math.ceil(h.num(argVal(a[0]))), hi = Math.floor(h.num(argVal(a[1]))); return lo + Math.floor(Math.random() * (hi - lo + 1)); },
  PI: () => Math.PI,
  VALUE: (a, h) => h.num(h.str(argVal(a[0]))),
  N: (a, h) => { const v = h.scalar(argVal(a[0])); return typeof v === "number" ? v : typeof v === "boolean" ? +v : 0; },
};
export const FUNC_NAMES = Object.keys(FUNCS).sort();

// ── 計算 (シート単位のキャッシュ。循環参照は #REF!) ──
// getSheets: () => sheets 配列 (別シート参照の名前解決に使う)
export function createCalc(getSheets) {
  let cache = new Map(); // sheetId -> Map(key -> value)
  const stack = new Set();
  const findSheet = (name) => getSheets().find((s) => s.name.toLowerCase() === String(name).toLowerCase());

  function value(sh, c, r) {
    if (c < 0 || r < 0) throw E.REF;
    let m = cache.get(sh.id); if (!m) { m = new Map(); cache.set(sh.id, m); }
    const k = key(c, r);
    if (m.has(k)) return m.get(k);
    const cell = sh.cells[k];
    let v = null;
    if (cell && cell.v !== undefined && cell.v !== "") {
      if (typeof cell.v === "string" && cell.v[0] === "=" && cell.v.length > 1) {
        const sk = sh.id + ":" + k;
        if (stack.has(sk)) return E.REF;
        stack.add(sk);
        try {
          v = evaluate(cell.v.slice(1), ctxFor(sh));
          if (v && v.range) v = v.range.length === 1 && v.range[0].length === 1 ? v.range[0][0] : E.VALUE;
          if (v === undefined) v = null;
          if (typeof v === "number" && !isFinite(v)) v = E.NUM;
        } catch (e) { v = isErr(e) ? e : E.ERR; }
        stack.delete(sk);
      } else v = parseLiteral(cell.v).v;
    }
    m.set(k, v);
    return v;
  }
  function ctxFor(sh) {
    const resolve = (name) => { if (!name) return sh; const s = findSheet(name); if (!s) throw E.REF; return s; };
    return {
      ref(t) {
        const s = resolve(t.sheet);
        const A = parseKey(t.a); if (!A) throw E.REF;
        if (!t.b) return value(s, A.c, A.r);
        const B = parseKey(t.b); if (!B) throw E.REF;
        return rangeOf(s, Math.min(A.c, B.c), Math.min(A.r, B.r), Math.max(A.c, B.c), Math.max(A.r, B.r));
      },
      colrange(t) { const s = resolve(t.sheet); const a = colIndex(t.a), b = colIndex(t.b); return rangeOf(s, Math.min(a, b), 0, Math.max(a, b), s.rows - 1); },
    };
  }
  function rangeOf(s, c1, r1, c2, r2) {
    if ((c2 - c1 + 1) * (r2 - r1 + 1) > 200000) throw E.REF;
    const out = [];
    for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(value(s, c, r)); out.push(row); }
    return { range: out };
  }
  return { value, findSheet, invalidate() { cache = new Map(); } };
}

// ── 数式内の参照を書き換える (コピー/オートフィル/行列の挿入削除) ──
// fn(sheetName|null, col, row, absC, absR) -> {c, r} | null(=#REF!)
export function rewriteRefs(formula, fn) {
  if (typeof formula !== "string" || formula[0] !== "=") return formula;
  const parts = formula.split(/("(?:[^"]|"")*")/);
  const re = /(^|[^A-Za-z0-9_.$'!])((?:'(?:[^']|'')+'|[A-Za-z0-9_぀-ヿ㐀-鿿＀-￯]+)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g;
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(re, (all, pre, sp, ac, col, ar, row) => {
      const sname = sp ? sp.slice(0, -1).replace(/^'|'$/g, "").replace(/''/g, "'") : null;
      const res = fn(sname, colIndex(col), +row - 1, !!ac, !!ar);
      if (!res || res.c < 0 || res.r < 0) return pre + "#REF!";
      return pre + (sp || "") + ac + colName(res.c) + ar + (res.r + 1);
    });
  }).join("");
}
export const shiftFormula = (f, dc, dr) => rewriteRefs(f, (s, c, r, ac, ar) => ({ c: ac ? c : c + dc, r: ar ? r : r + dr }));

export function renameSheetInFormula(f, oldN, newN) {
  const q = (n) => (/^[A-Za-z0-9_぀-ヿ㐀-鿿＀-￯]+$/.test(n) ? n : "'" + n.replace(/'/g, "''") + "'");
  const parts = f.split(/("(?:[^"]|"")*")/);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(^|[^A-Za-z0-9_.$'!])(?:'" + reEsc(oldN.replace(/'/g, "''")) + "'|" + reEsc(oldN) + ")!", "gi");
  return parts.map((p, i) => (i % 2 ? p : p.replace(re, (all, pre) => pre + q(newN) + "!"))).join("");
}

// ═══════════════════ 表示形式 ═══════════════════
export function fmtAuto(v) { return Number.isInteger(v) ? String(v) : String(+v.toPrecision(12)); }
export function fmtValue(v, fmt) {
  if (v == null) return "";
  if (isErr(v)) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    switch (fmt) {
      case "num": return v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
      case "num0": return Math.round(v).toLocaleString("ja-JP");
      case "dec2": return v.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case "yen": return (v < 0 ? "-¥" : "¥") + Math.abs(Math.round(v)).toLocaleString("ja-JP");
      case "pct": return (v * 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 }) + "%";
      default: return fmtAuto(v);
    }
  }
  return String(v);
}
export const FORMATS = [
  { id: "", name: "自動", ex: "1000.12" },
  { id: "plain", name: "書式なしテキスト", ex: "1000.12" },
  { id: "num", name: "数値", ex: "1,000.12" },
  { id: "num0", name: "数値 (整数)", ex: "1,000" },
  { id: "dec2", name: "小数 2 桁", ex: "1,000.12" },
  { id: "yen", name: "通貨 (円)", ex: "¥1,000" },
  { id: "pct", name: "パーセント", ex: "10.12%" },
];

// ═══════════════════ セル・行列の操作 (data = { sheets }) ═══════════════════
// セルに入力を書く (書式は残す。1,500 / ¥300 / 10% は自動で表示形式も付ける)
export function setRaw(sh, c, r, raw) {
  const k = key(c, r);
  const cell = sh.cells[k] || {};
  if (raw === "" || raw == null) delete cell.v;
  else {
    cell.v = typeof raw === "string" ? raw : String(raw);
    if (cell.v[0] !== "=") {
      const lit = parseLiteral(cell.v);
      if (lit.fmt && !(cell.s && cell.s.fmt)) { cell.s = cell.s || {}; cell.s.fmt = lit.fmt; }
    }
  }
  if (cell.v === undefined && (!cell.s || !Object.keys(cell.s).length)) delete sh.cells[k];
  else sh.cells[k] = cell;
  if (r + 1 > sh.rows) sh.rows = r + 1;
  if (c + 1 > sh.cols) sh.cols = c + 1;
}

function remapSheet(sh, mapCell) {
  const out = {};
  for (const k in sh.cells) { const p = parseKey(k); const n = mapCell(p.c, p.r); if (n) out[key(n.c, n.r)] = sh.cells[k]; }
  sh.cells = out;
}
function fixAllFormulas(data, target, mapRef) {
  const find = (name) => data.sheets.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  for (const s of data.sheets) for (const k in s.cells) {
    const cell = s.cells[k];
    if (typeof cell.v === "string" && cell.v[0] === "=") {
      cell.v = rewriteRefs(cell.v, (sname, c, r) => ((sname ? find(sname) : s) !== target ? { c, r } : mapRef(c, r)));
    }
  }
}
// 行・列の挿入/削除。at は 0 始まり。数式の参照も (他シートからの参照も) ずらす。消えた所への参照は #REF!
export function insertRows(data, sh, at, n) {
  const m = (c, r) => ({ c, r: r >= at ? r + n : r });
  fixAllFormulas(data, sh, m); remapSheet(sh, m); sh.rows += n;
}
export function deleteRows(data, sh, at, n) {
  const m = (c, r) => (r >= at && r < at + n ? null : { c, r: r >= at + n ? r - n : r });
  fixAllFormulas(data, sh, m); remapSheet(sh, m); sh.rows = Math.max(1, sh.rows - n);
}
export function insertCols(data, sh, at, n) {
  const m = (c, r) => ({ c: c >= at ? c + n : c, r });
  fixAllFormulas(data, sh, m); remapSheet(sh, m);
  const w = {}; for (const c in sh.colW) w[+c >= at ? +c + n : c] = sh.colW[c]; sh.colW = w;
  sh.cols += n;
}
export function deleteCols(data, sh, at, n) {
  const m = (c, r) => (c >= at && c < at + n ? null : { c: c >= at + n ? c - n : c, r });
  fixAllFormulas(data, sh, m); remapSheet(sh, m);
  const w = {}; for (const c in sh.colW) { if (+c >= at && +c < at + n) continue; w[+c >= at + n ? +c - n : c] = sh.colW[c]; } sh.colW = w;
  sh.cols = Math.max(1, sh.cols - n);
}
// シート名の変更 (他シートの数式内の名前も置き換え)
export function renameSheet(data, sh, newName) {
  const old = sh.name;
  for (const s of data.sheets) for (const k in s.cells) { const c = s.cells[k]; if (typeof c.v === "string" && c.v[0] === "=") c.v = renameSheetInFormula(c.v, old, newName); }
  sh.name = newName;
}
// 中身が入っている範囲 (値 or 書式)。空なら null
export function usedRange(sh, { valuesOnly = true } = {}) {
  let c2 = -1, r2 = -1;
  for (const k in sh.cells) { if (valuesOnly && (sh.cells[k].v === undefined || sh.cells[k].v === "")) continue; const p = parseKey(k); if (p.c > c2) c2 = p.c; if (p.r > r2) r2 = p.r; }
  return r2 < 0 ? null : { c1: 0, r1: 0, c2, r2 };
}

// ═══════════════════ 差分 (同時編集用) ═══════════════════
// 画面は「最後にサーバーから貰った状態 (base)」との差分だけを送り、サーバーは今の状態に重ねる。
// だから AI (MCP) と人が同時に別のセルを触っても消し合わない。同じセルは後から届いた方が勝つ。
// diff = { order?: [sheetId], sheets?: { [sheetId]: null(削除) | { name?, rows?, cols?, colW?, cells?: { A1: cell | null } } } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diffBook(base, local) {
  const out = { sheets: {} }; let any = false;
  const bm = new Map((base.sheets || []).map((s) => [s.id, s]));
  for (const s of local.sheets || []) {
    const b = bm.get(s.id);
    if (!b) { out.sheets[s.id] = { name: s.name, rows: s.rows, cols: s.cols, colW: s.colW, cells: s.cells }; any = true; continue; }
    const d = {};
    for (const f of ["name", "rows", "cols"]) if (s[f] !== b[f]) d[f] = s[f];
    if (!same(s.colW || {}, b.colW || {})) d.colW = s.colW || {};
    const cells = {}; let cn = 0;
    for (const k in s.cells) if (!same(s.cells[k], b.cells[k])) { cells[k] = s.cells[k]; cn++; }
    for (const k in b.cells) if (!(k in s.cells)) { cells[k] = null; cn++; }
    if (cn) d.cells = cells;
    if (Object.keys(d).length) { out.sheets[s.id] = d; any = true; }
  }
  const lids = new Set((local.sheets || []).map((s) => s.id));
  for (const s of base.sheets || []) if (!lids.has(s.id)) { out.sheets[s.id] = null; any = true; }
  const lo = (local.sheets || []).map((s) => s.id), bo = (base.sheets || []).map((s) => s.id).filter((id) => lids.has(id));
  if (!same(lo.filter((id) => bm.has(id)), bo) || lo.some((id) => !bm.has(id))) { out.order = lo; any = true; }
  return any ? out : null;
}
// data に diff を重ねる (data を書き換えて返す)
export function applyDiff(data, diff) {
  if (!diff) return data;
  data.sheets = data.sheets || [];
  for (const [id, sd] of Object.entries(diff.sheets || {})) {
    const i = data.sheets.findIndex((s) => s.id === id);
    if (sd === null) { if (i >= 0 && data.sheets.length > 1) data.sheets.splice(i, 1); continue; }
    let sh = data.sheets[i];
    if (!sh) { sh = newSheet(sd.name || "シート", id); data.sheets.push(sh); }
    if (typeof sd.name === "string" && sd.name) sh.name = sd.name;
    if (Number.isFinite(sd.rows) && sd.rows > 0) sh.rows = Math.min(sd.rows, 20000);
    if (Number.isFinite(sd.cols) && sd.cols > 0) sh.cols = Math.min(sd.cols, 702);
    if (sd.colW && typeof sd.colW === "object") sh.colW = sd.colW;
    for (const [k, cell] of Object.entries(sd.cells || {})) {
      if (!parseKey(k)) continue;
      if (cell === null) delete sh.cells[k]; else sh.cells[k] = cell;
    }
  }
  if (Array.isArray(diff.order)) {
    const pos = new Map(diff.order.map((id, i) => [id, i]));
    data.sheets.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
  }
  return data;
}
