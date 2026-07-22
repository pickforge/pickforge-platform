/**
 * pi-kit model table — POLICY AS CODE. FROZEN CONTRACT.
 * Mirrors the managed pool in ~/.pi/agent/AGENTS.md. Costs are rough
 * routing estimates in USD per million tokens, not billing truth.
 */
import type {
  Effort,
  ExecutionRoute,
  LaneMode,
  LaneOrigin,
  LaneSpec,
} from "./schema.ts";

export interface ModelRow {
  selector: string;
  name: string;
  prior: Effort;
  route: ExecutionRoute;
  runtimeModel: string;
  allowedEfforts: Effort[];
  origins: LaneOrigin[];
  /** estimated $/Mtok input, output — routing heuristics only */
  inPerM: number;
  outPerM: number;
  vision: boolean;
}

const ALL_EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ALL_ORIGINS: LaneOrigin[] = ["pi", "mcp"];

export const MODEL_TABLE: ModelRow[] = [
  { selector: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol", prior: "medium", route: "pi", runtimeModel: "gpt-5.6-sol", allowedEfforts: [...ALL_EFFORTS], origins: [...ALL_ORIGINS], inPerM: 1.75, outPerM: 14, vision: true },
  { selector: "anthropic/claude-fable-5", name: "Fable 5", prior: "high", route: "claude-code", runtimeModel: "fable", allowedEfforts: ["low", "medium", "high"], origins: ["pi"], inPerM: 3, outPerM: 15, vision: true },
  { selector: "anthropic/claude-opus-4-8", name: "Opus 4.8", prior: "xhigh", route: "claude-code", runtimeModel: "opus", allowedEfforts: ["xhigh"], origins: ["pi"], inPerM: 10, outPerM: 40, vision: true },
  { selector: "anthropic/claude-sonnet-5", name: "Sonnet 5", prior: "medium", route: "claude-code", runtimeModel: "sonnet", allowedEfforts: ["low", "medium", "high", "xhigh"], origins: ["pi"], inPerM: 3, outPerM: 15, vision: true },
  { selector: "xai/grok-4.5", name: "Grok 4.5", prior: "high", route: "pi", runtimeModel: "grok-4.5", allowedEfforts: ["high"], origins: [...ALL_ORIGINS], inPerM: 0, outPerM: 0, vision: true },
  { selector: "ollama/glm-5.2:cloud", name: "GLM-5.2", prior: "medium", route: "pi", runtimeModel: "glm-5.2:cloud", allowedEfforts: [...ALL_EFFORTS], origins: [...ALL_ORIGINS], inPerM: 0.6, outPerM: 2.2, vision: false },
];

export const EFFORTS: Effort[] = [...ALL_EFFORTS];
export const LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Models that must never run, on any route. */
export const BANNED = [/haiku/i, /luna/i, /gpt-5\.6-terra/i];

/** Per-model pinned efforts (exact value required). */
export const EFFORT_PINS: Array<{ match: RegExp; level: Effort }> = [
  { match: /opus/i, level: "xhigh" },
  { match: /grok/i, level: "high" },
];

export function findModel(selector: string): ModelRow | undefined {
  return MODEL_TABLE.find((m) => m.selector === selector);
}

export interface LanePolicyContext {
  origin: LaneOrigin;
}

export type NormalizedLaneSpec = LaneSpec & { mode: LaneMode };

/** Apply origin-specific compatibility defaults after validation. */
export function normalizeLaneSpec(
  spec: LaneSpec,
  { origin }: LanePolicyContext = { origin: "pi" },
): NormalizedLaneSpec {
  const mode = spec.mode ?? (origin === "pi" ? "workspace-write" : undefined);
  if (!mode) throw new Error("mode is required for MCP-origin lanes");
  return { ...spec, mode };
}

/** Validate a lane spec against policy. Returns null when valid, else a reason. */
export function validateLaneSpec(
  spec: Partial<LaneSpec>,
  { origin }: LanePolicyContext = { origin: "pi" },
): string | null {
  if (!spec.lane || !LANE_ID_PATTERN.test(spec.lane)) {
    return "lane id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
  }
  if (!spec.task || !spec.task.trim()) return "task is required and must be self-contained";
  if (!spec.model) return "model is required: state the full selector from the model table";
  const model = spec.model;
  if (BANNED.some((re) => re.test(model))) {
    return `model ${model} is banned (Haiku/Luna/Terra are never allowed)`;
  }
  if (!spec.effort) return "effort is required: a default lane is not a model selection";
  const effort = spec.effort;
  if (!EFFORTS.includes(effort)) {
    return `effort "${effort}" is invalid; xhigh is the absolute ceiling (ultra/max do not exist)`;
  }
  const row = findModel(model);
  if (!row) {
    return `model ${model} is not in the current table; use one of: ${MODEL_TABLE.map((m) => m.selector).join(", ")}`;
  }
  if (!row.origins.includes(origin)) {
    return `model ${model} is unavailable from ${origin}; use the native Claude workflow for Claude-to-Claude delegation`;
  }
  if (spec.mode !== undefined && spec.mode !== "read-only" && spec.mode !== "workspace-write") {
    return `mode "${spec.mode}" is invalid; use read-only or workspace-write`;
  }
  if (origin === "mcp" && !spec.mode) return "mode is required for MCP-origin lanes";
  const pin = EFFORT_PINS.find((p) => p.match.test(model));
  if (pin && effort !== pin.level) {
    return `model ${model} is pinned to effort ${pin.level}`;
  }
  if (!row.allowedEfforts.includes(effort)) {
    return `model ${model} has unsupported effort ${effort}; use one of: ${row.allowedEfforts.join(", ")}`;
  }
  return null;
}

/** Estimated USD for a usage delta on a model. */
export function estimateCost(selector: string, tokensIn: number, tokensOut: number): number {
  const row = findModel(selector);
  if (!row) return 0;
  return (tokensIn * row.inPerM + tokensOut * row.outPerM) / 1_000_000;
}
