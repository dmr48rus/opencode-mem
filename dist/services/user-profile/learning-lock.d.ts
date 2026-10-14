/**
 * Standalone coordination database (`@tursodatabase/database`) inside
 * CONFIG.storagePath. It is deliberately separate from the memory database:
 * every statement here is short and autonomous, and no transaction is ever
 * held across the LLM round trip, so lock traffic cannot block normal memory
 * database work. Left unencrypted even when memory shards use encryption —
 * it only stores ephemeral lock rows.
 */
export declare const PROFILE_LEARNING_COORDINATION_DB = ".profile-learning-coordination.db";
/**
 * Serializes profile learning across every process sharing this storage path.
 *
 * Ownership is a single row in a standalone SQLite coordination database:
 *  - acquiring is one `INSERT ... ON CONFLICT DO NOTHING` (rowsAffected 1 wins);
 *  - a conflicting row is only taken over with a conditional
 *    `UPDATE ... WHERE owner_token = <old token>` (CAS) when the recorded
 *    owner is provably dead or its original process identity is gone;
 *  - release is `DELETE ... WHERE owner_token = <token>`, so a stale release
 *    from a previous owner (even with a reused PID) can never drop someone
 *    else's lock.
 *
 * Returns a release function, or null when another process holds the lock or
 * the coordination state cannot be trusted (fail-closed) — in both cases the
 * caller must skip this round rather than wait, because the next idle event
 * retries.
 *
 * Service wiring note: this function is async and must be `await`ed by the
 * caller, with the in-process `isLearningRunning` guard set before the first
 * `await`.
 */
export declare function tryAcquireProfileLearningLock(directory: string): Promise<(() => Promise<void>) | null>;
/**
 * Whether a coordination record currently exists. Test/inspection helper; a
 * database error is reported as "not held" but logged.
 */
export declare function isProfileLearningLockHeld(): Promise<boolean>;
/** Boot identity the lock would record for this process (test/inspection helper). */
export declare function getProfileLearningBootId(): string | null;
/** Starttime identity the lock would record for `pid` (test/inspection helper). */
export declare function getProfileLearningStarttime(pid: number): string | null;
//# sourceMappingURL=learning-lock.d.ts.map