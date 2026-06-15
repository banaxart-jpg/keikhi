import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const tradesFile = path.join(dataDir, "trades.ndjson");
const decisionsFile = path.join(dataDir, "decisions.ndjson");

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function append(file, obj) {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n");
}

export function logDecision(rec) { append(decisionsFile, rec); }
export function logTrade(rec) { append(tradesFile, rec); }

// 直近 N 件の trades.ndjson を読む (簡易、巨大ファイル想定なし)
export function readTrades(limit = 100) {
  ensureDir();
  if (!fs.existsSync(tradesFile)) return [];
  const lines = fs.readFileSync(tradesFile, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function readDecisions(limit = 100) {
  ensureDir();
  if (!fs.existsSync(decisionsFile)) return [];
  const lines = fs.readFileSync(decisionsFile, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 今日 (UTC) のトレード件数
export function countTradesToday() {
  const today = new Date().toISOString().slice(0, 10);
  return readTrades(500).filter((t) => (t.at || "").startsWith(today)).length;
}
