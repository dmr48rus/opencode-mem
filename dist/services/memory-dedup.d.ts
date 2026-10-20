export type SoftDedupSample = {
    representative: string;
    duplicate: string;
    similarity: number;
    containerTag: string;
};
export type SoftDedupResult = {
    dryRun: boolean;
    coldDays: number;
    groups: number;
    marked: number;
    skippedWarm: number;
    skippedAlreadyMarked: number;
    samples: SoftDedupSample[];
};
export declare function markNearDuplicates(options?: {
    dryRun?: boolean;
    coldDays?: number;
    limit?: number;
}): Promise<SoftDedupResult>;
//# sourceMappingURL=memory-dedup.d.ts.map