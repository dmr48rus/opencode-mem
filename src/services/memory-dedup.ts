/**
 * Soft deduplication: mark the duplicates instead of deleting them.
 *
 * The fork's own deduplication removes the exact duplicates outright and only
 * reports the near ones. That is safe for the exact copies - they are the same
 * text - but it gives the near clusters no way to be acted on, and a deletion
 * is not undoable.
 *
 * Marking is the reversible form: the duplicate keeps its text and its vector,
 * `superseded_by` points at the record that replaces it, `confidence` records
 * how similar they were. Clearing the mark brings the record back.
 *
 * Only the cold clusters are touched. A duplicate of yesterday is still a
 * fresh thought, and the store is not a log: marking it would bury a
 * recent record under an older one.
 */
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { parseExtractedVector } from "./turso/vector-utils.js";

export type SoftDedupSample = {
  representative: string;
  duplicate: string;
  similarity: number;
  containerTag: string;
};

export type SoftDedupResult = {
  dryRun: boolean;
  coldDays: number;
  groups: number;
  marked: number;
  skippedWarm: number;
  skippedAlreadyMarked: number;
  samples: SoftDedupSample[];
};

export async function markNearDuplicates(
  options: { dryRun?: boolean; coldDays?: number; limit?: number } = {}
): Promise<SoftDedupResult> {
  const coldDays = Math.max(0, options.coldDays ?? 30);
  const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
  // A dry run is the default: marking the store is a decision, not a side
  // effect of asking.
  const dryRun = options.dryRun !== false;
  const cutoff = Date.now() - coldDays * 24 * 60 * 60 * 1000;

  await ensureTursoReady();
  const shards = [
    ...(await tursoShardManager.getAllShards("user", "")),
    ...(await tursoShardManager.getAllShards("project", "")),
  ];

  let marked = 0;
  let skippedWarm = 0;
  const skippedAlreadyMarked = 0;
  let groups = 0;
  const samples: SoftDedupSample[] = [];

  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const memories = await tursoVectorSearch.getAllMemoriesWithExtractedVectors(db);
    const byContent = new Map<string, typeof memories>();
    for (const memory of memories) {
      const key = `${memory.container_tag}:${memory.content}`;
      const bucket = byContent.get(key);
      if (bucket) bucket.push(memory);
      else byContent.set(key, [memory]);
    }
    // The exact duplicates are the hard deduplication's business; this pass
    // only looks at what is left.
    const unique = Array.from(byContent.values()).map((bucket) => bucket[0]!);
    const seen = new Set<string>();

    for (let i = 0; i < unique.length; i++) {
      const first = unique[i]!;
      const firstVector = parseExtractedVector(first.vector_json);
      if (!firstVector || seen.has(String(first.id))) continue;

      const cluster: Array<{ id: string; similarity: number; createdAt: number }> = [];

      for (let j = i + 1; j < unique.length; j++) {
        const second = unique[j]!;
        if (seen.has(String(second.id))) continue;
        if (first.container_tag !== second.container_tag) continue;
        const secondVector = parseExtractedVector(second.vector_json);
        if (!secondVector) continue;

        const similarity = cosineSimilarity(firstVector, secondVector);
        if (similarity < CONFIG.deduplicationSimilarityThreshold || similarity >= 1.0) continue;
        seen.add(String(second.id));
        cluster.push({
          id: String(second.id),
          similarity,
          createdAt: Number(second.created_at),
        });
      }

      if (cluster.length === 0) continue;

      // The canonical copy is the OLDEST one: a later copy of the same thing
      // is the duplicate. The order the rows come back in is not the order
      // they were written in, so the cluster is sorted by age - without that,
      // the mark lands on the original instead of the copy.
      const members = [
        { id: String(first.id), createdAt: Number(first.created_at), similarity: 1 },
        ...cluster,
      ].sort((a, b) => a.createdAt - b.createdAt);
      const canonical = members[0]!;
      const duplicates = members.slice(1);
      groups += 1;

      // A cluster is cold only when its NEWEST member is old. A cluster with
      // a member from this week is warm, and burying a fresh record under an
      // old one is worse than keeping a duplicate.
      const newest = members[members.length - 1]!.createdAt;
      if (newest > cutoff) {
        skippedWarm += duplicates.length;
        continue;
      }

      for (const member of duplicates) {
        if (marked >= limit) continue;
        if (!dryRun) {
          await tursoVectorSearch.markSuperseded(db, member.id, canonical.id, member.similarity);
        }
        marked += 1;
        if (samples.length < 10) {
          samples.push({
            representative: canonical.id,
            duplicate: member.id,
            similarity: Number(member.similarity.toFixed(3)),
            containerTag: String(first.container_tag),
          });
        }
      }
    }
  }

  log("Soft deduplication", { dryRun, coldDays, marked, skippedWarm, groups });
  return { dryRun, coldDays, groups, marked, skippedWarm, skippedAlreadyMarked, samples };
}
