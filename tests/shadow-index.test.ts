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
    // of the model in charge is still passed - the tags channel needs it.
    const withShadow = await tursoVectorSearch.searchInShard(
      shard,
      axis(0, 768),
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
