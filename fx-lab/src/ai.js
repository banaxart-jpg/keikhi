import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Gemini に「LONG / SHORT / PASS + 信頼度 + 理由」を返させる。
// chart = chart.js が組み立てた observability テキスト。
export async function decideFromChart(chartText) {
  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1000 },
  });
  const prompt = `あなたは短期 FX トレーダー (スキャル / デイトレ)。
以下の観測から「次の 5-30 分の値動き」を予想し、エントリー判断を返してください。

${chartText}

判定方針:
- 明確な根拠 (トレンド方向 + モメンタム + 反転シグナル等) がない限り PASS
- 1 トレード狙い 5-15 pips、リスクリワード 1:1 を想定
- RSI 70 超 / 30 切は逆張り検討、EMA20-50 のクロスは順張り検討
- confidence は本気で勝てると思う度合いを 0.0-1.0 で。0.7 以上のみ実弾発注閾値

JSON でだけ返す (前置きや説明禁止):
{
  "decision": "LONG" | "SHORT" | "PASS",
  "confidence": 0.0-1.0,
  "reasoning": "1-2 文の根拠 (具体に)"
}`;
  const r = await model.generateContent(prompt);
  const text = (r.response.text() || "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI レスポンスから JSON 取れず: " + text.slice(0, 200));
  const j = JSON.parse(m[0]);
  if (!["LONG", "SHORT", "PASS"].includes(j.decision)) {
    throw new Error("decision が不正: " + j.decision);
  }
  return {
    decision: j.decision,
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)),
    reasoning: String(j.reasoning || "").slice(0, 500),
  };
}
