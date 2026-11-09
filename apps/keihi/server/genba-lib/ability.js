// 連絡先の能力 (genba_contact_ability_*): 13 項目を 0〜5 (0 = 未評価) で、付けた人ごとに持つ。社内用の評価
//
//   genba_contact_abilities … (連絡先, 付けた人) ごとに 1 行。13 項目 + ひとこと + 付けた日時
//   連絡先 (genba_contacts) の列は増やさない: 付けた人ごとに別の点数を持つには 1 対多が要る。連絡先を消すと能力も消える
//
// genba-lib から ensureSchema(p) / forContacts(p, ids) / tools(by) / instructions を呼ぶ (既存のツールの動きは変えない)

// 表示名 (API・説明に出る名前) と DB の列名。順番は画面に出す順
export const ABILITIES = [
  ["力", "power"], ["体力", "stamina"], ["現場の正確さ", "site_accuracy"], ["現場のスピード", "site_speed"],
  ["運転・移動", "driving"], ["職人の仕切り", "crew_lead"], ["電話・交渉", "negotiation"], ["段取り・日程", "planning"],
  ["気づき・検討", "insight"], ["図面・納まり", "drawings"], ["数字・書類", "numbers_docs"], ["ネット手配", "online_ordering"],
  ["信用", "trust"],
].map(([label, col]) => ({ label, col }));
export const NOTE_MAX = 200;
export const INTERNAL_ONLY = "能力は社内用の評価。本人・相手の会社への文面 (LINE・メール・見積など) には、点数もひとことも、「力がある」のような言い換えも書かない";
const MONITOR = "LINE監視"; // 監視ジョブのトークンは人の評価を書かない

// 「運転移動」「運転・移動」「運転 移動」を同じに扱う
const squash = (s) => String(s ?? "").normalize("NFKC").replace(/[\s・･·/／]/g, "");
const BY_NAME = new Map(ABILITIES.map((a) => [squash(a.label), a]));
export const abilityOf = (name) => BY_NAME.get(squash(name)) || null;

