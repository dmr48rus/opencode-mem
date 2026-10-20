import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import type { TursoDb, TursoTx } from "./turso-db.js";
/**
 * Rank fusion is opt-in: the legacy weighted sum stays the default until the
 * hybrid is measured on the live store.
 *
 *   OPENCODE_MEM_RRF=1    enable rank fusion
 *   OPENCODE_MEM_RRF_K   the flattening constant (default 10)
 */
export declare function isRrfMode(): boolean;
export declare function rrfK(): number;
/**
 * Fuse the channels with GLOBAL ranks.
 *
 * Ranks inside a shard are not comparable between shards: every shard has its
 * own hub (a long boilerplate record that is similar to everything), so the
 * best match on the whole corpus can be third inside its own shard. Measured on
 * the live corpus, 19.10.2026: fusing inside a shard gave hit@10 9/20 on
 * word-overlap questions and 15/28 on paraphrased ones, while the same fusion
 * over global ranks gives 20/20 and 19/28.
 */
export declare function fuseGlobalRanks(results: SearchResult[], lexicalRanks: Map<string, number>, k: number): void;
/**
 * How the shadow (second-model) index takes part in the search.
 *
 * - "off": the shadow is ignored; the search behaves exactly as before.
 * - "channel": the shadow votes as one more channel of the rank fusion.
 * - "replace": the shadow replaces the content channel of the model in charge.
 */
export type ShadowMode = "off" | "channel" | "replace";
export declare class TursoVectorSearch {
    private prepareShardDb;
    insertVectorInTransaction(tx: TursoTx, record: MemoryRecord): Promise<void>;
    insertVector(db: TursoDb, record: MemoryRecord): Promise<void>;
    /**
     * The shadow vector, if the record carries one.
     *
     * It lives in its own column with its own model id, so the model in charge
     * keeps answering queries with its own vectors while the shadow index is
     * still being filled.
     */
    private writeShadowVector;
    searchInShard(shard: ShardInfo, queryVector: Float32Array, containerTag: string, limit: number, queryText?: string, globalLexicalRanks?: Map<string, number>, shadowQueryVector?: Float32Array, shadowMode?: ShadowMode): Promise<SearchResult[]>;
    /**
     * Lexical ranking over a SET of shards, computed globally.
     *
     * Why global: BM25 ranks inside one shard are not comparable between shards.
     * Each shard would contribute its own local champion with the same RRF
     * score, and the merged list would fill with one record per project instead
     * of the records that actually match. Measured on the live corpus:
     * per-shard BM25 gives hit@10 8/28 on paraphrased questions, global BM25
     * 19/28.
     */
    globalLexicalRanks(shards: ShardInfo[], queryText: string | undefined): Promise<Map<string, number>>;
    /**
     * The tokenized corpus for the lexical channel.
     *
     * The driver has no FTS5, so BM25 is counted in process over this corpus.
     * The corpus is cached: reading and tokenizing every shard on every query is
     * what made the hybrid search three times slower. The cache is dropped on a
     * write, so a record that was just written is findable at once.
     * shortcut: the whole store is read per cache miss, capped above; a real
     * index is the upgrade when the store actually reaches the cap.
     */
    private lexicalCorpus;
    /**
     * Keyword recall for hybrid ranking.
     * `@tursodatabase/database` does not ship FTS5, so we use tokenized LIKE
     * over content/tags (bounded tokens, ESCAPE-safe).
     */
    private keywordScores;
    private exactScanKind;
    searchAcrossShards(shards: ShardInfo[], queryVector: Float32Array, containerTag: string, limit: number, similarityThreshold: number, queryText?: string): Promise<{
        results: SearchResult[];
        warnings: string[];
    }>;
    deleteVector(db: TursoDb, memoryId: string): Promise<void>;
    updateVector(db: TursoDb, memoryId: string, vector: Float32Array, tagsVector?: Float32Array): Promise<void>;
    listMemories(db: TursoDb, containerTag: string, limit: number, tagFilters?: string[]): Promise<Record<string, unknown>[]>;
    getAllMemories(db: TursoDb): Promise<Record<string, unknown>[]>;
    getAllMemoriesWithExtractedVectors(db: TursoDb): Promise<Array<Record<string, unknown> & {
        vector_json: string | null;
    }>>;
    getMemoryById(db: TursoDb, memoryId: string): Promise<Record<string, unknown> | null>;
    getMemoriesBySessionID(db: TursoDb, sessionID: string): Promise<Record<string, unknown>[]>;
    countVectors(db: TursoDb, containerTag: string): Promise<number>;
    countAllVectors(db: TursoDb): Promise<number>;
    getDistinctTags(db: TursoDb): Promise<Record<string, unknown>[]>;
    getProjectPathCounts(db: TursoDb): Promise<Array<{
        projectPath: string;
        count: number;
        containerTag: string | null;
    }>>;
    updateProjectAssociation(db: TursoDb, oldContainerTag: string, update: {
        containerTag: string;
        projectPath?: string;
        projectName?: string;
        displayName?: string;
        gitRepoUrl?: string | null;
    }): Promise<number>;
    pinMemory(db: TursoDb, memoryId: string): Promise<void>;
    unpinMemory(db: TursoDb, memoryId: string): Promise<void>;
}
export declare const tursoVectorSearch: TursoVectorSearch;
//# sourceMappingURL=vector-search.d.ts.map