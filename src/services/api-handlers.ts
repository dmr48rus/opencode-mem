import { embeddingService, getShadowEmbeddingService } from "./embedding.js";
import type { ShadowMode } from "./turso/vector-search.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { fuseGlobalRanks, isRrfMode, rrfK, tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { formatTagsForEmbedding, parseSessionIdFromMetadata } from "./turso/vector-utils.js";
import { extractScopeFromContainerTag, tryExtractScopeFromContainerTag } from "./memory-scope.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryType } from "../types/index.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserProfileData } from "./user-profile/types.js";
import { sortProfileItems } from "../utils/profile.js";
import { toPublicProfileData } from "./user-profile/profile-utils.js";
import type { ShardInfo } from "./turso/types.js";

async function getAllMemoryShards(): Promise<ShardInfo[]> {
  await ensureTursoReady();
  const projectShards = await tursoShardManager.getAllShards("project", "");
  const userShards = await tursoShardManager.getAllShards("user", "");
  return [...projectShards, ...userShards];
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/** The only capability the tag migration needs from an external memory API. */
interface ExternalTagProvider {
  executeToolCall(
    systemPrompt: string,
    userPrompt: string,
    toolSchema: unknown,
    callId: string
  ): Promise<{ success?: boolean; data?: { tags?: string[] }; error?: string }>;
}

interface Memory {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

interface TagInfo {
  tag: string;
  tags?: string[];
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);
    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }
    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeJSONParse(jsonString: any): any {
  if (!jsonString || typeof jsonString !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

function extractScopeFromTag(tag: string): { scope: "user" | "project"; hash: string } {
  return extractScopeFromContainerTag(tag);
}

function getProjectPathFromTag(tag: string): Promise<string | undefined> {
  return (async () => {
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const tags = await tursoVectorSearch.getDistinctTags(db);
      for (const t of tags) {
        if (t.container_tag === tag && t.project_path) {
          return String(t.project_path);
        }
      }
    }
    return undefined;
  })();
}

function tagInfoFromDistinctRow(t: Record<string, unknown>): TagInfo | null {
  if (!t.container_tag) return null;
  return {
    tag: String(t.container_tag),
    displayName: t.display_name ? String(t.display_name) : undefined,
    userName: t.user_name ? String(t.user_name) : undefined,
    userEmail: t.user_email ? String(t.user_email) : undefined,
    projectPath: t.project_path ? String(t.project_path) : undefined,
    projectName: t.project_name ? String(t.project_name) : undefined,
    gitRepoUrl: t.git_repo_url ? String(t.git_repo_url) : undefined,
  };
}

async function collectDistinctTags(
  scope: "user" | "project",
  marker: "_user_" | "_project_"
): Promise<TagInfo[]> {
  const shards = await tursoShardManager.getAllShards(scope, "");
  const tagsMap = new Map<string, TagInfo>();
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const tags = await tursoVectorSearch.getDistinctTags(db);
    for (const t of tags) {
      const tagInfo = tagInfoFromDistinctRow(t);
      if (!tagInfo || tagsMap.has(tagInfo.tag) || !tagInfo.tag.includes(marker)) continue;
      tagsMap.set(tagInfo.tag, tagInfo);
    }
  }
  return Array.from(tagsMap.values());
}

export async function handleListTags(): Promise<
  ApiResponse<{ project: TagInfo[]; user: TagInfo[] }>
> {
  try {
    await ensureTursoReady();
    // Tags are stored as SQLite metadata; embedding model is not needed.
    // Calling warmup() here would block on local transformer init in the worker
    // thread and hang every read API. Only handlers that compute similarity
    // (e.g. handleSearch) should warm up the embedding service.
    //
    // Return both scopes: the unfiltered explorer list and /api/stats total
    // already include user + project memories, so the tag dropdown must too.
    const [project, user] = await Promise.all([
      collectDistinctTags("project", "_project_"),
      collectDistinctTags("user", "_user_"),
    ]);
    return { success: true, data: { project, user } };
  } catch (error) {
    log("handleListTags: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleListMemories(
  tag?: string | string[],
  page: number = 1,
  pageSize: number = 20,
  includePrompts: boolean = true
): Promise<ApiResponse<PaginatedResponse<Memory | any>>> {
  try {
    await ensureTursoReady();
    // Listing only reads SQLite rows; no vector ops happen here.
    // See handleListTags comment - keep embedding init out of read paths.
    const filterTags = (Array.isArray(tag) ? tag : tag ? [tag] : [])
      .map((t) => t.trim())
      .filter(Boolean);
    const allMemories: any[] = [];
    const seenIds = new Set<string>();

    async function pushUnique(memories: any[]) {
      for (const memory of memories) {
        const id = String(memory.id);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        allMemories.push(memory);
      }
    }

    if (filterTags.length > 0) {
      for (const filterTag of filterTags) {
        const { scope: tagScope, hash } = extractScopeFromTag(filterTag);
        const shards = await tursoShardManager.getAllShards(tagScope, hash);
        for (const shard of shards) {
          const db = await tursoConnectionManager.getConnection(shard.dbPath);
          const memories = await tursoVectorSearch.listMemories(db, filterTag, 10000);
          await pushUnique(memories);
        }
      }
    } else {
      // Iterate both project- and user-scoped shards. Previously this only
      // walked project shards, which silently hid user-scope memories from the
      // listing endpoint (Web UI navigation, /api/memories without a tag
      // filter, …). User-scope memories still showed up in /api/search and
      // /api/stats `byType`, but were invisible in /api/stats `byScope` and
      // unbrowseable in the UI — a confusing UX gap. The filter keeps the
      // defense-in-depth check on container_tag, just widens it to both
      // canonical scope markers.
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const userShards = await tursoShardManager.getAllShards("user", "");
      for (const shard of [...projectShards, ...userShards]) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.getAllMemories(db);
        await pushUnique(
          memories.filter(
            (m: any) =>
              m.container_tag?.includes("_project_") || m.container_tag?.includes("_user_")
          )
        );
      }
    }

    const memoriesWithType = allMemories.map((r: any) => {
      const metadata = safeJSONParse(r.metadata);
      return {
        type: "memory",
        id: r.id,
        content: r.content,
        memoryType: r.type,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
        createdAt: Number(r.created_at),
        updatedAt: r.updated_at ? Number(r.updated_at) : undefined,
        metadata,
        linkedPromptId: metadata?.promptId,
        displayName: r.display_name,
        userName: r.user_name,
        userEmail: r.user_email,
        projectPath: r.project_path,
        projectName: r.project_name,
        gitRepoUrl: r.git_repo_url,
        isPinned: r.is_pinned === 1,
      };
    });

    let timeline: any[] = memoriesWithType;
    if (includePrompts) {
      const promptById = new Map<string, any>();
      if (filterTags.length === 0) {
        const prompts = await userPromptManager.getCapturedPrompts(undefined);
        for (const p of prompts) promptById.set(p.id, p);
      } else {
        for (const filterTag of filterTags) {
          const projectPath = await getProjectPathFromTag(filterTag);
          const prompts = await userPromptManager.getCapturedPrompts(projectPath);
          for (const p of prompts) promptById.set(p.id, p);
        }
      }
      const promptsWithType = [...promptById.values()].map((p) => ({
        type: "prompt",
        id: p.id,
        sessionId: p.sessionId,
        content: p.content,
        createdAt: p.createdAt,
        projectPath: p.projectPath,
        linkedMemoryId: p.linkedMemoryId,
      }));
      timeline = [...memoriesWithType, ...promptsWithType];
    }

    const linkedPairs = new Map<string, { memory: any; prompt: any }>();
    const standalone: any[] = [];
    for (const item of timeline) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!linkedPairs.has(item.linkedPromptId)) {
          linkedPairs.set(item.linkedPromptId, { memory: item, prompt: null });
        } else {
          linkedPairs.get(item.linkedPromptId)!.memory = item;
        }
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!linkedPairs.has(item.id)) {
          linkedPairs.set(item.id, { memory: null, prompt: item });
        } else {
          linkedPairs.get(item.id)!.prompt = item;
        }
      } else {
        standalone.push(item);
      }
    }

    const sortedTimeline: any[] = [];
    const pairValues = Array.from(linkedPairs.values());
    const completePairs = pairValues.filter((p) => p.memory && p.prompt);
    // A memory or prompt whose counterpart is missing (linked prompt deleted,
    // or prompt capture off) must still show up in the timeline, unlinked.
    for (const pair of pairValues) {
      if (pair.memory && !pair.prompt) standalone.push(pair.memory);
      else if (pair.prompt && !pair.memory) standalone.push(pair.prompt);
    }

    type TimelineGroup = { kind: "pair"; memory: any; prompt: any } | { kind: "item"; item: any };

    const groups: TimelineGroup[] = [
      ...completePairs.map((p) => ({ kind: "pair" as const, memory: p.memory, prompt: p.prompt })),
      ...standalone.map((item) => ({ kind: "item" as const, item })),
    ];

    groups.sort((a, b) => {
      const pinA = a.kind === "pair" ? Number(!!a.memory.isPinned) : Number(!!a.item.isPinned);
      const pinB = b.kind === "pair" ? Number(!!b.memory.isPinned) : Number(!!b.item.isPinned);
      if (pinA !== pinB) return pinB - pinA;
      const timeA = a.kind === "pair" ? a.memory.createdAt : a.item.createdAt;
      const timeB = b.kind === "pair" ? b.memory.createdAt : b.item.createdAt;
      return timeB - timeA;
    });

    for (const group of groups) {
      if (group.kind === "pair") {
        sortedTimeline.push(group.memory);
        sortedTimeline.push(group.prompt);
      } else {
        sortedTimeline.push(group.item);
      }
    }
    timeline = sortedTimeline;

    const total = timeline.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults = timeline.slice(offset, offset + pageSize);

    const items = paginatedResults.map((item: any) => {
      if (item.type === "memory") {
        return {
          type: "memory",
          id: item.id,
          content: item.content,
          memoryType: item.memoryType,
          tags: item.tags,
          createdAt: safeToISOString(item.createdAt),
          updatedAt: item.updatedAt ? safeToISOString(item.updatedAt) : undefined,
          metadata: item.metadata,
          linkedPromptId: item.linkedPromptId,
          displayName: item.displayName,
          userName: item.userName,
          userEmail: item.userEmail,
          projectPath: item.projectPath,
          projectName: item.projectName,
          gitRepoUrl: item.gitRepoUrl,
          isPinned: item.isPinned,
        };
      } else {
        return {
          type: "prompt",
          id: item.id,
          sessionId: item.sessionId,
          content: item.content,
          createdAt: safeToISOString(item.createdAt),
          projectPath: item.projectPath,
          linkedMemoryId: item.linkedMemoryId,
        };
      }
    });

    return { success: true, data: { items, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleListMemories: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleAddMemory(data: {
  content: string;
  containerTag: string;
  type?: MemoryType;
  tags?: string[];
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  /**
   * Caller-supplied metadata. Auto-capture stores the session id and capture
   * facts here, and searchMemoriesBySessionID reads them back; without this the
   * HTTP path drops them, every capture looks like a new session, and the same
   * conversation gets captured again and again.
   */
  metadata?: Record<string, unknown>;
  sessionId?: string;
}): Promise<ApiResponse<{ id: string }>> {
  try {
    if (!data.content || !data.containerTag) {
      return { success: false, error: "content and containerTag are required" };
    }
    await ensureTursoReady();
    await embeddingService.warmup();
    const tags = (data.tags || []).map((t) => t.trim().toLowerCase());
    const embeddingInput =
      tags.length > 0 ? `${data.content}\nTags: ${tags.join(", ")}` : data.content;

    const vector = await embeddingService.embedWithTimeout(embeddingInput, { task: "document" });
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
        task: "document",
      });
    }
    // The shadow vector, when a shadow model is configured: the record is
    // written with both, so the shadow index stays complete without another
    // reindex pass. A failure here is not fatal - the reindex can fill it in.
    let shadowVector: Float32Array | undefined = undefined;
    let shadowModel: string | undefined = undefined;
    const shadowService = getShadowEmbeddingService();
    if (shadowService) {
      try {
        await shadowService.warmup();
        shadowVector = await shadowService.embedWithTimeout(embeddingInput, { task: "document" });
        shadowModel = shadowService.modelId;
      } catch (error) {
        log("Shadow embedding failed; the record is written without a shadow vector", {
          error: String(error),
        });
      }
    }

    const { scope, hash } = extractScopeFromTag(data.containerTag);

    return tursoShardManager.withScopeWriteLock(scope, hash, async () => {
      const shard = await tursoShardManager.getWriteShard(scope, hash);

      const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const now = Date.now();

      const record = {
        id,
        content: data.content,
        vector,
        tagsVector,
        shadowVector,
        shadowModel,
        containerTag: data.containerTag,
        tags: tags.length > 0 ? tags.join(",") : undefined,
        type: data.type,
        createdAt: now,
        updatedAt: now,
        displayName: data.displayName,
        userName: data.userName,
        userEmail: data.userEmail,
        projectPath: data.projectPath,
        projectName: data.projectName,
        gitRepoUrl: data.gitRepoUrl,
        metadata: JSON.stringify({ source: "api", ...(data.metadata ?? {}) }),
        sessionId: data.sessionId,
      };
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      await tursoVectorSearch.insertVector(db, record);
      await tursoShardManager.incrementVectorCount(shard.id);
      return { success: true as const, data: { id } };
    });
  } catch (error) {
    log("handleAddMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeleteMemory(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedPrompt: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        if (cascade) {
          const metadata = safeJSONParse(memory.metadata);
          const linkedPromptId = metadata?.promptId;
          if (linkedPromptId) await userPromptManager.deletePrompt(linkedPromptId);
        }
        await tursoVectorSearch.deleteVector(db, id);
        await tursoShardManager.decrementVectorCount(shard.id);
        return {
          success: true,
          data: { deletedPrompt: cascade && !!safeJSONParse(memory.metadata)?.promptId },
        };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleDeleteMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDelete(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeleteMemory(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDelete: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateMemory(
  id: string,
  data: { content?: string; type?: MemoryType; tags?: string[] }
): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    await embeddingService.warmup();

    // Find the existing memory first (read-only — no data modified yet)
    const shards = await getAllMemoryShards();
    let foundShard = null,
      existingMemory = null;
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        foundShard = shard;
        existingMemory = memory;
        break;
      }
    }
    if (!foundShard || !existingMemory) return { success: false, error: "Memory not found" };

    // STEP 1: Generate new embeddings FIRST (safe — no data deleted yet)
    const newContent = data.content || String(existingMemory.content);
    const existingTags = existingMemory.tags ? String(existingMemory.tags) : "";
    const tags =
      data.tags || (existingTags ? existingTags.split(",").map((t: string) => t.trim()) : []);
    const vector = await embeddingService.embedWithTimeout(newContent, { task: "document" });
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
        task: "document",
      });
    }

    const db = await tursoConnectionManager.getConnection(foundShard.dbPath);

    await db.transaction("write", async (tx) => {
      await tx.execute({ sql: `DELETE FROM memories WHERE id = ?`, args: [id] });
      await tx.execute({
        sql: `
        INSERT INTO memories (
          id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
          metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
        ) VALUES (?, ?, vector32(?), ${tagsVector ? "vector32(?)" : "NULL"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        args: [
          id,
          newContent,
          JSON.stringify(Array.from(vector)),
          ...(tagsVector ? [JSON.stringify(Array.from(tagsVector))] : []),
          String(existingMemory.container_tag),
          tags.length > 0 ? tags.join(",") : null,
          data.type || (existingMemory.type ? String(existingMemory.type) : null),
          Number(existingMemory.created_at),
          Date.now(),
          existingMemory.metadata ? String(existingMemory.metadata) : null,
          existingMemory.session_id
            ? String(existingMemory.session_id)
            : parseSessionIdFromMetadata(
                existingMemory.metadata ? String(existingMemory.metadata) : null
              ),
          existingMemory.display_name ? String(existingMemory.display_name) : null,
          existingMemory.user_name ? String(existingMemory.user_name) : null,
          existingMemory.user_email ? String(existingMemory.user_email) : null,
          existingMemory.project_path ? String(existingMemory.project_path) : null,
          existingMemory.project_name ? String(existingMemory.project_name) : null,
          existingMemory.git_repo_url ? String(existingMemory.git_repo_url) : null,
        ],
      });
    });

    return { success: true };
  } catch (error) {
    log("handleUpdateMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

interface FormattedPrompt {
  type: "prompt";
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  projectPath: string | null;
  linkedMemoryId: string | null;
  similarity?: number;
  isContext?: boolean;
}

interface FormattedMemory {
  type: "memory";
  id: string;
  content: string;
  memoryType?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
  linkedPromptId?: string;
  isContext?: boolean;
}

type SearchResultItem = FormattedPrompt | FormattedMemory;

export async function handleSearch(
  query: string,
  tag?: string | string[],
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>> {
  try {
    if (!query) return { success: false, error: "query is required" };
    await ensureTursoReady();
    // The shadow mode is read FIRST: in "replace" mode the model in charge
    // does not answer at all, so embedding the query with it would be work
    // whose result nobody reads (measured: about a third of the extra latency).
    let shadowMode: ShadowMode = "off";
    let shadowQueryVector: Float32Array | undefined;
    try {
      const { getShadowMode } = await import("./memory-shadow.js");
      shadowMode = await getShadowMode();
      if (shadowMode !== "off") {
        const shadowService = getShadowEmbeddingService();
        if (shadowService) {
          await shadowService.warmup();
          shadowQueryVector = await shadowService.embedWithTimeout(query, { task: "query" });
        }
      }
    } catch (error) {
      log("Shadow channel unavailable; continuing without it", { error: String(error) });
      shadowMode = "off";
      shadowQueryVector = undefined;
    }
    // "replace" without a shadow vector would leave the search with neither
    // the old model nor the new one. The mode is stored with the data, so a
    // config that no longer names a shadow model must not be able to
    // silently blind the store.
    if (shadowMode === "replace" && !shadowQueryVector) {
      log("Shadow mode is replace but no shadow vector is available; using the model in charge");
      shadowMode = "off";
    }

    let queryVector: Float32Array | undefined;
    if (shadowMode !== "replace") {
      await embeddingService.warmup();
      queryVector = await embeddingService.embedWithTimeout(query, { task: "query" });
    }
    const memoryResults: any[] = [];
    let promptResults: any[] = [];
    const filterTags = (Array.isArray(tag) ? tag : tag ? [tag] : [])
      .map((t) => t.trim())
      .filter(Boolean);
    // The lexical ranking is computed only when it is used. Computing it
    // unconditionally cost a full pass over every shard in legacy mode, and
    // it broke the tag-migration test, whose scenario runs with a mocked
    // config that has no storagePath at all.
    //
    // And it is an addition, not a requirement: if the shards cannot be read,
    // the search still works with the vector channels alone.
    let globalLexical = new Map<string, number>();
    if (isRrfMode()) {
      try {
        globalLexical = await tursoVectorSearch.globalLexicalRanks(
          await getAllMemoryShards(),
          query
        );
      } catch (error) {
        log("Global lexical ranking failed; continuing without it", {
          error: String(error),
        });
      }
    }
    if (filterTags.length > 0) {
      const seenMemoryKeys = new Set<string>();
      const promptById = new Map<string, any>();
      for (const filterTag of filterTags) {
        const { scope, hash } = extractScopeFromTag(filterTag);
        const shards = await tursoShardManager.getAllShards(scope, hash);
        for (const shard of shards) {
          try {
            const results = await tursoVectorSearch.searchInShard(
              shard,
              queryVector,
              filterTag,
              pageSize * 2,
              query,
              globalLexical,
              shadowQueryVector,
              shadowMode
            );
            for (const result of results) {
              const key = String(result.id ?? `${result.memory}:${result.similarity}`);
              if (seenMemoryKeys.has(key)) continue;
              seenMemoryKeys.add(key);
              memoryResults.push(result);
            }
          } catch (error) {
            log("Shard search error", { shardId: shard.id, error: String(error) });
          }
        }
        const projectPath = await getProjectPathFromTag(filterTag);
        const prompts = await userPromptManager.searchPrompts(query, projectPath, pageSize * 2);
        for (const prompt of prompts) promptById.set(prompt.id, prompt);
      }
      promptResults = [...promptById.values()];
    } else {
      const allShards = await getAllMemoryShards();
      const uniqueTags = new Set<string>();
      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const tags = await tursoVectorSearch.getDistinctTags(db);
        for (const t of tags) {
          if (t.container_tag) uniqueTags.add(String(t.container_tag));
        }
      }
      for (const containerTag of uniqueTags) {
        const parsed = tryExtractScopeFromContainerTag(containerTag);
        if (!parsed) {
          log("Skipping invalid container_tag during global search", { containerTag });
          continue;
        }
        const { scope, hash } = parsed;
        const shards = await tursoShardManager.getAllShards(scope, hash);
        for (const shard of shards) {
          try {
            const results = await tursoVectorSearch.searchInShard(
              shard,
              queryVector,
              containerTag,
              pageSize,
              query,
              globalLexical,
              shadowQueryVector,
              shadowMode
            );
            memoryResults.push(...results);
          } catch (error) {
            log("Shard search error", { shardId: shard.id, error: String(error) });
          }
        }
      }
      promptResults = await userPromptManager.searchPrompts(query, undefined, pageSize * 2);
    }

    // The shards are merged here, so this is the first place where the ranks
    // of the channels are comparable. Fusing inside a shard (see
    // searchInShard) ranks every shard against its own hub, and the best match
    // on the whole corpus loses to the hub of its own project.
    if (isRrfMode()) {
      fuseGlobalRanks(memoryResults, globalLexical, rrfK(), shadowMode);
    }

    const formattedPrompts: FormattedPrompt[] = promptResults.map((p) => ({
      type: "prompt",
      id: p.id,
      sessionId: p.sessionId,
      content: p.content,
      createdAt: safeToISOString(p.createdAt),
      projectPath: p.projectPath,
      linkedMemoryId: p.linkedMemoryId,
      similarity: 1.0,
    }));

    const formattedMemories: FormattedMemory[] = memoryResults.map((r: any) => ({
      type: "memory",
      id: r.id,
      content: r.memory,
      memoryType: r.metadata?.type,
      tags: r.tags,
      createdAt: safeToISOString(r.createdAt ?? r.metadata?.createdAt),
      updatedAt: r.metadata?.updatedAt ? safeToISOString(r.metadata.updatedAt) : undefined,
      similarity: r.similarity,
      metadata: r.metadata,
      displayName: r.displayName,
      userName: r.userName,
      userEmail: r.userEmail,
      projectPath: r.projectPath,
      projectName: r.projectName,
      gitRepoUrl: r.gitRepoUrl,
      isPinned: r.isPinned === 1,
      linkedPromptId: r.metadata?.promptId,
    }));

    const combinedResults = [...formattedMemories, ...formattedPrompts].sort(
      (a: any, b: any) =>
        (b.similarity || 0) - (a.similarity || 0) || b.createdAt.localeCompare(a.createdAt)
    );

    const total = combinedResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults: SearchResultItem[] = combinedResults.slice(offset, offset + pageSize);

    const missingPromptIds = new Set<string>();
    const missingMemoryIds = new Set<string>();
    for (const item of paginatedResults) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!paginatedResults.some((p) => p.id === item.linkedPromptId))
          missingPromptIds.add(item.linkedPromptId);
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!paginatedResults.some((m) => m.id === item.linkedMemoryId))
          missingMemoryIds.add(item.linkedMemoryId);
      }
    }

    if (missingPromptIds.size > 0) {
      const extraPrompts = await userPromptManager.getPromptsByIds(Array.from(missingPromptIds));
      for (const p of extraPrompts) {
        paginatedResults.push({
          type: "prompt",
          id: p.id,
          sessionId: p.sessionId,
          content: p.content,
          createdAt: safeToISOString(p.createdAt),
          projectPath: p.projectPath,
          linkedMemoryId: p.linkedMemoryId,
          similarity: 0,
          isContext: true,
        });
      }
    }

    if (missingMemoryIds.size > 0) {
      const shards = await getAllMemoryShards();
      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        for (const mid of missingMemoryIds) {
          const m = await tursoVectorSearch.getMemoryById(db, mid);
          if (m && !paginatedResults.some((existing) => existing.id === m.id)) {
            paginatedResults.push({
              type: "memory",
              id: String(m.id),
              content: String(m.content),
              memoryType: m.type ? String(m.type) : undefined,
              tags: m.tags
                ? String(m.tags)
                    .split(",")
                    .map((t: string) => t.trim())
                : [],
              createdAt: safeToISOString(m.created_at),
              updatedAt: m.updated_at ? safeToISOString(m.updated_at) : undefined,
              similarity: 0,
              metadata: safeJSONParse(m.metadata),
              displayName: m.display_name ? String(m.display_name) : undefined,
              userName: m.user_name ? String(m.user_name) : undefined,
              userEmail: m.user_email ? String(m.user_email) : undefined,
              projectPath: m.project_path ? String(m.project_path) : undefined,
              projectName: m.project_name ? String(m.project_name) : undefined,
              gitRepoUrl: m.git_repo_url ? String(m.git_repo_url) : undefined,
              isPinned: Number(m.is_pinned) === 1,
              linkedPromptId: safeJSONParse(m.metadata)?.promptId,
              isContext: true,
            });
          }
        }
      }
    }

    return { success: true, data: { items: paginatedResults, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleSearch: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

/**
 * The state of the store without a question: pinned and recent records plus
 * counts.
 *
 * No embedding is computed here, and that is the point: the packet is cheap
 * enough to read at the start of every session, where a search would cost an
 * embedding call per query. The shape follows the bootstrap read of the
 * remind project.
 */
export async function handleSnapshot(limit: number = 10): Promise<ApiResponse<any>> {
  try {
    const size = Math.max(1, Math.min(50, Number(limit) || 10));
    const shards = await getAllMemoryShards();
    const recent: any[] = [];
    const pinned: any[] = [];
    const counts: Record<string, number> = {};
    let total = 0;
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      // The snapshot filters on a column added by a migration, and the
      // snapshot path is not the search path: without this the query fails
      // with "no such column" on a shard that was never searched.
      await tursoShardManager.ensureShardSchema(db);
      const typeRows = await db.all(`SELECT type, COUNT(*) AS n FROM memories GROUP BY type`);
      for (const row of typeRows) {
        const key = row.type ? String(row.type) : "unknown";
        counts[key] = (counts[key] ?? 0) + Number(row.n ?? 0);
        total += Number(row.n ?? 0);
      }
      const rows = await db.all(
        `SELECT id, content, type, tags, created_at, is_pinned, project_name
         FROM memories WHERE aged_at IS NULL ORDER BY created_at DESC LIMIT ?`,
        [size * 2]
      );
      for (const row of rows) {
        const item = {
          id: String(row.id),
          content: String(row.content ?? "").slice(0, 400),
          type: row.type ? String(row.type) : undefined,
          tags: row.tags ? String(row.tags).split(",").filter(Boolean) : [],
          createdAt: safeToISOString(row.created_at),
          pinned: Boolean(row.is_pinned),
          project: row.project_name ? String(row.project_name) : undefined,
        };
        if (item.pinned) {
          if (pinned.length < size) pinned.push(item);
        } else {
          recent.push(item);
        }
      }
    }
    recent.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      success: true,
      data: {
        pinned,
        recent: recent.slice(0, size),
        counts,
        total,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    log("handleSnapshot: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

/**
 * Write a record into a project scope.
 *
 * The scope tag is `opencode_project_<hash>` and the readable path is known
 * only from the tags the shards carry, so the project is resolved here - by
 * path first, then by name - and a miss names the known projects instead of
 * failing silently.
 */
export async function handleRememberByProject(data: {
  content: string;
  tags?: string[];
  project?: string;
  type?: string;
}): Promise<ApiResponse<any>> {
  try {
    const content = String(data.content ?? "").trim();
    if (!content) return { success: false, error: "content is required" };
    const tags = (data.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
    const resolved = await resolveProjectTag(String(data.project ?? "").trim());
    if (resolved.error) return { success: false, error: resolved.error };
    return await handleAddMemory({
      content,
      containerTag: resolved.tag,
      tags,
      type: data.type ?? "fact",
      metadata: { source: "mcp" },
    });
  } catch (error) {
    log("handleRememberByProject: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

async function resolveProjectTag(wanted: string): Promise<{ tag: string; error: string }> {
  const shards = await getAllMemoryShards();
  const entries: Array<{ tag: string; path?: string; name?: string; newest: number }> = [];
  for (const shard of shards) {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const distinct = await tursoVectorSearch.getDistinctTags(db);
    for (const t of distinct) {
      if (!t.container_tag) continue;
      const tag = String(t.container_tag);
      if (entries.some((entry) => entry.tag === tag)) continue;
      const newestRow = await db.all(
        `SELECT created_at FROM memories WHERE container_tag = ? ORDER BY created_at DESC LIMIT 1`,
        [tag]
      );
      entries.push({
        tag,
        path: t.project_path ? String(t.project_path) : undefined,
        name: t.project_name ? String(t.project_name) : undefined,
        newest: Number(newestRow[0]?.created_at ?? 0),
      });
    }
  }
  const norm = wanted.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (!norm) {
    // No project named: the project of the newest record is the current one.
    const newest = entries.slice().sort((a, b) => b.newest - a.newest)[0];
    if (!newest) return { tag: "", error: "no project scope exists yet in this store" };
    return { tag: newest.tag, error: "" };
  }
  for (const entry of entries) {
    if (entry.path && entry.path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() === norm) {
      return { tag: entry.tag, error: "" };
    }
  }
  for (const entry of entries) {
    if (entry.name && entry.name.toLowerCase() === norm) return { tag: entry.tag, error: "" };
  }
  const known = entries
    .map((entry) => entry.name ?? entry.path ?? entry.tag)
    .filter(Boolean)
    .slice(0, 25)
    .join(", ");
  return {
    tag: "",
    error: `unknown project scope for ${wanted}; known projects: ${known}`,
  };
}

/**
 * Age the memories that may be forgotten.
 *
 * The sweep is a dry run unless the caller asks otherwise: forgetting is not
 * something a request should do by accident. The records are marked, not
 * deleted - the content stays, the marker can be cleared, and the search stops
 * returning them.
 */
/**
 * Fill the shadow index, and switch how it takes part in the search.
 *
 * The reindex is bounded, so the caller drives it in steps: the model download
 * and 1500 embeddings take minutes, and one long request is a request that
 * times out. The mode is stored with the data, so switching the shadow on (or
 * off again) does not need a deploy.
 */
export async function handleRunReindex(data?: {
  limit?: number;
  batchSize?: number;
  mode?: ShadowMode;
}): Promise<ApiResponse<any>> {
  try {
    const { runShadowReindex, setShadowMode, isShadowConfigured } =
      await import("./memory-shadow.js");
    if (data?.mode) await setShadowMode(data.mode);
    if (!isShadowConfigured()) {
      return { success: true, data: { skipped: "no shadow model configured" } };
    }
    const report = await runShadowReindex({
      limit: data?.limit,
      batchSize: data?.batchSize,
    });
    return { success: true, data: report };
  } catch (error) {
    log("handleRunReindex: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunSweep(data?: {
  dryRun?: boolean;
  episodicDays?: number;
  proceduralDays?: number;
  limit?: number;
  restore?: boolean;
}): Promise<ApiResponse<any>> {
  try {
    const { runMemorySweep } = await import("./memory-aging.js");
    const report = await runMemorySweep({
      dryRun: data?.dryRun !== false,
      episodicDays: data?.episodicDays,
      proceduralDays: data?.proceduralDays,
      limit: data?.limit,
      restore: data?.restore === true,
    });
    return { success: true, data: report };
  } catch (error) {
    log("handleRunSweep: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleStats(): Promise<
  ApiResponse<{
    total: number;
    byScope: { user: number; project: number };
    byType: Record<string, number>;
    memoryMb?: { rss: number; heapUsed: number; external: number };
  }>
> {
  try {
    // The process's own memory: the store holds an embedding model in RAM, and
    // the shadow index holds a second one. Guessing the host's budget is how a
    // container gets OOM-killed in the middle of a reindex, so the number that
    // decides it is reported instead.
    const memory = process.memoryUsage();
    const memoryMb = {
      rss: Math.round(memory.rss / 1048576),
      heapUsed: Math.round(memory.heapUsed / 1048576),
      external: Math.round(memory.external / 1048576),
    };
    // Stats only counts Turso/libSQL rows; no embedding needed.
    // See handleListTags comment - keep embedding init out of read paths.
    const shards = await getAllMemoryShards();
    let userCount = 0,
      projectCount = 0;
    const typeCount: Record<string, number> = {};
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memories = await tursoVectorSearch.getAllMemories(db);
      for (const r of memories) {
        const containerTag = String(r.container_tag ?? "");
        const type = r.type ? String(r.type) : "";
        if (containerTag.includes("_user_")) userCount++;
        else if (containerTag.includes("_project_")) projectCount++;
        if (type) typeCount[type] = (typeCount[type] || 0) + 1;
      }
    }
    return {
      success: true,
      data: {
        total: userCount + projectCount,
        byScope: { user: userCount, project: projectCount },
        byType: typeCount,
        memoryMb,
      },
    };
  } catch (error) {
    log("handleStats: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handlePinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        await tursoVectorSearch.pinMemory(db, id);
        return { success: true };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handlePinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUnpinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        await tursoVectorSearch.unpinMemory(db, id);
        return { success: true };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleUnpinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunCleanup(): Promise<
  ApiResponse<{ deletedCount: number; userCount: number; projectCount: number }>
> {
  try {
    const { cleanupService } = await import("./cleanup-service.js");
    const result = await cleanupService.runCleanup();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunDeduplication(): Promise<
  ApiResponse<{ exactDuplicatesDeleted: number; nearDuplicateGroups: any[] }>
> {
  try {
    const { deduplicationService } = await import("./deduplication-service.js");
    const result = await deduplicationService.detectAndRemoveDuplicates();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunDeduplication: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectMigration(): Promise<
  ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.detectDimensionMismatch();
    return { success: true, data: result };
  } catch (error) {
    log("handleDetectMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<
  ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.migrateToNewModel(strategy);
    return { success: result.success, data: result };
  } catch (error) {
    log("handleRunMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeletePrompt(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedMemory: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const prompt = await userPromptManager.getPromptById(id);
    if (!prompt) return { success: false, error: "Prompt not found" };
    let deletedMemory = false;
    if (cascade && prompt.linkedMemoryId) {
      const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
      if (result.success) deletedMemory = true;
    }
    await userPromptManager.deletePrompt(id);
    return { success: true, data: { deletedMemory } };
  } catch (error) {
    log("handleDeletePrompt: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDeletePrompts(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeletePrompt(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDeletePrompts: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

/**
 * Resolve which user id the web UI should read.
 *
 * The web server runs from the opencode service directory, not the project
 * directory, so `getTags(process.cwd())` yields no git user email and the id
 * collapses to "unknown" while profiles are stored under the project's git
 * identity. Falling back to the single active profile keeps the UI working in a
 * single-user setup without inventing a phantom id.
 */
async function resolveProfileUserId(explicitUserId?: string): Promise<string> {
  if (explicitUserId) return explicitUserId;
  const { getTags } = await import("./tags.js");
  const tags = getTags(process.cwd());
  if (tags.user.userEmail) return tags.user.userEmail;
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const active = await userProfileManager.getAllActiveProfiles();
    const only = active.length === 1 ? active[0] : undefined;
    if (only?.userId) {
      log("resolveProfileUserId: cwd has no git identity, using the single active profile id", {
        userId: only.userId,
      });
      return only.userId;
    }
  } catch (error) {
    log("resolveProfileUserId: active profile lookup failed", { error: String(error) });
  }
  return "unknown";
}

/**
 * Move a profile to another identity.
 *
 * The identity belongs to the person, not to the machine: when the work
 * moves to another PC, the learned profile has to move with it. The master
 * token only - a client key may not take over somebody else's identity.
 */
export async function handleTransferProfileIdentity(data: {
  fromUserId?: string;
  toUserId?: string;
}): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const result = await userProfileManager.transferIdentity(
      String(data?.fromUserId ?? ""),
      String(data?.toUserId ?? "")
    );
    return { success: true, data: result };
  } catch (error) {
    log("handleTransferProfileIdentity: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetUserProfile(
  userId?: string,
  raw = false
): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const targetUserId = await resolveProfileUserId(userId);
    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile)
      return {
        success: true,
        data: {
          exists: false,
          userId: targetUserId,
          message: "No profile found. Keep chatting to build your profile.",
        },
      };
    const profileData = JSON.parse(profile.profileData);
    profileData.preferences = sortProfileItems(profileData.preferences as any[], "confidence");
    profileData.patterns = sortProfileItems(profileData.patterns as any[], "frequency");
    profileData.workflows = sortProfileItems(profileData.workflows as any[], "frequency");
    return {
      success: true,
      data: {
        exists: true,
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
        userName: profile.userName,
        userEmail: profile.userEmail,
        version: profile.version,
        createdAt: safeToISOString(profile.createdAt),
        lastAnalyzedAt: safeToISOString(profile.lastAnalyzedAt),
        totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
        profileData: raw ? profileData : toPublicProfileData(profileData),
      },
    };
  } catch (error) {
    log("handleGetUserProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handlePutUserProfile(data: {
  userId?: string;
  profileData: Record<string, unknown>;
  promptsAnalyzed?: number;
  changeSummary?: string;
}): Promise<ApiResponse<{ profileId: string; version: number; created: boolean }>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const targetUserId = await resolveProfileUserId(data.userId);
    if (!data.profileData) {
      return { success: false, error: "profileData is required" };
    }
    const promptsAnalyzed = Number(data.promptsAnalyzed ?? 0);
    const changeSummary = data.changeSummary || "synced from client";

    // Upsert rather than a blind write: a client that has never seen this server
    // posts a profile for a user the server does not know yet, and rejecting that
    // would leave the store permanently empty.
    const existing = await userProfileManager.getActiveProfile(targetUserId);
    if (existing) {
      const profileId = String((existing as unknown as { id: string }).id);
      await userProfileManager.updateProfile(
        profileId,
        data.profileData as never,
        promptsAnalyzed,
        changeSummary
      );
      const updated = await userProfileManager.getProfileById(profileId);
      return {
        success: true,
        data: {
          profileId,
          version: Number((updated as unknown as { version: number })?.version ?? 0),
          created: false,
        },
      };
    }
    const profileId = await userProfileManager.createProfile(
      targetUserId,
      targetUserId,
      targetUserId,
      targetUserId,
      data.profileData as never,
      promptsAnalyzed
    );
    const created = await userProfileManager.getProfileById(profileId);
    return {
      success: true,
      data: {
        profileId,
        version: Number((created as unknown as { version: number })?.version ?? 1),
        created: true,
      },
    };
  } catch (error) {
    log("handlePutUserProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileChangelog(
  profileId: string,
  limit: number = 5
): Promise<ApiResponse<any[]>> {
  try {
    if (!profileId) return { success: false, error: "profileId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = await userProfileManager.getProfileChangelogs(profileId, limit);
    const formattedChangelogs = changelogs.map((c) => ({
      id: c.id,
      profileId: c.profileId,
      version: c.version,
      changeType: c.changeType,
      changeSummary: c.changeSummary,
      createdAt: safeToISOString(c.createdAt),
    }));
    return { success: true, data: formattedChangelogs };
  } catch (error) {
    log("handleGetProfileChangelog: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>> {
  try {
    if (!changelogId) return { success: false, error: "changelogId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelog = await userProfileManager.getChangelogById(changelogId);
    if (!changelog) return { success: false, error: "Changelog not found" };
    const profileData = toPublicProfileData(JSON.parse(changelog.profileDataSnapshot));
    return {
      success: true,
      data: {
        version: changelog.version,
        createdAt: safeToISOString(changelog.createdAt),
        profileData,
      },
    };
  } catch (error) {
    log("handleGetProfileSnapshot: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { getTags } = await import("./tags.js");
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const profile = await userProfileManager.getActiveProfile(targetUserId);
    let decayApplied = false;
    if (profile) {
      const pData = JSON.parse(profile.profileData);
      const { data: decayed, hasChanges } = userProfileManager.decayInMemory(pData);
      if (hasChanges) {
        await userProfileManager.updateProfile(profile.id, decayed, 0, "Applied confidence decay");
        decayApplied = true;
      }
    }
    const unanalyzedCount = await userPromptManager.countUnanalyzedForUserLearning();
    return {
      success: true,
      data: {
        message: decayApplied ? "Profile confidence decay applied" : "Profile refresh queued",
        profileExists: Boolean(profile),
        decayApplied,
        unanalyzedPrompts: unanalyzedCount,
        note: "Confidence decay runs immediately; AI profile learning still runs when the prompt threshold is reached",
      },
    };
  } catch (error) {
    log("handleRefreshProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

// Temporary storage for pending AI cleanup results (userId → result)
const pendingCleanups = new Map<
  string,
  {
    cleaned: UserProfileData;
    oldProfileData: UserProfileData;
    diff: any;
    allMerged: Array<{ ids: string[]; result: string }>;
    allRemovedIds: string[];
    includeIds?: string[];
    profileVersion: number;
    expiresAt: number;
  }
>();

export async function handleAICleanup(
  userId?: string,
  includeIds?: string[],
  profileVersion?: number
): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");
    const { aiCleanupProfile, aiCleanupProfileFromIndexed, filterProfileForCleanup } =
      await import("./user-profile/ai-cleanup.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "No profile found to clean up" };
    }
    if (profileVersion !== undefined && profile.version !== profileVersion) {
      return { success: false, error: "Profile changed. Reload it before running AI cleanup." };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);
    profileData.preferences = sortProfileItems(profileData.preferences as any[], "confidence");
    profileData.patterns = sortProfileItems(profileData.patterns as any[], "frequency");
    profileData.workflows = sortProfileItems(profileData.workflows as any[], "frequency");

    let indexed;
    let result;
    const scopedIds = includeIds && includeIds.length > 0 ? includeIds : undefined;
    if (scopedIds) {
      indexed = filterProfileForCleanup(profileData, scopedIds);
      result = await aiCleanupProfileFromIndexed(indexed);
    } else {
      result = await aiCleanupProfile(profileData);
    }

    pendingCleanups.set(targetUserId, {
      cleaned: result.cleaned,
      oldProfileData: profileData,
      diff: result.diff,
      allMerged: result.diff?.merged || [],
      allRemovedIds: (result.diff?.removed || []).map((r: any) => r.id),
      includeIds: scopedIds,
      profileVersion: profile.version,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return {
      success: true,
      data: {
        // Strip embeddings only on the HTTP response; pendingCleanups keeps
        // full vectors for apply/merge.
        old: toPublicProfileData(profileData),
        new: toPublicProfileData(result.cleaned),
        changes: result.diff,
      },
    };
  } catch (error) {
    log("handleAICleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

/**
 * Merge an AI-cleanup result into a full profile.
 * When includeIds is set, only scoped items are mutated; everything else is preserved.
 */
export function mergeCleanupIntoProfile(args: {
  currentProfile: UserProfileData;
  oldProfileData: UserProfileData;
  cleanedData: UserProfileData;
  includeIds?: string[];
  acceptedMerged?: string[][];
  acceptedRemoved?: string[];
  allMerged?: Array<{ ids: string[]; result: string }>;
  allRemovedIds?: string[];
  /** True when the client sent acceptance arrays (even if empty = reject all). */
  explicitAcceptance?: boolean;
}): UserProfileData {
  const {
    currentProfile,
    oldProfileData,
    cleanedData,
    includeIds,
    acceptedMerged = [],
    acceptedRemoved = [],
    allMerged = [],
    allRemovedIds = [],
    explicitAcceptance = false,
  } = args;

  // Start from cleaned data, then restore any rejected removals/merges.
  const scopedResult: UserProfileData = {
    preferences: [...cleanedData.preferences],
    patterns: [...cleanedData.patterns],
    workflows: [...cleanedData.workflows],
  };

  if (explicitAcceptance) {
    for (const id of acceptedRemoved) {
      removeItemFromProfile(scopedResult, oldProfileData, id);
    }

    for (const ids of acceptedMerged) {
      for (let i = 1; i < ids.length; i++) {
        removeItemFromProfile(scopedResult, oldProfileData, ids[i] ?? "");
      }
    }

    const acceptedTargetIds = new Set(acceptedMerged.map((g) => g[0]));
    for (const merge of allMerged) {
      const groupIds = merge.ids;
      if (groupIds.length <= 1) continue;
      if (acceptedTargetIds.has(groupIds[0])) continue;
      removeOneByDescription(scopedResult, merge.result, itemTypeFromId(groupIds[0] ?? ""));
      for (const id of groupIds) {
        if (id) pushItemFromProfile(scopedResult, oldProfileData, id);
      }
    }

    const acceptedRemovedSet = new Set(acceptedRemoved);
    for (const removedId of allRemovedIds) {
      if (acceptedRemovedSet.has(removedId)) continue;
      pushItemFromProfile(scopedResult, oldProfileData, removedId);
    }
  }

  // Full-profile cleanup: cleaned (+ acceptance) replaces the whole profile.
  if (!includeIds || includeIds.length === 0) {
    return scopedResult;
  }

  // Partial selection: mutate only the analyzed scope inside the current full profile.
  const result: UserProfileData = {
    preferences: [...currentProfile.preferences],
    patterns: [...currentProfile.patterns],
    workflows: [...currentProfile.workflows],
  };

  for (const id of includeIds) {
    removeItemFromProfile(result, oldProfileData, id);
  }

  result.preferences.push(...scopedResult.preferences);
  result.patterns.push(...scopedResult.patterns);
  result.workflows.push(...scopedResult.workflows);

  return result;
}

function pushItemFromProfile(target: UserProfileData, source: UserProfileData, id: string): void {
  const srcItem = findItemById(source, id);
  if (!srcItem) return;
  const { id: _id, ...rest } = srcItem as any;
  if (id.startsWith("pref_")) target.preferences.push(rest);
  else if (id.startsWith("pat_")) target.patterns.push(rest);
  else if (id.startsWith("wf_")) target.workflows.push(rest);
}

export async function handleApplyCleanup(userId?: string, body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const pending = pendingCleanups.get(targetUserId);
    if (!pending) {
      return { success: false, error: "No pending cleanup found. Run AI cleanup first." };
    }

    if (Date.now() > pending.expiresAt) {
      pendingCleanups.delete(targetUserId);
      return { success: false, error: "Cleanup session expired. Run AI cleanup again." };
    }

    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "Profile not found" };
    }
    if (profile.version !== pending.profileVersion) {
      pendingCleanups.delete(targetUserId);
      return { success: false, error: "Profile changed. Run AI cleanup again." };
    }

    const cleanedData = body?.profile || pending.cleaned;
    const acceptedMerged: string[][] = Array.isArray(body?.acceptedMerged)
      ? body.acceptedMerged
      : [];
    const acceptedRemoved: string[] = Array.isArray(body?.acceptedRemoved)
      ? body.acceptedRemoved
      : [];
    const explicitAcceptance =
      Array.isArray(body?.acceptedMerged) || Array.isArray(body?.acceptedRemoved);
    const existingData: UserProfileData = JSON.parse(profile.profileData);

    const result = mergeCleanupIntoProfile({
      currentProfile: existingData,
      oldProfileData: pending.oldProfileData,
      cleanedData,
      includeIds: pending.includeIds,
      acceptedMerged,
      acceptedRemoved,
      allMerged: pending.allMerged,
      allRemovedIds: pending.allRemovedIds,
      explicitAcceptance,
    });

    const partial = (pending.includeIds && pending.includeIds.length > 0) || explicitAcceptance;

    const success = await userProfileManager.updateProfile(
      profile.id,
      result,
      0,
      partial ? "AI cleanup applied (partial)" : "AI cleanup applied"
    );

    if (!success) {
      return { success: false, error: "Profile was modified by another session. Please retry." };
    }

    pendingCleanups.delete(targetUserId);

    return {
      success: true,
      data: {
        message: partial ? "Partial cleanup applied" : "Cleanup applied successfully",
        version: profile.version + 1,
      },
    };
  } catch (error) {
    log("handleApplyCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

function itemTypeFromId(id: string): string {
  if (id.startsWith("pref_")) return "preferences";
  if (id.startsWith("pat_")) return "patterns";
  return "workflows";
}
function findItemById(profile: UserProfileData, id: string): any | null {
  if (typeof id !== "string" || !id.includes("_")) return null;
  const parts = id.split("_");
  const prefix = parts[0];
  const idx = parseInt(parts[1] || "", 10);
  if (isNaN(idx)) return null;

  if (prefix === "pref") return profile.preferences[idx] || null;
  if (prefix === "pat") return profile.patterns[idx] || null;
  if (prefix === "wf") return profile.workflows[idx] || null;

  return null;
}
function removeItemFromProfile(
  target: UserProfileData,
  source: UserProfileData,
  id: string
): boolean {
  const sourceItem = findItemById(source, id);
  if (!sourceItem) return false;
  const itemType = itemTypeFromId(id) as keyof Pick<
    UserProfileData,
    "preferences" | "patterns" | "workflows"
  >;
  const items = target[itemType] as any[];
  const sourceKey = profileItemIdentityKey(sourceItem);
  const index = items.findIndex((item) => profileItemIdentityKey(item) === sourceKey);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
}
function profileItemIdentityKey(item: any): string {
  return JSON.stringify({
    category: item.category ?? null,
    description: item.description ?? null,
    steps: Array.isArray(item.steps) ? item.steps : null,
  });
}
function removeOneByDescription(profile: UserProfileData, desc: string, itemType: string): boolean {
  const items = profile[
    itemType as keyof Pick<UserProfileData, "preferences" | "patterns" | "workflows">
  ] as any[];
  const index = items.findIndex((item) => item.description === desc);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
}

export async function handleUpdateProfileItem(body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    const tags = getTags(process.cwd());
    const userId = tags.user.userEmail || "unknown";
    if (!userId) return { success: false, error: "Unable to resolve user identity" };

    const profile = await userProfileManager.getActiveProfile(userId);
    if (!profile) return { success: false, error: "No profile found" };

    const { type, index, action, category, description, steps } = body || {};
    if (!type || index === undefined || !action) {
      return { success: false, error: "type, index, and action are required" };
    }
    if (!["preferences", "patterns", "workflows"].includes(type)) {
      return { success: false, error: "type must be preferences, patterns, or workflows" };
    }
    if (!["edit", "delete"].includes(action)) {
      return { success: false, error: "action must be edit or delete" };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);
    const items: any[] = (profileData as any)[type] || [];
    // Re-sort to match handleGetUserProfile's display order
    const metric = type === "preferences" ? "confidence" : "frequency";
    const sorted = sortProfileItems(items as any[], metric);

    if (index < 0 || index >= sorted.length) {
      return { success: false, error: "index out of range" };
    }

    if (action === "delete") {
      sorted.splice(index, 1);
    } else {
      const item = sorted[index];
      if (!item) return { success: false, error: "Item not found" };
      if (category !== undefined && type !== "workflows") item.category = category;
      if (description !== undefined && description !== item.description) {
        item.description = description;
        item.centroid = undefined;
        item.anchor = undefined;
      }
      if (steps !== undefined && Array.isArray(steps) && type === "workflows") item.steps = steps;
    }

    (profileData as any)[type] = sorted;

    const changeSummary =
      action === "delete"
        ? `Deleted ${type.slice(0, -1)} at index ${index}`
        : `Edited ${type.slice(0, -1)} at index ${index}`;

    const success = await userProfileManager.updateProfile(
      profile.id,
      profileData,
      0,
      changeSummary
    );
    if (!success)
      return { success: false, error: "Profile was modified by another session. Please retry." };

    return {
      success: true,
      data: { message: `${action} successful`, version: profile.version + 1 },
    };
  } catch (error) {
    log("handleUpdateProfileItem: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectTagMigration(): Promise<
  ApiResponse<{ needsMigration: boolean; count: number }>
> {
  try {
    await ensureTursoReady();
    const projectShards = await tursoShardManager.getAllShards("project", "");
    let untaggedCount = 0;
    for (const shard of projectShards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const row = await db.get(
        "SELECT COUNT(*) as count FROM memories WHERE tags IS NULL OR tags = ''"
      );
      untaggedCount += Number(row?.count ?? 0);
    }
    return { success: true, data: { needsMigration: untaggedCount > 0, count: untaggedCount } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

interface MigrationProgress {
  processed: number;
  /** Next index in the memory list to attempt; advances even when tagging fails. */
  cursor: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  isComplete: boolean;
  errors: string[];
}

const migrationProgress: MigrationProgress = {
  processed: 0,
  cursor: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  isComplete: true,
  errors: [],
};

export async function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>> {
  return { success: true, data: migrationProgress };
}

export async function handleRunTagMigrationBatch(
  batchSize: number = 5
): Promise<ApiResponse<{ processed: number; total: number; hasMore: boolean; errors: number }>> {
  try {
    await ensureTursoReady();

    // Tag generation goes through the OpenCode provider when one is
    // configured, and only falls back to the external memory API otherwise.
    // Building the external provider up front threw "External API not
    // configured" for EVERY run in an opencode-only configuration, which is
    // the recommended one: auto-capture and user-profile-learning both prefer
    // OpenCode and rethrow the provider error when the fallback is missing,
    // so the migration is now the only path that could not use it at all.
    let externalProvider: ExternalTagProvider | null = null;

    const generateTagsViaOpencode = async (content: string): Promise<string[]> => {
      const { generateStructuredOutput } = await loadOpencodeProvider();
      const { getOpenCodeClient } = await import("./ai/profile-llm-client.js");
      const { z } = await import("zod");
      const client = await getOpenCodeClient();
      const schema = z.object({ tags: z.array(z.string()) });
      const result = await generateStructuredOutput({
        client,
        providerID: CONFIG.opencodeProvider as string,
        modelID: CONFIG.opencodeModel as string,
        ...(CONFIG.opencodeVariant ? { variant: CONFIG.opencodeVariant } : {}),
        systemPrompt: "You are a technical tagger.",
        userPrompt: `Generate 2-4 short technical tags for this memory content.\n\n${content}`,
        schema,
      });
      const raw = (result as { tags?: string[] } | null)?.tags;
      return (raw ?? [])
        .map((t: string) => String(t).trim().toLowerCase())
        .filter((t: string) => t.length > 0);
    };

    const generateTags = async (
      content: string
    ): Promise<{ ok: true; tags: string[] } | { ok: false; error: string }> => {
      if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
        try {
          const tags = await generateTagsViaOpencode(content);
          return tags.length > 0 ? { ok: true, tags } : { ok: false, error: "no tags returned" };
        } catch (e) {
          // A provider fault must fall through to the external API, exactly as
          // auto-capture does, rather than failing the whole batch.
          log("tag migration: opencode provider failed, falling back to external API", {
            error: String(e),
          });
        }
      }

      // No config pre-check here on purpose: buildMemoryProviderConfig already
      // owns that knowledge and throws a precise list of what is missing, and
      // this try/catch turns it into a per-memory soft error. Duplicating the
      // check above it would short-circuit providers the factory can still
      // build (and would skip it entirely when neither provider is set, which
      // is the case this whole path exists to handle).
      try {
        if (!externalProvider) {
          const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
          const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
          const providerConfig = buildMemoryProviderConfig(CONFIG, {
            maxIterations: 1,
            iterationTimeout: 30000,
          });
          externalProvider = AIProviderFactory.createProvider(
            CONFIG.memoryProvider,
            providerConfig
          ) as unknown as ExternalTagProvider;
        }

        const result = await externalProvider.executeToolCall(
          "You are a technical tagger.",
          `Generate 2-4 short technical tags for this memory content. Call the save_tags tool with a "tags" array.\n\n${content}`,
          {
            type: "function",
            function: {
              name: "save_tags",
              description: "Save generated tags",
              parameters: {
                type: "object",
                properties: { tags: { type: "array", items: { type: "string" } } },
                required: ["tags"],
              },
            },
          },
          `migration_${content.length}`
        );
        if (result?.success && result.data?.tags) {
          return { ok: true, tags: result.data.tags };
        }
        return { ok: false, error: result?.error ?? "no tags returned" };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };

    const projectShards = await tursoShardManager.getAllShards("project", "");

    const allMemories: { memory: any; shard: any }[] = [];

    for (const shard of projectShards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memories = await db.all("SELECT * FROM memories");
      for (const m of memories) {
        allMemories.push({ memory: m, shard });
      }
    }

    // Fresh run (or retry after a completed pass): reset counters so soft
    // failures from a prior attempt can be retried instead of being skipped.
    if (migrationProgress.total === 0 || migrationProgress.isComplete) {
      migrationProgress.processed = 0;
      migrationProgress.cursor = 0;
      migrationProgress.total = allMemories.length;
      migrationProgress.totalBatches = Math.ceil(allMemories.length / batchSize);
      migrationProgress.currentBatch = 0;
      migrationProgress.isComplete = false;
      migrationProgress.errors = [];
    }

    const startIdx = migrationProgress.cursor;
    const endIdx = Math.min(startIdx + batchSize, allMemories.length);

    for (let i = startIdx; i < endIdx; i++) {
      const item = allMemories[i];
      if (!item) continue;
      const { memory: m, shard } = item;
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      try {
        let currentTags = m.tags
          ? m.tags
              .split(",")
              .map((t: string) => t.trim().toLowerCase())
              .filter((t: string) => t)
          : [];

        // A memory that already has tags and a tags vector is fully migrated:
        // re-embedding it produces the same vector and changes nothing. This
        // endpoint walks the whole list one window at a time, and the normal
        // case is a handful of untagged memories among hundreds that are done,
        // so skipping the finished ones is the difference between a few
        // seconds and re-vectorizing every memory on every run. Memories with
        // tags but no tags vector are still processed so the missing vector is
        // rebuilt.
        if (currentTags.length > 0 && m.tags_vector != null) {
          migrationProgress.processed++;
          continue;
        }

        if (currentTags.length === 0) {
          const tagged = await generateTags(m.content);
          if (tagged.ok) {
            currentTags = tagged.tags;
            await db.run("UPDATE memories SET tags = ? WHERE id = ?", [
              currentTags.join(","),
              m.id,
            ]);
          } else {
            // Soft failure (e.g. no provider): do not mark processed.
            // Cursor still advances below so the batch window moves forward.
            const errorMsg = `Tag generation failed for memory ${m.id}: ${tagged.error}`;
            migrationProgress.errors.push(errorMsg);
            log("Migration error for memory", { id: m.id, error: errorMsg });
            continue;
          }
        }

        const vector = await embeddingService.embedWithTimeout(m.content, { task: "document" });
        const tagsVector = currentTags.length
          ? await embeddingService.embedWithTimeout(formatTagsForEmbedding(currentTags), {
              task: "document",
            })
          : undefined;
        await tursoVectorSearch.updateVector(db, m.id, vector, tagsVector);

        migrationProgress.processed++;
      } catch (e) {
        const errorMsg = String(e);
        migrationProgress.errors.push(errorMsg);
        log("Migration error for memory", { id: m.id, error: errorMsg });
      }
    }

    migrationProgress.cursor = endIdx;
    migrationProgress.currentBatch++;
    const hasMore = migrationProgress.cursor < allMemories.length;

    if (!hasMore) {
      migrationProgress.isComplete = true;
    }

    return {
      success: true,
      data: {
        processed: migrationProgress.processed,
        total: migrationProgress.total,
        hasMore,
        errors: migrationProgress.errors.length,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

function skillToApi(skill: {
  id: string;
  name: string;
  description: string;
  content: string;
  autoinvoke: boolean;
  enabled: boolean;
  containerTag: string | null;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    autoinvoke: skill.autoinvoke,
    enabled: skill.enabled,
    containerTag: skill.containerTag,
    createdAt: safeToISOString(skill.createdAt),
    updatedAt: safeToISOString(skill.updatedAt),
  };
}

export async function handleListSkills(options?: {
  containerTag?: string;
  enabledOnly?: boolean;
}): Promise<ApiResponse<{ items: ReturnType<typeof skillToApi>[] }>> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const items = await skillsManager.list({
      containerTag: options?.containerTag,
      enabledOnly: options?.enabledOnly,
    });
    return { success: true, data: { items: items.map(skillToApi) } };
  } catch (error) {
    log("handleListSkills: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetSkill(
  id: string
): Promise<ApiResponse<ReturnType<typeof skillToApi>>> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const skill = await skillsManager.get(id);
    if (!skill) return { success: false, error: `Skill not found: ${id}` };
    return { success: true, data: skillToApi(skill) };
  } catch (error) {
    log("handleGetSkill: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleCreateSkill(body: {
  id?: string;
  name?: string;
  description?: string;
  content?: string;
  autoinvoke?: boolean;
  enabled?: boolean;
  containerTag?: string | null;
}): Promise<ApiResponse<ReturnType<typeof skillToApi>>> {
  try {
    if (!body?.id || !body?.name || !body?.content) {
      return { success: false, error: "id, name, and content are required" };
    }
    const { skillsManager } = await import("./skills/skills-manager.js");
    const skill = await skillsManager.create({
      id: body.id,
      name: body.name,
      description: body.description,
      content: body.content,
      autoinvoke: body.autoinvoke,
      enabled: body.enabled,
      containerTag: body.containerTag,
    });
    return { success: true, data: skillToApi(skill) };
  } catch (error) {
    log("handleCreateSkill: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateSkill(
  id: string,
  body: {
    name?: string;
    description?: string;
    content?: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
  }
): Promise<ApiResponse<ReturnType<typeof skillToApi>>> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const skill = await skillsManager.update(id, body);
    return { success: true, data: skillToApi(skill) };
  } catch (error) {
    log("handleUpdateSkill: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeleteSkill(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const deleted = await skillsManager.delete(id);
    if (!deleted) return { success: false, error: `Skill not found: ${id}` };
    return { success: true, data: { deleted: true } };
  } catch (error) {
    log("handleDeleteSkill: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleSkillsCatalogIndex(): Promise<
  ApiResponse<{ skills: Array<{ name: string; version: string; files: string[] }> }>
> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const catalog = await skillsManager.toHttpCatalog();
    return { success: true, data: catalog };
  } catch (error) {
    log("handleSkillsCatalogIndex: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleSkillsCatalogFile(
  id: string
): Promise<ApiResponse<{ markdown: string }>> {
  try {
    const { skillsManager } = await import("./skills/skills-manager.js");
    const markdown = await skillsManager.toCatalogMarkdown(id);
    if (!markdown) return { success: false, error: `Skill not found: ${id}` };
    return { success: true, data: { markdown } };
  } catch (error) {
    log("handleSkillsCatalogFile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}
