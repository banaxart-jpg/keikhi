import zlib from "node:zlib";

// 青空文庫の XHTML から本文テキストを取り込む。
// - Shift_JIS デコード (青空文庫の HTML はほぼ全部 Shift_JIS)
// - ルビ (<rt>/<rp>) と注記タグを除去して素のテキストに
// - 「行全体が漢数字だけ」の行を章見出しとして分割 (一/二/…/三十二)
//   見出しが無い作品は 1 章 (全文) として返す

const KANJI_CHAPTER_RE = /^[　\s]*[一二三四五六七八九十百]+[　\s]*$/;
// 「はしがき」「第一の手記」「あとがき」型の見出し (人間失格などで使われる)
const HEADING_CHAPTER_RE = /^[　\s]*(はしがき|まえがき|序章|序|プロローグ|エピローグ|あとがき|終章|第[一二三四五六七八九十百]+の?(手記|章|話|部|篇|編)?)[　\s]*$/;

function isChapterMarker(line) {
  const t = line.trim();
  if (!t || t.length > 12) return false;
  return KANJI_CHAPTER_RE.test(line) || HEADING_CHAPTER_RE.test(line);
}

// ── 作品カタログ検索 ──
// 青空文庫公式の全作品 CSV (zip) をメモリに読み込んで検索する。
// LLM に URL を言わせると実在しない図書カード番号を創作するので (実際に 404 が出た)、
// 検索は必ずこのカタログ経由にする。インスタンス生存中はキャッシュ。
const CATALOG_URL = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
let catalogCache = null;

function inflateZipSingleFile(buf) {
  // 単一ファイル zip 前提の最小パーサ: EOCD → central directory → local header → inflateRaw
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip EOCD が見つかりません");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip central directory が不正");
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const localOffset = buf.readUInt32LE(cd + 42);
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const data = buf.slice(dataStart, dataStart + compSize);
  if (method === 0) return data;
  return zlib.inflateRawSync(data);
}

// クオート対応の CSV 1 行パース
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadCatalog() {
  if (catalogCache) return catalogCache;
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`カタログ取得に失敗: HTTP ${res.status}`);
  const csv = inflateZipSingleFile(Buffer.from(await res.arrayBuffer())).toString("utf8");
  const lines = csv.split("\n");
  const seen = new Set();
  const works = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    const id = c[0];
    if (!id || seen.has(id)) continue; // 翻訳者等で同一作品が複数行になるため 1 行目だけ採用
    seen.add(id);
    works.push({
      title: c[1] || "",
      reading: c[2] || "",
      author: `${c[15] || ""}${c[16] || ""}`,
      cardUrl: c[13] || "",
      fileUrl: c[50] || "",
    });
  }
  catalogCache = works;
  console.log(`[aozora] catalog loaded: ${works.length} works`);
  return works;
}

// タイトル/読み/作者名の部分一致。完全一致 → 前方一致 → 部分一致の順で上位に。
export async function searchAozoraCatalog(query, limit = 10) {
  const works = await loadCatalog();
  const q = String(query || "").trim();
  if (!q) return [];
  const scored = [];
  for (const w of works) {
    let score = -1;
    if (w.title === q) score = 0;
    else if (w.title.startsWith(q)) score = 1;
    else if (w.title.includes(q) || w.reading.includes(q)) score = 2;
    else if (w.author.includes(q)) score = 3;
    if (score >= 0) scored.push({ score, w });
  }
  scored.sort((a, b) => a.score - b.score || a.w.title.length - b.w.title.length);
  return scored.slice(0, limit).map(({ w }) => ({ title: w.title, author: w.author, cardUrl: w.cardUrl }));
}

// 青空文庫 XHTML の定型マークアップからタイトル・作者を取る
export function extractAozoraMeta(html) {
  const title = html.match(/<h1 class="title"[^>]*>([^<]*)<\/h1>/)?.[1]?.trim()
    || html.match(/<title>[^<]*?[　 ]([^<]*)<\/title>/)?.[1]?.trim() || null;
  const author = html.match(/<h2 class="author"[^>]*>([^<]*)<\/h2>/)?.[1]?.trim() || null;
  return { title, author };
}