// { 力: 4, 信用: "5" } → [{ ability, value }]。lo = 許す最小値 (set は 0 = 未評価に戻す、find の条件は 1)
export function parseScores(input, { lo = 0, what = "scores" } = {}) {
  let o = input;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { /* 下で止める */ } }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} は { 能力名: 点数 } の形で渡す (例 {"力": 4, "信用": 5})`);
  const got = new Map();
  for (const [k, raw] of Object.entries(o)) {
    const ability = abilityOf(k);
    if (!ability) throw new Error(`能力名が違う: ${k}。使える名前: ${ABILITIES.map((a) => a.label).join(" / ")}`);
    const v = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > 5) throw new Error(`${ability.label} は ${lo}〜5 の整数 (指定: ${JSON.stringify(raw)})${lo === 0 ? "。0 = 未評価" : ""}`);
    got.set(ability.col, { ability, value: v });
  }
  if (!got.size) throw new Error(`${what} が空`);
  return [...got.values()];
}

// 行 → { 能力名: 点数 } (0 = 未評価は出さない)
const scoresOf = (r) => Object.fromEntries(ABILITIES.filter((a) => Number(r[a.col]) > 0).map((a) => [a.label, Number(r[a.col])]));
const hasAny = (r) => ABILITIES.some((a) => Number(r[a.col]) > 0) || !!r.note;
// 付けた人の点数の平均 (0 = 未評価は数えない)。1 人だけならその人の点数
export function averages(rows) {
  const out = {};
  for (const a of ABILITIES) {
    const v = rows.map((r) => Number(r[a.col])).filter((x) => x > 0);
    if (v.length) out[a.label] = Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10;
  }
  return out;
}
const rowOut = (r) => ({ by: r.rated_by, scores: scoresOf(r), note: r.note || undefined, at: r.rated_at });

export function createAbility({ getPool, ready, resolveContact, loadContacts, contactsOut }) {
  async function ensureSchema(p) {
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_contact_abilities (
        contact_id  BIGINT NOT NULL REFERENCES genba_contacts(id) ON DELETE CASCADE,
        rated_by    TEXT NOT NULL,                       -- 付けた人 (トークンから)
        ${ABILITIES.map((a) => `${a.col} SMALLINT NOT NULL DEFAULT 0 CHECK (${a.col} BETWEEN 0 AND 5)`).join(",\n        ")},
        note        TEXT,                                -- 能力のひとこと
        rated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 付けた日時 (最後に書き換えた時刻)
        PRIMARY KEY (contact_id, rated_by)
      )`);
  }

  async function rawRows(p, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    return (await p.query(`SELECT * FROM genba_contact_abilities WHERE contact_id = ANY($1::bigint[]) ORDER BY rated_at DESC, rated_by`, [list])).rows;
  }
  // contactsOut が使う: 連絡先 id → { abilities: [{ by, scores, note, at }], avg }。読めなくても連絡先の返り値は壊さない
  async function forContacts(p, ids) {
    const map = new Map();
    try {
      const by = new Map();
      for (const r of await rawRows(p, ids)) { if (!hasAny(r)) continue; const k = Number(r.contact_id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
      for (const [k, rows] of by) { const avg = averages(rows); map.set(k, { abilities: rows.map(rowOut), avg: Object.keys(avg).length ? avg : undefined }); }
    } catch (e) { console.warn("[genba] contact abilities", e.message); }
    return map;
  }

  const scoreProps = Object.fromEntries(ABILITIES.map((a) => [a.label, { type: "integer", minimum: 0, maximum: 5 }]));
  const norm = (s) => squash(s).toLowerCase();
  function tools(by) {
    return [
      {
        name: "genba_contact_ability_set",
        description: `連絡先に能力 (0〜5 の整数、0 = 未評価) を書く。付けた人はトークンから (小西のトークンなら小西の点数、名取なら名取の点数。人ごとに別々に残る)。能力名: ${ABILITIES.map((a) => a.label).join(" / ")}。scores は変えたい項目だけ渡せばよい (渡さなかった項目は今の点数のまま、0 を渡すと未評価に戻る)。note = 能力のひとこと (${NOTE_MAX} 字まで、省略すると今のひとことのまま、"" で消す)。その人の評価を人から言われたときだけ書く。AI が推測で点数を付けない。${INTERNAL_ONLY}`,
        inputSchema: {
          type: "object", required: ["contact", "scores"],
          properties: {
            contact: { type: "string", description: "名前・呼び名・ID (一意に引けないと止まる。その時は ID か会社名で)" },
            scores: { type: "object", properties: scoreProps, additionalProperties: false, description: '{ "力": 4, "信用": 5 }' },
            note: { type: "string", description: `能力のひとこと (${NOTE_MAX} 字まで)` },
          },
        },
        handler: async (a) => {
          await ready();
          if (by === MONITOR) throw new Error("監視ジョブのトークンでは能力を付けられない (人の評価)");
          const p = getPool();
          const noteGiven = a.note !== undefined && a.note !== null;
          const note = noteGiven ? String(a.note).trim() : null;
          if (note && [...note].length > NOTE_MAX) throw new Error(`note は ${NOTE_MAX} 字まで (${[...note].length} 字)`);
          const pairs = a.scores === undefined || a.scores === null ? [] : parseScores(a.scores);
          if (!pairs.length && !noteGiven) throw new Error("scores か note のどちらかが必要");
          const c = await resolveContact(p, a.contact);
          const { rows: prev } = await p.query(`SELECT * FROM genba_contact_abilities WHERE contact_id=$1 AND rated_by=$2`, [c.id, by]);
          // 渡された項目だけ書く (列名は固定の定数。値は全部パラメータ)
          const cols = ["contact_id", "rated_by", ...pairs.map((x) => x.ability.col), ...(noteGiven ? ["note"] : [])];
          const vals = [c.id, by, ...pairs.map((x) => x.value), ...(noteGiven ? [note || null] : [])];
          const sets = [...cols.slice(2).map((k) => `${k}=EXCLUDED.${k}`), "rated_at=now()"];
          const { rows } = await p.query(
            `INSERT INTO genba_contact_abilities (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT (contact_id, rated_by) DO UPDATE SET ${sets.join(", ")} RETURNING *`, vals);
          const before = prev[0] || {};
          const changed = pairs.filter((x) => Number(before[x.ability.col] || 0) !== x.value).map((x) => ({ ability: x.ability.label, from: Number(before[x.ability.col] || 0), to: x.value }));
          const all = (await rawRows(p, [c.id])).filter(hasAny);
          const avg = averages(all);
          return {
            contact: { id: Number(c.id), name: c.name, company: c.company || null },
            ability: rowOut(rows[0]), changed,
            raters: all.map((r) => r.rated_by), ability_avg: all.length > 1 ? avg : undefined,
            reminder: INTERNAL_ONLY,
          };
        },
      },
      {
        name: "genba_contact_ability_find",
        description: `能力で連絡先を探す。例「力が 4 以上」→ min={"力":4}、「信用 4 以上かつ大工」→ min={"信用":4}, trade="大工"。min は全部満たす人だけ (かつ)。点数は付けた人の平均 (0 = 未評価は数えない、評価の無い項目は条件を満たさない)、by="小西" で小西が付けた点数だけで見る。条件に合った順 (min の項目の合計が高い順) に返し、各人に abilities (付けた人ごとの点数・ひとこと) が付く。条件が全部空なら評価がある人の一覧。${INTERNAL_ONLY}`,
        inputSchema: {
          type: "object",
          properties: {
            min: { type: "object", properties: Object.fromEntries(ABILITIES.map((a) => [a.label, { type: "integer", minimum: 1, maximum: 5 }])), additionalProperties: false, description: '最低点 {"力": 4, "信用": 4}' },
            trade: { type: "string", description: "職種 (大工・防水・電気…)。部分一致" },
            role: { type: "string", description: "職人 / 業者 / 元請け / 設計 / 客先 / 社内" },
            by: { type: "string", description: "誰が付けた点数で見るか (小西 / 名取)。省略 = 付けた人の平均" },
            limit: { type: "integer", description: "既定 20、最大 50" },
          },
        },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const conds = a.min === undefined || a.min === null ? [] : parseScores(a.min, { lo: 1, what: "min" });
          const who = a.by ? String(a.by).trim() : null;
          const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
          let rows = await loadContacts(p);
          if (a.role) rows = rows.filter((r) => norm(r.role) === norm(a.role));
          if (a.trade) rows = rows.filter((r) => r.trade && (norm(r.trade).includes(norm(a.trade)) || norm(a.trade).includes(norm(r.trade))));
          const raw = await rawRows(p, rows.map((r) => r.id));
          const byContact = new Map();
          for (const r of raw) { const k = Number(r.contact_id); if (!byContact.has(k)) byContact.set(k, []); byContact.get(k).push(r); }
          const scored = [];
          for (const r of rows) {
            const mine = (byContact.get(Number(r.id)) || []).filter((x) => hasAny(x) && (!who || x.rated_by === who));
            const avg = averages(mine);
            if (!Object.keys(avg).length) continue;                                  // 評価が無い人は出さない
            if (!conds.every((x) => (avg[x.ability.label] || 0) >= x.value)) continue;
            const sum = (conds.length ? conds.map((x) => x.ability) : ABILITIES).reduce((s, ab) => s + (avg[ab.label] || 0), 0);
            scored.push({ r, avg, sum });
          }
          scored.sort((x, y) => y.sum - x.sum || String(x.r.name).localeCompare(String(y.r.name), "ja"));
          const picked = scored.slice(0, limit);
          const out = await contactsOut(p, picked.map((x) => x.r));
          out.forEach((o, i) => { o.score_used = { by: who || "付けた人の平均", scores: picked[i].avg }; });
          return {
            count: out.length, matched: scored.length,
            conditions: { min: Object.fromEntries(conds.map((x) => [x.ability.label, x.value])), trade: a.trade || undefined, role: a.role || undefined, by: who || "付けた人の平均" },
            contacts: out, reminder: INTERNAL_ONLY,
          };
        },
      },
    ];
  }

  const instructions = [
    "■ 連絡先の能力 (genba_contact_ability_*): 13 項目 (" + ABILITIES.map((a) => a.label).join(" / ") + ") を 0〜5 (0 = 未評価)。付けた人ごとに別の点数が残る",
    "- 「〇〇さんは力 4、信用 5」のように人から評価を言われたら genba_contact_ability_set(contact, scores, note)。AI が推測で付けない。変えたい項目だけ渡せばよい",
    "- 「力のある人」「信用 4 以上の大工」のように人選びをするときは genba_contact_ability_find(min, trade, role)。genba_contact_find / genba_contact_list の返り値の abilities (付けた人ごと)・ability_avg (平均) も人選びの材料",
    "- 能力は社内用の評価 (評価メモと同じ扱い)。本人・相手の会社への文面には、点数もひとことも言い換えも書かない。社内の人への返答でも、人選びの材料に使うのはよいが、点数やひとことの原文を貼らない",
  ];

  return { ensureSchema, forContacts, tools, instructions };
}
