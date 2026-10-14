import type { MemoryType } from "../types/index.js";
export type MemoryScope = "project" | "all-projects";
export declare class LocalMemoryClient {
    private initPromise;
    private isInitialized;
    constructor();
    private initialize;
    warmup(progressCallback?: (progress: any) => void): Promise<void>;
    isReady(): Promise<boolean>;
    getEmbeddingInitError(): string | null;
    getStatus(): {
        dbConnected: boolean;
        modelLoaded: boolean;
        ready: boolean;
        embeddingError: string | null;
    };
    reset(): void;
    close(): Promise<void>;
    searchMemories(query: string, containerTag: string, scope?: MemoryScope): Promise<{
        success: true;
        results: import("./turso/remote-storage.js").RemoteMemoryRecord[];
        total: number;
        timing: number;
        error?: undefined;
    } | {
        warnings?: string[] | undefined;
        success: true;
        results: import("./turso/types.js").SearchResult[];
        total: number;
        timing: number;
        error?: undefined;
    } | {
        success: false;
        error: string;
        results: never[];
        total: number;
        timing: number;
    }>;
    addMemory(content: string, containerTag: string, metadata?: {
        type?: MemoryType;
        source?: "manual" | "auto-capture" | "import" | "api";
        tags?: string[];
        tool?: string;
        sessionID?: string;
        reasoning?: string;
        captureTimestamp?: number;
        displayName?: string;
        userName?: string;
        userEmail?: string;
        projectPath?: string;
        projectName?: string;
        gitRepoUrl?: string;
        [key: string]: unknown;
    }): Promise<{
        success: true;
        id: string;
        error?: undefined;
    } | {
        success: false;
        error: string;
        id?: undefined;
    }>;
    deleteMemory(memoryId: string): Promise<{
        success: boolean;
        error?: undefined;
    } | {
        success: boolean;
        error: string;
    }>;
    listMemories(containerTag: string, limit?: number, scope?: MemoryScope, tagFilters?: string[]): Promise<{
        success: true;
        memories: {
            id: any;
            summary: any;
            createdAt: string;
            tags: string[];
            metadata: any;
            displayName: any;
            userName: any;
            userEmail: any;
            projectPath: any;
            projectName: any;
            gitRepoUrl: any;
        }[];
        pagination: {
            currentPage: number;
            totalItems: number;
            totalPages: number;
        };
        error?: undefined;
    } | {
        success: false;
        error: string;
        memories: never[];
        pagination: {
            currentPage: number;
            totalItems: number;
            totalPages: number;
        };
    }>;
    ensureStorageReady(): Promise<void>;
    listShards(currentDirectory: string): Promise<import("./shard-inventory-service.js").ListShardsResult | {
        success: false;
        error: string;
    }>;
    migrateProjectPath(options: {
        currentDirectory: string;
        fromPath?: string;
        fromHash?: string;
        dryRun?: boolean;
        allowLinkedSource?: boolean;
    }): Promise<import("./shard-path-migration-service.js").PathMigrationResult>;
    exportMemories(currentDirectory: string, outputPath: string): Promise<import("./memory-portability-service.js").ExportMemoriesResult>;
    importMemories(currentDirectory: string, inputPath: string, dryRun?: boolean): Promise<import("./memory-portability-service.js").ImportMemoriesResult>;
    searchMemoriesBySessionID(sessionID: string, containerTag: string, limit?: number): Promise<{
        success: true;
        results: {
            id: any;
            memory: any;
            similarity: number;
            tags: any;
            metadata: any;
            containerTag: any;
            displayName: any;
            userName: any;
            userEmail: any;
            projectPath: any;
            projectName: any;
            gitRepoUrl: any;
            createdAt: any;
        }[];
        total: number;
        timing: number;
        error?: undefined;
    } | {
        success: false;
        error: string;
        results: never[];
        total: number;
        timing: number;
    }>;
}
export declare const memoryClient: LocalMemoryClient;
//# sourceMappingURL=client.d.ts.map