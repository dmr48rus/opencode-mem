export type MemoryTier = "semantic" | "procedural" | "episodic";
export declare function classifyTier(type: string | null | undefined): MemoryTier;
export type SweepCandidate = {
    id: string;
    tier: MemoryTier;
    ageDays: number;
    type?: string;
};
export type SweepReport = {
    dryRun: boolean;
    scanned: number;
    byTier: Record<MemoryTier, number>;
    aged: number;
    restored: number;
    candidates: SweepCandidate[];
};
export type SweepOptions = {
    episodicDays?: number;
    proceduralDays?: number;
    dryRun?: boolean;
    limit?: number;
    restore?: boolean;
};
export declare function runMemorySweep(options?: SweepOptions): Promise<SweepReport>;
//# sourceMappingURL=memory-aging.d.ts.map