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
    due_on: r.due_on ? String(r.due_on).slice(0, 10) : null,
    resolves_id: r.resolves_id ? Number(r.resolves_id) : null,
    photo_ids: Array.isArray(r.photo_ids) && r.photo_ids.length ? r.photo_ids : undefined,
    at: r.created_at,
  });

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
        description: "進捗ログに 1 行足す (追記のみ、消えない)。種類: 進捗 / 課題 / 決定 / 次やること / 解決。人の報告は種類ごとに分けて複数回呼ぶ (例「ボード貼り完了、明日パテ。床レベル 3mm 狂い要相談」→ 進捗 + 次やること(due_on 明日) + 課題)。課題や次やることが片付いたら kind=解決 で resolves_id に元の行 ID。書いた人はトークンから自動で入る",
        inputSchema: {
          type: "object",
          properties: {
            site: { type: "string", description: "案件 ID・現場名・ID" },
            kind: { type: "string", enum: LOG_KINDS },
            body: { type: "string", description: "本文 (短く。1 行 1 件)" },
            due_on: { type: "string", description: "期限 YYYY-MM-DD (次やること・課題)" },
            resolves_id: { type: "number", description: "kind=解決 のとき、解決した元の行 ID" },
            photo_ids: { type: "array", items: { type: "string" }, description: "関連する Drive の写真ファイル ID (list_site_photos の file_id)" },
          },
          required: ["site", "kind", "body"],
        },
        handler: async (a) => {
          await ensureSchema();
          const p = getPool();
          const site = await resolveSite(p, a.site);
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
          const { rows } = await p.query(
            `INSERT INTO genba_log (site_id, kind, body, written_by, due_on, resolves_id, photo_ids)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [site.id, a.kind, body, by, due, resolvesId, photos ? JSON.stringify(photos) : null]
          );
          return { site: { id: Number(site.id), code: site.site_code || null, name: site.name }, log: logRow(rows[0]) };
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

  return { tools, instructions: INSTRUCTIONS, mcpRoute, ensureSchema };
}
