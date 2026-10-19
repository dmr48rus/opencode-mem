import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import type { TursoDb, TursoTx } from "./turso-db.js";
export declare class TursoVectorSearch {
    private prepareShardDb;
    insertVectorInTransaction(tx: TursoTx, record: MemoryRecord): Promise<void>;
    insertVector(db: TursoDb, record: MemoryRecord): Promise<void>;
    searchInShard(shard: ShardInfo, queryVector: Float32Array, containerTag: string, limit: number, queryText?: string, globalLexicalRanks?: Map<string, number>): Promise<SearchResult[]>;
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
    globalLexicalRanks(shards: ShardInfo[], queryText: string | undefined, containerTag?: string): Promise<Map<string, number>>;
    /**
     * Documents for the lexical channel: id + content + tags.
     *
     * The driver has no FTS5, so BM25 is counted in process over this list.
     * shortcut: the whole shard is read per query, capped above; a real index is
     * the upgrade when a shard actually reaches the cap.
     */
    private lexicalDocs;
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