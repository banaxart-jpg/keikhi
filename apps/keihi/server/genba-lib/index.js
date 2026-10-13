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
const LOG_KINDS = ["進捗", "課題", "決定", "次やること", "待ち", "解決"];
// 開いたループ (解決で閉じるもの)。待ち = 相手の返事・物・データを待っている (人の仕事ではないのでタスク一覧・カレンダーには出さない)
const OPEN_KINDS = ["課題", "次やること", "待ち"];
const TASK_KINDS = ["次やること", "課題"];

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
// getCalendarApi = Google Calendar API (SA 認証)。タスク専用カレンダーとの双方向同期に使う (無ければ同期機能は出ない)
export function createGenba({ getPool, createMcpHandler, getDriveApi, gcs = null, getCalendarApi = null }) {
  // 1 プロセスで 1 回だけ。同時に来た最初の数リクエストは同じ promise を待つ (DDL を重ねて走らせない)。
  // 起動時に index.js から先に呼んでおく (コールドスタート直後の最初のツール呼び出しを速くする)
  let schemaOk = false, schemaPromise = null;
  async function ensureSchema() {
    if (schemaOk) return;
    if (schemaPromise) return schemaPromise;
    schemaPromise = ensureSchemaOnce().catch((e) => { schemaPromise = null; throw e; });
    return schemaPromise;
  }
  async function ensureSchemaOnce() {
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
    // 種類 待ち を追加 (2026-10-13)。CREATE TABLE の CHECK は自動命名 genba_log_kind_check
    await p.query(`ALTER TABLE genba_log DROP CONSTRAINT IF EXISTS genba_log_kind_check`);
    await p.query(`ALTER TABLE genba_log ADD CONSTRAINT genba_log_kind_check CHECK (kind IN ('進捗','課題','決定','次やること','待ち','解決'))`);
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
    // 日程をカレンダーに入れたら、その行に event ID (か 'done') を残す。抜け漏れチェック (genba_audit) が「日程あり・未登録」を拾う
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS calendar_event TEXT`);
    // タスクカレンダー同期用: 最後にカレンダーへ書いた状態 {date, summary, colorId}。これと予定の今を比べて「人が動かしたか」を見る
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS cal_snapshot JSONB`);
    // 待ち の「来たらやること」(ジョブ化): 返事・データが届いたら誰が何をするか。待っていた相手からの連絡で waiting_hits に載り、AI がそれを実行する
    await p.query(`ALTER TABLE genba_log ADD COLUMN IF NOT EXISTS then_do TEXT`);
    // 設定 (タスクカレンダーの ID と色の対応など)。デプロイ無しで変えられるように DB に置く
    await p.query(`
      CREATE TABLE IF NOT EXISTS genba_settings (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        updated_by  TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
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
    // 監視対象: owner (誰の Beeper/LINE か) × channel × room。監視ジョブがルーム一覧 (ID と名前だけ) を genba_room_sync で入れる。
    // デフォルトで全部読む (enabled=true)。個人的なルームは genba_source_exclude で外す (enabled=false)。
    // site_id は任意 (無ければ AI が内容から現場を判定、分からなければ会社全般)
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
    // 方針 (2026-10-13): ルームはデフォルトで全部読む (enabled=true)。個人的なルームだけ genba_source_exclude で外す。
    // 画面 (/genba/watch.html) は廃止。人が触っていない OFF の行 (updated_at = added_at) は ON に戻す
    await p.query(`ALTER TABLE genba_sources ALTER COLUMN enabled SET DEFAULT true`);
    await p.query(`UPDATE genba_sources SET enabled=true WHERE enabled=false AND purpose='記録' AND site_id IS NULL AND label IS NULL AND cursor IS NULL AND updated_at = added_at`);
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
  const THEN_MAX = 300;
  function cleanThen(v) {
    if (v == null) return null;
    const t = String(v).trim().replace(/\s+/g, " ");
    if (!t) return null;
    if ([...t].length > THEN_MAX) throw new Error(`then は ${THEN_MAX} 字まで (${[...t].length} 字)`);
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
    calendar_event: r.calendar_event || undefined,
    then: r.then_do || undefined,
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
  // ── 抜け漏れの検知 (本文から機械的に拾う。AI の記憶に頼らない) ──
  // 返事待ち・確認中・依頼した → 次やること (期限付き) が無いと流れる
  const WAIT_RE = /待ち|確認中|確認する|確認して|依頼(済|した|しました|中|する)|頼ん(だ|である)|頼む|投げ(た|てある|る)|送(った|付した|付済|信した)|聞い(た|てある|てみる)|問い合わせ|回答待ち|返事|返答|見積(待ち|依頼|を頼)/;
  // 日程を含む出来事 (搬入・打ち合わせ・現調・作業日…) → カレンダー登録が要る
  const EVENT_RE = /搬入|搬出|打ち?合わ?せ|現調|現場調査|着工|引き?渡し|納品|作業日|作業に入|に入る|入り|立ち?会い|検査|撤去|工事|施工|取付|据付|配送|納材|開始|完了予定|夜間|朝一/;
  const DATE_RE = /\d{1,2}\s*[\/月]\s*\d{1,2}|来週|来月|明日|明後日|今週|週末|翌日|[月火水木金土日]曜|\d{1,2}\s*時/;
  const textOf = (r) => `${r.title || ""} ${r.body || ""}`;
  const looksWaiting = (r) => (r.kind === "進捗" || r.kind === "決定") && WAIT_RE.test(textOf(r));
  // 「誰の返事待ちか / 何待ちか」の手がかり: 〇〇さん・〇〇様 の名前、「見積待ち」「図面確認中」の名詞。タスクがこの手がかりを含めば片付いている扱い
  function waitKeys(r) {
    const s = textOf(r), keys = new Set();
    for (const m of s.matchAll(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{1,8})(さん|様|くん|ちゃん)/gu)) keys.add(m[1]);
    for (const m of s.matchAll(/([\p{Script=Han}\p{Script=Katakana}A-Za-z]{2,10})(待ち|確認中|依頼|を頼|の返事|の回答)/gu)) keys.add(m[1]);
    if (r.topic) keys.add(r.topic);
    return [...keys].filter((k) => !["返事", "回答", "確認", "連絡", "依頼"].includes(k));
  }
  // その行の後 2 日以内に、同じ現場で、手がかりを含む未解決タスクが立っていれば OK
  function waitingCovered(r, openTasks) {
    const t0 = new Date(r.created_at).getTime() - 60000, t1 = t0 + 2 * 86400000 + 60000;
    const keys = waitKeys(r);
    return openTasks.some((t) => (t.site_id ?? null) === (r.site_id ?? null) && Number(t.id) !== Number(r.id)
      && new Date(t.created_at).getTime() >= t0 && new Date(t.created_at).getTime() <= t1
      && (!keys.length || keys.some((k) => textOf(t).includes(k))));
  }
  const looksEvent = (r) => EVENT_RE.test(textOf(r)) && (DATE_RE.test(textOf(r)) || !!r.due_on);
  // 1 行追記したあとに AI へ返す「次にやること」。ここで拾えば AI が忘れても止まる
  function followupsFor(row, { hasTaskInBatch = false } = {}) {
    const out = [];
    const isTask = TASK_KINDS.includes(row.kind);
    if (looksWaiting(row) && !hasTaskInBatch) out.push(`返事待ち・確認中の内容 → genba_log_add(kind=待ち, title=「〇〇の返事待ち」, who=待っている相手) で残す (タスクではない。返事が来たら 解決)`);
    // タスクはタスクカレンダーに Keihi が自動で出すので AI がカレンダーに入れない。決定・進捗に含まれる日程 (搬入・打ち合わせ) だけ人の判断で
    if (looksEvent(row) && !row.calendar_event && !(isTask && taskCalendarOn)) out.push(`日程が入っている → BANAX カレンダーに登録 (ルール カレンダー)。登録したら genba_log_fix(id=${Number(row.id)}, calendar_event=<event id か done>) で印を付ける`);
    if (row.kind === "決定" && !row.topic) out.push(`決定に topic が無い → genba_log_fix(id=${Number(row.id)}, topic=…) (変更の紐付けに使う)`);
    if (isTask && !row.due_on) out.push(taskCalendarOn
      ? `期限が無い → due_on を付ける。無いと【なるはや】として今日のカレンダーに出続ける (カレンダー上で日付を動かせば期限になる)`
      : `期限が無い → due_on を付ける (期限切れの検知に使う)`);
    return out;
  }
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
    const calendarEvent = a.calendar_event ? String(a.calendar_event).trim().slice(0, 200) : null;
    const thenDo = cleanThen(a.then);
    let resolvesId = null;
    if (a.kind === "解決") {
      resolvesId = Number(a.resolves_id);
      if (!Number.isInteger(resolvesId)) throw new Error("kind=解決 には resolves_id (元の課題/次やることの行 ID) が必要");
      const { rows: orig } = await p.query(`SELECT id, kind, site_id FROM genba_log WHERE id=$1 AND voided_at IS NULL`, [resolvesId]);
      if (!orig.length) throw new Error(`行 ${resolvesId} が無い (か取り消し済み)`);
      // 解決行は元の行と同じ現場に入れる (site を省略して ID だけで解決できるように)
      if (siteRowCache == null && a.site == null) { /* 現場未指定 → 元の行の現場を引き継ぐ */ }
      if (site && orig[0].site_id != null && Number(orig[0].site_id) !== Number(site.id)) throw new Error(`行 ${resolvesId} はこの現場のログに無い`);
      if (!OPEN_KINDS.includes(orig[0].kind)) throw new Error(`行 ${resolvesId} は ${orig[0].kind} なので解決の対象ではない`);
    }
    const due = a.due_on && /^\d{4}-\d{2}-\d{2}$/.test(a.due_on) ? a.due_on : null;
    if (a.due_on && !due) throw new Error("due_on は YYYY-MM-DD");
    const photos = Array.isArray(a.photo_ids) ? a.photo_ids.filter(Boolean).map(String).slice(0, 50) : null;
    const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
    const source = a.source && typeof a.source === "object" ? { ...a.source } : null;
    // 出どころの送信者 (表示名) が連絡先に一意に解決できたら contact_id / contact_name も残す (AI が書いた名前は上書きしない)
    let waitingHits = [];
    if (source && source.contact_id == null && (source.sender || source.room)) {
      const c = await resolveSourceContact(p, source, ctx);
      if (c) {
        source.contact_id = Number(c.id); source.contact_name = c.name;
        // この人からの連絡 = この人を待っていた 待ち があれば、返事が来たので AI に知らせる (自動発火)
        try { waitingHits = waitingFor(c, await loadOpenWaiting(p, ctx)); } catch (e) { console.warn("[genba] waiting hits", e.message); }
      }
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
      `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, resolves_id, photo_ids, source_ref, source, estimate_min, who, topic, supersedes_id, title, calendar_event, then_do)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [useSiteId, a.kind, body, by, due, resolvesId, photos ? JSON.stringify(photos) : null, sourceRef, source ? JSON.stringify(source) : null, est, who, topic, supersedesId, title, calendarEvent, thenDo]
    );
    if (rows.length) {
      const followups = followupsFor(rows[0], { hasTaskInBatch: !!ctx.hasTaskInBatch });
      let siteOverdue;
      if (useSiteId != null && !ctx.skipOverdue) {
        const { rows: od } = await p.query(
          `SELECT COUNT(*)::int AS n FROM genba_log l WHERE l.site_id=$1 AND l.kind IN ('課題','次やること') AND l.due_on < $2::date AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}`,
          [useSiteId, todayJst()]);
        siteOverdue = od[0]?.n || 0;
      }
      return {
        site: siteOut, log: logRow(rows[0]), duplicate: false,
        superseded: superseded ? { id: Number(superseded.id), body: superseded.body, at: superseded.created_at } : undefined,
        say: superseded ? `${topic || superseded.topic || "決定"}: 「${superseded.body}」→「${body}」に変更` : undefined,
        followups: followups.length ? followups : undefined,
        site_overdue: siteOverdue ? `この現場に期限切れのタスクが ${siteOverdue} 件 (genba_tasks(site) で確認)` : undefined,
        waiting_hits: waitingHits.length ? waitingHits : undefined,
        waiting_say: waitingHits.length ? waitingSay(`${source.contact_name} からの連絡。`, waitingHits) : undefined,
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
      // 直近のやりとりの時刻: この人からのメッセージの記録 (source.at) と、この人のルームの cursor (監視ジョブが最後に読んだメッセージの時刻)
      const roomIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.channels) ? r.channels : []).map((c) => c.room_id).filter(Boolean)))];
      let srcRows = [];
      if (roomIds.length) {
        try { srcRows = (await p.query(`SELECT channel, room, cursor FROM genba_sources WHERE room = ANY($1::text[])`, [roomIds])).rows; } catch (e) { console.warn("[genba] contact rooms", e.message); }
      }
      for (const [i, o] of out.entries()) {
        const { rows: lg } = await p.query(
          `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
            WHERE l.source->>'contact_id' = $1 AND l.voided_at IS NULL ORDER BY l.created_at DESC LIMIT 5`, [String(o.id)]);
        o.recent_log = lg.map(logRow);
        const mine = new Set((Array.isArray(rows[i].channels) ? rows[i].channels : []).map((c) => c.room_id).filter(Boolean));
        const times = [
          ...lg.map((l) => l.source && l.source.at).filter(Boolean),
          ...srcRows.filter((x) => mine.has(x.room)).map((x) => x.cursor && x.cursor.last_at).filter(Boolean),
        ].map((t) => new Date(t).getTime()).filter((t) => Number.isFinite(t));
        const last = times.length ? new Date(Math.max(...times)) : null;
        o.last_contact = last ? { at: last.toISOString(), minutes_ago: Math.max(0, Math.floor((Date.now() - last.getTime()) / 60000)) } : null;
        o.message_hint = messageHint(o.last_contact);
      }
    }
    return out;
  }
  // 連絡文の書き出し: 会話の続きなら挨拶を付けない (毎回「お疲れ様です！」から始めない)。Keihi が知っている範囲の時刻で判定し、送る直前にルームの直近を読むのは AI 側
  const jstDayOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  function messageHint(last) {
    const base = "送る直前にそのルームの直近 5 件を読み、会話の続きとして書く。1 通に用件は 1 つ、前に送った内容 (住所・日程・お礼) は繰り返さない";
    if (!last) return `このルームとのやりとりの記録が無い → 最初の 1 通だけ短い挨拶 OK (tone に従う)。${base}`;
    if (last.minutes_ago <= 180) return `${last.minutes_ago} 分前にやりとりあり → 「お疲れ様です」等の挨拶は付けない。用件から書く (続報・訂正は「先ほどの〇〇の件、」で始める)。${base}`;
    if (jstDayOf(last.at) === todayJst()) return `今日すでにやりとりあり → 挨拶は付けず用件から書く。${base}`;
    return `今日はまだやりとり無し → 最初の 1 通だけ短い挨拶 OK (tone に従う)。${base}`;
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
  // その人を待っている 待ち (未解決) を引く。who がその人の名前・呼び名、または本文に名前が出ている行
  async function loadOpenWaiting(p, ctx = {}) {
    if (ctx.openWaiting) return ctx.openWaiting;
    const { rows } = await p.query(
      `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
        WHERE l.kind IN ('待ち') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED} ORDER BY l.created_at`);
    ctx.openWaiting = rows;
    return rows;
  }
  function waitingFor(contact, waits) {
    const keys = new Set([contact.name_key, ...(Array.isArray(contact.aliases) ? contact.aliases.map(normName) : [])].filter(Boolean));
    return waits.filter((w) => (w.who && keys.has(normName(w.who))) || (!w.who && [...keys].some((k) => k.length >= 2 && normName(w.title || "").includes(k))))
      .map((w) => ({ id: Number(w.id), title: w.title || autoTitle(w.body), then: w.then_do || undefined, site: w.site_id ? { id: Number(w.site_id), name: w.site_name } : null, since: w.created_at }));
  }
  // 待っていた相手から連絡が来たときに AI へ返す指示文。then (来たらやること) があればそれを実行させる
  function waitingSay(lead, hits) {
    const list = hits.map((w) => `#${w.id} ${w.title}${w.from ? ` (${w.from})` : ""}${w.then ? ` → 来たら: ${w.then}` : ""}`).join(" / ");
    const anyThen = hits.some((w) => w.then);
    return `${lead}待っていた件 ${list} の返事なら、内容を記録して genba_log_add(kind=解決, resolves_id=…) で閉じ、${anyThen ? "「来たら」に書いてあることを実行する (送る相手は genba_contact_find。社外の人への文面は小西に見せてから、社内なら確認なしでよい)。無いものは" : ""}小西に報告して次のタスクに進む`;
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
  // 一度でも人が触った行 (現場を付けた・ラベルを付けた・用途を変えた・読み進めた) には触らない。
  // 用途が 応答 になった行は、人が OFF にしても purpose='記録' でないので二度と自動 ON しない
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
          WHERE owner=$1 AND channel=$2 AND room=$3 AND purpose='記録' AND site_id IS NULL AND label IS NULL AND cursor IS NULL
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

  // ───────── タスクカレンダー同期 (Keihi が正本、カレンダーは見る窓) ─────────
  // 専用カレンダー「BANAX タスク」と未解決タスクを双方向に合わせる。AI は関与しない (拾い漏れを仕組みで無くす)。
  //   Keihi → カレンダー: 未解決タスク = 終日予定 1 件。期限切れは今日に【期限切れ M/D】、期限なしは今日に【なるはや】。解決・取り消しで予定を消す
  //   カレンダー → Keihi: 人が予定を動かした = 期限変更、件名を変えた = title 変更、消した = 解決。人が直接作った予定 = 次やること として取り込む
  //   3 者比較: genba_log.cal_snapshot (最後に書いた状態) と予定の今が違えば人が触った、Keihi の望む状態と違えば Keihi から書く
  const SETTING_CAL = "task_calendar", SETTING_CAL_SYNC = "task_calendar_sync";
  const DEFAULT_COLORS = { "小西": "8", "名取": "1" }; // Google カレンダーの colorId: 8 = グラファイト, 1 = ラベンダー
  let taskCalendarOn = false; // 設定があるか (followups / audit の出し分けに使う。起動後の最初の読みで更新)
  let calCfgCache = { at: 0, cfg: null };
  async function getSetting(p, key) { const { rows } = await p.query(`SELECT value FROM genba_settings WHERE key=$1`, [key]); return rows[0]?.value ?? null; }
  async function setSetting(p, key, value, by) {
    await p.query(`INSERT INTO genba_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, JSON.stringify(value), by]);
  }
  async function taskCalendarConfig(p, { fresh = false } = {}) {
    if (!fresh && Date.now() - calCfgCache.at < 60000) return calCfgCache.cfg;
    const cfg = await getSetting(p, SETTING_CAL);
    calCfgCache = { at: Date.now(), cfg: cfg && cfg.calendarId ? cfg : null };
    taskCalendarOn = !!calCfgCache.cfg;
    return calCfgCache.cfg;
  }
  const evDate = (ev) => (ev?.start?.date ? String(ev.start.date).slice(0, 10)
    : ev?.start?.dateTime ? new Date(new Date(ev.start.dateTime).getTime() + 9 * 3600000).toISOString().slice(0, 10) : null);
  const addDaysStr = (day, n) => { const t = new Date(day + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const mdJp = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const CAL_PREFIX_RE = /^(?:【(?:期限切れ|なるはや)[^】]*】\s*)+/;
  const safeTitle = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); const cs = [...t]; return cs.length > TITLE_MAX ? cs.slice(0, TITLE_MAX).join("") : t; };
  // タスクをカレンダーにどう見せるか
  function desiredEvent(task, cfg, today) {
    const due = ymd(task.due_on);
    const date = due ? (due < today ? today : due) : today;
    const prefix = due && due < today ? `【期限切れ ${mdJp(due)}】` : !due ? "【なるはや】" : "";
    const colors = cfg.colors || DEFAULT_COLORS;
    const colorId = (task.who && colors[task.who]) || cfg.defaultColor || null;
    const summary = `${prefix}${task.title || autoTitle(task.body)}`;
    const description = `${task.site_name ? `現場: ${task.site_name}\n` : ""}${task.kind === "課題" ? "課題\n" : ""}${task.who ? `担当: ${task.who}\n` : ""}${task.body}\n\n(Keihi #${Number(task.id)} が管理。終わったら Keihi で解決 → この予定は消える。日付を動かすと期限が変わる。予定を消すと解決扱い)`;
    return { date, summary, colorId, description };
  }
  const eventBody = (taskId, want) => ({
    summary: want.summary, description: want.description,
    start: { date: want.date }, end: { date: addDaysStr(want.date, 1) },
    ...(want.colorId ? { colorId: String(want.colorId) } : {}),
    transparency: "transparent",
    extendedProperties: { private: { keihiTaskId: String(taskId) } },
  });
  const snapOf = (want) => ({ date: want.date, summary: want.summary, colorId: want.colorId || null });
  async function listTaskEvents(cal, calendarId, today) {
    const out = []; let pageToken;
    do {
      const r = await cal.events.list({
        calendarId, singleEvents: true, showDeleted: true, maxResults: 2500, pageToken,
        timeMin: `${addDaysStr(today, -120)}T00:00:00+09:00`, timeMax: `${addDaysStr(today, 400)}T00:00:00+09:00`,
      });
      out.push(...(r.data.items || [])); pageToken = r.data.nextPageToken;
    } while (pageToken);
    return out;
  }
  // 件名から現場を当てる (現場名が 1 つだけ含まれていればそれ)
  async function guessSiteId(p, text) {
    const t = norm(text);
    if (!t) return null;
    const { rows } = await p.query(`SELECT id, name FROM sites WHERE done_at IS NULL`);
    const hits = rows.filter((s) => { const k = norm(s.name); return k.length >= 2 && t.includes(k); }).sort((a, b) => norm(b.name).length - norm(a.name).length);
    if (!hits.length) return null;
    const top = norm(hits[0].name).length;
    const best = hits.filter((s) => norm(s.name).length === top);
    return best.length === 1 ? Number(best[0].id) : null;
  }
  const isGone = (e) => e?.code === 404 || e?.code === 410 || e?.response?.status === 404 || e?.response?.status === 410;
  // 担当が AI のタスク (届いたら書類を作って送る等、AI が実行する仕事) は人のカレンダーには出さない
  const AI_WHO_RE = /^(ai|claude|クロード|cowork|エーアイ)$/i;
  const isAiTask = (t) => !!(t.who && AI_WHO_RE.test(String(t.who).trim()));
  let calSyncRunning = null, calSyncLastAt = 0;
  async function syncTaskCalendar({ by = "同期" } = {}) {
    const p = getPool();
    if (!p) throw new Error("DB not configured");
    await ensureSchema();
    const cfg = await taskCalendarConfig(p, { fresh: true });
    if (!cfg) return { configured: false, note: "genba_calendar_setup でタスク専用カレンダーを登録する" };
    if (!getCalendarApi) return { configured: true, error: "Calendar API が配線されていない" };
    if (calSyncRunning) return calSyncRunning;
    calSyncRunning = runCalendarSync(p, cfg, by).finally(() => { calSyncRunning = null; calSyncLastAt = Date.now(); });
    return calSyncRunning;
  }
  async function runCalendarSync(p, cfg, by) {
    const cal = await getCalendarApi();
    const today = todayJst();
    const stats = { created: 0, updated: 0, deleted: 0, resolved: 0, imported: 0, due_changed: 0, title_changed: 0, errors: [] };
    const colorsRev = Object.fromEntries(Object.entries(cfg.colors || DEFAULT_COLORS).map(([w, c]) => [String(c), w]));
    const { rows: open } = await p.query(
      `SELECT l.*, s.name AS site_name FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
        WHERE l.kind IN ('次やること','課題') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED} ORDER BY l.id`);
    const { rows: closed } = await p.query(
      `SELECT l.* FROM genba_log l WHERE l.calendar_event IS NOT NULL AND l.cal_snapshot IS NOT NULL
         AND NOT (l.kind IN ('次やること','課題') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED})`);
    const aiOpen = open.filter(isAiTask);
    const humanOpen = open.filter((t) => !isAiTask(t));
    const events = await listTaskEvents(cal, cfg.calendarId, today);
    const byId = new Map(events.map((e) => [e.id, e]));
    const byTask = new Map();
    for (const e of events) { const t = e.extendedProperties?.private?.keihiTaskId; if (t) byTask.set(Number(t), e); }
    const claimed = new Set([...open, ...closed].map((t) => t.calendar_event).filter(Boolean));
    // 担当が AI に変わったタスクの予定は消す (人のカレンダーから外す)
    for (const t of aiOpen) {
      if (!t.calendar_event || !t.cal_snapshot) continue;
      try {
        let ev = byId.get(t.calendar_event) || null;
        if (!ev) { try { ev = (await cal.events.get({ calendarId: cfg.calendarId, eventId: t.calendar_event })).data; } catch (e) { if (!isGone(e)) throw e; } }
        if (ev && ev.status !== "cancelled") { await cal.events.delete({ calendarId: cfg.calendarId, eventId: t.calendar_event }); stats.deleted++; }
        await p.query(`UPDATE genba_log SET cal_snapshot=NULL WHERE id=$1`, [t.id]);
      } catch (e) { stats.errors.push(`#${t.id}: ${e.message}`); }
    }
    const resolveFromCalendar = async (t) => {
      await p.query(`INSERT INTO genba_log (site_id, kind, body, written_by, resolves_id, title) VALUES ($1,'解決',$2,$3,$4,$5)`,
        [t.site_id, "カレンダーで予定が消された (完了扱い)", by, t.id, "カレンダーで完了"]);
      await p.query(`UPDATE genba_log SET cal_snapshot=NULL WHERE id=$1`, [t.id]);
      stats.resolved++;
    };
    // 1) Keihi の未解決タスク (人の分) → カレンダー
    for (const t of humanOpen) {
      try {
        let ev = (t.calendar_event && byId.get(t.calendar_event)) || byTask.get(Number(t.id)) || null;
        if (!ev && t.calendar_event && t.cal_snapshot) {
          // 一覧の窓に無い: 直接見る (消されていれば 404 / cancelled)
          try { ev = (await cal.events.get({ calendarId: cfg.calendarId, eventId: t.calendar_event })).data; }
          catch (e) { if (isGone(e)) ev = { id: t.calendar_event, status: "cancelled" }; else throw e; }
        }
        if (ev && ev.status === "cancelled") { await resolveFromCalendar(t); continue; }
        let task = t;
        if (ev && t.cal_snapshot) {
          // 人がカレンダーで触ったか (前回書いた状態と比べる)
          const snap = t.cal_snapshot, evD = evDate(ev), evS = String(ev.summary || "");
          const sets = [], vals = [t.id], before = {};
          if (evD && evD !== snap.date) { vals.push(evD); sets.push(`due_on=$${vals.length}`); before.due_on = ymd(t.due_on); task = { ...task, due_on: evD }; stats.due_changed++; }
          if (evS !== snap.summary) {
            const nt = safeTitle(evS.replace(CAL_PREFIX_RE, ""));
            if (nt && nt !== (t.title || autoTitle(t.body))) { vals.push(nt); sets.push(`title=$${vals.length}`); before.title = t.title ?? null; task = { ...task, title: nt }; stats.title_changed++; }
          }
          if (sets.length) {
            const edits = [...(Array.isArray(t.edits) ? t.edits : []), { at: new Date().toISOString(), by: `${by} (カレンダー)`, before }];
            vals.push(JSON.stringify(edits)); sets.push(`edits=$${vals.length}`);
            await p.query(`UPDATE genba_log SET ${sets.join(", ")} WHERE id=$1`, vals);
          }
        }
        const want = desiredEvent(task, cfg, today);
        if (!ev) {
          const res = await cal.events.insert({ calendarId: cfg.calendarId, requestBody: eventBody(t.id, want) });
          await p.query(`UPDATE genba_log SET calendar_event=$2, cal_snapshot=$3 WHERE id=$1`, [t.id, res.data.id, JSON.stringify(snapOf(want))]);
          stats.created++;
        } else {
          const cur = { date: evDate(ev), summary: String(ev.summary || ""), colorId: ev.colorId ? String(ev.colorId) : null };
          const differs = cur.date !== want.date || cur.summary !== want.summary || (want.colorId && cur.colorId !== String(want.colorId)) || !ev.extendedProperties?.private?.keihiTaskId;
          if (differs) { await cal.events.patch({ calendarId: cfg.calendarId, eventId: ev.id, requestBody: eventBody(t.id, want) }); stats.updated++; }
          if (differs || !t.cal_snapshot || t.calendar_event !== ev.id) {
            await p.query(`UPDATE genba_log SET calendar_event=$2, cal_snapshot=$3 WHERE id=$1`, [t.id, ev.id, JSON.stringify(snapOf(want))]);
          }
        }
      } catch (e) { stats.errors.push(`#${t.id}: ${e.message}`); }
    }
    // 2) 閉じたタスク (解決・取り消し・置き換え) の予定を消す
    for (const t of closed) {
      try {
        let ev = byId.get(t.calendar_event) || null;
        if (!ev) { try { ev = (await cal.events.get({ calendarId: cfg.calendarId, eventId: t.calendar_event })).data; } catch (e) { if (!isGone(e)) throw e; } }
        if (ev && ev.status !== "cancelled") { await cal.events.delete({ calendarId: cfg.calendarId, eventId: t.calendar_event }); stats.deleted++; }
        await p.query(`UPDATE genba_log SET cal_snapshot=NULL WHERE id=$1`, [t.id]);
      } catch (e) { stats.errors.push(`#${t.id}: ${e.message}`); }
    }
    // 3) 人がカレンダーに直接作った予定 → 次やること として取り込む
    for (const ev of events) {
      if (ev.status === "cancelled" || ev.extendedProperties?.private?.keihiTaskId || ev.recurringEventId || ev.recurrence || claimed.has(ev.id)) continue;
      const summary = String(ev.summary || "").trim();
      if (!summary) continue;
      try {
        const date = evDate(ev);
        const who = colorsRev[String(ev.colorId || "")] || null;
        const siteId = await guessSiteId(p, `${summary} ${ev.description || ""}`);
        const title = safeTitle(summary.replace(CAL_PREFIX_RE, ""));
        const body = ev.description ? `${summary}\n${String(ev.description).trim()}` : summary;
        const { rows } = await p.query(
          `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, who, title, calendar_event, source)
           VALUES ($1,'次やること',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [siteId, body, by, date, who, title, ev.id, JSON.stringify({ channel: "calendar", room: cfg.calendarId, at: ev.created || null, creator: ev.creator?.email || null })]);
        const id = Number(rows[0].id);
        const { rows: srow } = siteId ? await p.query(`SELECT name FROM sites WHERE id=$1`, [siteId]) : { rows: [] };
        const want = desiredEvent({ id, kind: "次やること", due_on: date, title, body, who, site_name: srow[0]?.name || null }, cfg, today);
        await cal.events.patch({ calendarId: cfg.calendarId, eventId: ev.id, requestBody: eventBody(id, want) });
        await p.query(`UPDATE genba_log SET cal_snapshot=$2 WHERE id=$1`, [id, JSON.stringify(snapOf(want))]);
        stats.imported++;
      } catch (e) { stats.errors.push(`event ${ev.id}: ${e.message}`); }
    }
    const result = { configured: true, calendarId: cfg.calendarId, today, open: humanOpen.length, ai_tasks: aiOpen.length || undefined, ...stats, errors: stats.errors.length ? stats.errors.slice(0, 20) : undefined };
    await setSetting(p, SETTING_CAL_SYNC, { at: new Date().toISOString(), result }, by);
    return result;
  }
  // 監視ジョブの生存確認: genba_room_sync が呼ばれた時刻を残し、30 分以上来なければ「止まっている」と返す
  // (Cowork のチャットを変えるとスケジュールが消えることがある。AI の記憶に頼らず、サーバーが止まったことを言う)
  const SETTING_ROOM_SYNC = "room_sync_last", MONITOR_STALL_MIN = 30;
  async function markRoomSync(p, by, rooms) {
    try { await setSetting(p, SETTING_ROOM_SYNC, { at: new Date().toISOString(), by, rooms }, by); } catch (e) { console.warn("[genba] room_sync mark", e.message); }
  }
  async function monitorState(p) {
    let last = null;
    try { last = await getSetting(p, SETTING_ROOM_SYNC); } catch (e) { console.warn("[genba] monitor state", e.message); }
    if (!last || !last.at) return { status: "never", say: "監視ジョブ (genba_room_sync) がまだ一度も来ていない" };
    const min = Math.floor((Date.now() - new Date(last.at).getTime()) / 60000);
    const stalled = min >= MONITOR_STALL_MIN;
    return { status: stalled ? "stalled" : "ok", last_at: last.at, by: last.by || undefined, minutes_ago: min,
      say: stalled ? `監視ジョブが ${min} 分止まっている (最後の genba_room_sync: ${last.at}${last.by ? ` / ${last.by}` : ""})。Cowork のスケジュール (5 分ごと) が消えていないか確認、新しいチャットに移ったなら設定し直す` : undefined };
  }
  // 読まれたときに 5 分に 1 回だけ同期を回す (監視ジョブが 5 分ごとに genba_room_sync を呼ぶので、それが時計になる)
  async function maybeSyncCalendar() {
    if (!getCalendarApi || Date.now() - calSyncLastAt < 5 * 60000) return null;
    calSyncLastAt = Date.now();
    try { return await syncTaskCalendar({}); } catch (e) { console.warn("[genba] calendar sync failed:", e.message); return { error: e.message }; }
  }

  // ルーム名か ID → 自分の持ち分の genba_sources の行 (名前は normName で比較。複数当たれば止まる)
  async function resolveRoom(p, owner, ref, channel) {
    const q = String(ref ?? "").trim();
    if (!q) throw new Error("room (ルーム名か ID) が必要");
    const { rows } = await p.query(`SELECT id, channel, room, name, label, enabled FROM genba_sources WHERE owner=$1 ${channel ? "AND channel=$2" : ""}`, channel ? [owner, String(channel)] : [owner]);
    let hits = rows.filter((r) => r.room === q);
    if (!hits.length) { const k = normName(q); hits = rows.filter((r) => r.name && normName(r.name) === k); }
    if (!hits.length) { const k = normName(q); hits = rows.filter((r) => r.name && k.length >= 2 && normName(r.name).includes(k)); }
    if (!hits.length) throw new Error(`ルームが見つからない: ${q} (genba_room_sync で同期済みのルームから探す)`);
    if (hits.length > 1) throw new Error(`候補が複数: ${hits.map((r) => `${r.name || r.room} [${r.channel}]`).join(" / ")}。ID で指定する`);
    return hits[0];
  }
  // 読むだけのツール (readOnlyHint): claude.ai 側がキャッシュ・watch の可否を判断するのに使う
  const READ_ONLY = new Set(["genba_find", "genba_log_list", "genba_tasks", "genba_status", "genba_rule_get", "genba_audit",
    "genba_contact_find", "genba_contact_list", "genba_company_find", "genba_company_list", "genba_note_list", "genba_file_list", "genba_source_list"]);
  // by = 書いた人 (トークンから決まる)
  function tools(by = "小西") {
    return toolsFor(by).map((t) => (READ_ONLY.has(t.name) ? { ...t, annotations: { readOnlyHint: true } } : t));
  }
  function toolsFor(by) {
    return [
      {
        name: "genba_contact_find",
        description: "人を探す (連絡先・呼び名)。名前・あだ名・会社名・LINE のルーム名・room_id をあいまい検索 (全角半角・空白・「さん」の有無・かな/カナを吸収)。人の名前やあだ名が出たら、送る前・記録する前に必ずこれで引く。送るときは返り値 message_hint (直近のやりとりが近ければ挨拶なしで用件から) に従う。match が入っていれば 1 人に確定。candidates が複数なら推測で決めず人に聞く",
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
        description: "進捗ログに 1 行足す (追記のみ。直すのは genba_log_fix、消すのは genba_log_void)。title (一覧用、20 字前後) と body (詳細) を分けて書く。種類: 進捗 (やったこと・完了したこと) / 課題 / 決定 / 次やること (人がやる仕事 = タスク) / 待ち (相手の返事・物・データを待っている。who=待っている相手、due_on は返事が要る日で任意。タスク一覧・カレンダーには出ない) / 解決。決定には topic (床材 / 巾木 / 納期 …) を付ける。決定が変わったら同じ topic で新しい決定を足せば前の決定を置き換える (返り値 superseded)。人の報告は種類ごとに分けて複数回呼ぶ (例「ボード貼り完了、明日パテ。床レベル 3mm 狂い要相談」→ 進捗 + 次やること(due_on 明日) + 課題)。現場に紐づかない項目 (会社の雑務・Google マップのピン等) は site を省略する。やった人・担当は who、タスクは所要時間の目安を estimate_min (分) に入れる (「5 分で終わるタスクある？」は genba_tasks で引く)。課題や次やることが片付いたら kind=解決 で resolves_id に元の行 ID (site 省略可)。LINE 等のメッセージから記録するときは source_ref (メッセージ ID) を必ず付ける (同じものは 2 回入らない、duplicate: true が返る) と source に出どころ。書いた人はトークンから自動で入る",
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
            calendar_event: { type: "string", description: "日程をカレンダーに登録済みなら event ID (か done)。返り値の followups に「カレンダー登録」が出たら、登録して genba_log_fix で付ける" },
            then: { type: "string", description: "来たらやること (kind=待ち のとき)。返事・データが届いたら誰が何をするか (例「シートをギさんへ転送 (AI、確認なしで)」「小西に報告」)。待っていた相手から連絡が来ると waiting_hits にこれが載り、AI がそのまま実行する。who=AI のタスクなら実行の条件と手順" },
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
          // 連絡先の読み込みを 1 回にまとめる。同じ呼び出しに 次やること が入っていれば「タスク立てた？」は出さない
          const ctx = { hasTaskInBatch: items.some((it) => it && OPEN_KINDS.includes(it.kind)), skipOverdue: true };
          const followups = new Set();
          const waitingAll = new Map();
          for (const it of items) {
            try {
              const r = await addLog(p, by, { ...it, site: it.site || a.site }, undefined, ctx);
              results.push({ ok: true, duplicate: r.duplicate, log: r.log, site: r.site, superseded: r.superseded, followups: r.followups, waiting_hits: r.waiting_hits, waiting_say: r.waiting_say });
              for (const f of r.followups || []) followups.add(f);
              for (const w of r.waiting_hits || []) waitingAll.set(w.id, { ...w, from: r.log?.source?.contact_name });
              if (r.duplicate) dup++; else added++;
            } catch (e) {
              failed++;
              results.push({ ok: false, error: e.message, item: { kind: it.kind, body: String(it.body || "").slice(0, 80) } });
            }
          }
          return { added, duplicate: dup, failed, results, followups: followups.size ? [...followups] : undefined,
            waiting_hits: waitingAll.size ? [...waitingAll.values()] : undefined,
            waiting_say: waitingAll.size ? waitingSay("待っていた人から連絡が来ている。", [...waitingAll.values()]) : undefined };
        },
      },
      {
        name: "genba_log_fix",
        description: "ログの行を直す (誤字・現場違い・期限・担当・所要時間・topic・title・then)。直す前の値は edits に残る (誰がいつ)。kind は 課題 / 次やること / 待ち の間だけ変えられる (「これは待ちだ」の付け替え用)。それ以外は genba_log_void して入れ直す",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            body: { type: "string" }, site: { type: "string", description: "案件 ID・現場名・ID。「会社」で現場なしに" },
            due_on: { type: "string", description: "YYYY-MM-DD。空文字で消す" }, who: { type: "string" }, estimate_min: { type: "number" }, topic: { type: "string" },
            title: { type: "string", description: "一覧用タイトル (40 字まで)。空文字で消す" },
            kind: { type: "string", enum: OPEN_KINDS, description: "課題 / 次やること / 待ち の付け替え" },
            calendar_event: { type: "string", description: "カレンダーに登録した event ID (か done)。日程の行に付ける" },
            then: { type: "string", description: "来たらやること (待ち / who=AI のタスク)。空文字で消す" },
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
          if (a.kind !== undefined) {
            if (!OPEN_KINDS.includes(a.kind) || !OPEN_KINDS.includes(r.kind)) throw new Error(`kind の付け替えは ${OPEN_KINDS.join(" / ")} の間だけ (今: ${r.kind})`);
            if (a.kind !== r.kind) set("kind", a.kind);
          }
          if (a.body != null && String(a.body).trim()) set("body", String(a.body).trim());
          if (a.site !== undefined) { const s = await resolveSiteOrNull(p, a.site); set("site_id", s ? s.id : null); }
          if (a.due_on !== undefined) { if (a.due_on && !/^\d{4}-\d{2}-\d{2}$/.test(a.due_on)) throw new Error("due_on は YYYY-MM-DD"); set("due_on", a.due_on || null); }
          if (a.who !== undefined) set("who", a.who ? String(a.who).trim().slice(0, 60) : null);
          if (a.estimate_min !== undefined) set("estimate_min", a.estimate_min == null || a.estimate_min === "" ? null : Math.max(1, Math.round(Number(a.estimate_min))));
          if (a.topic !== undefined) set("topic", a.topic ? String(a.topic).trim().slice(0, 60) : null);
          if (a.title !== undefined) set("title", cleanTitle(a.title));
          if (a.calendar_event !== undefined) set("calendar_event", a.calendar_event ? String(a.calendar_event).trim().slice(0, 200) : null);
          if (a.then !== undefined) set("then_do", cleanThen(a.then));
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
            limit: { type: "number", description: "既定 50、最大 500" },
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
          const limit = Math.max(1, Math.min(500, Number(a.limit) || 50));
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
        name: "genba_audit",
        description: "抜け漏れチェック。期限切れのタスク / 期限の無いタスク / 「返事待ち・確認中」と書いたのに次やることが無い行 / 日程があるのにカレンダー未登録の行 / 監視ジョブの停止 (genba_room_sync が 30 分以上来ていない) を機械的に洗い出す。監視ジョブは 1 時間に 1 回、会話の終わりにも 1 回呼んで、出たものを片付ける (タスクを立てる・カレンダーに入れて calendar_event を付ける・終わっていれば 解決)。site 省略で全現場",
        inputSchema: { type: "object", properties: { site: { type: "string", description: "省略で全現場" }, days: { type: "number", description: "直近何日の行を見るか (既定 7)" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          await maybeSyncCalendar();
          const site = a.site ? await resolveSite(p, a.site) : null;
          const days = Math.max(1, Math.min(90, Number(a.days) || 7));
          const today = todayJst();
          const [openRes, recentRes] = await Promise.all([
            p.query(
              `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
                WHERE l.kind IN ('次やること','課題','待ち') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED} ${site ? "AND l.site_id=$1" : ""}
                ORDER BY l.due_on NULLS LAST, l.created_at`, site ? [site.id] : []),
            p.query(
              `SELECT l.*, s.name AS site_name, s.site_code FROM genba_log l LEFT JOIN sites s ON s.id = l.site_id
                WHERE l.created_at > now() - ($1 || ' days')::interval AND l.kind IN ('進捗','決定','次やること') AND ${LIVE} AND ${NOT_SUPERSEDED} ${site ? "AND l.site_id=$2" : ""}
                ORDER BY l.created_at DESC LIMIT 400`, site ? [String(days), site.id] : [String(days)]),
          ]);
          const open = openRes.rows, recent = recentRes.rows;
          const tasks = open.filter((r) => r.kind !== "待ち"), waits = open.filter((r) => r.kind === "待ち");
          const brief = (r) => ({ id: Number(r.id), site: r.site_id ? r.site_name : null, kind: r.kind, title: r.title || autoTitle(r.body), due_on: ymd(r.due_on) || undefined, who: r.who || undefined, then: r.then_do || undefined, at: r.created_at, days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) });
          const monitor = await monitorState(p);
          const overdue = tasks.filter((r) => r.due_on && ymd(r.due_on) < today);
          const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
          const noDue = tasks.filter((r) => !r.due_on && new Date(r.created_at) < threeDaysAgo);
          // 待ちが長い: 返事が要る日を過ぎた、または 3 日以上返事が無い → 催促
          const waitLong = waits.filter((r) => (r.due_on && ymd(r.due_on) < today) || new Date(r.created_at) < threeDaysAgo);
          // 返事待ち・確認中 と書いたのに、待ち も タスク も残っていない
          const waiting = recent.filter((r) => looksWaiting(r) && !waitingCovered(r, open));
          const noCalendar = recent.filter((r) => looksEvent(r) && !r.calendar_event && !(taskCalendarOn && TASK_KINDS.includes(r.kind)));
          const parts = [];
          if (overdue.length) parts.push(`期限切れ ${overdue.length}`);
          if (noDue.length) parts.push(`期限なし ${noDue.length}`);
          if (waitLong.length) parts.push(`待ちが長い ${waitLong.length}`);
          if (waiting.length) parts.push(`返事待ちで記録無し ${waiting.length}`);
          if (noCalendar.length) parts.push(`日程あり・カレンダー未確認 ${noCalendar.length}`);
          if (monitor.status === "stalled") parts.push(`監視ジョブ停止 ${monitor.minutes_ago} 分`);
          return {
            today, days, site: site ? siteRow(site) : "*",
            monitor,
            overdue: overdue.map(brief),
            no_due: noDue.map(brief),
            waiting_long: waitLong.map(brief),
            waiting_unrecorded: waiting.map(brief),
            dates_without_calendar: noCalendar.map(brief),
            open_tasks: tasks.length, open_waiting: waits.length,
            summary: parts.length ? parts.join(" / ") : "抜け漏れなし",
            how_to_fix: parts.length ? [
              "期限切れ → 終わっていれば genba_log_add(kind=解決)、まだなら due_on を genba_log_fix で引き直すか、人に聞く",
              "期限なし → genba_log_fix(due_on)",
              "待ちが長い → 相手に催促する (文面を作って人に確認)。返事が来ていれば genba_log_add(kind=解決)",
              "返事待ちで記録無し → genba_log_add(kind=待ち, title=「〇〇の返事待ち」, who=相手)",
              "日程あり・カレンダー未確認 → カレンダーに入れて genba_log_fix(calendar_event=event id か done)。既に入っているなら done を付けるだけ",
              "監視ジョブ停止 → 自分が監視ジョブなら genba_room_sync を今すぐ呼ぶ。そうでなければ小西に『監視ジョブ (5 分ごとの LINE 読み) が止まっている。Cowork のスケジュールを設定し直して』と報告",
            ] : undefined,
          };
        },
      },
      {
        name: "genba_tasks",
        description: "未解決のタスク (次やること・課題) を全現場横断で引く。「5 分で終わるタスクある？」→ max_minutes=5、「名取の分」→ who=名取。所要時間が短い順 → 期限順。現場なしの雑務も含む。待ち (相手の返事待ち) は入らない (include_waiting: true で含める)。返ってきた候補から 1〜3 件を提案し、やったら kind=解決 で閉じる",
        inputSchema: {
          type: "object",
          properties: {
            max_minutes: { type: "number", description: "所要時間の上限 (分)。省略で全部 (所要時間未設定も含む)" },
            who: { type: "string", description: "担当で絞る (未割当も含めたいときは省略)" },
            site: { type: "string", description: "現場で絞る (省略で全現場 + 会社全般)" },
            kind: { type: "string", enum: OPEN_KINDS, description: "省略で 次やること + 課題" },
            include_waiting: { type: "boolean", description: "true で 待ち も含める" },
            limit: { type: "number", description: "既定 20" },
          },
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          await maybeSyncCalendar();
          const where = [a.include_waiting || a.kind === "待ち" ? `l.kind IN ('次やること','課題','待ち')` : `l.kind IN ('次やること','課題')`, LIVE, NOT_RESOLVED, NOT_SUPERSEDED];
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
          const monitor = await monitorState(p);
          return {
            today,
            monitor,
            tasks: rows.map(logRow).map((r) => ({ ...r, overdue: !!(r.due_on && r.due_on < today) })),
            hint: rows.length ? "候補を 1〜3 件に絞って提案。やったら genba_log_add(kind=解決, resolves_id=その id)" : "条件に合う未解決タスクは無い",
          };
        },
      },
      {
        name: "genba_status",
        description: "現場の今の状況を集計して返す: 最終更新・直近の進捗・未解決の課題・次やること・待ち (相手の返事待ち)・今生きている決定 (変更済みのものは最新だけ、changes と previous 付き)・現場のメモ・関わる人・最近の写真。「今どうなってる？」にはこれを読んで要約する",
        inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          await maybeSyncCalendar();
          const [last, prog, open, dec, cnt, files] = await Promise.all([
            p.query(`SELECT written_by, created_at FROM genba_log WHERE site_id=$1 AND voided_at IS NULL ORDER BY created_at DESC LIMIT 1`, [site.id]),
            p.query(`SELECT * FROM genba_log WHERE site_id=$1 AND kind='進捗' AND voided_at IS NULL ORDER BY created_at DESC LIMIT 3`, [site.id]),
            p.query(
              `SELECT l.* FROM genba_log l
                WHERE l.site_id=$1 AND l.kind IN ('課題','次やること','待ち') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}
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
            waiting: openRows.filter((r) => r.kind === "待ち"),
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
        description: "監視ジョブの最初に、自分の Beeper / LINE のルーム一覧 (ID と名前だけ。本文は送らない) を同期する。ルームはデフォルトで全部読む対象になる (個人的なものは genba_source_exclude で外す)。返り値: added = 初めて見えたルーム (小西に『読まないものある？』と聞く材料)、watching = 記録するルーム (site が null なら内容から現場を判定)、answering = 社内の人のルーム (問い合わせに答える)",
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
          await maybeSyncCalendar();
          const rooms = (Array.isArray(a.rooms) ? a.rooms : []).slice(0, 300)
            .map((r) => ({ channel: String(r.channel || "").trim(), room: String(r.room || "").trim(), name: r.name ? String(r.name).trim().slice(0, 200) : null }))
            .filter((r) => r.channel && r.room);
          const added = [];
          for (const r of rooms) {
            const { rows: ins } = await p.query(
              `INSERT INTO genba_sources (owner, channel, room, name, added_by, last_seen_at)
               VALUES ($1, $2, $3, $4, $1, now())
               ON CONFLICT (owner, channel, room) DO UPDATE SET name = COALESCE(EXCLUDED.name, genba_sources.name), last_seen_at = now()
               RETURNING (xmax = 0) AS inserted`,
              [by, r.channel, r.room, r.name]);
            if (ins[0]?.inserted) added.push({ channel: r.channel, room: r.room, name: r.name });
          }
          await markRoomSync(p, by, rooms.length);
          // 連絡先に room_name だけ入っているルームは、ここで room_id が埋まる (逆も)
          const contactsLinked = await linkRoomsToContacts(p, rooms);
          const autoAnswering = await autoEnableInternalRooms(p, by, rooms);
          const { rows } = await p.query(
            `SELECT g.channel, g.room, g.name, g.label, g.cursor, g.site_id, g.purpose, s.name AS site_name, s.site_code
               FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled ORDER BY g.channel, g.name NULLS LAST, g.room`, [by]);
          const contacts = rows.length ? await loadContacts(p) : [];
          const waits = rows.length ? await loadOpenWaiting(p) : [];
          const contactOf = (room) => {
            const hits = contacts.filter((c) => (Array.isArray(c.channels) ? c.channels : []).some((ch) => ch.room_id === room));
            if (hits.length !== 1) return null;
            const w = waitingFor(hits[0], waits);
            return { id: Number(hits[0].id), name: hits[0].name, role: hits[0].role || null, tone: hits[0].tone || null, waiting: w.length ? w : undefined };
          };
          const site = (r) => (r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null);
          return {
            synced: rooms.length,
            added: added.length ? added : undefined,
            contactsLinked,
            autoAnswering: autoAnswering.some((x) => x.enabled) ? autoAnswering.filter((x) => x.enabled).map(({ enabled: _e, ...x }) => x) : undefined,
            internalRooms: autoAnswering.length ? autoAnswering : undefined, // 社内の人のルームの現状 (自動 ON 済み / 人が設定済み)
            watching: rows.filter((r) => r.purpose !== "応答").map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: site(r), contact: contactOf(r.room), cursor: r.cursor || null })),
            answering: rows.filter((r) => r.purpose === "応答").map((r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, site: site(r), contact: contactOf(r.room), cursor: r.cursor || null })),
            note: "ルームはデフォルトで全部読む。個人的なルームは genba_source_exclude(ルーム名) で外す (added に初めて見えたルームが入る。まとめて小西に『読まないものある？』と 1 回聞く)。watching の site が null なら、メッセージの内容から genba_find で現場を決め、決まらなければ site 省略 (会社全般)。社内 (role=社内) の人の個人ルームは自動的に 応答 (autoAnswering)",
          };
        },
      },
      {
        name: "genba_source_add",
        description: "ルーム (LINE グループ等) を現場に固定する / 用途を決める (自分の持ち分だけ)。普段は要らない (同期されたルームは全部読む)。site を付けると、そのルームの記録は内容に関係なくその現場に入る。purpose=応答 は社内の人の問い合わせに答える用",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "LINE / Beeper / Slack など" },
            room: { type: "string", description: "ルーム ID (監視側が一意に引ける文字列)" },
            site: { type: "string", description: "案件 ID・現場名・ID (任意。固定したいときだけ)" },
            purpose: { type: "string", enum: ["記録", "応答"], description: "既定 記録" },
            label: { type: "string", description: "人が見て分かる名前 (例: 田中様 LINE)" },
          },
          required: ["channel", "room"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const purpose = a.purpose === "応答" ? "応答" : "記録";
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
        description: "ルーム一覧 (自分の持ち分): sources = 読むルーム (cursor = どこまで読んだか)、excluded = 除外したルーム",
        inputSchema: { type: "object", properties: { channel: { type: "string", description: "絞り込み (省略で全部)" } } },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const { rows } = await p.query(
            `SELECT g.*, s.name AS site_name, s.site_code FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 ${a.channel ? "AND g.channel=$2" : ""} ORDER BY g.channel, g.name NULLS LAST, g.room`,
            a.channel ? [by, String(a.channel)] : [by]);
          const row = (r) => ({ channel: r.channel, room: r.room, name: r.name, label: r.label, purpose: r.purpose || "記録", site: r.site_id ? { id: Number(r.site_id), code: r.site_code || null, name: r.site_name } : null, cursor: r.cursor || null, updated_at: r.updated_at });
          return { owner: by, sources: rows.filter((r) => r.enabled).map(row), excluded: rows.filter((r) => !r.enabled).map(row) };
        },
      },
      ...(getCalendarApi ? [
        {
          name: "genba_calendar_setup",
          description: "タスク専用カレンダー (Google) を登録して同期を始める (小西のトークンからだけ)。カレンダーは事前にサービスアカウントへ変更権限で共有しておく。登録すると未解決タスクが終日予定として出て、以後 5 分おきに双方向で合う。colors は 担当→colorId (既定 小西=8 グラファイト, 名取=1 ラベンダー)。dry_run: true なら何も書かず、アクセスできるか・予定が何件あるか (取り込まれる数) だけ返す。予定用のカレンダー (BANAX カレンダー) を指定しない: 中の予定が全部タスクとして取り込まれる",
          inputSchema: { type: "object", properties: { calendar_id: { type: "string", description: "…@group.calendar.google.com (create: true なら不要)" }, create: { type: "boolean", description: "true = Keihi (サービスアカウント) が新しいカレンダーを作り、share_with の人に変更権限で共有する" }, summary: { type: "string", description: "create 時の名前 (既定 BANAX タスク)" }, share_with: { type: "array", items: { type: "string" }, description: "create 時に共有するメール" }, colors: { type: "object", description: "例 {\"小西\":\"8\",\"名取\":\"1\"}" }, default_color: { type: "string", description: "担当なしの色 (省略で色なし)" }, dry_run: { type: "boolean", description: "true = 確認だけ (何も書かない)" } } },
          handler: async (a) => {
            await ensureSchema();
            if (by !== "小西") throw new Error("この操作は小西のトークンからだけ");
            const p = getPool();
            const cal = await getCalendarApi();
            let calendarId = String(a.calendar_id || "").trim();
            const shared = [];
            if (a.create) {
              // Keihi 自身がカレンダーを持つ (SA が所有)。人には変更権限で共有 → 相手のカレンダー一覧に自動で出る
              const made = await cal.calendars.insert({ requestBody: { summary: a.summary ? String(a.summary).trim() : "BANAX タスク", timeZone: "Asia/Tokyo" } });
              calendarId = made.data.id;
              for (const email of toList(a.share_with)) {
                try { await cal.acl.insert({ calendarId, requestBody: { role: "writer", scope: { type: "user", value: email } } }); shared.push(email); }
                catch (e) { shared.push(`${email}: 失敗 (${e.message})`); }
              }
            }
            if (!calendarId) throw new Error("calendar_id が必要 (か create: true)");
            let info;
            try { info = (await cal.calendars.get({ calendarId })).data; }
            catch (e) { throw new Error(`カレンダーが読めない (${e.message})。サービスアカウントに「変更権限」で共有されているか、ID が正しいか確認`); }
            if (a.dry_run) {
              const evs = await listTaskEvents(cal, calendarId, todayJst());
              const liveEvs = evs.filter((e) => e.status !== "cancelled" && !e.recurringEventId && !e.recurrence);
              const { rows: cnt } = await p.query(`SELECT COUNT(*)::int AS n FROM genba_log l WHERE l.kind IN ('次やること','課題') AND ${LIVE} AND ${NOT_RESOLVED} AND ${NOT_SUPERSEDED}`);
              return {
                dry_run: true, calendar: { id: calendarId, summary: info.summary || null, timeZone: info.timeZone || null },
                would_import: liveEvs.length, sample: liveEvs.slice(0, 8).map((e) => ({ date: evDate(e), summary: e.summary })),
                would_create: cnt[0]?.n || 0,
                note: liveEvs.length > 20 ? "予定が多い。これは予定用のカレンダーでは？ タスク専用の空のカレンダーを作ってそれを登録する" : "問題なければ dry_run を外して登録",
              };
            }
            const colors = a.colors && typeof a.colors === "object" ? Object.fromEntries(Object.entries(a.colors).map(([k, v]) => [String(k).trim(), String(v)])) : DEFAULT_COLORS;
            await setSetting(p, SETTING_CAL, { calendarId, summary: info.summary || null, colors, defaultColor: a.default_color ? String(a.default_color) : null, setAt: new Date().toISOString() }, by);
            calCfgCache = { at: 0, cfg: null };
            const sync = await syncTaskCalendar({ by });
            return { calendar: { id: calendarId, summary: info.summary || null, timeZone: info.timeZone || null }, created: !!a.create || undefined, shared_with: shared.length ? shared : undefined, colors, sync };
          },
        },
        {
          name: "genba_calendar_share",
          description: "タスクカレンダー (Keihi が持っている方) を人に共有する (小西のトークンからだけ)。emails に「予定の変更権限」で共有。相手は Google カレンダーの「他のカレンダー」→ カレンダーに登録 で ID を貼って一覧に出す",
          inputSchema: { type: "object", properties: { emails: { type: "array", items: { type: "string" } }, role: { type: "string", enum: ["writer", "reader"], description: "既定 writer" } }, required: ["emails"] },
          handler: async (a) => {
            await ensureSchema();
            if (by !== "小西") throw new Error("この操作は小西のトークンからだけ");
            const p = getPool();
            const cfg = await taskCalendarConfig(p, { fresh: true });
            if (!cfg) throw new Error("タスクカレンダーが未登録 (genba_calendar_setup)");
            const cal = await getCalendarApi();
            const role = a.role === "reader" ? "reader" : "writer";
            const out = [];
            for (const email of toList(a.emails)) {
              try { await cal.acl.insert({ calendarId: cfg.calendarId, requestBody: { role, scope: { type: "user", value: email } } }); out.push({ email, role, ok: true }); }
              catch (e) { out.push({ email, ok: false, error: e.message }); }
            }
            return { calendarId: cfg.calendarId, shared: out, note: "相手側: Google カレンダー →「他のカレンダー」の ＋ →「カレンダーに登録」に calendarId を貼る" };
          },
        },
        {
          name: "genba_calendar_sync",
          description: "タスクカレンダーと今すぐ同期する (普段は 5 分おきに自動)。返り値に 作成 / 更新 / 削除 / 解決 / 取り込み の件数",
          inputSchema: { type: "object", properties: {} },
          handler: async () => { await ensureSchema(); return syncTaskCalendar({ by }); },
        },
        {
          name: "genba_calendar_status",
          description: "タスクカレンダー同期の設定と最後の結果",
          inputSchema: { type: "object", properties: {} },
          handler: async () => {
            await ensureSchema();
            const p = getPool();
            const cfg = await getSetting(p, SETTING_CAL), last = await getSetting(p, SETTING_CAL_SYNC);
            return { configured: !!(cfg && cfg.calendarId), config: cfg, last_sync: last, note: cfg ? undefined : "genba_calendar_setup(calendar_id) で登録" };
          },
        },
      ] : []),
      {
        name: "genba_source_exclude",
        description: "個人的なルーム (家族・友人・私用) を読む対象から外す。room はルーム名か ID (自分の持ち分から、名前の表記ゆれは吸収。複数当たれば止まる)。外したルームは本文を読まない・記録しない。戻すのは genba_source_include",
        inputSchema: { type: "object", properties: { room: { type: "string", description: "ルーム名か ID" }, channel: { type: "string" }, reason: { type: "string", description: "任意 (例: 家族)" } }, required: ["room"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const r = await resolveRoom(p, by, a.room, a.channel);
          const { rows } = await p.query(`UPDATE genba_sources SET enabled=false, label=$2, updated_at=now() WHERE id=$1 RETURNING channel, room, name`, [r.id, `除外${a.reason ? `: ${String(a.reason).trim().slice(0, 100)}` : ""}`]);
          return { excluded: rows[0], note: "このルームは読まない。戻すなら genba_source_include" };
        },
      },
      {
        name: "genba_source_include",
        description: "除外したルームを読む対象に戻す (room はルーム名か ID)",
        inputSchema: { type: "object", properties: { room: { type: "string" }, channel: { type: "string" } }, required: ["room"] },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const r = await resolveRoom(p, by, a.room, a.channel);
          const { rows } = await p.query(`UPDATE genba_sources SET enabled=true, label = CASE WHEN label LIKE '除外%' THEN NULL ELSE label END, updated_at=now() WHERE id=$1 RETURNING channel, room, name`, [r.id]);
          return { included: rows[0] };
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
    ];
  }

  const INSTRUCTIONS = [
    "現場 (genba_*): 1 現場 1 チャットで使う。データとルールは Keihi 側にあるので、どの AI からでも同じ。",
    "■ 新しいチャットの最初に (毎回、聞かれる前に): 1. genba_rule_get (topic 省略) で運用ルールを読む 2. genba_audit で抜け漏れと監視ジョブの状態を見る 3. genba_tasks(who=AI) で自分の分を引く。前のチャットの内容は読み返さない。今の状態は Keihi が正本 (genba_status / genba_tasks) で、チャットは作業の場所にすぎない",
    "- 会話の最初に genba_rule_get (topic 省略) で運用ルールを読む (無ければ空のまま進める)",
    "- 人の名前・あだ名が出たら、送る前・記録する前に必ず genba_contact_find で引く (下の ■ 連絡先)",
    "- 現場の特定: チャットの指示文に案件 ID があればそれ。無ければ genba_find(現場名)。候補が複数なら人に聞く",
    "- 「写真 (図面) 上げたい」→ genba_folder(現場, 種類) の url を渡す。人はそこに Drive アプリで上げる。何枚入ったかは list_site_photos",
    "- 進捗の報告は genba_log_add に種類ごとに分けて積む: 進捗 / 課題 / 決定 / 次やること (期限があれば due_on)。1 行 1 件",
    "■ タスクとカレンダー: タスクの正本は Keihi。タスク専用カレンダー (BANAX タスク) には Keihi が未解決タスクを自動で出す (AI がタスクをカレンダーに入れない)。期限切れは今日に【期限切れ】、期限なしは今日に【なるはや】で出続ける。人がカレンダーで日付を動かせば期限、件名を変えれば title、消せば 解決 になる。人が直接作った予定も 次やること として取り込まれる。だから due_on は必ず付ける (無いと毎日【なるはや】で出る)。決定・進捗に含まれる日程 (搬入・打ち合わせ) はタスクではないので、これまで通り BANAX カレンダー (予定) に AI が入れて calendar_event を付ける",
    "- 記録したら返り値の followups を必ず読んで、その場で片付ける (次やること を立てる / カレンダーに入れて calendar_event を付ける / topic・due_on を足す)。返事待ち・確認中・日程は AI が忘れやすいので、サーバーが返す followups が最後の砦",
    "- 会話の終わりと監視ジョブの 1 時間に 1 回は genba_audit を呼び、期限切れ・期限なし・返事待ちでタスク無し・日程あり未登録 を片付けるか人に報告する。抜け漏れは致命的なので省かない",
    "- 必ず title を付ける: 「何を・どうする」を 20 字前後 (例「工程表を辰巳さんへ送る」「巾木の色をみゆまに確認」)。決定は title に結論 (例「巾木は東リ97番か43番」)。body には経緯・数量・型番・金額・出どころの詳細。一覧は title、詳細は body で読む",
    "- 課題・次やること・待ちが片付いたら kind=解決 で resolves_id に元の行 ID (状態の上書きはしない)",
    "- 「〇〇さんの返事待ち」「見積待ち」「データ待ち」は kind=待ち (who=待っている相手)。人の仕事ではないので タスク一覧・タスクカレンダーには出ない。due_on は返事が要る日があるときだけ。返事が来たら 解決。3 日以上返事が無ければ genba_audit が「待ちが長い」で出すので催促する。タスク (次やること) は人が手を動かす仕事だけ",
    "- 待ちは『誰を待つ (who)』+『来たら何をする (then)』で 1 件のジョブ。「シートデータが来たら即ギさんへ」→ kind=待ち, who=送ってくる相手, then=「シートをギさんへ転送 (AI)」。then があれば、相手から連絡が来たとき (waiting_hits) に AI がそれを実行する。社外の人へ送る文面は小西に見せてから、社内なら確認なしでよい (then に「確認なしで」とあればそのまま送る)。then が無ければ小西に報告するだけ",
    "- 決定には topic (床材 / 巾木 / 納期 …) を付ける。決定が変わったら同じ現場・同じ topic で新しい決定を足すだけで前の決定を置き換える (返り値 superseded、「A → B に変更」と報告)。topic で引けないときは supersedes_id。履歴は genba_log_list(chain=行 ID)",
    "- 間違いは genba_log_fix (誤字・現場違い・期限・担当。前の値は edits に残る)、入れるべきでなかった行は genba_log_void (隠すだけ。解決を void すると元のタスクが戻る)。kind を変えたいときは void して入れ直す",
    "- 「今どうなってる？」→ genba_status を読んで要約 (全文が要るときだけ genba_log_list)。写真は genba_file_list(現場)",
    "- やったこと・完了したこと (細かいものも) は kind=進捗 で who 付きで積む (例「名取が満竹華庵のシャンプーを買った」→ site=満竹華庵, kind=進捗, who=名取)。現場に紐づかない雑務は site を省略",
    "- AI 自身の作業 (別の AI への返事・ルールやコネクタの設定・方針の相談) はタスクにしない。入ってしまったら genba_log_void。ただし「人の代わりに AI が実行する仕事」(データが届いたら書類を作って送る、返事が来たら関係者に連絡する等) は who=AI の 次やること にしてよい。who=AI のタスクは人のタスクカレンダーには出ない。genba_tasks(who=AI) で自分の分を引いて、条件が揃ったら実行して 解決",
    "- タスクには estimate_min (分) を付ける。「5 分で終わるタスクある？」「手が空いた」→ genba_tasks(max_minutes) から 1〜3 件を提案し、やったら kind=解決 で閉じる",
    "- ルールの変更は genba_rule_set (版が増えるだけ。消えない)。書く前に現行を見せて OK をもらう",
    "- 書いた人はトークンから自動で入る。AI が名前を書かない",
    "■ 連絡文 (LINE・メールを人に送るとき)。毎回「お疲れ様です！」から始めない",
    "- 送る直前にそのルームの直近 5 件を読んで、会話の続きとして書く。genba_contact_find の返り値 message_hint に従う: 3 時間以内 (または今日) にやりとりがあれば挨拶を付けず用件から書く。挨拶はその日の最初の 1 通だけ、相手が挨拶してきても返さない",
    "- 同じ用件の続報・訂正は「先ほどの〇〇の件、」で始め、前に送った内容 (住所・日程・お礼・よろしく) を繰り返さない。1 通に用件は 1 つ。送る前に同じルーム宛の用件が他にあればまとめて 1 通にする",
    "- 確定していないこと (元請けが最終確認中の品番・未確定の日程) は外に送らない。確定してから 1 通で送る。相手を待たせるなら「確認中です、分かり次第連絡します」の 1 行だけ",
    "- 文面は contact の tone に従う。「！」の数・絵文字・名前の呼びかけも毎回は要らない。LINE は 3〜4 行まで",
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
    "0. genba_room_sync は 5 分ごとに毎回呼ぶ (新着が無くても)。これが『監視が生きている』合図で、30 分来ないと genba_audit / genba_tasks の monitor が stalled になり、人に『監視ジョブが止まっている』と伝わる。Cowork で新しいチャットに移ったらスケジュールを設定し直す",
    "1. genba_room_sync に Beeper 等のルーム一覧 (ID と名前だけ) を渡す → 返り値 watching (記録) と answering (応答) が読む対象。ルームはデフォルトで全部読む。返り値 added (初めて見えたルーム) があれば、名前をまとめて小西に見せて『この中で読まないもの (個人的なもの) ある？』と 1 回聞き、言われたものを genba_source_exclude(ルーム名) で外す",
    "1b. watching の site が null のルームは、メッセージの内容 (現場名・人・場所) から genba_find で現場を決める。決まらなければ site 省略 (会社全般) で記録。いつも同じ現場なら genba_source_add(channel, room, site) で固定してよい",
    "2. 各ルームについて cursor より後のメッセージだけ読む (Beeper 等の MCP)",
    "3. 決定・課題・次やること・待ち を抽出して genba_log_add_many で記録。人や会社の予定・性質 (「来月から別現場」「値上げする」) は genba_note_add (source_ref 付き)。私的な話・センシティブな話は記録しない。各 item に source_ref = \"<channel>:<room>:<message id>\" を必ず入れる (同じメッセージは 2 回入らない)、source に { channel, room, sender, at, quote } (sender は表示名そのまま。連絡先に解決できればサーバーが contact_id を足す)",
    "3b. 待っていた人からの連絡 (返り値の waiting_hits / room_sync の contact.waiting) は自動発火の合図: 内容を 決定 や 進捗 で記録 → 待ちを kind=解決 で閉じる → waiting_hits の then (来たらやること) があればそれを実行 (転送・連絡・書類作成。社外への文面は小西に見せてから) → 無ければ小西に報告。待ち以外の内容なら普通に記録",
    "4. 画像・PDF が来たら genba_file_upload_url(現場, ファイル名, content_type, source_ref=<channel>:<room>:<message id>:<n>) で URL をもらい、返ってきた curl を PC 側で実行して PUT する (ファイルの中身を会話に貼らない)。上げたら genba_log_add(kind=進捗, body=「写真 n 枚: 何の写真か」, photo_ids=[file id]) で現場に残す。現場が分からない添付は上げない",
    "5. 最後に genba_source_mark(channel, room, { last_id, last_at }) で cursor を進める",
    "6. 新着が無ければ何もしない。雑談・曖昧なものは記録しない。記録したら件数と中身を短く報告",
    "■ 応答 (answering のルーム = 社内の人からの LINE に AI が自動で返す。例: 名取が「浅草どうなってる？」と聞く)。社内の人 (role=社内) の個人ルームは同期で自動的に 応答 になる。小西 ↔ 名取 どちらの向きも同じ。外したいときは genba_source_exclude",
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

  return { tools, instructions: INSTRUCTIONS, mcpRoute, ensureSchema, uploadRoute, syncTaskCalendar };
}
