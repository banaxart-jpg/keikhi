// 「つながり」: 人・現場・会社の名前で引いたときに、その名前が出てくる記録と今の状態をまとめて出す
//
//   log_links      … 記録 (genba_log) と 人 / 現場 / 会社 を結ぶ線。記録するときに自動で張る (auto=true)。人が手で付けたもの (auto=false) は消さない
//   entity_states  … 人・現場・会社の「今の状態」(不在 / 繁忙 / NG日 / 注意)。ends_on を過ぎたものは返さない
//   genba_graph / genba_graph_all … 1 つの点のまとめ / グラフ表示用の全部の点と線
//
// genba-lib の既存の動き (ログ・タスク・待ち・カレンダー連携) は変えない: リンクは記録したあとに張り、失敗しても記録は残る。
// 連絡先の能力評価 (abilities) はここでは読まない・返さない。genba-lib から createLinks(deps) で使う

export const LINK_TYPES = ["contact", "site", "company"];
export const LINK_ROLES = ["mentioned", "sender", "who", "site"];
export const STATE_KINDS = ["不在", "繁忙", "NG日", "注意", "その他"];
const ROLE_RANK = { mentioned: 1, site: 2, who: 3, sender: 4 };   // 同じ点が何通りかで出てきたら、強い役割を残す
const TYPE_ALIAS = { contact: "contact", 人: "contact", 連絡先: "contact", site: "site", 現場: "site", company: "company", 会社: "company" };
const TYPE_LABEL = { contact: "人", site: "現場", company: "会社" };
const OPEN_KINDS_SQL = `'課題','次やること','待ち'`;
const BODY_HEAD = 80, STATE_BODY_MAX = 300, MIN_KEY = 2, MANUAL_MAX = 20, EDGE_ENTITIES_MAX = 15;
export const normType = (v) => TYPE_ALIAS[String(v ?? "").trim().toLowerCase()] || TYPE_ALIAS[String(v ?? "").trim()] || null;
const keyOf = (type, id) => `${type}:${Number(id)}`;
const clipHead = (s, n = BODY_HEAD) => { const cs = [...String(s || "").replace(/\s+/g, " ").trim()]; return cs.length > n ? cs.slice(0, n).join("") + "…" : cs.join(""); };
const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : "");
const dateRange = (s) => (s.starts_on && s.ends_on ? `${md(s.starts_on)}〜${md(s.ends_on)}` : s.starts_on ? `${md(s.starts_on)}〜` : s.ends_on ? `〜${md(s.ends_on)}` : "期限なし");
// 「注意: 横山さんは 11/24〜11/29 繁忙（今週は動けない）」 (message_hint の先頭に出す)
export function cautionText(name, states) {
  const parts = states.map((s) => `${dateRange(s)} ${s.kind}（${s.body}）`);
  return `注意: ${name}さんは ${parts.join(" / ")}。この期間に動く依頼は送らず、小西に出す。`;
}

