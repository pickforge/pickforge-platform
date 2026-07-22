import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  DATA_DIR_ENV,
  type KitEvent,
  type LaneProjection,
  type RunProjection,
} from "./schema.ts";

export type ReadRunResult = KitEvent[] & { readonly corruptLines: number };

export function journalDir(): string {
  const dataDir = process.env[DATA_DIR_ENV] ?? join(homedir(), ".pickforge", "pi-kit");
  const runsDir = join(dataDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

/** Directory holding raw per-lane JSONL transcripts for a run. */
export function rawRunDir(runId: string): string {
  const dataDir = process.env[DATA_DIR_ENV] ?? join(homedir(), ".pickforge", "pi-kit");
  return join(dataDir, "raw", runId);
}

/** All journaled run ids, newest first. */
export function listRuns(): string[] {
  return readdirSync(journalDir())
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .sort()
    .reverse();
}

export function appendEvent(ev: KitEvent): void {
  const event = {
    ...ev,
    v: ev.v ?? 1,
    t: ev.t ?? new Date().toISOString(),
  } as KitEvent;
  appendFileSync(join(journalDir(), `${event.run}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
}

export function readRun(runId: string): ReadRunResult {
  let contents: string;
  try {
    contents = readFileSync(join(journalDir(), `${runId}.jsonl`), "utf8");
  } catch {
    contents = "";
  }

  const events: KitEvent[] = [];
  let corruptLines = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as KitEvent);
    } catch {
      corruptLines += 1;
    }
  }
  Object.defineProperty(events, "corruptLines", { value: corruptLines, enumerable: false });
  return events as ReadRunResult;
}

export function reduceRun(events: KitEvent[]): RunProjection {
  const projection: RunProjection = {
    run: events[0]?.run ?? "",
    origin: "",
    createdAt: "",
    ended: false,
    lanes: new Map(),
    totalCost: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
  };

  for (const event of events) {
    projection.run ||= event.run;
    if (event.type === "run_created") {
      projection.origin = event.origin;
      projection.createdAt = event.t;
      continue;
    }
    if (event.type === "run_end") {
      projection.ended = true;
      projection.ok = event.ok;
      projection.durationMs = event.durationMs;
      continue;
    }
    if (event.type === "lane_created") {
      const lane = event.lane ?? event.spec.lane;
      projection.lanes.set(lane, {
        spec: event.spec,
        state: "queued",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      });
      continue;
    }

    if (!event.lane) continue;
    const lane = projection.lanes.get(event.lane);
    if (!lane) continue;

    switch (event.type) {
      case "lane_start":
        lane.state = "running";
        lane.pid = event.pid;
        lane.startedAtMs ??= Date.parse(event.t);
        break;
      case "lane_tool":
        lane.currentTool = event.tool;
        break;
      case "lane_status":
        lane.lastStatus = event.text;
        break;
      case "lane_usage":
        lane.tokensIn = event.input;
        lane.tokensOut = event.output;
        lane.cost = event.cost;
        lane.context = event.context;
        break;
      case "lane_end":
        lane.state = event.ok ? "done" : "failed";
        lane.answer = event.answer;
        lane.durationMs = event.durationMs;
        break;
      case "lane_abandoned":
        lane.state = "abandoned";
        lane.abandonReason = event.reason;
        if (lane.startedAtMs !== undefined) {
          lane.durationMs = Math.max(0, Date.parse(event.t) - lane.startedAtMs);
        }
        break;
    }
  }

  for (const lane of projection.lanes.values()) {
    projection.totalCost += lane.cost;
    projection.totalTokensIn += lane.tokensIn;
    projection.totalTokensOut += lane.tokensOut;
  }
  return projection;
}

export function newRunId(): string {
  const compactTimestamp = new Date().toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "");
  return `run-${compactTimestamp}-${randomBytes(2).toString("hex")}`;
}
