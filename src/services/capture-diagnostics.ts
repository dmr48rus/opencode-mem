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

import type { CaptureFailureReason } from "./capture-retry-policy.js";
import { log } from "./logger.js";

export type CaptureAttemptOutcome = "saved" | "skipped" | "failed";

/** Where the attempt came from; kept as a field so a future importer is countable. */
export type CaptureAttemptSource = "live-capture";

/**
 * The shape written for every attempt. Every key is always present so records
 * stay comparable across versions; a value the path could not observe is null.
 */
export interface CaptureAttemptRecord {
  source: CaptureAttemptSource;
  sessionId: string;
  /** 1-based, as counted in the retry loop. */
  attempt: number;
  outcome: CaptureAttemptOutcome;
  /** null unless the attempt failed. */
  reason: CaptureFailureReason | null;
  httpStatus: number | null;
  durationMs: number;
}

export function buildCaptureAttemptRecord(input: {
  source: CaptureAttemptSource;
  sessionId: string;
  attempt: number;
  outcome: CaptureAttemptOutcome;
  reason: CaptureFailureReason | null;
  httpStatus?: number;
  durationMs: number;
}): CaptureAttemptRecord {
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
export function emitCaptureAttempt(record: CaptureAttemptRecord): void {
  try {
    log("Capture attempt", record as unknown as Record<string, unknown>);
  } catch {
    // The log is best effort here, as everywhere else.
  }
}
