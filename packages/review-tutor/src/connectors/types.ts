export type HarnessId = "pi" | "claude-code" | "codex";

export interface HarnessConnector {
  readonly id: HarnessId;
  readonly label: string;
  discover(deps: DiscoveryDeps): Promise<Discovery>;
  spawnSpec(request: ConnectorRequest): SpawnSpec;
  parseLine(line: string, sink: ParseSink): void;
  finish(sink: ParseSink): ParsedAnswer;
  readonly envKeys?: readonly string[];
}

export interface DiscoveryDeps {
  piModels: ModelChoice[];
  piVersion?: string;
}

export type Discovery =
  | { available: true; version: string; models: ModelChoice[] }
  | { available: false; reason: string };

export interface ModelChoice {
  id: string;
  label: string;
  thinkingLevels: string[];
}

export interface ConnectorRequest {
  model: string;
  thinking: string;
  cwd: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
}

export interface ParseSink {
  readonly answer?: string;
  readonly answerUsage?: Record<string, number>;
  delta(text: string): void;
  usage(u: Record<string, number>): void;
  final(answer: string): void;
}

export interface ParsedAnswer {
  answer: string;
  usage?: Record<string, number>;
}

export class ConnectorError extends Error {}
