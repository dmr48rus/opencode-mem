export const safeArray = (arr) => {
    if (!arr)
        return [];
    let result = arr;
    if (typeof result === "string") {
        try {
            result = JSON.parse(result);
        }
        catch {
            try {
                result = JSON.parse(result.trim().replace(/,$/, ""));
            }
            catch {
                return [];
            }
        }
    }
    if (!Array.isArray(result))
        return [];
    const flattened = [];
    const walk = (item) => {
        if (Array.isArray(item)) {
            item.forEach(walk);
        }
        else if (item) {
            flattened.push(item);
        }
    };
    walk(result);
    return flattened;
};
/**
 * Remove per-item embedding vectors (`centroid`/`anchor`) from profile data.
 *
 * Those 768-dim vectors are only used internally for similarity, dedup and
 * drift detection. Returning them to the model or the read-only API inflates
 * the payload by hundreds of KB, so callers that serialize profile data for
 * display must strip them first. Mutates in place and returns the same object.
 */
export const stripProfileEmbeddings = (data) => {
    if (!data || typeof data !== "object")
        return data;
    const container = data;
    for (const key of ["preferences", "patterns", "workflows"]) {
        const items = container[key];
        if (!Array.isArray(items))
            continue;
        for (const item of items) {
            if (item && typeof item === "object") {
                delete item.centroid;
                delete item.anchor;
            }
        }
    }
    return data;
};
/**
 * Clone profile data and strip embeddings for public responses.
 * Use this when the original object must keep embeddings (e.g. pending cleanups).
 */
export const toPublicProfileData = (data) => {
    return stripProfileEmbeddings(structuredClone(data));
};
export const safeObject = (obj, fallback) => {
    if (!obj)
        return fallback;
    let result = obj;
    if (typeof result === "string") {
        try {
            result = JSON.parse(result);
        }
        catch {
            return fallback;
        }
    }
    return result && typeof result === "object" && !Array.isArray(result) ? result : fallback;
};
