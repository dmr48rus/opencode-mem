/**
 * One metadata-only record per capture attempt.
 *
 * Ported from OMMS (github.com/cmdaltctr/omms v4.16.1,
 * src/services/capture-diagnostics.ts), reduced to the record itself. Their
 * module also writes the prompt and the reply to a per-day trace file with
 * secret redaction; that is a separate feature with its own privacy surface,
 * and it is not part of this port.
 *
 * The record never holds conversation text. It answers the question that costs
 * the most time when capture misbehaves: how many attempts ran, how they ended,
 * and why -- without opening the log and reading around.
 */
import { log } from "./logger.js";
export function buildCaptureAttemptRecord(input) {
    return {
        source: input.source,
        sessionId: input.sessionId,
        attempt: input.attempt,
        outcome: input.outcome,
        reason: input.outcome === "failed" ? (input.reason ?? "call-error") : null,
        httpStatus: input.httpStatus ?? null,
        durationMs: input.durationMs,
    };
}
/**
 * Write the record to the log. Never throws: diagnostics must not be able to
 * change a capture outcome.
 */
export function emitCaptureAttempt(record) {
    try {
        log("Capture attempt", record);
    }
    catch {
        // The log is best effort here, as everywhere else.
    }
}
