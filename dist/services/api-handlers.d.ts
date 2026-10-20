import { collectDailyStats, collectProfileStats, collectShardStats, type CollectDailyStatsOptions } from "./stats-service.js";
import type { ShadowMode } from "./turso/vector-search.js";
import type { MemoryType } from "../types/index.js";
import type { UserProfileData } from "./user-profile/types.js";
interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
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
export declare function handleListTags(): Promise<ApiResponse<{
    project: TagInfo[];
    user: TagInfo[];
}>>;
export declare function handleListMemories(tag?: string | string[], page?: number, pageSize?: number, includePrompts?: boolean): Promise<ApiResponse<PaginatedResponse<Memory | any>>>;
export declare function handleAddMemory(data: {
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
}): Promise<ApiResponse<{
    id: string;
}>>;
export declare function handleDeleteMemory(id: string, cascade?: boolean): Promise<ApiResponse<{
    deletedPrompt: boolean;
}>>;
export declare function handleBulkDelete(ids: string[], cascade?: boolean): Promise<ApiResponse<{
    deleted: number;
}>>;
export declare function handleUpdateMemory(id: string, data: {
    content?: string;
    type?: MemoryType;
    tags?: string[];
}): Promise<ApiResponse<void>>;
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
export declare function handleSearch(query: string, tag?: string | string[], page?: number, pageSize?: number): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>>;
/**
 * The state of the store without a question: pinned and recent records plus
 * counts.
 *
 * No embedding is computed here, and that is the point: the packet is cheap
 * enough to read at the start of every session, where a search would cost an
 * embedding call per query. The shape follows the bootstrap read of the
 * remind project.
 */
export declare function handleSnapshot(limit?: number): Promise<ApiResponse<any>>;
/**
 * Write a record into a project scope.
 *
 * The scope tag is `opencode_project_<hash>` and the readable path is known
 * only from the tags the shards carry, so the project is resolved here - by
 * path first, then by name - and a miss names the known projects instead of
 * failing silently.
 */
export declare function handleRememberByProject(data: {
    content: string;
    tags?: string[];
    project?: string;
    type?: string;
}): Promise<ApiResponse<any>>;
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
export declare function handleRunReindex(data?: {
    limit?: number;
    batchSize?: number;
    mode?: ShadowMode;
}): Promise<ApiResponse<any>>;
export declare function handleRunSweep(data?: {
    dryRun?: boolean;
    episodicDays?: number;
    proceduralDays?: number;
    limit?: number;
    restore?: boolean;
}): Promise<ApiResponse<any>>;
export declare function handleStats(options?: Pick<CollectDailyStatsOptions, "logDir" | "now"> & {
    probe?: boolean;
}): Promise<ApiResponse<{
    total: number;
    byScope: {
        user: number;
        project: number;
    };
    byType: Record<string, number>;
    generatedAt: string;
    shards: Awaited<ReturnType<typeof collectShardStats>>["shards"];
    profile: Awaited<ReturnType<typeof collectProfileStats>>;
    daily: ReturnType<typeof collectDailyStats>;
    dailyError?: string;
    memoryMb?: {
        rss: number;
        heapUsed: number;
        external: number;
    };
}>>;
export declare function handlePinMemory(id: string): Promise<ApiResponse<void>>;
export declare function handleUnpinMemory(id: string): Promise<ApiResponse<void>>;
export declare function handleRunCleanup(): Promise<ApiResponse<{
    deletedCount: number;
    userCount: number;
    projectCount: number;
}>>;
/**
 * Mark the near-duplicates instead of deleting them.
 *
 * A dry run is the default: the report says what would be marked, and the
 * store is only touched when the caller says so.
 */
