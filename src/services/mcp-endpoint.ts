/**
 * MCP over HTTP: JSON-RPC on POST /mcp.
 *
 * Why this exists: a client that speaks MCP over HTTP needs nothing but a URL
 * and a token - no Python, no build, no local store. That is what makes the
 * memory reachable from a harness on another machine.
 *
 * The protocol layer is kept pure on purpose: the tool bodies are injected, so
 * the JSON-RPC handling is testable without a database.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type McpToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "memory_search",
    description:
      "Search the shared memory store. Use it when the answer depends on what happened earlier: a decision already taken, a file already handled, a failure already diagnosed.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in the words you would use for it.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "How many records to return. Default 8.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_snapshot",
    description:
      "The state of the store without a question: pinned and recent records plus counts. No embedding is computed, so it is cheap enough to call at the start of every session.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many recent records to return. Default 10.",
        },
      },
    },
  },
  {
    name: "memory_profile",
    description:
      "The learned profile: preferences, patterns and workflows. Read it before deciding HOW to work - it holds how the user wants requests phrased and which checks are expected.",
    inputSchema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "Whose profile. Defaults to the profile of this server.",
        },
      },
    },
  },
  {
    name: "memory_remember",
    description:
      "Write a durable fact into the shared store. It becomes visible to every harness, on every machine.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact, in one or two sentences." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags." },
        project: {
          type: "string",
          description: "Project path or name. Defaults to the client project.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_forget",
    description: "Delete a record from the shared store. Explicit forgetting, not decay.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record id, as memory_search returns it." },
      },
      required: ["id"],
    },
  },
];

/**
 * Which Host headers the MCP endpoint accepts.
 *
 * A browser page can be pointed at this server by DNS rebinding: the name
 * resolves to the server and the page sends the request with its own origin.
 * The token is the real protection, but a Host allowlist closes the browser
 * case as well. OPENCODE_MEM_MCP_ALLOWED_HOSTS lists the allowed names
 * ("mem.agrohim.info,127.0.0.1:4747"); unset means any host is accepted.
 */
export function checkMcpHost(host: string | null, allowedList?: string): string | null {
  const allowed = (allowedList ?? process.env.OPENCODE_MEM_MCP_ALLOWED_HOSTS ?? "").trim();
  if (!allowed) return null;
  if (!host) return "mcp: the Host header is missing";
  const names = allowed
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes(host.trim().toLowerCase())) return null;
  return `mcp: host ${host} is not in OPENCODE_MEM_MCP_ALLOWED_HOSTS`;
}

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type McpDispatcher = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

export type McpJsonRpcResponse = { status: number; payload: unknown };

export async function handleMcpJsonRpc(
  body: unknown,
  dispatch: McpDispatcher
): Promise<McpJsonRpcResponse> {
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const item of body) {
      const result = await handleOne(item, dispatch);
      if (result !== null) results.push(result);
    }
    return { status: 200, payload: results };
  }
  const result = await handleOne(body, dispatch);
  if (result === null) return { status: 202, payload: null };
  return { status: 200, payload: result };
}

async function handleOne(body: unknown, dispatch: McpDispatcher): Promise<unknown | null> {
  if (!body || typeof body !== "object") return rpcError(null, -32600, "Invalid Request");
  const request = body as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = request.id === undefined ? null : request.id;
  const method = String(request.method ?? "");
  // Notifications carry no id and expect no answer.
  if (id === null && method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const params = (request.params ?? {}) as { protocolVersion?: string };
      const version =
        typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-mem", version: "1" },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOL_SPECS } };
    case "tools/call": {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const name = String(params.name ?? "");
      if (!MCP_TOOL_SPECS.some((spec) => spec.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await dispatch(name, params.arguments ?? {});
        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `${name} failed: ${String(error)}` }],
            isError: true,
          },
        };
      }
    }
    default:
      if (id === null) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
