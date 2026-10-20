import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Soft deduplication: the duplicates are marked, the originals stay, and the
// mark can be cleared. Only the cold clusters are touched - a cluster with a
// member from this week is warm.

describe("soft deduplication", () => {
  let dir: string | null = null;

  afterEach(async () => {
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await tursoConnectionManager.closeAll();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function fresh() {
    dir = mkdtempSync(join(tmpdir(), "soft-dedup-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = dir;
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const { markNearDuplicates } = await import("../src/services/memory-dedup.js");
    return {
      tursoShardManager,
      tursoConnectionManager,
      tursoVectorSearch,
      markNearDuplicates,
    };
  }

  const day = 24 * 60 * 60 * 1000;

  // Two nearly identical vectors: the cosine is just below 1, so the pair is a
  // near duplicate and not an exact one.
  function vectorA(): Float32Array {
    const vector = new Float32Array(768);
    vector[0] = 1;
    vector[1] = 0.01;
    return vector;
  }

  function vectorB(): Float32Array {
    const vector = new Float32Array(768);
    vector[0] = 0.999;
    vector[1] = 0.02;
    return vector;
  }

  it("marks a cold duplicate and keeps the original", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch, markNearDuplicates } =
      await fresh();
    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const old = Date.now() - 90 * day;

    await tursoVectorSearch.insertVector(db, {
      id: "m_original",
      content: "порядок сборки hermes и запуск шлюза",
      vector: vectorA(),
      containerTag,
      createdAt: old,
      updatedAt: old,
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m_duplicate",
      content: "порядок сборки hermes и запуск шлюза (повтор)",
      vector: vectorB(),
      containerTag,
      createdAt: old + 1000,
      updatedAt: old + 1000,
    } as any);

    // A dry run is the default and changes nothing.
    const dry = await markNearDuplicates({ dryRun: true, coldDays: 30 });
    expect(dry.dryRun).toBe(true);
    expect(dry.marked).toBe(1);
    const untouched = await db.get<{ superseded_by?: string }>(
      `SELECT superseded_by FROM memories WHERE id = ?`,
      ["m_duplicate"]
    );
    expect(untouched?.superseded_by ?? null).toBeNull();

    const applied = await markNearDuplicates({ dryRun: false, coldDays: 30 });
    expect(applied.marked).toBe(1);
    const marked = await db.get<{ superseded_by?: string; confidence?: number }>(
      `SELECT superseded_by, confidence FROM memories WHERE id = ?`,
      ["m_duplicate"]
    );
    expect(marked?.superseded_by).toBe("m_original");
    expect(Number(marked?.confidence)).toBeGreaterThan(0.9);
    // The original is still there - marking does not delete.
    const original = await db.get(`SELECT id FROM memories WHERE id = ?`, ["m_original"]);
    expect(original).toBeTruthy();
  });

  it("leaves a warm cluster alone", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch, markNearDuplicates } =
      await fresh();
    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const now = Date.now();

    await tursoVectorSearch.insertVector(db, {
      id: "m_fresh_a",
      content: "свежая запись про шлюз",
      vector: vectorA(),
      containerTag,
      createdAt: now,
      updatedAt: now,
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m_fresh_b",
      content: "свежая запись про шлюз (повтор)",
      vector: vectorB(),
      containerTag,
      createdAt: now + 1000,
      updatedAt: now + 1000,
    } as any);

    const report = await markNearDuplicates({ dryRun: false, coldDays: 30 });
    expect(report.marked).toBe(0);
    expect(report.skippedWarm).toBe(1);
    const row = await db.get<{ superseded_by?: string }>(
      `SELECT superseded_by FROM memories WHERE id = ?`,
      ["m_fresh_b"]
    );
    expect(row?.superseded_by ?? null).toBeNull();
  });
});
