import { describe, expect, it } from "vitest";

import type { LaneSpec } from "../src/schema.ts";
import { estimateCost, MODEL_TABLE, validateLaneSpec } from "../src/table.ts";

const valid: LaneSpec = {
  lane: "lane-1",
  task: "Implement the requested slice",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
};

describe("validateLaneSpec", () => {
  it("accepts a valid explicit lane", () => {
    expect(validateLaneSpec(valid)).toBeNull();
  });

  it("requires an explicit model and effort", () => {
    expect(validateLaneSpec({ ...valid, model: undefined })).toContain("state the full selector");
    expect(validateLaneSpec({ ...valid, effort: undefined })).toContain("not a model selection");
  });

  it.each(["anthropic/claude-haiku", "openai/gpt-5.6-luna", "openai/gpt-5.6-terra"])(
    "rejects banned selector %s",
    (model) => {
      expect(validateLaneSpec({ ...valid, model })).toContain("banned");
    },
  );

  it("rejects effort above the ceiling", () => {
    expect(validateLaneSpec({ ...valid, effort: "ultra" as LaneSpec["effort"] })).toContain("ceiling");
  });

  it("enforces the Opus effort pin", () => {
    const model = "anthropic/claude-opus-4-8";
    expect(validateLaneSpec({ ...valid, model, effort: "high" })).toContain("pinned to effort xhigh");
    expect(validateLaneSpec({ ...valid, model, effort: "xhigh" })).toBeNull();
  });

  it("enforces the Grok effort pin", () => {
    const model = "xai/grok-4.5";
    expect(validateLaneSpec({ ...valid, model, effort: "medium" })).toContain("pinned to effort high");
    expect(validateLaneSpec({ ...valid, model, effort: "high" })).toBeNull();
  });

  it("lists the table for an unknown selector", () => {
    const error = validateLaneSpec({ ...valid, model: "unknown/model" });
    expect(error).toContain("not in the current table");
    for (const row of MODEL_TABLE) expect(error).toContain(row.selector);
  });
});

describe("estimateCost", () => {
  it("applies per-million input and output prices", () => {
    expect(estimateCost("openai-codex/gpt-5.6-sol", 1_000_000, 500_000)).toBe(8.75);
  });

  it("uses Grok routing prices", () => {
    expect(estimateCost("xai/grok-4.5", 1_000_000, 500_000)).toBe(5);
  });
});
