import { execFile as nodeExecFile } from "node:child_process";
import type {
  ConnectorRequest,
  Discovery,
  DiscoveryDeps,
  DiscoveryExecFile,
  HarnessConnector,
  ParseSink,
  ParsedAnswer,
  SpawnSpec,
} from "./types.ts";
import { redact } from "./redact.ts";
import { ConnectorError } from "./types.ts";

const MAX_CATALOG_BYTES = 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const FALLBACK_LEVELS = ["low", "medium", "high"];
const MINIMUM_VERSION = [0, 140, 0] as const;
const DISCOVERY_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "CODEX_HOME"] as const;

interface CodexModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
  priority?: unknown;
}

interface CodexEvent {
  type?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  item?: { type?: unknown; text?: unknown };
  usage?: unknown;
}

export function discoveryEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(DISCOVERY_ENV_KEYS.flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

const defaultExecFile: DiscoveryExecFile = (file, args, options) => new Promise((resolve, reject) => {
  nodeExecFile(file, args, { ...options, env: discoveryEnvironment(), shell: false }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

function versionAtLeast(version: readonly number[]): boolean {
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    const difference = version[index]! - MINIMUM_VERSION[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function validListedModel(value: unknown): value is CodexModel & { slug: string; visibility: "list" } {
  if (!value || typeof value !== "object") return false;
  const model = value as CodexModel;
  return typeof model.slug === "string" && model.visibility === "list";
}

function parseModels(value: string): CodexModel[] {
  const parsed = JSON.parse(value) as unknown;
  const models = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : undefined;
  if (!models) throw new Error("invalid catalog");
  const listed = models.filter(validListedModel);
  if (listed.length === 0) throw new Error("invalid catalog");
  return listed;
}

function priority(model: CodexModel): number {
  return typeof model.priority === "number" && Number.isFinite(model.priority)
    ? model.priority
    : Number.POSITIVE_INFINITY;
}

function modelChoices(models: CodexModel[]) {
  return models
    .sort((left, right) => priority(left) - priority(right)
      || (left.slug as string).localeCompare(right.slug as string))
    .flatMap((model) => {
      const slug = model.slug as string;
      const levels = model.supported_reasoning_levels === undefined
        ? FALLBACK_LEVELS
        : Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
            .flatMap((level) => level && typeof level === "object"
              && typeof (level as { effort?: unknown }).effort === "string"
              ? [(level as { effort: string }).effort]
              : [])
            .filter((effort) => effort !== "max"
              && effort !== "ultra"
              && /^[a-z][a-z0-9_-]*$/.test(effort))
          : [];
      return levels.length === 0 ? [] : [{
        id: `codex:${slug}`,
        label: typeof model.display_name === "string" && model.display_name || slug,
        thinkingLevels: [...levels],
      }];
    });
}

function parseEvent(line: string): CodexEvent | undefined {
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return undefined;
  }
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function providerMessage(message: string, model: string): ConnectorError {
  let safe: string;
  if (/401|unauthorized|missing bearer|not logged in|login/i.test(message)) {
    safe = "Codex is not logged in. Run `codex login`, then ask again.";
  } else if (/429|rate limit|quota|insufficient_quota/i.test(message)) {
    safe = "Codex is rate-limited or out of quota right now. Try again later.";
  } else if (/model .* not (found|supported)|unknown model|invalid model/i.test(message)) {
    safe = `Codex rejected model ${model}.`;
  } else {
    safe = redact(message).replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return new ConnectorError(safe || "Codex failed to complete the turn.");
}

export class CodexConnector implements HarnessConnector {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly envKeys = ["CODEX_HOME"] as const;
  private completed = false;
  private lastError?: string;
  private model = "unknown";

  async discover(deps: DiscoveryDeps): Promise<Discovery> {
    const execFile = deps.execFile ?? defaultExecFile;
    let versionOutput: string;
    try {
      const options = {
        encoding: "utf8" as const,
        maxBuffer: MAX_CATALOG_BYTES,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        timeout: DISCOVERY_TIMEOUT_MS,
      };
      ({ stdout: versionOutput } = await execFile("codex", ["--version"], options));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { available: false, reason: "Codex is not installed (codex not found on PATH)." }
        : { available: false, reason: "Codex could not report a supported version." };
    }
    const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
    if (!match) {
      return { available: false, reason: "Codex could not report a supported version." };
    }
    const version = match.slice(1, 4).map(Number);
    const versionLabel = version.join(".");
    if (!versionAtLeast(version)) {
      return {
        available: false,
        reason: `Codex ${versionLabel} is too old; version 0.140.0 or newer is required.`,
      };
    }
    try {
      const options = {
        encoding: "utf8" as const,
        maxBuffer: MAX_CATALOG_BYTES,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        timeout: DISCOVERY_TIMEOUT_MS,
      };
      const { stdout } = await execFile("codex", ["debug", "models"], options);
      return { available: true, version: versionLabel, models: modelChoices(parseModels(stdout)) };
    } catch {
      return { available: false, reason: "Codex could not list its models." };
    }
  }

  spawnSpec(request: ConnectorRequest): SpawnSpec {
    this.model = request.model;
    return {
      command: "codex",
      args: [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check",
        "-s", "read-only", "-C", request.cwd,
        "-m", request.model, "-c", `model_reasoning_effort=\"${request.thinking}\"`,
        "-c", "shell_environment_policy.inherit=\"none\"",
        "-c", "model_verbosity=\"low\"", "-",
      ],
    };
  }

  parseLine(line: string, sink: ParseSink): void {
    const event = parseEvent(line);
    if (!event) return;
    if (event.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string") {
      sink.delta(event.item.text);
      sink.final(event.item.text);
      return;
    }
    if (event.type === "error" && typeof event.message === "string") {
      this.lastError = event.message;
      return;
    }
    if (event.type === "turn.failed") {
      const message = typeof event.error?.message === "string"
        ? event.error.message
        : this.lastError ?? "Codex failed to complete the turn.";
      throw providerMessage(message, this.model);
    }
    if (event.type === "turn.completed") {
      this.completed = true;
      const usage = numericUsage(event.usage);
      if (usage) sink.usage(usage);
    }
  }

  finish(sink: ParseSink): ParsedAnswer {
    try {
      if (!this.completed) {
        if (this.lastError) throw providerMessage(this.lastError, this.model);
        throw new ConnectorError("Codex exited without completing the turn.");
      }
      if (!sink.answer?.trim()) {
        throw new ConnectorError("Codex returned an empty answer.");
      }
      return { answer: sink.answer, ...(sink.answerUsage ? { usage: sink.answerUsage } : {}) };
    } finally {
      this.completed = false;
      this.lastError = undefined;
      this.model = "unknown";
    }
  }
}
