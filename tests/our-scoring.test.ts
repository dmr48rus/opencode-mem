import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

// The hybrid blend used to charge the full tags weight to rows that have no
// tags vector at all. An untagged memory could then reach 0.5 and nothing
// more, below the default 0.6 threshold, so it was stored and never read back
// - not even by a query repeating its own words. These cover the regression:
// a strong content match on an untagged memory must survive the threshold,
// while an unrelated memory must still be filtered out.
describe("hybrid scoring renormalizes over present signals", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  async function seed() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-scoring-"));

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

  function axisVector(index: number): Float32Array {
    const vector = new Float32Array(768);
    vector[index] = 1;
    return vector;
  }

  const THRESHOLD = 0.6;

  it("returns an untagged memory on a content match", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    // No tags, no tagsVector: the row that used to be unreachable.
    await tursoVectorSearch.insertVector(db, {
      id: "m_untagged",
      content: "порядок сборки hermes и запуск шлюза",
      vector: axisVector(0),
      containerTag,
    } as any);
    // Orthogonal vector, still untagged: must stay out.
    await tursoVectorSearch.insertVector(db, {
      id: "m_unrelated",
      content: "рецепт приготовления борща",
      vector: axisVector(1),
      containerTag,
    } as any);

    const results = await tursoVectorSearch.searchAcrossShards(
      [shard],
      axisVector(0),
      containerTag,
      10,
      THRESHOLD,
      "слова_которых_нет_в_тексте"
    );

    expect(results.results.map((r) => r.id)).toEqual(["m_untagged"]);
  });

  it("keeps a tagged memory reachable and does not demote it", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    await tursoVectorSearch.insertVector(db, {
      id: "m_tagged",
      content: "деплой hermes",
      vector: axisVector(0),
      tagsVector: axisVector(0),
      containerTag,
      tags: "deploy",
    } as any);

    const results = await tursoVectorSearch.searchAcrossShards(
      [shard],
      axisVector(0),
      containerTag,
      10,
      THRESHOLD,
      "deploy"
    );

    expect(results.results.map((r) => r.id)).toEqual(["m_tagged"]);
    // All three signals present: the blend is unchanged, still a full 1.0.
    expect(results.results[0]?.similarity).toBeCloseTo(1, 5);
  });

  it("does not lift a weak match over the threshold", async () => {
    const { tursoShardManager, tursoConnectionManager, tursoVectorSearch } = await seed();

    const containerTag = "opencode_project_abcdef1234567890";
    const shard = await tursoShardManager.createShard("project", "abcdef1234567890", 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    // 60 degrees off the query axis: cosine 0.5, so the untagged row scores
    // 0.5 and must still be below the threshold. Renormalizing must not
    // become a blanket "return everything".
    const weak = new Float32Array(768);
    weak[0] = 0.5;
    weak[1] = Math.sqrt(3) / 2;
    await tursoVectorSearch.insertVector(db, {
      id: "m_weak",
      content: "что-то частично похожее",
      vector: weak,
      containerTag,
    } as any);

    const results = await tursoVectorSearch.searchAcrossShards(
      [shard],
      axisVector(0),
      containerTag,
      10,
      THRESHOLD,
      "слов_нет"
    );

    expect(results.results).toHaveLength(0);
  });
});
