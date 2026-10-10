// 現場 (genba) MCP: 案件・進捗ログ・運用ルールを Postgres に持ち、写真の置き場 (Drive フォルダ URL) を返す。
// 「1 現場 1 チャット」で AI (Claude / ChatGPT / 次の何か) が同じ口から使う前提。データとルールは Keihi 側に残る。
//
// 置き場の線引き:
//   正本 = Postgres (sites に案件 ID と Drive フォルダ ID を足す / genba_log は追記のみ / genba_rules は版を積む)
//   写真・図面 = Drive の案件フォルダ (人が Drive アプリで直接上げる。Keihi はフォルダ URL を返すだけ)
// 書いた人は MCP のトークンから決める (AI が名前を書く余地を作らない)。

const SUBFOLDERS = {
  "図面": "01_図面", "見積": "02_見積", "業者見積": "02_見積", "写真": "03_写真", "資料": "04_資料", "参考": "05_参考",
};
const LOG_KINDS = ["進捗", "課題", "決定", "次やること", "解決"];

// 現場名の表記ゆれ吸収: 全角→半角、空白・記号を落として小文字に
function norm(s) {
  return String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　\-_・/()（）「」『』、。.,]/g, "");
}
// 人名の表記ゆれ吸収: norm に加えて末尾の敬称 (さん/様/くん/ちゃん/氏…) を落とし、ひらがなはカタカナに寄せる
// (「バカボンさん」「ばかぼん」「菊池　さん」→ 同じ鍵)。両側を同じ関数に通すので、鍵同士の比較だけに使う
const HONORIFIC_RE = /(さん|サン|様|さま|くん|君|ちゃん|氏|殿|先生|社長|部長|課長|専務|常務|会長)$/;
function normName(s) {
  const t = String(s || "").normalize("NFKC").trim().replace(HONORIFIC_RE, "");
  return norm(t).replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}
