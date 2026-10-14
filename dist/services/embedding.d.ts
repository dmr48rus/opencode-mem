declare const ONNX_DTYPE_VARIANTS: readonly [readonly ["fp32", ""], readonly ["fp16", "_fp16"], readonly ["q8", "_quantized"], readonly ["int8", "_int8"], readonly ["uint8", "_uint8"], readonly ["q4", "_q4"], readonly ["q4f16", "_q4f16"], readonly ["bnb4", "_bnb4"], readonly ["q2", "_q2"], readonly ["q2f16", "_q2f16"], readonly ["q1", "_q1"], readonly ["q1f16", "_q1f16"]];
/** Concrete dtype strings accepted by transformers.js `pipeline({ dtype })`. */
export type LocalOnnxDtype = (typeof ONNX_DTYPE_VARIANTS)[number][0] | "auto";
/**
 * Resolve a concrete dtype to pass into transformers.js `pipeline()`, or
 * undefined to leave dtype selection to transformers.js defaults / config.
 *
 * @param model Hugging Face model id (cache subdirectory under `.cache`)
 * @param cacheRoot Optional override for `{storagePath}/.cache` (tests)
 */
export declare function resolveLocalOnnxDtype(model: string, cacheRoot?: string): LocalOnnxDtype | undefined;
export type EmbeddingTask = "document" | "query";
export type EmbedOptions = {
    task?: EmbeddingTask;
};
export type EmbeddingTaskPrefixOptions = {
    useTaskPrefixes?: boolean;
    queryPrefix?: string;
    documentPrefix?: string;
};
/**
 * Resolve the prefix for a task: explicit/custom → Nomic (when enabled) → none.
 * Empty string means "no prefix" (disables Nomic fallback for that task).
 */
export declare function resolveEmbeddingTaskPrefix(task: EmbeddingTask, options?: EmbeddingTaskPrefixOptions): string;
/**
 * Apply task prefixes when configured.
 * Cache keys and API/local inputs should use the returned string.
 *
 * Third argument accepts the legacy boolean (`useTaskPrefixes`) or an options
 * object. Defaults read from CONFIG (custom/preset prefixes + Nomic flag).
 */
export declare function applyEmbeddingTaskPrefix(text: string, options?: EmbedOptions, useTaskPrefixesOrOpts?: boolean | EmbeddingTaskPrefixOptions): string;
type HfTransformers = typeof import("@huggingface/transformers");
declare let _transformers: {
    pipeline: HfTransformers["pipeline"];
    env: HfTransformers["env"];
} | null;
/**
 * Production transformers load path used by nested OpenCode install fixtures (#210).
 * Prefer this over a separately anchored createRequire() so empty-referrer hosts are covered.
 */
export declare function loadLocalTransformersBackend(): Promise<NonNullable<typeof _transformers>>;
/** Remote embedding call failed with an HTTP status. */
export declare class EmbeddingHttpError extends Error {
    readonly status: number;
    constructor(status: number, statusText: string);
}
/**
 * Perform a remote embedding request with bounded retries. Each attempt uses
 * AbortSignal.timeout so a hung connection is cancelled (not orphaned via
 * Promise.race); transient failures (network, abort/timeout, 429, 5xx) are
 * retried with linear backoff, everything else fails fast.
 *
 * `fetchImpl` is injectable for tests.
 */
export declare function fetchRemoteEmbeddingWithRetry(fetchImpl: typeof fetch, input: string, options?: {
    url?: string;
    apiKey?: string;
    model?: string;
    attemptTimeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
}): Promise<any>;
export declare class EmbeddingService {
    private pipe;
    private initPromise;
    isWarmedUp: boolean;
    /** Set when warmup fails permanently; prevents "initializing forever" (#184). */
    initError: string | null;
    private cache;
    private cachedFingerprint;
    static getInstance(): EmbeddingService;
    warmup(progressCallback?: (progress: any) => void): Promise<void>;
    private initializeModel;
    embed(text: string, options?: EmbedOptions): Promise<Float32Array>;
    embedWithTimeout(text: string, options?: EmbedOptions): Promise<Float32Array>;
    clearCache(): void;
}
export declare const embeddingService: EmbeddingService;
export {};
//# sourceMappingURL=embedding.d.ts.map