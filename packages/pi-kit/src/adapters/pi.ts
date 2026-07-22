import { createChildEnvironment } from "../child-env.ts";
import type {
  LaneEventParser,
  LaneExecutionAdapter,
  LaneProcessPlan,
  NormalizedLaneEvent,
} from "../execution-adapter.ts";
import type { LaneSpec } from "../schema.ts";
import { findModel } from "../table.ts";

const READ_ONLY_TOOLS = "read,grep,find,ls";

const PI_PROVIDERS: Record<string, string> = {
  "openai-codex/gpt-5.6-sol": "openai-codex",
  "xai/grok-4.5": "xai",
  "ollama/glm-5.2:cloud": "ollama",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function numberFrom(record: JsonRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  return contentText(message.content) || undefined;
}

class PiEventParser implements LaneEventParser {
  private taskEmitted = false;
  private input = 0;
  private output = 0;
  private cacheRead = 0;

  constructor(private readonly spec: LaneSpec) {}

  feedLine(line: string): NormalizedLaneEvent[] {
    const events = this.start();
    if (!line.trim()) return events;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return events;
    }
    if (!isRecord(event) || typeof event.type !== "string") return events;

    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        events.push({ v: 1, type: "text_delta", delta: update.delta });
      } else if (update.type === "thinking_delta" && typeof update.delta === "string") {
        events.push({ v: 1, type: "thinking_delta", delta: update.delta });
      }
    } else if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      events.push({ v: 1, type: "tool_start", tool: event.toolName, input: event.args });
    } else if (event.type === "tool_execution_end") {
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      const text = isRecord(event.result) ? contentText(event.result.content) : "";
      events.push({ v: 1, type: "tool_end", tool, text, isError: event.isError === true });
    } else if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
      if (isRecord(event.message.usage)) {
        const usage = event.message.usage;
        this.input += numberFrom(usage, "input", "inputTokens", "input_tokens");
        this.output += numberFrom(usage, "output", "outputTokens", "output_tokens");
        this.cacheRead += numberFrom(usage, "cacheRead", "cacheReadTokens", "cache_read");
        const reportedContext = numberFrom(usage, "totalTokens", "total_tokens", "total", "contextTokens");
        events.push({
          v: 1,
          type: "usage",
          input: this.input,
          output: this.output,
          cacheRead: this.cacheRead,
          context: reportedContext || this.input + this.output,
        });
      }
    } else if (event.type === "agent_end" && Array.isArray(event.messages)) {
      for (let index = event.messages.length - 1; index >= 0; index--) {
        const text = assistantText(event.messages[index]);
        if (text !== undefined) {
          events.push({ v: 1, type: "assistant_end", text });
          break;
        }
      }
    }

    return events;
  }

  end(): NormalizedLaneEvent[] {
    return this.start();
  }

  private start(): NormalizedLaneEvent[] {
    if (this.taskEmitted) return [];
    this.taskEmitted = true;
    return [{ v: 1, type: "task", text: this.spec.task }];
  }
}

export class PiExecutionAdapter implements LaneExecutionAdapter {
  readonly route = "pi" as const;

  constructor(
    private readonly piBinary = "pi",
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  preflight(spec: LaneSpec): void {
    const row = findModel(spec.model);
    if (!row || row.route !== this.route || !PI_PROVIDERS[spec.model]) {
      throw new Error(`model ${spec.model} is not available through the Pi execution route`);
    }
    if (spec.mode !== undefined && spec.mode !== "read-only" && spec.mode !== "workspace-write") {
      throw new Error(`unsupported Pi lane mode: ${String(spec.mode)}`);
    }
  }

  build(spec: LaneSpec): LaneProcessPlan {
    this.preflight(spec);
    const row = findModel(spec.model)!;
    const mode = spec.mode ?? "workspace-write";
    const args = ["--mode", "json", "--no-extensions", "--no-session", "-p"];
    if (mode === "read-only") args.push("--tools", READ_ONLY_TOOLS);
    args.push(
      "--provider",
      PI_PROVIDERS[spec.model]!,
      "--model",
      row.runtimeModel,
      "--thinking",
      spec.effort,
      `Task:\n${spec.task}`,
    );

    return {
      command: this.piBinary,
      args,
      cwd: spec.cwd ?? process.cwd(),
      env: { ...createChildEnvironment(this.env), PIKIT_CHILD: "1" },
    };
  }

  createParser(spec: LaneSpec): LaneEventParser {
    this.preflight(spec);
    return new PiEventParser(spec);
  }
}
