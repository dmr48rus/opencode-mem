export declare const safeArray: <T>(arr: any) => T[];
/**
 * Remove per-item embedding vectors (`centroid`/`anchor`) from profile data.
 *
 * Those 768-dim vectors are only used internally for similarity, dedup and
 * drift detection. Returning them to the model or the read-only API inflates
 * the payload by hundreds of KB, so callers that serialize profile data for
 * display must strip them first. Mutates in place and returns the same object.
 */
export declare const stripProfileEmbeddings: <T>(data: T) => T;
/**
 * Clone profile data and strip embeddings for public responses.
 * Use this when the original object must keep embeddings (e.g. pending cleanups).
 */
export declare const toPublicProfileData: <T>(data: T) => T;
export declare const safeObject: <T extends object>(obj: any, fallback: T) => T;
//# sourceMappingURL=profile-utils.d.ts.map