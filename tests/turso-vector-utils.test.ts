import { describe, expect, it } from "bun:test";
import {
  bm25Scores,
  distanceToSimilarity,
  escapeLikePattern,
  formatTagsForEmbedding,
  parseSessionIdFromMetadata,
  rankByScore,
  rrfScore,
  tokenizeQueryText,
} from "../src/services/turso/vector-utils.js";

describe("turso vector utils", () => {
  it("clamps cosine distance float artifacts into [0, 1] similarity", () => {
    expect(distanceToSimilarity(0)).toBe(1);
    expect(distanceToSimilarity(1)).toBe(0);
    expect(distanceToSimilarity(-1e-14)).toBe(1);
    expect(distanceToSimilarity(2)).toBe(0);
    expect(distanceToSimilarity(Number.NaN)).toBe(0);
  });

  it("formats tag embedding text consistently", () => {
    expect(formatTagsForEmbedding(["auth", "jwt"])).toBe("Topics: auth, jwt");
  });

  it("tokenizes query text and escapes LIKE wildcards", () => {
    expect(tokenizeQueryText("Hello, world_test")).toEqual(["hello", "world", "test"]);
    expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
    expect(parseSessionIdFromMetadata(JSON.stringify({ sessionID: "s1" }))).toBe("s1");
    expect(parseSessionIdFromMetadata("{bad")).toBeNull();
  });

  it("scores documents with BM25 and ranks only the matching ones", () => {
    const docs = [
      { id: "hub", text: "обработано письмо через gemini lite rest" },
      { id: "target", text: "добавление года в календарном плане сломало диалог" },
      { id: "other", text: "письмо обработано" },
    ];
    const scores = bm25Scores(docs, ["календарном", "плане"]);
    expect(scores.get("target")).toBeGreaterThan(0);
    expect(scores.has("hub")).toBe(false);
    expect(scores.has("other")).toBe(false);
    const ranks = rankByScore([...scores.entries()].map(([id, score]) => ({ id, score })));
    expect(ranks.get("target")).toBe(1);
  });

  it("fuses channels by rank, so one noisy channel cannot decide the winner", () => {
    // The hub leads the content channel and is absent from the lexical one;
    // the target trails the content channel and leads the lexical one. A rank
    // fusion must prefer the target - a weighted sum of scores would not.
    const content = new Map([
      ["hub", 1],
      ["target", 50],
    ]);
    const lexical = new Map([["target", 1]]);
    const fused = rrfScore([content, lexical], 10);
    expect(fused.get("target")!).toBeGreaterThan(fused.get("hub")!);
  });
});
