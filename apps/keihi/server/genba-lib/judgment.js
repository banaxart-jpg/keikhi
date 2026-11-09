// 判断ログ (genba_judgment_*): 小西の判断の癖を貯めて、AI が「小西ならこう判断する」と予想して答え合わせし、
// 当たり続けた種類の連絡から順に、確認なしで送れるようにする。機械学習はしない。過去の判断を検索して似た例を並べるだけ。
//
//   judgment_log     … 1 判断 = 1 行 (場面・AI の予想・小西の実際の判断・一致したか)
//   judgment_policy  … 種類 (category) ごとの運用モード: 確認あり / 事後報告
//
// 昇格 (確認あり → 事後報告) は目安を stats が「昇格候補」と出すだけ。切り替えは小西の OK で policy_set。
// 降格 (事後報告 → 確認あり) は事後報告中の種類で 不一致 が 1 件出たら、resolve が自動で戻す。
// 小西だけが見られる判断 (is_private) は、小西以外のトークンでは一覧・検索・統計・点検のどれにも出さない。
// genba-lib から ensureSchema(p) / tools(by) / policyList(p) / unanswered(p, by) を呼ぶ (既存のツールの動きは変えない)

export const OWNER = "小西";
export const STD_CATEGORIES = ["日程の返事", "お礼・了解", "社内への伝言", "業者への依頼", "金額・支払い", "仕様・範囲", "書類", "その他"];
const RESULTS = ["一致", "部分一致", "不一致"]; // 小西の答えとして渡せる値 (DB にはほかに 未回答 が入る)
const MODES = ["確認あり", "事後報告"];
const DEFAULT_THRESHOLD = 0.95, PROMOTE_DAYS = 30, PROMOTE_STREAK = 20; // 昇格の目安 (初期値)
const MIN_SIM = 0.12, SCAN_ROWS = 600, TEXT_MAX = 4000, CATEGORY_MAX = 40;

const jstDay = (d) => new Date(new Date(d).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const num = (v) => (v == null ? null : Number(v));
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

// ── 似ている度 (日本語は空白で切れないので 2 文字ずつ): 検索語が相手の文にどれだけ含まれるか + dice を半分ずつ
const grams = (s) => {
  const t = String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　、。,.!！?？「」『』()（）\-_/・:：]/g, "");
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  if (t.length === 1) g.add(t);
  return g;
};
export function similarity(query, text) {
  const Q = grams(query), T = grams(text);
  if (!Q.size || !T.size) return 0;
  let n = 0; for (const x of Q) if (T.has(x)) n++;
  const cover = n / Q.size, dice = (2 * n) / (Q.size + T.size);
  const plain = String(text || "").normalize("NFKC").toLowerCase().includes(String(query || "").normalize("NFKC").toLowerCase().trim()) && String(query || "").trim().length >= 2;
  return plain ? 1 : 0.5 * cover + 0.5 * dice;
}
// 新しい判断ほど重く (半減期 60 日。0.5〜1.0 倍)
const recency = (at) => 0.5 + 0.5 * Math.pow(0.5, Math.max(0, (Date.now() - new Date(at).getTime()) / 86400000) / 60);

