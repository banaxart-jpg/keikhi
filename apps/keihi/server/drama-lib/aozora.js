// 青空文庫の XHTML から本文テキストを取り込む。
// - Shift_JIS デコード (青空文庫の HTML はほぼ全部 Shift_JIS)
// - ルビ (<rt>/<rp>) と注記タグを除去して素のテキストに
// - 「行全体が漢数字だけ」の行を章見出しとして分割 (一/二/…/三十二)
//   見出しが無い作品は 1 章 (全文) として返す

const KANJI_CHAPTER_RE = /^[　\s]*[一二三四五六七八九十百]+[　\s]*$/;

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

// テキスト → [{ number, title, content }]。章見出し (漢数字だけの行) で分割。
export function splitChapters(text) {
  const lines = text.split("\n");
  const marks = [];
  lines.forEach((line, i) => {
    if (KANJI_CHAPTER_RE.test(line)) marks.push({ i, label: line.trim() });
  });
  if (marks.length < 2) {
    return [{ number: 1, title: "全文", content: text }];
  }
  const chapters = [];
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].i + 1;
    const to = k + 1 < marks.length ? marks[k + 1].i : lines.length;
    const content = lines.slice(from, to).join("\n").trim();
    chapters.push({ number: k + 1, title: marks[k].label, content });
  }
  // 最初の見出しより前に本文がある場合 (序文等) は先頭に足す
  const preamble = lines.slice(0, marks[0].i).join("\n").trim();
  if (preamble) chapters.unshift({ number: 0, title: "序", content: preamble });
  return chapters;
}
