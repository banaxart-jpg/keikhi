// SNS 発信 MCP (claude.ai カスタムコネクタ)。X / note の投稿と過去投稿・数字の記録だけを持つ薄い層。
// 文面づくり・口調・NG ルール・分析は各自の Claude (プロジェクト指示) 側でやる。画面は持たない。
// 接続 URL: https://<keihi-api の Cloud Run URL>/api/sns/mcp/<token>  (token は sns-config の tokens)
//
// DB (Cloud SQL keikhi-db / keihi): sns_posts / sns_post_stats / sns_account_stats
// 伸び率を出せるよう、数字は上書きせず「記録した時点の値」を積み上げる。
// 毎朝の記録: Cloud Scheduler → POST /api/internal/sns/snapshot (x-tick-secret)

import { accountsForToken, getSnsConfig } from "./config.js";
import { xPost, xDelete, xMe, xUserTweets, xTweetsByIds, hasLink } from "./x.js";
import { noteRss } from "./note.js";

export function createSns({ getPool, createMcpHandler }) {
  const pool = () => {
    const p = getPool();
    if (!p) throw new Error("DB not configured");
    return p;
  };

  let schemaReady = false;
  async function ensureSnsSchema() {
    if (schemaReady) return;
    const p = pool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS sns_posts (
        id BIGSERIAL PRIMARY KEY,
        account TEXT NOT NULL,
        platform TEXT NOT NULL,            -- 'x' | 'note'
        external_id TEXT,                  -- X の tweet id / note の記事キー (下書きは NULL)
        status TEXT NOT NULL,              -- 'posted' | 'deleted' | 'draft'
        title TEXT,
        body TEXT,
        url TEXT,
        source TEXT NOT NULL DEFAULT 'mcp', -- 'mcp' | 'import'
        posted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS sns_posts_ext_uq ON sns_posts (platform, external_id) WHERE external_id IS NOT NULL`);
    await p.query(`CREATE INDEX IF NOT EXISTS sns_posts_acc_idx ON sns_posts (account, platform, posted_at DESC)`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS sns_post_stats (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT NOT NULL REFERENCES sns_posts(id) ON DELETE CASCADE,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        impressions INT, likes INT, reposts INT, replies INT, quotes INT, bookmarks INT
      )`);
    await p.query(`CREATE INDEX IF NOT EXISTS sns_post_stats_post_idx ON sns_post_stats (post_id, captured_at)`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS sns_account_stats (
        account TEXT NOT NULL,
        platform TEXT NOT NULL,
        captured_on DATE NOT NULL,
        followers INT, following INT, posts INT,
        PRIMARY KEY (account, platform, captured_on)
      )`);
    schemaReady = true;
  }

  async function accountCfg(name) {
    const cfg = await getSnsConfig();
    const a = cfg?.accounts?.[name];
    if (!a) throw new Error(`アカウント設定がありません: ${name}`);
    return a;
  }

  // ── 共通処理 ──

  async function upsertX(account, t, source, handle) {
    const r = await pool().query(
      `INSERT INTO sns_posts (account, platform, external_id, status, body, url, source, posted_at)
       VALUES ($1,'x',$2,'posted',$3,$4,$5,$6)
       ON CONFLICT (platform, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET body = EXCLUDED.body, updated_at = now()
       RETURNING id`,
      [account, t.id, t.text, `https://x.com/${handle || "i/web"}/status/${t.id}`, source, t.created_at || new Date().toISOString()]);
    return r.rows[0].id;
  }

  async function insertXStats(postId, m) {
    if (!m) return;
    await pool().query(
      `INSERT INTO sns_post_stats (post_id, impressions, likes, reposts, replies, quotes, bookmarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [postId, m.impression_count ?? null, m.like_count ?? null, m.retweet_count ?? null,
       m.reply_count ?? null, m.quote_count ?? null, m.bookmark_count ?? null]);
  }

  async function saveAccountStats(account, platform, { followers, following, posts }) {
    await pool().query(
      `INSERT INTO sns_account_stats (account, platform, captured_on, followers, following, posts)
       VALUES ($1,$2,(now() AT TIME ZONE 'Asia/Tokyo')::date,$3,$4,$5)
       ON CONFLICT (account, platform, captured_on)
       DO UPDATE SET followers = EXCLUDED.followers, following = EXCLUDED.following, posts = EXCLUDED.posts`,
      [account, platform, followers ?? null, following ?? null, posts ?? null]);
  }

  // X の自分の投稿を取り込む (手でスマホから出した投稿も DB に揃える)。読み取り課金あり
  async function importX(account, max = 20) {
    const a = await accountCfg(account);
    const me = await xMe(a.x);
    const tweets = await xUserTweets(a.x, me.id, max);
    for (const t of tweets) {
      const id = await upsertX(account, t, "import", a.x.handle);
      await insertXStats(id, t.public_metrics);
    }
    const pm = me.public_metrics || {};
    await saveAccountStats(account, "x", { followers: pm.followers_count, following: pm.following_count, posts: pm.tweet_count });
    return tweets.length;
  }

  // note の公開記事を RSS から取り込む。同じタイトルの下書きがあれば「公開済み」に付け替える
  async function importNote(account) {
    const a = await accountCfg(account);
    const items = await noteRss(a.note?.urlname);
    const p = pool();
    let added = 0;
    for (const it of items) {
      const exists = await p.query(`SELECT id FROM sns_posts WHERE platform='note' AND external_id=$1`, [it.id]);
      if (exists.rowCount) continue;
      const draft = await p.query(
        `SELECT id FROM sns_posts WHERE account=$1 AND platform='note' AND status='draft' AND title=$2
         ORDER BY created_at DESC LIMIT 1`, [account, it.title]);
      if (draft.rowCount) {
        await p.query(
          `UPDATE sns_posts SET status='posted', external_id=$2, url=$3, posted_at=$4, updated_at=now() WHERE id=$1`,
          [draft.rows[0].id, it.id, it.url, it.postedAt]);
      } else {
        await p.query(
          `INSERT INTO sns_posts (account, platform, external_id, status, title, body, url, source, posted_at)
           VALUES ($1,'note',$2,'posted',$3,$4,$5,'import',$6)`,
          [account, it.id, it.title, it.summary, it.url, it.postedAt]);
      }
      added++;
    }
    return { total: items.length, added };
  }

  // 毎朝の記録。X は投稿後 7 日間は毎日、30 日までは週 1 回だけ数字を取る (読み取り課金を抑える)
  async function snapshot(account) {
    const a = await accountCfg(account);
    const out = { account };
    if (a.x?.consumer_key) {
      const me = await xMe(a.x);
      const pm = me.public_metrics || {};
      await saveAccountStats(account, "x", { followers: pm.followers_count, following: pm.following_count, posts: pm.tweet_count });
      const { rows } = await pool().query(
        `SELECT p.id, p.external_id FROM sns_posts p
         WHERE p.account=$1 AND p.platform='x' AND p.status='posted' AND p.posted_at > now() - interval '30 days'
           AND (p.posted_at > now() - interval '7 days'
                OR NOT EXISTS (SELECT 1 FROM sns_post_stats s WHERE s.post_id=p.id AND s.captured_at > now() - interval '7 days'))`,
        [account]);
      const byExt = new Map(rows.map((r) => [r.external_id, r.id]));
      const ids = [...byExt.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const tweets = await xTweetsByIds(a.x, ids.slice(i, i + 100));
        for (const t of tweets) await insertXStats(byExt.get(t.id), t.public_metrics);
      }
      out.x = { followers: pm.followers_count, postsMeasured: ids.length };
    }
    if (a.note?.urlname) out.note = await importNote(account);
    return out;
  }

  async function snapshotAll() {
    const cfg = await getSnsConfig();
    if (!cfg) throw new Error("sns-config を読めません");
    await ensureSnsSchema();
    const results = [];
    for (const name of Object.keys(cfg.accounts)) {
      try { results.push(await snapshot(name)); }
      catch (e) { console.warn(`[sns] snapshot ${name} failed:`, e.message); results.push({ account: name, error: e.message }); }
    }
    return results;
  }

  // ── MCP ツール ──
  // handler(args, ctx) の ctx.allowed = このトークンで触れるアカウント

  function pickAccount(ctx, arg) {
    if (arg) {
      if (!ctx.allowed.includes(arg)) throw new Error(`このコネクタでは触れないアカウントです: ${arg}`);
      return arg;
    }
    if (ctx.allowed.length === 1) return ctx.allowed[0];
    throw new Error(`account を指定してください (${ctx.allowed.join(" / ")})`);
  }

  const accountProp = { account: { type: "string", description: "アカウント名。1つしかなければ省略可" } };

  const tools = [
    {
      name: "sns_accounts",
      description: "このコネクタで使えるアカウントと、X / note の設定状況を返す。",
      inputSchema: { type: "object", properties: {} },
      handler: async (_a, ctx) => {
        const cfg = await getSnsConfig();
        return ctx.allowed.map((name) => {
          const a = cfg.accounts[name] || {};
          return {
            account: name,
            label: a.label || null,
            x: a.x?.consumer_key ? `@${a.x.handle || "?"}` : "未設定",
            note: a.note?.urlname ? `https://note.com/${a.note.urlname}` : "未設定",
          };
        });
      },
    },
    {
      name: "x_post",
      description: [
        "X に投稿する (即時・取り消しは x_delete)。1本 $0.015。",
        "URL を含む投稿は 1本 $0.20 と約13倍高いので、含める場合は allow_link: true が必要。",
        "投稿前に必ず本文をユーザーに見せて OK をもらうこと。",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          ...accountProp,
          text: { type: "string", description: "本文 (280 文字相当まで。日本語は全角1文字=2カウント)" },
          reply_to: { type: "string", description: "返信先の投稿 ID (任意)" },
          allow_link: { type: "boolean", description: "URL 入りを許可 ($0.20/本)" },
        },
        required: ["text"],
      },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        const text = String(args.text || "").trim();
        if (!text) throw new Error("text が空です");
        if (hasLink(text) && !args.allow_link) {
          throw new Error("URL が含まれています。URL 入りは 1本 $0.20 です。それでも出すなら allow_link: true で再実行してください");
        }
        await ensureSnsSchema();
        const a = await accountCfg(account);
        const t = await xPost(a.x, { text, replyTo: args.reply_to });
        await upsertX(account, { id: t.id, text: t.text, created_at: new Date().toISOString() }, "mcp", a.x.handle);
        return { ok: true, id: t.id, url: `https://x.com/${a.x.handle || "i/web"}/status/${t.id}` };
      },
    },
    {
      name: "x_delete",
      description: "X の投稿を削除する (誤投稿の取り消し用)。",
      inputSchema: { type: "object", properties: { ...accountProp, id: { type: "string", description: "投稿 ID" } }, required: ["id"] },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        const own = await pool().query(`SELECT id FROM sns_posts WHERE account=$1 AND platform='x' AND external_id=$2`, [account, String(args.id)]);
        const a = await accountCfg(account);
        const deleted = await xDelete(a.x, String(args.id));
        if (own.rowCount) await pool().query(`UPDATE sns_posts SET status='deleted', updated_at=now() WHERE id=$1`, [own.rows[0].id]);
        return { ok: deleted };
      },
    },
    {
      name: "x_list",
      description: [
        "X の過去投稿を DB から返す (最新の記録済みの数字つき)。無料。",
        "refresh: true で X から最新 N 件を取り込み直す (手動投稿も拾える。読み取り $0.005/件)。",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          ...accountProp,
          limit: { type: "number", description: "件数 (既定 30)" },
          refresh: { type: "boolean", description: "X から取り込み直す" },
          refresh_count: { type: "number", description: "取り込む件数 5〜100 (既定 20)" },
        },
      },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        let imported = null;
        if (args.refresh) imported = await importX(account, args.refresh_count || 20);
        const { rows } = await pool().query(
          `SELECT p.external_id AS id, p.status, p.body, p.url, p.source, p.posted_at,
                  s.impressions, s.likes, s.reposts, s.replies, s.quotes, s.bookmarks, s.captured_at
           FROM sns_posts p
           LEFT JOIN LATERAL (SELECT * FROM sns_post_stats WHERE post_id=p.id ORDER BY captured_at DESC LIMIT 1) s ON true
           WHERE p.account=$1 AND p.platform='x'
           ORDER BY p.posted_at DESC NULLS LAST LIMIT $2`,
          [account, Math.min(200, args.limit || 30)]);
        return { imported, posts: rows };
      },
    },
    {
      name: "note_draft",
      description: [
        "note 記事の下書きを DB に保存する (note への自動投稿はまだ無い)。",
        "保存後、本文をユーザーに渡して note に手で貼ってもらう。公開後に note_list を呼ぶと同じタイトルの下書きが公開済みに付け替わる。",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          ...accountProp,
          title: { type: "string" },
          body: { type: "string", description: "本文 (Markdown)" },
        },
        required: ["title", "body"],
      },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        const r = await pool().query(
          `INSERT INTO sns_posts (account, platform, status, title, body, source) VALUES ($1,'note','draft',$2,$3,'mcp') RETURNING id`,
          [account, String(args.title).trim(), String(args.body)]);
        return { ok: true, draftId: r.rows[0].id };
      },
    },
    {
      name: "note_list",
      description: "note の記事一覧 (公開済み + 下書き)。既定で note の RSS から公開記事を取り込み直してから返す (無料)。",
      inputSchema: {
        type: "object",
        properties: {
          ...accountProp,
          limit: { type: "number", description: "件数 (既定 30)" },
          refresh: { type: "boolean", description: "RSS から取り込み直す (既定 true)" },
          include_body: { type: "boolean", description: "下書きの本文も返す" },
        },
      },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        let imported = null;
        if (args.refresh !== false) {
          try { imported = await importNote(account); } catch (e) { imported = { error: e.message }; }
        }
        const { rows } = await pool().query(
          `SELECT id AS draft_id, external_id AS id, status, title,
                  CASE WHEN $3 THEN body ELSE left(body, 200) END AS body, url, posted_at, created_at
           FROM sns_posts WHERE account=$1 AND platform='note'
           ORDER BY COALESCE(posted_at, created_at) DESC LIMIT $2`,
          [account, Math.min(200, args.limit || 30), !!args.include_body]);
        return { imported, posts: rows };
      },
    },
    {
      name: "sns_stats",
      description: [
        "記録済みの数字をそのまま返す (無料)。伸び率や比較の計算はこれを元にチャット側でやる。",
        "posts: 投稿ごとの記録の時系列 / account: フォロワー数などの日ごとの記録。",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          ...accountProp,
          platform: { type: "string", enum: ["x", "note"] },
          days: { type: "number", description: "直近何日分の投稿か (既定 30)" },
        },
      },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        const days = Math.min(365, args.days || 30);
        const platform = args.platform || null;
        const posts = await pool().query(
          `SELECT p.platform, p.external_id AS id, left(COALESCE(p.title, p.body), 80) AS head, p.posted_at,
                  COALESCE(json_agg(json_build_object('at', s.captured_at, 'imp', s.impressions, 'like', s.likes,
                    'rp', s.reposts, 'reply', s.replies, 'quote', s.quotes, 'bm', s.bookmarks) ORDER BY s.captured_at)
                    FILTER (WHERE s.id IS NOT NULL), '[]') AS series
           FROM sns_posts p LEFT JOIN sns_post_stats s ON s.post_id = p.id
           WHERE p.account=$1 AND p.status='posted' AND ($2::text IS NULL OR p.platform=$2)
             AND p.posted_at > now() - make_interval(days => $3)
           GROUP BY p.id ORDER BY p.posted_at DESC`,
          [account, platform, days]);
        const acc = await pool().query(
          `SELECT platform, captured_on::text AS captured_on, followers, following, posts FROM sns_account_stats
           WHERE account=$1 AND ($2::text IS NULL OR platform=$2) AND captured_on > (now() - make_interval(days => $3))::date
           ORDER BY platform, captured_on`,
          [account, platform, days]);
        return { posts: posts.rows, account: acc.rows };
      },
    },
    {
      name: "sns_snapshot",
      description: "今の数字をすぐ記録する (毎朝自動でも動く)。X は読み取り課金あり。",
      inputSchema: { type: "object", properties: { ...accountProp } },
      handler: async (args, ctx) => {
        const account = pickAccount(ctx, args.account);
        await ensureSnsSchema();
        return await snapshot(account);
      },
    },
  ];

  const INSTRUCTIONS = [
    "X / note の発信用。文面はユーザーと相談して決め、投稿系 (x_post / x_delete) は毎回本文を見せて確認を取ってから呼ぶ。",
    "投稿文・記事に会社名や社名が分かる情報は入れない (匿名アカウントとして運用中)。",
    "数字の分析は sns_stats の生データからチャット側で計算する。X の読み取り (refresh / snapshot) は課金されるので必要なときだけ。",
    "note は今は下書き保存まで。本文をユーザーに渡し、note に手で貼って公開してもらう。",
  ].join("\n");

  // ctx (許可アカウント) を handler に渡すため、リクエスト毎に handler を包む
  function mcpRoute() {
    return async (req, res) => {
      let allowed = null;
      try { allowed = await accountsForToken(req.params.token); } catch { allowed = null; }
      if (!allowed) return res.status(403).json({ error: "forbidden" });
      const ctx = { allowed };
      const handler = createMcpHandler({
        name: "sns",
        instructions: INSTRUCTIONS,
        tools: tools.map((t) => ({ ...t, handler: (a) => t.handler(a, ctx) })),
      });
      return handler(req, res);
    };
  }

  // 統合コネクタ用: 設定済みの全アカウントを触れる ctx でツールを返す
  async function toolsForAll() {
    const cfg = await getSnsConfig();
    const allowed = Object.keys(cfg?.accounts || {});
    if (!allowed.length) return [];
    const ctx = { allowed };
    return tools.map((t) => ({ ...t, handler: (a) => t.handler(a, ctx) }));
  }

  return { mcpRoute, snapshotAll, toolsForAll, instructions: INSTRUCTIONS };
}
