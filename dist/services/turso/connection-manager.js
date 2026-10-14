import { connect } from "@tursodatabase/database";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { collectReleasedSqliteHandles } from "./sqlite-handle-release.js";
import { TursoDb } from "./turso-db.js";
import { resolveOrCreateDatabaseEncryptionKey } from "./encryption-key.js";
/** Always-on experimental flags for every Turso open. */
export const TURSO_BASE_EXPERIMENTAL_FEATURES = ["encryption"];
/**
 * Multiprocess WAL is Unix-only. On Windows/WASM/32-bit the flag is accepted but
 * ignored (single-process mode) — see Turso multi-process docs.
 */
export function supportsTursoMultiprocessWal(platform = process.platform) {
    return platform !== "win32";
}
/** Experimental flags required on every Turso open for the current platform. */
export function tursoExperimentalFeatures(platform = process.platform) {
    if (supportsTursoMultiprocessWal(platform)) {
        return [...TURSO_BASE_EXPERIMENTAL_FEATURES, "multiprocess_wal"];
    }
    return [...TURSO_BASE_EXPERIMENTAL_FEATURES];
}
function assertPathInsideStorage(dbPath) {
    const storageRoot = resolve(CONFIG.storagePath);
    const resolvedPath = resolve(dbPath);
    const relativePath = relative(storageRoot, resolvedPath);
    // Only treat path-segment traversal as escape (not filenames containing "..").
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Refusing to open database outside storagePath: ${dbPath}`);
    }
}
/**
 * Shared connect options for `@tursodatabase/database`.
 * Always enables encryption; adds multiprocess_wal on Unix so concurrent
 * OpenCode sessions can share the store. Windows stays single-process.
 */
export function buildConnectOptions(encryption) {
    const opts = {
        experimental: tursoExperimentalFeatures(),
    };
    if (encryption) {
        opts.encryption = encryption;
    }
    return opts;
}
export function resolveDatabaseEncryption() {
    const hexkey = resolveOrCreateDatabaseEncryptionKey();
    if (!hexkey)
        return null;
    return {
        cipher: CONFIG.databaseEncryptionCipher,
        hexkey,
    };
}
const LOCK_ERROR_RE = /File is locked by another process|already open (with|without) experimental multiprocess WAL|Locking error/i;
export function isTursoMultiProcessLockError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return LOCK_ERROR_RE.test(message);
}
export function wrapTursoOpenError(dbPath, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTursoMultiProcessLockError(error)) {
        const platformHint = process.platform === "win32"
            ? "On Windows the Turso engine still allows only one process as database owner — close other OpenCode sessions."
            : "Another OpenCode session (or an older opencode-mem without multiprocess_wal) still holds the database — close it and retry.";
        return new Error(`Failed to open database ${dbPath}: ${message}. ${platformHint}`, {
            cause: error,
        });
    }
    return error instanceof Error ? error : new Error(message, { cause: error });
}
export class TursoConnectionManager {
    connectFactory;
    connections = new Map();
    pending = new Map();
    closingConnections = new Map();
    closingPromise = null;
    constructor(connectFactory = connect) {
        this.connectFactory = connectFactory;
    }
    async getConnection(dbPath) {
        if (this.closingPromise) {
            await this.closingPromise;
        }
        const closingConnection = this.closingConnections.get(dbPath);
        if (closingConnection) {
            await closingConnection;
        }
        assertPathInsideStorage(dbPath);
        const existing = this.connections.get(dbPath);
        if (existing) {
            return existing;
        }
        const inFlight = this.pending.get(dbPath);
        if (inFlight) {
            return inFlight;
        }
        const openPromise = (async () => {
            const dir = dirname(dbPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            const encryption = resolveDatabaseEncryption();
            const opts = buildConnectOptions(encryption);
            let database = null;
            try {
                database = await this.connectFactory(dbPath, opts);
                const db = new TursoDb(database);
                await db.execute("PRAGMA foreign_keys = ON");
                this.connections.set(dbPath, db);
                return db;
            }
            catch (error) {
                if (database) {
                    try {
                        await database.close();
                    }
                    catch {
                        // ignore close errors during cleanup
                    }
                }
                if (encryption) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (isTursoMultiProcessLockError(error)) {
                        throw wrapTursoOpenError(dbPath, error);
                    }
                    throw new Error(`Failed to open encrypted database ${dbPath}: ${message}. ` +
                        `Check databaseEncryptionKey / cipher, or remove encryption config for plaintext shards.`, { cause: error });
                }
                throw wrapTursoOpenError(dbPath, error);
            }
        })();
        this.pending.set(dbPath, openPromise);
        try {
            return await openPromise;
        }
        catch (error) {
            this.connections.delete(dbPath);
            throw error;
        }
        finally {
            this.pending.delete(dbPath);
        }
    }
    async closeConnection(dbPath) {
        if (this.closingPromise) {
            await this.closingPromise;
        }
        const existingClose = this.closingConnections.get(dbPath);
        if (existingClose) {
            return existingClose;
        }
        const closePromise = Promise.resolve()
            .then(async () => {
            const pending = this.pending.get(dbPath);
            if (pending) {
                await Promise.allSettled([pending]);
            }
            const db = this.connections.get(dbPath);
            if (db) {
                try {
                    await db.close();
                }
                catch (error) {
                    log("Error closing Turso database", { path: dbPath, error: String(error) });
                }
                this.connections.delete(dbPath);
            }
            await collectReleasedSqliteHandles();
        })
            .finally(() => {
            this.closingConnections.delete(dbPath);
        });
        this.closingConnections.set(dbPath, closePromise);
        return closePromise;
    }
    async closeAll() {
        if (this.closingPromise)
            return this.closingPromise;
        this.closingPromise = (async () => {
            await Promise.allSettled([...this.pending.values(), ...this.closingConnections.values()]);
            for (const [path, db] of this.connections) {
                try {
                    await db.close();
                }
                catch (error) {
                    log("Error closing Turso database", { path, error: String(error) });
                }
            }
            this.connections.clear();
            this.pending.clear();
            await collectReleasedSqliteHandles();
        })();
        try {
            await this.closingPromise;
        }
        finally {
            this.closingPromise = null;
        }
    }
    closeAllSync() {
        for (const [path, db] of this.connections) {
            try {
                void db.close();
            }
            catch (error) {
                log("Error closing Turso database (sync)", { path, error: String(error) });
            }
        }
        this.connections.clear();
        this.pending.clear();
    }
}
export const tursoConnectionManager = new TursoConnectionManager();
