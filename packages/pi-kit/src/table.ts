/**
 * pi-kit model table — POLICY AS CODE. FROZEN CONTRACT.
 * Mirrors the managed pool in ~/.pi/agent/AGENTS.md. Costs are rough
 * routing estimates in USD per million tokens, not billing truth.
 */
import type { Effort, LaneSpec } from "./schema.ts";

export interface ModelRow {
  selector: string;
  name: string;
  prior: Effort;
  /** estimated $/Mtok input, output — routing heuristics only */
  inPerM: number;
  outPerM: number;
  vision: boolean;
}

export const MODEL_TABLE: ModelRow[] = [
  { selector: "openai-codex/gpt-5.6-sol", name: "GPT-5.6 Sol", prior: "medium", inPerM: 1.75, outPerM: 14, vision: true },
  { selector: "anthropic/claude-fable-5", name: "Fable 5", prior: "high", inPerM: 3, outPerM: 15, vision: true },
  { selector: "anthropic/claude-opus-4-8", name: "Opus 4.8", prior: "xhigh", inPerM: 10, outPerM: 40, vision: true },
  { selector: "anthropic/claude-sonnet-5", name: "Sonnet 5", prior: "medium", inPerM: 3, outPerM: 15, vision: true },
  { selector: "ollama/glm-5.2:cloud", name: "GLM-5.2", prior: "medium", inPerM: 0.6, outPerM: 2.2, vision: false },
];

export const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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

/** Validate a lane spec against policy. Returns null when valid, else a reason. */
export function validateLaneSpec(spec: Partial<LaneSpec>): string | null {
  if (!spec.task || !spec.task.trim()) return "task is required and must be self-contained";
  if (!spec.model) return "model is required: state the full selector from the model table";
  if (BANNED.some((re) => re.test(spec.model!))) {
    return `model ${spec.model} is banned (Haiku/Luna/Terra are never allowed)`;
  }
  if (!spec.effort) return "effort is required: a default lane is not a model selection";
  if (!EFFORTS.includes(spec.effort)) {
    return `effort "${spec.effort}" is invalid; xhigh is the absolute ceiling (ultra/max do not exist)`;
  }
  const pin = EFFORT_PINS.find((p) => p.match.test(spec.model!));
  if (pin && spec.effort !== pin.level) {
    return `model ${spec.model} is pinned to effort ${pin.level}`;
  }
  const row = findModel(spec.model!);
  if (!row) {
    return `model ${spec.model} is not in the current table; use one of: ${MODEL_TABLE.map((m) => m.selector).join(", ")}`;
  }
  return null;
}

/** Estimated USD for a usage delta on a model. */
export function estimateCost(selector: string, tokensIn: number, tokensOut: number): number {
  const row = findModel(selector);
  if (!row) return 0;
  return (tokensIn * row.inPerM + tokensOut * row.outPerM) / 1_000_000;
}
