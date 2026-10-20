import type { ShadowMode } from "./turso/vector-search.js";
export declare function shadowModelId(): string | undefined;
export declare function isShadowConfigured(): boolean;
/**
 * The mode of the shadow index, stored in the shard metadata.
 *
 * It is a stored value rather than a config value on purpose: the switch is a
 * decision about the data (the index is complete and the new model measures
 * better), and it must survive a restart without another deploy.
 */
export declare function getShadowMode(): Promise<ShadowMode>;
export declare function setShadowMode(mode: ShadowMode): Promise<void>;
export type ReindexReport = {
    model: string;
    processed: number;
    embedded: number;
    remaining: number;
    errors: string[];
    done: boolean;
};
/**
 * Embed the records that have no shadow vector yet.
 *
 * Bounded by `limit`, so the caller can drive it in steps: the model download
 * and 1500 embeddings take minutes, and one long HTTP request is a request
 * that times out.
 */
export declare function runShadowReindex(options?: {
    limit?: number;
    batchSize?: number;
}): Promise<ReindexReport>;
//# sourceMappingURL=memory-shadow.d.ts.map