// 会社名: 株式会社 / (株) / ㈱ 等の法人格を落とす (NFKC で ㈱ → (株) になる)
function normCompany(s) {
  return norm(String(s || "").normalize("NFKC").replace(/株式会社|有限会社|合同会社|合資会社|\(株\)|\(有\)|\(同\)|㈱|㈲/g, ""));
}
function driveFolderIdOf(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return null;
}
const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
// pg は DATE を JS の Date (サーバーの TZ の 0 時) で返す。String() すると "Mon Oct 12" になって比較が壊れるので
// 必ず YYYY-MM-DD に揃える (サーバーは UTC なので toISOString でよい)
const ymd = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function createGenba({ getPool, createMcpHandler, getDriveApi }) {
  let schemaOk = false;
  async function ensureSchema() {
    if (schemaOk) return;
    const p = getPool();
    if (!p) throw new Error("DB not configured");
    // sites (現場マスタ、/genba/ アプリが管理) に案件 ID・Drive フォルダ・客先を足す。既存アプリは触らない
    await p.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_code TEXT`);
    await p.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS drive_folder_id TEXT`);
    await p.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS client TEXT`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS sites_code_uq ON sites (site_code) WHERE site_code IS NOT NULL`);
    // 進捗ログ: 追記のみ。状態の変更も「解決」行の追記で表す (resolves_id が元の行)
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_log (
        id          BIGSERIAL PRIMARY KEY,
        site_id     BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('進捗','課題','決定','次やること','解決')),
        body        TEXT NOT NULL,
        written_by  TEXT NOT NULL,
        due_on      DATE,
        resolves_id BIGINT REFERENCES genba_log(id),
        photo_ids   JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_log_site_idx ON genba_log (site_id, created_at DESC)`);
    // 監視ジョブ (5 分ごとに LINE 等を読む) が同じメッセージを 2 回記録しないための鍵と、出どころ
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS source_ref TEXT`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS source JSONB`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS genba_log_source_ref_uq ON genba_log (source_ref) WHERE source_ref IS NOT NULL`);
    // 現場に紐づかない項目 (会社の雑務・Google マップのピン等) は site_id NULL。所要時間 (分) と担当/やった人
    await p.query(`ALTER TABLE genba_log ALTER COLUMN site_id DROP NOT NULL`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS estimate_min INTEGER`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS who TEXT`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_log_open_idx ON genba_log (kind, estimate_min) WHERE kind IN ('課題','次やること')`);
    // 監視対象 (ホワイトリスト): owner (誰の Beeper/LINE か) × channel × room → 現場。
    // 監視ジョブがルーム一覧 (ID と名前だけ) を genba_room_sync で入れ、画面 (/genba/watch.html) でトグル。
    // enabled=true かつ site_id ありのルームだけ読む (デフォルト拒否)
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_sources (
        id          BIGSERIAL PRIMARY KEY,
        owner       TEXT NOT NULL DEFAULT '小西', -- 持ち主 (トークンの名前 = 画面のログインから引く名前)
        channel     TEXT NOT NULL,              -- LINE / Beeper / Slack など
        room        TEXT NOT NULL,              -- ルーム ID (監視側が一意に引けるもの)
        name        TEXT,                       -- ルームの表示名 (同期で更新)
        label       TEXT,                       -- 人が付けたメモ
        site_id     BIGINT REFERENCES sites(id) ON DELETE SET NULL,
        enabled     BOOLEAN NOT NULL DEFAULT false,
        cursor      JSONB,                      -- 監視側が「ここまで読んだ」を置く (last_id / last_at など自由)
        last_seen_at TIMESTAMPTZ,
        added_by    TEXT NOT NULL,
        added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // 初版 (owner 無し・site 必須・UNIQUE(channel, room)) からの移行。空テーブルでも安全
    await p.query(`ALTER TABLE genba_sources ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT '小西'`);
    await p.query(`ALTER TABLE genba_sources ADD COLUMN IF NOT EXISTS name TEXT`);
    await p.query(`ALTER TABLE genba_sources ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
    await p.query(`ALTER TABLE genba_sources ALTER COLUMN site_id DROP NOT NULL`);
    await p.query(`ALTER TABLE genba_sources DROP CONSTRAINT IF EXISTS genba_sources_channel_room_key`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS genba_sources_owner_room_uq ON genba_sources (owner, channel, room)`);
    // 画面のログイン (メール) → 持ち主の名前。トークンの名前と同じ文字列にする
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_owners (
        email       TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`INSERT INTO genba_owners (email, label) VALUES ('konishi0221@gmail.com', '小西') ON CONFLICT (email) DO NOTHING`);
    // 運用ルール: topic ごとに版を積む。上書きしない
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_rules (
        id          BIGSERIAL PRIMARY KEY,
        topic       TEXT NOT NULL,
        version     INTEGER NOT NULL,
        body        TEXT NOT NULL,
        updated_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (topic, version)
      )`);
    // 連絡先・呼び名: 人をあだ名や下の名前で呼ぶので「誰か / どのルームに送るか / どんな言葉遣いか」を全 AI で同じ答えにする。
    // 同一人物の判定は name + company (正規化した鍵)。aliases / channels / site_ids は JSONB の配列
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_contacts (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,                 -- 正式な名前 (例: 菊池)
        name_key    TEXT NOT NULL,                 -- normName(name)
        company     TEXT,                          -- 会社名 (例: ㈱大丁工業)
        company_key TEXT NOT NULL DEFAULT '',      -- normCompany(company)。無ければ ''
        aliases     JSONB NOT NULL DEFAULT '[]',   -- 呼び名・あだ名・表記ゆれ
        role        TEXT,                          -- 職人 / 業者 / 元請け / 設計 / 客先 / 社内
        trade       TEXT,                          -- 職種 (防水, 解体, 大工, 空調, 電気…)
        channels    JSONB NOT NULL DEFAULT '[]',   -- [{ channel, room_id, room_name, kind, chat_id }]。room_id = Beeper の変わらない ID が正本
        tone        TEXT,                          -- 言葉遣い (丁寧語・「！」なし / 軽め・「！」可)
        site_ids    JSONB NOT NULL DEFAULT '[]',   -- 関わっている現場 (sites.id)
        phone       TEXT,
        email       TEXT,
        notes       TEXT,
        updated_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS genba_contacts_key_uq ON genba_contacts (name_key, company_key)`);
    schemaOk = true;
  }

  const siteRow = (r) => ({
    id: Number(r.id), code: r.site_code || null, name: r.name,
    address: r.address || null, client: r.client || null,
    done: !!r.done_at, folderUrl: r.drive_folder_id ? folderUrl(r.drive_folder_id) : null,
  });

  // 現場の特定: 数値 ID / 案件 ID / 名前 (完全一致 → 部分一致 → 表記ゆれ)
  async function findSites(p, query, limit = 5) {
    const q = String(query || "").trim();
    if (!q) return [];
    const { rows } = await p.query(`SELECT * FROM sites ORDER BY (done_at IS NOT NULL), id`);
    const byId = /^\d+$/.test(q) ? rows.filter((r) => Number(r.id) === Number(q)) : [];
    if (byId.length) return byId;
    const code = rows.filter((r) => r.site_code && r.site_code.toLowerCase() === q.toLowerCase());
    if (code.length) return code;
    const exact = rows.filter((r) => r.name === q);
    if (exact.length) return exact;
    const nq = norm(q);
    const partial = rows.filter((r) => norm(r.name).includes(nq) || (nq.length >= 2 && nq.includes(norm(r.name))));
    return partial.slice(0, limit);
  }
  // site 省略 / 「会社」「全般」= 現場に紐づかない項目
  const NO_SITE_WORDS = new Set(["", "会社", "全般", "共通", "なし", "none", "company", "-"]);
  async function resolveSiteOrNull(p, query) {
    if (query == null || NO_SITE_WORDS.has(String(query).trim().toLowerCase())) return null;
    return resolveSite(p, query);
  }
  async function resolveSite(p, query) {
    const hits = await findSites(p, query);
    if (!hits.length) throw new Error(`現場が見つからない: ${query}。genba_find で探すか genba_register で登録する`);
    if (hits.length > 1) {
      throw new Error(`候補が複数: ${hits.map((r) => `${r.site_code || "ID" + r.id} ${r.name}`).join(" / ")}。案件 ID か ID で指定する`);
    }
    return hits[0];
  }

  // 案件フォルダ直下の種類別サブフォルダを探す (無ければ作る)
  async function subfolder(site, kind) {
    const sub = SUBFOLDERS[kind];
    if (!sub) throw new Error(`種類は ${Object.keys(SUBFOLDERS).join(" / ")} のどれか (指定: ${kind})`);
    if (!site.drive_folder_id) {
      throw new Error(`${site.name} に Drive の案件フォルダが登録されていない。genba_register(name, drive_folder_url) で登録する`);
    }
    const drive = await getDriveApi();
    const esc = (s) => String(s).replace(/'/g, "\\'");
    const found = await drive.files.list({
      q: `'${esc(site.drive_folder_id)}' in parents and name='${esc(sub)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id,name)", pageSize: 5, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const hit = (found.data.files || [])[0];
    if (hit) return { id: hit.id, name: sub, created: false };
    const made = await drive.files.create({
      requestBody: { name: sub, mimeType: "application/vnd.google-apps.folder", parents: [site.drive_folder_id] },
      fields: "id", supportsAllDrives: true,
    });
    return { id: made.data.id, name: sub, created: true };
  }

  const logRow = (r) => ({
    id: Number(r.id), kind: r.kind, body: r.body, by: r.written_by,
    due_on: ymd(r.due_on),
    resolves_id: r.resolves_id ? Number(r.resolves_id) : null,
    photo_ids: Array.isArray(r.photo_ids) && r.photo_ids.length ? r.photo_ids : undefined,
    source_ref: r.source_ref || undefined,
    source: r.source || undefined,
    estimate_min: r.estimate_min != null ? Number(r.estimate_min) : undefined,
    who: r.who || undefined,
    site: r.site_name !== undefined ? (r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null) : undefined,
    at: r.created_at,
  });

  // 1 行追記 (genba_log_add / genba_log_add_many 共通)。source_ref があれば重複は 2 回入らない
  async function addLog(p, by, a, siteRowCache, ctx = {}) {
    const site = siteRowCache || await resolveSiteOrNull(p, a.site);
    const siteId = site ? site.id : null;
    if (!LOG_KINDS.includes(a.kind)) throw new Error(`kind は ${LOG_KINDS.join(" / ")}`);
    const body = String(a.body || "").trim();
    if (!body) throw new Error("body が空");
    let resolvesId = null;
    if (a.kind === "解決") {
      resolvesId = Number(a.resolves_id);
      if (!Number.isInteger(resolvesId)) throw new Error("kind=解決 には resolves_id (元の課題/次やることの行 ID) が必要");
      const { rows: orig } = await p.query(`SELECT id, kind, site_id FROM genba_log WHERE id=$1`, [resolvesId]);
      if (!orig.length) throw new Error(`行 ${resolvesId} が無い`);
      // 解決行は元の行と同じ現場に入れる (site を省略して ID だけで解決できるように)
      if (siteRowCache == null && a.site == null) { /* 現場未指定 → 元の行の現場を引き継ぐ */ }
      if (site && orig[0].site_id != null && Number(orig[0].site_id) !== Number(site.id)) throw new Error(`行 ${resolvesId} はこの現場のログに無い`);
      if (!["課題", "次やること"].includes(orig[0].kind)) throw new Error(`行 ${resolvesId} は ${orig[0].kind} なので解決の対象ではない`);
    }
    const due = a.due_on && /^\d{4}-\d{2}-\d{2}$/.test(a.due_on) ? a.due_on : null;
    if (a.due_on && !due) throw new Error("due_on は YYYY-MM-DD");
    const photos = Array.isArray(a.photo_ids) ? a.photo_ids.filter(Boolean).map(String).slice(0, 50) : null;
    const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
    const source = a.source && typeof a.source === "object" ? { ...a.source } : null;
    // 出どころの送信者 (表示名) が連絡先に一意に解決できたら contact_id / contact_name も残す (AI が書いた名前は上書きしない)
    if (source && source.contact_id == null && (source.sender || source.room)) {
      const c = await resolveSourceContact(p, source, ctx);
      if (c) { source.contact_id = Number(c.id); source.contact_name = c.name; }
    }
    const est = a.estimate_min != null && a.estimate_min !== "" ? Math.max(1, Math.min(100000, Math.round(Number(a.estimate_min)))) : null;
    if (a.estimate_min != null && a.estimate_min !== "" && !Number.isFinite(Number(a.estimate_min))) throw new Error("estimate_min は分 (数値)");
    const who = a.who ? String(a.who).trim().slice(0, 60) : null;
    // 解決行で現場未指定なら元の行の現場を使う
    let useSiteId = siteId;
    if (resolvesId && useSiteId == null) {
      const { rows: o } = await p.query(`SELECT site_id FROM genba_log WHERE id=$1`, [resolvesId]);
      useSiteId = o[0]?.site_id ?? null;
    }
    const siteOut = site ? { id: Number(site.id), code: site.site_code || null, name: site.name } : null;
    const { rows } = await p.query(
      `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, resolves_id, photo_ids, source_ref, source, estimate_min, who)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [useSiteId, a.kind, body, by, due, resolvesId, photos ? JSON.stringify(photos) : null, sourceRef, source ? JSON.stringify(source) : null, est, who]
    );
    if (rows.length) return { site: siteOut, log: logRow(rows[0]), duplicate: false };
    // source_ref が既にある = 同じメッセージを前に記録済み
    const { rows: ex } = await p.query(`SELECT * FROM genba_log WHERE source_ref=$1`, [sourceRef]);
    return { site: siteOut, log: ex[0] ? logRow(ex[0]) : null, duplicate: true };
  }

  // ───────── 連絡先・呼び名 ─────────
  const CONTACT_ROLES = ["職人", "業者", "元請け", "設計", "客先", "社内"];
  // 配列でも "a, b / c" の文字列でも受ける
  const toList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(/[,、/／\n]/))
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  const uniqBy = (arr, keyFn) => { const seen = new Set(); return arr.filter((x) => { const k = keyFn(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
  function cleanChannel(c) {
    if (!c || typeof c !== "object") return null;
    const out = {
      channel: c.channel ? String(c.channel).trim() : "LINE",
      room_id: c.room_id ? String(c.room_id).trim() : undefined,
      room_name: c.room_name ? String(c.room_name).trim().slice(0, 200) : undefined,
      kind: c.kind === "group" || c.kind === "single" ? c.kind : undefined,
      chat_id: c.chat_id != null && c.chat_id !== "" ? String(c.chat_id).trim() : undefined, // 数字の chatID は変わるので補助
    };
    return out.room_id || out.room_name ? out : null;
  }
  // 既存の channels に新しい分を重ねる。room_id が同じ、または (片方に room_id が無く) ルーム名が同じなら同じルームとして上書き
  function mergeChannels(oldArr, newArr) {
    const out = (Array.isArray(oldArr) ? oldArr : []).map((c) => ({ ...c }));
    for (const n of newArr) {
      let hit = n.room_id ? out.find((c) => c.room_id === n.room_id) : null;
      if (!hit && n.room_name) hit = out.find((c) => (!c.room_id || !n.room_id) && c.room_name && normName(c.room_name) === normName(n.room_name));
      if (hit) { for (const k of Object.keys(n)) if (n[k] !== undefined) hit[k] = n[k]; }
      else out.push({ ...n });
    }
    return out;
  }
  const contactRow = (r, siteMap) => ({
    id: Number(r.id), name: r.name, company: r.company || null,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    role: r.role || null, trade: r.trade || null,
    channels: Array.isArray(r.channels) ? r.channels : [],
    tone: r.tone || null,
    sites: (Array.isArray(r.site_ids) ? r.site_ids : []).map((id) => (siteMap && siteMap.get(Number(id))) || { id: Number(id) }),
    phone: r.phone || null, email: r.email || null, notes: r.notes || null,
    updated_by: r.updated_by, updated_at: r.updated_at,
  });
  // site_ids → { id, code, name } に広げて返す
  async function contactsOut(p, rows) {
    const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.site_ids) ? r.site_ids : [])).map(Number).filter(Number.isInteger))];
    const siteMap = new Map();
    if (ids.length) {
      const { rows: ss } = await p.query(`SELECT id, site_code, name FROM sites WHERE id = ANY($1::bigint[])`, [ids]);
      for (const s of ss) siteMap.set(Number(s.id), { id: Number(s.id), code: s.site_code || null, name: s.name });
    }
    return rows.map((r) => contactRow(r, siteMap));
  }
  const loadContacts = async (p) => (await p.query(`SELECT * FROM genba_contacts ORDER BY company NULLS LAST, name`)).rows;
  // あいまい検索の点数: 4 完全一致 / 3 鍵が検索語で始まる (菊池 → 菊池輝) / 2 検索語が鍵で始まる / 1 部分一致。
  // 鍵 = 名前・呼び名・会社名・ルーム名 (全部 normName)。room_id / chat_id はそのまま一致で 4
  function contactScore(r, rawQ) {
    const q = String(rawQ || "").trim();
    if (!q) return 0;
    const chans = Array.isArray(r.channels) ? r.channels : [];
    if (chans.some((c) => c.room_id && c.room_id === q)) return 4;
    if (chans.some((c) => c.chat_id && String(c.chat_id) === q)) return 4;
    const qn = normName(q);
    if (!qn) return 0;
    const keys = [r.name, ...(Array.isArray(r.aliases) ? r.aliases : []), r.company, ...chans.map((c) => c.room_name)]
      .filter(Boolean).map(normName).concat(r.company ? [normCompany(r.company)] : []).filter(Boolean);
    let best = 0;
    for (const k of keys) {
      if (k === qn) return 4;
      if (k.startsWith(qn)) best = Math.max(best, 3);
      else if (qn.startsWith(k) && k.length >= 2) best = Math.max(best, 2);
      else if (qn.length >= 2 && k.length >= 2 && (k.includes(qn) || qn.includes(k))) best = Math.max(best, 1);
    }
    return best;
  }
  // 候補を点数順に。完全一致があっても「菊池 → 菊池輝」のような前方一致は残す (自動で決めないため)。弱い一致だけ落とす
  function rankContacts(rows, q) {
    const scored = rows.map((r) => ({ r, s: contactScore(r, q) })).filter((x) => x.s > 0);
    if (!scored.length) return [];
    const max = Math.max(...scored.map((x) => x.s));
    const floor = max >= 3 ? max - 1 : 1;
    return scored.filter((x) => x.s >= floor).sort((a, b) => b.s - a.s || String(a.r.name).localeCompare(String(b.r.name), "ja")).map((x) => x.r);
  }
  // 数値 ID か、一意に引ける名前・呼び名。複数なら候補を並べて止まる (推測で決めない)
  async function resolveContact(p, ref) {
    const q = String(ref ?? "").trim();
    if (!q) throw new Error("contact (名前・呼び名・ID) が必要");
    if (/^\d+$/.test(q)) {
      const { rows } = await p.query(`SELECT * FROM genba_contacts WHERE id=$1`, [Number(q)]);
      if (!rows.length) throw new Error(`連絡先 ID ${q} が無い`);
      return rows[0];
    }
    const hits = rankContacts(await loadContacts(p), q);
    if (!hits.length) throw new Error(`連絡先が見つからない: ${q}。genba_contact_find で探すか genba_contact_upsert で登録する`);
    if (hits.length > 1) throw new Error(`候補が複数: ${hits.map((r) => `#${r.id} ${r.name}${r.company ? ` (${r.company})` : ""}`).join(" / ")}。ID か会社名で指定する (推測で決めない)`);
    return hits[0];
  }
  // 監視ジョブの source { sender, room } → 連絡先。sender で一意なら確定。複数ならそのルームを持つ人に絞る。
  // sender 無し (or 不明) で room が個人ルームとして 1 人だけに登録されていればその人
  async function resolveSourceContact(p, source, ctx = {}) {
    try {
      const rows = ctx.contacts || (ctx.contacts = await loadContacts(p));
      if (!rows.length) return null;
      const room = source.room ? String(source.room) : null;
      const inRoom = (r) => room && (Array.isArray(r.channels) ? r.channels : []).some((c) => c.room_id === room);
      if (source.sender) {
        let hits = rankContacts(rows, String(source.sender));
        if (hits.length > 1 && room) hits = hits.filter(inRoom);
        if (hits.length === 1) return hits[0];
        return null;
      }
      const byRoom = rows.filter((r) => inRoom(r) && !(r.channels || []).some((c) => c.room_id === room && c.kind === "group"));
      return byRoom.length === 1 ? byRoom[0] : null;
    } catch (e) { console.warn("[genba] contact resolve", e.message); return null; }
  }
  // 同期されたルーム (ID と名前) を連絡先の channels に結びつける: ルーム名が合えば room_id を埋め、room_id が合えばルーム名を埋める
  async function linkRoomsToContacts(p, rooms) {
    const named = rooms.filter((r) => r.name);
    if (!rooms.length) return 0;
    const rows = await loadContacts(p);
    let n = 0;
    for (const c of rows) {
      const chans = Array.isArray(c.channels) ? c.channels.map((x) => ({ ...x })) : [];
      let changed = false;
      for (const ch of chans) {
        if (!ch.room_id && ch.room_name) {
          const hits = named.filter((r) => normName(r.name) === normName(ch.room_name));
          if (hits.length === 1) { ch.room_id = hits[0].room; changed = true; }
        } else if (ch.room_id && !ch.room_name) {
          const hit = named.find((r) => r.room === ch.room_id);
          if (hit) { ch.room_name = hit.name; changed = true; }
        }
      }
      if (changed) { await p.query(`UPDATE genba_contacts SET channels=$2, updated_at=now() WHERE id=$1`, [c.id, JSON.stringify(chans)]); n++; }
    }
    return n;
  }
  // sites の名前/ID の配列 → sites.id の配列。一意に引けないものは warnings に
  async function resolveSiteIds(p, list, warnings) {
    const ids = [];
    for (const s of list) {
      const hits = await findSites(p, s);
      if (hits.length === 1) ids.push(Number(hits[0].id));
      else warnings.push(hits.length ? `現場「${s}」は候補が複数 (${hits.map((h) => h.site_code || "ID" + h.id).join(" / ")})。ID で指定する` : `現場「${s}」が見つからない`);
    }
    return ids;
  }
  const contactsNote = (hits) => (!hits.length ? "見つからない。推測で送らず人に聞く。新しい人なら genba_contact_upsert"
    : hits.length === 1 ? undefined : "候補が複数。自動で決めずに人に聞く (ID か会社名で絞れる)");

  // by = 書いた人 (トークンから決まる)
  function tools(by = "小西") {
    return [
      {
        name: "genba_contact_find",
        description: "人を探す (連絡先・呼び名)。名前・あだ名・会社名・LINE のルーム名・room_id をあいまい検索 (全角半角・空白・「さん」の有無・かな/カナを吸収)。人の名前やあだ名が出たら、送る前・記録する前に必ずこれで引く。match が入っていれば 1 人に確定。candidates が複数なら推測で決めず人に聞く",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "例: バカボン / 菊池 / 大丁工業 / !8YEO…:beeper.local" } }, required: ["query"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const hits = rankContacts(await loadContacts(p), a.query);
          const out = await contactsOut(p, hits);
          return { query: a.query, match: out.length === 1 ? out[0] : null, candidates: out, note: contactsNote(out) };
        },
      },
      {
        name: "genba_contact_upsert",
        description: "連絡先を登録・更新する。name + company で同一人物を判定 (company 省略時は同じ名前が 1 人だけならその人)。aliases / channels / sites は既存に足す (消えない)、他の項目は渡したものだけ上書き。channels の room_id は Beeper の変わらない ID (!xxxx:beeper.local) を正本にする。数字の chatID は chat_id に (補助)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "正式な名前 (例: 菊池)" },
            company: { type: "string", description: "会社名 (例: ㈱大丁工業)" },
            aliases: { type: "array", items: { type: "string" }, description: "呼び名・あだ名・表記ゆれ (例: バカボンさん, バカボン, 菊池さん)" },
            role: { type: "string", enum: CONTACT_ROLES, description: "職人 / 業者 / 元請け / 設計 / 客先 / 社内" },
            trade: { type: "string", description: "職種 (防水, 解体, 大工, 空調, 電気…)" },
            channels: {
              type: "array",
              items: { type: "object", properties: { channel: { type: "string", description: "LINE / iMessage / Mail (既定 LINE)" }, room_id: { type: "string" }, room_name: { type: "string" }, kind: { type: "string", enum: ["single", "group"] }, chat_id: { type: "string" } } },
              description: "連絡先のルーム。room_id か room_name のどちらかは必要",
            },
            tone: { type: "string", description: "言葉遣い (例: 丁寧語・「！」なし / 軽め・「！」可)" },
            sites: { type: "array", items: { type: "string" }, description: "関わっている現場 (案件 ID・現場名・ID)" },
            phone: { type: "string" }, email: { type: "string" }, notes: { type: "string" },
          },
          required: ["name"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const name = String(a.name || "").trim();
          if (!name) throw new Error("name が必要");
          const nameKey = normName(name);
          if (!nameKey) throw new Error("name が読めない");
          const company = a.company ? String(a.company).trim() : null;
          const companyKey = company ? normCompany(company) : "";
          const warnings = [];
          // 同一人物の判定
          const { rows: same } = await p.query(`SELECT * FROM genba_contacts WHERE name_key=$1`, [nameKey]);
          let cur = null;
          if (companyKey) cur = same.find((r) => r.company_key === companyKey) || (same.length === 1 && !same[0].company_key ? same[0] : null);
          else if (same.length === 1) cur = same[0];
          else if (same.length > 1) throw new Error(`同じ名前が複数: ${same.map((r) => `#${r.id} ${r.name} (${r.company || "会社なし"})`).join(" / ")}。company で区別する`);
          const aliases = uniqBy([...(cur && Array.isArray(cur.aliases) ? cur.aliases : []), ...toList(a.aliases)], normName);
          const channels = mergeChannels(cur ? cur.channels : [], (Array.isArray(a.channels) ? a.channels : [a.channels]).map(cleanChannel).filter(Boolean));
          const siteIds = [...new Set([...(cur && Array.isArray(cur.site_ids) ? cur.site_ids.map(Number) : []), ...(await resolveSiteIds(p, toList(a.sites ?? a.site), warnings))])];
          const role = a.role ? String(a.role).trim() : cur?.role || null;
          if (a.role && !CONTACT_ROLES.includes(role)) warnings.push(`role は ${CONTACT_ROLES.join(" / ")} のどれかが望ましい (指定: ${role})`);
          const pick = (k) => (a[k] != null && a[k] !== "" ? String(a[k]).trim() : cur?.[k] ?? null);
          // 既存に当たったら名前・会社の表記は最初に登録したものを残す (「菊池さん」「大丁工業」で呼んでも正式表記は変えない)
          const vals = [cur ? cur.name : name, nameKey, cur?.company || company || null, cur?.company_key || (company ? companyKey : ""),
            JSON.stringify(aliases), role, pick("trade"), JSON.stringify(channels), pick("tone"), JSON.stringify(siteIds),
            pick("phone"), pick("email"), pick("notes"), by];
          const { rows } = cur
            ? await p.query(
              `UPDATE genba_contacts SET name=$2, name_key=$3, company=$4, company_key=$5, aliases=$6, role=$7, trade=$8, channels=$9, tone=$10,
                      site_ids=$11, phone=$12, email=$13, notes=$14, updated_by=$15, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...vals])
            : await p.query(
              `INSERT INTO genba_contacts (name, name_key, company, company_key, aliases, role, trade, channels, tone, site_ids, phone, email, notes, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, vals);
          const [out] = await contactsOut(p, rows);
          return { ...out, created: !cur, warnings: warnings.length ? warnings : undefined };
        },
      },
      {
        name: "genba_contact_alias_add",
        description: "呼び名・あだ名を足す。「A は B のこと」「これ覚えといて」と言われたら呼ぶ。contact は名前・呼び名・ID (一意に引けないと止まるので、その時は ID か会社名で)",
        inputSchema: { type: "object", properties: { contact: { type: "string", description: "誰に足すか (名前・呼び名・ID)" }, alias: { type: "string", description: "足す呼び名 (複数は , 区切りか配列)" } }, required: ["contact", "alias"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const cur = await resolveContact(p, a.contact);
          const add = toList(a.alias);
          if (!add.length) throw new Error("alias が空");
          const before = Array.isArray(cur.aliases) ? cur.aliases : [];
          const aliases = uniqBy([...before, ...add], normName);
          const { rows } = await p.query(`UPDATE genba_contacts SET aliases=$2, updated_by=$3, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, JSON.stringify(aliases), by]);
          const [out] = await contactsOut(p, rows);
          return { ...out, added: aliases.slice(before.length) };
        },
      },
      {
        name: "genba_contact_list",
        description: "連絡先の一覧。site (現場) / role (職人・業者・元請け・設計・客先・社内) / trade (職種) で絞る。全部省略で全員",
        inputSchema: { type: "object", properties: { site: { type: "string", description: "案件 ID・現場名・ID" }, role: { type: "string" }, trade: { type: "string" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          let rows = await loadContacts(p);
          if (a.site) { const s = await resolveSite(p, a.site); rows = rows.filter((r) => (Array.isArray(r.site_ids) ? r.site_ids : []).map(Number).includes(Number(s.id))); }
          if (a.role) rows = rows.filter((r) => norm(r.role) === norm(a.role));
          if (a.trade) rows = rows.filter((r) => r.trade && (norm(r.trade).includes(norm(a.trade)) || norm(a.trade).includes(norm(r.trade))));
          return { count: rows.length, contacts: await contactsOut(p, rows) };
        },
      },
      {
        name: "genba_contact_remove",
        description: "連絡先を 1 件消す (小西のトークンからだけ)。間違えて登録したときの掃除用。普段は使わない",
        inputSchema: { type: "object", properties: { contact: { type: "string", description: "名前・呼び名・ID (一意に引けるもの)" } }, required: ["contact"] },
        handler: async (a) => {
          await ensureSchema();
          if (by !== "小西") throw new Error("この操作は小西のトークンからだけ");
          const p = getPool();
          const cur = await resolveContact(p, a.contact);
          await p.query(`DELETE FROM genba_contacts WHERE id=$1`, [cur.id]);
          return { removed: { id: Number(cur.id), name: cur.name, company: cur.company || null } };
        },
      },
      {
        name: "genba_find",
        description: "現場 (案件) を探す。案件 ID (例 2609-03)・名前・名前の一部で検索。表記ゆれ (全角半角・空白) は吸収する。チャットの指示文に案件 ID があれば呼ばなくていい",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const hits = await findSites(p, a.query, 10);
          return { sites: hits.map(siteRow), hint: hits.length ? undefined : "見つからない。genba_register で登録できる" };
        },
      },
      {
        name: "genba_register",
        description: "現場を登録、または既存の現場に案件 ID / Drive の案件フォルダ / 客先を紐付ける。name が既にあれば更新、無ければ新規作成。drive_folder_url は Drive の案件フォルダ (この下に 01_図面〜05_参考 を作る)",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "現場名 (現場アプリと同じ名前)" },
            code: { type: "string", description: "案件 ID (例 2609-03)" },
            drive_folder_url: { type: "string", description: "Drive の案件フォルダの URL か ID" },
            client: { type: "string", description: "客先" },
            address: { type: "string" },
          },
          required: ["name"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const name = String(a.name || "").trim();
          if (!name) throw new Error("name が必要");
          const folderId = a.drive_folder_url ? driveFolderIdOf(a.drive_folder_url) : null;
          if (a.drive_folder_url && !folderId) throw new Error(`Drive フォルダの URL / ID として読めない: ${a.drive_folder_url}`);
          const code = a.code ? String(a.code).trim() : null;
          const { rows } = await p.query(
            `INSERT INTO sites (name, address, site_code, drive_folder_id, client)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (name) DO UPDATE SET
               address = COALESCE(EXCLUDED.address, sites.address),
               site_code = COALESCE(EXCLUDED.site_code, sites.site_code),
               drive_folder_id = COALESCE(EXCLUDED.drive_folder_id, sites.drive_folder_id),
               client = COALESCE(EXCLUDED.client, sites.client)
             RETURNING *, (xmax = 0) AS inserted`,
            [name, a.address ? String(a.address).trim() : null, code, folderId, a.client ? String(a.client).trim() : null]
          );
          return { ...siteRow(rows[0]), created: !!rows[0].inserted };
        },
      },
      {
        name: "genba_folder",
        description: "写真・図面などを上げる Drive フォルダの URL を返す (無ければ案件フォルダの下に作る)。人はこの URL を Drive アプリで開いて上げるだけ。種類: 写真 / 図面 / 見積 (業者見積) / 資料 / 参考。上げた枚数の確認は list_site_photos",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID のどれか" },
            kind: { type: "string", enum: Object.keys(SUBFOLDERS), description: "既定 写真" },
          },
          required: ["site"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          const kind = a.kind || "写真";
          const f = await subfolder(site, kind);
          return {
            site: siteRow(site), kind, folder: f.name, url: folderUrl(f.id), created: f.created,
            say: `${site.name} の${kind}はここに上げてください: ${folderUrl(f.id)}`,
          };
        },
      },
      {
        name: "genba_log_add",
        description: "進捗ログに 1 行足す (追記のみ、消えない)。種類: 進捗 (やったこと・完了したこと) / 課題 / 決定 / 次やること (タスク) / 解決。人の報告は種類ごとに分けて複数回呼ぶ (例「ボード貼り完了、明日パテ。床レベル 3mm 狂い要相談」→ 進捗 + 次やること(due_on 明日) + 課題)。現場に紐づかない項目 (会社の雑務・Google マップのピン等) は site を省略する。やった人・担当は who、タスクは所要時間の目安を estimate_min (分) に入れる (「5 分で終わるタスクある？」は genba_tasks で引く)。課題や次やることが片付いたら kind=解決 で resolves_id に元の行 ID (site 省略可)。LINE 等のメッセージから記録するときは source_ref (メッセージ ID) を必ず付ける (同じものは 2 回入らない、duplicate: true が返る) と source に出どころ。書いた人はトークンから自動で入る",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID。省略 (または「会社」) = 現場に紐づかない項目" },
            who: { type: "string", description: "やった人 / 担当 (例: 名取)。省略可" },
            estimate_min: { type: "number", description: "所要時間の目安 (分)。タスク (次やること・課題) に付ける" },
            kind: { type: "string", enum: LOG_KINDS },
            body: { type: "string", description: "本文 (短く。1 行 1 件。決定は型番・数量・金額を省略しない)" },
            due_on: { type: "string", description: "期限 YYYY-MM-DD (次やること・課題)" },
            resolves_id: { type: "number", description: "kind=解決 のとき、解決した元の行 ID" },
            photo_ids: { type: "array", items: { type: "string" }, description: "関連する Drive の写真ファイル ID (list_site_photos の file_id)" },
            source_ref: { type: "string", description: "出どころの一意キー (例 LINE:<room>:<message id>)。同じ source_ref は 2 回記録されない" },
            source: { type: "object", description: "出どころ { channel, room, sender, at, quote } など自由" },
          },
          required: ["kind", "body"],
        },
        handler: async (a) => {
          await ensureSchema();
          return addLog(getPool(), by, a);
        },
      },
      {
        name: "genba_log_add_many",
        description: "進捗ログを複数行まとめて足す (監視ジョブや、会話を貼られて一度に抽出したとき用)。items の各要素は genba_log_add と同じ引数 (site を省略したら共通の site)。1 件ずつ入るので途中で失敗しても前の行は残る。結果に各行の duplicate が付く",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "共通の現場 (各 item に site があればそちら優先)" },
            items: { type: "array", items: { type: "object" }, description: "最大 50 件" },
          },
          required: ["items"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const items = Array.isArray(a.items) ? a.items.slice(0, 50) : [];
          if (!items.length) throw new Error("items が空");
          const results = [];
          let added = 0, dup = 0, failed = 0;
          const ctx = {}; // 連絡先の読み込みを 1 回にまとめる
          for (const it of items) {
            try {
              const r = await addLog(p, by, { ...it, site: it.site || a.site }, undefined, ctx);
              results.push({ ok: true, duplicate: r.duplicate, log: r.log, site: r.site });
              if (r.duplicate) dup++; else added++;
            } catch (e) {
              failed++;
              results.push({ ok: false, error: e.message, item: { kind: it.kind, body: String(it.body || "").slice(0, 80) } });
            }
          }
          return { added, duplicate: dup, failed, results };
        },
      },
      {
        name: "genba_log_list",
        description: "進捗ログの一覧 (新しい順)。site 省略 = 現場に紐づかない項目、site \"*\" = 全現場横断。days で期間、kind で種類、who で人を絞る (例: 名取が今週やったこと = who=名取, kind=進捗, days=7)。普段は genba_status で足りる",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID。省略 = 会社全般、\"*\" = 全部" },
            who: { type: "string", description: "人で絞る" },
            days: { type: "number", description: "既定 30" },
            kind: { type: "string", enum: LOG_KINDS },
            limit: { type: "number", description: "既定 50、最大 200" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const all = a.site === "*" || a.site === "全部";
          const site = all ? null : await resolveSiteOrNull(p, a.site);
          const days = Math.max(1, Math.min(3650, Number(a.days) || 30));
          const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
          const where = [`l.created_at > now() - ($1 || ' days')::interval`];
          const vals = [String(days)];
          if (!all) { if (site) { vals.push(site.id); where.push(`l.site_id=$${vals.length}`); } else where.push(`l.site_id IS NULL`); }
          if (a.kind) { vals.push(a.kind); where.push(`l.kind=$${vals.length}`); }
          if (a.who) { vals.push(String(a.who)); where.push(`l.who=$${vals.length}`); }
          vals.push(limit);
          const { rows } = await p.query(
            `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
              WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT $${vals.length}`, vals);
          return { site: all ? "*" : (site ? siteRow(site) : null), days, logs: rows.map(logRow) };
        },
      },
      {
        name: "genba_tasks",
        description: "未解決のタスク (次やること・課題) を全現場横断で引く。「5 分で終わるタスクある？」→ max_minutes=5、「名取の分」→ who=名取。所要時間が短い順 → 期限順。現場なしの雑務も含む。返ってきた候補から 1〜3 件を提案し、やったら kind=解決 で閉じる",
        inputSchema: {
          type: "object",
          properties: {
            max_minutes: { type: "number", description: "所要時間の上限 (分)。省略で全部 (所要時間未設定も含む)" },
            who: { type: "string", description: "担当で絞る (未割当も含めたいときは省略)" },
            site: { type: "string", description: "現場で絞る (省略で全現場 + 会社全般)" },
            kind: { type: "string", enum: ["次やること", "課題"], description: "省略で両方" },
            limit: { type: "number", description: "既定 20" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const where = [`l.kind IN ('次やること','課題')`, `NOT EXISTS (SELECT 1 FROM genba_log r WHERE r.resolves_id = l.id)`];
          const vals = [];
          if (a.kind) { vals.push(a.kind); where.push(`l.kind=$${vals.length}`); }
          if (a.max_minutes != null) { vals.push(Math.max(1, Math.round(Number(a.max_minutes) || 0))); where.push(`l.estimate_min IS NOT NULL AND l.estimate_min <= $${vals.length}`); }
          if (a.who) { vals.push(String(a.who)); where.push(`(l.who=$${vals.length} OR l.who IS NULL)`); }
          if (a.site) { const site = await resolveSite(p, a.site); vals.push(site.id); where.push(`l.site_id=$${vals.length}`); }
          vals.push(Math.max(1, Math.min(100, Number(a.limit) || 20)));
          const { rows } = await p.query(
            `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
              WHERE ${where.join(" AND ")}
              ORDER BY (l.estimate_min IS NULL), l.estimate_min, l.due_on NULLS LAST, l.created_at
              LIMIT $${vals.length}`, vals);
          const today = todayJst();
          return {
            today,
            tasks: rows.map(logRow).map((r) => ({ ...r, overdue: !!(r.due_on && r.due_on < today) })),
            hint: rows.length ? "候補を 1〜3 件に絞って提案。やったら genba_log_add(kind=解決, resolves_id=その id)" : "条件に合う未解決タスクは無い",
          };
        },
      },
      {
        name: "genba_status",
        description: "現場の今の状況を集計して返す: 最終更新・直近の進捗・未解決の課題・次やること・最近の決定。「今どうなってる？」にはこれを読んで要約する",
        inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          const [last, prog, open, dec, cnt] = await Promise.all([
            p.query(`SELECT written_by, created_at FROM genba_log WHERE site_id=$1 ORDER BY created_at DESC LIMIT 1`, [site.id]),
            p.query(`SELECT * FROM genba_log WHERE site_id=$1 AND kind='進捗' ORDER BY created_at DESC LIMIT 3`, [site.id]),
            p.query(
              `SELECT l.* FROM genba_log l
                WHERE l.site_id=$1 AND l.kind IN ('課題','次やること')
                  AND NOT EXISTS (SELECT 1 FROM genba_log r WHERE r.resolves_id = l.id)
                ORDER BY l.due_on NULLS LAST, l.created_at`, [site.id]),
            p.query(`SELECT * FROM genba_log WHERE site_id=$1 AND kind='決定' ORDER BY created_at DESC LIMIT 3`, [site.id]),
            p.query(`SELECT kind, COUNT(*)::int AS n FROM genba_log WHERE site_id=$1 GROUP BY kind`, [site.id]),
          ]);
          const today = todayJst();
          const openRows = open.rows.map(logRow).map((r) => ({ ...r, overdue: !!(r.due_on && r.due_on < today) }));
          return {
            site: siteRow(site),
            today,
            last_update: last.rows[0] ? { by: last.rows[0].written_by, at: last.rows[0].created_at } : null,
            recent_progress: prog.rows.map(logRow),
            open_issues: openRows.filter((r) => r.kind === "課題"),
            todos: openRows.filter((r) => r.kind === "次やること"),
            recent_decisions: dec.rows.map(logRow),
            counts: Object.fromEntries(cnt.rows.map((r) => [r.kind, r.n])),
          };
        },
      },
      {
        name: "genba_rule_get",
        description: "運用ルールを読む (最新版)。会話の最初に topic 省略で一覧を読む。topic 指定でその本文。例: 写真 / 進捗 / 見積 / フォルダ",
        inputSchema: { type: "object", properties: { topic: { type: "string" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          // 一覧は「連絡先」を先頭に (人の名前が出たら最初に引く約束を最初に読ませる)
          const { rows } = await p.query(
            `SELECT * FROM (
               SELECT DISTINCT ON (topic) topic, version, body, updated_by, created_at
                 FROM genba_rules ${a.topic ? "WHERE topic=$1" : ""}
                ORDER BY topic, version DESC) t
              ORDER BY (topic <> '連絡先'), topic`, a.topic ? [String(a.topic)] : []);
          if (a.topic) {
            if (!rows.length) return { topic: a.topic, body: null, note: "このトピックのルールはまだ無い" };
            const r = rows[0];
            return { topic: r.topic, version: r.version, body: r.body, updated_by: r.updated_by, at: r.created_at };
          }
          return { rules: rows.map((r) => ({ topic: r.topic, version: r.version, body: r.body, updated_by: r.updated_by, at: r.created_at })) };
        },
      },
      {
        name: "genba_rule_set",
        description: "運用ルールを書き換える (新しい版を積む。前の版は消えない)。topic 単位で本文を丸ごと渡す。変更前に genba_rule_get で現行を見せて OK をもらってから",
        inputSchema: { type: "object", properties: { topic: { type: "string" }, body: { type: "string" } }, required: ["topic", "body"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const topic = String(a.topic || "").trim(), body = String(a.body || "").trim();
          if (!topic || !body) throw new Error("topic と body が必要");
          const { rows } = await p.query(
            `INSERT INTO genba_rules (topic, version, body, updated_by)
             VALUES ($1, COALESCE((SELECT MAX(version) FROM genba_rules WHERE topic=$1), 0) + 1, $2, $3)
             RETURNING topic, version, updated_by, created_at`,
            [topic, body, by]);
          return { ...rows[0], note: `版 ${rows[0].version} として保存。次の会話から全 AI に効く` };
        },
      },
      {
        name: "genba_room_sync",
        description: "監視ジョブの最初に、自分の Beeper / LINE のルーム一覧 (ID と名前だけ。本文は送らない) を同期する。画面 (/genba/watch.html) にトグル付きで並ぶ。同期しても監視は ON にならない (ON/OFF は画面か genba_source_add)。返り値の watching に ON のルームと現場が入るので、そのまま読む対象にする",
        inputSchema: {
          type: "object",
          properties: {
            rooms: { type: "array", items: { type: "object", properties: { channel: { type: "string" }, room: { type: "string" }, name: { type: "string" } }, required: ["channel", "room"] }, description: "最大 300 件" },
          },
          required: ["rooms"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const rooms = (Array.isArray(a.rooms) ? a.rooms : []).slice(0, 300)
            .map((r) => ({ channel: String(r.channel || "").trim(), room: String(r.room || "").trim(), name: r.name ? String(r.name).trim().slice(0, 200) : null }))
            .filter((r) => r.channel && r.room);
          for (const r of rooms) {
            await p.query(
              `INSERT INTO genba_sources (owner, channel, room, name, added_by, last_seen_at)
               VALUES ($1, $2, $3, $4, $1, now())
               ON CONFLICT (owner, channel, room) DO UPDATE SET name = COALESCE(EXCLUDED.name, genba_sources.name), last_seen_at = now()`,
              [by, r.channel, r.room, r.name]);
          }
          // 連絡先に room_name だけ入っているルームは、ここで room_id が埋まる (逆も)
          const contactsLinked = await linkRoomsToContacts(p, rooms);
          const { rows } = await p.query(
            `SELECT g.channel, g.room, g.name, g.label, g.cursor, g.site_id, s.name AS site_name, s.site_code
               FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled AND g.site_id IS NOT NULL ORDER BY g.channel, g.name NULLS LAST, g.room`, [by]);
          return {
            synced: rooms.length,
            contactsLinked,
            watching: rows.map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: { id: Number(r.site_id), code: r.site_code || null, name: r.site_name }, cursor: r.cursor || null })),
            note: "watching に無いルームは読まない。ON/OFF は /genba/watch.html",
          };
        },
      },
      {
        name: "genba_source_add",
        description: "ルーム (LINE グループ等) を現場に紐付けて監視 ON にする (自分の持ち分だけ)。画面 /genba/watch.html のトグルと同じ。登録されていないルームは監視ジョブが読まない",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "LINE / Beeper / Slack など" },
            room: { type: "string", description: "ルーム ID (監視側が一意に引ける文字列)" },
            site: { type: "string", description: "案件 ID・現場名・ID" },
            label: { type: "string", description: "人が見て分かる名前 (例: 田中様 LINE)" },
          },
          required: ["channel", "room", "site"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          const { rows } = await p.query(
            `INSERT INTO genba_sources (owner, channel, room, label, site_id, enabled, added_by)
             VALUES ($1, $2, $3, $4, $5, true, $1)
             ON CONFLICT (owner, channel, room) DO UPDATE SET site_id = EXCLUDED.site_id, label = COALESCE(EXCLUDED.label, genba_sources.label), enabled = true, updated_at = now()
             RETURNING *`,
            [by, String(a.channel).trim(), String(a.room).trim(), a.label ? String(a.label).trim() : null, site.id]);
          return { owner: by, channel: rows[0].channel, room: rows[0].room, name: rows[0].name, label: rows[0].label, site: siteRow(site), enabled: rows[0].enabled };
        },
      },
      {
        name: "genba_source_list",
        description: "監視 ON のルーム一覧 (自分の持ち分) と、各ルームの cursor (どこまで読んだか)。監視ジョブはここに無いルームを読まない",
        inputSchema: { type: "object", properties: { channel: { type: "string", description: "絞り込み (省略で全部)" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const { rows } = await p.query(
            `SELECT g.*, s.name AS site_name, s.site_code FROM genba_sources g JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled ${a.channel ? "AND g.channel=$2" : ""} ORDER BY g.channel, g.name NULLS LAST, g.room`,
            a.channel ? [by, String(a.channel)] : [by]);
          return { owner: by, sources: rows.map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: { id: Number(r.site_id), code: r.site_code || null, name: r.site_name }, cursor: r.cursor || null, updated_at: r.updated_at })) };
        },
      },
      {
        name: "genba_source_mark",
        description: "監視ジョブが「このルームはここまで読んだ」を記録する。cursor は自由な JSON (例 { last_id: \"...\", last_at: \"2026-10-09T15:00:00+09:00\" })。次回はこれより後だけ読む",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" }, room: { type: "string" }, cursor: { type: "object" } },
          required: ["channel", "room", "cursor"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const { rows } = await p.query(
            `UPDATE genba_sources SET cursor=$4, updated_at=now() WHERE owner=$1 AND channel=$2 AND room=$3 RETURNING channel, room, cursor, updated_at`,
            [by, String(a.channel).trim(), String(a.room).trim(), JSON.stringify(a.cursor || {})]);
          if (!rows.length) throw new Error(`監視対象に無い: ${a.channel} / ${a.room} (genba_room_sync か genba_source_add で登録)`);
          return rows[0];
        },
      },
      {
        name: "genba_source_remove",
        description: "監視を OFF にする (自分の持ち分)。ルームは一覧に残り、過去に記録したログも残る。forget: true で一覧からも消す (次の同期でまた出てくる)",
        inputSchema: { type: "object", properties: { channel: { type: "string" }, room: { type: "string" }, forget: { type: "boolean", description: "true で行ごと削除 (既定 false = OFF にするだけ)" } }, required: ["channel", "room"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const args = [by, String(a.channel).trim(), String(a.room).trim()];
          if (a.forget) {
            const { rowCount } = await p.query(`DELETE FROM genba_sources WHERE owner=$1 AND channel=$2 AND room=$3`, args);
            return { removed: rowCount > 0 };
          }
          const { rowCount } = await p.query(`UPDATE genba_sources SET enabled=false, updated_at=now() WHERE owner=$1 AND channel=$2 AND room=$3`, args);
          return { disabled: rowCount > 0 };
        },
      },
      {
        name: "genba_owner_set",
        description: "画面 (/genba/watch.html) のログイン (メール) と、監視トークンの名前を結びつける (例: 名取のメール → 名取)。小西のトークンからだけ使える",
        inputSchema: { type: "object", properties: { email: { type: "string" }, label: { type: "string", description: "トークンの名前と同じ文字列 (小西 / 名取 / LINE監視 …)" } }, required: ["email", "label"] },
        handler: async (a) => {
          await ensureSchema();
          if (by !== "小西") throw new Error("この操作は小西のトークンからだけ");
          const p = getPool();
          const email = String(a.email || "").trim().toLowerCase(), label = String(a.label || "").trim();
          if (!email.includes("@") || !label) throw new Error("email と label が必要");
          await p.query(`INSERT INTO genba_owners (email, label) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET label = EXCLUDED.label, updated_at = now()`, [email, label]);
          return { email, label };
        },
      },
    ];
  }

  const INSTRUCTIONS = [
    "現場 (genba_*): 1 現場 1 チャットで使う。データとルールは Keihi 側にあるので、どの AI からでも同じ。",
    "- 会話の最初に genba_rule_get (topic 省略) で運用ルールを読む (無ければ空のまま進める)",
    "- 人の名前・あだ名が出たら、送る前・記録する前に必ず genba_contact_find で引く (下の ■ 連絡先)",
    "- 現場の特定: チャットの指示文に案件 ID があればそれ。無ければ genba_find(現場名)。候補が複数なら人に聞く",
    "- 「写真 (図面) 上げたい」→ genba_folder(現場, 種類) の url を渡す。人はそこに Drive アプリで上げる。何枚入ったかは list_site_photos",
    "- 進捗の報告は genba_log_add に種類ごとに分けて積む: 進捗 / 課題 / 決定 / 次やること (期限があれば due_on)。1 行 1 件、短く",
    "- 課題・次やることが片付いたら kind=解決 で resolves_id に元の行 ID (状態の上書きはしない)",
    "- 「今どうなってる？」→ genba_status を読んで要約 (全文が要るときだけ genba_log_list)",
    "- やったこと・完了したこと (細かいものも) は kind=進捗 で who 付きで積む (例「名取が満竹華庵のシャンプーを買った」→ site=満竹華庵, kind=進捗, who=名取)。現場に紐づかない雑務は site を省略",
    "- タスクには estimate_min (分) を付ける。「5 分で終わるタスクある？」「手が空いた」→ genba_tasks(max_minutes) から 1〜3 件を提案し、やったら kind=解決 で閉じる",
    "- ルールの変更は genba_rule_set (版が増えるだけ。消えない)。書く前に現行を見せて OK をもらう",
    "- 書いた人はトークンから自動で入る。AI が名前を書かない",
    "■ 連絡先・呼び名 (genba_contact_*)。人はあだ名や下の名前で呼ばれる (例: バカボンさん = ㈱大丁工業 菊池)。誰か / どのルームに送るか / どんな言葉遣いか は全 AI で同じ答えにする",
    "- 名前・あだ名・会社名・ルーム名が出たら genba_contact_find。match が入れば確定。見つからない / candidates が複数なら推測で送らず人に聞く",
    "- 「A は B のこと」「覚えといて」と言われたら genba_contact_alias_add(contact, alias)",
    "- 返信案は contact の tone に合わせて書く (丁寧語・「！」なし / 軽め・「！」可)",
    "- 新しい人・会社・LINE ルームが分かったら genba_contact_upsert (name + company で同一人物)。room_id は Beeper の変わらない ID (!xxxx:beeper.local) を正本に、数字の chatID は chat_id に",
    "- 現場ごと・職種ごとの顔ぶれは genba_contact_list(site, role, trade)",
    "■ 監視ジョブ (Cowork 等で 5 分ごとに LINE などを読んで自動記録するとき)",
    "1. genba_room_sync に Beeper 等のルーム一覧 (ID と名前だけ) を渡す → 返り値 watching が読む対象 (ON/OFF は画面 /genba/watch.html)。watching に無いルームは読まない",
    "2. 各ルームについて cursor より後のメッセージだけ読む (Beeper 等の MCP)",
    "3. 決定・課題・次やること を抽出して genba_log_add_many で記録。各 item に source_ref = \"<channel>:<room>:<message id>\" を必ず入れる (同じメッセージは 2 回入らない)、source に { channel, room, sender, at, quote } (sender は表示名そのまま。連絡先に解決できればサーバーが contact_id を足す)",
    "4. 最後に genba_source_mark(channel, room, { last_id, last_at }) で cursor を進める",
    "5. 新着が無ければ何もしない。雑談・曖昧なものは記録しない。記録したら件数と中身を短く報告",
  ].join("\n");

  // 人ごとのトークン: { token: 名前 }。URL の token で書いた人を決める
  function mcpRoute(tokens) {
    const map = tokens || {};
    const handlers = new Map();
    return (req, res) => {
      const by = map[req.params.token];
      if (!by) return res.status(403).json({ error: "forbidden" });
      if (!handlers.has(by)) handlers.set(by, createMcpHandler({ name: "genba", instructions: INSTRUCTIONS, tools: tools(by) }));
      return handlers.get(by)(req, res);
    };
  }

  // 画面 (/genba/watch.html) 用。認証ミドルウェアの後にマウントする (req.user.email が要る)
  async function ownerOf(p, email) {
    const { rows } = await p.query(`SELECT label FROM genba_owners WHERE email=$1`, [String(email || "").toLowerCase()]);
    return rows[0]?.label || null;
  }
  function registerRoutes(app) {
    const wrap = (fn) => async (req, res) => {
      const p = getPool();
      if (!p) return res.status(503).json({ error: "DB not configured" });
      try { await ensureSchema(); await fn(p, req, res); }
      catch (e) { console.error("[genba] route", e); res.status(500).json({ error: e.message }); }
    };
    app.get("/api/genba/me", wrap(async (p, req, res) => {
      res.json({ email: req.user.email, owner: await ownerOf(p, req.user.email) });
    }));
    // 自分のルーム一覧 (ON/OFF 問わず)
    app.get("/api/genba/rooms", wrap(async (p, req, res) => {
      const owner = await ownerOf(p, req.user.email);
      if (!owner) return res.json({ owner: null, rooms: [] });
      const { rows } = await p.query(
        `SELECT g.id, g.channel, g.room, g.name, g.label, g.enabled, g.site_id, g.cursor, g.last_seen_at, g.updated_at,
                s.name AS site_name, s.site_code
           FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
          WHERE g.owner=$1 ORDER BY g.enabled DESC, g.channel, g.name NULLS LAST, g.room`, [owner]);
      res.json({ owner, rooms: rows.map((r) => ({
        id: Number(r.id), channel: r.channel, room: r.room, name: r.name, label: r.label, enabled: r.enabled,
        siteId: r.site_id ? Number(r.site_id) : null, siteName: r.site_name || null, siteCode: r.site_code || null,
        cursor: r.cursor || null, lastSeenAt: r.last_seen_at, updatedAt: r.updated_at,
      })) });
    }));
    // トグル / 現場の割当 / メモ
    app.put("/api/genba/rooms/:id", wrap(async (p, req, res) => {
      const owner = await ownerOf(p, req.user.email);
      if (!owner) return res.status(403).json({ error: "持ち主が未登録 (genba_owner_set)" });
      const id = Number(req.params.id);
      const b = req.body || {};
      const sets = [], vals = [owner, id];
      if (typeof b.enabled === "boolean") { vals.push(b.enabled); sets.push(`enabled=$${vals.length}`); }
      if ("siteId" in b) { vals.push(b.siteId == null ? null : Number(b.siteId)); sets.push(`site_id=$${vals.length}`); }
      if ("label" in b) { vals.push(b.label ? String(b.label).trim().slice(0, 200) : null); sets.push(`label=$${vals.length}`); }
      if (!sets.length) return res.status(400).json({ error: "変更が無い" });
      const { rows } = await p.query(`UPDATE genba_sources SET ${sets.join(", ")}, updated_at=now() WHERE owner=$1 AND id=$2 RETURNING id, enabled, site_id`, vals);
      if (!rows.length) return res.status(404).json({ error: "not found" });
      if (rows[0].enabled && !rows[0].site_id) {
        // 現場が無いまま ON にはできない (ログの行き先が無い)
        await p.query(`UPDATE genba_sources SET enabled=false WHERE id=$1`, [id]);
        return res.status(400).json({ error: "現場を選んでから ON にする" });
      }
      res.json({ id: Number(rows[0].id), enabled: rows[0].enabled, siteId: rows[0].site_id ? Number(rows[0].site_id) : null });
    }));
    // 一覧から消す (同期されればまた出てくる)
    app.delete("/api/genba/rooms/:id", wrap(async (p, req, res) => {
      const owner = await ownerOf(p, req.user.email);
      if (!owner) return res.status(403).json({ error: "持ち主が未登録" });
      await p.query(`DELETE FROM genba_sources WHERE owner=$1 AND id=$2`, [owner, Number(req.params.id)]);
      res.status(204).end();
    }));
  }

  return { tools, instructions: INSTRUCTIONS, mcpRoute, ensureSchema, registerRoutes };
}
