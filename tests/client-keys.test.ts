import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A per-machine key: it works for what it was issued for, and it can be
// revoked without touching the master token or the other machines.

describe("per-client keys", () => {
  let dir: string | null = null;

  afterEach(async () => {
    const { setClientKeysFile } = await import("../src/services/client-keys.js");
    setClientKeysFile(null);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function fresh() {
    dir = mkdtempSync(join(tmpdir(), "client-keys-"));
    const { setClientKeysFile } = await import("../src/services/client-keys.js");
    setClientKeysFile(join(dir, "client-keys.json"));
    return await import("../src/services/client-keys.js");
  }

  it("issues a key that resolves to its scope and can be revoked", async () => {
    const { issueClientKey, resolveClientScope, revokeClientKey, listClientKeys } = await fresh();

    const issued = issueClientKey({
      label: "laptop",
      clientId: "laptop.local",
      scope: "read",
    });
    expect(issued.key.startsWith("ck_")).toBe(true);
    expect(resolveClientScope(issued.key)).toBe("read");
    expect(listClientKeys()).toHaveLength(1);

    expect(revokeClientKey(issued.record.id)).toBe(true);
    expect(resolveClientScope(issued.key)).toBeNull();
    expect(listClientKeys()).toHaveLength(0);
  });

  it("keeps the plaintext out of the stored file", async () => {
    const { issueClientKey } = await fresh();
    const issued = issueClientKey({
      label: "desktop",
      clientId: "desktop.local",
      scope: "write",
    });
    const { readFileSync } = await import("node:fs");
    const stored = readFileSync(join(dir as string, "client-keys.json"), "utf-8");
    expect(stored.includes(issued.key)).toBe(false);
    expect(stored).toContain("desktop.local");
  });

  it("refuses a write from a read-only key and lets the master through", async () => {
    const { issueClientKey } = await fresh();
    const { authorizeApiRequest } = await import("../src/services/web-api-auth.js");
    const issued = issueClientKey({
      label: "reader",
      clientId: "reader.local",
      scope: "read",
    });
    const master = "master-token-value";

    const readRequest = new Request("https://store/api/memories", {
      method: "GET",
      headers: { "x-opencode-mem-token": issued.key },
    });
    expect(authorizeApiRequest(readRequest, master)).toBeNull();

    const writeRequest = new Request("https://store/api/memories", {
      method: "POST",
      headers: { "x-opencode-mem-token": issued.key },
    });
    const refused = authorizeApiRequest(writeRequest, master);
    expect(refused?.status).toBe(403);

    const masterRequest = new Request("https://store/api/memories", {
      method: "POST",
      headers: { "x-opencode-mem-token": master },
    });
    expect(authorizeApiRequest(masterRequest, master)).toBeNull();

    const strangerRequest = new Request("https://store/api/memories", {
      method: "GET",
      headers: { "x-opencode-mem-token": "not-a-key" },
    });
    expect(authorizeApiRequest(strangerRequest, master)?.status).toBe(401);
  });
});
