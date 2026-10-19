import { describe, expect, it } from "bun:test";
import { fuseGlobalRanks } from "../src/services/turso/vector-search.js";

describe("global rank fusion", () => {
  it("ranks the global winner above the hub of its own shard", () => {
    // Three records as if the shards were merged. "hub" leads by content
    // similarity inside its shard, but globally it is mediocre; "target" is
    // third by content and first by tags and by the lexical channel. Fusing
    // inside a shard would keep the hub on top; fusing over global ranks must
    // not.
    const results = [
      { id: "hub", memory: "", similarity: 0, contentSim: 0.9, tagsSim: 0.4 },
      { id: "target", memory: "", similarity: 0, contentSim: 0.8, tagsSim: 0.95 },
      { id: "other", memory: "", similarity: 0, contentSim: 0.85, tagsSim: 0.1 },
    ];
    const lexical = new Map([["target", 1]]);
    fuseGlobalRanks(results as never[], lexical, 10);
    expect(results[1].similarity).toBeGreaterThan(results[0].similarity);
    expect(results[1].similarity).toBeGreaterThan(results[2].similarity);
  });

  it("gives a record nothing when no channel saw it", () => {
    const results = [{ id: "x", memory: "", similarity: 0.5 }];
    fuseGlobalRanks(results as never[], new Map(), 10);
    expect(results[0].similarity).toBe(0);
  });
});
