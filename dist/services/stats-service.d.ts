import type { ShardInfo } from "./turso/types.js";
export type DailyCounter = "captures" | "captureSkipped" | "profileInjections" | "compactionInjections";
export interface ParsedLogLine {
    date: string;
    message: string;
    payload?: string;
}
export interface LogClassification {
    counter?: DailyCounter;
    errorBucket?: string;
}
export interface DailyStats {
    date: string;
    captures: number;
    captureSkipped: number;
    profileInjections: number;
    compactionInjections: number;
    errors: Record<string, number>;
}
export interface ShardStats {
    shardId: number | null;
    scope: "user" | "project";
    scopeHash: string;
    shardIndex: number;
    fileName: string;
    fileExists: boolean;
    isActive: boolean;
    registeredVectorCount: number;
    memoryCount: number;
    oldestCreatedAt: string | null;
    newestCreatedAt: string | null;
    duplicateTagCount: number;
    error?: string;
}
export interface ShardCollection {
    shards: ShardStats[];
    total: number;
    byScope: {
        user: number;
        project: number;
    };
    byType: Record<string, number>;
}
/** Parse a structured logger line, splitting the message only at the first `: {`. */
export declare function parseLogLine(line: string): ParsedLogLine | null;
/** Classify a parsed logger message as one daily counter or a named error bucket. */
export declare function classifyLogMessage(message: string): LogClassification;
export interface CollectDailyStatsOptions {
    logDir?: string;
    days?: number;
    now?: Date;
}
/** Read and aggregate structured log counters into a local-date, zero-filled series. */
export declare function collectDailyStats({ logDir, days, now, }?: CollectDailyStatsOptions): DailyStats[];
/** Collects registered shard health while preserving the existing stats totals. */
export declare function collectShardStats(shards: ShardInfo[]): Promise<ShardCollection>;
export interface ProfileStats {
    exists: boolean;
    version?: number;
    counts?: {
        preferences: number;
        patterns: number;
        workflows: number;
    };
    lastAnalyzedAt?: string;
    totalPromptsAnalyzed?: number;
    error?: string;
}
/** Read the active user's compact profile summary without returning profile contents. */
export declare function collectProfileStats(): Promise<ProfileStats>;
//# sourceMappingURL=stats-service.d.ts.map