// MCP (Model Context Protocol) Streamable HTTP サーバーの最小実装。
// claude.ai のカスタムコネクタ (リモート MCP) から接続する用。
// SDK は入れず JSON-RPC を直接さばく: 依存を増やさない + stateless で Cloud Run と相性が良い。
//
// 対応: initialize / notifications/* / ping / tools/list / tools/call / server/discover (claude.ai Artifact ブリッジ用)
// セッション管理はしない (毎リクエスト独立)。GET の SSE ストリームは張らない (405)。
// レスポンスは application/json (Streamable HTTP 仕様上、サーバーは JSON 応答を選べる)。
// Accept が text/event-stream だけのクライアントには、同じ JSON を 1 イベントの SSE で返す。
// 各 tools/call は 1 行ログ (ツール名・ms・bytes) + メモリ上の直近 200 件 (recentMcpCalls) に残す。

// 直近の呼び出し (ツール名・所要時間・結果) を 200 件だけメモリに持つ。Cloud Logging を見に行けないときの一次情報
// (GET /api/genba/mcp/<token>/recent)。引数の中身は残さない (個人情報を溜めない)
const RECENT_MAX = 200;
const RECENT = [];
function remember(entry) {
  RECENT.push({ at: new Date().toISOString(), ...entry });
  if (RECENT.length > RECENT_MAX) RECENT.splice(0, RECENT.length - RECENT_MAX);
}
export function recentMcpCalls() { return RECENT.slice().reverse(); }

