export declare const DEFAULT_DATABASE_ENCRYPTION_KEY_PATH: string;
export declare function isValidDatabaseEncryptionHexKey(value: string): boolean;
/**
 * Create a new AES-256 key (32 random bytes as 64 hex chars) at path with mode 0600.
 * Refuses to create a new key when encrypted DBs already exist (fail-closed).
 */
export declare function generateDatabaseEncryptionKeyFile(keyPath?: string): string;
/**
 * Ensure a key file exists (generate once if missing), then return its hex contents.
 */
export declare function ensureDatabaseEncryptionKeyFile(keyPath?: string): string;
/**
 * Resolve the active encryption hex key, auto-generating the default key file when
 * encryption is enabled and no key is configured yet.
 */
export declare function resolveOrCreateDatabaseEncryptionKey(): string | null;
//# sourceMappingURL=encryption-key.d.ts.map