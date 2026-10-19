import { describe, expect, it } from "bun:test";
import { classifyTier } from "../src/services/memory-aging.js";

describe("memory aging tiers", () => {
  it("keeps facts and decisions forever", () => {
    expect(classifyTier("fact")).toBe("semantic");
    expect(classifyTier("decision")).toBe("semantic");
    expect(classifyTier("summary")).toBe("semantic");
    expect(classifyTier("preference")).toBe("semantic");
  });

  it("keeps procedures longer than episodes", () => {
    expect(classifyTier("technical")).toBe("procedural");
    expect(classifyTier("bug-fix")).toBe("procedural");
    expect(classifyTier("documentation")).toBe("procedural");
    expect(classifyTier("capture")).toBe("episodic");
    expect(classifyTier("memory")).toBe("episodic");
  });

  it("treats an unknown type as episodic", () => {
    expect(classifyTier("что-то незнакомое")).toBe("episodic");
    expect(classifyTier(undefined)).toBe("episodic");
    expect(classifyTier("")).toBe("episodic");
  });
});
