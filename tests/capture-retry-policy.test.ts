import { describe, expect, it } from "bun:test";
import {
  classifyCaptureFailure,
  describeCaptureFailure,
  errorHttpStatus,
  parseRetryAfter,
  quickRetryDelayMs,
  type CaptureFailureInfo,
} from "../src/services/capture-retry-policy.js";
import {
  buildCaptureAttemptRecord,
  type CaptureAttemptRecord,
} from "../src/services/capture-diagnostics.js";
import { RemoteStorageError } from "../src/services/turso/remote-storage.js";

describe("classifyCaptureFailure", () => {
  const retryable: CaptureFailureInfo[] = [
    { reason: "persist-error" },
    { reason: "persist-error", httpStatus: 503 },
    { reason: "persist-error", httpStatus: 429 },
    { reason: "call-error" },
    { reason: "call-error", httpStatus: 408 },
    { reason: "call-error", httpStatus: 429 },
    { reason: "call-error", httpStatus: 500 },
    { reason: "call-error", httpStatus: 502 },
  ];
  for (const failure of retryable) {
    it(`retries ${failure.reason}${failure.httpStatus ? ` ${failure.httpStatus}` : ""}`, () => {
      expect(classifyCaptureFailure(failure)).toBe("retryable");
    });
  }

  const permanent: CaptureFailureInfo[] = [
    { reason: "call-error", httpStatus: 401 },
    { reason: "call-error", httpStatus: 403 },
    { reason: "call-error", httpStatus: 400 },
    { reason: "call-error", httpStatus: 404 },
    { reason: "persist-error", httpStatus: 401 },
    { reason: "persist-error", httpStatus: 403 },
    { reason: "persist-error", httpStatus: 400 },
    { reason: "persist-error", httpStatus: 404 },
    { reason: "schema-mismatch" },
    { reason: "invalid-json" },
    { reason: "empty-text" },
    { reason: "truncated" },
  ];
  for (const failure of permanent) {
    it(`refuses to retry ${failure.reason}${failure.httpStatus ? ` ${failure.httpStatus}` : ""}`, () => {
      expect(classifyCaptureFailure(failure)).toBe("permanent");
    });
  }
});

describe("quickRetryDelayMs", () => {
  it("doubles from two seconds", () => {
    expect([1, 2, 3, 4].map(quickRetryDelayMs)).toEqual([2000, 4000, 8000, 16000]);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("reads an HTTP date", () => {
    const now = Date.parse("2026-10-14T10:00:00Z");
    expect(parseRetryAfter("Wed, 14 Oct 2026 10:01:00 GMT", now)).toBe(60_000);
  });

  it("refuses a date already in the past rather than going negative", () => {
    const now = Date.parse("2026-10-14T10:05:00Z");
    expect(parseRetryAfter("Wed, 14 Oct 2026 10:01:00 GMT", now)).toBe(0);
  });

  it("returns nothing for junk", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("describeCaptureFailure", () => {
  it("reads a store failure as persist-error and keeps its status", () => {
    const failure = describeCaptureFailure(new RemoteStorageError("boom", 503, "/api/memories"));
    expect(failure.reason).toBe("persist-error");
    expect(failure.httpStatus).toBe(503);
  });

  it("reads a 401 from the store as permanent through the classifier", () => {
    const failure = describeCaptureFailure(new RemoteStorageError("nope", 401, "/api/search"));
    expect(failure.httpStatus).toBe(401);
    expect(classifyCaptureFailure(failure)).toBe("permanent");
  });

  it("reads a schema rejection as schema-mismatch", () => {
    const zod = Object.assign(new Error("invalid_type"), { name: "ZodError" });
    expect(describeCaptureFailure(zod).reason).toBe("schema-mismatch");
  });

  it("treats an unlabelled failure as a call error and keeps it retryable", () => {
    const failure = describeCaptureFailure(new Error("socket hang up"));
    expect(failure.reason).toBe("call-error");
    expect(failure.httpStatus).toBeUndefined();
    expect(classifyCaptureFailure(failure)).toBe("retryable");
  });

  it("follows the cause chain for a wrapped error", () => {
    const inner = Object.assign(new Error("wrapped"), { httpStatus: 429 });
    const outer = new Error("Summary generation failed", { cause: inner });
    expect(errorHttpStatus(outer)).toBe(429);
  });
});

describe("buildCaptureAttemptRecord", () => {
  const base = {
    source: "live-capture" as const,
    sessionId: "ses_1",
    attempt: 1,
    durationMs: 42,
  };

  it("carries every key so records stay comparable", () => {
    const record: CaptureAttemptRecord = buildCaptureAttemptRecord({
      ...base,
      outcome: "saved",
      reason: null,
    });
    expect(Object.keys(record).sort()).toEqual([
      "attempt",
      "durationMs",
      "httpStatus",
      "outcome",
      "reason",
      "sessionId",
      "source",
    ]);
    expect(record.httpStatus).toBeNull();
  });

  it("defaults a failed attempt with no stated reason to call-error", () => {
    const record = buildCaptureAttemptRecord({ ...base, outcome: "failed", reason: null });
    expect(record.reason).toBe("call-error");
  });

  it("never states a reason for an attempt that did not fail", () => {
    // A skipped attempt is not a failure; keeping a reason here would make a
    // histogram count skips as errors.
    const record = buildCaptureAttemptRecord({
      ...base,
      outcome: "skipped",
      reason: "schema-mismatch",
    });
    expect(record.reason).toBeNull();
  });

  it("keeps the status of a failed attempt", () => {
    const record = buildCaptureAttemptRecord({
      ...base,
      attempt: 3,
      outcome: "failed",
      reason: "persist-error",
      httpStatus: 500,
    });
    expect(record.attempt).toBe(3);
    expect(record.httpStatus).toBe(500);
  });
});
