export declare const RETRYABLE_FILE_LOCK_CODES: Set<string>;
/**
 * Rename a SQLite/Turso database file together with its WAL/SHM/TSHM sidecars.
 * Leaving a `.tmp-wal` behind after renaming only the main file drops commits.
 * `-tshm` is Turso multiprocess WAL shared memory (multiprocess_wal).
 */
export declare function renameSqliteDatabase(fromPath: string, toPath: string): void;
/**
 * Copy a SQLite/Turso database file together with its WAL/SHM/TSHM sidecars.
 */
export declare function copySqliteDatabase(fromPath: string, toPath: string): void;
/**
 * Remove a SQLite/Turso database file together with WAL/SHM/TSHM sidecars.
 */
export declare function removeSqliteDatabase(dbPath: string): void;
/**
 * libsql 0.5.x leaves prepared-statement handles alive until garbage collection.
 * Collect them before Windows file swaps/removals that require exclusive access.
 *
 * Upstream: https://github.com/tursodatabase/libsql-js/issues/228
 */
export declare function collectReleasedSqliteHandles(): Promise<void>;
/**
 * Retries Windows file mutations while stable libsql releases native handles.
 * The operation runs at most `maxRetries + 1` times: the initial attempt plus
 * up to `maxRetries` retries. Non-lock errors and non-Windows platforms fail
 * immediately. The default covers every entry in the delay table, matching the
 * pre-parameter behavior exactly.
 */
export declare function withSqliteFileLockRetry<T>(operation: () => T | Promise<T>, maxRetries?: number): Promise<T>;
//# sourceMappingURL=sqlite-handle-release.d.ts.map