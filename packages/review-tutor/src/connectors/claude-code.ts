import { redact } from "./redact.ts";
import type {
  ConnectorRequest,
  Discovery,
  DiscoveryDeps,
  HarnessConnector,
  ParseSink,
  ParsedAnswer,
  SpawnSpec,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

const THINKING_LEVELS = ["low", "medium", "high", "xhigh"];
const MODELS = [
  { id: "claude-code:fable", label: "Claude Fable 5", thinkingLevels: THINKING_LEVELS },
  { id: "claude-code:opus", label: "Claude Opus 5", thinkingLevels: THINKING_LEVELS },
  { id: "claude-code:sonnet", label: "Claude Sonnet 5", thinkingLevels: THINKING_LEVELS },
];
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  permissionMode?: unknown;
  tools?: unknown;
  usage?: unknown;
  event?: {
    type?: unknown;
    delta?: { type?: unknown; text?: unknown };
  };
  message?: { content?: unknown };
}

function versionAtLeast(major: number, minor: number, patch: number): boolean {
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 0)));
}

function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block): block is { type: "text"; text: string } =>
      block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function validateInit(event: ClaudeEvent): void {
  if (event.type !== "system" || event.subtype !== "init") return;
  const wrongMode = event.permissionMode !== undefined && event.permissionMode !== "dontAsk";
  const wrongTools = Array.isArray(event.tools)
    && event.tools.some((tool) => typeof tool !== "string" || !READ_ONLY_TOOLS.has(tool));
  if (wrongMode || wrongTools) {
    throw new ConnectorError(
      "Claude Code did not honour the read-only tool set; refusing to continue.",
    );
  }
}

function eventDelta(event: ClaudeEvent): string | undefined {
  const delta = event.event?.delta;
  return event.type === "stream_event"
    && event.event?.type === "content_block_delta"
    && delta?.type === "text_delta"
    && typeof delta.text === "string"
    ? delta.text
    : undefined;
}

function eventUsage(event: ClaudeEvent): Record<string, number> {
  const usage = event.usage && typeof event.usage === "object"
    ? event.usage as Record<string, unknown>
    : {};
  const answerUsage: Record<string, number> = {};
  if (typeof usage.input_tokens === "number") answerUsage.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") answerUsage.output_tokens = usage.output_tokens;
  const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : usage.total_cost_usd;
  if (typeof cost === "number") answerUsage.total_cost_usd = cost;
  return answerUsage;
}

export class ClaudeCodeConnector implements HarnessConnector {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";
  readonly envKeys = ["CLAUDE_CONFIG_DIR"] as const;
  private latestAssistant?: string;
  private model = "unknown";
  private sawResult = false;

  async discover(deps: DiscoveryDeps): Promise<Discovery> {
    const output = await deps.which("claude");
    if (output === undefined) {
      return {
        available: false,
        reason: "Claude Code is not installed (claude not found on PATH).",
      };
    }
    const match = output.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return { available: false, reason: "Claude Code version could not be parsed." };
    }
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (!versionAtLeast(Number(match[1]), Number(match[2]), Number(match[3]))) {
      return {
        available: false,
        reason: `Claude Code ${version} is too old; 2.1.0 or newer is required.`,
      };
    }
    return { available: true, version, models: MODELS.map((model) => ({ ...model })) };
  }

  spawnSpec(request: ConnectorRequest): SpawnSpec {
    this.latestAssistant = undefined;
    this.model = request.model;
    this.sawResult = false;
    return {
      command: "claude",
      args: [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", request.model, "--effort", request.thinking,
        "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk",
        "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
        "--no-session-persistence", "--max-turns", "8",
      ],
    };
  }

  parseLine(line: string, sink: ParseSink): void {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return;
    }

    validateInit(event);
    const delta = eventDelta(event);
    if (delta !== undefined) sink.delta(delta);
    if (event.type === "assistant") {
      const latest = assistantText(event.message?.content);
      if (latest !== undefined) this.latestAssistant = latest;
    }
    if (event.type === "result") this.handleResult(event, sink);
  }

  private handleResult(event: ClaudeEvent, sink: ParseSink): void {
    this.sawResult = true;
    if (event.is_error === true || event.subtype !== "success") {
      throw new ConnectorError(this.failureMessage(event.result));
    }
    sink.usage(eventUsage(event));
    const answer = typeof event.result === "string" ? event.result : this.latestAssistant;
    if (answer !== undefined) sink.final(answer);
  }

  finish(sink: ParseSink): ParsedAnswer {
    if (!this.sawResult) {
      throw new ConnectorError("Claude Code exited without a result.");
    }
    if (!sink.answer?.trim()) {
      throw new ConnectorError("Claude Code returned an empty answer.");
    }
    return { answer: sink.answer, ...(sink.answerUsage ? { usage: sink.answerUsage } : {}) };
  }

  private failureMessage(value: unknown): string {
    const text = typeof value === "string" ? value : "Claude Code failed.";
    if (/not logged in|please run \/login|authentication/i.test(text)) {
      return "Claude Code is not logged in. Run `claude` once and sign in, then ask again.";
    }
    if (/rate limit|overloaded|429/i.test(text)) {
      return "Claude Code is rate-limited right now. Try again in a few minutes.";
    }
    if (/unknown model|invalid model/i.test(text)) {
      return `Claude Code rejected model ${this.model}.`;
    }
    return redact(text.slice(0, 200));
  }
}
