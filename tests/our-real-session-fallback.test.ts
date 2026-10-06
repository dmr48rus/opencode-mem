import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  generateStructuredOutput,
  resetInternalStructuredSessions,
  setStructuredOutputRealSessionFallback,
} from "../src/services/ai/opencode-provider.js";

/**
 * The real-session fallback is the only shape of structured output that
 * free-tier providers (OpenCode Zen apiKey "public") accept: they reject the
 * sessionless generate calls the plugin otherwise uses.
 *
 * Three properties, each asserted separately:
 * - the config default is off, so behaviour matches upstream unless asked for;
 * - ON adds exactly ONE extra request to the host, and only when the transport
 *   was refused (not for timeouts or connectivity errors);
 * - when the fallback also fails, the ORIGINAL error survives. A fallback that
 *   hides the real cause is worse than no fallback.
 *
 * The base URL is pinned per test rather than relying on it being unset: the
 * provider module caches it across tests, so "no client configured" is not a
 * state this file can assume.
 *
 * The config default is read in a SUBPROCESS. `CONFIG` is a module singleton,
 * and in a full-suite run it is initialised by other test files — including
 * from the operator's real `opencode-mem.jsonc`, where the flag is ON. Reading
 * the singleton here made the test depend on file order AND on the contents of
 * a live config file on this machine.
 */
describe("structured-output real-session fallback", () => {
  const UNREACHABLE = "http://127.0.0.1:9999";
  let restoreFetch: typeof globalThis.fetch;
  let urls: string[] = [];

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

  /** Every request fails as a refusal (500), so the fallback must engage. */
  function refuseAll(status = 500) {
    restoreFetch = globalThis.fetch;
    urls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("upstream refused", { status });
    }) as any;
  }

  async function callStructuredOutput() {
    const { createV2Client } = await import("../src/services/ai/opencode-provider.js");
    createV2Client(UNREACHABLE);
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

  it("defaults the config flag to false with no config file present", async () => {
    const home = mkdtempSync(join(tmpdir(), "om-flag-default-"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    // A config file that predates the option, so the default must apply.
    writeFileSync(
      join(home, ".config", "opencode", "opencode-mem.jsonc"),
      '{ "autoCaptureEnabled": true }',
      "utf-8"
    );

    // bun takes a filesystem path for the script, not a file:// URL.
    const probe = fileURLToPath(new URL("./helpers/config-default.probe.mjs", import.meta.url));
    const configUrl = pathToFileURL(
      fileURLToPath(new URL("../src/config.ts", import.meta.url))
    ).href;
    const proc = Bun.spawn(["bun", probe, configUrl, home], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;

    expect(out.trim(), `stderr: ${err.slice(0, 200)}`).toBe("false");
  });

  it("makes no host request when the fallback is off", async () => {
    process.env.OPENCODE_PORT = "59998";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    setStructuredOutputRealSessionFallback(false);
    refuseAll();

    const message = await callStructuredOutput();

    // Only the transport's own create attempt.
    expect(urls.length).toBe(1);
    expect(message).toContain("500 Internal Server Error");
  });

  it("adds exactly one host request when on, and keeps the original error", async () => {
    process.env.OPENCODE_PORT = "59998";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    setStructuredOutputRealSessionFallback(true);
    refuseAll();

    const message = await callStructuredOutput();

    // Transport create + one real-session create. The fallback's create fails,
    // so there is no prompt and no delete to count.
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain("127.0.0.1:59998");
    // The fallback's own failure must not become the reported cause.
    expect(message).toContain("500 Internal Server Error");
    expect(message).not.toContain("real-session generate returned no JSON");
  });

  it("stays out of the way for connectivity errors, where no transport can help", async () => {
    process.env.OPENCODE_PORT = "59998";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    setStructuredOutputRealSessionFallback(true);
    restoreFetch = globalThis.fetch;
    urls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as any;

    const message = await callStructuredOutput();

    expect(urls.length).toBe(1);
    expect(message).toContain("ECONNREFUSED");
  });
});
