/**
 * Remote memory storage: the same plugin, but memories live on another machine
 * behind the plugin's own HTTP API.
 *
 * Why a service-level client and not a database driver: the fork reaches its
 * store through libsql `file:` URLs and issues arbitrary SQL (vector_distance_cos,
 * vector_extract, transactions). None of that can be proxied over REST, so the
 * driver idea is not merely hard, it is impossible. What is proxied instead is
 * the set of operations the plugin actually performs -- the same set the server
 * already exposes under /api.
 *
 * The server embeds, so this client never touches ONNX: /api/search takes the
 * query as text and embeds it server-side, and /api/memories POST stores the
 * content and embeds it there. That is what lets the client drop its local
 * model.
 *
 * Configuration is passed in rather than read from CONFIG, so this module can be
 * exercised without a plugin instance.
 */
export interface RemoteStorageConfig {
    enabled: boolean;
    baseUrl: string;
    apiToken?: string;
    timeoutMs: number;
}
export interface RemoteMemoryRecord {
    id: string;
    content: string;
    containerTag?: string;
    tags?: string[];
    type?: string;
    createdAt?: number;
    updatedAt?: number;
    isPinned?: boolean;
    metadata?: unknown;
    sessionId?: string;
    similarity?: number;
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
}
export interface RemoteSearchOptions {
    tags?: string[];
    page?: number;
    pageSize?: number;
    includePrompts?: boolean;
}
export declare class RemoteStorageError extends Error {
    readonly status: number;
    readonly path: string;
    constructor(message: string, status: number, path: string);
}
type FetchLike = typeof fetch;
/**
 * The server's shape for a skill, which is what `GET /api/skills` returns.
 *
 * It is NOT the client's SkillRecord and deliberately so: the columns
 * container_tag and autoinvoke exist in both, but created_at / updated_at come
 * back as ISO strings here and as epoch numbers in the local row. Converting
 * once, in skills-manager, keeps that knowledge in one place instead of
 * spreading "maybe it is a date, maybe it is a number" across the call sites.
 */
export interface RemoteSkillRecord {
    id: string;
    name: string;
    description: string;
    content: string;
    autoinvoke: boolean;
    enabled: boolean;
    containerTag: string | null;
    createdAt?: string;
    updatedAt?: string;
}
export interface RemoteSkillInput {
    id: string;
    name: string;
    description?: string;
    content: string;
    autoinvoke?: boolean;
    enabled?: boolean;
    containerTag?: string | null;
}
export type RemoteSkillUpdate = Partial<Omit<RemoteSkillInput, "id">>;
export interface RemoteStorageClient {
    search(query: string, options?: RemoteSearchOptions): Promise<RemoteMemoryRecord[]>;
    getMemoryById(id: string): Promise<RemoteMemoryRecord | null>;
    listMemories(tags: string[], page: number, pageSize: number): Promise<RemoteMemoryRecord[]>;
    getTags(): Promise<{
        tag: string;
    }[]>;
    stats(): Promise<Record<string, unknown>>;
    addMemory(data: RemoteMemoryRecord & {
        content: string;
        containerTag: string;
    }): Promise<{
        id: string;
    }>;
    updateMemory(id: string, data: {
        content?: string;
        type?: string;
        tags?: string[];
    }): Promise<void>;
    deleteMemory(id: string, cascade?: boolean): Promise<void>;
    getProfile(userId?: string): Promise<Record<string, unknown> | null>;
    putProfile(payload: {
        userId?: string;
        profileData: Record<string, unknown>;
        promptsAnalyzed?: number;
        changeSummary?: string;
    }): Promise<{
        profileId: string;
        version: number;
        created: boolean;
    }>;
    listSkills(options?: {
        enabledOnly?: boolean;
    }): Promise<RemoteSkillRecord[]>;
    getSkill(id: string): Promise<RemoteSkillRecord | null>;
    createSkill(payload: RemoteSkillInput): Promise<RemoteSkillRecord>;
    updateSkill(id: string, payload: RemoteSkillUpdate): Promise<RemoteSkillRecord>;
    deleteSkill(id: string): Promise<void>;
}
export declare function getRemoteStore(): RemoteStorageClient | null;
export declare function resetRemoteStore(): void;
/**
 * Read path only. Writes land in the same file as the second half of this work;
 * until they exist, remoteStorage.enabled must stay false, or the client would
 * write memories locally while reading them from the server and silently split
 * the store in two.
 */
export declare function createRemoteStorageClient(config: RemoteStorageConfig, fetchImpl?: FetchLike): RemoteStorageClient;
export {};
//# sourceMappingURL=remote-storage.d.ts.map