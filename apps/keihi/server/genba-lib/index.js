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
    at: r.created_at,
  });

  // 1 行追記 (genba_log_add / genba_log_add_many 共通)。source_ref があれば重複は 2 回入らない
  async function addLog(p, by, a, siteRowCache) {
    const site = siteRowCache || await resolveSite(p, a.site);
    if (!LOG_KINDS.includes(a.kind)) throw new Error(`kind は ${LOG_KINDS.join(" / ")}`);
    const body = String(a.body || "").trim();
    if (!body) throw new Error("body が空");
    let resolvesId = null;
    if (a.kind === "解決") {
      resolvesId = Number(a.resolves_id);
      if (!Number.isInteger(resolvesId)) throw new Error("kind=解決 には resolves_id (元の課題/次やることの行 ID) が必要");
      const { rows: orig } = await p.query(`SELECT id, kind, site_id FROM genba_log WHERE id=$1`, [resolvesId]);
      if (!orig.length || Number(orig[0].site_id) !== Number(site.id)) throw new Error(`行 ${resolvesId} はこの現場のログに無い`);
      if (!["課題", "次やること"].includes(orig[0].kind)) throw new Error(`行 ${resolvesId} は ${orig[0].kind} なので解決の対象ではない`);
    }
    const due = a.due_on && /^\d{4}-\d{2}-\d{2}$/.test(a.due_on) ? a.due_on : null;
    if (a.due_on && !due) throw new Error("due_on は YYYY-MM-DD");
    const photos = Array.isArray(a.photo_ids) ? a.photo_ids.filter(Boolean).map(String).slice(0, 50) : null;
    const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
    const source = a.source && typeof a.source === "object" ? a.source : null;
    const { rows } = await p.query(
      `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, resolves_id, photo_ids, source_ref, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [site.id, a.kind, body, by, due, resolvesId, photos ? JSON.stringify(photos) : null, sourceRef, source ? JSON.stringify(source) : null]
    );
    if (rows.length) return { site: { id: Number(site.id), code: site.site_code || null, name: site.name }, log: logRow(rows[0]), duplicate: false };
    // source_ref が既にある = 同じメッセージを前に記録済み
    const { rows: ex } = await p.query(`SELECT * FROM genba_log WHERE source_ref=$1`, [sourceRef]);
    return { site: { id: Number(site.id), code: site.site_code || null, name: site.name }, log: ex[0] ? logRow(ex[0]) : null, duplicate: true };
  }

  // by = 書いた人 (トークンから決まる)
  function tools(by = "小西") {
    return [
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
        description: "進捗ログに 1 行足す (追記のみ、消えない)。種類: 進捗 / 課題 / 決定 / 次やること / 解決。人の報告は種類ごとに分けて複数回呼ぶ (例「ボード貼り完了、明日パテ。床レベル 3mm 狂い要相談」→ 進捗 + 次やること(due_on 明日) + 課題)。課題や次やることが片付いたら kind=解決 で resolves_id に元の行 ID。LINE 等のメッセージから記録するときは source_ref (メッセージ ID) を必ず付ける (同じものは 2 回入らない、duplicate: true が返る) と source に出どころ。書いた人はトークンから自動で入る",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID" },
            kind: { type: "string", enum: LOG_KINDS },
            body: { type: "string", description: "本文 (短く。1 行 1 件。決定は型番・数量・金額を省略しない)" },
            due_on: { type: "string", description: "期限 YYYY-MM-DD (次やること・課題)" },
            resolves_id: { type: "number", description: "kind=解決 のとき、解決した元の行 ID" },
            photo_ids: { type: "array", items: { type: "string" }, description: "関連する Drive の写真ファイル ID (list_site_photos の file_id)" },
            source_ref: { type: "string", description: "出どころの一意キー (例 LINE:<room>:<message id>)。同じ source_ref は 2 回記録されない" },
            source: { type: "object", description: "出どころ { channel, room, sender, at, quote } など自由" },
          },
          required: ["site", "kind", "body"],
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
          for (const it of items) {
            try {
              const r = await addLog(p, by, { ...it, site: it.site || a.site });
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
        description: "進捗ログの一覧 (新しい順)。days で期間、kind で種類を絞る。普段は genba_status で足りる",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string" },
            days: { type: "number", description: "既定 30" },
            kind: { type: "string", enum: LOG_KINDS },
            limit: { type: "number", description: "既定 50、最大 200" },
          },
          required: ["site"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
          const days = Math.max(1, Math.min(3650, Number(a.days) || 30));
          const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
          const { rows } = await p.query(
            `SELECT * FROM genba_log WHERE site_id=$1 AND created_at > now() - ($2 || ' days')::interval
               ${a.kind ? "AND kind=$4" : ""}
              ORDER BY created_at DESC LIMIT $3`,
            a.kind ? [site.id, String(days), limit, a.kind] : [site.id, String(days), limit]
          );
          return { site: siteRow(site), days, logs: rows.map(logRow) };
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
          const { rows } = await p.query(
            `SELECT DISTINCT ON (topic) topic, version, body, updated_by, created_at
               FROM genba_rules ${a.topic ? "WHERE topic=$1" : ""}
              ORDER BY topic, version DESC`, a.topic ? [String(a.topic)] : []);
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
          const { rows } = await p.query(
            `SELECT g.channel, g.room, g.name, g.label, g.cursor, g.site_id, s.name AS site_name, s.site_code
               FROM genba_sources g LEFT JOIN sites s ON s.id = g.site_id
              WHERE g.owner=$1 AND g.enabled AND g.site_id IS NOT NULL ORDER BY g.channel, g.name NULLS LAST, g.room`, [by]);
          return {
            synced: rooms.length,
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
    "- 現場の特定: チャットの指示文に案件 ID があればそれ。無ければ genba_find(現場名)。候補が複数なら人に聞く",
    "- 「写真 (図面) 上げたい」→ genba_folder(現場, 種類) の url を渡す。人はそこに Drive アプリで上げる。何枚入ったかは list_site_photos",
    "- 進捗の報告は genba_log_add に種類ごとに分けて積む: 進捗 / 課題 / 決定 / 次やること (期限があれば due_on)。1 行 1 件、短く",
    "- 課題・次やることが片付いたら kind=解決 で resolves_id に元の行 ID (状態の上書きはしない)",
    "- 「今どうなってる？」→ genba_status を読んで要約 (全文が要るときだけ genba_log_list)",
    "- ルールの変更は genba_rule_set (版が増えるだけ。消えない)。書く前に現行を見せて OK をもらう",
    "- 書いた人はトークンから自動で入る。AI が名前を書かない",
    "■ 監視ジョブ (Cowork 等で 5 分ごとに LINE などを読んで自動記録するとき)",
    "1. genba_room_sync に Beeper 等のルーム一覧 (ID と名前だけ) を渡す → 返り値 watching が読む対象 (ON/OFF は画面 /genba/watch.html)。watching に無いルームは読まない",
    "2. 各ルームについて cursor より後のメッセージだけ読む (Beeper 等の MCP)",
    "3. 決定・課題・次やること を抽出して genba_log_add_many で記録。各 item に source_ref = \"<channel>:<room>:<message id>\" を必ず入れる (同じメッセージは 2 回入らない)、source に { channel, room, sender, at, quote }",
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
