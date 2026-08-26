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
    return {
      available: true,
      version: deps.piVersion ?? "unknown",
      models: deps.piModels.map((model) => ({ ...model, id: `pi:${model.id}` })),
    };
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