export function extractAozoraText(html) {
  const start = html.indexOf('<div class="main_text">');
  let end = html.indexOf('<div class="bibliographical_information"');
  if (end < 0) end = html.length;
  let t = html.slice(start >= 0 ? start : 0, end);
  t = t.replace(/<rp>[\s\S]*?<\/rp>/g, "").replace(/<rt>[\s\S]*?<\/rt>/g, "");
  t = t.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "");
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  t = t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function assertAozoraUrl(url) {
  // aozora.gr.jp (サブドメイン含む) の https 以外は拒否 (SSRF ガード)
  const u = new URL(url);
  if (u.protocol !== "https:" || !/(^|\.)aozora\.gr\.jp$/.test(u.hostname)) {
    throw new Error("青空文庫 (aozora.gr.jp) の URL だけ取り込めます");
  }
  return u;
}

// 図書カード URL (cards/NNNNNN/cardYY.html) なら XHTML 本文ファイルの URL に解決する
export async function resolveAozoraFileUrl(url) {
  const u = assertAozoraUrl(url);
  if (/\/files\/[\w.]+\.html$/.test(u.pathname)) return url; // 既に本文 URL
  if (!/\/card\d+\.html$/.test(u.pathname)) return url;      // 不明な形式はそのまま試す
  const res = await fetch(url);
  if (!res.ok) throw new Error(`図書カードの取得に失敗: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/href="\.\/(files\/[\w]+\.html)"/) || html.match(/(files\/[\w]+\.html)/);
  if (!m) throw new Error("図書カードから XHTML 本文リンクが見つかりません");
  return new URL(m[1], url).href;
}

export async function fetchAozoraText(url) {
  const fileUrl = await resolveAozoraFileUrl(url);
  assertAozoraUrl(fileUrl);
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`青空文庫の取得に失敗: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // charset は Shift_JIS が基本。meta で UTF-8 明示なら UTF-8。
  const head = buf.slice(0, 1000).toString("latin1").toLowerCase();
  const isUtf8 = /charset=["']?utf-?8/.test(head);
  const html = isUtf8 ? buf.toString("utf8") : new TextDecoder("shift_jis").decode(buf);
  return { text: extractAozoraText(html), meta: extractAozoraMeta(html) };
}

// テキスト → [{ number, title, content }]。
// 章見出し = 漢数字だけの行 (一/二/…) または「はしがき/第一の手記/あとがき」型の短行。
// 見出し直後に別の見出しが続く空章 (例: 第三の手記 → 一) は次章のタイトルに繋げる
// (「第三の手記 一」)。
export function splitChapters(text) {
  const lines = text.split("\n");
  const marks = [];
  lines.forEach((line, i) => {
    if (isChapterMarker(line)) marks.push({ i, label: line.trim() });
  });
  if (marks.length < 2) {
    return [{ number: 1, title: "全文", content: text }];
  }
  const raw = [];
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].i + 1;
    const to = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    const content = lines.slice(from, to).join("\n").trim();
    raw.push({ title: marks[k].label, content });
  }
  // 空章 (見出し直後に子見出しが続く「第三の手記」等) は親見出しとして子に引き継ぐ。
  // 親が付いた後の漢数字だけの章 (一/二…) には親見出しを前置し続ける
  const merged = [];
  let parent = "";
  for (const ch of raw) {
    const numeral = /^[一二三四五六七八九十百]+$/.test(ch.title);
    if (!numeral) parent = ""; // 新しい見出しが来たら親をリセット
    const title = numeral && parent ? `${parent} ${ch.title}` : ch.title;
    if (ch.content.length < 40) { parent = title; continue; } // 空見出し → 親として繰り越し
    merged.push({ title, content: ch.content });
  }
  const chapters = merged.map((ch, i) => ({ number: i + 1, title: ch.title, content: ch.content }));
  // 最初の見出しより前に本文がある場合 (序文等) は先頭に足す
  const preamble = lines.slice(0, marks[0].i).join("\n").trim();
  if (preamble.length >= 40) chapters.unshift({ number: 0, title: "序", content: preamble });
  return chapters;
}
