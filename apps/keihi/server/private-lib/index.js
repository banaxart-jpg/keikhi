// 小西だけが見られる非公開の記録 (MCP: private_*)。共有の Keihi (genba_* など) とは別のテーブル・別のコネクタ URL・別の説明文。
//
// 隠し方 (名取など他の人から「中身」も「そういう記録がある」ことも分からないように):
//   - ツールは専用コネクタ /api/private/mcp/<token> にだけ載る。統合コネクタ (/api/mcp/…) と genba の人ごと URL には一切出ない。
//     専用 URL は GET /api/mcp-connector に「小西のログインのときだけ」載る (他の人の返り値には項目ごと無い)。トークンが違えば 404
//   - この URL への呼び出しは直近の呼び出し記録 (/recent) にも Cloud Run のログにも残さない (createMcpHandler の quiet)
//   - データは private_entries / private_settings だけ。共有側のツール (genba_status / log_list / tasks / audit / contact_find / カレンダー同期) は
//     この表を読まない。人への紐づけ (about_id) は外部キーにしない: 共有側で連絡先を消されても消えず、消すのが失敗して存在がばれることもない
//   - 予定は共有の BANAX カレンダーではなく、持ち主の個人カレンダー (既定 konishi0221@gmail.com) にだけ入れる。Keihi のタスクカレンダー同期とは混ざらない
//
//   - 人の分け方 (private_people): 友人 = 仕事に関係ない友人。共有の連絡先から外して (中身はここに退避)、共有側には名前も出さない。
//     両方 = 友人で仕事もある人。共有の連絡先は残し、仕事の話だけ共有・個人的なやりとりはここ。何も無ければ 仕事 (共有の連絡先のまま)
//
// 持ち主は OWNERS の名前だけ (今は 小西)。tools(owner) は持ち主以外には空を返す。

const KINDS = ["記録", "予定", "メモ"];
const RELATIONS = ["友人", "両方", "仕事"];
const TITLE_MAX = 40, TOPIC_MAX = 30, BODY_MAX = 20000;
const OWNERS = {
  小西: { emails: ["konishi0221@gmail.com"], calendarId: "konishi0221@gmail.com" },
};
const SA_EMAIL = "keihi-run@static-epigram-496002-v8.iam.gserviceaccount.com";

const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(String(s) + "T00:00:00Z"));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
const ymd = (v) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const addDay = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const autoTitle = (body) => { const t = String(body || "").replace(/\s+/g, " ").trim(); const cs = [...t]; return cs.length > 28 ? cs.slice(0, 28).join("") : t; };
const cleanTitle = (v) => {
  const t = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  if ([...t].length > TITLE_MAX) throw new Error(`title は ${TITLE_MAX} 字まで (${[...t].length} 字)`);
  return t;
};
// ── 文章の仕分け (AI を呼ばない。言葉と人の一覧だけで決める) ──
// play = 遊び・交友の言葉 / work = 仕事の言葉 / sensitive = 家庭・健康の言葉 (遊びではなく、仕事に響く理由として出ることがある)
const PLAY_TERMS = ["飲み", "飲もう", "飲んだ", "呑み", "乾杯", "ゴルフ", "旅行", "遊び", "遊ぼ", "映画", "ライブ", "フェス", "誕生日", "結婚式", "披露宴", "二次会", "同窓会", "ランチ", "ご飯", "めし", "焼肉", "居酒屋", "サウナ", "釣り", "キャンプ", "BBQ", "バーベキュー", "草野球", "サッカー", "野球", "麻雀", "パチンコ", "競馬", "デート", "ドライブ", "ツーリング", "ゲーム", "筋トレ", "ジム"];
const WORK_TERMS = ["見積", "発注", "受注", "納期", "現場", "現調", "工事", "施工", "図面", "請求", "入金", "支払", "契約", "工程", "搬入", "搬出", "職人", "業者", "元請", "施主", "客先", "仕上", "材料", "資材", "作業", "打ち合わせ", "打合せ", "打ち合せ", "検査", "引き渡し", "引渡", "大工", "電気", "設備", "内装", "塗装", "防水", "解体", "納品", "数量", "単価", "金額", "税込", "仕様", "型番", "手配", "見学"];
const SENSITIVE_TERMS = ["家族", "子ども", "子供", "息子", "娘", "嫁", "旦那", "彼女", "彼氏", "実家", "結婚", "離婚", "妊娠", "体調", "風邪", "病院", "入院", "介護", "ダイエット"];
export function classifyText(text) {
  const t = String(text || "");
  const play = PLAY_TERMS.filter((w) => t.includes(w)), work = WORK_TERMS.filter((w) => t.includes(w)), sensitive = SENSITIVE_TERMS.filter((w) => t.includes(w));
  const world = play.length && !work.length ? "play" : play.length && work.length ? "mixed" : work.length ? "work" : "neutral";
  return { world, play, work, sensitive };
}
const WORK_KINDS = ["決定", "課題", "次やること", "待ち", "進捗"];
const STORE_KINDS = [...WORK_KINDS, "メモ", "雑談", "私的"];
const ymdJst = (iso) => { const d = iso && Number.isFinite(Date.parse(iso)) ? new Date(iso) : new Date(); return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); };
const gerr = (e) => String(e?.errors?.[0]?.message || e?.message || e).slice(0, 240);

