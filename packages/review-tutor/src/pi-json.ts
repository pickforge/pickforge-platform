export interface PiResult {
  answer: string;
  usage?: Record<string, number>;
}

export type PiStreamEvent = { type: "delta"; text: string };

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

function delta(event: PiEvent): PiStreamEvent[] {
  const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
  return update?.type === "text_delta" && typeof update.delta === "string"
    ? [{ type: "delta", text: update.delta }]
    : [];
}

export function parsePiJson() {
  let pending = "";
  let answer: string | undefined;
  let usage: Record<string, number> | undefined;

  const parseLine = (raw: string): PiStreamEvent[] => {
    let event: PiEvent;
    try {
      event = JSON.parse(raw) as PiEvent;
    } catch {
      throw new Error(
        "Pi JSON parsing failed: expected one valid JSON object per LF-delimited line; inspect child output and retry",
      );
    }

    if (
      event.type === "message_end"
      && event.message?.usage
      && typeof event.message.usage === "object"
    ) {
      usage = event.message.usage as Record<string, number>;
    }

    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const candidate = finalAnswer(event.messages);
      if (answer === undefined || candidate?.trim()) answer = candidate;
    }
    return delta(event);
  };

  return {
    push(chunk: string): PiStreamEvent[] {
      pending += chunk;
      const output: PiStreamEvent[] = [];
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (raw) output.push(...parseLine(raw));
      }
      return output;
    },
    finish(): PiResult {
      if (pending.trim()) parseLine(pending);
      if (!answer?.trim()) {
        throw new Error(
          "Pi answer failed: expected a non-empty final assistant message in agent_end; choose another question or model and retry",
        );
      }
      return { answer, ...(usage ? { usage } : {}) };
    },
  };
}
