/**
 * Which capture failures a retry can actually fix, and how long to wait.
 *
 * Ported from OMMS (github.com/cmdaltctr/omms v4.16.1,
 * src/core/capture-retry-policy.ts), trimmed to what this codebase can
 * observe. Their classifier is kept intact; two of its reason codes are not
 * produced here yet, because our provider neither hands the raw reply nor a
 * stop reason up the stack -- see classifyCaptureFailure for the consequence.
 */
import { RemoteStorageError } from "./turso/remote-storage.js";
/**
 * A retry can fix a model call that never got an answer, a timeout, a rate
 * limit, a server error, or a store that was briefly busy. Anything else would
 * send the same input to the same model for the same bad result, and each try
 * costs money and two seconds of backoff.
 *
 * A missing status is treated as retryable. That is the safe direction: an
 * unknown failure is retried exactly as before this policy existed, so the
 * classification can only remove attempts that provably cannot help.
 *
 * One deliberate deviation from OMMS: they classify every `persist-error` as
 * retryable, because their store is a local file that can only be busy. Ours is
 * the remote server, where a 401 or a 404 is a misconfiguration that answers
 * identically forever, so the status decides here too. This is the case the
 * policy exists for: a rotated token used to burn three attempts and two
 * minutes of backoff before reporting the same failure.
 *
 * `empty-text` and `truncated` are permanent by this rule and are not produced
 * yet -- our provider throws a plain Error and keeps the reply text. Producing
 * them needs the raw reply plumbed up first.
 */
export function classifyCaptureFailure(failure) {
    if (failure.reason !== "call-error" && failure.reason !== "persist-error") {
        return "permanent";
    }
    const status = failure.httpStatus;
    if (status === undefined)
        return "retryable";
    if (status === 408 || status === 429 || status >= 500)
        return "retryable";
    return "permanent";
}
const QUICK_RETRY_BASE_MS = 2000;
/** The wait inside a turn after quick try `attempt` fails: 2 s, then 4 s, doubling. */
export function quickRetryDelayMs(attempt) {
    return QUICK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
}
/** Read an HTTP `Retry-After` header: seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed) * 1000;
    const date = Date.parse(trimmed);
    if (Number.isNaN(date))
        return undefined;
    return Math.max(0, date - now);
}
function numberField(error, key) {
    let current = error;
    // Follow a short cause chain: providers wrap errors once or twice.
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
        const record = current;
        for (const candidate of key === "status" ? ["httpStatus", "status"] : [key]) {
            const value = record[candidate];
            if (typeof value === "number" && Number.isFinite(value))
                return value;
        }
        current = current.cause;
    }
    return undefined;
}
/**
 * The HTTP status a provider attached to a thrown error, if any. Reads
 * `httpStatus` and `status`, because RemoteStorageError carries the second and
 * the OpenAI-style SDKs the first.
 */
export function errorHttpStatus(error) {
    return numberField(error, "status");
}
/** The `Retry-After` wait a provider attached to a thrown error, if any. */
export function errorRetryAfterMs(error) {
    return numberField(error, "retryAfterMs");
}
/**
 * Turn a thrown error into the reason the log records and the status the
 * classifier needs.
 *
 * A storage failure is separated from a model failure because they have
 * opposite retry behaviour in practice: the model may come back, while a store
 * that answered 401 or 403 will answer exactly the same thing next time.
 */
export function describeCaptureFailure(error) {
    const httpStatus = errorHttpStatus(error);
    if (error instanceof RemoteStorageError) {
        return { reason: "persist-error", httpStatus };
    }
    if (error instanceof Error && error.name === "ZodError") {
        return { reason: "schema-mismatch", httpStatus };
    }
    return { reason: "call-error", httpStatus };
}
