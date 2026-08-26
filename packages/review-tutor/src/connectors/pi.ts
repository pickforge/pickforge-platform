import type {
  ConnectorRequest,
  Discovery,
  DiscoveryDeps,
  HarnessConnector,
  ModelChoice,
  ParseSink,
  ParsedAnswer,
  SpawnSpec,
} from "./types.ts";
import {
  BASE_DISCOVERY_ENV_KEYS,
  createDiscoveryExecFile,
  discoveryOptions,
} from "./discovery.ts";
import { ConnectorError } from "./types.ts";

const MINIMUM_VERSION = [0, 83, 0] as const;
const DISCOVERY_ENV_KEYS = [...BASE_DISCOVERY_ENV_KEYS, "XDG_CONFIG_HOME"] as const;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const HEADER_COLUMNS = ["provider", "model", "context", "max-out", "thinking", "images"];

const defaultExecFile = createDiscoveryExecFile(DISCOVERY_ENV_KEYS);

function versionAtLeast(version: readonly number[]): boolean {
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    const difference = version[index]! - MINIMUM_VERSION[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function tableRows(output: string): string[][] {
  const lines = output.split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith("Warning:"));
  const header = lines.findIndex((line) => {
    const columns = line.trim().split(/\s{2,}/);
    return HEADER_COLUMNS.every((column, index) => columns[index] === column);
  });
  if (header < 0) return [];
  return lines.slice(header + 1)
    .map((line) => line.trim().split(/\s{2,}/))
    .filter((columns) => columns.length >= HEADER_COLUMNS.length);
}

function listedModels(output: string): ModelChoice[] {
  return tableRows(output).map(([provider, model, , , thinking]) => ({
    id: `pi:${provider!}/${model!}`,
    label: `${provider!}: ${model!}`,
    thinkingLevels: thinking === "yes" ? [...REASONING_LEVELS] : ["off"],
  }));
}

interface PiContent {
  type?: unknown;
  text?: unknown;
}

interface PiMessage {
  role?: unknown;
  content?: unknown;
  usage?: unknown;
}

interface PiEvent {
  type?: unknown;
  message?: PiMessage;
  messages?: PiMessage[];
  assistantMessageEvent?: {
    type?: unknown;
    delta?: unknown;
  };
}

function parseEvent(line: string): PiEvent {
  try {
    return JSON.parse(line) as PiEvent;
  } catch {
    throw new ConnectorError(
      "Pi JSON parsing failed: expected one valid JSON object per LF-delimited line; inspect child output and retry",
    );
  }
}

function finalAnswer(messages: PiMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const final = messages.filter((message) => message?.role === "assistant").at(-1);
  if (!Array.isArray(final?.content)) {
    return typeof final?.content === "string" ? final.content : "";
  }
  return (final.content as PiContent[])
    .filter((content) => content?.type === "text")
    .map((content) => typeof content.text === "string" ? content.text : "")
    .join("");
}

export class PiConnector implements HarnessConnector {
  readonly id = "pi" as const;
  readonly label = "Pi";

  async discover(deps: DiscoveryDeps): Promise<Discovery> {
    if (deps.piModels) {
      return {
        available: true,
        version: deps.piVersion ?? "unknown",
        models: deps.piModels.map((model) => ({ ...model, id: `pi:${model.id}` })),
      };
    }
    return this.discoverWithoutHost(deps.execFile ?? defaultExecFile);
  }

  private async discoverWithoutHost(execFile: NonNullable<DiscoveryDeps["execFile"]>): Promise<Discovery> {
    let versionOutput: string;
    try {
      ({ stdout: versionOutput } = await execFile("pi", ["--version"], discoveryOptions()));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { available: false, reason: "Pi is not installed (pi not found on PATH)." }
        : { available: false, reason: "Pi could not report a supported version." };
    }
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionOutput.trim());
    if (!match) {
      return { available: false, reason: "Pi could not report a supported version." };
    }
    const version = match.slice(1, 4).map(Number);
    const versionLabel = version.join(".");
    if (!versionAtLeast(version)) {
      return {
        available: false,
        reason: `Pi ${versionLabel} is too old; version 0.83.0 or newer is required.`,
      };
    }
    let models: ModelChoice[];
    try {
      const { stdout } = await execFile("pi", ["--list-models"], discoveryOptions());
      models = listedModels(stdout);
    } catch {
      return { available: false, reason: "Pi could not list its models." };
    }
    return models.length
      ? { available: true, version: versionLabel, models }
      : { available: false, reason: "Pi could not list its models." };
  }

  spawnSpec(request: ConnectorRequest): SpawnSpec {
    const [provider, ...modelParts] = request.model.split("/");
    return {
      command: "pi",
      args: [
        "--mode", "json", "--no-extensions", "--no-skills", "--no-prompt-templates",
        "--no-context-files", "--no-session", "-p", "--tools", "read,grep,find,ls",
        "--provider", provider!, "--model", modelParts.join("/"), "--thinking", request.thinking,
      ],
    };
  }

  parseLine(line: string, sink: ParseSink): void {
    const event = parseEvent(line);
    const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      sink.delta(update.delta);
    }
    if (event.type === "message_end" && event.message?.usage && typeof event.message.usage === "object") {
      sink.usage(event.message.usage as Record<string, number>);
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const candidate = finalAnswer(event.messages);
      if (candidate !== undefined) sink.final(candidate);
    }
  }

  finish(sink: ParseSink): ParsedAnswer {
    if (!sink.answer?.trim()) {
      throw new ConnectorError(
        "Pi answer failed: expected a non-empty final assistant message in agent_end; choose another question or model and retry",
      );
    }
    return { answer: sink.answer, ...(sink.answerUsage ? { usage: sink.answerUsage } : {}) };
  }
}
