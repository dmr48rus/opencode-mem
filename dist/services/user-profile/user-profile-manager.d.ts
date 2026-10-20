import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";
import { EmbeddingService } from "../embedding.js";
export declare class UserProfileManager {
    private db;
    private dbPath;
    private initPromise;
    private coldBuffers;
    private coldBufferPath;
    /**
     * Set when the last disk read of cold-buffer.json failed in a way that means
     * "unknown on-disk state" (permission error, unparseable JSON, bad schema).
     * A merge round must then fail closed instead of treating the data as empty
     * and overwriting it. The constructor stays fail-safe: a non-critical cache
     * read error must never crash the plugin import path, so it is only recorded.
     */
    private coldBufferLoadError;
    private dedupCheckedCache;
    constructor();
    reset(): void;
    private initialize;
    private ready;
    private emptyColdBuffer;
    /**
     * Fail-safe wrapper for the constructor / reset() path. A non-critical cache
     * read error must not crash plugin import, so the error is recorded and an
     * empty map is returned; the next merge round then fails closed.
     */
    private loadColdBuffersFailSafe;
    /**
     * Reads the complete cold-buffer snapshot from disk, strictly.
     *
     * A missing file (ENOENT) legitimately means "empty snapshot". Any other
     * failure (permissions, unparseable JSON, malformed schema) means the
     * on-disk state is unknown and MUST be thrown to the caller — treating it
     * as empty would persist an empty snapshot over data we never read.
     */
    private loadColdBuffers;
    /**
     * Starts a merge round from the freshest complete on-disk snapshot.
     *
     * Cooperative learners take the learning lock, then re-read the snapshot at
     * the start of every merge round, so a peer's persisted buckets are never
     * clobbered by a stale in-memory map (mtime comparison cannot be trusted:
     * same-mtime writes and clock rollback both hide peer updates). The loaded
     * map is fixed for the whole round: every buffer mutation and save in this
     * round goes through the same reference, so pending unsaved increments are
     * never dropped by a mid-round reference swap.
     */
    private beginColdBufferRound;
    private getColdBuffer;
    /**
     * Persists the current snapshot atomically: write a unique tmp file with
     * O_EXCL (wx) and mode 0600, then rename over the target. Failures are
     * thrown to the caller — swallowing them would let a round that never
     * reached disk be reported as a successful learning merge.
     */
    private saveColdBuffers;
    private initDatabase;
    getActiveProfile(userId: string): Promise<UserProfile | null>;
    createProfile(userId: string, displayName: string, userName: string, userEmail: string, profileData: UserProfileData, promptsAnalyzed: number): Promise<string>;
    updateProfile(profileId: string, profileData: UserProfileData, additionalPromptsAnalyzed: number, changeSummary: string): Promise<boolean>;
    private addChangelog;
    private cleanupOldChangelogs;
    getProfileChangelogs(profileId: string, limit?: number): Promise<UserProfileChangelog[]>;
    getChangelogById(id: string): Promise<UserProfileChangelog | undefined>;
    decayInMemory(data: UserProfileData): {
        data: UserProfileData;
        hasChanges: boolean;
    };
    private decayItems;
    deleteProfile(profileId: string): Promise<void>;
    /**
     * Move a profile to another identity.
     *
     * The profile is the learned part of a person: the preferences, the
     * patterns, the workflows. It follows the person, not the machine, so a new
     * PC can take over the identity of the old one. The changelog rows are keyed
     * by profile id, so they travel with the profile.
     *
     * A target that already has a profile is refused: merging two identities
     * silently is how a profile ends up with two contradictory halves.
     */
    transferIdentity(fromUserId: string, toUserId: string): Promise<{
        moved: number;
        from: string;
        to: string;
    }>;
    getProfileById(profileId: string): Promise<UserProfile | null>;
    getAllActiveProfiles(): Promise<UserProfile[]>;
    private rowToProfile;
    private rowToChangelog;
    mergeProfileData(existing: UserProfileData, updates: Partial<UserProfileData>, embedService?: EmbeddingService, profileId?: string): Promise<UserProfileData>;
    private mergeItems;
    /**
     * Merge a new confirmed observation into an existing profile entry.
     * ONLY call for confirmed matches (exact, strong sameCat/crossCat, Thompson upgrade).
     * Do NOT call for forced merge or cross-validation — those handle fields directly.
     */
    private mergeConfirmedMatch;
    private initItem;
    /**
     * Three-way merge: item1 + item2 + newItem → single combined entry.
     * Called when top-1 and top-2 both strongly match the same new observation
     * within the same category, confirming they describe the same behavior.
     */
    private combineThree;
    private ensureArray;
    private isMilestone;
    private minEvidenceForEvolve;
    syncConfidence(item: any): void;
    private lazyMigrateAlpha;
    private detectConflicts;
    private checkSemanticDuplicate;
    private deduplicateItems;
    private checkConflict;
    private evolveDescription;
    evolveAndUpdate(item: any, itemType: string, profileId?: string): Promise<void>;
    private callOpencodeProvider;
    private callExternalAPI;
}
export declare const userProfileManager: UserProfileManager;
//# sourceMappingURL=user-profile-manager.d.ts.map