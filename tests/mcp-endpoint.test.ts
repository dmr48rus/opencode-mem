import { describe, expect, it } from "bun:test";
import { MCP_TOOL_SPECS, handleMcpJsonRpc } from "../src/services/mcp-endpoint.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("mcp endpoint", () => {
  it("answers initialize with the client's protocol version", async () => {
    const { status, payload } = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      async () => ok("")
    );
    expect(status).toBe(200);
    const result = (payload as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toBeDefined();
  });

  it("lists the tools", async () => {
    const { payload } = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      async () => ok("")
    );
    const tools = (payload as { result: { tools: unknown[] } }).result.tools;
    expect(tools.length).toBe(MCP_TOOL_SPECS.length);
  });

  it("calls a tool and returns its content", async () => {
    const { payload } = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "память" } },
      },
      async (name, args) => ok(`${name}:${JSON.stringify(args)}`)
    );
    const result = (payload as { result: { content: Array<{ text: string }> } }).result;
    expect(result.content[0].text).toContain("memory_search");
    expect(result.content[0].text).toContain("память");
  });

  it("refuses an unknown tool by name", async () => {
    const { payload } = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } },
      async () => ok("")
    );
    expect((payload as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("answers a notification with no body", async () => {
    const { status } = await handleMcpJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      async () => ok("")
    );
    expect(status).toBe(202);
  });

  it("turns a throwing tool into an error result, not a broken response", async () => {
    const { payload } = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memory_forget", arguments: { id: "x" } },
      },
      async () => {
        throw new Error("boom");
      }
    );
    const result = (payload as { result: { isError?: boolean } }).result;
    expect(result.isError).toBe(true);
  });
});
