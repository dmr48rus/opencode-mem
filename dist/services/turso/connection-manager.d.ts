import { type Database } from "@tursodatabase/database";
import type { DatabaseOpts, EncryptionOpts } from "@tursodatabase/database-common";
import { TursoDb } from "./turso-db.js";
export type ConnectFactory = (path: string, opts?: DatabaseOpts) => Promise<Database>;
/** Always-on experimental flags for every Turso open. */
export declare const TURSO_BASE_EXPERIMENTAL_FEATURES: readonly ["encryption"];
/**
 * Multiprocess WAL is Unix-only. On Windows/WASM/32-bit the flag is accepted but
 * ignored (single-process mode) — see Turso multi-process docs.
 */
export declare function supportsTursoMultiprocessWal(platform?: NodeJS.Platform): boolean;
/** Experimental flags required on every Turso open for the current platform. */
export declare function tursoExperimentalFeatures(platform?: NodeJS.Platform): Array<(typeof TURSO_BASE_EXPERIMENTAL_FEATURES)[number] | "multiprocess_wal">;
/**
 * Shared connect options for `@tursodatabase/database`.
 * Always enables encryption; adds multiprocess_wal on Unix so concurrent
 * OpenCode sessions can share the store. Windows stays single-process.
 */
export declare function buildConnectOptions(encryption?: EncryptionOpts | null): DatabaseOpts;
export declare function resolveDatabaseEncryption(): EncryptionOpts | null;
export declare function isTursoMultiProcessLockError(error: unknown): boolean;
export declare function wrapTursoOpenError(dbPath: string, error: unknown): Error;
export declare class TursoConnectionManager {
    private readonly connectFactory;
    private readonly connections;
    private readonly pending;
    private readonly closingConnections;
    private closingPromise;
    constructor(connectFactory?: ConnectFactory);
    getConnection(dbPath: string): Promise<TursoDb>;
    closeConnection(dbPath: string): Promise<void>;
    closeAll(): Promise<void>;
    closeAllSync(): void;
}
export declare const tursoConnectionManager: TursoConnectionManager;
//# sourceMappingURL=connection-manager.d.ts.map