// 汎用 OHLCV CSV パーサ。HistData / Dukascopy / Stooq / Twelve Data 等の
// よくある形式を自動判定して { time, o, h, l, c, v } の candle 配列を返す。
//
// 対応する区切り: カンマ・セミコロン・タブ・空白
// 対応する時刻形式:
//   - ISO8601 ("2025-06-01T00:00:00Z")
//   - "2025-06-01 00:00:00"
//   - "2025.06.01 00:00:00" (Dukascopy)
//   - "20250601 000000"     (HistData M1)
//   - "2025-06-01"          (日次)
//   - 2 列に別れている時 ("2025-06-01,00:00")
// 列順:
//   ts, open, high, low, close, [volume]
//   または ts_date, ts_time, open, high, low, close, [volume]
// ヘッダ行 (open/Open 等を含む) は自動スキップ。
// 価格は数値変換できない行はスキップ。

export function parseCandlesCsv(text) {
  if (!text || typeof text !== "string") throw new Error("CSV テキストが空");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("CSV に行がない");
  const out = [];
  // 区切りを推定: 最初の行で最も多いもの
  const sample = lines[Math.min(5, lines.length - 1)];
  const cands = [",", ";", "\t", " "];
  const counts = cands.map((c) => (sample.match(new RegExp("\\" + c, "g")) || []).length);
  const sep = cands[counts.indexOf(Math.max(...counts))];
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (raw.startsWith("#") || raw.startsWith("//")) continue;
    const parts = raw.split(sep === " " ? /\s+/ : sep).map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length < 5) continue;
    // ヘッダ判定
    if (/open|high|low|close|date|time|timestamp/i.test(parts[0] + parts[1] + parts[2])) {
      // 数値が無い行なら header とみなしスキップ
      const numeric = parts.slice(-4).every((p) => Number.isFinite(Number(p)));
      if (!numeric) continue;
    }
    // 末尾から連続して数値が並ぶ個数を数える。4 or 5 (OHLC + optional volume) を期待
    let numericCount = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (Number.isFinite(Number(parts[i])) && parts[i] !== "") numericCount++;
      else break;
    }
    if (numericCount < 4) continue;
    const ohlcStart = parts.length - numericCount;
    if (ohlcStart < 1) continue;
    const o = Number(parts[ohlcStart]);
    const h = Number(parts[ohlcStart + 1]);
    const l = Number(parts[ohlcStart + 2]);
    const c = Number(parts[ohlcStart + 3]);
    const v = numericCount >= 5 ? Number(parts[ohlcStart + 4]) || 0 : 0;
    // 時刻 = 0 〜 ohlcStart の要素を結合
    let ts;
    if (ohlcStart === 1) {
      ts = normalizeTimestamp(parts[0]);
    } else if (ohlcStart === 2) {
      ts = normalizeTimestamp(parts[0] + " " + parts[1]);
    } else {
      ts = normalizeTimestamp(parts.slice(0, ohlcStart).join(" "));
    }
    if (!ts) continue;
    if (!Number.isFinite(o + h + l + c) || h < l) continue;
    out.push({ time: ts, o, h, l, c, v });
  }
  if (!out.length) throw new Error("候補となる candle 行が見つからず (列順や区切りを確認)");
  // 時系列順 (古い → 新しい)
  out.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return out;
}

function normalizeTimestamp(s) {
  if (!s) return null;
  s = s.trim();
  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return new Date(s).toISOString();
  // "2025-06-01 00:00:00"
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return new Date(s.replace(" ", "T") + (s.length === 16 ? ":00" : "") + "Z").toISOString();
  }
  // "2025.06.01 00:00:00" (Dukascopy)
  if (/^\d{4}\.\d{2}\.\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const norm = s.replace(/\./g, "-").replace(" ", "T") + (s.length === 16 ? ":00" : "");
    return new Date(norm + "Z").toISOString();
  }
  // "20250601 000000" (HistData M1)
  const m = s.match(/^(\d{4})(\d{2})(\d{2})[ T]?(\d{2})(\d{2})(\d{2})?$/);
  if (m) {
    const [, y, mo, d, hh, mm, ss] = m;
    return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss || "00"}Z`).toISOString();
  }
  // "2025-06-01" (日次のみ)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z").toISOString();
  // Unix timestamp
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  return null;
}
