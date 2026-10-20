/**
 * Per-client keys, beside the master token.
 *
 * One shared token for every machine means two things nobody can fix from the
 * outside: nobody can be revoked without revoking everybody, and the client id
 * in a record is a claim the writer makes about itself rather than something
 * the store verified. A key is issued per machine, stored as a hash, and
 * carries a scope. The master token stays valid and stays an administrator:
 * the keys are added beside it, not instead of it.
 *
 * The plaintext of a key is returned once, at issue time, and never stored.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
const DATA_DIR = join(homedir(), ".opencode-mem");
const KEYS_FILE = join(DATA_DIR, "client-keys.json");
let cache = null;
let keysFileOverride = null;
/** Point the key file somewhere else (tests). Pass null to go back. */
export function setClientKeysFile(path) {
    keysFileOverride = path;
    cache = null;
}
function keysFilePath() {
    return keysFileOverride ?? KEYS_FILE;
}
function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
function readKeys() {
    try {
        if (!existsSync(keysFilePath()))
            return [];
        const mtimeMs = statSync(keysFilePath()).mtimeMs;
        if (cache && cache.mtimeMs === mtimeMs)
            return cache.file;
        const parsed = JSON.parse(readFileSync(keysFilePath(), "utf-8"));
        const file = Array.isArray(parsed?.keys) ? parsed.keys : [];
        cache = { file, mtimeMs };
        return file;
    }
    catch {
        return [];
    }
}
function writeKeys(keys) {
    mkdirSync(join(keysFilePath(), ".."), { recursive: true });
    writeFileSync(keysFilePath(), JSON.stringify({ keys }, null, 2), { mode: 0o600 });
    if (platform() !== "win32") {
        try {
            chmodSync(keysFilePath(), 0o600);
        }
        catch {
            // best-effort; the file was created with mode 0o600 above
        }
    }
    cache = null;
}
export function listClientKeys() {
    return readKeys().map(({ hash: _hash, ...rest }) => rest);
}
/**
 * Issue a key. The plaintext is returned once and only its hash is stored.
 */
export function issueClientKey(options) {
    const token = `ck_${randomBytes(24).toString("hex")}`;
    const record = {
        id: `ck_${randomBytes(6).toString("hex")}`,
        label: options.label,
        clientId: options.clientId,
        scope: options.scope,
        createdAt: new Date().toISOString(),
        hash: hashToken(token),
    };
    const keys = readKeys().filter((key) => key.id !== record.id);
    keys.push(record);
    writeKeys(keys);
    const { hash: _hash, ...publicRecord } = record;
    return { key: token, record: publicRecord };
}
export function revokeClientKey(id) {
    const keys = readKeys();
    const remaining = keys.filter((key) => key.id !== id);
    if (remaining.length === keys.length)
        return false;
    writeKeys(remaining);
    return true;
}
/**
 * The scope a presented token carries, or null when it is not a client key.
 *
 * The master token is not resolved here: it is the administrator's, and the
 * caller checks it first.
 */
export function resolveClientScope(token) {
    const hash = hashToken(token);
    const keys = readKeys();
    for (const key of keys) {
        if (!safeEqual(key.hash, hash))
            continue;
        key.lastUsedAt = new Date().toISOString();
        writeKeys(keys);
        return key.scope;
    }
    return null;
}
