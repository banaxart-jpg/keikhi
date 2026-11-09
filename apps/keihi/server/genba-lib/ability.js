// 連絡先の「能力」「条件」「チーム」 (genba_contact_ability_* / genba_contact_condition_set)
//
//   能力 (点数)   genba_contact_ratings … (連絡先, 付けた人) ごとに 1 行。項目ごとの点数 (1〜5 / 不明 / 未入力) と理由は JSONB
//                 → 項目を足しても DB の変更は要らない。項目の一覧は ABILITY_ITEMS の 1 か所だけ
//   条件          genba_contacts の列 (night_ok / crew_size / has_car / area)。点数ではない事実なので付けた人ごとには持たない
//   チーム        genba_contacts.team_lead_id (親方の連絡先)。親方を消すと NULL に戻る
//
// 能力・理由は社内用の評価。genba-lib から ensureSchema(p) / forContacts(p, rows) / tools(by) / instructions を呼ぶ

// ── 項目の一覧 (ここだけ。足すときは 1 行足す。名前を変える・消すときは保存済みの scores のキーも直す)
export const ABILITY_ITEMS = [
  { key: "力", hint: "重い物を運ぶ・持ち上げる" },
  { key: "体力", hint: "長時間・夜でもバテない" },
  { key: "現場の正確さ", hint: "仕上がりがきれい・寸法がずれない" },
  { key: "現場のスピード", hint: "手が速い" },
  { key: "運転・移動", hint: "車で動ける・運べる" },
  { key: "職人の仕切り", hint: "現場で説明・指示できる" },
  { key: "電話・交渉", hint: "電話や金額・日程の交渉" },
  { key: "段取り・日程", hint: "先回りして日程や手配を組む" },
  { key: "気づき・検討", hint: "じっくり考えて抜けに気づく" },
  { key: "図面・納まり", hint: "図面が読めて納まりを考えられる" },
  { key: "数字・書類", hint: "見積・請求・書類を間違えない" },
  { key: "ネット手配", hint: "材料を探して注文できる" },
  { key: "信用", hint: "約束を守る・任せて安心" },
  { key: "理解力", hint: "打ち合わせで言われたことをその場で分かる" },
  { key: "説明力", hint: "相手に分かるように伝えられる" },
  { key: "腕の幅", hint: "本業以外に何ができるか" },
  { key: "急ぎ・融通", hint: "前日でも来てくれる・変更に付き合ってくれる" },
  { key: "現場のきれいさ", hint: "養生・片付け・ゴミの持ち帰り" },
  { key: "単価", hint: "5＝安い・コスパがいい、1＝高い" },
];
export const SCORE_MIN = 1, SCORE_MAX = 5;
export const NOTE_MAX = 200, REASON_MAX = 120, AREA_MAX = 100, CREW_MAX = 99;
export const UNKNOWN = "unknown";
export const INTERNAL_ONLY = "能力・理由は社内用の評価。本人・相手の会社・社外への文面 (LINE・メール・見積など) には、点数も理由もひとことも、「力がある」のような言い換えも書かない";
const MONITOR = "LINE監視"; // 監視ジョブのトークンは人の評価を書かない

// 「運転移動」「運転・移動」「運転 移動」を同じに扱う
const squash = (s) => String(s ?? "").normalize("NFKC").replace(/[\s・･·/／]/g, "");
const norm = (s) => squash(s).toLowerCase();
const BY_NAME = new Map(ABILITY_ITEMS.map((it) => [squash(it.key), it]));
export const itemOf = (name) => BY_NAME.get(squash(name)) || null;
const itemError = (k) => new Error(`能力の項目名が違う: ${k}。使える名前: ${ABILITY_ITEMS.map((it) => it.key).join(" / ")}`);

