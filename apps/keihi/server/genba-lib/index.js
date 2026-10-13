// 現場 (genba) MCP: 案件・進捗ログ・運用ルールを Postgres に持ち、写真の置き場 (Drive フォルダ URL) を返す。
// 「1 現場 1 チャット」で AI (Claude / ChatGPT / 次の何か) が同じ口から使う前提。データとルールは Keihi 側に残る。
//
// 置き場の線引き:
//   正本 = Postgres (sites に案件 ID と Drive フォルダ ID を足す / genba_log は追記のみ / genba_rules は版を積む)
//   写真・図面 = Drive の案件フォルダ (人が Drive アプリで直接上げる。Keihi はフォルダ URL を返すだけ)
// 書いた人は MCP のトークンから決める (AI が名前を書く余地を作らない)。

import crypto from "node:crypto";

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
const kanaFold = (s) => s.replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
function normName(s) {
  const t = String(s || "").normalize("NFKC").trim().replace(HONORIFIC_RE, "");
  return kanaFold(norm(t));
}
// 会社名: 株式会社 / (株) / ㈱ 等の法人格を落とす (NFKC で ㈱ → (株) になる)。かなはカタカナに寄せる
function normCompany(s) {
  return kanaFold(norm(String(s || "").normalize("NFKC").replace(/株式会社|有限会社|合同会社|合資会社|\(株\)|\(有\)|\(同\)|㈱|㈲/g, "")));
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

// gcs = { bucket, getStorage, publicUrl, secret }: LINE 等から来た画像を PC 側 (Cowork) が PUT で流し込む口と、その署名 URL
export function createGenba({ getPool, createMcpHandler, getDriveApi, gcs = null }) {
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
    // 決定の変更: topic (何についての決定か) と supersedes_id (置き換えた前の行)。「今生きている決定」= 置き換えられていない行
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS topic TEXT`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS supersedes_id BIGINT REFERENCES genba_log(id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_log_supersedes_idx ON genba_log (supersedes_id) WHERE supersedes_id IS NOT NULL`);
    // 訂正と取り消し: 追記のみは崩さず、直したら edits に前の値を残し、消すときは voided_at で隠す (物理削除しない)
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS edits JSONB`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS voided_by TEXT`);
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS void_reason TEXT`);
    // 一覧用の短いタイトル (40 字まで)。body は詳細として残す。空なら返すときだけ body の先頭 28 字を出す (DB には書かない)
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS title TEXT`);
    // 画像・PDF (LINE 等から来たもの)。中身は GCS、ここは台帳。source_ref で同じ添付を 2 回入れない
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_files (
        id           BIGSERIAL PRIMARY KEY,
        site_id      BIGINT REFERENCES sites(id) ON DELETE SET NULL,
        kind         TEXT NOT NULL DEFAULT '写真',   -- 写真 / 図面 / 資料 / その他
        gcs_url      TEXT NOT NULL,
        filename     TEXT,
        content_type TEXT,
        bytes        BIGINT,
        source_ref   TEXT,
        source       JSONB,
        uploaded_by  TEXT NOT NULL,
        log_id       BIGINT REFERENCES genba_log(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        voided_at    TIMESTAMPTZ,
        voided_by    TEXT
      )`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS genba_files_source_ref_uq ON genba_files (source_ref) WHERE source_ref IS NOT NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_files_site_idx ON genba_files (site_id, created_at DESC)`);
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
    // 用途: 記録 (現場の進捗を自動記録。現場が要る) / 応答 (社内の人からの問い合わせに AI が答える。現場は要らない)
    await p.query(`ALTER TABLE genba_sources ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '記録'`);
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
    // 会社: 連絡先の company (文字列) を本体にする。価格感・得意工事・評価は個人ではなく会社に付く
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_companies (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        name_key    TEXT NOT NULL UNIQUE,          -- normCompany(name)
        aliases     JSONB NOT NULL DEFAULT '[]',
        role        TEXT,                          -- 業者 / 元請け / 設計 / 客先 / 社内
        trades      JSONB NOT NULL DEFAULT '[]',   -- 得意工事・職種
        phone       TEXT,
        email       TEXT,
        address     TEXT,
        notes       TEXT,
        updated_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`ALTER TABLE genba_contacts ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES genba_companies(id) ON DELETE SET NULL`);
    // 既存の連絡先の会社文字列から会社を起こして結ぶ (済んだ行には効かない)
    await p.query(`
      INSERT INTO genba_companies (name, name_key, updated_by)
        SELECT DISTINCT ON (company_key) company, company_key, 'system' FROM genba_contacts
         WHERE company_id IS NULL AND company IS NOT NULL AND company_key <> ''
         ORDER BY company_key, id
        ON CONFLICT (name_key) DO NOTHING`);
    await p.query(`
      UPDATE genba_contacts c SET company_id = k.id FROM genba_companies k
       WHERE c.company_id IS NULL AND c.company_key <> '' AND k.name_key = c.company_key`);
    // メモ = 流れない情報。人・会社・現場・社内 にぶら下がる性質・予定・評価・決まり。期限付き。消さずに引退させる
    // (出来事は genba_log に流す。ここは「今もそうである」こと)
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_notes (
        id            BIGSERIAL PRIMARY KEY,
        subject_type  TEXT NOT NULL CHECK (subject_type IN ('contact','company','site','general')),
        subject_id    BIGINT,                      -- general (社内) は NULL
        kind          TEXT NOT NULL DEFAULT 'メモ' CHECK (kind IN ('性質','予定','評価','ルール','メモ')),
        body          TEXT NOT NULL,
        valid_from    DATE,                        -- 「来月から」
        valid_until   DATE,                        -- 「〜まで」
        written_by    TEXT NOT NULL,
        source_ref    TEXT,                        -- 監視ジョブの重複防止
        source        JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        retired_at    TIMESTAMPTZ,
        retired_by    TEXT,
        retired_reason TEXT
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS genba_notes_subject_idx ON genba_notes (subject_type, subject_id) WHERE retired_at IS NULL`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS genba_notes_source_ref_uq ON genba_notes (source_ref) WHERE source_ref IS NOT NULL`);
    await p.query(`ALTER TABLE genba_notes ADD COLUMN IF NOT EXISTS title TEXT`);
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

  const TITLE_MAX = 40;
  // title の入力チェック: 空は null、40 字まで
  function cleanTitle(v) {
    if (v == null) return null;
    const t = String(v).trim().replace(/\s+/g, " ");
    if (!t) return null;
    if ([...t].length > TITLE_MAX) throw new Error(`title は ${TITLE_MAX} 字まで (${[...t].length} 字)`);
    return t;
  }
  const autoTitle = (body) => { const s = String(body || "").replace(/\s+/g, " ").trim(); const cs = [...s]; return cs.length > 28 ? cs.slice(0, 28).join("") : s; };
  const logRow = (r) => ({
    id: Number(r.id), kind: r.kind, title: r.title || autoTitle(r.body), title_auto: r.title ? undefined : true, body: r.body, by: r.written_by,
    due_on: ymd(r.due_on),
    resolves_id: r.resolves_id ? Number(r.resolves_id) : null,
    photo_ids: Array.isArray(r.photo_ids) && r.photo_ids.length ? r.photo_ids : undefined,
    source_ref: r.source_ref || undefined,
    source: r.source || undefined,
    estimate_min: r.estimate_min != null ? Number(r.estimate_min) : undefined,
    who: r.who || undefined,
    topic: r.topic || undefined,
    supersedes_id: r.supersedes_id ? Number(r.supersedes_id) : undefined,
    superseded_by: r.superseded_by ? Number(r.superseded_by) : undefined,
    edited: Array.isArray(r.edits) && r.edits.length ? r.edits.length : undefined,
    voided: r.voided_at ? { at: r.voided_at, by: r.voided_by, reason: r.void_reason || undefined } : undefined,
    site: r.site_name !== undefined ? (r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null) : undefined,
    at: r.created_at,
  });
  // 「生きている行」の条件 (SQL 断片、別名 l 前提): 取り消されていない / 解決されていない / 置き換えられていない
  const LIVE = `l.voided_at IS NULL`;
  const NOT_RESOLVED = `NOT EXISTS (SELECT 1 FROM genba_log r WHERE r.resolves_id = l.id AND r.voided_at IS NULL)`;
  const NOT_SUPERSEDED = `NOT EXISTS (SELECT 1 FROM genba_log n WHERE n.supersedes_id = l.id AND n.voided_at IS NULL)`;
  // 行の一覧に「この行を置き換えた行の ID」を付ける
  async function withSupersededBy(p, rows) {
    const ids = rows.map((r) => Number(r.id));
    if (!ids.length) return rows;
    const { rows: nx } = await p.query(`SELECT id, supersedes_id FROM genba_log WHERE supersedes_id = ANY($1::bigint[]) AND voided_at IS NULL`, [ids]);
    const map = new Map(nx.map((n) => [Number(n.supersedes_id), Number(n.id)]));
    return rows.map((r) => ({ ...r, superseded_by: map.get(Number(r.id)) ?? null }));
  }

  // 1 行追記 (genba_log_add / genba_log_add_many 共通)。source_ref があれば重複は 2 回入らない
  async function addLog(p, by, a, siteRowCache, ctx = {}) {
    const site = siteRowCache || await resolveSiteOrNull(p, a.site);
    const siteId = site ? site.id : null;
    if (!LOG_KINDS.includes(a.kind)) throw new Error(`kind は ${LOG_KINDS.join(" / ")}`);
    const body = String(a.body || "").trim();
    if (!body) throw new Error("body が空");
    const title = cleanTitle(a.title);
    let resolvesId = null;
    if (a.kind === "解決") {
      resolvesId = Number(a.resolves_id);
      if (!Number.isInteger(resolvesId)) throw new Error("kind=解決 には resolves_id (元の課題/次やることの行 ID) が必要");
      const { rows: orig } = await p.query(`SELECT id, kind, site_id FROM genba_log WHERE id=$1 AND voided_at IS NULL`, [resolvesId]);
      if (!orig.length) throw new Error(`行 ${resolvesId} が無い (か取り消し済み)`);
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
    // 変更の紐付け: supersedes_id が指定されればそれ、無ければ 決定 + topic で同じ現場の生きている決定を自動で引く
    const topic = a.topic ? String(a.topic).trim().slice(0, 60) : null;
    let supersedesId = null, superseded = null;
    if (a.supersedes_id != null && a.supersedes_id !== "") {
      supersedesId = Number(a.supersedes_id);
      if (!Number.isInteger(supersedesId)) throw new Error("supersedes_id は行 ID");
      const { rows: prev } = await p.query(`SELECT * FROM genba_log WHERE id=$1`, [supersedesId]);
      if (!prev.length || prev[0].voided_at) throw new Error(`行 ${supersedesId} が無い (か取り消し済み)`);
      if (prev[0].site_id != null && useSiteId != null && Number(prev[0].site_id) !== Number(useSiteId)) throw new Error(`行 ${supersedesId} は別の現場のログ`);
      if (useSiteId == null && prev[0].site_id != null) useSiteId = Number(prev[0].site_id);
      const { rows: already } = await p.query(`SELECT id FROM genba_log WHERE supersedes_id=$1 AND voided_at IS NULL`, [supersedesId]);
      if (already.length) throw new Error(`行 ${supersedesId} は既に #${already[0].id} で置き換え済み。そちらを supersedes_id にする`);
      superseded = prev[0];
    } else if (a.kind === "決定" && topic) {
      const { rows: live } = await p.query(
        `SELECT l.* FROM genba_log l WHERE l.kind=$1 AND l.topic IS NOT NULL AND ${LIVE} AND l.site_id IS NOT DISTINCT FROM $2 AND ${NOT_SUPERSEDED}
          ORDER BY l.created_at DESC`, ["決定", useSiteId]);
      const hit = live.find((r) => norm(r.topic) === norm(topic));
      if (hit) { supersedesId = Number(hit.id); superseded = hit; }
    }
    const { rows } = await p.query(
      `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, resolves_id, photo_ids, source_ref, source, estimate_min, who, topic, supersedes_id, title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [useSiteId, a.kind, body, by, due, resolvesId, photos ? JSON.stringify(photos) : null, sourceRef, source ? JSON.stringify(source) : null, est, who, topic, supersedesId, title]
    );
    if (rows.length) {
      return {
        site: siteOut, log: logRow(rows[0]), duplicate: false,
        superseded: superseded ? { id: Number(superseded.id), body: superseded.body, at: superseded.created_at } : undefined,
        say: superseded ? `${topic || superseded.topic || "決定"}: 「${superseded.body}」→「${body}」に変更` : undefined,
      };
    }
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
  // ───────── 会社 ─────────
  const companyRow = (r, notes) => ({
    id: Number(r.id), name: r.name, aliases: Array.isArray(r.aliases) ? r.aliases : [], role: r.role || null,
    trades: Array.isArray(r.trades) ? r.trades : [],
    phone: r.phone || null, email: r.email || null, address: r.address || null, memo: r.notes || null,
    notes: notes || [],
    updated_by: r.updated_by, updated_at: r.updated_at,
  });
  const loadCompanies = async (p) => (await p.query(`SELECT * FROM genba_companies ORDER BY name`)).rows;
  async function companiesOut(p, rows, { contacts = false } = {}) {
    const ids = rows.map((r) => Number(r.id));
    const notesMap = await notesFor(p, "company", ids);
    const out = rows.map((r) => companyRow(r, notesMap.get(Number(r.id))));
    if (contacts && ids.length) {
      const { rows: cs } = await p.query(`SELECT id, name, role, trade, tone, company_id FROM genba_contacts WHERE company_id = ANY($1::bigint[]) ORDER BY name`, [ids]);
      for (const o of out) o.contacts = cs.filter((c) => Number(c.company_id) === o.id).map((c) => ({ id: Number(c.id), name: c.name, role: c.role || null, trade: c.trade || null, tone: c.tone || null }));
    }
    return out;
  }
  // 会社名の文字列 → 会社の行 (無ければ作る)。連絡先の company から呼ぶ
  async function ensureCompany(p, name, by) {
    const key = normCompany(name);
    if (!key) return null;
    const { rows } = await p.query(`SELECT * FROM genba_companies WHERE name_key=$1`, [key]);
    if (rows.length) return rows[0];
    const ins = await p.query(
      `INSERT INTO genba_companies (name, name_key, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (name_key) DO UPDATE SET updated_at = genba_companies.updated_at RETURNING *`, [String(name).trim(), key, by]);
    return ins.rows[0];
  }

  // ───────── メモ (流れない情報) ─────────
  const NOTE_KINDS = ["性質", "予定", "評価", "ルール", "メモ"];
  const SUBJECT_TYPES = { "人": "contact", "contact": "contact", "連絡先": "contact", "会社": "company", "company": "company", "現場": "site", "site": "site", "社内": "general", "general": "general", "全般": "general", "会社全般": "general" };
  const SUBJECT_LABEL = { contact: "人", company: "会社", site: "現場", general: "社内" };
  const subjectTypeOf = (v) => {
    const t = SUBJECT_TYPES[String(v || "").trim().toLowerCase()] || SUBJECT_TYPES[String(v || "").trim()];
    if (!t) throw new Error("subject_type は 人 / 会社 / 現場 / 社内 のどれか");
    return t;
  };
  const noteRow = (r, subject) => ({
    id: Number(r.id), subject_type: SUBJECT_LABEL[r.subject_type] || r.subject_type,
    subject: subject !== undefined ? subject : (r.subject_id != null ? { id: Number(r.subject_id) } : null),
    kind: r.kind, title: r.title || undefined, body: r.body,
    valid_from: ymd(r.valid_from) || undefined, valid_until: ymd(r.valid_until) || undefined,
    by: r.written_by, source_ref: r.source_ref || undefined, source: r.source || undefined,
    at: r.created_at, retired_at: r.retired_at || undefined,
  });
  // 対象 (複数可) の有効なメモ。on 日時点で期限内・未引退のものだけ。Map(subject_id → notes[])
  async function notesFor(p, type, ids, { on = todayJst(), includeExpired = false } = {}) {
    const map = new Map();
    const list = (ids || []).map(Number).filter(Number.isInteger);
    if (!list.length) return map;
    const { rows } = await p.query(
      `SELECT * FROM genba_notes WHERE subject_type=$1 AND subject_id = ANY($2::bigint[]) AND retired_at IS NULL
         ${includeExpired ? "" : "AND (valid_from IS NULL OR valid_from <= $3::date) AND (valid_until IS NULL OR valid_until >= $3::date)"}
        ORDER BY created_at`, includeExpired ? [type, list] : [type, list, on]);
    for (const r of rows) {
      const k = Number(r.subject_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(noteRow(r, undefined));
    }
    return map;
  }
  // 社内 (対象なし) のメモ
  async function generalNotes(p, { on = todayJst(), includeExpired = false } = {}) {
    const { rows } = await p.query(
      `SELECT * FROM genba_notes WHERE subject_type='general' AND retired_at IS NULL
         ${includeExpired ? "" : "AND (valid_from IS NULL OR valid_from <= $1::date) AND (valid_until IS NULL OR valid_until >= $1::date)"}
        ORDER BY created_at`, includeExpired ? [] : [on]);
    return rows.map((r) => noteRow(r, null));
  }
  // subject_type + subject (名前・呼び名・ID) → { type, id, label }
  async function resolveSubject(p, typeIn, ref) {
    const type = subjectTypeOf(typeIn);
    if (type === "general") return { type, id: null, label: "社内" };
    if (ref == null || String(ref).trim() === "") throw new Error(`subject (${SUBJECT_LABEL[type]}の名前か ID) が必要`);
    if (type === "contact") { const c = await resolveContact(p, ref); return { type, id: Number(c.id), label: `${c.name}${c.company ? ` (${c.company})` : ""}` }; }
    if (type === "company") { const k = await resolveCompany(p, ref); return { type, id: Number(k.id), label: k.name }; }
    const s = await resolveSite(p, ref); return { type, id: Number(s.id), label: s.name };
  }

  const contactRow = (r, siteMap, notesMap, companyMap) => ({
    id: Number(r.id), name: r.name, company: r.company || null,
    company_detail: r.company_id && companyMap ? companyMap.get(Number(r.company_id)) || undefined : undefined,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    role: r.role || null, trade: r.trade || null,
    channels: Array.isArray(r.channels) ? r.channels : [],
    tone: r.tone || null,
    sites: (Array.isArray(r.site_ids) ? r.site_ids : []).map((id) => (siteMap && siteMap.get(Number(id))) || { id: Number(id) }),
    phone: r.phone || null, email: r.email || null, memo: r.notes || null,
    notes: (notesMap && notesMap.get(Number(r.id))) || [],
    updated_by: r.updated_by, updated_at: r.updated_at,
  });
  // site_ids → { id, code, name }、会社 (性質・メモ込み)、本人のメモ、recent なら最近のやりとり (genba_log の source.contact_id) も付けて返す
  async function contactsOut(p, rows, { recent = false } = {}) {
    const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.site_ids) ? r.site_ids : [])).map(Number).filter(Number.isInteger))];
    const siteMap = new Map();
    if (ids.length) {
      const { rows: ss } = await p.query(`SELECT id, site_code, name FROM sites WHERE id = ANY($1::bigint[])`, [ids]);
      for (const s of ss) siteMap.set(Number(s.id), { id: Number(s.id), code: s.site_code || null, name: s.name });
    }
    const notesMap = await notesFor(p, "contact", rows.map((r) => r.id));
    const companyIds = [...new Set(rows.map((r) => r.company_id).filter((x) => x != null).map(Number))];
    const companyMap = new Map();
    if (companyIds.length) {
      const { rows: ks } = await p.query(`SELECT * FROM genba_companies WHERE id = ANY($1::bigint[])`, [companyIds]);
      const kn = await notesFor(p, "company", companyIds);
      for (const k of ks) {
        const { contacts: _c, ...row } = companyRow(k, kn.get(Number(k.id)));
        companyMap.set(Number(k.id), row);
      }
    }
    const out = rows.map((r) => contactRow(r, siteMap, notesMap, companyMap));
    if (recent) {
      for (const o of out) {
        const { rows: lg } = await p.query(
          `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
            WHERE l.source->>'contact_id' = $1 AND l.voided_at IS NULL ORDER BY l.created_at DESC LIMIT 5`, [String(o.id)]);
        o.recent_log = lg.map(logRow);
      }
    }
    return out;
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
    return keyScore(keys, qn);
  }
  function keyScore(keys, qn) {
    let best = 0;
    for (const k of keys) {
      if (k === qn) return 4;
      if (k.startsWith(qn)) best = Math.max(best, 3);
      else if (qn.startsWith(k) && k.length >= 2) best = Math.max(best, 2);
      else if (qn.length >= 2 && k.length >= 2 && (k.includes(qn) || qn.includes(k))) best = Math.max(best, 1);
    }
    return best;
  }
  // 点数順に並べ、弱い一致だけ落とす (完全一致があっても前方一致は残す = 自動で決めないため)
  function rankBy(rows, scoreFn, nameOf) {
    const scored = rows.map((r) => ({ r, s: scoreFn(r) })).filter((x) => x.s > 0);
    if (!scored.length) return [];
    const max = Math.max(...scored.map((x) => x.s));
    const floor = max >= 3 ? max - 1 : 1;
    return scored.filter((x) => x.s >= floor).sort((a, b) => b.s - a.s || String(nameOf(a.r)).localeCompare(String(nameOf(b.r)), "ja")).map((x) => x.r);
  }
  function companyScore(r, rawQ) {
    const qn = normCompany(rawQ);
    if (!qn) return 0;
    return keyScore([r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])].filter(Boolean).map(normCompany).filter(Boolean), qn);
  }
  const rankCompanies = (rows, q) => rankBy(rows, (r) => companyScore(r, q), (r) => r.name);
  async function resolveCompany(p, ref) {
    const q = String(ref ?? "").trim();
    if (!q) throw new Error("company (会社名・ID) が必要");
    if (/^\d+$/.test(q)) {
      const { rows } = await p.query(`SELECT * FROM genba_companies WHERE id=$1`, [Number(q)]);
      if (!rows.length) throw new Error(`会社 ID ${q} が無い`);
      return rows[0];
    }
    const hits = rankCompanies(await loadCompanies(p), q);
    if (!hits.length) throw new Error(`会社が見つからない: ${q}。genba_company_find で探すか genba_company_upsert で登録する`);
    if (hits.length > 1) throw new Error(`候補が複数: ${hits.map((r) => `#${r.id} ${r.name}`).join(" / ")}。ID で指定する (推測で決めない)`);
    return hits[0];
  }
  // 候補を点数順に。完全一致があっても「菊池 → 菊池輝」のような前方一致は残す (自動で決めないため)。弱い一致だけ落とす
  const rankContacts = (rows, q) => rankBy(rows, (r) => contactScore(r, q), (r) => r.name);
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
    const state = rows.map((c) => ({ c, chans: Array.isArray(c.channels) ? c.channels.map((x) => ({ ...x })) : [], changed: false }));
    // 1) 連絡先に室名だけ / ID だけ入っているものを埋める
    for (const s of state) {
      for (const ch of s.chans) {
        if (!ch.room_id && ch.room_name) {
          const hits = named.filter((r) => normName(r.name) === normName(ch.room_name));
          if (hits.length === 1) { ch.room_id = hits[0].room; s.changed = true; }
        } else if (ch.room_id && !ch.room_name) {
          const hit = named.find((r) => r.room === ch.room_id);
          if (hit) { ch.room_name = hit.name; s.changed = true; }
        }
      }
    }
    // 2) どの連絡先にも結ばれていないルームで、名前が 1 人の連絡先の名前・呼び名と一致するものは、その人の個人ルームとして足す
    for (const r of named) {
      if (state.some((s) => s.chans.some((ch) => ch.room_id === r.room))) continue;
      const key = normName(r.name);
      if (!key) continue;
      const hits = state.filter((s) => s.c.name_key === key || (Array.isArray(s.c.aliases) ? s.c.aliases : []).some((al) => normName(al) === key));
      if (hits.length !== 1) continue;
      hits[0].chans.push({ channel: r.channel || "LINE", room_id: r.room, room_name: r.name, kind: "single" });
      hits[0].changed = true;
    }
    let n = 0;
    for (const s of state) {
      if (!s.changed) continue;
      await p.query(`UPDATE genba_contacts SET channels=$2, updated_at=now() WHERE id=$1`, [s.c.id, JSON.stringify(s.chans)]);
      n++;
    }
    return n;
  }
  // 社内の人 (role=社内) の個人ルームは、同期で初めて見えたときに自動で「応答」ON にする (名取から LINE が来たら AI が返す)。
  // 一度でも人が触った行 (OFF にした・現場を付けた・ラベルを付けた・用途を変えた) には触らない
  async function autoEnableInternalRooms(p, owner, rooms) {
    if (!rooms.length) return [];
    const internal = (await loadContacts(p)).filter((c) => c.role === "社内");
    if (!internal.length) return [];
    const out = [];
    for (const r of rooms) {
      const hit = internal.filter((c) => (Array.isArray(c.channels) ? c.channels : []).some((ch) => ch.room_id === r.room && ch.kind !== "group"));
      if (hit.length !== 1) continue;
      const { rows } = await p.query(
        `UPDATE genba_sources SET purpose='応答', enabled=true, label=$4, updated_at=now()
          WHERE owner=$1 AND channel=$2 AND room=$3 AND enabled=false AND purpose='記録' AND site_id IS NULL AND label IS NULL AND cursor IS NULL
          RETURNING id`, [owner, r.channel, r.room, `社内: ${hit[0].name} (自動で応答 ON)`]);
      if (rows.length) { out.push({ channel: r.channel, room: r.room, name: r.name, contact: hit[0].name, enabled: true }); continue; }
      // 既に人が触った行 (or 想定外の状態)。何が違うかを返しておく
      const { rows: cur } = await p.query(`SELECT enabled, purpose, site_id, label, cursor FROM genba_sources WHERE owner=$1 AND channel=$2 AND room=$3`, [owner, r.channel, r.room]);
      out.push({ channel: r.channel, room: r.room, name: r.name, contact: hit[0].name, enabled: false, state: cur[0] ? { enabled: cur[0].enabled, purpose: cur[0].purpose, site_id: cur[0].site_id, label: cur[0].label, cursor: cur[0].cursor } : "row not found" });
    }
    return out;
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

  // ───────── ファイル (GCS) ─────────
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", txt: "text/plain" };
  const guessType = (name) => MIME[String(name).toLowerCase().split(".").pop()] || "application/octet-stream";
  const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const sign = (s) => crypto.createHmac("sha256", gcs?.secret || "").update(s).digest("hex").slice(0, 32);
  // アップロード用の一時トークン: 中身 (現場・ファイル名・source_ref・書いた人・期限) + HMAC。URL に秘密を載せずに PUT を受けられる
  function uploadToken(payload) {
    if (!gcs?.secret) throw new Error("アップロードの秘密鍵 (INTERNAL_TICK_SECRET) が無い");
    const body = b64u(JSON.stringify(payload));
    return `${body}.${sign(body)}`;
  }
  function readUploadToken(token) {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig || !gcs?.secret || sign(body) !== sig) return null;
    try { const p = JSON.parse(unb64u(body)); return p && p.e > Date.now() ? p : null; } catch { return null; }
  }
  async function signRead(gsUrl, days = 7) {
    const storage = gcs?.getStorage?.();
    if (!storage) return null;
    const [, , bucket, ...rest] = gsUrl.split("/");
    const [url] = await storage.bucket(bucket).file(rest.join("/")).getSignedUrl({ version: "v2", action: "read", expires: Date.now() + days * 86400000 });
    return url;
  }
  async function fileRow(r) {
    let url = null;
    try { url = await signRead(r.gcs_url); } catch (e) { console.warn("[genba] sign", e.message); }
    return {
      id: Number(r.id), kind: r.kind, filename: r.filename, content_type: r.content_type, bytes: r.bytes != null ? Number(r.bytes) : undefined,
      url, gs: r.gcs_url, site: r.site_name !== undefined ? (r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null) : undefined,
      source_ref: r.source_ref || undefined, source: r.source || undefined, by: r.uploaded_by, at: r.created_at,
    };
  }
  // PUT /api/genba/upload/:token (認証ミドルウェアの前に express.raw と一緒にマウント)。中身を GCS に置いて台帳に 1 行
  function uploadRoute() {
    return async (req, res) => {
      try {
        const t = readUploadToken(req.params.token);
        if (!t) return res.status(403).json({ error: "token が無効か期限切れ。genba_file_upload_url で作り直す" });
        const buf = Buffer.isBuffer(req.body) ? req.body : null;
        if (!buf || !buf.length) return res.status(400).json({ error: "本文が空。--data-binary @file で送る" });
        const storage = gcs.getStorage();
        if (!storage || !gcs.bucket) return res.status(503).json({ error: "GCS not configured" });
        const p = getPool();
        await ensureSchema();
        if (t.r) {
          const { rows: ex } = await p.query(`SELECT * FROM genba_files WHERE source_ref=$1`, [t.r]);
          if (ex.length) return res.json({ duplicate: true, ...(await fileRow(ex[0])) });
        }
        const d = new Date(), ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const key = `genba/${t.s ?? "company"}/${ym}/${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${t.f}`;
        const contentType = req.headers["content-type"] && !/^application\/(octet-stream|x-www-form-urlencoded)/.test(req.headers["content-type"]) ? String(req.headers["content-type"]).split(";")[0] : t.c;
        await storage.bucket(gcs.bucket).file(key).save(buf, { contentType, resumable: false });
        const gsUrl = `gs://${gcs.bucket}/${key}`;
        const { rows } = await p.query(
          `INSERT INTO genba_files (site_id, kind, gcs_url, filename, content_type, bytes, source_ref, source, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING *`,
          [t.s, t.k, gsUrl, t.f, contentType, buf.length, t.r, t.o ? JSON.stringify(t.o) : null, t.b]);
        if (!rows.length) {
          const { rows: ex } = await p.query(`SELECT * FROM genba_files WHERE source_ref=$1`, [t.r]);
          return res.json({ duplicate: true, ...(await fileRow(ex[0])) });
        }
        res.json({ duplicate: false, ...(await fileRow(rows[0])) });
      } catch (e) {
        console.error("[genba] upload", e);
        res.status(500).json({ error: e.message });
      }
    };
  }

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
          const out = await contactsOut(p, hits, { recent: hits.length === 1 });
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
            phone: { type: "string" }, email: { type: "string" }, memo: { type: "string", description: "本人についての自由メモ (1 行)。性質・予定など流れない情報は genba_note_add の方へ" },
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
          if (a.memo != null && a.notes == null) a.notes = a.memo;
          const pick = (k) => (a[k] != null && a[k] !== "" ? String(a[k]).trim() : cur?.[k] ?? null);
          // 既存に当たったら名前・会社の表記は最初に登録したものを残す (「菊池さん」「大丁工業」で呼んでも正式表記は変えない)
          const companyName = cur?.company || company || null;
          const companyId = cur?.company_id ?? (companyName ? (await ensureCompany(p, companyName, by))?.id ?? null : null);
          const vals = [cur ? cur.name : name, nameKey, companyName, cur?.company_key || (company ? companyKey : ""),
            JSON.stringify(aliases), role, pick("trade"), JSON.stringify(channels), pick("tone"), JSON.stringify(siteIds),
            pick("phone"), pick("email"), pick("notes"), by, companyId];
          const { rows } = cur
            ? await p.query(
              `UPDATE genba_contacts SET name=$2, name_key=$3, company=$4, company_key=$5, aliases=$6, role=$7, trade=$8, channels=$9, tone=$10,
                      site_ids=$11, phone=$12, email=$13, notes=$14, updated_by=$15, company_id=$16, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...vals])
            : await p.query(
              `INSERT INTO genba_contacts (name, name_key, company, company_key, aliases, role, trade, channels, tone, site_ids, phone, email, notes, updated_by, company_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, vals);
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
        name: "genba_company_find",
        description: "会社を探す (名前・別名。株式会社/㈱ の有無や全角半角は吸収)。返り値に会社のメモ (価格感・得意工事・評価など) と所属の連絡先が付く。1 件なら match、複数なら candidates だけ",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const hits = rankCompanies(await loadCompanies(p), a.query);
          const out = await companiesOut(p, hits, { contacts: true });
          return { query: a.query, match: out.length === 1 ? out[0] : null, candidates: out, note: !out.length ? "見つからない。新しい会社なら genba_company_upsert" : out.length === 1 ? undefined : "候補が複数。人に聞く" };
        },
      },
      {
        name: "genba_company_upsert",
        description: "会社を登録・更新する (name で同一判定。株式会社/㈱ の有無は同じ会社)。aliases / trades は足すだけ、他は渡したものだけ上書き。「この会社は高い」「〇〇が得意」のような評価・性質は genba_note_add(会社, …) の方に入れる",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            role: { type: "string", enum: CONTACT_ROLES, description: "業者 / 元請け / 設計 / 客先 / 社内" },
            trades: { type: "array", items: { type: "string" }, description: "得意工事・職種 (防水, 解体, 大工…)" },
            phone: { type: "string" }, email: { type: "string" }, address: { type: "string" },
            memo: { type: "string", description: "自由メモ (1 行)" },
          },
          required: ["name"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const name = String(a.name || "").trim();
          const key = normCompany(name);
          if (!key) throw new Error("name が必要");
          const { rows: same } = await p.query(`SELECT * FROM genba_companies WHERE name_key=$1`, [key]);
          const cur = same[0] || null;
          const aliases = uniqBy([...(cur && Array.isArray(cur.aliases) ? cur.aliases : []), ...toList(a.aliases)], normCompany);
          const trades = uniqBy([...(cur && Array.isArray(cur.trades) ? cur.trades : []), ...toList(a.trades ?? a.trade)], norm);
          const pick = (k) => (a[k] != null && a[k] !== "" ? String(a[k]).trim() : cur?.[k] ?? null);
          const warnings = [];
          const role = a.role ? String(a.role).trim() : cur?.role || null;
          if (a.role && !CONTACT_ROLES.includes(role)) warnings.push(`role は ${CONTACT_ROLES.join(" / ")} のどれかが望ましい (指定: ${role})`);
          const vals = [cur ? cur.name : name, key, JSON.stringify(aliases), role, JSON.stringify(trades), pick("phone"), pick("email"), pick("address"), a.memo != null && a.memo !== "" ? String(a.memo).trim() : cur?.notes ?? null, by];
          const { rows } = cur
            ? await p.query(`UPDATE genba_companies SET name=$2, name_key=$3, aliases=$4, role=$5, trades=$6, phone=$7, email=$8, address=$9, notes=$10, updated_by=$11, updated_at=now() WHERE id=$1 RETURNING *`, [cur.id, ...vals])
            : await p.query(`INSERT INTO genba_companies (name, name_key, aliases, role, trades, phone, email, address, notes, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, vals);
          // 同じ会社名の連絡先がまだ結ばれていなければ結ぶ
          await p.query(`UPDATE genba_contacts SET company_id=$1 WHERE company_id IS NULL AND company_key=$2`, [rows[0].id, key]);
          const [out] = await companiesOut(p, rows, { contacts: true });
          return { ...out, created: !cur, warnings: warnings.length ? warnings : undefined };
        },
      },
      {
        name: "genba_company_list",
        description: "会社の一覧。role (業者 / 元請け / 設計 / 客先) や trade (職種・得意工事) で絞る。「防水やれる会社どこ？」用",
        inputSchema: { type: "object", properties: { role: { type: "string" }, trade: { type: "string" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          let rows = await loadCompanies(p);
          if (a.role) rows = rows.filter((r) => norm(r.role) === norm(a.role));
          if (a.trade) rows = rows.filter((r) => (Array.isArray(r.trades) ? r.trades : []).some((t) => norm(t).includes(norm(a.trade)) || norm(a.trade).includes(norm(t))));
          return { count: rows.length, companies: await companiesOut(p, rows, { contacts: true }) };
        },
      },
      {
        name: "genba_company_remove",
        description: "会社を 1 件消す (小西のトークンからだけ)。所属の連絡先は残る (会社の紐付けだけ外れる)",
        inputSchema: { type: "object", properties: { company: { type: "string" } }, required: ["company"] },
        handler: async (a) => {
          await ensureSchema();
          if (by !== "小西") throw new Error("この操作は小西のトークンからだけ");
          const p = getPool();
          const cur = await resolveCompany(p, a.company);
          await p.query(`DELETE FROM genba_companies WHERE id=$1`, [cur.id]);
          return { removed: { id: Number(cur.id), name: cur.name } };
        },
      },
      {
        name: "genba_note_add",
        description: "流れない情報を対象にぶら下げる: 人・会社・現場・社内 の 性質 / 予定 / 評価 / ルール。例「久保木は来月から別現場で忙しい」→ 人, 予定, valid_from=来月 1 日。「大丁工業は金額高め」→ 会社, 評価。「この現場は搬入が 8 時から」→ 現場, 性質。「請求は月末締め」→ 社内, ルール。出来事 (〇日に決まった・やった) は genba_log_add の方。期限は valid_from / valid_until (YYYY-MM-DD)。find / status の返り値に notes として付いてくる",
        inputSchema: {
          type: "object",
          properties: {
            subject_type: { type: "string", enum: ["人", "会社", "現場", "社内"] },
            subject: { type: "string", description: "対象の名前・呼び名・ID (社内のときは省略)" },
            kind: { type: "string", enum: NOTE_KINDS, description: "既定 メモ" },
            title: { type: "string", description: "一覧用の短いタイトル (40 字まで、任意)" },
            body: { type: "string", description: "1 行で。主語を入れる (誰が / どの会社が)" },
            valid_from: { type: "string", description: "この日から有効 (YYYY-MM-DD)" },
            valid_until: { type: "string", description: "この日まで有効 (YYYY-MM-DD)" },
            source_ref: { type: "string", description: "監視ジョブ: <channel>:<room>:<message id> (同じメッセージは 2 回入らない)" },
            source: { type: "object", description: "{ channel, room, sender, at, quote }" },
          },
          required: ["subject_type", "body"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const subj = await resolveSubject(p, a.subject_type, a.subject);
          const kind = a.kind ? String(a.kind).trim() : "メモ";
          if (!NOTE_KINDS.includes(kind)) throw new Error(`kind は ${NOTE_KINDS.join(" / ")}`);
          const body = String(a.body || "").trim();
          if (!body) throw new Error("body が空");
          const d = (v, k) => { if (v == null || v === "") return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${k} は YYYY-MM-DD`); return String(v); };
          const from = d(a.valid_from, "valid_from"), until = d(a.valid_until, "valid_until");
          if (from && until && from > until) throw new Error("valid_from が valid_until より後");
          const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
          const source = a.source && typeof a.source === "object" ? a.source : null;
          const { rows } = await p.query(
            `INSERT INTO genba_notes (subject_type, subject_id, kind, body, valid_from, valid_until, written_by, source_ref, source, title)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING *`,
            [subj.type, subj.id, kind, body, from, until, by, sourceRef, source ? JSON.stringify(source) : null, cleanTitle(a.title)]);
          if (!rows.length) {
            const { rows: ex } = await p.query(`SELECT * FROM genba_notes WHERE source_ref=$1`, [sourceRef]);
            return { duplicate: true, note: ex[0] ? noteRow(ex[0], { id: subj.id, label: subj.label }) : null };
          }
          return { duplicate: false, note: noteRow(rows[0], subj.id != null ? { id: subj.id, label: subj.label } : null) };
        },
      },
      {
        name: "genba_note_list",
        description: "メモの一覧。subject_type + subject で対象を絞る (社内 は subject 不要)。subject_type だけなら その種類の全部 (例: 人 の 予定 を全部 → 「来月手が空いてる職人」を探す)。on で日付時点の有効分 (既定 今日)。include_expired で期限切れも",
        inputSchema: {
          type: "object",
          properties: {
            subject_type: { type: "string", enum: ["人", "会社", "現場", "社内"] },
            subject: { type: "string" },
            kind: { type: "string", enum: NOTE_KINDS },
            on: { type: "string", description: "YYYY-MM-DD (既定 今日)" },
            include_expired: { type: "boolean" },
            limit: { type: "number", description: "既定 100" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const on = a.on && /^\d{4}-\d{2}-\d{2}$/.test(a.on) ? a.on : todayJst();
          const where = ["retired_at IS NULL"], vals = [];
          let subj = null;
          if (a.subject_type) {
            if (a.subject || subjectTypeOf(a.subject_type) === "general") {
              subj = await resolveSubject(p, a.subject_type, a.subject);
              vals.push(subj.type); where.push(`subject_type=$${vals.length}`);
              if (subj.id != null) { vals.push(subj.id); where.push(`subject_id=$${vals.length}`); }
            } else { vals.push(subjectTypeOf(a.subject_type)); where.push(`subject_type=$${vals.length}`); }
          }
          if (a.kind) { vals.push(String(a.kind)); where.push(`kind=$${vals.length}`); }
          if (!a.include_expired) { vals.push(on); where.push(`(valid_from IS NULL OR valid_from <= $${vals.length}::date) AND (valid_until IS NULL OR valid_until >= $${vals.length}::date)`); }
          const limit = Math.min(500, Math.max(1, Number(a.limit) || 100));
          const { rows } = await p.query(`SELECT * FROM genba_notes WHERE ${where.join(" AND ")} ORDER BY subject_type, subject_id, created_at LIMIT ${limit}`, vals);
          // 対象の名前を付ける
          const byType = { contact: new Map(), company: new Map(), site: new Map() };
          for (const t of Object.keys(byType)) {
            const ids = [...new Set(rows.filter((r) => r.subject_type === t && r.subject_id != null).map((r) => Number(r.subject_id)))];
            if (!ids.length) continue;
            const table = t === "contact" ? "genba_contacts" : t === "company" ? "genba_companies" : "sites";
            const { rows: ns } = await p.query(`SELECT id, name FROM ${table} WHERE id = ANY($1::bigint[])`, [ids]);
            for (const n of ns) byType[t].set(Number(n.id), { id: Number(n.id), label: n.name });
          }
          return { on, count: rows.length, notes: rows.map((r) => noteRow(r, r.subject_type === "general" ? null : byType[r.subject_type]?.get(Number(r.subject_id)) || { id: Number(r.subject_id) })) };
        },
      },
      {
        name: "genba_note_retire",
        description: "メモを引退させる (消さない)。もう当てはまらなくなった・間違っていたとき。「久保木もう戻ってきた」→ 該当の 予定 を retire",
        inputSchema: { type: "object", properties: { id: { type: "number" }, reason: { type: "string" } }, required: ["id"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const id = Number(a.id);
          if (!Number.isInteger(id)) throw new Error("id が必要");
          const { rows } = await p.query(`UPDATE genba_notes SET retired_at=now(), retired_by=$2, retired_reason=$3 WHERE id=$1 AND retired_at IS NULL RETURNING *`, [id, by, a.reason ? String(a.reason).trim() : null]);
          if (!rows.length) throw new Error(`メモ ${id} が無い (か既に引退)`);
          return { retired: noteRow(rows[0], undefined) };
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
        description: "進捗ログに 1 行足す (追記のみ。直すのは genba_log_fix、消すのは genba_log_void)。title (一覧用、20 字前後) と body (詳細) を分けて書く。種類: 進捗 (やったこと・完了したこと) / 課題 / 決定 / 次やること (タスク) / 解決。決定には topic (床材 / 巾木 / 納期 …) を付ける。決定が変わったら同じ topic で新しい決定を足せば前の決定を置き換える (返り値 superseded)。人の報告は種類ごとに分けて複数回呼ぶ (例「ボード貼り完了、明日パテ。床レベル 3mm 狂い要相談」→ 進捗 + 次やること(due_on 明日) + 課題)。現場に紐づかない項目 (会社の雑務・Google マップのピン等) は site を省略する。やった人・担当は who、タスクは所要時間の目安を estimate_min (分) に入れる (「5 分で終わるタスクある？」は genba_tasks で引く)。課題や次やることが片付いたら kind=解決 で resolves_id に元の行 ID (site 省略可)。LINE 等のメッセージから記録するときは source_ref (メッセージ ID) を必ず付ける (同じものは 2 回入らない、duplicate: true が返る) と source に出どころ。書いた人はトークンから自動で入る",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID。省略 (または「会社」) = 現場に紐づかない項目" },
            who: { type: "string", description: "やった人 / 担当 (例: 名取)。省略可" },
            estimate_min: { type: "number", description: "所要時間の目安 (分)。タスク (次やること・課題) に付ける" },
            kind: { type: "string", enum: LOG_KINDS },
            title: { type: "string", description: "一覧用の短いタイトル (20 字前後、40 字まで)。「何を・どうする」(例: 工程表を辰巳さんへ送る / 巾木の色をみゆまに確認)。決定は結論を書く (例: 巾木は東リ97番か43番)。新しく記録するときは必ず付ける" },
            body: { type: "string", description: "詳細 (経緯・数量・型番・金額・出どころ)。1 行 1 件。決定は型番・数量・金額を省略しない" },
            due_on: { type: "string", description: "期限 YYYY-MM-DD (次やること・課題)" },
            resolves_id: { type: "number", description: "kind=解決 のとき、解決した元の行 ID" },
            topic: { type: "string", description: "決定が何についてか (床材 / 巾木 / 納期 / 色 …)。同じ現場に同じ topic の生きている決定があれば自動でそれを置き換える (変更として紐付く)" },
            supersedes_id: { type: "number", description: "この行が置き換える前の行 ID (決定の変更・タスクの言い換え)。topic で自動紐付けできないときに" },
            photo_ids: { type: "array", items: { type: "string" }, description: "関連する写真・ファイルの ID (genba_file_list の id、または Drive の file_id)" },
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
        description: "進捗ログを複数行まとめて足す (監視ジョブや、会話を貼られて一度に抽出したとき用)。items の各要素は genba_log_add と同じ引数 (title / kind / body / … 。site を省略したら共通の site)。1 件ずつ入るので途中で失敗しても前の行は残る。結果に各行の duplicate が付く",
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
        name: "genba_log_fix",
        description: "ログの行を直す (誤字・現場違い・期限・担当・所要時間・topic・title)。直す前の値は edits に残る (誰がいつ)。kind は変えられない (変えたいなら genba_log_void して入れ直す)",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            body: { type: "string" }, site: { type: "string", description: "案件 ID・現場名・ID。「会社」で現場なしに" },
            due_on: { type: "string", description: "YYYY-MM-DD。空文字で消す" }, who: { type: "string" }, estimate_min: { type: "number" }, topic: { type: "string" },
            title: { type: "string", description: "一覧用タイトル (40 字まで)。空文字で消す" },
          },
          required: ["id"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const id = Number(a.id);
          const { rows: cur } = await p.query(`SELECT * FROM genba_log WHERE id=$1`, [id]);
          if (!cur.length) throw new Error(`行 ${id} が無い`);
          if (cur[0].voided_at) throw new Error(`行 ${id} は取り消し済み`);
          const r = cur[0];
          const sets = [], vals = [id], before = {};
          const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); before[col] = r[col] instanceof Date ? ymd(r[col]) : r[col] ?? null; };
          if (a.body != null && String(a.body).trim()) set("body", String(a.body).trim());
          if (a.site !== undefined) { const s = await resolveSiteOrNull(p, a.site); set("site_id", s ? s.id : null); }
          if (a.due_on !== undefined) { if (a.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(a.due_on)) throw new Error("due_on は YYYY-MM-DD"); set("due_on", a.due_on || null); }
          if (a.who !== undefined) set("who", a.who ? String(a.who).trim().slice(0, 60) : null);
          if (a.estimate_min !== undefined) set("estimate_min", a.estimate_min == null || a.estimate_min === "" ? null : Math.max(1, Math.round(Number(a.estimate_min))));
          if (a.topic !== undefined) set("topic", a.topic ? String(a.topic).trim().slice(0, 60) : null);
          if (a.title !== undefined) set("title", cleanTitle(a.title));
          if (!sets.length) throw new Error("直す項目が無い");
          const edits = [...(Array.isArray(r.edits) ? r.edits : []), { at: new Date().toISOString(), by, before }];
          vals.push(JSON.stringify(edits)); sets.push(`edits=$${vals.length}`);
          const { rows } = await p.query(`UPDATE genba_log SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, vals);
          return { log: logRow(rows[0]), before };
        },
      },
      {
        name: "genba_log_void",
        description: "ログの行を取り消す (消さずに隠す)。status / list / tasks から消える。解決の行を取り消すと元のタスクが未解決に戻り、変更の決定を取り消すと前の決定が生き返る。間違って入れたとき用",
        inputSchema: { type: "object", properties: { id: { type: "number" }, reason: { type: "string" } }, required: ["id"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const id = Number(a.id);
          const { rows } = await p.query(
            `UPDATE genba_log SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1 AND voided_at IS NULL RETURNING *`,
            [id, by, a.reason ? String(a.reason).trim() : null]);
          if (!rows.length) throw new Error(`行 ${id} が無い (か既に取り消し済み)`);
          const r = rows[0];
          const effects = [];
          if (r.kind === "解決" && r.resolves_id) effects.push(`#${r.resolves_id} が未解決に戻った`);
          if (r.supersedes_id) effects.push(`前の行 #${r.supersedes_id} が生き返った`);
          const { rows: nx } = await p.query(`SELECT id FROM genba_log WHERE supersedes_id=$1 AND voided_at IS NULL`, [id]);
          if (nx.length) effects.push(`この行を置き換えた #${nx[0].id} は残る`);
          const { rows: rs } = await p.query(`SELECT id FROM genba_log WHERE resolves_id=$1 AND voided_at IS NULL`, [id]);
          if (rs.length) effects.push(`この行を解決した #${rs[0].id} は残る (要らなければそれも void)`);
          return { voided: logRow(r), effects: effects.length ? effects : undefined };
        },
      },
      {
        name: "genba_log_title_set_many",
        description: "【移行用・あとで消す】既存のログ行に title だけを付ける。items: [{ id, title }] (最大 200 件)。body・kind・日付には触らない、新しい行も作らない。AI が本文を読んで付けたタイトルを流し込む用。返り値は更新できた件数と、無かった id",
        inputSchema: {
          type: "object",
          properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "number" }, title: { type: "string" } }, required: ["id", "title"] }, description: "最大 200 件" } },
          required: ["items"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const items = Array.isArray(a.items) ? a.items.slice(0, 200) : [];
          if (!items.length) throw new Error("items が空");
          let updated = 0;
          const missing = [], invalid = [];
          for (const it of items) {
            const id = Number(it?.id);
            if (!Number.isInteger(id)) { invalid.push({ id: it?.id, error: "id が数値でない" }); continue; }
            let title;
            try { title = cleanTitle(it.title); } catch (e) { invalid.push({ id, error: e.message }); continue; }
            const { rows } = await p.query(`UPDATE genba_log SET title=$2 WHERE id=$1 RETURNING id`, [id, title]);
            if (rows.length) updated++; else missing.push(id);
          }
          return { updated, missing, invalid: invalid.length ? invalid : undefined };
        },
      },
      ...(gcs ? [
        {
          name: "genba_file_upload_url",
          description: "画像・PDF を Keihi (GCS) に上げるための一時 URL を作る。LINE (Beeper) に来た写真を監視ジョブが保存するとき用。本文に base64 を貼らない: 返ってきた curl を PC 側で実行してファイルを PUT する。同じ source_ref は 2 回入らない (duplicate: true で既存の情報が返る)。上げたら genba_log_add(kind=進捗, body=「写真 n 枚: 内容」, photo_ids=[file id]) で現場に残す",
          inputSchema: {
            type: "object",
            properties: {
              site: { type: "string", description: "案件 ID・現場名・ID。省略 = 現場なし" },
              filename: { type: "string" },
              content_type: { type: "string", description: "image/jpeg など (省略で拡張子から)" },
              kind: { type: "string", enum: ["写真", "図面", "資料", "その他"], description: "既定 写真" },
              source_ref: { type: "string", description: "<channel>:<room>:<message id>:<n>。同じ添付を 2 回入れないための鍵" },
              source: { type: "object", description: "{ channel, room, sender, at, quote }" },
            },
            required: ["filename"],
          },
          handler: async (a) => {
            await ensureSchema();
            const p = getPool();
            const site = await resolveSiteOrNull(p, a.site);
            const filename = String(a.filename || "file").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
            const contentType = a.content_type ? String(a.content_type).trim() : guessType(filename);
            const kind = ["写真", "図面", "資料", "その他"].includes(a.kind) ? a.kind : "写真";
            const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
            if (sourceRef) {
              const { rows: ex } = await p.query(`SELECT * FROM genba_files WHERE source_ref=$1`, [sourceRef]);
              if (ex.length) return { duplicate: true, file: await fileRow(ex[0]) };
            }
            const exp = Date.now() + 2 * 3600 * 1000;
            const token = uploadToken({ s: site ? Number(site.id) : null, k: kind, f: filename, c: contentType, r: sourceRef, o: a.source && typeof a.source === "object" ? a.source : null, b: by, e: exp });
            const url = `${gcs.publicUrl}/api/genba/upload/${token}`;
            return {
              duplicate: false, site: site ? siteRow(site) : null, kind, filename, content_type: contentType, expires_at: new Date(exp).toISOString(),
              method: "PUT", upload_url: url,
              curl: `curl -sS -X PUT -H "Content-Type: ${contentType}" --data-binary @"${filename}" "${url}"`,
              note: "PC 側でこの curl を実行する (ファイルの中身を会話に貼らない)。返ってくる JSON の id を genba_log_add の photo_ids に入れる",
            };
          },
        },
        {
          name: "genba_file_list",
          description: "現場の写真・ファイル一覧 (新しい順)。URL は 7 日有効の署名付き。site 省略 = 現場なし、\"*\" = 全部",
          inputSchema: { type: "object", properties: { site: { type: "string" }, days: { type: "number", description: "既定 90" }, kind: { type: "string" }, limit: { type: "number", description: "既定 30、最大 200" } } },
          handler: async (a) => {
            await ensureSchema();
            const p = getPool();
            const all = a.site === "*" || a.site === "全部";
            const site = all ? null : await resolveSiteOrNull(p, a.site);
            const where = [`f.voided_at IS NULL`, `f.created_at > now() - ($1 || ' days')::interval`];
            const vals = [String(Math.max(1, Math.min(3650, Number(a.days) || 90)))];
            if (!all) { if (site) { vals.push(site.id); where.push(`f.site_id=$${vals.length}`); } else where.push(`f.site_id IS NULL`); }
            if (a.kind) { vals.push(String(a.kind)); where.push(`f.kind=$${vals.length}`); }
            vals.push(Math.max(1, Math.min(200, Number(a.limit) || 30)));
            const { rows } = await p.query(
              `SELECT f.*, s.name AS site_name, s.site_code FROM genba_files f LEFT JOIN sites s ON s.id = f.site_id
                WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC LIMIT $${vals.length}`, vals);
            const files = [];
            for (const r of rows) files.push(await fileRow(r));
            return { site: all ? "*" : (site ? siteRow(site) : null), count: files.length, files };
          },
        },
        {
          name: "genba_file_void",
          description: "ファイルを一覧から外す (GCS の中身は消さない)。間違って上げたとき用",
          inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
          handler: async (a) => {
            await ensureSchema();
            const p = getPool();
            const { rows } = await p.query(`UPDATE genba_files SET voided_at=now(), voided_by=$2 WHERE id=$1 AND voided_at IS NULL RETURNING id, filename`, [Number(a.id), by]);
            if (!rows.length) throw new Error(`ファイル ${a.id} が無い (か既に外してある)`);
            return { voided: { id: Number(rows[0].id), filename: rows[0].filename } };
          },
        },
      ] : []),
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
            topic: { type: "string", description: "決定の topic で絞る (例: 床材)" },
            chain: { type: "number", description: "この行 ID の変更の履歴 (置き換えの連鎖) を古い順に返す。他の絞り込みは無視" },
            include_voided: { type: "boolean", description: "取り消した行も出す (既定 false)" },
            limit: { type: "number", description: "既定 50、最大 200" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          if (a.chain != null) {
            // 連鎖: 指定行から前へ (supersedes_id) と後ろへ (superseded_by) 辿る
            const { rows: all } = await p.query(
              `WITH RECURSIVE back AS (
                 SELECT * FROM genba_log WHERE id=$1
                 UNION ALL SELECT g.* FROM genba_log g JOIN back b ON g.id = b.supersedes_id),
               fwd AS (
                 SELECT * FROM genba_log WHERE id=$1
                 UNION ALL SELECT g.* FROM genba_log g JOIN fwd f ON g.supersedes_id = f.id AND g.voided_at IS NULL)
               SELECT l.*, s.name AS site_name, s.site_code FROM (SELECT * FROM back UNION SELECT * FROM fwd) l LEFT JOIN sites s ON s.id = l.site_id
                ORDER BY l.created_at`, [Number(a.chain)]);
            if (!all.length) throw new Error(`行 ${a.chain} が無い`);
            const rows = await withSupersededBy(p, all);
            return { chain_of: Number(a.chain), logs: rows.map(logRow), current: rows.filter((r) => !r.voided_at && !r.superseded_by).map((r) => Number(r.id)) };
          }
          const all = a.site === "*" || a.site === "全部";
          const site = all ? null : await resolveSiteOrNull(p, a.site);
          const days = Math.max(1, Math.min(3650, Number(a.days) || 30));
          const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
          const where = [`l.created_at > now() - ($1 || ' days')::interval`];
          const vals = [String(days)];
          if (!all) { if (site) { vals.push(site.id); where.push(`l.site_id=$${vals.length}`); } else where.push(`l.site_id IS NULL`); }
          if (a.kind) { vals.push(a.kind); where.push(`l.kind=$${vals.length}`); }
          if (a.who) { vals.push(String(a.who)); where.push(`l.who=$${vals.length}`); }
          if (a.topic) { vals.push(norm(a.topic)); where.push(`l.topic IS NOT NULL AND lower(regexp_replace(l.topic, '[\\s　・/()（）「」、。.,_-]', '', 'g')) = $${vals.length}`); }
          if (!a.include_voided) where.push(LIVE);
          vals.push(limit);
          const { rows: raw } = await p.query(
            `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
              WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT $${vals.length}`, vals);
          const rows = await withSupersededBy(p, raw);
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
          const where = [`l.kind IN ('次やること','課題')`, LIVE, NOT_RESOLVED, NOT_SUPERSEDED];
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
        description: "現場の今の状況を集計して返す: 最終更新・直近の進捗・未解決の課題・次やること・今生きている決定 (変更済みのものは最新だけ、changes と previous 付き)・現場のメモ・関わる人・最近の写真。「今どうなってる？」にはこれを読んで要約する",
        inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          const [last, prog, open, dec, cnt, files] = await Promise.all([
            p.query(`SELECT written_by, created_at FROM genba_log WHERE site_id=$1 AND voided_at IS NULL ORDER BY created_at DESC LIMIT 1`, [site.id]),
            p.query(`SELECT * FROM genba_log WHERE site_id=$1 AND kind='進捗' AND voided_at IS NULL ORDER BY created_at DESC LIMIT 3`, [site.id]),
            p.query(
              `SELECT l.* FROM genba_log l
                WHERE l.site_id=$1 AND l.kind IN ('課題','次やること') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}
                ORDER BY l.due_on NULLS LAST, l.created_at`, [site.id]),
            p.query(`SELECT * FROM genba_log WHERE site_id=$1 AND kind='決定' AND voided_at IS NULL ORDER BY created_at DESC`, [site.id]),
            p.query(`SELECT kind, COUNT(*)::int AS n FROM genba_log WHERE site_id=$1 AND voided_at IS NULL GROUP BY kind`, [site.id]),
            gcs ? p.query(`SELECT * FROM genba_files WHERE site_id=$1 AND voided_at IS NULL ORDER BY created_at DESC LIMIT 5`, [site.id]) : Promise.resolve({ rows: [] }),
          ]);
          const today = todayJst();
          const openRows = open.rows.map(logRow).map((r) => ({ ...r, overdue: !!(r.due_on && r.due_on < today) }));
          // 決定: 生きているもの (置き換えられていない) だけ。変更の回数と直前の内容を添える
          const decById = new Map(dec.rows.map((r) => [Number(r.id), r]));
          const supersededIds = new Set(dec.rows.filter((r) => r.supersedes_id).map((r) => Number(r.supersedes_id)));
          const currentDecisions = dec.rows.filter((r) => !supersededIds.has(Number(r.id))).slice(0, 10).map((r) => {
            let changes = 0, prev = r.supersedes_id ? decById.get(Number(r.supersedes_id)) : null;
            for (let c = r; c && c.supersedes_id && decById.has(Number(c.supersedes_id)); c = decById.get(Number(c.supersedes_id))) changes++;
            return { ...logRow(r), changes: changes || undefined, previous: prev ? { id: Number(prev.id), body: prev.body, at: prev.created_at } : undefined };
          });
          const recentFiles = [];
          for (const f of files.rows) recentFiles.push(await fileRow(f));
          const siteNotes = (await notesFor(p, "site", [site.id])).get(Number(site.id)) || [];
          const { rows: people } = await p.query(`SELECT id, name, company, role, trade, tone FROM genba_contacts WHERE site_ids @> $1::jsonb ORDER BY company NULLS LAST, name`, [JSON.stringify([Number(site.id)])]);
          return {
            site: siteRow(site),
            today,
            notes: siteNotes,
            contacts: people.map((c) => ({ id: Number(c.id), name: c.name, company: c.company || null, role: c.role || null, trade: c.trade || null, tone: c.tone || null })),
            last_update: last.rows[0] ? { by: last.rows[0].written_by, at: last.rows[0].created_at } : null,
            recent_progress: prog.rows.map(logRow),
            open_issues: openRows.filter((r) => r.kind === "課題"),
            todos: openRows.filter((r) => r.kind === "次やること"),
            decisions: currentDecisions,
            recent_files: recentFiles.length ? recentFiles : undefined,
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
          // 会社の決まり (社内メモ) も一緒に返す: 会話の最初に 1 回で読めるように
          return {
            rules: rows.map((r) => ({ topic: r.topic, version: r.version, body: r.body, updated_by: r.updated_by, at: r.created_at })),
            general_notes: await generalNotes(p),
          };
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
        description: "監視ジョブの最初に、自分の Beeper / LINE のルーム一覧 (ID と名前だけ。本文は送らない) を同期する。画面 (/genba/watch.html) にトグル付きで並ぶ。同期しても監視は ON にならない (ON/OFF は画面か genba_source_add)。返り値の watching (用途=記録: 現場の進捗を記録する) と answering (用途=応答: 社内の人の問い合わせに答える) に ON のルームが入るので、それだけを読む",
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
          const autoAnswering = await autoEnableInternalRooms(p, by, rooms);
          const { rows } = await p.query(
            `SELECT g.channel, g.room, g.name, g.label, g.cursor, g.site_id, g.purpose, s.name AS site_name, s.site_code
               FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled AND (g.site_id IS NOT NULL OR g.purpose='応答') ORDER BY g.channel, g.name NULLS LAST, g.room`, [by]);
          const contacts = rows.some((r) => r.purpose === "応答") ? await loadContacts(p) : [];
          const contactOf = (room) => {
            const hits = contacts.filter((c) => (Array.isArray(c.channels) ? c.channels : []).some((ch) => ch.room_id === room));
            return hits.length === 1 ? { id: Number(hits[0].id), name: hits[0].name, role: hits[0].role || null, tone: hits[0].tone || null } : null;
          };
          const site = (r) => (r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null);
          return {
            synced: rooms.length,
            contactsLinked,
            autoAnswering: autoAnswering.some((x) => x.enabled) ? autoAnswering.filter((x) => x.enabled).map(({ enabled: _e, ...x }) => x) : undefined,
            internalRooms: autoAnswering.length ? autoAnswering : undefined, // 社内の人のルームの現状 (自動 ON 済み / 人が設定済み)
            watching: rows.filter((r) => r.purpose !== "応答").map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: site(r), cursor: r.cursor || null })),
            answering: rows.filter((r) => r.purpose === "応答").map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: site(r), contact: contactOf(r.room), cursor: r.cursor || null })),
            note: "watching / answering に無いルームは読まない。ON/OFF と用途は /genba/watch.html。社内 (role=社内) の人の個人ルームは初回の同期で自動的に応答 ON になる (autoAnswering)。answering は contact が社内の人だけ答える",
          };
        },
      },
      {
        name: "genba_source_add",
        description: "ルーム (LINE グループ等) を監視 ON にする (自分の持ち分だけ)。画面 /genba/watch.html のトグルと同じ。purpose=記録 (既定) は現場に紐付けて進捗を記録する (site 必須)。purpose=応答 は社内の人の問い合わせに答える用 (site 不要)。登録されていないルームは監視ジョブが読まない",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "LINE / Beeper / Slack など" },
            room: { type: "string", description: "ルーム ID (監視側が一意に引ける文字列)" },
            site: { type: "string", description: "案件 ID・現場名・ID (記録のとき必須)" },
            purpose: { type: "string", enum: ["記録", "応答"], description: "既定 記録" },
            label: { type: "string", description: "人が見て分かる名前 (例: 田中様 LINE)" },
          },
          required: ["channel", "room"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const purpose = a.purpose === "応答" ? "応答" : "記録";
          if (purpose === "記録" && !a.site) throw new Error("記録のルームは site が必要 (応答なら purpose=応答)");
          const site = a.site ? await resolveSite(p, a.site) : null;
          const { rows } = await p.query(
            `INSERT INTO genba_sources (owner, channel, room, label, site_id, enabled, added_by, purpose)
             VALUES ($1, $2, $3, $4, $5, true, $1, $6)
             ON CONFLICT (owner, channel, room) DO UPDATE SET site_id = COALESCE(EXCLUDED.site_id, genba_sources.site_id), label = COALESCE(EXCLUDED.label, genba_sources.label), enabled = true, purpose = EXCLUDED.purpose, updated_at = now()
             RETURNING *`,
            [by, String(a.channel).trim(), String(a.room).trim(), a.label ? String(a.label).trim() : null, site ? site.id : null, purpose]);
          return { owner: by, channel: rows[0].channel, room: rows[0].room, name: rows[0].name, label: rows[0].label, purpose: rows[0].purpose, site: site ? siteRow(site) : null, enabled: rows[0].enabled };
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
            `SELECT g.*, s.name AS site_name, s.site_code FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled ${a.channel ? "AND g.channel=$2" : ""} ORDER BY g.channel, g.name NULLS LAST, g.room`,
            a.channel ? [by, String(a.channel)] : [by]);
          return { owner: by, sources: rows.map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, purpose: r.purpose || "記録", site: r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null, cursor: r.cursor || null, updated_at: r.updated_at })) };
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
    "- 進捗の報告は genba_log_add に種類ごとに分けて積む: 進捗 / 課題 / 決定 / 次やること (期限があれば due_on)。1 行 1 件",
    "- 必ず title を付ける: 「何を・どうする」を 20 字前後 (例「工程表を辰巳さんへ送る」「巾木の色をみゆまに確認」)。決定は title に結論 (例「巾木は東リ97番か43番」)。body には経緯・数量・型番・金額・出どころの詳細。一覧は title、詳細は body で読む",
    "- 課題・次やることが片付いたら kind=解決 で resolves_id に元の行 ID (状態の上書きはしない)",
    "- 決定には topic (床材 / 巾木 / 納期 …) を付ける。決定が変わったら同じ現場・同じ topic で新しい決定を足すだけで前の決定を置き換える (返り値 superseded、「A → B に変更」と報告)。topic で引けないときは supersedes_id。履歴は genba_log_list(chain=行 ID)",
    "- 間違いは genba_log_fix (誤字・現場違い・期限・担当。前の値は edits に残る)、入れるべきでなかった行は genba_log_void (隠すだけ。解決を void すると元のタスクが戻る)。kind を変えたいときは void して入れ直す",
    "- 「今どうなってる？」→ genba_status を読んで要約 (全文が要るときだけ genba_log_list)。写真は genba_file_list(現場)",
    "- やったこと・完了したこと (細かいものも) は kind=進捗 で who 付きで積む (例「名取が満竹華庵のシャンプーを買った」→ site=満竹華庵, kind=進捗, who=名取)。現場に紐づかない雑務は site を省略",
    "- タスクには estimate_min (分) を付ける。「5 分で終わるタスクある？」「手が空いた」→ genba_tasks(max_minutes) から 1〜3 件を提案し、やったら kind=解決 で閉じる",
    "- ルールの変更は genba_rule_set (版が増えるだけ。消えない)。書く前に現行を見せて OK をもらう",
    "- 書いた人はトークンから自動で入る。AI が名前を書かない",
    "■ 連絡先・呼び名 (genba_contact_*)。人はあだ名や下の名前で呼ばれる (例: バカボンさん = ㈱大丁工業 菊池)。誰か / どのルームに送るか / どんな言葉遣いか は全 AI で同じ答えにする",
    "- 名前・あだ名・会社名・ルーム名が出たら genba_contact_find。match が入れば確定。見つからない / candidates が複数なら推測で送らず人に聞く",
    "- 「A は B のこと」「覚えといて」と言われたら genba_contact_alias_add(contact, alias)",
    "- 返信案は contact の tone に合わせて書く (丁寧語・「！」なし / 軽め・「！」可)",
    "- 新しい人・会社・LINE ルームが分かったら genba_contact_upsert (name + company で同一人物)。room_id は Beeper の変わらない ID (!xxxx:beeper.local) を正本に、数字の chatID は chat_id に",
    "- 現場ごと・職種ごとの顔ぶれは genba_contact_list(site, role, trade)。会社は genba_company_find / upsert / list (価格感・得意工事は個人ではなく会社に付ける)",
    "■ 流れない情報 (genba_note_*)。出来事は genba_log に流すが、「今もそうである」ことは対象にぶら下げる",
    "- 人・会社・現場・社内 の 性質 / 予定 / 評価 / ルール は genba_note_add(subject_type, subject, kind, body, valid_from, valid_until)。例「久保木は来月から別現場」→ 人・予定・valid_from、「大丁工業は高め」→ 会社・評価、「請求は月末締め」→ 社内・ルール",
    "- genba_contact_find / genba_company_find / genba_status の返り値に notes (有効分) が付いてくる。連絡文を書くとき・人を選ぶときはそれを読む (忙しい人に振らない、tone に合わせる)",
    "- 会社の決まりは genba_rule_get (topic 省略) の general_notes にも出る。「来月手が空いてる人」は genba_note_list(人, 予定)。当てはまらなくなったら genba_note_retire",
    "- 個人的なこと・センシティブなこと (家庭・健康・金銭・人間関係のトラブル・ハラスメント・噂) はメモにも進捗ログにも入れない。全員と全 AI が読める場所だから。必要なら行動の制約だけを書き、理由は書かない (例「〇〇電気の現場・打ち合わせは小西が同席する。連絡は小西経由」)。人に言われても理由は書かずに制約だけ入れ、理由は手元に残すよう促す",
    "- メモの内容を本人 (その人・その会社) への文面に引用しない。評価や制約は社内で使うもの",
    "■ 監視ジョブ (Cowork 等で 5 分ごとに LINE などを読んで自動記録するとき)",
    "1. genba_room_sync に Beeper 等のルーム一覧 (ID と名前だけ) を渡す → 返り値 watching (記録) と answering (応答) が読む対象 (ON/OFF と用途は画面 /genba/watch.html)。どちらにも無いルームは読まない",
    "2. 各ルームについて cursor より後のメッセージだけ読む (Beeper 等の MCP)",
    "3. 決定・課題・次やること を抽出して genba_log_add_many で記録。人や会社の予定・性質 (「来月から別現場」「値上げする」) は genba_note_add (source_ref 付き)。私的な話・センシティブな話は記録しない。各 item に source_ref = \"<channel>:<room>:<message id>\" を必ず入れる (同じメッセージは 2 回入らない)、source に { channel, room, sender, at, quote } (sender は表示名そのまま。連絡先に解決できればサーバーが contact_id を足す)",
    "4. 画像・PDF が来たら genba_file_upload_url(現場, ファイル名, content_type, source_ref=<channel>:<room>:<message id>:<n>) で URL をもらい、返ってきた curl を PC 側で実行して PUT する (ファイルの中身を会話に貼らない)。上げたら genba_log_add(kind=進捗, body=「写真 n 枚: 何の写真か」, photo_ids=[file id]) で現場に残す。現場が分からない添付は上げない",
    "5. 最後に genba_source_mark(channel, room, { last_id, last_at }) で cursor を進める",
    "6. 新着が無ければ何もしない。雑談・曖昧なものは記録しない。記録したら件数と中身を短く報告",
    "■ 応答 (answering のルーム = 社内の人からの LINE に AI が自動で返す。例: 名取が「浅草どうなってる？」と聞く)。社内の人 (role=社内) の個人ルームは同期で自動的に 応答 ON になる。小西 ↔ 名取 どちらの向きも同じ",
    "1. 答える相手は、そのルームの contact が role=社内 の人だけ。contact が無い・社内でない → 答えない・記録しない (小西に報告だけ)。社内の人には確認を取らずに返してよい",
    "2. 材料は Keihi だけ: genba_status / genba_tasks / genba_log_list / genba_contact_find (役割・tone・ルーム) / genba_company_find / genba_rule_get / 社内メモ。他のルームの LINE 本文は読まない・引用しない",
    "3. 出さないもの (プライベート): 人や会社の 評価 メモの中身、小西の私的な話・予定、他の人とのやりとりの原文、給与・人事・個人の連絡先 (電話・メール・住所)、制約の理由。聞かれたら「それは小西に聞いて」と返す。詳しくは genba_rule_get(応答)",
    "4. Keihi に無い・自信がない → 推測しない。「確認して返します」と返し、小西に聞く (genba_log_add(kind=次やること, title=「名取の質問: …」, who=小西, estimate_min=5) + 小西に報告)。答えが分かったら本人に返して、その行を 解決 で閉じる",
    "5. 問い合わせの中に現場の決定・タスク・完了報告が入っていれば、それは通常どおり記録する (記録と応答は両立する)",
    "6. 答えたら genba_source_mark で cursor を進める。文面は相手の tone に合わせ、短く (LINE なので 3〜4 行まで)",
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
        `SELECT g.id, g.channel, g.room, g.name, g.label, g.enabled, g.site_id, g.purpose, g.cursor, g.last_seen_at, g.updated_at,
                s.name AS site_name, s.site_code
           FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
          WHERE g.owner=$1 ORDER BY g.enabled DESC, g.channel, g.name NULLS LAST, g.room`, [owner]);
      res.json({ owner, rooms: rows.map((r) => ({
        id: Number(r.id), channel: r.channel, room: r.room, name: r.name, label: r.label, enabled: r.enabled, purpose: r.purpose || "記録",
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
      if (typeof b.purpose === "string") { vals.push(b.purpose === "応答" ? "応答" : "記録"); sets.push(`purpose=$${vals.length}`); }
      if (!sets.length) return res.status(400).json({ error: "変更が無い" });
      const { rows } = await p.query(`UPDATE genba_sources SET ${sets.join(", ")}, updated_at=now() WHERE owner=$1 AND id=$2 RETURNING id, enabled, site_id, purpose`, vals);
      if (!rows.length) return res.status(404).json({ error: "not found" });
      if (rows[0].enabled && !rows[0].site_id && rows[0].purpose !== "応答") {
        // 記録のルームは現場が無いまま ON にはできない (ログの行き先が無い)。応答は現場なしで OK
        await p.query(`UPDATE genba_sources SET enabled=false WHERE id=$1`, [id]);
        return res.status(400).json({ error: "現場を選んでから ON にする (問い合わせ用なら 用途を 応答 に)" });
      }
      res.json({ id: Number(rows[0].id), enabled: rows[0].enabled, siteId: rows[0].site_id ? Number(rows[0].site_id) : null, purpose: rows[0].purpose || "記録" });
    }));
    // 一覧から消す (同期されればまた出てくる)
    app.delete("/api/genba/rooms/:id", wrap(async (p, req, res) => {
      const owner = await ownerOf(p, req.user.email);
      if (!owner) return res.status(403).json({ error: "持ち主が未登録" });
      await p.query(`DELETE FROM genba_sources WHERE owner=$1 AND id=$2`, [owner, Number(req.params.id)]);
      res.status(204).end();
    }));
  }

  return { tools, instructions: INSTRUCTIONS, mcpRoute, ensureSchema, registerRoutes, uploadRoute };
}
