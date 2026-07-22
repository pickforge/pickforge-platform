import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEvent,
  journalDir,
  listRuns,
  readRun,
  reduceRun,
} from "../src/journal-core.ts";
import type { KitEvent } from "../src/schema.ts";

function event<Type extends KitEvent["type"]>(
  run: string,
  lane: string,
  value: Type,
): Extract<KitEvent, { type: Type }> {
  const base = { v: 1 as const, t: "2026-07-16T12:00:00.000Z", run, lane };
  let result: KitEvent;
  switch (value) {
    case "lane_created": result = {
      ...base,
      type: value,
      spec: {
        lane,
        task: `work in ${lane}`,
        model: "openai-codex/gpt-5.6-sol",
        effort: "medium",
      },
    }; break;
    case "lane_start": result = { ...base, type: value, pid: 42 }; break;
    case "lane_tool": result = { ...base, type: value, tool: "read", summary: "src/index.ts" }; break;
    case "lane_usage": result = { ...base, type: value, input: 10, output: 5, cost: 0.1, context: 15 }; break;
    case "lane_end": result = { ...base, type: value, ok: true, answer: "done", durationMs: 20 }; break;
    case "lane_abandoned": result = { ...base, type: value, reason: "cancelled" }; break;
    default: throw new Error(`unsupported event ${value}`);
  }
  return result as Extract<KitEvent, { type: Type }>;
}

describe("journal core", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pi-kit-journal-"));
    process.env.PIKIT_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.PIKIT_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("appends and reads a realistic event sequence", () => {
    const run = "run-sequence";
    const events: KitEvent[] = [
      { v: 1, t: "2026-07-16T12:00:00.000Z", run, type: "run_created", lanes: 1, origin: "test" },
      event(run, "lane-1", "lane_created"),
      event(run, "lane-1", "lane_start"),
      event(run, "lane-1", "lane_tool"),
      event(run, "lane-1", "lane_usage"),
      { ...event(run, "lane-1", "lane_usage"), input: 25, output: 9, cost: 0.25, context: 34 },
      event(run, "lane-1", "lane_end"),
    ];

    for (const item of events) appendEvent(item);

    expect(readRun(run)).toEqual(events);
  });

  it("lists only journal runs in newest-first order", () => {
    appendEvent({
      v: 1,
      t: "2026-07-16T12:00:00.000Z",
      run: "run-20260716",
      type: "run_created",
      lanes: 0,
      origin: "test",
    });
    appendEvent({
      v: 1,
      t: "2026-07-17T12:00:00.000Z",
      run: "run-20260717",
      type: "run_created",
      lanes: 0,
      origin: "test",
    });
    appendFileSync(join(journalDir(), "notes.txt"), "not a run", "utf8");

    expect(listRuns()).toEqual(["run-20260717", "run-20260716"]);
  });

  it("uses cumulative lane usage and reduces terminal states and totals", () => {
    const run = "run-projection";
    const events: KitEvent[] = [
      { v: 1, t: "2026-07-16T12:00:00.000Z", run, type: "run_created", lanes: 3, origin: "test" },
      event(run, "done", "lane_created"),
      event(run, "done", "lane_start"),
      event(run, "done", "lane_usage"),
      { ...event(run, "done", "lane_usage"), input: 30, output: 12, cost: 0.3, context: 42 },
      event(run, "done", "lane_end"),
      event(run, "failed", "lane_created"),
      { ...event(run, "failed", "lane_usage"), input: 7, output: 2, cost: 0.07, context: 9 },
      { ...event(run, "failed", "lane_end"), ok: false },
      event(run, "abandoned", "lane_created"),
      { ...event(run, "abandoned", "lane_usage"), input: 3, output: 1, cost: 0.03, context: 4 },
      event(run, "abandoned", "lane_abandoned"),
      { v: 1, t: "2026-07-16T12:01:00.000Z", run, type: "run_end", ok: false, durationMs: 60_000 },
    ];

    const projection = reduceRun(events);

    expect(projection.lanes.get("done")).toMatchObject({ state: "done", tokensIn: 30, tokensOut: 12, cost: 0.3 });
    expect(projection.lanes.get("failed")?.state).toBe("failed");
    expect(projection.lanes.get("abandoned")?.state).toBe("abandoned");
    expect(projection).toMatchObject({
      ended: true,
      ok: false,
      totalTokensIn: 40,
      totalTokensOut: 15,
      totalCost: 0.4,
    });
    expect(reduceRun(events)).toEqual(projection);
  });

  it("skips and counts corrupt lines", () => {
    const run = "run-corrupt";
    const valid: KitEvent = {
      v: 1,
      t: "2026-07-16T12:00:00.000Z",
      run,
      type: "run_created",
      lanes: 0,
      origin: "test",
    };
    appendEvent(valid);
    appendFileSync(join(journalDir(), `${run}.jsonl`), "not-json\n", "utf8");

    const read = readRun(run);
    expect(read).toEqual([valid]);
    expect(read.corruptLines).toBe(1);
  });
});
