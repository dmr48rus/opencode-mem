/**
 * Tier-aware aging: what may be forgotten, and when.
 *
 * The fork's own cleanup deletes by age alone, so a captured conversation and
 * a recorded decision age the same way. The tiers follow ai-memory: episodic
 * (what happened) fades, semantic (what was decided) never goes, procedural
 * (how it is done) goes late. Pinned records are exempt from everything.
 *
 * Forgetting here is a tombstone, not a delete: the record keeps its content
 * and its vector, and clearing the marker brings it back. The hard delete
 * stays available in the fork's cleanup - the sweep is the reversible one.
 *
 * shortcut: the decay uses the age and the type only. Access-weighted
 * retention (ai-memory) needs counters of how often a record was recalled, and
 * the fork does not keep them; add them when the tiers are in use and the
 * cold-but-used records start being swept.
 */
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { log } from "./logger.js";
/** Facts and decisions: what the store is for, and they never go. */
const SEMANTIC_TYPES = new Set([
    "fact",
    "facts",
    "decision",
    "decisions",
    "lesson",
    "lessons",
    "summary",
    "success",
    "outcome",
    "preference",
    "architecture",
    "architecture-decision",
    "technical-decision",
    "rule",
    "convention",
]);
/** How it was done: goes late, because it is worth keeping while it works. */
const PROCEDURAL_TYPES = new Set([
    "technical",
    "tech",
    "technical-work",
    "technical-analysis",
    "config",
    "configuration",
    "documentation",
    "docs",
    "docs-processing",
    "docs-fix",
    "document",
    "document-processing",
    "code",
    "code_change",
    "code-change",
    "refactoring",
    "optimization",
    "test",
    "research",
    "analysis",
    "verification",
    "project-verification",
    "project-check",
    "inspection",
    "bug-fix",
    "bugfix",
    "debugging",
    "diagnostics",
    "diagnosis",
    "cleanup",
    "feature",
    "automation",
    "capability",
    "record",
    "workflow-rule",
    "translation",
    "literary-translation",
    "save",
]);
export function classifyTier(type) {
    const key = String(type ?? "")
        .trim()
        .toLowerCase();
    if (SEMANTIC_TYPES.has(key))
        return "semantic";
    if (PROCEDURAL_TYPES.has(key))
        return "procedural";
    return "episodic";
}
const DAY_MS = 24 * 60 * 60 * 1000;
export async function runMemorySweep(options = {}) {
    await ensureTursoReady();
    const episodicDays = options.episodicDays ?? 30;
    const proceduralDays = options.proceduralDays ?? 180;
    const dryRun = options.dryRun !== false;
    const limit = Math.max(1, Math.min(10000, options.limit ?? 1000));
    const shards = [
        ...(await tursoShardManager.getAllShards("user", "")),
        ...(await tursoShardManager.getAllShards("project", "")),
    ];
    const now = Date.now();
    const byTier = { semantic: 0, procedural: 0, episodic: 0 };
    const candidates = [];
    let scanned = 0;
    for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        // The sweep reads a column added by a migration, so the schema has to be
        // current before the query - a shard that was never searched would not
        // have it yet.
        await tursoShardManager.ensureShardSchema(db);
        const rows = await db.all(`SELECT id, type, created_at FROM memories
       WHERE is_pinned = 0 AND aged_at IS NULL`);
        for (const row of rows) {
            scanned += 1;
            const tier = classifyTier(row.type);
            byTier[tier] += 1;
            if (tier === "semantic")
                continue;
            const ageDays = Math.floor((now - Number(row.created_at ?? now)) / DAY_MS);
            const threshold = tier === "procedural" ? proceduralDays : episodicDays;
            if (ageDays < threshold)
                continue;
            candidates.push({
                id: String(row.id),
                tier,
                ageDays,
                type: row.type ? String(row.type) : undefined,
                dbPath: shard.dbPath,
            });
        }
    }
    const selected = candidates.slice(0, limit);
    let aged = 0;
    if (!dryRun && selected.length > 0) {
        for (const candidate of selected) {
            // The write lock is taken on the shard that actually holds the record.
            const shard = shards.find((candidateShard) => candidateShard.dbPath === candidate.dbPath);
            if (!shard)
                continue;
            const db = await tursoConnectionManager.getConnection(shard.dbPath);
            try {
                await tursoShardManager.withScopeWriteLock(shard.scope, shard.scopeHash, async () => {
                    await db.run(`UPDATE memories SET aged_at = ? WHERE id = ? AND aged_at IS NULL`, [
                        now,
                        candidate.id,
                    ]);
                });
                aged += 1;
            }
            catch (error) {
                log("Memory sweep: could not age a record", {
                    id: candidate.id,
                    error: String(error),
                });
            }
        }
    }
    return {
        dryRun,
        scanned,
        byTier,
        aged,
        candidates: selected.map((candidate) => ({
            id: candidate.id,
            tier: candidate.tier,
            ageDays: candidate.ageDays,
            type: candidate.type,
        })),
    };
}
