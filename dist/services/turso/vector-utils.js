export function vectorToJson(vector) {
    return JSON.stringify(Array.from(vector));
}
export function blobToFloat32Array(value) {
    if (value == null)
        return null;
    try {
        if (value instanceof Float32Array) {
            return value;
        }
        if (value instanceof ArrayBuffer) {
            if (value.byteLength === 0 || value.byteLength % 4 !== 0) {
                return null;
            }
            return new Float32Array(value);
        }
        if (ArrayBuffer.isView(value)) {
            const view = value;
            const byteLength = view.byteLength;
            if (byteLength === 0 || byteLength % 4 !== 0) {
                return null;
            }
            return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
        }
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value);
                return new Float32Array(parsed);
            }
            catch {
                return null;
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
/** Parse libSQL `vector_extract()` JSON output (preferred over raw F32_BLOB bytes). */
export function parseExtractedVector(value) {
    if (value == null)
        return null;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed) || parsed.length === 0)
                return null;
            return new Float32Array(parsed);
        }
        catch {
            return null;
        }
    }
    return blobToFloat32Array(value);
}
export function distanceToSimilarity(distance) {
    const similarity = 1 - Number(distance);
    if (!Number.isFinite(similarity))
        return 0;
    // Clamp float artifacts (docs: cos-distance can be slightly negative near exact matches).
    return Math.max(0, Math.min(1, similarity));
}
/**
 * Tokenize the documents and collect the corpus statistics BM25 needs.
 *
 * The lexical channel runs on every query, so the tokenization and the
 * document frequencies belong to the corpus, not to the query. Re-tokenizing
 * 1500 documents per query is what made the hybrid search three times slower
 * (measured on the live server, 19.10.2026: p50 883 ms against 302 ms in
 * legacy mode).
 */
export function buildLexicalCorpus(docs) {
    const documentFrequency = new Map();
    const documents = [];
    let totalLength = 0;
    for (const doc of docs) {
        const tokens = doc.text
            .toLowerCase()
            .split(/[\s,._/-]+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 1);
        const counts = new Map();
        for (const token of tokens)
            counts.set(token, (counts.get(token) ?? 0) + 1);
        for (const token of counts.keys()) {
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
        totalLength += tokens.length;
        documents.push({
            id: doc.id,
            containerTag: doc.containerTag ?? "",
            counts,
            length: tokens.length,
        });
    }
    const averageLength = documents.length ? totalLength / documents.length : 1;
    return { documents, documentFrequency, averageLength };
}
export function bm25Scores(corpus, queryTokens) {
    const scores = new Map();
    if (queryTokens.length === 0 || corpus.documents.length === 0)
        return scores;
    const k1 = 1.2;
    const b = 0.75;
    const total = corpus.documents.length;
    for (const doc of corpus.documents) {
        let score = 0;
        for (const token of queryTokens) {
            const frequency = doc.counts.get(token);
            if (!frequency)
                continue;
            const df = corpus.documentFrequency.get(token) ?? 0;
            const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
            const denominator = frequency + k1 * (1 - b + (b * doc.length) / corpus.averageLength);
            score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0)
            scores.set(doc.id, score);
    }
    return scores;
}
/** Rank ids by score, best first. Ranks are 1-based; only positive scores take part. */
export function rankByScore(entries) {
    const ranks = new Map();
    entries
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .forEach((entry, index) => ranks.set(entry.id, index + 1));
    return ranks;
}
/**
 * Reciprocal rank fusion: the channels vote with ranks, not with scores.
 *
 * A weighted sum of scores lets one noisy signal decide the winner; a rank
 * cannot. `k` flattens the head - with k=10 a first place is worth 1/11 and a
 * tenth place 1/20, so a second channel can still lift a record that one
 * channel ranked low.
 */
export function rrfScore(rankChannels, k) {
    const scores = new Map();
    for (const ranks of rankChannels) {
        for (const [id, rank] of ranks) {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
        }
    }
    return scores;
}
/** Canonical text used for tag-vector embeddings (must stay consistent across write paths). */
export function formatTagsForEmbedding(tags) {
    return `Topics: ${tags.join(", ")}`;
}
/** Split free text into lowercase tokens for keyword / hybrid search. */
export function tokenizeQueryText(text) {
    if (!text)
        return [];
    return text
        .toLowerCase()
        .split(/[\s,._/-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1)
        .slice(0, 16);
}
/**
 * Escape LIKE wildcards so user tokens are matched literally.
 * Pair with `ESCAPE '\\'` in SQL.
 */
export function escapeLikePattern(token) {
    return token.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
export function parseSessionIdFromMetadata(metadata) {
    if (!metadata)
        return null;
    try {
        const parsed = JSON.parse(metadata);
        return typeof parsed.sessionID === "string" && parsed.sessionID.length > 0
            ? parsed.sessionID
            : null;
    }
    catch {
        return null;
    }
}