const okResp = (id, result) => ({ jsonrpc: "2.0", id, result });
const errResp = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// tools: [{ name, description, inputSchema, handler(args) → { content:[...] } | 任意の値 }]
// handler が content 形式以外を返したら JSON 文字列の text content に包む。
export function createMcpHandler({ name, version = "1.0.0", instructions = "", tools = [] }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  async function handleOne(msg, meta = {}) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      remember({ server: name, method: msg?.method ?? null, ok: false, error: "invalid request", ...meta });
      return errResp(msg?.id ?? null, -32600, "invalid request");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    const t0 = Date.now();
    try {
      if (method === "initialize") {
        return okResp(id, {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      if (method === "ping") return okResp(id, {});
      if (method.startsWith("notifications/")) return null; // 応答不要
      const toolList = () => tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      if (method === "tools/list") return okResp(id, { tools: toolList() });
      // claude.ai の Artifact ブリッジが最初に投げてくる独自メソッド (標準外)。initialize + tools/list をまとめた形で返す。
      // これに -32601 を返すとブリッジが upstream_error にしてしまう (2026-10-13 に /recent で観測)
      if (method === "server/discover") {
        // 期待される形が公開されていないので、引数をそのまま記録して様子を見る (値は小さいので丸ごと)
        remember({ server: name, method, ok: true, params: JSON.stringify(params ?? null).slice(0, 600), ...meta });
        return okResp(id, {
          protocolVersion: params?.protocolVersion || meta.proto || "2025-06-18",
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
          tools: toolList(),
          resources: [],
          resourceTemplates: [],
          prompts: [],
        });
      }
      if (method === "resources/list") return okResp(id, { resources: [] });
      if (method === "resources/templates/list") return okResp(id, { resourceTemplates: [] });
      if (method === "prompts/list") return okResp(id, { prompts: [] });
      if (method === "tools/call") {
        const tool = toolMap.get(params?.name);
        if (!tool) {
          remember({ server: name, method, tool: params?.name ?? null, ok: false, error: "unknown tool", ...meta });
          return errResp(id, -32602, `unknown tool: ${params?.name}`);
        }
        const argKeys = params?.arguments && typeof params.arguments === "object" ? Object.keys(params.arguments) : [];
        try {
          const result = await tool.handler(params?.arguments || {});
          const content = (result && Array.isArray(result.content))
            ? result.content
            : [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 1) }];
          const bytes = content.reduce((n, c) => n + (typeof c.text === "string" ? Buffer.byteLength(c.text) : 0), 0);
          const ms = Date.now() - t0;
          console.log(`[mcp:${name}] ${params.name} ok ${ms}ms ${bytes}B args=${argKeys.join(",")}${meta.ua ? ` ua=${meta.ua}` : ""}`);
          remember({ server: name, method, tool: params.name, ok: true, isError: false, ms, bytes, argKeys, ...meta });
          return okResp(id, { content, isError: false });
        } catch (e) {
          // ツール実行エラーはプロトコルエラーではなく isError で返す (モデルがリカバーできる)
          const ms = Date.now() - t0;
          console.warn(`[mcp:${name}] ${params?.name} isError ${ms}ms: ${e.message}`);
          remember({ server: name, method, tool: params?.name, ok: true, isError: true, ms, error: String(e.message).slice(0, 300), argKeys, ...meta });
          return okResp(id, { content: [{ type: "text", text: `エラー: ${e.message}` }], isError: true });
        }
      }
      if (isNotification) return null;
      remember({ server: name, method, ok: false, error: "method not found", paramsKeys: params && typeof params === "object" ? Object.keys(params) : undefined, ...meta });
      return errResp(id, -32601, `method not found: ${method}`);
    } catch (e) {
      console.error(`[mcp:${name}] ${method} crashed:`, e);
      remember({ server: name, method, tool: params?.name, ok: false, error: String(e.message).slice(0, 300), ms: Date.now() - t0, ...meta });
      return isNotification ? null : errResp(id, -32603, e.message);
    }
  }

  const mcpHandler = async function mcpHandler(req, res) {
    if (req.method === "DELETE") return res.status(200).end(); // stateless: 終了処理なし
    if (req.method !== "POST") return res.status(405).json({ error: "POST only (stateless MCP)" });
    const body = req.body;
    const ua = String(req.headers["user-agent"] || "").slice(0, 60);
    const accept = String(req.headers.accept || "");
    if (!body || typeof body !== "object") {
      remember({ server: name, method: null, ok: false, error: `empty/invalid body (content-type=${req.headers["content-type"] || "-"})`, ua });
      return res.status(400).json(errResp(null, -32700, "parse error: JSON body required"));
    }
    const msgs = Array.isArray(body) ? body : [body];
    const t0 = Date.now();
    const proto = req.headers["mcp-protocol-version"] ? String(req.headers["mcp-protocol-version"]) : undefined;
    const results = (await Promise.all(msgs.map((msg) => handleOne(msg, { ua, proto })))).filter(Boolean);
    const hdr = { accept, ct: String(req.headers["content-type"] || ""), proto, session: req.headers["mcp-session-id"] ? "yes" : undefined };
    const payload = Array.isArray(body) ? results : results[0];
    const bytes = results.length ? Buffer.byteLength(JSON.stringify(payload)) : 0;
    // リクエスト単位の記録 (どのクライアントが何を・どんなヘッダで投げ、何バイト返したか)。tools/call の中身は handleOne 側で別に残す
    remember({ server: name, method: "http", methods: msgs.map((x) => `${x?.method || "?"}${x?.id === undefined || x?.id === null ? "(notif)" : ""}`), batch: Array.isArray(body) || undefined, status: results.length ? 200 : 202, ms: Date.now() - t0, bytes, hdr, ok: true, ua });
    if (!results.length) return res.status(202).end(); // notification のみ
    // Streamable HTTP の互換: 受け取った Mcp-Session-Id / MCP-Protocol-Version はそのまま返す (新しい版のクライアントが応答側にも求める可能性)
    if (req.headers["mcp-session-id"]) res.set("Mcp-Session-Id", String(req.headers["mcp-session-id"]));
    if (proto) res.set("MCP-Protocol-Version", proto);
    // Streamable HTTP: クライアントが SSE しか受けないと言ってきたら、1 イベントの SSE で同じ JSON を返す
    // (JSON を受けられるクライアント = 普段の claude.ai / Claude Code はそのまま application/json)
    if (accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*")) {
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    res.json(payload);
  };
  // 統合コネクタ (/api/mcp/<token>) が各 MCP のツールと説明を束ねるのに使う
  mcpHandler.meta = { name, instructions, tools };
  return mcpHandler;
}
