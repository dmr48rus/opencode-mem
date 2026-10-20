import { tursoConnectionManager } from "./connection-manager.js";
import { tursoShardManager } from "./shard-manager.js";
import { log } from "../logger.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import {
  bm25Scores,
  buildLexicalCorpus,
  distanceToSimilarity,
  escapeLikePattern,
  parseSessionIdFromMetadata,
  rankByScore,
  rrfScore,
  tokenizeQueryText,
  vectorToJson,
  type LexicalCorpus,
} from "./vector-utils.js";
import type { SqlValue, TursoDb, TursoTx } from "./turso-db.js";

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Rows read per query for the BM25 channel. */
const LEXICAL_SCAN_LIMIT = 50000;

/**
 * The lexical index is a cache, not a scan.
 *
 * Reading every shard on every query cost two dozen round trips and made the
 * search three times slower: measured on the live server, 19.10.2026, p50 883 ms
 * against 302 ms in legacy mode. The corpus changes rarely, so the tokenized
 * corpus is cached and dropped when a record is written.
 */
const LEXICAL_CACHE_TTL_MS = 60_000;
let globalLexicalCorpus: { corpus: LexicalCorpus; builtAt: number } | null = null;

/**
 * Rank fusion is opt-in: the legacy weighted sum stays the default until the
 * hybrid is measured on the live store.
 *
 *   OPENCODE_MEM_RRF=1    enable rank fusion
 *   OPENCODE_MEM_RRF_K   the flattening constant (default 10)
 */
