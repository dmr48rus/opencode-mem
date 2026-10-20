import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

// The shadow index holds the vectors of a second model in its own column.
//
// The point of the column is that the model in charge keeps answering while
// the shadow index is filled, so the switch is a flag and not a window with
// an unreadable store. The shadow vectors have another width on purpose: a
// width mismatch must fail loudly here, not in production.

describe("shadow index", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
    delete process.env.OPENCODE_MEM_RRF;
  });

  async function seed() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-shadow-"));

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

  function axis(index: number, dims: number): Float32Array {
    const vector = new Float32Array(dims);
    vector[index] = 1;
    return vector;
  }

  it("lets the shadow replace the content channel in the global fusion", async () => {
    const { fuseGlobalRanks } = await import("../src/services/turso/vector-search.js");
    // The lexical channel prefers "c", the old model's distance prefers "a",
    // the shadow's distance prefers "c": with two records the sums are
    // symmetric and the test proves nothing.
    const lexical = new Map([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
    const make = () => [
      { id: "a", memory: "a", similarity: 0, contentSim: 0.9, tagsSim: 0.9, shadowSim: 0.1 },
      { id: "b", memory: "b", similarity: 0, contentSim: 0.8, tagsSim: 0.8, shadowSim: 0.2 },
      { id: "c", memory: "c", similarity: 0, contentSim: 0.1, tagsSim: 0.1, shadowSim: 0.9 },
    ];

    // Off: the model in charge decides, and it prefers "a".
    const off = make();
    fuseGlobalRanks(off, lexical, 10, "off");
    expect(off[0].similarity).toBeGreaterThan(off[2].similarity);

    // Replace: the shadow's distance is the content channel, and it prefers "c".
    // Without this the shadow was counted inside the shard and then
    // overwritten here by the old model, so the switch did nothing.
    const replace = make();
    fuseGlobalRanks(replace, lexical, 10, "replace");
    expect(replace[2].similarity).toBeGreaterThan(replace[0].similarity);
  });

  it("stores the shadow vector in its own column and reads it on request", async () => {
    process.env.OPENCODE_MEM_RRF = "1";
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    await tursoVectorSearch.insertVector(db, {
      id: "m_shadow",
      content: "запись, которую находит теневая модель",
      vector: axis(0, 768),
      shadowVector: axis(1, 384),
      shadowModel: "test/shadow-model",
      containerTag,
    } as any);

    const row = await db.get<{ shadow_model?: string; shadow_vector?: unknown }>(
      `SELECT shadow_model, shadow_vector FROM memories WHERE id = ?`,
      ["m_shadow"]
    );
    expect(String(row?.shadow_model)).toBe("test/shadow-model");
    expect(row?.shadow_vector).toBeTruthy();

    // The model in charge alone: the shadow is not read.
    const withoutShadow = await tursoVectorSearch.searchInShard(
      shard,
      axis(0, 768),
      containerTag,
      10,
      "слов_нет_в_тексте",
      undefined,
      undefined,
      "off"
    );
    expect(withoutShadow.length).toBeGreaterThan(0);

    // The shadow speaks for itself: another width, another column. The vector
    // of the model in charge is NOT passed - in "replace" mode it does not
    // exist, and asking for candidates with a vector of another width is an
    // error, not an empty list. This is the shape the live server has.
    const withShadow = await tursoVectorSearch.searchInShard(
      shard,
      undefined,
      containerTag,
      10,
      "слов_нет_в_тексте",
      undefined,
      axis(1, 384),
      "replace"
    );
    expect(withShadow.map((r) => r.id)).toContain("m_shadow");
  });
});
