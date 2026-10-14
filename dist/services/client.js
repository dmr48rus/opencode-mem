import { embeddingService } from "./embedding.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { formatTagsForEmbedding } from "./turso/vector-utils.js";
import { extractScopeFromContainerTag, resolveMemoryScope, } from "./memory-scope.js";
import { CONFIG } from "../config.js";
import { getRemoteStore, resetRemoteStore } from "./turso/remote-storage.js";
import { log } from "./logger.js";
/**
 * Remote storage lives at this seam, not in vector-search: the client is the
 * plugin's entire conversation with the store, and it is also the only place
 * that embeds. Routing here keeps roughly fifty call sites untouched and, more
 * to the point, is what lets this machine drop its local embedding model --
 * a facade below the embedding call would still load ONNX just to throw the
 * vector away.
 *
 * The client is built once and cached. resetRemoteStore() is called when the
 * plugin resets, so a changed configuration is picked up rather than silently
 * ignored for the rest of the session.
 */
function safeToISOString(timestamp) {
    try {
        if (timestamp === null || timestamp === undefined) {
            return new Date().toISOString();
        }
        const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);
        if (isNaN(numValue) || numValue < 0) {
            return new Date().toISOString();
        }
        return new Date(numValue).toISOString();
    }
    catch {
        return new Date().toISOString();
    }
}
function safeJSONParse(jsonString) {
    if (!jsonString || typeof jsonString !== "string") {
        return undefined;
    }
    try {
        return JSON.parse(jsonString);
    }
    catch {
        return undefined;
    }
}
function resolveScopeValue(scope, containerTag) {
    return resolveMemoryScope(scope, containerTag);
}
export class LocalMemoryClient {
    initPromise = null;
    isInitialized = false;
    constructor() { }
    async initialize() {
        if (this.isInitialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = (async () => {
            try {
                await ensureTursoReady();
                this.isInitialized = true;
            }
            catch (error) {
                this.initPromise = null;
                log("Turso initialization failed", { error: String(error) });
                throw error;
            }
        })();
        return this.initPromise;
    }
    async warmup(progressCallback) {
        await this.initialize();
        await embeddingService.warmup(progressCallback);
    }
    async isReady() {
        return this.isInitialized && embeddingService.isWarmedUp;
    }
    getEmbeddingInitError() {
        return embeddingService.initError;
    }
    getStatus() {
        return {
            dbConnected: this.isInitialized,
            modelLoaded: embeddingService.isWarmedUp,
            ready: this.isInitialized && embeddingService.isWarmedUp,
            embeddingError: embeddingService.initError,
        };
    }
    reset() {
        this.isInitialized = false;
        this.initPromise = null;
        resetRemoteStore();
    }
    async close() {
        const { closeTursoAndInvalidateCaches } = await import("./turso/lifecycle.js");
        await closeTursoAndInvalidateCaches();
        this.reset();
    }
    async searchMemories(query, containerTag, scope = "project") {
        try {
            const remote = getRemoteStore();
            if (remote) {
                // The server embeds the query, so this client needs no local model.
                // all-projects deliberately sends no tag: the endpoint then searches
                // every project shard, which is the same semantics the local path gets
                // from resolving the scope to all shards.
                const items = await remote.search(query, {
                    tags: scope === "all-projects" ? [] : [containerTag],
                    pageSize: CONFIG.maxMemories,
                });
                return { success: true, results: items, total: items.length, timing: 0 };
            }
            await this.initialize();
            const queryVector = await embeddingService.embedWithTimeout(query, { task: "query" });
            const resolved = resolveScopeValue(scope, containerTag);
            const shards = (await Promise.all(resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash)))).flat();
            if (shards.length === 0) {
                return { success: true, results: [], total: 0, timing: 0 };
            }
            const { results, warnings } = await tursoVectorSearch.searchAcrossShards(shards, queryVector, scope === "all-projects" ? "" : containerTag, CONFIG.maxMemories, CONFIG.similarityThreshold, query);
            return {
                success: true,
                results,
                total: results.length,
                timing: 0,
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("searchMemories: error", { error: errorMessage });
            return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
        }
    }
    async addMemory(content, containerTag, metadata) {
        try {
            const remote = getRemoteStore();
            if (remote) {
                // No local embedding: the server computes the vector on the way in, which
                // is what lets this machine drop its ONNX model entirely. The id comes
                // back from the server because it is the one that owns the record.
                const { displayName, userName, userEmail, projectPath, projectName, gitRepoUrl, type, tags: metaTags, ...dynamicMetadata } = metadata || {};
                const sessionId = typeof dynamicMetadata.sessionID === "string" ? dynamicMetadata.sessionID : undefined;
                const created = await remote.addMemory({
                    id: "",
                    content,
                    containerTag,
                    tags: metaTags,
                    type,
                    displayName,
                    userName,
                    userEmail,
                    projectPath,
                    projectName,
                    gitRepoUrl,
                    // metadata rides along so searchMemoriesBySessionID still finds this
                    // capture; without it the same conversation would be captured again.
                    sessionId,
                    metadata: dynamicMetadata,
                });
                return { success: true, id: created.id };
            }
            await this.initialize();
            const tags = metadata?.tags || [];
            const vector = await embeddingService.embedWithTimeout(content, { task: "document" });
            let tagsVector = undefined;
            if (tags.length > 0) {
                tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
                    task: "document",
                });
            }
            const { scope, hash } = extractScopeFromContainerTag(containerTag);
            return tursoShardManager.withScopeWriteLock(scope, hash, async () => {
                const shard = await tursoShardManager.getWriteShard(scope, hash);
                const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
                const now = Date.now();
                const { displayName, userName, userEmail, projectPath, projectName, gitRepoUrl, type, tags: _tags, ...dynamicMetadata } = metadata || {};
                const sessionId = typeof dynamicMetadata.sessionID === "string" ? dynamicMetadata.sessionID : undefined;
                const record = {
                    id,
                    content,
                    vector,
                    tagsVector,
                    containerTag,
                    tags: tags.length > 0 ? tags.join(",") : undefined,
                    type,
                    createdAt: now,
                    updatedAt: now,
                    displayName,
                    userName,
                    userEmail,
                    projectPath,
                    projectName,
                    gitRepoUrl,
                    sessionId,
                    metadata: Object.keys(dynamicMetadata).length > 0 ? JSON.stringify(dynamicMetadata) : undefined,
                };
                const db = await tursoConnectionManager.getConnection(shard.dbPath);
                await tursoVectorSearch.insertVector(db, record);
                await tursoShardManager.incrementVectorCount(shard.id);
                return {
                    success: true,
                    id,
                };
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("addMemory: error", { error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async deleteMemory(memoryId) {
        try {
            await this.initialize();
            const userShards = await tursoShardManager.getAllShards("user", "");
            const projectShards = await tursoShardManager.getAllShards("project", "");
            const allShards = [...userShards, ...projectShards];
            for (const shard of allShards) {
                const db = await tursoConnectionManager.getConnection(shard.dbPath);
                const memory = await tursoVectorSearch.getMemoryById(db, memoryId);
                if (memory) {
                    await tursoVectorSearch.deleteVector(db, memoryId);
                    await tursoShardManager.decrementVectorCount(shard.id);
                    return { success: true };
                }
            }
            return { success: false, error: "Memory not found" };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("deleteMemory: error", { memoryId, error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async listMemories(containerTag, limit = 20, scope = "project", tagFilters = []) {
        try {
            await this.initialize();
            const resolved = resolveScopeValue(scope, containerTag);
            const shards = (await Promise.all(resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash)))).flat();
            if (shards.length === 0) {
                return {
                    success: true,
                    memories: [],
                    pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
                };
            }
            const allMemories = [];
            for (const shard of shards) {
                const db = await tursoConnectionManager.getConnection(shard.dbPath);
                const memories = await tursoVectorSearch.listMemories(db, scope === "all-projects" ? "" : containerTag, limit, tagFilters);
                allMemories.push(...memories);
            }
            allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            const memories = allMemories.slice(0, limit).map((r) => ({
                id: r.id,
                summary: r.content,
                createdAt: safeToISOString(r.created_at),
                tags: r.tags
                    ? String(r.tags)
                        .split(",")
                        .map((t) => t.trim())
                        .filter((t) => t.length > 0)
                    : [],
                metadata: safeJSONParse(r.metadata),
                displayName: r.display_name,
                userName: r.user_name,
                userEmail: r.user_email,
                projectPath: r.project_path,
                projectName: r.project_name,
                gitRepoUrl: r.git_repo_url,
            }));
            return {
                success: true,
                memories,
                pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("listMemories: error", { error: errorMessage });
            return {
                success: false,
                error: errorMessage,
                memories: [],
                pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
            };
        }
    }
    async ensureStorageReady() {
        await this.initialize();
    }
    async listShards(currentDirectory) {
        try {
            await this.initialize();
            const { shardInventoryService } = await import("./shard-inventory-service.js");
            return await shardInventoryService.listShards(currentDirectory);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("listShards: error", { error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async migrateProjectPath(options) {
        try {
            await this.initialize();
            const { shardPathMigrationService } = await import("./shard-path-migration-service.js");
            return await shardPathMigrationService.migrate(options);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("migrateProjectPath: error", { error: errorMessage });
            return { success: false, dryRun: Boolean(options.dryRun), error: errorMessage };
        }
    }
    async exportMemories(currentDirectory, outputPath) {
        try {
            await this.initialize();
            const { memoryPortabilityService } = await import("./memory-portability-service.js");
            return await memoryPortabilityService.exportMemories({ currentDirectory, outputPath });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("exportMemories: error", { error: errorMessage });
            return { success: false, error: errorMessage };
        }
    }
    async importMemories(currentDirectory, inputPath, dryRun) {
        try {
            await this.initialize();
            const { memoryPortabilityService } = await import("./memory-portability-service.js");
            return await memoryPortabilityService.importMemories({
                currentDirectory,
                inputPath,
                dryRun,
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("importMemories: error", { error: errorMessage });
            return { success: false, dryRun: Boolean(dryRun), error: errorMessage };
        }
    }
    async searchMemoriesBySessionID(sessionID, containerTag, limit = 10) {
        try {
            await this.initialize();
            const { scope, hash } = extractScopeFromContainerTag(containerTag);
            const shards = await tursoShardManager.getAllShards(scope, hash);
            if (shards.length === 0) {
                return { success: true, results: [], total: 0, timing: 0 };
            }
            const allMemories = [];
            for (const shard of shards) {
                const db = await tursoConnectionManager.getConnection(shard.dbPath);
                const memories = await tursoVectorSearch.getMemoriesBySessionID(db, sessionID);
                allMemories.push(...memories);
            }
            allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            const results = allMemories.slice(0, limit).map((row) => ({
                id: row.id,
                memory: row.content,
                similarity: 1.0,
                tags: row.tags || [],
                metadata: row.metadata || {},
                containerTag: row.container_tag,
                displayName: row.display_name,
                userName: row.user_name,
                userEmail: row.user_email,
                projectPath: row.project_path,
                projectName: row.project_name,
                gitRepoUrl: row.git_repo_url,
                createdAt: row.created_at,
            }));
            return { success: true, results, total: results.length, timing: 0 };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("searchMemoriesBySessionID: error", { error: errorMessage });
            return { success: false, error: errorMessage, results: [], total: 0, timing: 0 };
        }
    }
}
export const memoryClient = new LocalMemoryClient();
