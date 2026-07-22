/**
 * pi-kit event schema v1 — FROZEN CONTRACT.
 * All extensions and the runner build against these types.
 * The journal is append-only JSONL; one event per line; replay must be deterministic.
 */

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type LaneMode = "read-only" | "workspace-write";
export type LaneOrigin = "pi" | "mcp";
export type ExecutionRoute = "pi" | "claude-code";

export type LaneState = "queued" | "running" | "done" | "failed" | "abandoned";

/** A single dispatched subagent lane. Model and effort MUST be explicit. */
export interface LaneSpec {
  /** short unique id within the run, e.g. "lane-1" or a caller-chosen name */
  lane: string;
  /** self-contained task prompt */
  task: string;
  /** full selector "provider/model-id", e.g. "openai-codex/gpt-5.6-sol" */
  model: string;
  effort: Effort;
  /** tool and workspace access policy; Pi-origin calls default to workspace-write */
  mode?: LaneMode;
  /** working directory; defaults to the parent session cwd */
  cwd?: string;
  /** why this model/effort was chosen (journaled for audit) */
  rationale?: string;
}

export type KitEvent = { v: 1; t: string; run: string; lane?: string } & (
  | { type: "run_created"; lanes: number; origin: string }
  | { type: "lane_created"; spec: LaneSpec }
  | { type: "lane_start"; pid: number }
  | { type: "lane_tool"; tool: string; summary: string }
  | { type: "lane_status"; text: string }
  | {
      type: "lane_usage";
      input: number;
      output: number;
      cacheRead?: number;
      /** cumulative estimated USD for this lane */
      cost: number;
      /** cumulative context tokens (last known) */
      context: number;
    }
  | { type: "lane_end"; ok: boolean; stopReason?: string; answer: string; durationMs: number }
  | { type: "lane_abandoned"; reason: string }
  | { type: "run_end"; ok: boolean; durationMs: number }
);

/** Reduced projection of a run, rebuilt purely from journal events. */
export interface LaneProjection {
  spec: LaneSpec;
  state: LaneState;
  pid?: number;
  currentTool?: string;
  lastStatus?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: number;
  answer?: string;
  durationMs?: number;
  abandonReason?: string;
}

export interface RunProjection {
  run: string;
  origin: string;
  createdAt: string;
  ended: boolean;
  ok?: boolean;
  lanes: Map<string, LaneProjection>;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export const DATA_DIR_ENV = "PIKIT_DATA_DIR";
export const DEFAULT_DATA_DIR = "~/.pickforge/pi-kit";