// ── 入力の読み取り
// 点数 1〜5 / "unknown" (不明) / null (未入力に戻す。旧仕様の 0 も同じ)
export function parseScoreValue(item, raw) {
  if (raw === null || raw === "" || raw === 0 || raw === "0") return { clear: true };
  if (typeof raw === "string" && /^(unknown|不明)$/i.test(raw.trim())) return { unknown: true };
  const v = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof v !== "number" || !Number.isInteger(v) || v < SCORE_MIN || v > SCORE_MAX) {
    throw new Error(`${item.key} は ${SCORE_MIN}〜${SCORE_MAX} の整数 (不明は "unknown"、未入力に戻すなら null) (指定: ${JSON.stringify(raw)})`);
  }
  return { score: v };
}
function asObject(input, what) {
  let o = input;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { /* 下で止める */ } }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} は { 項目名: 値 } の形で渡す`);
  return o;
}
// { 力: 4, 体力: "unknown", 信用: null } → Map(項目名 → op)
export function parseScores(input, what = "scores") {
  const ops = new Map();
  for (const [k, raw] of Object.entries(asObject(input, what))) {
    const item = itemOf(k); if (!item) throw itemError(k);
    ops.set(item.key, parseScoreValue(item, raw));
  }
  return ops;
}
// { 力: "重い物をよく運ぶ", 体力: "" } → Map(項目名 → 文字列 | null)  (空・null は理由を消す)
export function parseReasons(input) {
  const ops = new Map();
  for (const [k, raw] of Object.entries(asObject(input, "reasons"))) {
    const item = itemOf(k); if (!item) throw itemError(k);
    if (raw === null || raw === undefined) { ops.set(item.key, null); continue; }
    const t = String(raw).trim();
    if ([...t].length > REASON_MAX) throw new Error(`${item.key} の理由は ${REASON_MAX} 字まで (${[...t].length} 字)`);
    ops.set(item.key, t || null);
  }
  return ops;
}
// はい / いいえ / 不明。null・"" は未入力に戻す
export function parseYN(raw, field) {
  if (raw === null || raw === "") return null;
  if (raw === true) return "yes";
  if (raw === false) return "no";
  const t = String(raw).trim().toLowerCase();
  if (["はい", "yes", "y", "true", "ok", "可", "あり"].includes(t)) return "yes";
  if (["いいえ", "no", "n", "false", "ng", "不可", "なし"].includes(t)) return "no";
  if (["不明", "unknown", "?", "？"].includes(t)) return UNKNOWN;
  throw new Error(`${field} は true / false / "unknown" (はい / いいえ / 不明)。未入力に戻すなら null (指定: ${JSON.stringify(raw)})`);
}
const ynOut = (v) => (v === "yes" ? true : v === "no" ? false : v === UNKNOWN ? UNKNOWN : null);
export function parseCrew(raw) {
  if (raw === null || raw === "" || (typeof raw === "string" && /^(unknown|不明)$/i.test(raw.trim()))) return null;
  const v = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > CREW_MAX) throw new Error(`crew_size は 0〜${CREW_MAX} の整数 (不明・未入力は null) (指定: ${JSON.stringify(raw)})`);
  return v;
}

// ── 出力の形
export const conditionsOf = (r) => ({ night_ok: ynOut(r.night_ok), crew_size: r.crew_size == null ? null : Number(r.crew_size), has_car: ynOut(r.has_car), area: r.area || null });
const stateOf = (row) => ({ scores: row && row.scores && typeof row.scores === "object" ? row.scores : {}, note: row ? row.note ?? null : null, unknown_person: !!(row && row.unknown_person) });
// 保存形 { 項目: { score?, unknown?, reason? } } → { scores: { 項目: 4 | "unknown" } (未入力は出さない = null), reasons: { 項目: 文字列 } }
function entriesOut(scores) {
  const s = {}, rs = {};
  for (const it of ABILITY_ITEMS) {
    const e = scores && scores[it.key]; if (!e) continue;
    if (Number.isInteger(e.score)) s[it.key] = e.score; else if (e.unknown) s[it.key] = UNKNOWN;
    if (e.reason) rs[it.key] = e.reason;
  }
  return { s, rs };
}
const hasAny = (r) => { const { s, rs } = entriesOut(stateOf(r).scores); return Object.keys(s).length > 0 || Object.keys(rs).length > 0 || !!r.note || !!r.unknown_person; };
export function rowOut(r) {
  const { s, rs } = entriesOut(stateOf(r).scores);
  return { by: r.rated_by, scores: s, reasons: Object.keys(rs).length ? rs : undefined, note: r.note || undefined, unknown_person: !!r.unknown_person, at: r.rated_at };
}
// 付けた人の平均 (数値の点数だけ。不明・未入力は数えない)
export function averages(rows) {
  const out = {};
  for (const it of ABILITY_ITEMS) {
    const v = rows.map((r) => stateOf(r).scores[it.key]).filter((e) => e && Number.isInteger(e.score)).map((e) => e.score);
    if (v.length) out[it.key] = Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
  }
  return out;
}
// 1 人分の書き換え (純粋関数): 渡された項目だけ変える
export function applyOps(state, { scoreOps, reasonOps, note, unknownPerson }) {
  let scores = { ...state.scores }, unknown = state.unknown_person;
  if (unknownPerson === true) { scores = {}; unknown = true; }
  else {
    for (const [k, op] of scoreOps) {
      const e = { ...(scores[k] || {}) }; delete e.score; delete e.unknown;
      if (op.score !== undefined) e.score = op.score; else if (op.unknown) e.unknown = true;
      scores[k] = e;
    }
    for (const [k, t] of reasonOps) { const e = { ...(scores[k] || {}) }; if (t) e.reason = t; else delete e.reason; scores[k] = e; }
    for (const k of Object.keys(scores)) { const e = scores[k]; if (!Number.isInteger(e.score) && !e.unknown && !e.reason) delete scores[k]; }
    unknown = unknownPerson === false ? false : (scoreOps.size || reasonOps.size || note !== undefined ? false : unknown);
  }
  return { scores, note: note !== undefined ? note || null : state.note, unknown_person: unknown };
}

// 前の版 (13 列・0〜5。genba_contact_abilities) の列と項目名の対応。移行にだけ使う
const LEGACY = [["力", "power"], ["体力", "stamina"], ["現場の正確さ", "site_accuracy"], ["現場のスピード", "site_speed"], ["運転・移動", "driving"], ["職人の仕切り", "crew_lead"], ["電話・交渉", "negotiation"], ["段取り・日程", "planning"], ["気づき・検討", "insight"], ["図面・納まり", "drawings"], ["数字・書類", "numbers_docs"], ["ネット手配", "online_ordering"], ["信用", "trust"]];

export function createAbility({ getPool, ready, resolveContact, loadContacts, contactsOut, contactScore, normName }) {
  async function ensureSchema(p) {
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_contact_ratings (
        contact_id     BIGINT NOT NULL REFERENCES genba_contacts(id) ON DELETE CASCADE,
        rated_by       TEXT NOT NULL,                       -- 付けた人 (トークンから)
        scores         JSONB NOT NULL DEFAULT '{}',         -- { 項目名: { score?: 1〜5, unknown?: true, reason?: 文字列 } }。無い項目 = 未入力
        note           TEXT,                                -- ひとこと
        unknown_person BOOLEAN NOT NULL DEFAULT false,      -- この人は知らない (人まるごと不明)
        rated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 付けた日時 (最後に書き換えた時刻)
        rev            INTEGER NOT NULL DEFAULT 0,          -- 同時に書かれても消し合わないための版
        PRIMARY KEY (contact_id, rated_by)
      )`);
    // 条件とチーム: 点数ではない、連絡先ごとの事実。どれも NULL 可の追加の列だけ (既存の行・既存のツールには影響しない)
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS night_ok TEXT CHECK (night_ok IN ('yes','no','unknown'))`);
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS crew_size INTEGER CHECK (crew_size >= 0)`);
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS has_car TEXT CHECK (has_car IN ('yes','no','unknown'))`);
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS area TEXT`);
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS team_lead_id BIGINT REFERENCES genba_contacts(id) ON DELETE SET NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_contacts_team_idx ON genba_contacts (team_lead_id) WHERE team_lead_id IS NOT NULL`);
    // 前の版 (13 列・0〜5) のテーブルがあれば、中身を新しい形に写して、名前を変えて残す (消さない)。失敗しても起動は止めない
    try {
      const old = await p.query(`SELECT to_regclass('genba_contact_abilities') AS t`);
      if (old.rows[0] && old.rows[0].t) {
        const { rows } = await p.query(`SELECT * FROM genba_contact_abilities`);
        for (const r of rows) {
          const scores = {};
          for (const [label, col] of LEGACY) if (Number(r[col]) > 0) scores[label] = { score: Number(r[col]) };
          await p.query(
            `INSERT INTO genba_contact_ratings (contact_id, rated_by, scores, note, rated_at) VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (contact_id, rated_by) DO NOTHING`,
            [r.contact_id, r.rated_by, JSON.stringify(scores), r.note || null, r.rated_at]);
        }
        await p.query(`ALTER TABLE genba_contact_abilities RENAME TO genba_contact_abilities_v1`);
      }
    } catch (e) { console.warn("[genba] ability migrate", e.message); }
  }

  async function ratingRows(p, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    return (await p.query(`SELECT * FROM genba_contact_ratings WHERE contact_id = ANY($1::bigint[]) ORDER BY rated_at DESC, rated_by`, [list])).rows;
  }
  const brief = (r) => ({ id: Number(r.id), name: r.name, company: r.company || null, trade: r.trade || null });
  // contactsOut が使う: 連絡先 1 人ごとの { abilities, ability_avg, conditions, team }。読めなくても連絡先の返り値は壊さない
  async function forContacts(p, rows) {
    const map = new Map();
    for (const r of rows) map.set(Number(r.id), { abilities: [], ability_avg: undefined, conditions: conditionsOf(r), team: { lead: null, members: [] } });
    const ids = rows.map((r) => Number(r.id));
    try {
      const by = new Map();
      for (const r of await ratingRows(p, ids)) { if (!hasAny(r)) continue; const k = Number(r.contact_id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
      for (const [k, rs] of by) { const m = map.get(k); if (!m) continue; m.abilities = rs.map(rowOut); const avg = averages(rs); m.ability_avg = Object.keys(avg).length ? avg : undefined; }
    } catch (e) { console.warn("[genba] contact abilities", e.message); }
    try {
      const leadIds = [...new Set(rows.map((r) => r.team_lead_id).filter((x) => x != null).map(Number))];
      if (leadIds.length) {
        const leads = new Map((await p.query(`SELECT id, name, company, trade FROM genba_contacts WHERE id = ANY($1::bigint[])`, [leadIds])).rows.map((r) => [Number(r.id), brief(r)]));
        for (const r of rows) if (r.team_lead_id != null) map.get(Number(r.id)).team.lead = leads.get(Number(r.team_lead_id)) || { id: Number(r.team_lead_id) };
      }
      const mem = (await p.query(`SELECT id, name, company, trade, team_lead_id FROM genba_contacts WHERE team_lead_id = ANY($1::bigint[]) ORDER BY name`, [ids])).rows;
      for (const r of mem) { const m = map.get(Number(r.team_lead_id)); if (m) m.team.members.push(brief(r)); }
    } catch (e) { console.warn("[genba] contact team", e.message); }
    return map;
  }

  // 連絡先を引く (書き込み用)。ID か、名前・呼び名の「一致 / 前方一致」(点数 3 以上) だけを確定として扱う。
  // 「加藤くんの息子」が「加藤くん」に化けないよう、検索語のほうが長い弱い一致 (点数 1〜2) では確定しない。
  // 複数なら team (親方) と trade で絞り、それでも決まらなければ候補を並べて止まる (推測で決めない)
  async function findContact(p, ref, { trade, team } = {}) {
    const q = String(ref ?? "").trim();
    if (!q) throw new Error("contact (名前・呼び名・ID) が必要");
    if (/^\d+$/.test(q)) {
      const { rows } = await p.query(`SELECT * FROM genba_contacts WHERE id=$1`, [Number(q)]);
      if (!rows.length) throw new Error(`連絡先 ID ${q} が無い`);
      return { row: rows[0], similar: [] };
    }
    const scored = (await loadContacts(p)).map((r) => ({ r, s: contactScore(r, q) })).filter((x) => x.s > 0);
    let strong = scored.filter((x) => x.s >= 3);
    if (strong.length > 1 && team) { const lead = await resolveContact(p, team); strong = strong.filter((x) => Number(x.r.team_lead_id) === Number(lead.id) || Number(x.r.id) === Number(lead.id)); }
    if (strong.length > 1 && trade) strong = strong.filter((x) => x.r.trade && (norm(x.r.trade).includes(norm(trade)) || norm(trade).includes(norm(x.r.trade))));
    if (strong.length > 1) throw new Error(`候補が複数: ${strong.map((x) => `#${x.r.id} ${x.r.name}${x.r.company ? ` (${x.r.company})` : ""}`).join(" / ")}。ID か、team (親方の名前)・trade で指定する (推測で決めない)`);
    const similar = scored.filter((x) => x.s < 3).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => brief(x.r));
    return { row: strong[0] ? strong[0].r : null, similar };
  }
  async function mustFind(p, ref, hint) {
    const { row } = await findContact(p, ref);
    if (!row) throw new Error(`連絡先が見つからない: ${ref}。${hint}`);
    return row;
  }

  // 1 人 × 1 人の付けた人の書き換え。同時に書かれても消し合わないよう、版 (rev) が変わっていたら読み直して最大 5 回やり直す
  async function writeRating(p, contactId, by, ops) {
    for (let i = 0; i < 5; i++) {
      const { rows } = await p.query(`SELECT * FROM genba_contact_ratings WHERE contact_id=$1 AND rated_by=$2`, [contactId, by]);
      const prev = rows[0] || null;
      const next = applyOps(stateOf(prev), ops);
      const args = [contactId, by, JSON.stringify(next.scores), next.note, next.unknown_person];
      const r = prev
        ? await p.query(`UPDATE genba_contact_ratings SET scores=$3::jsonb, note=$4, unknown_person=$5, rated_at=now(), rev=rev+1 WHERE contact_id=$1 AND rated_by=$2 AND rev=$6 RETURNING *`, [...args, prev.rev])
        : await p.query(`INSERT INTO genba_contact_ratings (contact_id, rated_by, scores, note, unknown_person) VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (contact_id, rated_by) DO NOTHING RETURNING *`, args);
      if (r.rows.length) return { prev, row: r.rows[0] };
    }
    throw new Error("同じ人の点数が同時に書き換えられていて保存できなかった。もう一度送る");
  }

  const scoreSchema = (it) => ({ type: ["integer", "string", "null"], minimum: SCORE_MIN, maximum: SCORE_MAX, description: `${it.hint}。${SCORE_MIN}〜${SCORE_MAX}、不明は "unknown"、null で未入力に戻す` });
  const names = ABILITY_ITEMS.map((it) => it.key).join(" / ");
  const ynSchema = (d) => ({ type: ["boolean", "string", "null"], description: `${d}。true / false / "unknown" (不明)、null で未入力に戻す` });

  function tools(by) {
    return [
      {
        name: "genba_contact_ability_set",
        description: `連絡先に能力 (点数) を書く。項目 (${ABILITY_ITEMS.length}): ${names}。各項目は ${SCORE_MIN}〜${SCORE_MAX} の整数 (単価だけ 5＝安い)、"unknown" = 不明と明示、null = 未入力に戻す。付けた人はトークンから (小西のトークンなら小西の点数、名取なら名取の点数。人ごとに別々に残る)。scores・reasons は変えたい項目だけ渡せばよい (渡さなかった項目は今のまま)。reasons = 項目ごとの理由 (${REASON_MAX} 字まで、"" で消す)、note = その人のひとこと (${NOTE_MAX} 字まで、"" で消す)、unknown_person = true で「この人は知らない」(自分の点数・理由を全部消して人まるごと不明にする。scores と一緒には渡せない。後から点数を付ければ自動で false に戻る)。contact は名前・呼び名・ID。見つからなければ、team (親方の名前、登録済みの人) と trade (職種) を付けて職人として新規に作る (既存の連絡先の team / trade は変えない。変えるなら genba_contact_upsert)。その人の評価を人から言われたときだけ書く。AI が推測で点数を付けない。${INTERNAL_ONLY}`,
        inputSchema: {
          type: "object", required: ["contact"],
          properties: {
            contact: { type: "string", description: "名前・呼び名・ID。一意に引けないと止まる (ID か team・trade で指定)" },
            scores: { type: "object", description: '{ "力": 4, "体力": "unknown", "信用": 5 }', properties: Object.fromEntries(ABILITY_ITEMS.map((it) => [it.key, scoreSchema(it)])) },
            reasons: { type: "object", description: '{ "力": "重い物をよく運んでいる" }', additionalProperties: { type: ["string", "null"] } },
            note: { type: "string", description: `その人のひとこと (${NOTE_MAX} 字まで)` },
            unknown_person: { type: "boolean", description: "この人は知らない (人まるごと不明)" },
            team: { type: "string", description: "新規に作るときだけ使う: 親方の名前 (登録済みの連絡先)" },
            trade: { type: "string", description: "新規に作るときだけ使う、または同名が複数のときの絞り込み: 職種" },
          },
        },
        handler: async (a) => {
          await ready();
          if (by === MONITOR) throw new Error("監視ジョブのトークンでは能力を付けられない (人の評価)");
          const p = getPool();
          const given = (v) => v !== undefined;
          const scoreOps = given(a.scores) && a.scores !== null ? parseScores(a.scores) : new Map();
          const reasonOps = given(a.reasons) && a.reasons !== null ? parseReasons(a.reasons) : new Map();
          let note;
          if (given(a.note) && a.note !== null) { note = String(a.note).trim(); if ([...note].length > NOTE_MAX) throw new Error(`note は ${NOTE_MAX} 字まで (${[...note].length} 字)`); }
          const unknownPerson = given(a.unknown_person) && a.unknown_person !== null ? (a.unknown_person === true || a.unknown_person === "true" ? true : a.unknown_person === false || a.unknown_person === "false" ? false : (() => { throw new Error("unknown_person は true / false"); })()) : undefined;
          if (!scoreOps.size && !reasonOps.size && note === undefined && unknownPerson === undefined) throw new Error("scores / reasons / note / unknown_person のどれかが必要");
          if (unknownPerson === true && (scoreOps.size || reasonOps.size)) throw new Error("unknown_person=true (この人は知らない) と scores / reasons は一緒に渡せない");
          const trade = a.trade ? String(a.trade).trim() : "";
          const warnings = [];
          const { row: found, similar } = await findContact(p, a.contact, { trade, team: a.team });
          let c = found, created = false;
          if (!c) {
            const name = String(a.contact).trim();
            if (/^\d+$/.test(name)) throw new Error(`連絡先 ID ${name} が無い`);
            const nameKey = normName(name);
            if (!nameKey) throw new Error("contact の名前が読めない");
            const lead = a.team ? await resolveContact(p, a.team) : null;   // 親方が登録されていなければここで止まる (連絡先は作らない)
            const ins = await p.query(
              `INSERT INTO genba_contacts (name, name_key, company, company_key, aliases, role, trade, channels, site_ids, updated_by, team_lead_id)
               VALUES ($1,$2,NULL,'','[]'::jsonb,'職人',$3,'[]'::jsonb,'[]'::jsonb,$4,$5) RETURNING *`,
              [name, nameKey, trade || null, by, lead ? lead.id : null]);
            c = ins.rows[0]; created = true;
            if (similar.length) warnings.push(`近い名前の連絡先がある: ${similar.map((s) => `#${s.id} ${s.name}${s.company ? ` (${s.company})` : ""}`).join(" / ")}。同じ人なら重複 (genba_contact_remove で消して ID で付け直す)、別の人ならそのまま`);
          } else {
            if (a.team) {
              try { const lead = await resolveContact(p, a.team); if (Number(c.team_lead_id) !== Number(lead.id)) warnings.push(`既存の連絡先 (#${c.id} ${c.name}) なので team は変えていない (変えるなら genba_contact_upsert の team)`); }
              catch (e) { warnings.push(`既存の連絡先 (#${c.id} ${c.name}) なので team は使っていない (${e.message})`); }
            }
            if (trade && c.trade && norm(c.trade) !== norm(trade)) warnings.push(`既存の連絡先 (#${c.id} ${c.name}) なので trade は変えていない (今: ${c.trade})`);
          }
          const { prev, row } = await writeRating(p, c.id, by, { scoreOps, reasonOps, note, unknownPerson });
          const before = entriesOut(stateOf(prev).scores).s, after = entriesOut(stateOf(row).scores).s;
          const changed = [...scoreOps.keys()].filter((k) => (before[k] ?? null) !== (after[k] ?? null)).map((k) => ({ item: k, from: before[k] ?? null, to: after[k] ?? null }));
          const all = (await ratingRows(p, [c.id])).filter(hasAny);
          return {
            contact: { id: Number(c.id), name: c.name, company: c.company || null, trade: c.trade || null }, created,
            ability: rowOut(row), changed,
            raters: all.map((r) => r.rated_by), ability_avg: all.length > 1 ? averages(all) : undefined,
            warnings: warnings.length ? warnings : undefined, reminder: INTERNAL_ONLY,
          };
        },
      },
      {
        name: "genba_contact_condition_set",
        description: "連絡先に条件 (点数ではない事実) を書く。night_ok = 夜間 OK か (true / false / \"unknown\" = 不明)、crew_size = 連れて来られる人数 (整数、0 以上)、has_car = 車あり・資材を積めるか (true / false / \"unknown\")、area = 対応エリア (文字列)。渡した項目だけ変わる (渡さなかった項目は今のまま、null で未入力に戻す)。付けた人ごとには持たない (連絡先に 1 つ)。見つからない連絡先は作らない (新しく作るのは genba_contact_ability_set / genba_contact_upsert)。条件は手配の候補を探す材料 (genba_contact_ability_find)。本人から聞いた事実だけ書く。" + INTERNAL_ONLY,
        inputSchema: {
          type: "object", required: ["contact"],
          properties: {
            contact: { type: "string", description: "名前・呼び名・ID" },
            night_ok: ynSchema("夜間 OK か"),
            crew_size: { type: ["integer", "string", "null"], minimum: 0, maximum: CREW_MAX, description: "連れて来られる人数 (整数)。不明・未入力は null" },
            has_car: ynSchema("車あり・資材を積めるか"),
            area: { type: ["string", "null"], description: `対応エリア (${AREA_MAX} 字まで。例: 東京23区・埼玉南部)。"" か null で消す` },
          },
        },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const sets = [], vals = [], fields = [];
          const add = (col, v, name) => { vals.push(v); sets.push(`${col}=$${vals.length + 1}`); fields.push([name, col]); };
          if (a.night_ok !== undefined) add("night_ok", parseYN(a.night_ok, "night_ok"), "night_ok");
          if (a.crew_size !== undefined) add("crew_size", parseCrew(a.crew_size), "crew_size");
          if (a.has_car !== undefined) add("has_car", parseYN(a.has_car, "has_car"), "has_car");
          if (a.area !== undefined) {
            const t = a.area === null ? "" : String(a.area).trim();
            if ([...t].length > AREA_MAX) throw new Error(`area は ${AREA_MAX} 字まで (${[...t].length} 字)`);
            add("area", t || null, "area");
          }
          if (!sets.length) throw new Error("night_ok / crew_size / has_car / area のどれかが必要");
          const c = await mustFind(p, a.contact, "新しく作るなら genba_contact_ability_set (team と trade を付ける) か genba_contact_upsert");
          const { rows } = await p.query(`UPDATE genba_contacts SET ${sets.join(", ")}, updated_by=$${vals.length + 2}, updated_at=now() WHERE id=$1 RETURNING *`, [c.id, ...vals, by]);
          const was = conditionsOf(c), now = conditionsOf(rows[0]);
          return {
            contact: { id: Number(c.id), name: c.name, company: c.company || null, trade: c.trade || null },
            conditions: now,
            changed: fields.map(([n]) => ({ field: n, from: was[n], to: now[n] })).filter((x) => x.from !== x.to),
            reminder: INTERNAL_ONLY,
          };
        },
      },
      {
        name: "genba_contact_ability_find",
        description: `能力と条件で連絡先を探す (手配の候補探し)。例「力 4 以上で夜 OK」→ min={"力":4}, night_ok=true、「信用 4 以上かつ大工」→ min={"信用":4}, trade="大工"、「まちゃのチーム」→ team="まちゃ"。条件は全部満たす人だけ (かつ)。min の点数は付けた人の平均 (数値だけ。不明・未入力は数えず、点数の無い項目は条件を満たさない)、by="小西" で小西が付けた点数だけで見る。点数の高い順 (min の項目の合計) に返し、各人に abilities (付けた人ごとの点数・理由・ひとこと) と ability_avg (平均) と conditions と team が付く。点数の条件 (min) が無ければ、条件・チームだけで探せる (点数が無い人も入る)。全部空なら能力か条件が入っている人の一覧。${INTERNAL_ONLY}`,
        inputSchema: {
          type: "object",
          properties: {
            min: { type: "object", description: '最低点 {"力": 4, "信用": 4}', properties: Object.fromEntries(ABILITY_ITEMS.map((it) => [it.key, { type: "integer", minimum: SCORE_MIN, maximum: SCORE_MAX, description: it.hint }])) },
            night_ok: { type: ["boolean", "string"], description: '夜間 OK (true / false / "unknown")' },
            has_car: { type: ["boolean", "string"], description: '車あり・資材を積める (true / false / "unknown")' },
            crew_min: { type: "integer", description: "連れて来られる人数がこれ以上" },
            area: { type: "string", description: "対応エリアに含まれる言葉 (部分一致)" },
            trade: { type: "string", description: "職種 (大工・防水・電気…)。部分一致" },
            role: { type: "string", description: "職人 / 業者 / 元請け / 設計 / 客先 / 社内" },
            team: { type: "string", description: "親方の名前。その人のチーム (親方本人を含む)" },
            by: { type: "string", description: "誰が付けた点数で見るか (小西 / 名取)。省略 = 付けた人の平均" },
            limit: { type: "integer", description: "既定 20、最大 50" },
          },
        },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const mins = a.min === undefined || a.min === null ? [] : [...parseScores(a.min, "min")].map(([k, op]) => {
            if (op.score === undefined) throw new Error(`min の ${k} は ${SCORE_MIN}〜${SCORE_MAX} の整数`);
            return { item: k, value: op.score };
          });
          const wantNight = a.night_ok === undefined || a.night_ok === null ? undefined : parseYN(a.night_ok, "night_ok");
          const wantCar = a.has_car === undefined || a.has_car === null ? undefined : parseYN(a.has_car, "has_car");
          if (wantNight === null || wantCar === null) throw new Error("night_ok / has_car は true / false / \"unknown\"");
          const crewMin = a.crew_min === undefined || a.crew_min === null ? undefined : parseCrew(a.crew_min);
          const who = a.by ? String(a.by).trim() : null;
          const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
          const lead = a.team ? await mustFind(p, a.team, "team は親方の名前 (登録済みの連絡先)") : null;
          let rows = await loadContacts(p);
          if (a.role) rows = rows.filter((r) => norm(r.role) === norm(a.role));
          if (a.trade) rows = rows.filter((r) => r.trade && (norm(r.trade).includes(norm(a.trade)) || norm(a.trade).includes(norm(r.trade))));
          if (lead) rows = rows.filter((r) => Number(r.team_lead_id) === Number(lead.id) || Number(r.id) === Number(lead.id));
          const yn = (want, v) => (want === UNKNOWN ? v === UNKNOWN || v == null : v === want);
          if (wantNight !== undefined) rows = rows.filter((r) => yn(wantNight, r.night_ok));
          if (wantCar !== undefined) rows = rows.filter((r) => yn(wantCar, r.has_car));
          if (crewMin !== undefined && crewMin !== null) rows = rows.filter((r) => r.crew_size != null && Number(r.crew_size) >= crewMin);
          if (a.area) rows = rows.filter((r) => r.area && norm(r.area).includes(norm(a.area)));
          const byContact = new Map();
          for (const r of await ratingRows(p, rows.map((r) => r.id))) { const k = Number(r.contact_id); if (!byContact.has(k)) byContact.set(k, []); byContact.get(k).push(r); }
          const filtered = !!(mins.length || wantNight !== undefined || wantCar !== undefined || crewMin != null || a.area || a.trade || a.role || lead);
          const scored = [];
          for (const r of rows) {
            const mine = (byContact.get(Number(r.id)) || []).filter((x) => hasAny(x) && (!who || x.rated_by === who));
            const avg = averages(mine);
            if (!conds_ok(mins, avg)) continue;
            const c = conditionsOf(r);
            if (!filtered && !Object.keys(avg).length && !mine.length && c.night_ok == null && c.crew_size == null && c.has_car == null && !c.area) continue;   // 条件が全部空: 能力か条件がある人だけ
            scored.push({ r, avg, sum: mins.reduce((s, m) => s + (avg[m.item] || 0), 0) });
          }
          scored.sort((x, y) => y.sum - x.sum || String(x.r.name).localeCompare(String(y.r.name), "ja"));
          const picked = scored.slice(0, limit);
          const out = await contactsOut(p, picked.map((x) => x.r));
          out.forEach((o, i) => { o.score_used = { by: who || "付けた人の平均", scores: picked[i].avg }; });
          return {
            count: out.length, matched: scored.length,
            conditions: {
              min: Object.fromEntries(mins.map((m) => [m.item, m.value])),
              night_ok: wantNight === undefined ? undefined : ynOut(wantNight), has_car: wantCar === undefined ? undefined : ynOut(wantCar),
              crew_min: crewMin ?? undefined, area: a.area || undefined, trade: a.trade || undefined, role: a.role || undefined, team: lead ? lead.name : undefined,
              by: who || "付けた人の平均",
            },
            contacts: out, reminder: INTERNAL_ONLY,
          };
        },
      },
    ];
  }
  const conds_ok = (mins, avg) => mins.every((m) => (avg[m.item] || 0) >= m.value);

  const instructions = [
    `■ 連絡先の能力・条件・チーム。職人さんと社内の人の得意を点数で持ち、手配の候補を探す。能力 (${ABILITY_ITEMS.length} 項目: ${ABILITY_ITEMS.map((it) => it.key).join(" / ")}) は各 ${SCORE_MIN}〜${SCORE_MAX} (単価だけ 5＝安い)・不明は "unknown"・未入力は null。項目ごとに理由、人ごとにひとこと・「この人は知らない」。付けた人ごとに別の点数が残る (トークンの名前)`,
    "- 人から評価を言われたら genba_contact_ability_set(contact, scores, reasons, note)。AI が推測で付けない。変えたい項目だけ渡せばよい。登録されていない職人は team (親方) と trade を付ければその場で作れる (親方は先に登録されている人)",
    "- 夜 OK・人数・車・エリアを聞いたら genba_contact_condition_set(contact, night_ok, crew_size, has_car, area)。点数ではなく事実。連絡先に 1 つ",
    "- 「力 4 以上で夜 OK の人」「信用 4 以上の大工」「まちゃのチーム」のような手配の候補探しは genba_contact_ability_find(min, night_ok, has_car, crew_min, area, trade, role, team)。点数は付けた人の平均と、付けた人ごとの両方が返る。genba_contact_find / genba_contact_list の返り値の abilities・ability_avg・conditions・team も人選びの材料",
    "- チームは連絡先の team (親方)。親方に付ける: genba_contact_upsert(name, team=親方の名前)。親方本人の連絡先に members (子方) が出る",
    "- 能力・理由は社内用の評価 (評価メモと同じ扱い)。本人・相手の会社・社外への文面には、点数も理由もひとことも言い換えも書かない。社内の人への返答でも、人選びの材料に使うのはよいが、点数・理由・ひとことの原文を貼らない",
  ];

  return { ensureSchema, forContacts, tools, instructions };
}
