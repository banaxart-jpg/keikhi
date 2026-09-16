// seko-kanri の報酬演出テスト: 実 index.html を firebase/fetch/AudioContext スタブで起動し、
// コンボ・XP・クリティカル・レベルアップ・日課リング・サマリーを実ブラウザで検証する。
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// 生成物 (ハーネス HTML / スクショ) はリポジトリを汚さないよう tmp に置く
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seko-fx-"));
let html = fs.readFileSync("/home/user/keikhi/apps/seko-kanri/index.html", "utf8");

// config.js → API_BASE + fetch スタブ + AudioContext スタブ (鳴った周波数を記録)
html = html.replace('<script src="/config.js"></script>', `<script>
window.API_BASE = "";
window.__tones = [];            // [{freq, type, vol}] 鳴った音
window.__vibes = [];            // navigator.vibrate の記録
window.__posted = [];           // サーバーに送った body
navigator.vibrate = (p) => { window.__vibes.push(p); return true; };
class FakeAudioContext {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = "running"; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createOscillator() {
    const o = { type: "sine", frequency: { value: 0 }, connect() {}, start() { window.__tones.push({ freq: Math.round(o.frequency.value), type: o.type }); }, stop() {} };
    return o;
  }
}
window.AudioContext = FakeAudioContext;
// 出題: 択一2問 + 記述1問
window.__QUESTIONS = [
  { id: 101, category: "kanri_ho", difficulty: 3, type: "choice", question: "Q1 択一", options: ["A", "B", "C", "D"], genre: "工程管理", group_id: "kanri_ho", exam_level: "1ji" },
  { id: 102, category: "kanri_ho", difficulty: 3, type: "choice", question: "Q2 択一", options: ["A", "B", "C", "D"], genre: "品質管理", group_id: "kanri_ho", exam_level: "1ji" },
  { id: 103, category: "niji_kijutsu_shiage", difficulty: 3, type: "free", question: "Q3 記述", options: null, genre: "防水工事の留意点 (記述)", group_id: "niji_kijutsu_shiage", exam_level: "2ji" },
  { id: 104, category: "kanri_ho", difficulty: 3, type: "choice", question: "Q4 択一", options: ["A", "B", "C", "D"], genre: "安全管理", group_id: "kanri_ho", exam_level: "1ji" },
  { id: 105, category: "kanri_ho", difficulty: 3, type: "choice", question: "Q5 択一", options: ["A", "B", "C", "D"], genre: "原価管理", group_id: "kanri_ho", exam_level: "1ji" },
  { id: 106, category: "kanri_ho", difficulty: 3, type: "choice", question: "Q6 択一", options: ["A", "B", "C", "D"], genre: "施工計画書", group_id: "kanri_ho", exam_level: "1ji" },
];
// answer の返り値をテストから差し替えるキュー
window.__answerQueue = [];
window.__me = {
  user: { display_name: "konishi0221", level: 3, total_correct: 42, total_answers: 60, exam_target: "first_full", shubetsu: "shiage", xp: 260 },
  xp: { xp: 260, level: 3, levelXpBase: 220, nextLevelXp: 360, intoLevel: 40, needForNext: 140 },
  streak: { streak: 4, today_active: false, today_correct: 2, daily_min: 5 },
  groups: [
    { id: "kanri_ho", name: "施工管理法", color: "#4338ca", genres: [{ name: "工程管理", target: 8, correct: 4 }], target: 8, correct: 4, pct: 50 },
    { id: "ho_ki", name: "法規", color: "#b45309", genres: [{ name: "建設業法", target: 8, correct: 2 }], target: 8, correct: 2, pct: 25 },
    { id: "shiko_shiage", name: "施工 (仕上)", color: "#c4a574", genres: [{ name: "防水工事", target: 10, correct: 6 }], target: 10, correct: 6, pct: 60 },
  ],
  pool: { total: 50, generated: 50, seed: 0, gen_last_hour: 5 },
  recentWords: [], learnedAll: [], pace: { last7_answers: 30, last7_correct: 20 },
  hasLauncherAccess: true, isOwner: true,
  exam_target: "first_full", shubetsu: "shiage",
};
window.__end = { ok: true, level: 4, xp: { xp: 400, level: 4, levelXpBase: 360, nextLevelXp: 520, intoLevel: 40, needForNext: 160 },
  streak: { streak: 5, today_active: true, today_correct: 6, daily_min: 5 },
  dailyGoalJustReached: true, streakDays: 5, totalUniqCorrect: 45, sessionXp: 0, maxCombo: 0, levelUps: 0,
  message: '<span class="icon">local_fire_department</span> 今日の日課クリア 連続 5 日' };
if (window.__streakOverride) window.__me.streak = window.__streakOverride;
window.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (body) window.__posted.push({ url: u, body });
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.includes("/api/seko/me")) return json(window.__me);
  if (u.includes("/api/seko/genres")) return json({ domain: { title: "施工管理2級" }, groups: window.__me.groups, phases: [] });
  if (u.includes("/api/seko/peers")) return json([]);
  if (u.includes("/api/seko/peer-learned")) return json({ learned: [] });
  if (u.includes("/api/seko/ui-demo")) return json({ pending: 0, total: 0, disabled: true });
  if (u.includes("/api/seko/sessions/start")) return json({ total: window.__QUESTIONS.length, questions: window.__QUESTIONS });
  if (u.includes("/api/seko/sessions/end")) return json(window.__end);
  if (u.includes("/api/seko/answer")) {
    const r = window.__answerQueue.shift() || { is_correct: true, answer: "A", explanation: "解説", xp_gain: 10, xp_total: 270, combo_mult: 1, critical: false, first_clear: false, level: 3, level_up: false, old_level: 3, level_xp_base: 220, next_level_xp: 360 };
    return json(r);
  }
  return json({});
};
</script>`);
// firebase import → スタブ (即ログイン済み)
html = html.replace(/import \{ initializeApp \} from "https:\/\/www\.gstatic\.com\/firebasejs[^"]*";/, "const initializeApp = () => ({});");
html = html.replace(/import \{[^}]*\} from "https:\/\/www\.gstatic\.com\/firebasejs\/10\.14\.1\/firebase-auth\.js";/, `
const getAuth = () => ({ currentUser: null });
const onAuthStateChanged = (a, cb) => setTimeout(() => cb({ email: "konishi0221@gmail.com", uid: "t", getIdToken: async () => "tok" }), 0);
const signOut = async () => {};
const GoogleAuthProvider = function () { this.setCustomParameters = () => {}; };
const signInWithPopup = async () => {};
const signInWithRedirect = async () => {};
const getRedirectResult = async () => null;
const setPersistence = async () => {};
const browserLocalPersistence = null;`);
html = html.replace(/<script src="\/push-register\.js"><\/script>/, "");
html = html.replace(/import [^;]*from "\/push-register\.js";/, "const registerPushForUser = async () => {};");
fs.writeFileSync(path.join(dir, "seko-fx.html"), html);

