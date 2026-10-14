/**
 * Which capture failures a retry can actually fix, and how long to wait.
 *
 * Ported from OMMS (github.com/cmdaltctr/omms v4.16.1,
 * src/core/capture-retry-policy.ts), trimmed to what this codebase can
 * observe. Their classifier is kept intact; two of its reason codes are not
 * produced here yet, because our provider neither hands the raw reply nor a
 * stop reason up the stack -- see classifyCaptureFailure for the consequence.
 */
/**
 * Why an attempt failed. These names are counted by grep over the log, so they
 * are part of the interface: renaming one breaks someone's histogram.
 */
export type CaptureFailureReason = "call-error" | "empty-text" | "truncated" | "invalid-json" | "schema-mismatch" | "persist-error";
/** What the capture pipeline knows about a failed attempt. */
export interface CaptureFailureInfo {
    reason: CaptureFailureReason;
    httpStatus?: number;
    retryAfterMs?: number;
}
export type CaptureRetryClass = "retryable" | "permanent";
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
export declare function classifyCaptureFailure(failure: CaptureFailureInfo): CaptureRetryClass;
/** The wait inside a turn after quick try `attempt` fails: 2 s, then 4 s, doubling. */
export declare function quickRetryDelayMs(attempt: number): number;
/** Read an HTTP `Retry-After` header: seconds or an HTTP date. */
export declare function parseRetryAfter(value: string | null | undefined, now?: number): number | undefined;
/**
 * The HTTP status a provider attached to a thrown error, if any. Reads
 * `httpStatus` and `status`, because RemoteStorageError carries the second and
 * the OpenAI-style SDKs the first.
 */
export declare function errorHttpStatus(error: unknown): number | undefined;
/** The `Retry-After` wait a provider attached to a thrown error, if any. */
export declare function errorRetryAfterMs(error: unknown): number | undefined;
/**
 * Turn a thrown error into the reason the log records and the status the
 * classifier needs.
 *
 * A storage failure is separated from a model failure because they have
 * opposite retry behaviour in practice: the model may come back, while a store
 * that answered 401 or 403 will answer exactly the same thing next time.
 */
export declare function describeCaptureFailure(error: unknown): CaptureFailureInfo;
//# sourceMappingURL=capture-retry-policy.d.ts.map