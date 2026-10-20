import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store hygiene: a copy of a cold cluster is folded into its canonical
// copy, the records that contradict each other are flagged, and the profile
// item goes with the record that was forgotten.

describe("store hygiene", () => {
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
    dir = mkdtempSync(join(tmpdir(), "memory-hygiene-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = dir;
    // The profile may live on a remote store; the test keeps it local.
    (CONFIG.remoteStorage as any).enabled = false;
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const { markNearDuplicates } = await import("../src/services/memory-dedup.js");
    const { compactDuplicates, scanContradictions, forgetUnsupportedProfileItems } =
      await import("../src/services/memory-hygiene.js");
    const { userProfileManager } =
      await import("../src/services/user-profile/user-profile-manager.js");
    // The manager is a singleton: it has to be pointed at the new storage.
    userProfileManager.reset();
    return {
      tursoShardManager,
      tursoConnectionManager,
      tursoVectorSearch,
      markNearDuplicates,
      compactDuplicates,
      scanContradictions,
      forgetUnsupportedProfileItems,
      userProfileManager,
    };
  }

  const day = 24 * 60 * 60 * 1000;

  /** Two nearly identical vectors: the cosine is just below 1. */
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

  it("folds a cold duplicate into its canonical copy and brings it back", async () => {
    const {
      tursoShardManager,
      tursoConnectionManager,
      tursoVectorSearch,
      markNearDuplicates,
      compactDuplicates,
    } = await fresh();
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

    // The mark comes first: the compaction acts on what the marking found.
    const marked = await markNearDuplicates({ dryRun: false, coldDays: 30 });
    expect(marked.marked).toBe(1);

    // A dry run changes nothing.
    const dry = await compactDuplicates({ dryRun: true, coldDays: 30 });
    expect(dry.compacted).toBe(1);
    const untouched = await db.get<{ compacted_into?: string }>(
      `SELECT compacted_into FROM memories WHERE id = ?`,
      ["m_duplicate"]
    );
    expect(untouched?.compacted_into ?? null).toBeNull();

    const applied = await compactDuplicates({ dryRun: false, coldDays: 30 });
    expect(applied.compacted).toBe(1);
    const folded = await db.get<{ compacted_into?: string }>(
      `SELECT compacted_into FROM memories WHERE id = ?`,
      ["m_duplicate"]
    );
    expect(folded?.compacted_into).toBe("m_original");

    // The canonical copy stays and the copy stops being listed.
    const listed = await tursoVectorSearch.listMemories(db, "", 10);
    const ids = listed.map((row) => String(row.id));
    expect(ids).toContain("m_original");
    expect(ids).not.toContain("m_duplicate");

    // The fold is undone: the copy keeps its text and comes back.
    const restored = await compactDuplicates({ dryRun: false, restore: true });
    expect(restored.restored).toBe(1);
    const back = await db.get<{ compacted_into?: string }>(
      `SELECT compacted_into FROM memories WHERE id = ?`,
      ["m_duplicate"]
    );
    expect(back?.compacted_into ?? null).toBeNull();
  });

  it("flags the records that contradict each other and lifts the flag", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch, scanContradictions } =
      await fresh();
    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const now = Date.now();

    await tursoVectorSearch.insertVector(db, {
      id: "m_port_a",
      content: "порт панели управления в проекте hermes 9119",
      vector: vectorA(),
      containerTag,
      createdAt: now,
      updatedAt: now,
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m_port_b",
      content: "порт панели управления в проекте hermes 18801",
      vector: vectorB(),
      containerTag,
      createdAt: now + 1000,
      updatedAt: now + 1000,
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m_bun_a",
      content: "сборка hermes не требует установки пакета",
      vector: vectorA(),
      containerTag,
      createdAt: now + 2000,
      updatedAt: now + 2000,
    } as any);
    await tursoVectorSearch.insertVector(db, {
      id: "m_bun_b",
      content: "сборка hermes требует установки пакета",
      vector: vectorB(),
      containerTag,
      createdAt: now + 3000,
      updatedAt: now + 3000,
    } as any);

    // A dry run reports and changes nothing.
    const dry = await scanContradictions({ dryRun: true });
    expect(dry.pairs).toBe(2);
    const none = await db.all(`SELECT * FROM memory_conflicts`);
    expect(none.length).toBe(0);

    const applied = await scanContradictions({ dryRun: false });
    expect(applied.flagged).toBe(2);
    const rows = await db.all<{ kind: string; memory_id: string; other_id: string }>(
      `SELECT * FROM memory_conflicts`
    );
    expect(rows.length).toBe(2);
    const kinds = rows.map((row) => String(row.kind)).sort();
    expect(kinds).toEqual(["polarity", "value"]);
    // Both records of a pair stay in the store: a flag resolves nothing.
    const alive = await db.all(`SELECT id FROM memories`);
    expect(alive.length).toBe(4);

    // The flag is a note, and notes are lifted.
    const { handleClearConflicts } = await import("../src/services/api-handlers.js");
    const cleared = await handleClearConflicts({ memoryId: "m_port_a" });
    expect(cleared.success).toBe(true);
    const left = await db.all(`SELECT * FROM memory_conflicts`);
    expect(left.length).toBe(1);
  });

  it("takes the profile item with the record that was forgotten", async () => {
    const {
      tursoShardManager,
      tursoConnectionManager,
      tursoVectorSearch,
      forgetUnsupportedProfileItems,
      userProfileManager,
    } = await fresh();
    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const now = Date.now();

    await tursoVectorSearch.insertVector(db, {
      id: "m_preference",
      content: "пользователь предпочитает минимальные правки кода",
      vector: vectorA(),
      containerTag,
      createdAt: now,
      updatedAt: now,
    } as any);

    await userProfileManager.createProfile(
      "owner@local",
      "Owner",
      "owner",
      "owner@local",
      {
        preferences: [
          {
            category: "work",
            description: "пользователь предпочитает минимальные правки кода",
            confidence: 0.9,
            frequency: 3,
            evidence: [],
            lastSeen: now,
          },
        ],
        patterns: [],
        workflows: [],
      } as any,
      3
    );

    // The record is forgotten by the sweep.
    await db.run(`UPDATE memories SET aged_at = ? WHERE id = ?`, [now, "m_preference"]);

    const cleaned = await forgetUnsupportedProfileItems({ dryRun: false });
    expect(cleaned.removed).toBe(1);
    const profile = await userProfileManager.getActiveProfile("owner@local");
    const data = JSON.parse(profile!.profileData);
    expect(data.preferences.length).toBe(0);

    // The record comes back - and so does its item.
    await db.run(`UPDATE memories SET aged_at = NULL WHERE id = ?`, ["m_preference"]);
    const again = await forgetUnsupportedProfileItems({ dryRun: false });
    expect(again.restored).toBe(1);
    const restored = await userProfileManager.getActiveProfile("owner@local");
    const restoredData = JSON.parse(restored!.profileData);
    expect(restoredData.preferences.length).toBe(1);
  });
});