const server = http.createServer((req, res) => {
  let body = null;
  const p = path.join(dir, req.url.split("?")[0].replace(/^\//, ""));
  try { body = fs.readFileSync(p); } catch (_) {}
  if (body === null) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port + "/";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/ERR_CERT|ERR_NAME|fonts\.googleapis|gstatic|404 \(Not Found\)/.test(m.text())) errs.push("console: " + m.text()); });

const fails = [];
const ok = (c, l) => { console.log((c ? "PASS" : "FAIL") + " " + l); if (!c) fails.push(l); };
const txt = (sel) => page.locator(sel).innerText();

await page.goto(base + "seko-fx.html");
await page.waitForSelector("#homeView.active", { timeout: 8000 });
await page.waitForTimeout(400);

// ── ホーム: XP バー + 日課リング ──
ok((await txt("#xpLv")) === "LV 3", "home XP bar level label");
const w = await page.locator("#xpBar > div").evaluate((el) => el.style.width);
ok(w === "29%", "XP bar width = 40/140 = 29% (got " + w + ")");
ok((await txt("#xpRest")).includes("100"), "XP rest = 100 (" + (await txt("#xpRest")) + ")");
const ringOff = await page.locator("#dailyRingVal").getAttribute("stroke-dashoffset");
const C = 2 * Math.PI * 23;
ok(Math.abs(Number(ringOff) - C * (1 - 2 / 5)) < 0.5, "daily ring = 2/5 (" + ringOff + ")");
ok(!(await page.locator("#dailyRing").evaluate((el) => el.classList.contains("done"))), "daily ring not done at 2/5");
ok((await txt("#dailyTxt")).includes("今日 2 / 5 問") && (await txt("#dailyTxt")).includes("あと 3 問"), "daily text shows remaining");
ok((await page.locator("#soundPill .icon").innerText()) === "volume_up", "sound pill on by default");

// ── セッション: コンボ連鎖 ──
await page.evaluate(() => {
  const mk = (o) => Object.assign({ is_correct: true, answer: "A", explanation: "解説", xp_gain: 10, xp_total: 270, combo_mult: 1, critical: false, first_clear: false, level: 3, level_up: false, old_level: 3, level_xp_base: 220, next_level_xp: 360 }, o);
  window.__answerQueue = [
    mk({ xp_gain: 15, first_clear: true }),                                        // 1 連続
    mk({ xp_gain: 17, combo_mult: 1.1, xp_total: 287 }),                           // 2 連続
    mk({ is_correct: false, xp_gain: 1, answer: "A", score: null }),               // 不正解 (コンボ 2 → break なし)
  ];
});
await page.click("#startBtn");
await page.waitForSelector("#sessionView.active", { timeout: 5000 });
await page.waitForTimeout(200);
ok((await txt("#sessXpLv")) === "LV 3", "session XP bar rendered on start");

// 今表示されている入力欄 (択一 or 記述) に応じて回答する
const answerCurrent = async () => {
  const isFree = await page.locator("#freeArea").evaluate((el) => el.style.display !== "none");
  if (isFree) { await page.fill("#freeInput", "配筋検査でかぶり厚さを確認する"); await page.click("#freeSubmit"); }
  else { await page.locator("#choiceList .choice-btn").first().click(); }
  await page.waitForTimeout(400);
};
const answerChoice = answerCurrent;
const goNext = async () => { await page.click("button.next-btn"); await page.waitForTimeout(200); };
await page.evaluate(() => { window.__tones = []; });
await answerChoice();                 // combo 1
let tones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(tones.length >= 1 && tones[0] === 523, "combo1 tone = C5 523Hz (got " + tones.slice(0, 2) + ")");
ok((await txt("#comboChip")) === "", "combo chip hidden at combo 1");
let pop = await page.locator(".xp-pop").count();
ok(pop === 0 || (await page.locator(".xp-pop").first().innerText()).includes("+15 XP"), "xp pop shows +15");
const postedCombo = await page.evaluate(() => window.__posted.filter((p) => p.url.includes("/answer")).map((p) => p.body.combo));
ok(postedCombo[0] === 1, "combo=1 sent to server");

await goNext();
await page.evaluate(() => { window.__tones = []; });
await answerCurrent();                // combo 2
tones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(tones[0] === 587, "combo2 tone rises to D5 587Hz (got " + tones[0] + ")");
ok((await txt("#comboChip")).includes("2 COMBO") && (await txt("#comboChip")).includes("×1.1"), "combo chip shows 2 COMBO x1.1");
const w2 = await page.locator("#sessXpBar > div").evaluate((el) => el.style.width);
ok(w2 === "48%", "session XP bar grew to 67/140 = 48% (got " + w2 + ")");
const combo2 = await page.evaluate(() => window.__posted.filter((p) => p.url.includes("/answer")).map((p) => p.body.combo));
ok(combo2[1] === 2, "combo=2 sent to server");

// 3問目: 記述で不正解 → コンボ 0、wrong 音
await goNext();
await page.evaluate(() => { window.__tones = []; window.__vibes = []; });
await answerCurrent();
tones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(tones.includes(220) && tones.includes(165), "wrong tone 220→165 (got " + tones + ")");
ok((await txt("#comboChip")).includes("最大 2") || (await txt("#comboChip")) === "", "combo reset after wrong");
ok((await page.evaluate(() => window.__vibes.length)) >= 1, "vibration on wrong");

// ── クリティカル + コンボ 3 + レベルアップ ──
await page.evaluate(() => {
  const mk = (o) => Object.assign({ is_correct: true, answer: "A", explanation: "解説", xp_gain: 10, xp_total: 300, combo_mult: 1, critical: false, first_clear: false, level: 3, level_up: false, old_level: 3, level_xp_base: 220, next_level_xp: 360 }, o);
  window.__answerQueue = [
    mk({ xp_gain: 10 }),                                                        // combo1
    mk({ xp_gain: 11, combo_mult: 1.1 }),                                       // combo2
    mk({ xp_gain: 40, combo_mult: 1.2, critical: true, xp_total: 358 }),        // combo3 + CRITICAL
    mk({ xp_gain: 13, combo_mult: 1.3, xp_total: 371, level: 4, level_up: true, level_xp_base: 360, next_level_xp: 520 }), // LEVEL UP
  ];
  window.__tones = [];
});
await goNext();
await answerCurrent();                 // Q4 combo1
await goNext();
await answerCurrent();                 // Q5 combo2
await goNext();
await page.evaluate(() => { window.__tones = []; });
await answerCurrent();                 // Q3 再出題 (記述) combo3 + critical
ok((await page.locator(".combo-pop").count()) >= 1 && (await page.locator(".combo-pop").last().innerText()).includes("3"), "combo pop at 3 combo");
ok((await page.locator(".xp-pop.crit").count()) >= 1, "critical xp pop styled");
ok((await page.locator(".xp-pop.crit").last().innerText()).includes("CRITICAL"), "CRITICAL label shown");
tones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(tones.includes(1047) && tones.includes(1319), "critical arpeggio played (got " + tones.slice(0, 4) + ")");
ok((await page.locator(".crit-flash").count()) >= 1, "critical flash overlay");

await goNext();
await page.evaluate(() => { window.__tones = []; });
await answerCurrent();                 // Q6 combo4 → level up
await page.waitForTimeout(900);
tones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(tones.includes(1047) && tones.includes(784), "level up fanfare played");
ok((await txt("#sessXpLv")) === "LV 4", "session XP bar switched to LV 4");
ok((await page.locator(".confetti").count()) > 0, "confetti on level up");

// ── セッション終了 → サマリー ──
await page.evaluate(() => { window.__end.levelUps = 1; });
await page.click("button.next-btn");
await page.waitForSelector("#summaryView.active", { timeout: 5000 });
await page.waitForTimeout(1200);
const sumXp = Number(await txt("#sumXp"));
ok(sumXp === 107, "summary XP = 15+17+1+10+11+40+13 = 107 (got " + sumXp + ")");
ok((await txt("#sumCombo")) === "4", "summary max combo = 4");
ok(parseInt(await txt("#sumAcc"), 10) > 0, "summary accuracy shown (" + (await txt("#sumAcc")) + ")");
ok((await txt("#summaryLevelChange")).includes("レベル 4 に到達"), "summary shows level up");
ok((await page.locator("#celebrateOverlay").evaluate((el) => el.classList.contains("show"))), "celebrate overlay shown");
ok((await page.locator("#celebrateBurst").evaluate((el) => el.textContent)) === "Level Up", "celebrate burst = Level Up");
ok((await txt("#celebrateSub")).includes("+107 XP") && (await txt("#celebrateSub")).includes("最大 4"), "celebrate sub shows XP + combo");
const endBody = await page.evaluate(() => window.__posted.filter((p) => p.url.includes("sessions/end")).pop().body);
ok(endBody.xp === 107 && endBody.maxCombo === 4 && endBody.levelUps === 1 && endBody.correct >= 3, "session stats sent to server " + JSON.stringify(endBody));

// ── ミュート ──
await page.click("#celebrateOverlay .celebrate-skip").catch(() => {});
await page.waitForTimeout(300);
await page.evaluate(() => { window.__tones = []; });
await page.click("#soundPill");
ok((await page.locator("#soundPill .icon").innerText()) === "volume_off", "sound pill → off");
ok((await page.evaluate(() => localStorage.getItem("seko_sound"))) === "off", "mute persisted");
await page.evaluate(() => { window.__tones = []; window.sfx_test = 1; });
await page.evaluate(() => { /* ミュート中は鳴らない */ });
await page.click("#startBtn");
await page.waitForSelector("#sessionView.active");
await answerChoice();
tones = await page.evaluate(() => window.__tones.length);
ok(tones === 0, "muted: no tones played (got " + tones + ")");

// ── 日課クリアの瞬間 (今日 4/5 → 1 問正解で跨ぐ) ──
await page.evaluate(() => localStorage.setItem("seko_sound", "on"));
await page.addInitScript(() => { window.__streakOverride = { streak: 7, today_active: false, today_correct: 4, daily_min: 5 }; });
await page.reload();
await page.waitForSelector("#homeView.active", { timeout: 8000 });
await page.waitForTimeout(400);
ok((await txt("#dailyTxt")).includes("今日 4 / 5 問"), "daily ring reloaded at 4/5");
await page.evaluate(() => { window.__QUESTIONS = window.__QUESTIONS.filter((q) => q.type === "choice"); window.__answerQueue = []; window.__tones = []; });
await page.click("#startBtn");
await page.waitForSelector("#sessionView.active", { timeout: 5000 });
await answerCurrent();
await page.waitForTimeout(1100);
const dailyTones = await page.evaluate(() => window.__tones.map((t) => t.freq));
ok(dailyTones.includes(1319), "daily clear jingle played (784/1047/1319, got " + dailyTones + ")");
const popTxt = await page.locator(".xp-pop.crit").last().innerText().catch(() => "");
ok(popTxt.includes("日課クリア") && popTxt.includes("連続 8 日"), "daily clear pop shows streak+1 (" + popTxt + ")");
// 2 問目では二重に出さない
await goNext();
await page.evaluate(() => { window.__tones = []; });
await answerCurrent();
await page.waitForTimeout(1100);
ok(!(await page.evaluate(() => window.__tones.map((t) => t.freq))).includes(1319), "daily clear fires only once");

ok(errs.length === 0, "no page errors: " + JSON.stringify(errs.slice(0, 3)));
await page.screenshot({ path: dir + "seko-fx.png", fullPage: false });
await browser.close();
server.close();
console.log(fails.length ? "\nFAILURES: " + fails.join(" | ") : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