export function isRrfMode(): boolean {
  const value = (process.env.OPENCODE_MEM_RRF ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function rrfK(): number {
  const raw = Number(process.env.OPENCODE_MEM_RRF_K);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

function resolveSessionId(record: MemoryRecord): string | null {
  if (record.sessionId && record.sessionId.length > 0) return record.sessionId;
  return parseSessionIdFromMetadata(record.metadata);
}

function insertArgs(record: MemoryRecord, contentVector: string, tagsVectorJson: string | null) {
  return [
    record.id,
    record.content,
    contentVector,
    ...(tagsVectorJson ? [tagsVectorJson] : []),
    record.containerTag,
    record.tags || null,
    record.type || null,
    record.createdAt,
    record.updatedAt,
    record.metadata || null,
    resolveSessionId(record),
    record.displayName || null,
    record.userName || null,
    record.userEmail || null,
    record.projectPath || null,
    record.projectName || null,
    record.gitRepoUrl || null,
  ];
}

const INSERT_WITH_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), vector32(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_WITHOUT_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

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
export function fuseGlobalRanks(
  results: SearchResult[],
  lexicalRanks: Map<string, number>,
  k: number,
  shadowMode: ShadowMode = "off"
): void {
  // The shadow replaces the model in charge, and the replacement has to reach
  // this fusion too: measured on the live corpus, the shadow was counted
  // inside the shard and then overwritten here by the old model's distance, so
  // the whole switch had no effect (34/48 against 36/48).
  const useShadow = shadowMode !== "off";
  const contentRanks = rankByScore(
    results.map((result) => ({
      id: result.id,
      score: useShadow ? (result.shadowSim ?? 0) : (result.contentSim ?? 0),
    }))
  );
  const tagRanks = rankByScore(
    results.map((result) => ({ id: result.id, score: result.tagsSim ?? 0 }))
  );
  const shadowRanks = useShadow
    ? rankByScore(results.map((result) => ({ id: result.id, score: result.shadowSim ?? 0 })))
    : new Map<string, number>();
  for (const result of results) {
    let score = 0;
    const contentRank = contentRanks.get(result.id);
    if (contentRank) score += 1 / (k + contentRank);
    if (shadowMode === "channel") {
      const shadowRank = shadowRanks.get(result.id);
      if (shadowRank) score += 1 / (k + shadowRank);
      const tagRank = tagRanks.get(result.id);
      if (tagRank) score += 1 / (k + tagRank);
    } else if (shadowMode !== "replace") {
      const tagRank = tagRanks.get(result.id);
      if (tagRank) score += 1 / (k + tagRank);
    }
    const lexicalRank = lexicalRanks.get(result.id);
    if (lexicalRank) score += 1 / (k + lexicalRank);
    result.similarity = score;
  }
}

/**
 * How the shadow (second-model) index takes part in the search.
 *
 * - "off": the shadow is ignored; the search behaves exactly as before.
 * - "channel": the shadow votes as one more channel of the rank fusion.
 * - "replace": the shadow replaces the content channel of the model in charge.
 */
export type ShadowMode = "off" | "channel" | "replace";

export class TursoVectorSearch {
  private async prepareShardDb(db: TursoDb): Promise<void> {
    await tursoShardManager.ensureShardSchema(db);
  }

  async insertVectorInTransaction(tx: TursoTx, record: MemoryRecord): Promise<void> {
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await tx.execute({
        sql: INSERT_WITH_TAGS,
        args: insertArgs(record, contentVector, vectorToJson(record.tagsVector)),
      });
      return;
    }

    await tx.execute({
      sql: INSERT_WITHOUT_TAGS,
      args: insertArgs(record, contentVector, null),
    });
  }

  async insertVector(db: TursoDb, record: MemoryRecord): Promise<void> {
    await this.prepareShardDb(db);
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await db.execute(
        INSERT_WITH_TAGS,
        insertArgs(record, contentVector, vectorToJson(record.tagsVector))
      );
      await this.writeShadowVector(db, record);
      globalLexicalCorpus = null;
      return;
    }

    await db.execute(INSERT_WITHOUT_TAGS, insertArgs(record, contentVector, null));
    await this.writeShadowVector(db, record);
    globalLexicalCorpus = null;
  }

  /**
   * The shadow vector, if the record carries one.
   *
   * It lives in its own column with its own model id, so the model in charge
   * keeps answering queries with its own vectors while the shadow index is
   * still being filled.
   */
  private async writeShadowVector(db: TursoDb, record: MemoryRecord): Promise<void> {
    if (!record.shadowVector) return;
    await db.execute(`UPDATE memories SET shadow_vector = ?, shadow_model = ? WHERE id = ?`, [
      vectorToJson(record.shadowVector),
      record.shadowModel ?? "",
      record.id,
    ]);
  }
  async searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array | undefined,
    containerTag: string,
    limit: number,
    queryText?: string,
    globalLexicalRanks?: Map<string, number>,
    shadowQueryVector?: Float32Array,
    shadowMode: ShadowMode = "off"
  ): Promise<SearchResult[]> {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await this.prepareShardDb(db);
    // Empty when the model in charge is replaced: its distances are not
    // computed at all, so the query vector is not needed.
    const queryJson = queryVector ? vectorToJson(queryVector) : "";
    // Exact cosine already returns the best-k rows; over-fetch a little so
    // content+tags+keyword candidates can merge before hybrid re-rank.
    const k = Math.max(limit * 2, 32);

    const queryWords = tokenizeQueryText(queryText);
    const hasKeyword = queryWords.length > 0;
    // Rank fusion is opt-in: the legacy weighted sum stays the default until
    // the hybrid is measured on the live store.
    const rrfMode = hasKeyword && isRrfMode();

    // The shadow is asked for its own candidates: its vectors have another
    // width, so the current query vector cannot stand in for it.
    const shadowActive = shadowMode !== "off" && !!shadowQueryVector;
    const shadowJson = shadowActive ? vectorToJson(shadowQueryVector as Float32Array) : "";

    // The candidates come from the channels that actually answer. In
    // "replace" mode the model in charge has no query vector at all (its
    // channel is not used), and asking it for candidates with a vector of
    // another width is an error, not an empty list - so the shadow is asked
    // instead. Measured: with the old candidates the search returned nothing.
    const legacyChannels = shadowMode !== "replace";
    const contentResults = legacyChannels
      ? await this.exactScanKind(db, queryJson, k, containerTag, "vector")
      : [];
    const tagsResults = legacyChannels
      ? await this.exactScanKind(db, queryJson, k, containerTag, "tags_vector")
      : [];
    const shadowResults = shadowActive
      ? await this.exactScanKind(db, shadowJson, k, containerTag, "shadow_vector")
      : [];
    // In rank-fusion mode the LIKE keyword channel is replaced by BM25, so the
    // per-token scans (up to 16 of them) are not paid for twice.
    const keywordScores = rrfMode
      ? new Map<string, number>()
      : await this.keywordScores(db, queryText, containerTag, k);

    // The lexical channel: BM25 counted in process (the driver has no FTS5).
    // A caller that searches several shards at once passes the GLOBAL ranks
    // instead: per-shard ranks are not comparable between shards, so every
    // shard would contribute its own local champion to the merged list.
    // Without those ranks (the local store path) there is no lexical channel,
    // exactly as before.
    const lexicalRanks = globalLexicalRanks ?? new Map<string, number>();

    const candidateIds = new Set<string>();
    for (const result of contentResults) candidateIds.add(result.id);
    for (const result of tagsResults) candidateIds.add(result.id);
    for (const result of shadowResults) candidateIds.add(result.id);
    for (const id of keywordScores.keys()) candidateIds.add(id);
    for (const [id, rank] of lexicalRanks) {
      if (rank <= k) candidateIds.add(id);
    }

    const ids = Array.from(candidateIds);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    // The shadow column is only read when the shadow is in play: its vectors
    // have another width, so handing the current query vector to it would be
    // an error, not a zero.
    const shadowColumn = shadowActive
      ? `CASE WHEN shadow_vector IS NOT NULL
               THEN vector_distance_cos(shadow_vector, vector32(?))
               ELSE NULL END AS shadow_dist,`
      : "";
    // In "replace" mode the channels of the model in charge are not used at
    // all, so their distances are not computed - and the query does not have
    // to be embedded with that model either (measured: that second embedding
    // was about a third of the extra latency).
    const legacyOff = shadowMode === "replace";
    const contentColumn = legacyOff
      ? "NULL AS content_dist,"
      : "vector_distance_cos(vector, vector32(?)) AS content_dist,";
    const tagsColumn = legacyOff
      ? "NULL AS tags_dist"
      : `CASE WHEN tags_vector IS NOT NULL
               THEN vector_distance_cos(tags_vector, vector32(?))
               ELSE NULL END AS tags_dist`;
    const legacyParam = legacyOff ? [] : [queryJson];
    const rows = await db.all(
      containerTag === ""
        ? `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             ${contentColumn}
             ${shadowColumn}
             ${tagsColumn}
      FROM memories
      WHERE id IN (${placeholders}) AND aged_at IS NULL
    `
        : `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             ${contentColumn}
             ${shadowColumn}
             ${tagsColumn}
      FROM memories
      WHERE id IN (${placeholders}) AND container_tag = ? AND aged_at IS NULL
    `,
      containerTag === ""
        ? [...legacyParam, ...(shadowActive ? [shadowJson] : []), ...legacyParam, ...ids]
        : [
            ...legacyParam,
            ...(shadowActive ? [shadowJson] : []),
            ...legacyParam,
            ...ids,
            containerTag,
          ]
    );

    const components = rows.map((row: Record<string, unknown>) => {
      const contentSim = distanceToSimilarity(Number(row.content_dist));
      const shadowSim =
        row.shadow_dist == null || row.shadow_dist === undefined
          ? 0
          : distanceToSimilarity(Number(row.shadow_dist));
      const tagsSim =
        row.tags_dist == null || row.tags_dist === undefined
          ? 0
          : distanceToSimilarity(Number(row.tags_dist));
      const memoryTagsStr = String(row.tags || "");
      // filter(Boolean): "".split(",") → [""], and "query".includes("") is always true.
      const memoryTags = memoryTagsStr
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);

      let exactMatchBoost = 0;
      if (queryWords.length > 0 && memoryTags.length > 0) {
        const matches = queryWords.filter((word) =>
          memoryTags.some((tag) => tag.includes(word) || word.includes(tag))
        ).length;
        exactMatchBoost = matches / Math.max(queryWords.length, 1);
      }

      const keywordSim = keywordScores.get(String(row.id)) ?? 0;
      const finalTagsSim = Math.max(tagsSim, exactMatchBoost);
      return { row, contentSim, shadowSim, finalTagsSim, keywordSim, memoryTagsStr };
    });

    // With query text: blend vector + keyword. Without: keep classic 0.6/0.4.
    //
    // A signal the memory does NOT have is absent, not zero. Charging the
    // full tags weight against a row with no tags vector capped every
    // untagged memory at 0.5 - below the default 0.6 threshold - so it could
    // be stored and then never read back, not even by a query repeating its
    // own text. Weights are renormalized over the signals a row carries.
    //
    // Rank-fusion mode replaces that sum: the channels vote with ranks, so one
    // noisy signal cannot decide the winner. The sum cannot do that - a row
    // with no lexical and no tag signal keeps the whole weight on a single
    // vector, and long boilerplate records win exactly those comparisons.
    const fused = new Map<string, number>();
    if (rrfMode) {
      const contentRanks = rankByScore(
        components.map((component) => ({
          id: String(component.row.id),
          score: component.contentSim,
        }))
      );
      const tagRanks = rankByScore(
        components.map((component) => ({
          id: String(component.row.id),
          score: component.finalTagsSim,
        }))
      );
      const channels: Array<Map<string, number>> = [contentRanks, tagRanks, lexicalRanks];
      if (shadowActive) {
        const shadowRanks = rankByScore(
          components.map((component) => ({
            id: String(component.row.id),
            score: component.shadowSim,
          }))
        );
        if (shadowMode === "replace") {
          // The shadow takes the seat of the model in charge - the content
          // channel AND the tags channel, whose vectors belong to that model
          // too. A leftover channel from the old model would dilute the one
          // that works, and measured on the live corpus it did exactly that:
          // the shadow reordered the results but did not move a single hit
          // into the top ten.
          channels[0] = shadowRanks;
          channels.splice(1, 1);
        } else {
          channels.push(shadowRanks);
        }
      }
      const fusedScores = rrfScore(channels, rrfK());
      // Normalize so that first place in every channel is 1.0. The scale
      // is a constant, not a per-shard maximum: a per-shard maximum would make
      // every shard contribute its own winner to the global merge.
      const scale = (rrfK() + 1) / channels.length;
      for (const [id, score] of fusedScores) fused.set(id, score * scale);
    } else {
      for (const component of components) {
        const { contentSim, finalTagsSim, keywordSim } = component;
        let similarity: number;
        if (hasKeyword) {
          const wContent = 0.5;
          const wTags = finalTagsSim > 0 ? 0.3 : 0;
          const wKeyword = keywordSim > 0 ? 0.2 : 0;
          const total = wContent + wTags + wKeyword;
          similarity =
            (contentSim * wContent + finalTagsSim * wTags + keywordSim * wKeyword) / total;
        } else {
          const wContent = 0.6;
          const wTags = finalTagsSim > 0 ? 0.4 : 0;
          const total = wContent + wTags;
          similarity = (contentSim * wContent + finalTagsSim * wTags) / total;
        }
        fused.set(String(component.row.id), similarity);
      }
    }

    const hydratedResults = components.map((component) => {
      const row = component.row;
      return {
        id: String(row.id),
        memory: String(row.content),
        similarity: fused.get(String(row.id)) ?? 0,
        // The raw channel scores travel with the result: the fusion has to be
        // redone over GLOBAL ranks once the shards are merged (fuseGlobalRanks).
        contentSim: component.contentSim,
        tagsSim: component.finalTagsSim,
        shadowSim: component.shadowSim,
        createdAt: Number(row.created_at),
        tags: component.memoryTagsStr ? component.memoryTagsStr.split(",") : [],
        metadata: parseMetadata(row.metadata),
        containerTag: String(row.container_tag),
        displayName: row.display_name ? String(row.display_name) : undefined,
        userName: row.user_name ? String(row.user_name) : undefined,
        userEmail: row.user_email ? String(row.user_email) : undefined,
        projectPath: row.project_path ? String(row.project_path) : undefined,
        projectName: row.project_name ? String(row.project_name) : undefined,
        gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
        isPinned: row.is_pinned,
      };
    });

    hydratedResults.sort((a, b) => b.similarity - a.similarity);
    return hydratedResults.slice(0, Math.max(0, limit));
  }

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
  async globalLexicalRanks(
    shards: ShardInfo[],
    queryText: string | undefined
  ): Promise<Map<string, number>> {
    // Legacy mode keeps the old path and pays nothing for the global scan.
    if (!isRrfMode()) return new Map();
    const queryTokens = tokenizeQueryText(queryText);
    if (queryTokens.length === 0) return new Map();
    const corpus = await this.lexicalCorpus(shards);
    const scores = bm25Scores(corpus, queryTokens);
    return rankByScore([...scores.entries()].map(([id, score]) => ({ id, score })));
  }

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
  private async lexicalCorpus(shards: ShardInfo[]): Promise<LexicalCorpus> {
    if (globalLexicalCorpus && Date.now() - globalLexicalCorpus.builtAt < LEXICAL_CACHE_TTL_MS) {
      return globalLexicalCorpus.corpus;
    }
    const docs: Array<{ id: string; text: string; containerTag: string }> = [];
    for (const shard of shards) {
      try {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const rows = await db.all(`SELECT id, content, tags, container_tag FROM memories LIMIT ?`, [
          LEXICAL_SCAN_LIMIT,
        ]);
        for (const row of rows) {
          docs.push({
            id: String(row.id),
            text: `${String(row.content ?? "")} ${String(row.tags ?? "")}`,
            containerTag: String(row.container_tag ?? ""),
          });
        }
      } catch (error) {
        log("Lexical scan failed on a shard", { shardId: shard.id, error: String(error) });
      }
    }
    const corpus = buildLexicalCorpus(docs);
    globalLexicalCorpus = { corpus, builtAt: Date.now() };
    return corpus;
  }

  /**
   * Keyword recall for hybrid ranking.
   * `@tursodatabase/database` does not ship FTS5, so we use tokenized LIKE
   * over content/tags (bounded tokens, ESCAPE-safe).
   */
  private async keywordScores(
    db: TursoDb,
    queryText: string | undefined,
    containerTag: string,
    limit: number
  ): Promise<Map<string, number>> {
    const tokens = tokenizeQueryText(queryText);
    if (tokens.length === 0) return new Map();

    const scores = new Map<string, number>();
    for (const token of tokens) {
      const pattern = `%${escapeLikePattern(token)}%`;
      const rows = await db.all(
        containerTag === ""
          ? `
          SELECT id FROM memories
          WHERE content LIKE ? ESCAPE '\\' OR IFNULL(tags, '') LIKE ? ESCAPE '\\'
          LIMIT ?
        `
          : `
          SELECT id FROM memories
          WHERE container_tag = ?
            AND (content LIKE ? ESCAPE '\\' OR IFNULL(tags, '') LIKE ? ESCAPE '\\')
          LIMIT ?
        `,
        containerTag === "" ? [pattern, pattern, limit] : [containerTag, pattern, pattern, limit]
      );
      for (const row of rows) {
        const id = String(row.id);
        scores.set(id, (scores.get(id) ?? 0) + 1 / tokens.length);
      }
    }
    return scores;
  }

  private async exactScanKind(
    db: TursoDb,
    queryJson: string,
    k: number,
    containerTag: string,
    columnName: string
  ): Promise<Array<{ id: string; similarity: number }>> {
    const rows = await db.all(
      containerTag === ""
        ? `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL AND m.aged_at IS NULL
        ORDER BY dist ASC
        LIMIT ?
      `
        : `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL AND m.aged_at IS NULL AND m.container_tag = ?
        ORDER BY dist ASC
        LIMIT ?
      `,
      containerTag === "" ? [queryJson, k] : [queryJson, containerTag, k]
    );

    return rows.map((row) => ({
      id: String(row.id),
      similarity: distanceToSimilarity(Number(row.dist)),
    }));
  }

  async searchAcrossShards(
    shards: ShardInfo[],
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<{ results: SearchResult[]; warnings: string[] }> {
    const shardErrors: Array<{ shardId: number; error: string }> = [];

    // One lexical ranking for all shards: ranks from different shards are not
    // comparable, so a per-shard lexical channel would fill the merged list
    // with one local champion per project.
    const globalLexical =
      isRrfMode() && queryText ? await this.globalLexicalRanks(shards, queryText) : undefined;

    const shardPromises = shards.map(async (shard) => {
      try {
        return await this.searchInShard(
          shard,
          queryVector,
          containerTag,
          limit,
          queryText,
          globalLexical
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Shard search error", { shardId: shard.id, error: message });
        shardErrors.push({ shardId: shard.id, error: message });
        return [];
      }
    });

    const resultsArray = await Promise.all(shardPromises);

    if (shardErrors.length > 0 && shardErrors.length === shards.length) {
      throw new Error(
        `Vector search failed on all shards: ${shardErrors.map((entry) => `${entry.shardId}: ${entry.error}`).join("; ")}`
      );
    }

    const warnings =
      shardErrors.length > 0
        ? [
            `Vector search completed with partial shard failures (${shardErrors.length}/${shards.length}): ${shardErrors
              .map((entry) => `${entry.shardId}: ${entry.error}`)
              .join("; ")}`,
          ]
        : [];

    if (warnings.length > 0) {
      log("Vector search completed with partial shard failures", {
        failedShards: shardErrors,
        totalShards: shards.length,
      });
    }

    const allResults = resultsArray.flat();
    allResults.sort((a, b) => b.similarity - a.similarity);
    return {
      results: allResults
        .filter((result) =>
          isRrfMode() ? result.similarity > 0 : result.similarity >= similarityThreshold
        )
        .slice(0, limit),
      warnings,
    };
  }

  async deleteVector(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`DELETE FROM memories WHERE id = ?`, [memoryId]);
    globalLexicalCorpus = null;
  }

  async updateVector(
    db: TursoDb,
    memoryId: string,
    vector: Float32Array,
    tagsVector?: Float32Array
  ): Promise<void> {
    const contentVector = vectorToJson(vector);
    if (tagsVector) {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = vector32(?) WHERE id = ?`,
        [contentVector, vectorToJson(tagsVector), memoryId]
      );
    } else {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = NULL WHERE id = ?`,
        [contentVector, memoryId]
      );
    }
    globalLexicalCorpus = null;
  }

  async listMemories(
    db: TursoDb,
    containerTag: string,
    limit: number,
    tagFilters: string[] = []
  ): Promise<Record<string, unknown>[]> {
    // The list filters on a column added by a migration, and the list path is
    // not the search path: without this the query fails with "no such column"
    // on a shard that was never searched.
    await this.prepareShardDb(db);
    const filters = Array.isArray(tagFilters)
      ? tagFilters.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length > 0)
      : [];
    const params: SqlValue[] = [];
    const clauses: string[] = [];
    if (containerTag !== "") {
      clauses.push("container_tag = ?");
      params.push(containerTag);
    }
    for (const tag of filters) {
      // Tags are stored as one comma-separated string, so match with commas on
      // both sides: otherwise "git" also matches "github" and "legit".
      // escapeLikePattern() keeps `%`, `_` and `\` literal under ESCAPE.
      clauses.push("(',' || COALESCE(tags, '') || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${escapeLikePattern(tag)},%`);
    }
    if (clauses.length === 0) {
      return db.all(
        `
      SELECT * FROM memories
      WHERE aged_at IS NULL
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
    `,
        [limit]
      );
    }
    return db.all(
      `
      SELECT * FROM memories
      WHERE ${clauses.join(" AND ")} AND aged_at IS NULL
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
    `,
      [...params, limit]
    );
  }

  async getAllMemories(db: TursoDb): Promise<Record<string, unknown>[]> {
    return db.all(`SELECT * FROM memories ORDER BY created_at DESC`);
  }

  async getAllMemoriesWithExtractedVectors(
    db: TursoDb
  ): Promise<Array<Record<string, unknown> & { vector_json: string | null }>> {
    return db.all(`
      SELECT
        id,
        content,
        container_tag,
        created_at,
        vector_extract(vector) AS vector_json
      FROM memories
      ORDER BY created_at DESC
    `);
  }

  async getMemoryById(db: TursoDb, memoryId: string): Promise<Record<string, unknown> | null> {
    return db.get(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
  }

  async getMemoriesBySessionID(db: TursoDb, sessionID: string): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    const rows = await db.all(
      `
      SELECT * FROM memories
      WHERE session_id = ?
         OR (session_id IS NULL AND metadata LIKE ?)
      ORDER BY created_at DESC
    `,
      [sessionID, `%"sessionID":"${sessionID}"%`]
    );

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? String(row.tags).split(",") : [],
      metadata: row.metadata ? (parseMetadata(String(row.metadata)) ?? {}) : {},
    }));
  }

  async countVectors(db: TursoDb, containerTag: string): Promise<number> {
    const row = await db.get(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`, [
      containerTag,
    ]);
    return Number(row?.count ?? 0);
  }

  async countAllVectors(db: TursoDb): Promise<number> {
    const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
    return Number(row?.count ?? 0);
  }

  async getDistinctTags(db: TursoDb): Promise<Record<string, unknown>[]> {
    return db.all(`
      SELECT DISTINCT
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
    `);
  }

  async getProjectPathCounts(
    db: TursoDb
  ): Promise<Array<{ projectPath: string; count: number; containerTag: string | null }>> {
    const rows = await db.all(`
      SELECT
        project_path AS project_path,
        container_tag AS container_tag,
        COUNT(*) AS cnt
      FROM memories
      WHERE project_path IS NOT NULL AND project_path != ''
      GROUP BY project_path, container_tag
      ORDER BY cnt DESC, project_path ASC
    `);
    return rows.map((row) => ({
      projectPath: String(row.project_path),
      count: Number(row.cnt ?? 0),
      containerTag: row.container_tag ? String(row.container_tag) : null,
    }));
  }

  async updateProjectAssociation(
    db: TursoDb,
    oldContainerTag: string,
    update: {
      containerTag: string;
      projectPath?: string;
      projectName?: string;
      displayName?: string;
      gitRepoUrl?: string | null;
    }
  ): Promise<number> {
    return db.run(
      `
      UPDATE memories SET
        container_tag = ?,
        project_path = ?,
        project_name = ?,
        display_name = ?,
        git_repo_url = ?
      WHERE container_tag = ?
    `,
      [
        update.containerTag,
        update.projectPath ?? null,
        update.projectName ?? null,
        update.displayName ?? null,
        update.gitRepoUrl ?? null,
        oldContainerTag,
      ]
    );
  }

  async pinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 1 WHERE id = ?`, [memoryId]);
  }

  async unpinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 0 WHERE id = ?`, [memoryId]);
  }
}

export const tursoVectorSearch = new TursoVectorSearch();
