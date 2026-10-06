import { afterEach, describe, expect, it } from "bun:test";
import {
  generateStructuredOutput,
  resetInternalStructuredSessions,
  setStructuredOutputRealSessionFallback,
} from "../src/services/ai/opencode-provider.js";

/**
 * The real-session fallback is the only way structured output works on free-tier
 * providers (OpenCode Zen apiKey "public"), which reject sessionless generate.
 *
 * Two things must hold, and each has its own assertion below:
 * - OFF by default, so behaviour is byte-identical to upstream unless asked for;
 * - ON does exactly ONE extra request, and the ORIGINAL error survives when the
 *   fallback also fails. A fallback that hides the real cause is worse than no
 *   fallback.
 */
describe("structured-output real-session fallback", () => {
  let restoreFetch: typeof globalThis.fetch;
  let fetchCalls = 0;

  afterEach(() => {
    setStructuredOutputRealSessionFallback(false);
    resetInternalStructuredSessions();
    if (restoreFetch) globalThis.fetch = restoreFetch;
    delete process.env.OPENCODE_PORT;
    delete process.env.OPENCODE_SERVER_PASSWORD;
  });

  const schema = {
    parse: (v: unknown) => v,
    toJSONSchema: () => ({ type: "object" }),
  } as any;

  /** Counts fetches so "did the fallback try the host at all?" is observable. */
  function spyFetch() {
    restoreFetch = globalThis.fetch;
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      // Refuse everything: the fallback must give up, not loop.
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as any;
  }

  async function callStructuredOutput() {
    try {
      await generateStructuredOutput({
        client: {} as any,
        providerID: "opencode",
        modelID: "free-model",
        systemPrompt: "s",
        userPrompt: "u",
        schema,
      });
      return "";
    } catch (error) {
      return String(error);
    }
  }

  it("defaults the config flag to false, so behaviour matches upstream unless asked for", async () => {
    // The module-level flag is always overwritten by the plugin init, so the
    // default that actually decides behaviour lives in CONFIG.
    const { CONFIG } = await import("../src/config.js");
    expect(CONFIG.opencodeRealSessionFallback).toBe(false);
  });

  it("does not touch the host when the fallback is off", async () => {
    process.env.OPENCODE_PORT = "59999";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    setStructuredOutputRealSessionFallback(false);
    spyFetch();

    const message = await callStructuredOutput();

    expect(fetchCalls).toBe(0);
    expect(message).toContain("v2 server base URL not initialized");
  });

  it("tries the host exactly once when the fallback is on, keeping the original error", async () => {
    process.env.OPENCODE_PORT = "59999";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    setStructuredOutputRealSessionFallback(true);
    spyFetch();

    const message = await callStructuredOutput();

    // One create attempt; no prompt, no delete, because create never returned.
    expect(fetchCalls).toBe(1);
    // The fallback failed too, but the operator must still see the real cause.
    expect(message).toContain("v2 server base URL not initialized");
    expect(message).not.toContain("real-session generate returned no JSON");
  });
});
