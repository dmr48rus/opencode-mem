export type ClientScope = "read" | "write";
export type ClientKey = {
    id: string;
    label: string;
    clientId: string;
    scope: ClientScope;
    createdAt: string;
    lastUsedAt?: string;
};
/** Point the key file somewhere else (tests). Pass null to go back. */
export declare function setClientKeysFile(path: string | null): void;
export declare function listClientKeys(): ClientKey[];
/**
 * Issue a key. The plaintext is returned once and only its hash is stored.
 */
export declare function issueClientKey(options: {
    label: string;
    clientId: string;
    scope: ClientScope;
}): {
    key: string;
    record: ClientKey;
};
export declare function revokeClientKey(id: string): boolean;
/**
 * The scope a presented token carries, or null when it is not a client key.
 *
 * The master token is not resolved here: it is the administrator's, and the
 * caller checks it first.
 */
export declare function resolveClientScope(token: string): ClientScope | null;
//# sourceMappingURL=client-keys.d.ts.map