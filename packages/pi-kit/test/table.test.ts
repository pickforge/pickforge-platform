import { describe, expect, it } from "vitest";

import type { LaneSpec } from "../src/schema.ts";
import {
  estimateCost,
  findModel,
  MODEL_TABLE,
  normalizeLaneSpec,
  validateLaneSpec,
} from "../src/table.ts";

const valid: LaneSpec = {
  lane: "lane-1",
  task: "Implement the requested slice",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
};

const validAnthropic: LaneSpec = {
  ...valid,
  model: "anthropic/claude-fable-5",
  effort: "high",
};

describe("validateLaneSpec", () => {
  it("accepts a valid explicit lane", () => {
    expect(validateLaneSpec(valid)).toBeNull();
    expect(validateLaneSpec({ ...valid, lane: `a${"x".repeat(63)}` })).toBeNull();
    expect(validateLaneSpec({ ...valid, mode: "workspace-write" }, { origin: "mcp" })).toBeNull();
  });

  it.each(["../escape", "nested/lane", "nested\\lane", ".hidden", `a${"x".repeat(64)}`])(
    "rejects unsafe or oversized lane id %s",
    (lane) => {
      expect(validateLaneSpec({ ...valid, lane })).toContain("lane id");
    },
  );

  it("rejects routes unavailable to the calling origin", () => {
    expect(validateLaneSpec(validAnthropic, { origin: "mcp" })).toContain("native Claude workflow");
    expect(validateLaneSpec(validAnthropic, { origin: "pi" })).toBeNull();
  });

  it("requires MCP callers to choose a mode", () => {
    expect(validateLaneSpec({ ...valid, mode: undefined }, { origin: "mcp" })).toContain("mode is required");
    expect(validateLaneSpec({ ...valid, mode: "read-only" }, { origin: "mcp" })).toBeNull();
  });

  it("rejects invalid modes", () => {
    expect(validateLaneSpec({ ...valid, mode: "unsafe" as LaneSpec["mode"] })).toContain("mode");
  });

  it("defaults existing Pi calls to workspace-write", () => {
    expect(normalizeLaneSpec(valid, { origin: "pi" }).mode).toBe("workspace-write");
    expect(normalizeLaneSpec({ ...valid, mode: "read-only" }, { origin: "pi" }).mode).toBe("read-only");
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

  it.each(["ultra", "max"])("rejects prohibited effort %s", (effort) => {
    expect(validateLaneSpec({ ...valid, effort: effort as LaneSpec["effort"] })).toContain("ceiling");
  });

  it("enforces route-specific efforts and hard pins", () => {
    expect(validateLaneSpec({ ...validAnthropic, effort: "minimal" }, { origin: "pi" })).toContain(
      "unsupported effort",
    );

    const opus = "anthropic/claude-opus-4-8";
    expect(validateLaneSpec({ ...valid, model: opus, effort: "high" })).toContain("pinned to effort xhigh");
    expect(validateLaneSpec({ ...valid, model: opus, effort: "xhigh" })).toBeNull();

    const grok = "xai/grok-4.5";
    expect(validateLaneSpec({ ...valid, model: grok, effort: "medium" })).toContain("pinned to effort high");
    expect(validateLaneSpec({ ...valid, model: grok, effort: "high" })).toBeNull();
  });

  it("lists the table for an unknown selector", () => {
    const error = validateLaneSpec({ ...valid, model: "unknown/model" });
    expect(error).toContain("not in the current table");
    for (const row of MODEL_TABLE) expect(error).toContain(row.selector);
  });
});

describe("model execution metadata", () => {
  it("routes Fable through Claude Code for Pi callers", () => {
    expect(findModel("anthropic/claude-fable-5")).toMatchObject({
      route: "claude-code",
      runtimeModel: "fable",
      allowedEfforts: ["low", "medium", "high"],
      origins: ["pi"],
    });
  });

  it("routes pinned Grok through Pi for both origins", () => {
    expect(findModel("xai/grok-4.5")).toMatchObject({
      route: "pi",
      runtimeModel: "grok-4.5",
      allowedEfforts: ["high"],
      origins: ["pi", "mcp"],
    });
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
