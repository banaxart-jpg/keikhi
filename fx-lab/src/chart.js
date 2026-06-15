import { ema, rsi, atr, last } from "./indicators.js";

// AI に投げるテキスト形式の「チャート概況」を組み立てる。
// 直近 N 本のローソク + 主要インディケータを構造化テキストに。
export function buildChartSummary(candles, instrument, granularity) {
  const closes = candles.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r14 = rsi(closes, 14);
  const a14 = atr(candles, 14);

  const lastIdx = candles.length - 1;
  const lastC = candles[lastIdx];
  const lastE20 = last(e20);
  const lastE50 = last(e50);
  const lastR = last(r14);
  const lastA = last(a14);

  // 直近 30 本だけ表に
  const window = candles.slice(-30);
  const tbl = window.map((c, i) => {
    const idx = candles.length - window.length + i;
    return `${c.time} O=${c.o} H=${c.h} L=${c.l} C=${c.c} EMA20=${e20[idx] != null ? e20[idx].toFixed(5) : "-"} EMA50=${e50[idx] != null ? e50[idx].toFixed(5) : "-"} RSI=${r14[idx] != null ? r14[idx].toFixed(1) : "-"}`;
  }).join("\n");

  return `【観測対象】 ${instrument} / ${granularity} 足 / 直近 ${candles.length} 本

【最新スナップショット】
  時刻: ${lastC.time}
  終値: ${lastC.c}
  EMA(20): ${lastE20?.toFixed(5) ?? "-"}
  EMA(50): ${lastE50?.toFixed(5) ?? "-"}
  RSI(14): ${lastR?.toFixed(1) ?? "-"}
  ATR(14): ${lastA?.toFixed(5) ?? "-"}
  トレンド: ${lastE20 && lastE50 ? (lastE20 > lastE50 ? "上昇 (EMA20 > EMA50)" : "下降 (EMA20 < EMA50)") : "-"}

【直近 30 本】
${tbl}
`;
}