export function createPrivate({ getPool, getCalendarApi = null, normName = (s) => String(s || "").trim().toLowerCase(), normCompany = (s) => String(s || "").trim().toLowerCase() }) {
  const pool = () => { const p = getPool(); if (!p) throw new Error("DB not configured"); return p; };

  let schemaPromise = null;
  function ensureSchema() {
    schemaPromise ||= (async () => {
      const p = pool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS private_entries (
          id            BIGSERIAL PRIMARY KEY,
          owner         TEXT NOT NULL,
          kind          TEXT NOT NULL,                 -- 記録 / 予定 / メモ
          title         TEXT,
          body          TEXT NOT NULL,
          topic         TEXT,                          -- 家族 / 健康 / 評価 / 採用 / 交友 … (自由)
          about_type    TEXT,                          -- contact / company / text
          about_id      BIGINT,                        -- genba_contacts / genba_companies の id。外部キーにしない (共有側の削除と無関係にする)
          about_label   TEXT,                          -- 書いたときの名前
          on_date       DATE,                          -- 予定の日 / 出来事の日
          start_time    TEXT,                          -- 予定の開始 HH:MM (無ければ終日)
          minutes       INT,
          valid_until   DATE,                          -- この日を過ぎたら通常の検索に出さない (任意)
          calendar_id   TEXT,
          calendar_event TEXT,
          source_ref    TEXT,
          source        JSONB,
          edits         JSONB,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          voided_at     TIMESTAMPTZ,
          void_reason   TEXT
        )`);
      await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS private_entries_src_idx ON private_entries (owner, source_ref) WHERE source_ref IS NOT NULL`);
      await p.query(`CREATE INDEX IF NOT EXISTS private_entries_owner_idx ON private_entries (owner, created_at DESC)`);
      await p.query(`CREATE INDEX IF NOT EXISTS private_entries_about_idx ON private_entries (owner, about_type, about_id)`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS private_people (
          id          BIGSERIAL PRIMARY KEY,
          owner       TEXT NOT NULL,
          name        TEXT NOT NULL,
          name_key    TEXT NOT NULL,                   -- normName(name)
          aliases     JSONB NOT NULL DEFAULT '[]'::jsonb,
          relation    TEXT NOT NULL,                   -- 友人 / 両方 (仕事 は行を持たない = 共有の連絡先のまま)
          contact_id  BIGINT,                          -- 両方: 共有側の連絡先 id (外部キーなし)
          profile     JSONB,                           -- 友人: 共有の連絡先から外したときの中身 (復元用。LINE のルームなどもここ)
          note        TEXT,                            -- どういう人か 一言 (例: 高校の同級生)
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (owner, name_key)
        )`);
      await p.query(`CREATE TABLE IF NOT EXISTS private_settings (owner TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (owner, key))`);
    })().catch((e) => { schemaPromise = null; throw e; });
    return schemaPromise;
  }

  const ownerCfg = (owner) => OWNERS[owner] || null;
  const isOwnerEmail = (email) => { const e = String(email || "").trim().toLowerCase(); return !!e && Object.values(OWNERS).some((o) => o.emails.includes(e)); };

  async function getSetting(owner, key) {
    const { rows } = await pool().query(`SELECT value FROM private_settings WHERE owner=$1 AND key=$2`, [owner, key]);
    return rows[0]?.value ?? null;
  }
  async function setSetting(owner, key, value) {
    await pool().query(
      `INSERT INTO private_settings (owner, key, value) VALUES ($1,$2,$3) ON CONFLICT (owner, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [owner, key, JSON.stringify(value)]);
  }
  async function calendarIdFor(owner) {
    const s = await getSetting(owner, "calendar");
    return (s && s.calendarId) || ownerCfg(owner)?.calendarId || null;
  }

  // ── 人・会社への紐づけ (共有側の連絡先・会社を読むだけ。見つからなければ名前の文字だけ残す) ──
  async function resolveAbout(owner, text) {
    const t = String(text ?? "").trim();
    if (!t) return null;
    const p = pool();
    const k = normName(t);
    // 1) 私的な人の一覧 (友人 / 両方) が先。両方は共有の連絡先 (alt) の記録も同じ人として探せる
    let people = [];
    try { people = (await p.query(`SELECT id, name, name_key, aliases, contact_id FROM private_people WHERE owner=$1`, [owner])).rows; } catch { people = []; }
    const ph = people.filter((x) => x.name_key === k || (Array.isArray(x.aliases) ? x.aliases : []).some((a) => normName(a) === k));
    if (ph.length === 1) return { type: "person", id: Number(ph[0].id), label: ph[0].name, alt: ph[0].contact_id != null ? { type: "contact", id: Number(ph[0].contact_id) } : null };
    if (ph.length > 1) throw new Error(`「${t}」に当たる人が複数: ${ph.map((x) => x.name).join(" / ")}`);
    let contacts = [];
    try { contacts = (await p.query(`SELECT id, name, name_key, aliases, company FROM genba_contacts`)).rows; } catch { contacts = []; }
    const hits = contacts.filter((c) => c.name_key === k || (Array.isArray(c.aliases) ? c.aliases : []).some((a) => normName(a) === k));
    if (hits.length === 1) return { type: "contact", id: Number(hits[0].id), label: hits[0].name };
    if (hits.length > 1) throw new Error(`「${t}」に当たる連絡先が複数: ${hits.map((c) => `${c.name}${c.company ? `(${c.company})` : ""}`).join(" / ")}。会社つきの名前で指定する`);
    let companies = [];
    try { companies = (await p.query(`SELECT id, name, name_key FROM genba_companies`)).rows; } catch { companies = []; }
    const ck = normCompany(t);
    const co = companies.find((c) => c.name_key === ck);
    if (co) return { type: "company", id: Number(co.id), label: co.name };
    return { type: "text", id: null, label: t.slice(0, 60) };
  }

  const aboutOut = (r) => (r.about_label ? { type: r.about_type || "text", id: r.about_id != null ? Number(r.about_id) : undefined, name: r.about_label } : undefined);
  const entryOut = (r) => ({
    id: Number(r.id), kind: r.kind, title: r.title || autoTitle(r.body), body: r.body,
    topic: r.topic || undefined, about: aboutOut(r),
    on: ymd(r.on_date) || undefined, time: r.start_time || undefined, minutes: r.minutes != null ? Number(r.minutes) : undefined,
    valid_until: ymd(r.valid_until) || undefined,
    in_calendar: r.calendar_event ? true : undefined,
    source_ref: r.source_ref || undefined,
    at: r.created_at, edited: Array.isArray(r.edits) && r.edits.length ? r.edits.length : undefined,
  });

  // ── 個人カレンダー (予定だけ) ──
  const eventBody = (r) => {
    const on = ymd(r.on_date), mins = r.minutes != null ? Number(r.minutes) : 60;
    const desc = [r.body && r.body !== (r.title || "") ? String(r.body).slice(0, 2000) : "", r.about_label ? `(${r.about_label})` : ""].filter(Boolean).join("\n");
    const body = { summary: r.title || autoTitle(r.body), description: desc || undefined, visibility: "private", extendedProperties: { private: { keihiPrivateId: String(r.id) } } };
    if (r.start_time) {
      const start = new Date(`${on}T${r.start_time}:00+09:00`);
      body.start = { dateTime: `${on}T${r.start_time}:00+09:00`, timeZone: "Asia/Tokyo" };
      body.end = { dateTime: new Date(start.getTime() + mins * 60000).toISOString(), timeZone: "Asia/Tokyo" };
    } else { body.start = { date: on }; body.end = { date: addDay(on, 1) }; }
    return body;
  };
  const NO_CAL = (calId) => `個人カレンダー (${calId}) に書けない。Google カレンダーの設定 → 「特定のユーザーとの共有」にサービスアカウント ${SA_EMAIL} を「予定の変更」権限で足す。足したら private_calendar を 1 回呼ぶ (たまっていた予定も入る)。共有したくなければ private_calendar(create: true) で Keihi が専用カレンダーを作って小西にだけ共有する`;
  async function pushEvent(owner, r) {
    if (!getCalendarApi) return { ok: false, error: "カレンダー API が未設定" };
    const calId = await calendarIdFor(owner);
    if (!calId) return { ok: false, error: "カレンダー ID が未設定" };
    try {
      const cal = await getCalendarApi();
      const res = r.calendar_event && r.calendar_id === calId
        ? await cal.events.patch({ calendarId: calId, eventId: r.calendar_event, requestBody: eventBody(r), sendUpdates: "none" })
        : await cal.events.insert({ calendarId: calId, requestBody: eventBody(r), sendUpdates: "none" });
      await pool().query(`UPDATE private_entries SET calendar_id=$2, calendar_event=$3, updated_at=now() WHERE id=$1`, [r.id, calId, res.data.id]);
      return { ok: true, calendar_id: calId };
    } catch (e) { return { ok: false, error: gerr(e), how_to: NO_CAL(calId) }; }
  }
  async function dropEvent(r) {
    if (!r.calendar_event || !r.calendar_id || !getCalendarApi) return;
    try { await (await getCalendarApi()).events.delete({ calendarId: r.calendar_id, eventId: r.calendar_event, sendUpdates: "none" }); } catch { /* 既に無い・権限なしは無視 */ }
  }
  async function accessOf(calId) {
    if (!getCalendarApi) return { ok: false, error: "カレンダー API が未設定" };
    try {
      const cal = await getCalendarApi();
      let entry;
      try { entry = (await cal.calendarList.get({ calendarId: calId })).data; }
      catch { entry = (await cal.calendarList.insert({ requestBody: { id: calId } })).data; } // 共有されていれば SA の一覧に足せる
      const role = entry.accessRole || "unknown";
      return { ok: role === "owner" || role === "writer", role, summary: entry.summary || null };
    } catch (e) { return { ok: false, error: gerr(e) }; }
  }

  const q = (owner, where, params, tail = "") => pool().query(`SELECT * FROM private_entries WHERE owner=$1 ${where} ${tail}`, [owner, ...params]);
  const mustRow = async (owner, id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) throw new Error("id は数値");
    const { rows } = await q(owner, `AND id=$2 AND voided_at IS NULL`, [n]);
    if (!rows.length) throw new Error(`見つからない: ${id}`);
    return rows[0];
  };

  // ── 人の分け方 ──
  const personOut = (r) => ({
    id: Number(r.id), name: r.name, relation: r.relation, aliases: Array.isArray(r.aliases) && r.aliases.length ? r.aliases : undefined,
    note: r.note || undefined,
    shared_contact_id: r.contact_id != null ? Number(r.contact_id) : undefined,
    company: r.c_company || undefined, role: r.c_role || undefined,
    entries: r.entries != null ? Number(r.entries) : undefined, last_at: r.last_at || undefined,
    // 友人: 共有の連絡先から外したときの中身 (LINE のルーム・口調など)。連絡するときの材料
    contact_info: r.relation === "友人" && r.profile ? Object.fromEntries(["company", "role", "trade", "channels", "tone", "phone", "email", "notes"].filter((k) => r.profile[k] != null && r.profile[k] !== "" && !(Array.isArray(r.profile[k]) && !r.profile[k].length)).map((k) => [k, r.profile[k]])) : undefined,
  });
  // 人の一覧の取り方 (list と set の返り値で共通): 記録の件数・最後の日付・共有の連絡先の会社と役割つき
  async function queryPeople(where, params) {
    const sql = (join) => `SELECT p.*, ${join ? "c.company AS c_company, c.role AS c_role," : ""}
        (SELECT COUNT(*)::int FROM private_entries e WHERE e.owner = p.owner AND e.voided_at IS NULL AND ((e.about_type = 'person' AND e.about_id = p.id) OR (p.contact_id IS NOT NULL AND e.about_type = 'contact' AND e.about_id = p.contact_id))) AS entries,
        (SELECT MAX(e.created_at) FROM private_entries e WHERE e.owner = p.owner AND e.voided_at IS NULL AND ((e.about_type = 'person' AND e.about_id = p.id) OR (p.contact_id IS NOT NULL AND e.about_type = 'contact' AND e.about_id = p.contact_id))) AS last_at
      FROM private_people p ${join ? "LEFT JOIN genba_contacts c ON c.id = p.contact_id" : ""} WHERE ${where.join(" AND ")} ORDER BY last_at DESC NULLS LAST, p.name`;
    try { return (await pool().query(sql(true), params)).rows; } catch { return (await pool().query(sql(false), params)).rows; }
  }
  async function sharedContactsFor(name, company) {
    let rows = [];
    try { rows = (await pool().query(`SELECT id, name, name_key, company, company_key, aliases, role FROM genba_contacts`)).rows; } catch { rows = []; }
    const k = normName(name);
    let hits = rows.filter((c) => c.name_key === k || (Array.isArray(c.aliases) ? c.aliases : []).some((a) => normName(a) === k));
    if (company) hits = hits.filter((c) => c.company_key === normCompany(company));
    return hits;
  }
  async function restoreContact(profile) {
    const { rows: cols } = await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_name='genba_contacts'`);
    const names = cols.map((c) => c.column_name).filter((c) => c !== "id" && Object.prototype.hasOwnProperty.call(profile, c));
    if (!names.length) return null;
    const list = names.map((n) => `"${n}"`).join(", ");
    const r = await pool().query(`INSERT INTO genba_contacts (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::genba_contacts, $1::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [JSON.stringify(profile)]);
    return r.rows[0] ? Number(r.rows[0].id) : null;
  }
  async function setPerson(owner, a) {
    const name = String(a.name || "").trim();
    if (!name) throw new Error("name が必要");
    const rel = String(a.relation || "");
    if (!RELATIONS.includes(rel)) throw new Error(`relation は ${RELATIONS.join(" / ")}`);
    const p = pool(), key = normName(name);
    const extra = (Array.isArray(a.aliases) ? a.aliases : String(a.aliases || "").split(/[,、\n]/)).map((x) => String(x).trim()).filter(Boolean);
    const { rows: ex } = await p.query(`SELECT * FROM private_people WHERE owner=$1 AND (name_key=$2 OR aliases @> $3::jsonb)`, [owner, key, JSON.stringify([name])]);
    const existing = ex[0] || null;
    const shared = await sharedContactsFor(name, a.company);
    if (shared.length > 1) throw new Error(`「${name}」に当たる共有の連絡先が複数: ${shared.map((c) => `${c.name}${c.company ? `(${c.company})` : ""}`).join(" / ")}。company を付けて指定する`);
    const contact = shared[0] || null;
    const out = { moved: {} };
    if (rel === "仕事") {
      if (existing && existing.relation === "友人" && existing.profile && !contact) {
        const id = await restoreContact(existing.profile);
        out.moved.contact_restored = id != null;
        if (id == null) out.warning = "同じ名前の連絡先が既にあるので復元しなかった";
      }
      if (existing) await p.query(`DELETE FROM private_people WHERE id=$1`, [existing.id]);
      out.person = { name, relation: "仕事", note: "非公開の人の一覧から外した (共有の連絡先のまま)" };
      return out;
    }
    if (contact && contact.role === "社内") throw new Error("社内の人 (小西・名取など) は 友人 / 両方 にできない");
    let aliases = [...new Set([...(existing && Array.isArray(existing.aliases) ? existing.aliases : []), ...(contact && Array.isArray(contact.aliases) ? contact.aliases : []), ...extra])];
    aliases = aliases.filter((x) => normName(x) !== key);
    let profile = existing ? existing.profile : null, contactId = null;
    if (rel === "両方") {
      let c = contact;
      if (!c && existing && existing.profile) { const id = await restoreContact(existing.profile); out.moved.contact_restored = id != null; if (id != null) c = { id }; else out.warning = "同じ名前の連絡先が既にあるので復元しなかった"; }
      contactId = c ? Number(c.id) : null;
      if (existing && existing.relation === "友人") profile = null;
    }
    const { rows: up } = await p.query(
      `INSERT INTO private_people (owner, name, name_key, aliases, relation, contact_id, profile, note)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)
       ON CONFLICT (owner, name_key) DO UPDATE SET name = EXCLUDED.name, aliases = EXCLUDED.aliases, relation = EXCLUDED.relation, contact_id = EXCLUDED.contact_id,
         profile = EXCLUDED.profile, note = COALESCE(EXCLUDED.note, private_people.note), updated_at = now()
       RETURNING *`,
      [owner, existing ? existing.name : name, key, JSON.stringify(aliases), rel, contactId, profile ? JSON.stringify(profile) : null, a.note ? String(a.note).trim().slice(0, 200) : null]);
    let person = up[0];
    if (rel === "友人" && contact) {
      // 共有の連絡先を外す: 中身を退避 → 共有側のメモを非公開のメモへ移す → 共有の連絡先を消す
      const { rows: pj } = await p.query(`SELECT to_jsonb(c) AS j FROM genba_contacts c WHERE id=$1`, [contact.id]);
      profile = pj[0].j;
      let notes = [];
      try { notes = (await p.query(`SELECT * FROM genba_notes WHERE subject_type='contact' AND subject_id=$1 AND retired_at IS NULL ORDER BY id`, [contact.id])).rows; } catch { notes = []; }
      for (const n of notes) {
        await p.query(
          `INSERT INTO private_entries (owner, kind, title, body, topic, about_type, about_id, about_label, on_date, valid_until, source_ref)
           VALUES ($1,'メモ',$2,$3,$4,'person',$5,$6,$7,$8,$9) ON CONFLICT (owner, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
          [owner, n.title || null, n.body, n.kind || null, person.id, person.name, ymd(n.valid_from), ymd(n.valid_until), `moved:genba_notes:${n.id}`]);
      }
      try { await p.query(`DELETE FROM genba_notes WHERE subject_type='contact' AND subject_id=$1`, [contact.id]); } catch { /* 無ければ何もしない */ }
      await p.query(`DELETE FROM genba_contacts WHERE id=$1`, [contact.id]);
      person = (await p.query(`UPDATE private_people SET profile=$2::jsonb, contact_id=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [person.id, JSON.stringify(profile)])).rows[0];
      out.moved = { contact: true, notes: notes.length };
    }
    out.person = personOut((await queryPeople(["p.owner = $1", "p.id = $2"], [owner, person.id]))[0] || person);
    return out;
  }

  async function addEntry(owner, a) {
    await ensureSchema();
    const kind = a.kind ? String(a.kind) : "記録";
    if (!KINDS.includes(kind)) throw new Error(`kind は ${KINDS.join(" / ")}`);
    const body = String(a.body || "").trim();
    if (!body) throw new Error("body が空");
    if (body.length > BODY_MAX) throw new Error(`body は ${BODY_MAX} 字まで`);
    const on = a.on ? String(a.on) : null;
    if (on && !isDate(on)) throw new Error("on は YYYY-MM-DD");
    if (kind === "予定" && !on) throw new Error("予定には on (YYYY-MM-DD) が必要");
    const time = a.time ? String(a.time) : null;
    if (time && !isTime(time)) throw new Error("time は HH:MM");
    const validUntil = a.valid_until ? String(a.valid_until) : null;
    if (validUntil && !isDate(validUntil)) throw new Error("valid_until は YYYY-MM-DD");
    const minutes = a.minutes != null && a.minutes !== "" ? Math.max(5, Math.min(1440, Math.round(Number(a.minutes)))) : null;
    if (a.minutes != null && a.minutes !== "" && !Number.isFinite(Number(a.minutes))) throw new Error("minutes は分 (数値)");
    const about = await resolveAbout(owner, a.about);
    const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
    const { rows } = await pool().query(
      `INSERT INTO private_entries (owner, kind, title, body, topic, about_type, about_id, about_label, on_date, start_time, minutes, valid_until, source_ref, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (owner, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING *`,
      [owner, kind, cleanTitle(a.title), body, a.topic ? String(a.topic).trim().slice(0, TOPIC_MAX) : null,
       about ? about.type : null, about ? about.id : null, about ? about.label : null, on, kind === "予定" ? time : null, kind === "予定" ? minutes : null,
       validUntil, sourceRef, a.source && typeof a.source === "object" ? JSON.stringify(a.source) : null]);
    if (!rows.length) {
      const { rows: ex } = await q(owner, `AND source_ref=$2`, [sourceRef]);
      return { duplicate: true, entry: ex[0] ? entryOut(ex[0]) : null };
    }
    const row = rows[0];
    const out = { entry: entryOut(row) };
    if (kind === "予定") {
      out.calendar = await pushEvent(owner, row);
      if (out.calendar.ok) out.entry.in_calendar = true;
    }
    return out;
  }

  // ── 取り込み時の仕分け (genba_source_mark / source 付きの genba_log_add・add_many から呼ばれる) ──
  // 友人からのものは必ず非公開へ。両方の人は「遊びの内容」だけ非公開へ。AI の判断 (kind=私的で中身つき) も尊重する。
  // 仕事の話・どちらとも言えない話は共有のまま (AI が分けて書く)。AI は呼ばない: 人の一覧と言葉だけで決める
  async function loadRegistry(owner) {
    const { rows } = await pool().query(`SELECT id, name, name_key, aliases, relation, contact_id, profile FROM private_people WHERE owner=$1`, [owner]);
    const rooms = new Map();
    if (rows.length) {
      const addRooms = (person, channels) => { for (const c of Array.isArray(channels) ? channels : []) if (c && c.room_id && c.kind !== "group") rooms.set(String(c.room_id), person); };
      for (const r of rows) if (r.relation === "友人" && r.profile) addRooms(r, r.profile.channels);
      const ids = rows.filter((r) => r.contact_id != null).map((r) => Number(r.contact_id));
      if (ids.length) {
        let cs = []; try { cs = (await pool().query(`SELECT id, channels FROM genba_contacts WHERE id = ANY($1::bigint[])`, [ids])).rows; } catch { cs = []; }
        for (const c of cs) { const r = rows.find((x) => Number(x.contact_id) === Number(c.id)); if (r) addRooms(r, c.channels); }
      }
    }
    return { rows, rooms };
  }
  function findPerson(reg, { sender, room }) {
    const k = sender ? normName(sender) : "";
    let hit = k ? reg.rows.find((x) => x.name_key === k || (Array.isArray(x.aliases) ? x.aliases : []).some((a) => normName(a) === k)) : null;
    if (!hit && room && reg.rooms.has(String(room))) hit = reg.rooms.get(String(room)); // 1 対 1 のルームなら、自分が送った分もその人のやりとり
    return hit || null;
  }
  async function plan(owner, { room, items }) {
    await ensureSchema();
    const reg = await loadRegistry(owner);
    return (items || []).map((it) => {
      const kind = String(it?.kind || "");
      const person = findPerson(reg, { sender: it?.sender, room });
      const text = [it?.title, it?.body, it?.gist].filter(Boolean).join(" ");
      const w = classifyText(text);
      const hasText = !!String(it?.body || it?.title || "").trim() || String(it?.gist || "").trim().length >= 6;
      let route = "shared", reason;
      if (person && person.relation === "友人") { route = "private"; reason = "友人"; }
      else if (person && person.relation === "両方" && w.world === "play" && (WORK_KINDS.includes(kind) || kind === "雑談")) { route = "private"; reason = "遊びの内容"; }
      else if (kind === "私的" && hasText) { route = "private"; reason = "私的"; }
      return { route, reason, person, world: w.world, play: w.play, work: w.work, sensitive: w.sensitive, storeable: route === "private" && STORE_KINDS.includes(kind) && hasText };
    });
  }
  async function storeIngest(owner, src, it, pl) {
    const person = pl.person;
    const body = String(it.body || it.title || it.gist || "").trim();
    const due = it.due_on && isDate(it.due_on) ? String(it.due_on) : null;
    const schedule = !!due && ["次やること", "決定"].includes(String(it.kind));
    const r = await addEntry(owner, {
      kind: schedule ? "予定" : "記録", body, title: it.title ? String(it.title).trim().slice(0, TITLE_MAX) : null,
      about: person ? person.name : (it.sender ? String(it.sender).trim() : null),
      topic: person ? "交友" : (it.topic || null),
      on: schedule ? due : ymdJst(it.at),
      source_ref: src.sourceRef || null, source: { channel: src.channel, room: src.room, sender: it.sender, at: it.at },
    });
    return { id: r.entry ? r.entry.id : undefined, duplicate: r.duplicate || undefined, calendar: r.calendar };
  }
  function ingestFor(by) {
    if (!ownerCfg(by)) return null;
    return { plan: (a) => plan(by, a), store: (src, it, pl) => storeIngest(by, src, it, pl) };
  }

  function tools(owner) {
    if (!ownerCfg(owner)) return [];
    const str = { type: "string" };
    const READ = { readOnlyHint: true };
    return [
      {
        name: "private_add",
        description: "小西だけが見られる非公開の記録を 1 件足す。共有の Keihi (genba_*) や共有カレンダーには出ない。kind: 記録 (出来事・雑談・近況・交友) / 予定 (on が必要。個人カレンダーにだけ入る) / メモ (人や会社についての流れない情報。家庭の事情・評価・採用など)。人・会社のことは about に名前 (連絡先・会社に当たれば紐づく、無ければ名前の文字だけ残る)。topic は家族 / 健康 / 評価 / 採用 / 交友 などの自由な見出し。同じ source_ref は 2 回入らない (監視ジョブで LINE から拾うときに付ける)。title は短く (40 字まで、省略で本文の頭)",
        inputSchema: {
          type: "object", required: ["body"],
          properties: {
            kind: { type: "string", enum: KINDS, description: "既定 記録" },
            body: { ...str, description: "中身" }, title: str, topic: str,
            about: { ...str, description: "人・会社の名前 (例: 名取 / 久保木 / ㈱大丁工業)" },
            on: { ...str, description: "YYYY-MM-DD。予定の日 (予定では必須) / 出来事の日" },
            time: { ...str, description: "HH:MM。予定の開始 (省略で終日)" },
            minutes: { type: "integer", description: "予定の長さ (分、既定 60)" },
            valid_until: { ...str, description: "YYYY-MM-DD。この日を過ぎたら通常の検索に出さない (任意)" },
            source_ref: { ...str, description: "出どころの一意キー (例 LINE:<room>:<message id>)" },
            source: { type: "object", description: "出どころ { channel, room, sender, at } など自由" },
          },
        },
        handler: async (a) => addEntry(owner, a),
      },
      {
        name: "private_find",
        description: "非公開の記録を探す・一覧する (小西だけ)。query は title・本文・人の名前・topic のあいまい検索、about は人・会社で絞る、kind / topic / days (直近何日に書いたか) でも絞れる。upcoming: true で今日以降の予定 (日付順)。valid_until を過ぎたものは既定で出ない (include_expired: true で出す)。新しい順、既定 30 件。ここで読んだ内容は共有側 (genba_* のログ・メモ・タスク・カレンダー・LINE・メール・シート・会議・SNS) に書かない・引用しない",
        annotations: READ,
        inputSchema: {
          type: "object",
          properties: {
            query: str, about: str, kind: { type: "string", enum: KINDS }, topic: str,
            days: { type: "integer", description: "直近 N 日に書いたもの" },
            upcoming: { type: "boolean", description: "今日以降の予定を日付順に" },
            include_expired: { type: "boolean" },
            limit: { type: "integer", description: "既定 30、最大 100" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const where = ["AND voided_at IS NULL"], params = [];
          const add = (sql, v) => { params.push(v); where.push(sql.replace("$#", `$${params.length + 1}`)); };
          if (!a.include_expired) add("AND (valid_until IS NULL OR valid_until >= $#::date)", todayJst());
          if (a.kind) { if (!KINDS.includes(a.kind)) throw new Error(`kind は ${KINDS.join(" / ")}`); add("AND kind = $#", a.kind); }
          if (a.topic) add("AND topic ILIKE $#", `%${String(a.topic).trim()}%`);
          if (a.days) add("AND created_at > now() - ($#::int || ' days')::interval", Math.max(1, Math.min(3650, Number(a.days) || 1)));
          if (a.upcoming) { add("AND kind = '予定' AND on_date >= $#::date", todayJst()); }
          if (a.query) { const like = `%${String(a.query).trim()}%`; params.push(like); where.push(`AND (title ILIKE $${params.length + 1} OR body ILIKE $${params.length + 1} OR about_label ILIKE $${params.length + 1} OR topic ILIKE $${params.length + 1})`); }
          if (a.about) {
            const t = String(a.about).trim();
            let ab = null; try { ab = await resolveAbout(owner, t); } catch { ab = null; }
            params.push(`%${t}%`);
            const likeIdx = params.length + 1;
            // 連絡先・会社に当たった人は id だけで探す (同じ名前の別人を混ぜない)。名前の文字だけで残した記録 (text) は名前の一部で探す
            if (ab && ab.id != null) {
              const pairs = [[ab.type, ab.id], ...(ab.alt ? [[ab.alt.type, ab.alt.id]] : [])];
              const ors = pairs.map(([ty, id]) => { params.push(ty); params.push(id); return `(about_type = $${params.length} AND about_id = $${params.length + 1})`; });
              where.push(`AND (${ors.join(" OR ")} OR (about_type = 'text' AND about_label ILIKE $${likeIdx}))`);
            }
            else where.push(`AND about_label ILIKE $${likeIdx}`);
          }
          const limit = Math.min(100, Math.max(1, Number(a.limit) || 30));
          const { rows } = await q(owner, where.join(" "), params, `ORDER BY ${a.upcoming ? "on_date ASC, start_time ASC NULLS FIRST, id ASC" : "created_at DESC, id DESC"} LIMIT ${limit}`);
          return { count: rows.length, entries: rows.map(entryOut), confidential: "非公開。共有側に書かない・引用しない" };
        },
      },
      {
        name: "private_fix",
        description: "非公開の記録を直す (渡した項目だけ)。title / body / topic / about (空文字で外す) / on / time / minutes / valid_until (空文字で消す)。valid_until を今日にすると「もう当てはまらない」扱い。予定の日付や名前を直すと個人カレンダーの予定も直る。個人カレンダーに入っていない予定は retry_calendar: true で入れ直す。直す前の値は残る。kind は変えられない (private_void して入れ直す)",
        inputSchema: {
          type: "object", required: ["id"],
          properties: {
            id: { type: "integer" }, title: str, body: str, topic: str, about: str, on: str, time: str, minutes: { type: "integer" }, valid_until: str,
            retry_calendar: { type: "boolean" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const r = await mustRow(owner, a.id);
          const sets = [], vals = [r.id, owner], before = {};
          const set = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); before[col] = r[col] instanceof Date ? ymd(r[col]) : r[col] ?? null; };
          if (a.title !== undefined) set("title", cleanTitle(a.title));
          if (a.body !== undefined) { const b = String(a.body || "").trim(); if (!b) throw new Error("body が空"); if (b.length > BODY_MAX) throw new Error(`body は ${BODY_MAX} 字まで`); set("body", b); }
          if (a.topic !== undefined) set("topic", a.topic ? String(a.topic).trim().slice(0, TOPIC_MAX) : null);
          if (a.about !== undefined) {
            const ab = await resolveAbout(owner, a.about);
            set("about_type", ab ? ab.type : null); set("about_id", ab ? ab.id : null); set("about_label", ab ? ab.label : null);
          }
          if (a.on !== undefined) { if (a.on && !isDate(a.on)) throw new Error("on は YYYY-MM-DD"); if (!a.on && r.kind === "予定") throw new Error("予定の on は消せない"); set("on_date", a.on || null); }
          if (a.time !== undefined) { if (a.time && !isTime(a.time)) throw new Error("time は HH:MM"); set("start_time", a.time || null); }
          if (a.minutes !== undefined) set("minutes", a.minutes == null || a.minutes === "" ? null : Math.max(5, Math.min(1440, Math.round(Number(a.minutes)))));
          if (a.valid_until !== undefined) { if (a.valid_until && !isDate(a.valid_until)) throw new Error("valid_until は YYYY-MM-DD"); set("valid_until", a.valid_until || null); }
          if (!sets.length && !a.retry_calendar) throw new Error("直す項目が無い");
          let row = r;
          if (sets.length) {
            const edits = [...(Array.isArray(r.edits) ? r.edits : []), { at: new Date().toISOString(), before }];
            vals.push(JSON.stringify(edits)); sets.push(`edits=$${vals.length}`);
            row = (await pool().query(`UPDATE private_entries SET ${sets.join(", ")}, updated_at=now() WHERE id=$1 AND owner=$2 RETURNING *`, vals)).rows[0];
          }
          const out = { entry: entryOut(row) };
          if (row.kind === "予定" && (a.retry_calendar || ["title", "body", "about", "on", "time", "minutes"].some((k) => a[k] !== undefined))) {
            out.calendar = await pushEvent(owner, row);
            if (out.calendar.ok) out.entry.in_calendar = true;
          }
          return out;
        },
      },
      {
        name: "private_void",
        description: "非公開の記録を取り消す (消さずに隠す。通常の検索に出なくなる)。予定は個人カレンダーからも消す。間違って入れたとき用",
        inputSchema: { type: "object", required: ["id"], properties: { id: { type: "integer" }, reason: str } },
        handler: async (a) => {
          await ensureSchema();
          const r = await mustRow(owner, a.id);
          await dropEvent(r);
          await pool().query(`UPDATE private_entries SET voided_at=now(), void_reason=$3, calendar_event=NULL, updated_at=now() WHERE id=$1 AND owner=$2`, [r.id, owner, a.reason ? String(a.reason).trim().slice(0, 200) : null]);
          return { voided: Number(r.id), calendar_removed: r.calendar_event ? true : undefined };
        },
      },
      {
        name: "private_calendar",
        description: "個人カレンダー (予定の出し先) の状態を見る・設定する (小西だけ)。引数なし: 今の出し先 (既定は小西の Google カレンダー konishi0221@gmail.com)・書き込めるか・共有のしかた。書けるときは、書けなかったまま溜まっていた予定も入れる。calendar_id: 出し先を別のカレンダーに変える。create: true: Keihi が専用カレンダー「小西 個人」を作って小西にだけ共有する (個人カレンダーを共有したくないとき)",
        inputSchema: { type: "object", properties: { calendar_id: str, create: { type: "boolean" } } },
        handler: async (a) => {
          await ensureSchema();
          const cfg = ownerCfg(owner);
          let created;
          if (a.create) {
            if (!getCalendarApi) throw new Error("カレンダー API が未設定");
            const cal = await getCalendarApi();
            const made = await cal.calendars.insert({ requestBody: { summary: "小西 個人", timeZone: "Asia/Tokyo" } });
            let shared = [];
            for (const email of cfg.emails) {
              try { await cal.acl.insert({ calendarId: made.data.id, sendNotifications: true, requestBody: { role: "writer", scope: { type: "user", value: email } } }); shared.push(email); }
              catch (e) { shared.push(`${email}: 失敗 (${gerr(e)})`); }
            }
            await setSetting(owner, "calendar", { calendarId: made.data.id, summary: "小西 個人", created: true });
            created = { calendar_id: made.data.id, shared_with: shared, note: "相手側: Google カレンダーの「他のカレンダー」に自動で出る (招待メールの承諾が要ることもある)" };
          } else if (a.calendar_id) {
            const id = String(a.calendar_id).trim();
            const acc = await accessOf(id);
            if (!acc.ok) throw new Error(`そのカレンダーには書けない (${acc.error || `権限: ${acc.role}`})`);
            await setSetting(owner, "calendar", { calendarId: id, summary: acc.summary });
          }
          const calId = await calendarIdFor(owner);
          const acc = await accessOf(calId);
          let pushed = 0, failed = 0;
          if (acc.ok) {
            const { rows } = await q(owner, `AND kind='予定' AND voided_at IS NULL AND calendar_event IS NULL AND on_date >= $2::date`, [todayJst()]);
            for (const r of rows) { const res = await pushEvent(owner, r); if (res.ok) pushed++; else failed++; }
          }
          return {
            calendar_id: calId, can_write: acc.ok, access_role: acc.role || undefined, summary: acc.summary || undefined,
            error: acc.ok ? undefined : acc.error, how_to: acc.ok ? undefined : NO_CAL(calId),
            pushed_pending: pushed || undefined, failed_pending: failed || undefined, created,
          };
        },
      },
      {
        name: "private_person_set",
        description: "人を 友人 / 両方 / 仕事 に分ける (小西だけ)。友人 = 仕事に関係ない友人: 共有の連絡先から外して (連絡先の中身と共有側のメモはここへ移す)、共有側には名前も出さない。両方 = 友人で仕事もある人: 共有の連絡先は残し、仕事の話だけ共有・個人的なやりとりは private_add(about=名前)。仕事 = 非公開の一覧から外す (友人から戻すときは外した連絡先を復元)。「〇〇は友達」「〇〇は友達で仕事もある」と言われたらこれ。名前は連絡先と同じでなくてよい (aliases に呼び名)。同じ名前の連絡先が複数なら company を付ける。社内の人には使えない",
        inputSchema: {
          type: "object", required: ["name", "relation"],
          properties: {
            name: { ...str, description: "例: 金井 / 大久保翔平" }, relation: { type: "string", enum: RELATIONS },
            aliases: { type: "array", items: { type: "string" }, description: "呼び名・あだ名 (例: 金井くん)" },
            company: { ...str, description: "同名の連絡先が複数あるときの会社名" },
            note: { ...str, description: "どういう人か 一言 (例: 高校の同級生)" },
          },
        },
        handler: async (a) => { await ensureSchema(); return setPerson(owner, a); },
      },
      {
        name: "private_person_list",
        description: "友人 / 両方 に分けた人の一覧 (小西だけ)。relation で絞る、query で名前・呼び名・一言を探す。各人: 関係・呼び名・一言・非公開の記録の件数と最後の日付。両方は共有の連絡先の id・会社・役割、友人は共有から外したときの連絡先の中身 (LINE のルームなど。連絡するときの材料)。LINE の監視や連絡文を書く前に最初に 1 回読む (友人の話は共有に書かない・両方は仕事の話だけ共有)",
        annotations: READ,
        inputSchema: { type: "object", properties: { relation: { type: "string", enum: ["友人", "両方"] }, query: str } },
        handler: async (a) => {
          await ensureSchema();
          const where = ["p.owner = $1"], params = [owner];
          if (a.relation) { if (!["友人", "両方"].includes(a.relation)) throw new Error("relation は 友人 / 両方"); params.push(a.relation); where.push(`p.relation = $${params.length}`); }
          if (a.query) { params.push(`%${String(a.query).trim()}%`); where.push(`(p.name ILIKE $${params.length} OR p.note ILIKE $${params.length} OR p.aliases::text ILIKE $${params.length})`); }
          const rows = await queryPeople(where, params);
          return { count: rows.length, people: rows.map(personOut), note: "友人の話は共有に書かない。両方は仕事の話だけ共有。仕事 (一覧に無い人) は共有の連絡先のまま", confidential: "非公開" };
        },
      },
    ];
  }

  const instructions = [
    "小西だけの非公開の記録 (private_*)。共有の Keihi (genba_* など) とは別の場所で、名取など他の人の AI からは見えない・存在も分からない。",
    "■ 仕分け。判断の軸は「名取がこれを知らないと仕事で困るか」",
    "- 仕事に響くことは、響く部分だけ共有に書く (genba_log_add / genba_note_add)。理由の中身は非公開に書く。例: 共有に「クロス屋さんは朝 10 時以降の入りが多い」、非公開に private_add(kind=メモ, about=クロス屋さん, topic=家庭, body=理由)",
    "- 仕事の電話や LINE の途中で出た雑談・近況・家族や個人の予定・社員の評価や採用は、共有に書かず非公開に書く",
    "- 小西個人の交友関係 (誰と会った・連絡した) は共有側に一切出さない。private_add(kind=記録, about=相手, topic=交友)。共有の進捗ログ・メモ・タスクにも、現場に関係なければ書かない",
    "- 迷ったら非公開に入れる。共有に出し直すのは小西が言ったとき・仕事に必要だと分かったときだけ",
    "■ 人の分け方 (private_person_set / private_person_list)。人ごとに 仕事 (既定: 共有の連絡先のまま) / 両方 / 友人 に分ける",
    "- 友人 = 仕事に関係ない友人。共有の連絡先から外れ、共有には名前も出さない。その人とのやりとりは共有に何も書かない (進捗・タスク・メモ・連絡先・カレンダー)。private_add(about=名前) だけ",
    "- 両方 = 友人で仕事もある人。共有の連絡先は残す。仕事の話 (見積・日程・段取り) だけ共有に書き、遊び・飲み・近況・家庭・交友は private_add(about=名前, topic=交友 など) に書く。1 つのやりとりに両方入っていたら分けて書く",
    "- 「〇〇は友達」「〇〇は友達で仕事もある」と言われたら private_person_set。友人が仕事の相手にもなったら 両方 に変える (外した連絡先が復元される)。誰か分からない・迷うときは 友人 扱いで共有に出さず、小西に聞く",
    "- LINE の監視・連絡文・人の名前が出る作業の最初に private_person_list を 1 回読む。友人・両方の名前が出たら上の分け方で書く。友人のルームは genba_source_mark の目録に kind=私的 (gist なし) で入れ、共有の記録にしない",
    "■ 取り込み時の自動の仕分け (小西のアカウントで genba_source_mark、または source に sender を付けた genba_log_add / add_many をしたとき)。サーバーが 文章と人の一覧で仕分ける (AI は呼ばない)",
    "- 友人からのものは共有に入れず、この非公開側に入る。両方の人の「遊びの内容」(飲み・ゴルフ・旅行・映画 など、仕事の言葉が無いもの) も同じ。kind=私的 で本文 (title / body) を付けて渡したものも非公開に入る。返り値 recorded[].routed = private",
    "- 仕事の話、どちらとも言えない話は共有に入る。1 つの文に仕事と遊びが混ざる (sort.world = mixed) ときは、仕事の部分だけ共有に書き、遊びの部分は別の item (kind=私的 + 本文) にして渡す。家庭・健康の言葉 (sort.sensitive) が出たら、共有には響く部分だけ書き、理由は非公開に書く",
    "- 共有の目録 (genba_seen) には、非公開に回した分の送り主と要旨は残らない (件数だけ)。友人の 1 対 1 のルームは、名前が違う (自分が送った) メッセージも友人のやりとりとして扱う",
    "- 仕分けを確認できないときは、何も記録せず cursor も進めずにエラーで返る。そのまま同じ items でやり直す",
    "■ 使い方",
    "- 記録・近況・雑談: private_add(kind=記録, body, about?, topic?, on?)。人・会社についての流れない情報 (事情・性質・評価・採用): private_add(kind=メモ, about=名前, topic, body)",
    "- 予定: private_add(kind=予定, title, on=YYYY-MM-DD, time=HH:MM?)。小西の個人カレンダーにだけ入る。共有の BANAX カレンダーにも Keihi のタスクにも入れない。予定を共有側に出す必要があるときは小西に聞く",
    "- 探す: private_find(query / about / topic / kind / days / upcoming)。人について連絡文や段取りを考えるときは、その人の private_find(about=名前) を先に見る。メモの内容は本人・その会社に送る文面に引用しない",
    "- 直す・取り消す: private_fix / private_void。監視ジョブで LINE から拾うときは source_ref (channel:room:message id) を付ける (同じものは 2 回入らない)。genba_source_mark の目録には kind=私的 (gist なし) で入れ、残したい内容だけ private_add する",
    "- 出し先のカレンダーが書けないとき (private_add の calendar.ok が false) は、返り値の how_to を小西に伝える。共有できたら private_calendar を 1 回呼ぶ",
    "■ 守ること (漏れたら取り返せない)",
    "- private_* の返り値・中身を、共有側に書かない・引用しない: genba_* のログ・メモ・タスク・ルール、共有カレンダー、LINE・メールの文面、スプレッドシート、会議、SNS、ドラマ。要約や言い換えもしない",
    "- 名取など社内の人への返信・LINE の自動応答のとき (genba の「応答」) は、private_* を呼ばない・使わない。聞かれても「非公開の記録がある」とは言わず、「それは小西に聞いて」と返す。この種の応答は、このコネクタを接続していないセッションで動かすのが確実",
    "- このコネクタがあること自体を、小西以外に話さない。他のコネクタ・チャットに、ツール名や URL を出さない",
  ].join("\n");

  return { tools, instructions, isOwnerEmail, ingestFor, owners: Object.keys(OWNERS), ensureSchema, _resolveAbout: (o, t) => resolveAbout(o, t) };
}
