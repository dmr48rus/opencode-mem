import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

// Tags live in one comma-separated column, so a plain LIKE '%git%' also matches
// "github" and "legit". These cover the whole-tag match and the ESCAPE clause.
describe("listMemories tag filter", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  async function seed() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-tag-filter-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    return { tursoShardManager, tursoConnectionManager, tursoVectorSearch };
  }

  it("matches whole tags only and escapes LIKE wildcards", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const vector = new Float32Array(768);
    vector[0] = 1;
    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    const rows: [string, string, string][] = [
      ["m_git", "про git и протокол", "git"],
      ["m_github", "про github Actions", "github"],
      ["m_legit", "про legit вопрос", "legit"],
      ["m_mytag", "подчёркивание", "my_tag"],
      ["m_mytag2", "похожее имя", "myXtag"],
      ["m_multi", "несколько", "git,sql"],
    ];
    for (const [id, content, tags] of rows) {
      await tursoVectorSearch.insertVector(db, {
        id,
        content,
        vector,
        containerTag,
        tags,
      } as any);
    }

    const list = async (filters: string[], limit = 20) =>
      (await tursoVectorSearch.listMemories(db, containerTag, limit, filters))
        .map((r) => r.id)
        .sort();

    // "git" must not catch github or legit.
    expect(await list(["git"])).toEqual(["m_git", "m_multi"]);
    // Substring-style tags stay reachable on their own.
    expect(await list(["github"])).toEqual(["m_github"]);
    // Multiple filters are AND.
    expect(await list(["git", "sql"])).toEqual(["m_multi"]);
    // '_' is one character in LIKE unless escaped: without ESCAPE both rows hit.
    expect(await list(["my_tag"])).toEqual(["m_mytag"]);
    // No filter keeps the previous behaviour.
    expect((await list([])).length).toBe(rows.length);
    // Unknown tag yields nothing rather than everything.
    expect(await list(["nosuchtag"])).toEqual([]);
  });

  it("still honours containerTag and limit", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const vector = new Float32Array(768);
    vector[0] = 1;
    const shard = await tursoShardManager.createShard("project", "aaaabbbbccccdddd", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    await tursoVectorSearch.insertVector(db, {
      id: "m1",
      content: "one",
      vector,
      containerTag: "opencode_project_aaaabbbbccccdddd",
      tags: "git",
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m2",
      content: "two",
      vector,
      containerTag: "opencode_project_9999888877776666",
      tags: "git",
    } as any);

    // A different containerTag must not leak in, even with a matching tag.
    const scoped = await tursoVectorSearch.listMemories(
      db,
      "opencode_project_aaaabbbbccccdddd",
      20,
      ["git"]
    );
    expect(scoped.map((r) => r.id)).toEqual(["m1"]);

    // Empty containerTag = all scopes, and limit still applies.
    expect((await tursoVectorSearch.listMemories(db, "", 1, ["git"])).length).toBe(1);
  });
});
