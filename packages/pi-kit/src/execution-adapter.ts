import type { ExecutionRoute, LaneSpec } from "./schema.ts";

export type NormalizedLaneEvent =
  | { v: 1; type: "task"; text: string }
  | { v: 1; type: "text_delta"; delta: string }
  | { v: 1; type: "thinking_delta"; delta: string }
  | { v: 1; type: "tool_start"; tool: string; input: unknown }
  | { v: 1; type: "tool_end"; tool: string; text: string; isError: boolean }
  | { v: 1; type: "usage"; input: number; output: number; cacheRead: number; context: number }
  | { v: 1; type: "assistant_end"; text: string; isError?: boolean };

export interface LaneProcessPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LaneEventParser {
  feedLine(line: string): NormalizedLaneEvent[];
  end(): NormalizedLaneEvent[];
}

export interface LaneExecutionAdapter {
  route: ExecutionRoute;
  preflight(spec: LaneSpec): void;
  prepare?(spec: LaneSpec): Promise<void>;
  build(spec: LaneSpec): LaneProcessPlan;
  createParser(spec: LaneSpec): LaneEventParser;
}
