// MCP (Model Context Protocol) Streamable HTTP サーバーの最小実装。
// claude.ai のカスタムコネクタ (リモート MCP) から接続する用。
// SDK は入れず JSON-RPC を直接さばく: 依存を増やさない + stateless で Cloud Run と相性が良い。
//
// 対応: initialize / notifications/* / ping / tools/list / tools/call
// セッション管理はしない (毎リクエスト独立)。GET の SSE ストリームは張らない (405)。
// レスポンスは application/json 一本 (Streamable HTTP 仕様上、サーバーは JSON 応答を選べる)。

const okResp = (id, result) => ({ jsonrpc: "2.0", id, result });
const errResp = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// tools: [{ name, description, inputSchema, handler(args) → { content:[...] } | 任意の値 }]
// handler が content 形式以外を返したら JSON 文字列の text content に包む。
export function createMcpHandler({ name, version = "1.0.0", instructions = "", tools = [] }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  async function handleOne(msg) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return errResp(msg?.id ?? null, -32600, "invalid request");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
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
      if (method === "tools/list") {
        return okResp(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          })),
        });
      }
      if (method === "tools/call") {
        const tool = toolMap.get(params?.name);
        if (!tool) return errResp(id, -32602, `unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(params?.arguments || {});
          const content = (result && Array.isArray(result.content))
            ? result.content
            : [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 1) }];
          return okResp(id, { content, isError: false });
        } catch (e) {
          // ツール実行エラーはプロトコルエラーではなく isError で返す (モデルがリカバーできる)
          console.warn(`[mcp:${name}] tool ${params?.name} failed:`, e.message);
          return okResp(id, { content: [{ type: "text", text: `エラー: ${e.message}` }], isError: true });
        }
      }
      if (isNotification) return null;
      return errResp(id, -32601, `method not found: ${method}`);
    } catch (e) {
      return isNotification ? null : errResp(id, -32603, e.message);
    }
  }

  return async function mcpHandler(req, res) {
    if (req.method === "DELETE") return res.status(200).end(); // stateless: 終了処理なし
    if (req.method !== "POST") return res.status(405).json({ error: "POST only (stateless MCP)" });
    const body = req.body;
    const msgs = Array.isArray(body) ? body : [body];
    const results = (await Promise.all(msgs.map(handleOne))).filter(Boolean);
    if (!results.length) return res.status(202).end(); // notification のみ
    res.json(Array.isArray(body) ? results : results[0]);
  };
}
