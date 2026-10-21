type ConflictKind = "value" | "polarity";
export type CompactSample = {
    duplicate: string;
    canonical: string;
    ageDays: number;
};
export type CompactResult = {
    dryRun: boolean;
    coldDays: number;
    clusters: number;
    compacted: number;
    restored: number;
    skippedWarm: number;
    samples: CompactSample[];
};
/**
 * Fold the marked duplicates into their canonical copies.
 *
 * Only the cold clusters: a duplicate of this week is still a fresh thought,
 * and folding it away hides what was just written. The canonical copy stays
 * where it is, and the fold is undone by clearing the marker.
 */
export declare function compactDuplicates(options?: {
    dryRun?: boolean;
    coldDays?: number;
    limit?: number;
    restore?: boolean;
}): Promise<CompactResult>;
export type ConflictSample = {
    memoryId: string;
    otherId: string;
    kind: ConflictKind;
    confidence: number;
    reason: string;
};
export type ConflictScanResult = {
    dryRun: boolean;
    scanned: number;
    pairs: number;
    flagged: number;
    samples: ConflictSample[];
};
/**
 * Find the records that contradict each other and flag the pair.
 *
 * Nothing is resolved: both records stay where they are and both stay
 * searchable. The flag says that they disagree, and the owner decides.
 */
export declare function scanContradictions(options?: {
    dryRun?: boolean;
    limit?: number;
}): Promise<ConflictScanResult>;
export type ProfileCleanReport = {
    dryRun: boolean;
    profiles: number;
    removed: number;
    restored: number;
    items: Array<{
        profileId: string;
        kind: string;
        description: string;
    }>;
};
/**
 * Forget the profile items whose support was forgotten.
 *
 * The profile is a derivate of the records, so a record that the sweep put
 * away takes its profile item with it - but only when no live record still
 * supports the item. An item that another record backs stays, and an item that
 * no forgotten record ever matched stays as well: it was learned from the
 * prompts and the store never held it.
 *
 * The cleaning is idempotent and reversible: the items it removed are in the
 * profile's changelog, so they are candidates again, and a record that came
 * back brings its item back with it.
 */
export declare function forgetUnsupportedProfileItems(options?: {
    dryRun?: boolean;
}): Promise<ProfileCleanReport>;
export {};
//# sourceMappingURL=memory-hygiene.d.ts.map