export function createJudgment({ getPool, ready, resolveSite }) {
  // ready = genba 側の ensureSchema (判断ログの DDL もそこから呼ばれる)。各ツールは動く前に待つ
  async function ensureSchema(p) {
    await p.query(`
      CREATE TABLE IF NOT EXISTS judgment_log (
        id             BIGSERIAL PRIMARY KEY,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        site_id        BIGINT REFERENCES sites(id) ON DELETE SET NULL,   -- 現場に紐づかない雑務は NULL
        category       TEXT NOT NULL,                                    -- 日程の返事 / お礼・了解 / … 新しい種類も入れてよい
        situation      TEXT NOT NULL,                                    -- 場面 (相手・何を言われたか・何を決める必要があるか)
        source_ref     TEXT,                                             -- LINE / Plaud / メールなどの出どころ ID。同じものは 2 回入らない
        ai_prediction  TEXT,                                             -- AI の予想 (送る文面案を含めてよい)
        ai_confidence  NUMERIC(4,3) CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
        basis_ids      BIGINT[] NOT NULL DEFAULT '{}',                   -- 予想の根拠にした過去の judgment_log.id
        decision       TEXT,                                             -- 小西が実際にどう判断したか (回答前は NULL)
        result         TEXT NOT NULL DEFAULT '未回答' CHECK (result IN ('一致','部分一致','不一致','未回答')),
        reason         TEXT,                                             -- 違ったときの小西の一言
        related_log_id BIGINT REFERENCES genba_log(id) ON DELETE SET NULL,
        auto_sent      BOOLEAN NOT NULL DEFAULT false,                   -- 確認なしで AI が送ったか
        is_private     BOOLEAN NOT NULL DEFAULT false,                   -- 小西だけが見られる判断 (社員の AI には出さない)
        "by"           TEXT NOT NULL,                                    -- 書いた人 (トークンから)
        resolved_at    TIMESTAMPTZ,                                      -- 答え合わせをした時刻 (連続一致・最後の不一致の並びに使う)
        resolved_by    TEXT
      )`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS judgment_log_source_ref_uq ON judgment_log (source_ref) WHERE source_ref IS NOT NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS judgment_log_cat_idx ON judgment_log (category, created_at DESC)`);
    await p.query(`CREATE INDEX IF NOT EXISTS judgment_log_open_idx ON judgment_log (created_at) WHERE result = '未回答'`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS judgment_policy (
        category    TEXT PRIMARY KEY,
        mode        TEXT NOT NULL DEFAULT '確認あり' CHECK (mode IN ('確認あり','事後報告')),
        threshold   NUMERIC(4,3) NOT NULL DEFAULT 0.95 CHECK (threshold >= 0 AND threshold <= 1),   -- 昇格の一致率の目安
        changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        changed_by  TEXT NOT NULL,
        note        TEXT
      )`);
  }

  // 小西以外のトークンには is_private を出さない (一覧・検索・統計・点検の共通の条件)
  const VIS = (by) => (by === OWNER ? "" : "AND NOT j.is_private");

  const out = (r, by) => ({
    id: Number(r.id), at: r.created_at, category: r.category,
    site: r.site_name || undefined,
    situation: r.situation, ai_prediction: r.ai_prediction || undefined, ai_confidence: num(r.ai_confidence) ?? undefined,
    basis_ids: Array.isArray(r.basis_ids) && r.basis_ids.length ? r.basis_ids.map(Number) : undefined,
    decision: r.decision ?? undefined, result: r.result, reason: r.reason || undefined,
    related_log_id: r.related_log_id != null ? Number(r.related_log_id) : undefined,
    auto_sent: r.auto_sent || undefined, private: by === OWNER && r.is_private ? true : undefined,
    source_ref: r.source_ref || undefined, by: r["by"], resolved_at: r.resolved_at || undefined,
  });
  const SELECT = `SELECT j.*, s.name AS site_name FROM judgment_log j LEFT JOIN sites s ON s.id = j.site_id`;

  async function modeOf(p, category) {
    const { rows } = await p.query(`SELECT mode, threshold, changed_at FROM judgment_policy WHERE category=$1`, [category]);
    return rows[0] ? { mode: rows[0].mode, threshold: Number(rows[0].threshold), changed_at: rows[0].changed_at } : { mode: "確認あり", threshold: DEFAULT_THRESHOLD, changed_at: null };
  }

  // 同じ種類・似た場面の、答えの付いた過去の判断。recent=true は新しい順 (add の材料)、false は 似ている度 × 新しさ の順 (検索)
  async function findSimilar(p, by, { category, site_id, query, limit, recent, excludeId }) {
    const where = ["j.decision IS NOT NULL"], params = [];
    if (category) { params.push(category); where.push(`j.category = $${params.length}`); }
    if (site_id != null) { params.push(site_id); where.push(`j.site_id = $${params.length}`); }
    if (excludeId != null) { params.push(excludeId); where.push(`j.id <> $${params.length}`); }
    const { rows } = await p.query(`${SELECT} WHERE ${where.join(" AND ")} ${VIS(by)} ORDER BY j.created_at DESC, j.id DESC LIMIT ${SCAN_ROWS}`, params);
    if (!query) return rows.slice(0, limit).map((r) => out(r, by));
    const scored = rows.map((r) => ({ r, s: similarity(query, `${r.situation} ${r.decision || ""}`) })).filter((x) => x.s >= MIN_SIM);
    if (recent) return scored.slice(0, limit).map((x) => ({ ...out(x.r, by), similarity: Math.round(x.s * 100) / 100 }));
    scored.sort((a, b) => b.s * recency(b.r.created_at) - a.s * recency(a.r.created_at) || b.r.id - a.r.id);
    return scored.slice(0, limit).map((x) => ({ ...out(x.r, by), similarity: Math.round(x.s * 100) / 100 }));
  }

  // 種類ごとの件数・一致率・連続一致・最後の不一致 (+ 昇格候補)
  async function statsFor(p, by, { days = PROMOTE_DAYS, category } = {}) {
    const params = []; let cat = "";
    if (category) { params.push(category); cat = `AND j.category = $1`; }
    const { rows } = await p.query(
      `SELECT j.id, j.category, j.result, j.auto_sent, j.created_at, j.resolved_at FROM judgment_log j WHERE true ${cat} ${VIS(by)}
        ORDER BY COALESCE(j.resolved_at, j.created_at) DESC, j.id DESC LIMIT 5000`, params);
    const { rows: pol } = await p.query(`SELECT category, mode, threshold FROM judgment_policy`);
    const polBy = new Map(pol.map((r) => [r.category, r]));
    const since = Date.now() - days * 86400000;
    const by_cat = new Map();
    for (const r of rows) {
      const c = by_cat.get(r.category) || { category: r.category, resolved: [], open: 0 };
      if (r.result === "未回答") c.open++; else c.resolved.push(r);
      by_cat.set(r.category, c);
    }
    const list = [...by_cat.values()].map((c) => {
      const win = c.resolved.filter((r) => new Date(r.resolved_at || r.created_at).getTime() >= since);
      const matched = win.filter((r) => r.result === "一致").length, partial = win.filter((r) => r.result === "部分一致").length, mismatched = win.filter((r) => r.result === "不一致").length;
      let streak = 0; for (const r of c.resolved) { if (r.result === "一致") streak++; else break; } // 新しい答えから、一致が続く数
      const lastMis = c.resolved.find((r) => r.result === "不一致");
      const pl = polBy.get(c.category), mode = pl ? pl.mode : "確認あり", threshold = pl ? Number(pl.threshold) : DEFAULT_THRESHOLD;
      const rate = win.length ? matched / win.length : null;
      const candidate = mode === "確認あり" && streak >= PROMOTE_STREAK && rate != null && rate >= threshold;
      const needs = mode !== "確認あり" ? undefined : candidate ? undefined
        : [streak < PROMOTE_STREAK ? `連続一致あと ${PROMOTE_STREAK - streak} 件` : null, rate == null ? `直近 ${days} 日の答えが無い` : rate < threshold ? `直近 ${days} 日の一致率 ${Math.round(rate * 100)}% → ${Math.round(threshold * 100)}% 以上` : null].filter(Boolean).join(" / ");
      return {
        category: c.category, mode, total: win.length, matched, partial, mismatched,
        match_rate: rate == null ? null : Math.round(rate * 1000) / 1000,
        streak, last_mismatch_on: lastMis ? jstDay(lastMis.resolved_at || lastMis.created_at) : null,
        unanswered: c.open, auto_sent: win.filter((r) => r.auto_sent).length || undefined,
        promotion_candidate: candidate || undefined,
        promotion_note: candidate ? `昇格候補: 直近 ${days} 日の一致率 ${Math.round(rate * 100)}% (${win.length} 件)、連続 ${streak} 件一致。小西の OK が取れたら genba_judgment_policy_set(category=${c.category}, mode=事後報告)` : needs,
      };
    });
    list.sort((a, b) => b.total - a.total || b.unanswered - a.unanswered || a.category.localeCompare(b.category));
    return list;
  }

  // genba_rule_get (topic 省略) に載せる: 標準の種類 + 設定のある種類のモード
  async function policyList(p) {
    const { rows } = await p.query(`SELECT category, mode, threshold, changed_at, changed_by, note FROM judgment_policy ORDER BY category`);
    const by = new Map(rows.map((r) => [r.category, r]));
    const mk = (category) => { const r = by.get(category); return { category, mode: r ? r.mode : "確認あり", threshold: r ? Number(r.threshold) : DEFAULT_THRESHOLD, changed_at: r ? r.changed_at : undefined, changed_by: r ? r.changed_by : undefined, note: r && r.note ? r.note : undefined }; };
    return [...STD_CATEGORIES.map(mk), ...rows.filter((r) => !STD_CATEGORIES.includes(r.category)).map((r) => mk(r.category))];
  }

  // genba_audit に載せる: 24 時間以上「未回答」のままの判断
  async function unanswered(p, by, hours = 24) {
    const { rows } = await p.query(
      `SELECT j.id, j.category, j.situation, j.auto_sent, j."by", j.created_at FROM judgment_log j
        WHERE j.result = '未回答' AND j.created_at < now() - ($1::int || ' hours')::interval ${VIS(by)} ORDER BY j.created_at LIMIT 30`, [hours]);
    return rows.map((r) => ({ id: Number(r.id), category: r.category, situation: clip(r.situation, 60), hours: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 3600000), by: r["by"], auto_sent: r.auto_sent || undefined }));
  }

  const str = { type: "string" };
  function tools(by) {
    const needOwner = () => { if (by !== OWNER) throw new Error("この操作は小西のトークンからだけ"); };
    return [
      {
        name: "genba_judgment_add",
        description: "小西の判断が要る場面を 1 件登録する (判断ログ)。送る前に呼んで、AI の予想 (送る文面案つき) と確信度 0〜1 を残す。返り値: id、この種類の今のモード (mode: 確認あり = 送る前に小西の OK / 事後報告 = 確認なしで送って 1 行で報告)、similar = 同じ種類で似た場面の過去の判断 (答えの付いたもの、新しい順に最大 5 件。予想の材料)。similar を読んで予想を直してから動く。新しい種類 (category) は自由に足してよい。標準: 日程の返事 / お礼・了解 / 社内への伝言 / 業者への依頼 / 金額・支払い / 仕様・範囲 / 書類 / その他。同じ source_ref は 2 回入らない。確認なしで送ったときは auto_sent: true。is_private: true は小西だけが見られる判断 (個人的な連絡)",
        inputSchema: {
          type: "object", required: ["category", "situation", "ai_prediction", "ai_confidence"],
          properties: {
            category: { ...str, description: "判断の種類 (例: 日程の返事)" },
            situation: { ...str, description: "場面: 相手・何を言われたか・何を決める必要があるか" },
            ai_prediction: { ...str, description: "AI の予想 (「たぶんこう判断する」。送る文面案があれば含める)" },
            ai_confidence: { type: "number", description: "0〜1" },
            basis_ids: { type: "array", items: { type: "integer" }, description: "予想の根拠にした過去の judgment の id" },
            site: { ...str, description: "案件 ID・現場名。現場に紐づかない雑務は省略" },
            source_ref: { ...str, description: "出どころの ID (例 LINE:<room>:<message id> / Plaud:<id> / メール ID)" },
            is_private: { type: "boolean", description: "小西だけが見られる判断 (社員の AI には出さない)。小西のトークンからだけ" },
            auto_sent: { type: "boolean", description: "確認なしで AI が送った (事後報告のモード)" },
            related_log_id: { type: "integer", description: "結びつける genba_log の行 ID" },
          },
        },
        handler: async (a) => {
          const p = a.__pool;
          const category = String(a.category || "").trim(), situation = String(a.situation || "").trim(), pred = String(a.ai_prediction || "").trim();
          if (!category) throw new Error("category が必要");
          if ([...category].length > CATEGORY_MAX) throw new Error(`category は ${CATEGORY_MAX} 字まで`);
          if (!situation) throw new Error("situation が必要");
          if (situation.length > TEXT_MAX || pred.length > TEXT_MAX) throw new Error(`situation / ai_prediction は ${TEXT_MAX} 字まで`);
          if (!pred) throw new Error("ai_prediction が必要 (予想が無いときも「予想なし。〇〇が分からない」と書く)");
          const conf = Number(a.ai_confidence);
          if (a.ai_confidence == null || a.ai_confidence === "" || !Number.isFinite(conf) || conf < 0 || conf > 1) throw new Error("ai_confidence は 0〜1");
          if (a.is_private && by !== OWNER) throw new Error("is_private は小西のトークンからだけ");
          const basis = Array.isArray(a.basis_ids) ? a.basis_ids.slice(0, 10).map(Number) : [];
          if (basis.some((x) => !Number.isInteger(x))) throw new Error("basis_ids は judgment の id (整数) の配列");
          const site = a.site ? await resolveSite(p, a.site) : null;
          let related = null;
          if (a.related_log_id != null && a.related_log_id !== "") {
            related = Number(a.related_log_id);
            const { rows } = await p.query(`SELECT 1 FROM genba_log WHERE id=$1`, [related]);
            if (!Number.isInteger(related) || !rows.length) throw new Error(`related_log_id: 行 ${a.related_log_id} が無い`);
          }
          const sourceRef = a.source_ref ? String(a.source_ref).trim().slice(0, 300) : null;
          const { rows } = await p.query(
            `INSERT INTO judgment_log (site_id, category, situation, source_ref, ai_prediction, ai_confidence, basis_ids, related_log_id, auto_sent, is_private, "by")
             VALUES ($1,$2,$3,$4,$5,$6,$7::bigint[],$8,$9,$10,$11)
             ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
            [site ? site.id : null, category, situation, sourceRef, pred, conf, basis, related, !!a.auto_sent, !!a.is_private, by]);
          if (!rows.length) {
            const { rows: ex } = await p.query(`${SELECT} WHERE j.source_ref = $1`, [sourceRef]);
            const visible = ex[0] && (by === OWNER || !ex[0].is_private);
            return visible ? { duplicate: true, id: Number(ex[0].id), judgment: out(ex[0], by) } : { duplicate: true };
          }
          const id = Number(rows[0].id);
          const m = await modeOf(p, category);
          const similar = await findSimilar(p, by, { category, query: situation, limit: 5, recent: true, excludeId: id });
          return {
            id, category, mode: m.mode,
            how: m.mode === "事後報告" ? "確認なしで送ってよい種類。送ったらすぐ小西に 1 行で報告 (auto_sent は true にして登録する)" : "送る前に、予想と文面案を小西に見せて OK を取る",
            similar, note: similar.length ? undefined : "この種類で似た過去の判断はまだ無い (予想は一般論になる)",
          };
        },
      },
      {
        name: "genba_judgment_resolve",
        description: "小西の答えを記録する (答え合わせ、小西のトークンからだけ)。decision = 小西が実際にどう判断したか、result = 一致 / 部分一致 / 不一致 (AI の予想と比べて)、reason = 違ったときの理由の一言 (「電話でこう話した」など)。事後報告のモードの種類で 不一致 を記録すると、サーバーが自動でその種類を 確認あり に戻す (返り値 demoted)。直す場合はもう一度呼べば上書きされる",
        inputSchema: {
          type: "object", required: ["id", "decision", "result"],
          properties: {
            id: { type: "integer" }, decision: { ...str, description: "小西が実際にした判断" },
            result: { type: "string", enum: RESULTS }, reason: { ...str, description: "違ったときの理由 (小西の一言)" },
            related_log_id: { type: "integer", description: "結びつける genba_log の行 ID" },
          },
        },
        handler: async (a) => {
          needOwner();
          const p = a.__pool;
          const id = Number(a.id);
          if (!Number.isInteger(id)) throw new Error("id は数値");
          const decision = String(a.decision || "").trim();
          if (!decision) throw new Error("decision が必要");
          if (decision.length > TEXT_MAX) throw new Error(`decision は ${TEXT_MAX} 字まで`);
          if (!RESULTS.includes(a.result)) throw new Error(`result は ${RESULTS.join(" / ")}`);
          let related = undefined;
          if (a.related_log_id != null && a.related_log_id !== "") {
            related = Number(a.related_log_id);
            const { rows } = await p.query(`SELECT 1 FROM genba_log WHERE id=$1`, [related]);
            if (!Number.isInteger(related) || !rows.length) throw new Error(`related_log_id: 行 ${a.related_log_id} が無い`);
          }
          const { rows } = await p.query(
            `UPDATE judgment_log SET decision=$2, result=$3, reason=$4, resolved_at=now(), resolved_by=$5, related_log_id=COALESCE($6, related_log_id)
              WHERE id=$1 RETURNING *`,
            [id, decision, a.result, a.reason ? String(a.reason).trim().slice(0, 1000) : null, by, related ?? null]);
          if (!rows.length) throw new Error(`判断 ${id} が無い`);
          const row = rows[0];
          // 降格: 事後報告中の種類で 不一致 が 1 件出たら 確認あり に戻す
          const pol = await modeOf(p, row.category);
          let demoted;
          if (pol.mode === "事後報告" && a.result === "不一致") {
            await p.query(`UPDATE judgment_policy SET mode='確認あり', changed_at=now(), changed_by=$2, note=$3 WHERE category=$1`, [row.category, "自動 (降格)", `判断 #${id} が 不一致 だったので確認ありに戻した`]);
            demoted = { category: row.category, from: "事後報告", to: "確認あり", because: id };
          }
          const stats = (await statsFor(p, by, { category: row.category }))[0];
          const { rows: full } = await p.query(`${SELECT} WHERE j.id=$1`, [id]);
          return {
            judgment: out(full[0], by), mode: demoted ? "確認あり" : pol.mode, demoted,
            note: demoted ? `事後報告 → 確認あり に戻した (${row.category})。この種類は送る前に小西の OK を取る` : undefined,
            promotion_candidate: stats && stats.promotion_candidate ? stats.promotion_note : undefined,
          };
        },
      },
      {
        name: "genba_judgment_similar",
        description: "過去の判断 (答えの付いたもの) を検索する。query = 場面の言葉 (全文のあいまい検索)、category / site で絞る。query があれば 似ている度 × 新しさ の順 (新しい判断ほど上に出る)、無ければ新しい順。返り値の decision / reason が小西の実際の判断。予想を作るときの材料にする。小西以外のトークンには is_private の判断は出ない",
        inputSchema: { type: "object", properties: { query: str, category: str, site: str, limit: { type: "integer", description: "既定 10、最大 30" } } },
        handler: async (a) => {
          const p = a.__pool;
          const site = a.site ? await resolveSite(p, a.site) : null;
          const limit = Math.min(30, Math.max(1, Number(a.limit) || 10));
          const rows = await findSimilar(p, by, { category: a.category ? String(a.category).trim() : null, site_id: site ? site.id : null, query: a.query ? String(a.query).trim() : null, limit, recent: false });
          return { count: rows.length, judgments: rows };
        },
      },
      {
        name: "genba_judgment_stats",
        description: "判断ログの統計。種類 (category) ごとに、直近 days 日 (既定 30) の件数・一致率・部分一致・不一致と、全期間の直近の連続一致数・最後の不一致の日・未回答の数・今のモード。昇格の目安 (初期値): 直近 30 日の一致率 95% 以上かつ連続 20 件一致 → promotion_candidate / promotion_note に「昇格候補」と出る。勝手には切り替えない。小西に「〇〇の連絡は確認なしで送ってよさそう」と聞いて、OK なら genba_judgment_policy_set。小西以外のトークンには is_private の判断は数えない",
        inputSchema: { type: "object", properties: { days: { type: "integer", description: "既定 30" }, category: str } },
        handler: async (a) => {
          const p = a.__pool;
          const days = Math.max(1, Math.min(3650, Number(a.days) || PROMOTE_DAYS));
          const categories = await statsFor(p, by, { days, category: a.category ? String(a.category).trim() : undefined });
          const cands = categories.filter((c) => c.promotion_candidate).map((c) => c.category);
          return { days, promote_rule: `直近 ${PROMOTE_DAYS} 日の一致率 ${DEFAULT_THRESHOLD * 100}% 以上 かつ 連続 ${PROMOTE_STREAK} 件一致 (一致率は種類ごとに policy_set の threshold で変えられる)`, categories, promotion_candidates: cands.length ? cands : undefined };
        },
      },
      {
        name: "genba_judgment_policy_get",
        description: "種類 (category) ごとの運用モードの一覧。確認あり = 今まで通り送る前に小西の OK を取る / 事後報告 = AI が確認なしで送り、送ったらすぐ小西に 1 行で報告する (不一致が 1 件出ると自動で 確認あり に戻る)。設定の無い種類は 確認あり。genba_rule_get (topic 省略) にも同じ一覧が付く",
        inputSchema: { type: "object", properties: {} },
        handler: async (a) => ({ policies: await policyList(a.__pool), default_mode: "確認あり" }),
      },
      {
        name: "genba_judgment_policy_set",
        description: "種類 (category) の運用モードを切り替える (小西のトークンからだけ。小西が OK したときだけ呼ぶ。昇格候補が出ても勝手に切り替えない)。mode = 確認あり / 事後報告。threshold = その種類の昇格の一致率の目安 0〜1 (既定 0.95)。事後報告のあいだに 不一致 が 1 件出ると自動で 確認あり に戻る",
        inputSchema: { type: "object", required: ["category", "mode"], properties: { category: str, mode: { type: "string", enum: MODES }, threshold: { type: "number", description: "0〜1 (既定 0.95)" } } },
        handler: async (a) => {
          needOwner();
          const p = a.__pool;
          const category = String(a.category || "").trim();
          if (!category) throw new Error("category が必要");
          if ([...category].length > CATEGORY_MAX) throw new Error(`category は ${CATEGORY_MAX} 字まで`);
          if (!MODES.includes(a.mode)) throw new Error(`mode は ${MODES.join(" / ")}`);
          let th = null;
          if (a.threshold != null && a.threshold !== "") { th = Number(a.threshold); if (!Number.isFinite(th) || th < 0 || th > 1) throw new Error("threshold は 0〜1"); }
          const { rows } = await p.query(
            `INSERT INTO judgment_policy (category, mode, threshold, changed_by, note) VALUES ($1,$2,COALESCE($3::numeric, $5::numeric),$4,$6)
             ON CONFLICT (category) DO UPDATE SET mode=EXCLUDED.mode, threshold=COALESCE($3::numeric, judgment_policy.threshold), changed_at=now(), changed_by=$4, note=EXCLUDED.note
             RETURNING category, mode, threshold, changed_at`,
            [category, a.mode, th, by, DEFAULT_THRESHOLD, a.mode === "事後報告" ? "小西の OK で事後報告にした" : "確認ありにした"]);
          const r = rows[0];
          return { category: r.category, mode: r.mode, threshold: Number(r.threshold), changed_at: r.changed_at,
            how: r.mode === "事後報告" ? "以後この種類は確認なしで送り、送ったらすぐ小西に 1 行で報告する (auto_sent: true で登録)。不一致が 1 件出ると自動で 確認あり に戻る" : "以後この種類は送る前に小西の OK を取る" };
        },
      },
    ].map((t) => ({ ...t, handler: async (a) => { await ready(); return t.handler({ ...a, __pool: getPool() }); } }));
  }

  const instructions = [
    "■ 判断ログ (genba_judgment_*)。小西の判断の癖を貯めて、当たり続けた種類の連絡から順に確認なしで送れるようにする。機械学習ではなく、過去の判断を並べて似た例から予想する",
    "- 小西の判断が要る連絡 (返事・依頼・金額・日程など) が来たら、送る前に genba_judgment_add(category, situation, ai_prediction (送る文面案つき), ai_confidence 0〜1) を呼ぶ。返り値の similar (同じ種類の似た過去の判断) を読んで予想を直し、返り値の mode に従う",
    "- mode=確認あり: 予想と文面案を小西に見せて OK を取る。mode=事後報告: 確認なしで送り (auto_sent=true)、送ったらすぐ小西に 1 行で報告する。事後報告で送ったものは、小西の反応で resolve する (反応が無いまま 24 時間たったものは genba_audit が出すので、まとめて「問題なかった？」と 1 回聞く)",
    "- 小西が答えたら genba_judgment_resolve(id, decision=実際の判断, result=一致 / 部分一致 / 不一致, reason=違った理由の一言)。事後報告の種類で 不一致 が出ると、サーバーが自動で 確認あり に戻す (返り値 demoted)",
    "- 過去の判断は genba_judgment_similar(query, category) で探す。genba_judgment_stats に「昇格候補」が出たら、小西に「〇〇の連絡は確認なしで送ってよさそう (一致率・連続一致)」と 1 回聞く。OK なら genba_judgment_policy_set。勝手には切り替えない。モードの一覧は genba_rule_get の judgment_modes にもある",
    "- 小西だけが見られる判断 (個人的な連絡) は is_private=true で登録する。社員のトークンの一覧・検索・統計には出ない",
  ];

  return { ensureSchema, tools, policyList, unanswered, instructions, statsFor };
}
