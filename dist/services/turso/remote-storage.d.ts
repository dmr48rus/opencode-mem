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