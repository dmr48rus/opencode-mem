/**
 * The shadow index: a second embedding model, filling a parallel column.
 *
 * Why a parallel column and not a replacement: the store is shared and live.
 * Replacing the vectors in place would leave a window where the stored
 * vectors and the query vector have different widths - the search would fail
 * loudly and the store would be unreadable. A parallel column keeps the model
 * in charge serving queries while the shadow index is filled, and the switch
 * is then one flag, reversible at any moment.
 *
 * Measured 20.10.2026 on the live corpus (1503 records): a multilingual model
 * takes the semantic slice from 16/28 to 21/28 (offline, together with the
 * lexical channel), while the current English-only model adds nothing over
 * that channel alone.
 */
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { getShadowEmbeddingService } from "./embedding.js";
import { vectorToJson } from "./turso/vector-utils.js";
const MODE_KEY = "embedding_shadow_mode";
const MODES = ["off", "channel", "replace"];
export function shadowModelId() {
    return CONFIG.embeddingShadowModel;
}
export function isShadowConfigured() {
    return Boolean(CONFIG.embeddingShadowModel);
}
async function allShards() {
    return [
        ...(await tursoShardManager.getAllShards("user", "")),
        ...(await tursoShardManager.getAllShards("project", "")),
    ];
}
/**
 * The mode of the shadow index, stored in the shard metadata.
 *
 * It is a stored value rather than a config value on purpose: the switch is a
 * decision about the data (the index is complete and the new model measures
 * better), and it must survive a restart without another deploy.
 */
export async function getShadowMode() {
    try {
        await ensureTursoReady();
        const shards = await allShards();
        for (const shard of shards) {
            const db = await tursoConnectionManager.getConnection(shard.dbPath);
            const row = await db.get(`SELECT value FROM shard_metadata WHERE key = ?`, [MODE_KEY]);
            const value = String(row?.value ?? "off");
            if (MODES.includes(value))
                return value;
        }
    }
    catch (error) {
        log("Shadow mode: could not be read", { error: String(error) });
    }
    return "off";
}
export async function setShadowMode(mode) {
    if (!MODES.includes(mode))
        throw new Error(`Unknown shadow mode: ${mode}`);
    await ensureTursoReady();
    const shards = await allShards();
    for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        await db.execute(`INSERT OR REPLACE INTO shard_metadata (key, value) VALUES (?, ?)`, [
            MODE_KEY,
            mode,
        ]);
    }
    log("Shadow mode changed", { mode, shards: shards.length });
}
/**
 * Embed the records that have no shadow vector yet.
 *
 * Bounded by `limit`, so the caller can drive it in steps: the model download
 * and 1500 embeddings take minutes, and one long HTTP request is a request
 * that times out.
 */
export async function runShadowReindex(options = {}) {
    await ensureTursoReady();
    const model = CONFIG.embeddingShadowModel;
    if (!model)
        throw new Error("No shadow model configured (embeddingShadowModel)");
    const service = getShadowEmbeddingService();
    if (!service)
        throw new Error("Shadow embedding service is not available");
    const limit = Math.max(1, Math.min(5000, options.limit ?? 100));
    const batchSize = Math.max(1, Math.min(64, options.batchSize ?? 16));
    const shards = await allShards();
    let processed = 0;
    let embedded = 0;
    let remaining = 0;
    const errors = [];
    await service.warmup();
    for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        await tursoShardManager.ensureShardSchema(db);
        // Records whose shadow vector came from another model are re-embedded:
        // a model swap has to reach the whole corpus, not only the empty cells.
        const pending = await db.all(`SELECT id, content FROM memories
       WHERE aged_at IS NULL
         AND (shadow_vector IS NULL OR shadow_model IS NULL OR shadow_model != ?)
       LIMIT ?`, [model, limit - processed]);
        const left = await db.get(`SELECT COUNT(*) AS n FROM memories
       WHERE aged_at IS NULL
         AND (shadow_vector IS NULL OR shadow_model IS NULL OR shadow_model != ?)`, [model]);
        remaining += Number(left?.n ?? 0);
        if (pending.length === 0)
            continue;
        const texts = pending.map((row) => String(row.content ?? ""));
        const vectors = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            const chunk = texts.slice(i, i + batchSize);
            for (const text of chunk) {
                try {
                    vectors.push(await service.embed(text, { task: "document" }));
                }
                catch (error) {
                    errors.push(String(error).slice(0, 200));
                    vectors.push(new Float32Array(0));
                }
            }
        }
        for (let i = 0; i < pending.length; i++) {
            const row = pending[i];
            if (!row)
                continue;
            const vector = vectors[i];
            if (!vector || vector.length === 0)
                continue;
            try {
                await tursoShardManager.withScopeWriteLock(shard.scope, shard.scopeHash, async () => {
                    await db.execute(`UPDATE memories SET shadow_vector = ?, shadow_model = ? WHERE id = ?`, [
                        vectorToJson(vector),
                        model,
                        String(row.id),
                    ]);
                });
                embedded += 1;
            }
            catch (error) {
                errors.push(String(error).slice(0, 200));
            }
            processed += 1;
        }
    }
    return {
        model,
        processed,
        embedded,
        remaining,
        errors: errors.slice(0, 10),
        done: remaining === 0,
    };
}