export declare function handleMarkDuplicates(data?: {
    dryRun?: boolean;
    coldDays?: number;
    limit?: number;
}): Promise<ApiResponse<any>>;
export declare function handleRunDeduplication(): Promise<ApiResponse<{
    exactDuplicatesDeleted: number;
    nearDuplicateGroups: any[];
}>>;
export declare function handleDetectMigration(): Promise<ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
}>>;
export declare function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
}>>;
export declare function handleDeletePrompt(id: string, cascade?: boolean): Promise<ApiResponse<{
    deletedMemory: boolean;
}>>;
export declare function handleBulkDeletePrompts(ids: string[], cascade?: boolean): Promise<ApiResponse<{
    deleted: number;
}>>;
/**
 * Move a profile to another identity.
 *
 * The identity belongs to the person, not to the machine: when the work
 * moves to another PC, the learned profile has to move with it. The master
 * token only - a client key may not take over somebody else's identity.
 */
export declare function handleTransferProfileIdentity(data: {
    fromUserId?: string;
    toUserId?: string;
}): Promise<ApiResponse<any>>;
export declare function handleGetUserProfile(userId?: string, raw?: boolean): Promise<ApiResponse<any>>;
export declare function handlePutUserProfile(data: {
    userId?: string;
    profileData: Record<string, unknown>;
    promptsAnalyzed?: number;
    changeSummary?: string;
}): Promise<ApiResponse<{
    profileId: string;
    version: number;
    created: boolean;
}>>;
export declare function handleGetProfileChangelog(profileId: string, limit?: number): Promise<ApiResponse<any[]>>;
export declare function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>>;
export declare function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>>;
export declare function handleAICleanup(userId?: string, includeIds?: string[], profileVersion?: number): Promise<ApiResponse<any>>;
/**
 * Merge an AI-cleanup result into a full profile.
 * When includeIds is set, only scoped items are mutated; everything else is preserved.
 */
export declare function mergeCleanupIntoProfile(args: {
    currentProfile: UserProfileData;
    oldProfileData: UserProfileData;
    cleanedData: UserProfileData;
    includeIds?: string[];
    acceptedMerged?: string[][];
    acceptedRemoved?: string[];
    allMerged?: Array<{
        ids: string[];
        result: string;
    }>;
    allRemovedIds?: string[];
    /** True when the client sent acceptance arrays (even if empty = reject all). */
    explicitAcceptance?: boolean;
}): UserProfileData;
export declare function handleApplyCleanup(userId?: string, body?: any): Promise<ApiResponse<any>>;
export declare function handleUpdateProfileItem(body?: any): Promise<ApiResponse<any>>;
export declare function handleDetectTagMigration(): Promise<ApiResponse<{
    needsMigration: boolean;
    count: number;
}>>;
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
export declare function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>>;
export declare function handleRunTagMigrationBatch(batchSize?: number): Promise<ApiResponse<{
    processed: number;
    total: number;
    hasMore: boolean;
    errors: number;
}>>;
declare function skillToApi(skill: {
    id: string;
    name: string;
    description: string;
    content: string;
    autoinvoke: boolean;
    enabled: boolean;
    containerTag: string | null;
    createdAt: number;
    updatedAt: number;
}): {
    id: string;
    name: string;
    description: string;
    content: string;
    autoinvoke: boolean;
    enabled: boolean;
    containerTag: string | null;
    createdAt: string;
    updatedAt: string;
};
export declare function handleListSkills(options?: {
    containerTag?: string;
    enabledOnly?: boolean;
}): Promise<ApiResponse<{
    items: ReturnType<typeof skillToApi>[];
}>>;
export declare function handleGetSkill(id: string): Promise<ApiResponse<ReturnType<typeof skillToApi>>>;
export declare function handleCreateSkill(body: {
    id?: string;
    name?: string;
    description?: string;
    content?: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
}): Promise<ApiResponse<ReturnType<typeof skillToApi>>>;
export declare function handleUpdateSkill(id: string, body: {
    name?: string;
    description?: string;
    content?: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
}): Promise<ApiResponse<ReturnType<typeof skillToApi>>>;
export declare function handleDeleteSkill(id: string): Promise<ApiResponse<{
    deleted: boolean;
}>>;
export declare function handleSkillsCatalogIndex(): Promise<ApiResponse<{
    skills: Array<{
        name: string;
        version: string;
        files: string[];
    }>;
}>>;
export declare function handleSkillsCatalogFile(id: string): Promise<ApiResponse<{
    markdown: string;
}>>;
export {};
//# sourceMappingURL=api-handlers.d.ts.map