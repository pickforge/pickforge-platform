import { describe, expect, it } from "vitest";
import { delegationRatio, emptyCounts, recordTool, summarize } from "../src/delegation-core.ts";

describe("delegation accounting", () => {
  it("starts at zero and reports 0% without activity", () => {
    const counts = emptyCounts();
    expect(delegationRatio(counts)).toBe(0);
    expect(summarize(counts)).toBe("delegation 0% · 0 lanes / 0 direct");
  });

  it("counts direct tool calls", () => {
    let counts = emptyCounts();
    counts = recordTool(counts, "bash", 1);
    counts = recordTool(counts, "read", 1);
    expect(counts).toEqual({ direct: 2, dispatches: 0, lanes: 0 });
    expect(delegationRatio(counts)).toBe(0);
  });

  it("counts lanes per dispatch, not dispatches", () => {
    let counts = emptyCounts();
    counts = recordTool(counts, "lanes_spawn", 3);
    counts = recordTool(counts, "lanes_spawn", 1);
    expect(counts).toEqual({ direct: 0, dispatches: 2, lanes: 4 });
    expect(delegationRatio(counts)).toBe(1);
  });

  it("treats a malformed lane count as one lane", () => {
    const counts = recordTool(emptyCounts(), "lanes_spawn", 0);
    expect(counts.lanes).toBe(1);
  });

  it("computes a mixed ratio and summary", () => {
    let counts = emptyCounts();
    for (let i = 0; i < 6; i++) counts = recordTool(counts, "bash", 1);
    counts = recordTool(counts, "lanes_spawn", 2);
    expect(delegationRatio(counts)).toBe(0.25);
    expect(summarize(counts)).toBe("delegation 25% · 2 lanes / 6 direct");
  });

  it("pluralizes a single lane correctly", () => {
    const counts = recordTool(emptyCounts(), "lanes_spawn", 1);
    expect(summarize(counts)).toBe("delegation 100% · 1 lane / 0 direct");
  });
});
