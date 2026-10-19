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
export declare const MCP_PROTOCOL_VERSION = "2025-06-18";
export type McpToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};
export declare const MCP_TOOL_SPECS: McpToolSpec[];
/**
 * Which Host headers the MCP endpoint accepts.
 *
 * A browser page can be pointed at this server by DNS rebinding: the name
 * resolves to the server and the page sends the request with its own origin.
 * The token is the real protection, but a Host allowlist closes the browser
 * case as well. OPENCODE_MEM_MCP_ALLOWED_HOSTS lists the allowed names
 * ("mem.agrohim.info,127.0.0.1:4747"); unset means any host is accepted.
 */
export declare function checkMcpHost(host: string | null, allowedList?: string): string | null;
export type McpToolResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError?: boolean;
};
export type McpDispatcher = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
export type McpJsonRpcResponse = {
    status: number;
    payload: unknown;
};
export declare function handleMcpJsonRpc(body: unknown, dispatch: McpDispatcher): Promise<McpJsonRpcResponse>;
//# sourceMappingURL=mcp-endpoint.d.ts.map