export function createLinks(d) {
  const { getPool, ready, today, norm, normName, normCompany, kanaFold, ymd, autoTitle, LIVE, NOT_RESOLVED, NOT_SUPERSEDED,
    loadContacts, loadCompanies, resolveContact, resolveCompany, resolveSite, contactScore } = d;

  async function ensureSchema(p) {
    await p.query(`
      CREATE TABLE IF NOT EXISTS log_links (
        id          BIGSERIAL PRIMARY KEY,
        log_id      BIGINT NOT NULL REFERENCES genba_log(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','site','company')),
        entity_id   BIGINT NOT NULL,                                  -- genba_contacts.id / sites.id / genba_companies.id (型で変わるので FK は張らない)
        role        TEXT NOT NULL CHECK (role IN ('mentioned','sender','who','site')),
        auto        BOOLEAN NOT NULL DEFAULT true,                    -- true = 記録のときに自動で張った / false = 人 (AI) が手で付けた
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (log_id, entity_type, entity_id)
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS log_links_entity_idx ON log_links (entity_type, entity_id)`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS entity_states (
        id          BIGSERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','site','company')),
        entity_id   BIGINT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('不在','繁忙','NG日','注意','その他')),
        body        TEXT NOT NULL,
        starts_on   DATE,
        ends_on     DATE,                                             -- これを過ぎたら返さない (NULL = 期限なし)
        source_ref  TEXT,                                             -- 出どころの一意キー (同じ点・同じ source_ref は 2 回入らない)
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        voided_at   TIMESTAMPTZ,
        voided_by   TEXT
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS entity_states_entity_idx ON entity_states (entity_type, entity_id) WHERE voided_at IS NULL`);
  }

  // ── 名前の照合 (連絡先・現場・会社) ──
  const loadSites = async (p) => (await p.query(`SELECT id, name, site_code, client, done_at FROM sites ORDER BY id`)).rows;
  // 現場名の短縮形 (邸 / ビル / 店 / 2号店 / 括弧の中を除いたもの)。現場には aliases が無いので、名前そのものと合わせて照合に使う
  const siteKeys = (name) => {
    const full = kanaFold(norm(name));
    const head = kanaFold(norm(String(name).split(/[（(]/)[0]));
    const strip = (k) => k.replace(/(様邸|邸|ビル|店舗|店|[0-9]*号店|現場|工事)$/, "");
    return { full, shorts: [...new Set([head, strip(full), strip(head)].filter((k) => k && k !== full))] };
  };
  // 名前の鍵 → 持ち主 (1 つの鍵が複数の点を指すときは、どちらか決められないので本文の照合には使わない)
  async function buildMatcher(p) {
    const [contacts, sites, companies] = await Promise.all([loadContacts(p), loadSites(p), loadCompanies(p)]);
    const names = new Map();
    const exactContact = new Map();            // 人の名前 → id の集合 (who / sender の完全一致に使う。長さの下限なし)
    const owners = { contact: new Map(), site: new Map(), company: new Map() };
    const own = (type, key, id) => { if (!key) return; const m = owners[type]; if (!m.has(key)) m.set(key, new Set()); m.get(key).add(Number(id)); };
    for (const c of contacts) {
      names.set(keyOf("contact", c.id), c.name);
      for (const raw of [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]) {
        const k = normName(raw); if (!k) continue;
        if (!exactContact.has(k)) exactContact.set(k, new Set()); exactContact.get(k).add(Number(c.id));
        if ([...k].length >= MIN_KEY) own("contact", k, c.id);
      }
    }
    const fullKeys = new Set();
    for (const s of sites) { names.set(keyOf("site", s.id), s.name); const { full } = siteKeys(s.name); if ([...full].length >= MIN_KEY) { own("site", full, s.id); fullKeys.add(full); } }
    // 短縮形 (邸・店などを除いたもの) は、3 文字以上で、他の現場の正式名や人・会社の名前とぶつからないものだけ (「横山邸」の「横山」が人の横山さんと混ざらないように)
    for (const s of sites) for (const k of siteKeys(s.name).shorts) if ([...k].length >= 3 && !fullKeys.has(k) && !owners.contact.has(k) && !owners.company.has(k)) own("site", k, s.id);
    for (const k of companies) {
      names.set(keyOf("company", k.id), k.name);
      for (const raw of [k.name, ...(Array.isArray(k.aliases) ? k.aliases : [])]) { const key = normCompany(raw); if ([...key].length >= MIN_KEY) own("company", key, k.id); }
    }
    const entries = (type) => [...owners[type]].filter(([, ids]) => ids.size === 1).map(([key, ids]) => ({ key, id: [...ids][0] }));
    const E = { contact: entries("contact"), site: entries("site"), company: entries("company") };
    return {
      names,
      nameOf: (type, id) => names.get(keyOf(type, id)) || null,
      lookupContact: (raw) => { const s = exactContact.get(normName(raw)); return s && s.size === 1 ? [...s][0] : null; },
      // 本文に名前が出てくる点 (さんの有無・かな/カナ・全角/半角は鍵の側で吸収済み)
      match(text) {
        const t = kanaFold(norm(text)), tc = normCompany(text), out = [];
        // 同じ種類で、別の点の長い名前に含まれる名前は外す (「行田屋2号店」に出てきた「行田屋」を別の現場と取り違えない)
        const longest = (type, hits) => hits.filter((h) => !hits.some((o) => o.id !== h.id && o.key.length > h.key.length && o.key.includes(h.key))).map((h) => ({ type, id: h.id }));
        out.push(...longest("contact", E.contact.filter((e) => t.includes(e.key))));
        out.push(...longest("site", E.site.filter((e) => t.includes(e.key))));
        out.push(...longest("company", E.company.filter((e) => tc.includes(e.key))));
        return out;
      },
    };
  }

  // ── 記録 1 行 → 張るリンクの一覧 (DB には触らない)。site → site / who → who / source の送り主 → sender / 本文の名前 → mentioned / 手で付けたもの ──
  function computeLinks(m, log, { source, manual = [] } = {}) {
    const found = new Map();
    // 同じ点が何通りかで出てきたら 1 本にまとめる: 手で付けたものが自動より優先、同じ種類どうしなら強い役割を残す
    const put = (type, id, role, auto = true) => {
      if (id == null) return;
      const k = keyOf(type, id), cur = found.get(k);
      const wins = !cur || (!auto && cur.auto) || (auto === cur.auto && ROLE_RANK[role] > ROLE_RANK[cur.role]);
      if (wins) found.set(k, { type, id: Number(id), role, auto });
    };
    if (log.site_id != null) put("site", log.site_id, "site");
    for (const w of String(log.who || "").split(/[,、/／・&＆\s]+/).filter(Boolean)) put("contact", m.lookupContact(w), "who");
    const src = source && typeof source === "object" ? source : (log.source && typeof log.source === "object" ? log.source : null);
    if (src) {
      if (src.contact_id != null && Number.isInteger(Number(src.contact_id))) put("contact", Number(src.contact_id), "sender");
      else if (src.sender) put("contact", m.lookupContact(src.sender), "sender");
    }
    for (const h of m.match(`${log.title || ""} ${log.body || ""}`)) put(h.type, h.id, "mentioned");
    for (const x of manual) put(x.type, x.id, x.role || "mentioned", false);
    return [...found.values()];
  }
  const linkOut = (m, l) => ({ type: l.type, id: l.id, name: m.nameOf(l.type, l.id), role: l.role, auto: !!l.auto });

  async function writeLinks(p, logId, list) {
    for (const l of list) {
      if (l.auto) await p.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) VALUES ($1,$2,$3,$4,true) ON CONFLICT (log_id, entity_type, entity_id) DO NOTHING`, [logId, l.type, l.id, l.role]);
      else await p.query(`INSERT INTO log_links (log_id, entity_type, entity_id, role, auto) VALUES ($1,$2,$3,$4,false) ON CONFLICT (log_id, entity_type, entity_id) DO UPDATE SET role=EXCLUDED.role, auto=false`, [logId, l.type, l.id, l.role]);
    }
  }
  // genba_log_add / add_many: 記録したあとに呼ぶ。返り値 = 張ったリンクの一覧 (ctx に鍵の表を持たせて、まとめて入れるときの読み込みを 1 回にする)
  async function link(p, log, { source, manual = [], ctx = {} } = {}) {
    const m = ctx.linkMatcher || (ctx.linkMatcher = await buildMatcher(p));
    const list = computeLinks(m, log, { source, manual });
    await writeLinks(p, log.id, list);
    return list.map((l) => linkOut(m, l));
  }
  // 記録を直したとき (title / body / site / who): 自動のリンクだけ張り直す。手で付けたものは残す
  async function relink(p, log) {
    await p.query(`DELETE FROM log_links WHERE log_id=$1 AND auto=true`, [log.id]);
    const m = await buildMatcher(p);
    const list = computeLinks(m, log, {});
    await writeLinks(p, log.id, list);
    return list.map((l) => linkOut(m, l));
  }
  // links: [{ type, id か name, role? }] を、記録の前に確かめる (違えば記録する前にエラー)
  async function resolveManual(p, input) {
    if (!Array.isArray(input)) throw new Error("links は [{ type, id か name }] の配列");
    if (input.length > MANUAL_MAX) throw new Error(`links は ${MANUAL_MAX} 件まで`);
    const out = [];
    for (const it of input) {
      if (!it || typeof it !== "object") throw new Error("links の要素は { type, id か name }");
      const type = normType(it.type);
      if (!type) throw new Error(`links の type は ${LINK_TYPES.join(" / ")} (指定: ${it.type})`);
      const ref = it.id != null && it.id !== "" ? String(it.id) : it.name != null ? String(it.name).trim() : "";
      if (!ref) throw new Error("links の要素には id か name が必要");
      const role = it.role == null || it.role === "" ? "mentioned" : String(it.role);
      if (!LINK_ROLES.includes(role)) throw new Error(`links の role は ${LINK_ROLES.join(" / ")}`);
      if (role === "site" && type !== "site") throw new Error("role=site は現場にだけ付けられる");
      if ((role === "who" || role === "sender") && type !== "contact") throw new Error(`role=${role} は人にだけ付けられる`);
      const row = type === "contact" ? await resolveContact(p, ref) : type === "site" ? await resolveSite(p, ref) : await resolveCompany(p, ref);
      out.push({ type, id: Number(row.id), role });
    }
    return out;
  }

  // ── 状態 (entity_states) ──
  const stateRow = (r, todayStr) => {
    const starts = ymd(r.starts_on), ends = ymd(r.ends_on);
    return { id: Number(r.id), kind: r.kind, body: r.body, starts_on: starts, ends_on: ends, upcoming: starts && starts > todayStr ? true : undefined, source_ref: r.source_ref || undefined, by: r.created_by || undefined, at: r.created_at };
  };
  // 今有効な状態: 取り消されていない・ends_on を過ぎていない (これから始まるものも「upcoming」で出す: 来週の NG をいま知らせるため)
  async function activeStates(p, type, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    const map = new Map();
    if (!list.length) return map;
    const t = today();
    const { rows } = await p.query(
      `SELECT * FROM entity_states WHERE entity_type=$1 AND entity_id = ANY($2::bigint[]) AND voided_at IS NULL AND (ends_on IS NULL OR ends_on >= $3::date)
        ORDER BY entity_id, COALESCE(starts_on, DATE '1900-01-01'), id`, [type, list, t]);
    for (const r of rows) { const k = Number(r.entity_id); if (!map.has(k)) map.set(k, []); map.get(k).push(stateRow(r, t)); }
    return map;
  }
  const logBrief = (r) => ({
    id: Number(r.id), kind: r.kind, title: r.title || autoTitle(r.body), site: r.site_id ? { id: Number(r.site_id), name: r.site_name } : null,
    due_on: ymd(r.due_on), who: r.who || undefined, role: r.link_role || undefined, at: r.created_at, body: clipHead(r.body),
  });
  // 連絡先ごとの、つながっている未解決の記録 (本文に名前が出るものも含む)
  async function linkedOpen(p, contactIds, limit = 10) {
    const map = new Map();
    const ids = [...new Set((contactIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return map;
    const { rows } = await p.query(
      `SELECT l.*, s.name AS site_name, k.role AS link_role, k.entity_id AS link_entity
         FROM log_links k JOIN genba_log l ON l.id = k.log_id LEFT JOIN sites s ON s.id = l.site_id
        WHERE k.entity_type='contact' AND k.entity_id = ANY($1::bigint[]) AND l.kind IN (${OPEN_KINDS_SQL}) AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}
        ORDER BY l.due_on NULLS LAST, l.created_at DESC`, [ids]);
    for (const r of rows) { const k = Number(r.link_entity); if (!map.has(k)) map.set(k, []); if (map.get(k).length < limit) map.get(k).push(logBrief(r)); }
    return map;
  }
  // genba_contact_find の返り値に足す: active_states / linked_open。状態があれば message_hint の先頭に注意を出す。失敗しても find は壊さない
  async function decorateFind(p, out) {
    try {
      const ids = out.map((o) => o.id);
      const [st, lo] = await Promise.all([activeStates(p, "contact", ids), linkedOpen(p, ids)]);
      for (const o of out) {
        o.active_states = st.get(o.id) || [];
        o.linked_open = lo.get(o.id) || [];
        if (o.active_states.length && o.message_hint) o.message_hint = `${cautionText(o.name, o.active_states)} ${o.message_hint}`;
      }
    } catch (e) { console.warn("[genba] find states", e.message); }
  }
  // genba_status(site) に足す: その現場の状態と、関わる人 (現場に登録された人 + この現場の記録の who / sender) の状態
  async function statusExtras(p, site, people) {
    try {
      const sid = Number(site.id);
      const ids = new Set((people || []).map((c) => Number(c.id)));
      const { rows } = await p.query(
        `SELECT DISTINCT k.entity_id FROM log_links k JOIN genba_log l ON l.id = k.log_id
          WHERE k.entity_type='contact' AND k.role IN ('who','sender') AND l.site_id=$1 AND l.voided_at IS NULL AND l.created_at >= now() - interval '120 days'`, [sid]);
      for (const r of rows) ids.add(Number(r.entity_id));
      const [own, per] = await Promise.all([activeStates(p, "site", [sid]), activeStates(p, "contact", [...ids])]);
      const contacts = await loadContacts(p);
      const nameOf = new Map(contacts.map((c) => [Number(c.id), c.name]));
      const people_states = [...per].map(([id, states]) => ({ contact: { id, name: nameOf.get(id) || null }, states })).filter((x) => x.contact.name);
      const out = {};
      if (own.get(sid)?.length) out.active_states = own.get(sid);
      if (people_states.length) out.people_states = people_states;
      return out;
    } catch (e) { console.warn("[genba] status states", e.message); return {}; }
  }

  // ── 点の特定 (人・現場・会社の名前か ID) ──
  const companyKeyScore = (r, q) => {
    const qn = normCompany(q); if (!qn) return 0;
    let best = 0;
    for (const raw of [r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])]) {
      const k = normCompany(raw); if (!k) continue;
      if (k === qn) return 4;
      if (k.startsWith(qn)) best = Math.max(best, 3);
      else if ([...qn].length >= 2 && [...k].length >= 2 && (k.includes(qn) || qn.includes(k))) best = Math.max(best, 2);
    }
    return best;
  };
  const siteScore = (r, q) => {
    const qn = kanaFold(norm(q)), k = kanaFold(norm(r.name)); if (!qn || !k) return 0;
    if (k === qn) return 4; if (k.startsWith(qn)) return 3;
    return [...qn].length >= 2 && [...k].length >= 2 && (k.includes(qn) || qn.includes(k)) ? 2 : 0;
  };
  const label = (type, name, extra) => `${TYPE_LABEL[type]}: ${name}${extra ? ` (${extra})` : ""}`;
  async function entityByTypeId(p, type, id) {
    const table = type === "contact" ? "genba_contacts" : type === "site" ? "sites" : "genba_companies";
    const { rows } = await p.query(`SELECT * FROM ${table} WHERE id=$1`, [Number(id)]);
    if (!rows.length) throw new Error(`${TYPE_LABEL[type]} ID ${id} が無い`);
    return { type, id: Number(rows[0].id), name: rows[0].name, row: rows[0] };
  }
  // ref: 文字列 ("横山" / "contact:12" / "現場:5")・{ type, id | name}。決まらなければ { candidates }
  async function resolveEntity(p, ref, onlyType = null) {
    let type = onlyType, id = null, name = null;
    if (ref && typeof ref === "object") {
      if (ref.type) { type = normType(ref.type); if (!type) throw new Error(`type は ${LINK_TYPES.join(" / ")}`); }
      if (ref.id != null && ref.id !== "") id = Number(ref.id);
      if (ref.name != null) name = String(ref.name).trim();
    } else if (typeof ref === "string") {
      const m = ref.trim().match(/^(contact|site|company|人|現場|会社)\s*[:：]\s*(.+)$/i);
      if (m) { type = normType(m[1]); const rest = m[2].trim(); if (/^\d+$/.test(rest)) id = Number(rest); else name = rest; } else name = ref.trim();
    }
    if (id != null) {
      if (!Number.isInteger(id)) throw new Error("id は数値");
      if (!type) throw new Error("id で指定するときは type (contact / site / company) も付ける");
      return entityByTypeId(p, type, id);
    }
    if (!name) throw new Error("entity (人・現場・会社の名前か ID) が必要");
    const cand = [];
    if (!type || type === "contact") for (const r of await loadContacts(p)) { const s = contactScore(r, name); if (s >= 2) cand.push({ type: "contact", id: Number(r.id), name: r.name, extra: r.company || r.trade || "", score: s, row: r }); }
    if (!type || type === "site") for (const r of await loadSites(p)) { const s = siteScore(r, name); if (s >= 2) cand.push({ type: "site", id: Number(r.id), name: r.name, extra: r.client || "", score: s, row: r }); }
    if (!type || type === "company") for (const r of await loadCompanies(p)) { const s = companyKeyScore(r, name); if (s >= 2) cand.push({ type: "company", id: Number(r.id), name: r.name, extra: "", score: s, row: r }); }
    cand.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
    if (!cand.length) throw new Error(`見つからない: ${name} (人・現場・会社の名前か ID。genba_contact_find / genba_find で探せる)`);
    const best = cand[0];
    if (cand.length === 1 || (best.score >= 3 && best.score > cand[1].score)) return { type: best.type, id: best.id, name: best.name, row: best.row };
    return { candidates: cand.slice(0, 8).map((c) => ({ type: c.type, id: c.id, name: c.name, label: label(c.type, c.name, c.extra) })) };
  }
  const strictEntity = async (p, ref) => {
    const e = await resolveEntity(p, ref);
    if (e.candidates) throw new Error(`候補が複数: ${e.candidates.map((c) => `${c.label} [${c.type}:${c.id}]`).join(" / ")}。entity に {type, id} (例 {"type":"contact","id":12}) で指定する`);
    return e;
  };
  // 基本情報 (能力評価・電話・メールは入れない)
  const basicInfo = (e) => {
    const r = e.row;
    if (e.type === "contact") return { type: "contact", id: e.id, name: r.name, company: r.company || null, role: r.role || null, trade: r.trade || null, aliases: Array.isArray(r.aliases) ? r.aliases : [] };
    if (e.type === "site") return { type: "site", id: e.id, name: r.name, code: r.site_code || null, client: r.client || null, done: !!r.done_at };
    return { type: "company", id: e.id, name: r.name, role: r.role || null, trades: Array.isArray(r.trades) ? r.trades : [], aliases: Array.isArray(r.aliases) ? r.aliases : [] };
  };

  // ── グラフ ──
  const clampDays = (v) => Math.min(365, Math.max(1, Math.round(Number(v)) || 60));
  const cutoffOf = (days) => new Date(Date.parse(`${today()}T00:00:00+09:00`) - days * 86400000).toISOString();
  async function nameMaps(p) {
    const [cs, ss, ks] = await Promise.all([loadContacts(p), loadSites(p), loadCompanies(p)]);
    const maps = { contact: new Map(cs.map((r) => [Number(r.id), r])), site: new Map(ss.map((r) => [Number(r.id), r])), company: new Map(ks.map((r) => [Number(r.id), r])) };
    return { maps, nameOf: (t, id) => (maps[t].get(Number(id)) || {}).name || null };
  }
  // 1 つの点と、同じ記録に出てくる点 (件数つき)。window = 期間の条件の SQL 断片と値
  async function neighbors(p, type, id, win, limit) {
    const { rows } = await p.query(
      `SELECT b.entity_type AS t, b.entity_id AS i, COUNT(DISTINCT a.log_id)::int AS n
         FROM log_links a JOIN log_links b ON b.log_id = a.log_id AND NOT (b.entity_type = a.entity_type AND b.entity_id = a.entity_id)
         JOIN genba_log l ON l.id = a.log_id
        WHERE a.entity_type=$1 AND a.entity_id=$2 AND ${LIVE} ${win.sql}
        GROUP BY b.entity_type, b.entity_id ORDER BY n DESC, b.entity_type, b.entity_id LIMIT ${limit}`, [type, Number(id), ...win.params]);
    return rows.map((r) => ({ type: r.t, id: Number(r.i), count: r.n }));
  }
  const openWhere = `l.kind IN (${OPEN_KINDS_SQL}) AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}`;

  const idSchema = { type: "object", description: '{ "type": "contact" | "site" | "company", "id": 12 } か { "type": "contact", "name": "横山" }。名前だけの文字列 ("横山" / "contact:12") でもよい' };
  function tools(by) {
    return [
      {
        name: "genba_state_set",
        description: "人・現場・会社の「今の状態」を入れる (不在 / 繁忙 / NG日 / 注意 / その他)。電話や会話で「いつまで無理」「この日はダメ」「今週は動けない」が出たら、その場で入れる。entity = 名前か ID ({type, id|name}。同名が複数なら止まる)、kind、body = 短い内容 (例「今週は動けない」)、starts_on / ends_on = 期間 (YYYY-MM-DD。ends_on を過ぎると返さなくなる。省略 = 期限なし)、source_ref = 出どころの一意キー (同じ点・同じ source_ref は 2 回入らない)。genba_contact_find / genba_graph の active_states に出て、genba_contact_find の message_hint の先頭に注意が付く。間違いは genba_state_void",
        inputSchema: {
          type: "object", required: ["entity", "kind", "body"],
          properties: {
            entity: { ...idSchema, type: ["object", "string"] },
            kind: { type: "string", enum: STATE_KINDS },
            body: { type: "string", description: `短い内容 (${STATE_BODY_MAX} 字まで)。例: 今週は動けない` },
            starts_on: { type: "string", description: "開始日 YYYY-MM-DD (省略 = いまから)" },
            ends_on: { type: "string", description: "終了日 YYYY-MM-DD (この日までは有効。省略 = 期限なし)" },
            source_ref: { type: "string", description: "出どころの一意キー (例 Plaud:<id> / LINE:<room>:<msg id>)" },
          },
        },
        handler: async (a) => {
          await ready();
          const p = getPool();
          if (!STATE_KINDS.includes(a.kind)) throw new Error(`kind は ${STATE_KINDS.join(" / ")}`);
          const body = String(a.body || "").trim();
          if (!body) throw new Error("body が必要");
          if ([...body].length > STATE_BODY_MAX) throw new Error(`body は ${STATE_BODY_MAX} 字まで (${[...body].length} 字)`);
          const date = (v, f) => { if (v == null || v === "") return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${f} は YYYY-MM-DD`); return String(v); };
          const starts = date(a.starts_on, "starts_on"), ends = date(a.ends_on, "ends_on");
          if (starts && ends && ends < starts) throw new Error("ends_on が starts_on より前");
          const e = await strictEntity(p, a.entity);
          const ref = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
          if (ref) {
            const { rows: ex } = await p.query(`SELECT * FROM entity_states WHERE entity_type=$1 AND entity_id=$2 AND source_ref=$3 AND voided_at IS NULL`, [e.type, e.id, ref]);
            if (ex.length) return { duplicate: true, entity: { type: e.type, id: e.id, name: e.name }, state: stateRow(ex[0], today()) };
          }
          const { rows } = await p.query(
            `INSERT INTO entity_states (entity_type, entity_id, kind, body, starts_on, ends_on, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [e.type, e.id, a.kind, body, starts, ends, ref, by]);
          const st = stateRow(rows[0], today());
          const expired = ends && ends < today();
          return {
            entity: { type: e.type, id: e.id, name: e.name }, state: st,
            note: expired ? "ends_on がもう過ぎているので、返り値の active_states には出ない" : `${e.name} の active_states に出る (${dateRange(st)})。genba_contact_find の message_hint の先頭にも注意が付く`,
          };
        },
      },
      {
        name: "genba_state_void",
        description: "状態を取り消す (消さずに隠す)。間違って入れたとき、状況が変わって要らなくなったとき用。id は genba_state_set の返り値か genba_contact_find / genba_graph の active_states の id",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, reason: { type: "string" } } },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const id = Number(a.id);
          if (!Number.isInteger(id)) throw new Error("id は数値");
          const { rows } = await p.query(`UPDATE entity_states SET voided_at=now(), voided_by=$2 WHERE id=$1 AND voided_at IS NULL RETURNING *`, [id, by]);
          if (!rows.length) throw new Error(`状態 ${id} が無い (か既に取り消し済み)`);
          return { voided: stateRow(rows[0], today()), entity: { type: rows[0].entity_type, id: Number(rows[0].entity_id) } };
        },
      },
      {
        name: "genba_graph",
        description: "人・現場・会社の名前で引いたとき、その名前が出てくる記録と今の状態をまとめて返す (つながり)。query = 名前 (あいまい可)、または entity = {type, id|name}。返り値: active_states = 今有効な状態 (一番上。不在・繁忙・NG日・注意。ここに出たら依頼を送る前に小西に出す) / entity = 基本情報 / open_logs = つながっている未解決の記録 (本文に名前が出るものも含む) / recent_logs = 直近 days 日の記録 / neighbors = 一緒に出てくる人・現場・会社と件数 (depth=2 なら 2 段先まで)。名前が複数の点に当たるときは ambiguous + candidates だけ返す (entity で指定し直す)。能力評価は含めない。送る前の相手の確認は genba_contact_find でも同じ active_states が見える",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "名前 (例: 横山 / いちご / 大丁工業)" },
            entity: { ...idSchema, type: ["object", "string"] },
            depth: { type: "integer", description: "1 (既定) = 隣まで / 2 = 2 段先まで" },
            days: { type: "integer", description: "直近何日の記録を見るか (既定 60、最大 365)" },
          },
        },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const ref = a.entity !== undefined && a.entity !== null ? a.entity : a.query;
          if (ref === undefined || ref === null || ref === "") throw new Error("query (名前) か entity が必要");
          const e = await resolveEntity(p, ref);
          if (e.candidates) return { ambiguous: true, candidates: e.candidates, note: "名前が複数の点に当たる。entity に {type, id} で指定し直す" };
          const days = clampDays(a.days), depth = Number(a.depth) === 2 ? 2 : 1, cutoff = cutoffOf(days), t = today();
          const [states, openRes] = await Promise.all([
            activeStates(p, e.type, [e.id]),
            p.query(
              `SELECT l.*, s.name AS site_name, k.role AS link_role FROM log_links k JOIN genba_log l ON l.id = k.log_id LEFT JOIN sites s ON s.id = l.site_id
                WHERE k.entity_type=$1 AND k.entity_id=$2 AND ${openWhere} AND ${LIVE} ORDER BY l.due_on NULLS LAST, l.created_at DESC LIMIT 50`, [e.type, e.id]),
          ]);
          const openIds = openRes.rows.map((r) => Number(r.id));
          const recentRes = await p.query(
            `SELECT l.*, s.name AS site_name, k.role AS link_role FROM log_links k JOIN genba_log l ON l.id = k.log_id LEFT JOIN sites s ON s.id = l.site_id
              WHERE k.entity_type=$1 AND k.entity_id=$2 AND ${LIVE} AND l.created_at >= $3::timestamptz AND l.id <> ALL($4::bigint[]) ORDER BY l.created_at DESC LIMIT 40`, [e.type, e.id, cutoff, openIds]);
          const { maps, nameOf } = await nameMaps(p);
          const win = { sql: `AND l.created_at >= $3::timestamptz`, params: [cutoff] };
          const nb1 = await neighbors(p, e.type, e.id, win, 30);
          const nbOut = (list) => ({
            people: list.filter((x) => x.type === "contact").map((x) => ({ id: x.id, name: nameOf("contact", x.id), count: x.count })).filter((x) => x.name),
            sites: list.filter((x) => x.type === "site").map((x) => ({ id: x.id, name: nameOf("site", x.id), count: x.count })).filter((x) => x.name),
            companies: list.filter((x) => x.type === "company").map((x) => ({ id: x.id, name: nameOf("company", x.id), count: x.count })).filter((x) => x.name),
          });
          const st = states.get(e.id) || [];
          const out = {
            active_states: st,
            warning: st.length ? cautionText(e.name, st) : undefined,
            entity: basicInfo({ ...e, row: maps[e.type].get(e.id) || e.row }),
            open_logs: openRes.rows.map(logBrief),
            recent_logs: recentRes.rows.map(logBrief),
            neighbors: nbOut(nb1),
            days, depth, today: t,
          };
          if (depth === 2) {
            const seen = new Set([keyOf(e.type, e.id), ...nb1.map((x) => keyOf(x.type, x.id))]);
            out.depth2 = [];
            for (const x of nb1.slice(0, 8)) {
              const nb = (await neighbors(p, x.type, x.id, win, 12)).filter((y) => !seen.has(keyOf(y.type, y.id))).slice(0, 6);
              if (nb.length) out.depth2.push({ via: { type: x.type, id: x.id, name: nameOf(x.type, x.id) }, neighbors: nbOut(nb) });
            }
          }
          return out;
        },
      },
      {
        name: "genba_graph_all",
        description: "グラフ表示用: 全部の点 (人・現場・会社) と線を 1 回で返す。nodes = { key, type, id, name, count (つながる記録の数), state (今有効な状態があるか), sub (人は職種・会社は肩書きなし) }、edges = { a, b, count (2 つの点が一緒に出てくる記録の数) } (a / b は nodes の key)。days = 直近何日の記録を数えるか (既定 60、最大 365)。open_only=true = 未解決の記録だけを数える (期間に関係なく全部の未解決)。点の中身は genba_graph で引く。能力評価は含めない",
        inputSchema: { type: "object", properties: { days: { type: "integer", description: "既定 60、最大 365" }, open_only: { type: "boolean", description: "未解決の記録だけ (既定 false)" } } },
        handler: async (a) => {
          await ready();
          const p = getPool();
          const days = clampDays(a.days), openOnly = a.open_only === true || a.open_only === "true";
          const win = openOnly ? { sql: `AND ${openWhere}`, params: [] } : { sql: `AND l.created_at >= $1::timestamptz`, params: [cutoffOf(days)] };
          const { maps } = await nameMaps(p);
          const [cnt, edg, st] = await Promise.all([
            p.query(`SELECT k.entity_type AS t, k.entity_id AS i, COUNT(DISTINCT k.log_id)::int AS n FROM log_links k JOIN genba_log l ON l.id = k.log_id WHERE ${LIVE} ${win.sql} GROUP BY k.entity_type, k.entity_id`, win.params),
            p.query(
              `SELECT a.entity_type AS at, a.entity_id AS ai, b.entity_type AS bt, b.entity_id AS bi, COUNT(DISTINCT a.log_id)::int AS n
                 FROM log_links a JOIN log_links b ON b.log_id = a.log_id AND (a.entity_type, a.entity_id) < (b.entity_type, b.entity_id)
                 JOIN genba_log l ON l.id = a.log_id WHERE ${LIVE} ${win.sql} GROUP BY a.entity_type, a.entity_id, b.entity_type, b.entity_id`, win.params),
            p.query(`SELECT DISTINCT entity_type AS t, entity_id AS i FROM entity_states WHERE voided_at IS NULL AND (ends_on IS NULL OR ends_on >= $1::date)`, [today()]),
          ]);
          const counts = new Map(cnt.rows.map((r) => [keyOf(r.t, r.i), r.n]));
          const withState = new Set(st.rows.map((r) => keyOf(r.t, r.i)));
          const nodes = [];
          for (const type of LINK_TYPES) for (const [id, r] of maps[type]) {
            const key = keyOf(type, id);
            nodes.push({ key, type, id, name: r.name, count: counts.get(key) || 0, state: withState.has(key), sub: type === "contact" ? r.trade || undefined : undefined });
          }
          const have = new Set(nodes.map((n) => n.key));
          const edges = edg.rows.map((r) => ({ a: keyOf(r.at, r.ai), b: keyOf(r.bt, r.bi), count: r.n })).filter((e) => have.has(e.a) && have.has(e.b));
          return { days, open_only: openOnly, today: today(), nodes, edges, counts: { nodes: nodes.length, linked_nodes: nodes.filter((n) => n.count > 0).length, edges: edges.length } };
        },
      },
      {
        name: "genba_links_backfill",
        description: "つながりの自動リンクを、既に入っている全ログにかけた結果を見る・かけ直す (小西のトークンから)。rerun=true でもう一度かける (人が手で付けたリンクは残る。同じものは 2 回入らない)。返り値: 件数と、人・現場・会社ごとのリンク件数。初回は新しい版を最初に使ったときに自動で 1 回走る",
        inputSchema: { type: "object", properties: { rerun: { type: "boolean", description: "true = 全ログにもう一度かける" } } },
        handler: async (a) => {
          await ready();
          const p = getPool();
          if (a.rerun === true) {
            if (by !== "小西") throw new Error("かけ直しは小西のトークンからだけ");
            return runBackfill(p, by);
          }
          const { rows } = await p.query(`SELECT value FROM genba_settings WHERE key='links_backfill_v1'`);
          return rows[0] ? rows[0].value : { status: "まだ走っていない", note: "rerun=true (小西のトークン) でかける" };
        },
      },
    ];
  }

  // ── バックフィル: 既存の全ログに自動リンク (auto=true) を 1 度かけて、人・現場ごとのリンク件数を残す ──
  const BACKFILL_KEY = "links_backfill_v1";
  async function backfillRun(p) {
    const m = await buildMatcher(p);
    let last = 0, logs = 0, inserted = 0;
    for (;;) {
      const { rows } = await p.query(`SELECT id, site_id, title, body, who, source FROM genba_log WHERE id > $1 ORDER BY id LIMIT 500`, [last]);
      if (!rows.length) break;
      const lg = [], ty = [], en = [], ro = [];
      for (const r of rows) {
        for (const l of computeLinks(m, r, {})) { lg.push(Number(r.id)); ty.push(l.type); en.push(l.id); ro.push(l.role); }
        last = Number(r.id); logs++;
      }
      if (lg.length) {
        const res = await p.query(
          `INSERT INTO log_links (log_id, entity_type, entity_id, role, auto)
           SELECT x.log_id, x.t, x.e, x.r, true FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[]) AS x(log_id, t, e, r)
           ON CONFLICT (log_id, entity_type, entity_id) DO NOTHING RETURNING id`, [lg, ty, en, ro]);
        inserted += res.rows.length;
      }
    }
    const { rows: tot } = await p.query(`SELECT k.entity_type AS t, k.entity_id AS i, COUNT(*)::int AS n FROM log_links k JOIN genba_log l ON l.id = k.log_id WHERE l.voided_at IS NULL GROUP BY k.entity_type, k.entity_id ORDER BY n DESC`);
    const list = (type) => tot.filter((r) => r.t === type).map((r) => ({ id: Number(r.i), name: m.nameOf(type, r.i), links: r.n })).filter((x) => x.name);
    return { logs, inserted, people: list("contact"), sites: list("site"), companies: list("company").slice(0, 30), links_total: tot.reduce((s, r) => s + r.n, 0) };
  }
  async function runBackfill(p, by) {
    const started = new Date().toISOString();
    try {
      const r = await backfillRun(p);
      const value = { status: "done", started_at: started, finished_at: new Date().toISOString(), ...r };
      await p.query(`INSERT INTO genba_settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [BACKFILL_KEY, JSON.stringify(value), by || "system"]);
      console.log(`[genba] links backfill: logs=${r.logs} 新しく張ったリンク=${r.inserted} 人=${r.people.length} 現場=${r.sites.length} 会社=${r.companies.length}`);
      console.log(`[genba] links backfill 人ごと: ${r.people.slice(0, 15).map((x) => `${x.name} ${x.links}`).join(" / ")}`);
      console.log(`[genba] links backfill 現場ごと: ${r.sites.slice(0, 15).map((x) => `${x.name} ${x.links}`).join(" / ")}`);
      return value;
    } catch (e) {
      await p.query(`INSERT INTO genba_settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [BACKFILL_KEY, JSON.stringify({ status: "failed", started_at: started, error: e.message }), by || "system"]).catch(() => {});
      throw e;
    }
  }
  // 新しい版を最初に使ったときに 1 回だけ走る (複数のインスタンスが同時に来ても 1 つだけ。印は genba_settings)
  async function maybeBackfill(p) {
    const { rows } = await p.query(`INSERT INTO genba_settings (key, value, updated_by) VALUES ($1,'{"status":"running"}'::jsonb,'system') ON CONFLICT (key) DO NOTHING RETURNING key`, [BACKFILL_KEY]);
    if (!rows.length) return null;
    return runBackfill(p, "system");
  }

  const instructions = [
    "■ つながり (genba_graph / genba_state_*): 人・現場・会社の名前で引いたとき、その名前が出てくる記録と今の状態をまとめて見る。記録 (genba_log_add) するとき、現場・who・送り主・本文に出てくる連絡先と現場と会社の名前に自動でリンクが張られる (返り値 links。手で付けるなら links:[{type, id か name}])",
    "- 送る前は必ず genba_contact_find か genba_graph で相手を引き、active_states (不在・繁忙・NG日・注意) とぶつかる依頼は送らずに小西に出す。genba_contact_find の message_hint の先頭に「注意: ○○さんは m/d〜m/d …」が付く",
    "- 電話や会話で「いつまで無理」「この日はダメ」「今週は動けない」が出たら、その場で genba_state_set(entity, kind, body, starts_on, ends_on) で入れる。間違い・状況が変わったら genba_state_void。ends_on を過ぎた状態は自動で返らなくなる",
    "- 「〇〇さんの件、どうなってる？」「〇〇に関わる未解決は？」は genba_graph(query=名前)。つながっている未解決の記録 (open_logs・本文に名前が出るものも含む)・直近の記録・一緒に出てくる人と現場 (neighbors) が 1 回で出る。全体の見取り図は genba_graph_all (グラフ表示用)",
  ];

  return { ensureSchema, maybeBackfill, link, relink, resolveManual, activeStates, decorateFind, statusExtras, tools, instructions, backfillRun };
}
