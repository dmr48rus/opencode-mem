export declare function vectorToJson(vector: Float32Array): string;
export declare function blobToFloat32Array(value: unknown): Float32Array | null;
/** Parse libSQL `vector_extract()` JSON output (preferred over raw F32_BLOB bytes). */
export declare function parseExtractedVector(value: unknown): Float32Array | null;
export declare function distanceToSimilarity(distance: number): number;
/**
 * BM25 over a shard's memories.
 *
 * `@tursodatabase/database` does not ship FTS5, so the lexical channel is
 * counted in process: one scan of the shard per query. Token rules match
 * `tokenizeQueryText` (the query side caps at 16 tokens, a document does not).
 *
 * shortcut: one full scan per query per shard. Acceptable up to ~50k rows in a
 * shard; beyond that the lexical channel has to move to a real index (upgrade
 * when a shard actually reaches that size).
 */
export type TokenizedDocument = {
    id: string;
    containerTag: string;
    counts: Map<string, number>;
    length: number;
};
export type LexicalCorpus = {
    documents: TokenizedDocument[];
    documentFrequency: Map<string, number>;
    averageLength: number;
};
/**
 * Tokenize the documents and collect the corpus statistics BM25 needs.
 *
 * The lexical channel runs on every query, so the tokenization and the
 * document frequencies belong to the corpus, not to the query. Re-tokenizing
 * 1500 documents per query is what made the hybrid search three times slower
 * (measured on the live server, 19.10.2026: p50 883 ms against 302 ms in
 * legacy mode).
 */
export declare function buildLexicalCorpus(docs: Array<{
    id: string;
    text: string;
    containerTag?: string;
}>): LexicalCorpus;
export declare function bm25Scores(corpus: LexicalCorpus, queryTokens: string[]): Map<string, number>;
/** Rank ids by score, best first. Ranks are 1-based; only positive scores take part. */
export declare function rankByScore(entries: Array<{
    id: string;
    score: number;
}>): Map<string, number>;
/**
 * Reciprocal rank fusion: the channels vote with ranks, not with scores.
 *
 * A weighted sum of scores lets one noisy signal decide the winner; a rank
 * cannot. `k` flattens the head - with k=10 a first place is worth 1/11 and a
 * tenth place 1/20, so a second channel can still lift a record that one
 * channel ranked low.
 */
export declare function rrfScore(rankChannels: Array<Map<string, number>>, k: number): Map<string, number>;
/** Canonical text used for tag-vector embeddings (must stay consistent across write paths). */
export declare function formatTagsForEmbedding(tags: string[]): string;
/** Split free text into lowercase tokens for keyword / hybrid search. */
export declare function tokenizeQueryText(text: string | undefined | null): string[];
/**
 * Escape LIKE wildcards so user tokens are matched literally.
 * Pair with `ESCAPE '\\'` in SQL.
 */
export declare function escapeLikePattern(token: string): string;
export declare function parseSessionIdFromMetadata(metadata: string | undefined | null): string | null;
//# sourceMappingURL=vector-utils.d.ts.map