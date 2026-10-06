import { describe, expect, it } from "bun:test";
import { toLegacyEvent } from "../src/v2/legacy-client.js";
import { extractJsonPayload } from "../src/services/ai/opencode-provider.js";

describe("our fixes on top of upstream", () => {
  it("aliases failed and interrupted execution events to session.idle", () => {
    const t = (raw: string) => toLegacyEvent({ type: raw, data: { sessionID: "ses-1" } });

    // The two the upstream nested ternary never covered: without these the
    // session.idle branch never arms, so auto-capture and profile learning
    // silently skip sessions that ended in a failure or an interruption.
    expect(t("session.execution.failed")).toEqual({
      type: "session.idle",
      properties: { sessionID: "ses-1" },
    });
    expect(t("session.execution.interrupted")).toEqual({
      type: "session.idle",
      properties: { sessionID: "ses-1" },
    });

    // Already handled upstream; kept so a regression is visible.
    expect(t("session.execution.succeeded").type).toBe("session.idle");
    expect(t("session.compaction.ended").type).toBe("session.compacted");
    expect(t("message.updated").type).toBe("message.updated");
    expect(t("session.execution.succeeded.1").type).toBe("session.idle");
  });

  it("recovers JSON the free tier returns fenced or wrapped in prose", () => {
    expect(extractJsonPayload('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonPayload('```json\n{"tags":["git"]}\n```')).toEqual({ tags: ["git"] });
    expect(extractJsonPayload('Here you go:\n{"summary":"done"}\nHope that helps.')).toEqual({
      summary: "done",
    });
    // Braces inside strings must not end the scan early.
    expect(extractJsonPayload('prose {"text":"a } brace","n":2} tail')).toEqual({
      text: "a } brace",
      n: 2,
    });
    expect(extractJsonPayload("no json at all")).toBeUndefined();
    expect(extractJsonPayload("")).toBeUndefined();
  });
});
