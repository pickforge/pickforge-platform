/**
 * Lane transcript model: reduces a raw per-lane Pi JSONL stream (pi --mode json)
 * into an ordered list of display entries (thinking, text, tool calls, results).
 * Used by the lanes TUI for both live tailing and archived replay.
 */

export type EntryKind = "task" | "thinking" | "text" | "tool" | "tool_result" | "info";

export interface TranscriptEntry {
  kind: EntryKind;
  /** Short label, e.g. tool name. */
  title?: string;
  text: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

const MAX_ENTRY_TEXT = 20_000;
const MAX_RESULT_TEXT = 4_000;

export class LaneTranscript {
  readonly entries: TranscriptEntry[] = [];
  /** Bumped on every visible change, so views can cheaply detect updates. */
  version = 0;
  private currentKey = "";

  /** Feed one raw JSONL line from the lane's pi process. */
  feed(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event) || typeof event.type !== "string") return;
    if (event.v === 1 && this.handleNormalized(event)) return;
    this.handlePi(event);
  }

  feedChunk(chunk: string): void {
    for (const line of chunk.split("\n")) this.feed(line);
  }

  private push(kind: EntryKind, text: string, title?: string): void {
    this.entries.push({ kind, text, ...(title !== undefined ? { title } : {}) });
    this.version++;
  }

  private appendDelta(kind: "thinking" | "text", key: string, delta: string): void {
    const last = this.entries[this.entries.length - 1];
    if (this.currentKey === key && last && last.kind === kind) {
      if (last.text.length < MAX_ENTRY_TEXT) last.text += delta.slice(0, MAX_ENTRY_TEXT - last.text.length);
    } else {
      this.currentKey = key;
      this.entries.push({ kind, text: delta.slice(0, MAX_ENTRY_TEXT) });
    }
    this.version++;
  }

  private handleNormalized(event: JsonRecord): boolean {
    switch (event.type) {
      case "task":
        if (typeof event.text !== "string") return true;
        if (this.entries.length === 0) this.push("task", event.text.slice(0, MAX_ENTRY_TEXT));
        return true;
      case "thinking_delta":
        if (typeof event.delta === "string") this.appendDelta("thinking", "normalized-thinking", event.delta);
        return true;
      case "text_delta":
        if (typeof event.delta === "string") this.appendDelta("text", "normalized-text", event.delta);
        return true;
      case "tool_start":
        if (typeof event.tool !== "string") return true;
        this.currentKey = "";
        this.push("tool", inputText(event.input).slice(0, MAX_RESULT_TEXT), event.tool);
        return true;
      case "tool_end":
        if (typeof event.tool !== "string" || typeof event.text !== "string") return true;
        this.currentKey = "";
        this.push(
          "tool_result",
          event.text.slice(0, MAX_RESULT_TEXT),
          event.isError === true ? `${event.tool} (error)` : event.tool,
        );
        return true;
      case "usage":
        return true;
      case "assistant_end": {
        if (typeof event.text !== "string" || !event.text) return true;
        const rendered = this.entries
          .filter((entry) => entry.kind === "text")
          .map((entry) => entry.text)
          .join("");
        if (!rendered) this.push("text", event.text.slice(0, MAX_ENTRY_TEXT));
        else if (event.text.startsWith(rendered) && event.text.length > rendered.length) {
          this.appendDelta("text", "normalized-text", event.text.slice(rendered.length));
        }
        this.currentKey = "";
        return true;
      }
      default:
        return false;
    }
  }

  private handlePi(event: JsonRecord): void {
    if (event.type === "message_start" && isRecord(event.message) && event.message.role === "user") {
      if (this.entries.length === 0) this.push("task", firstText(event.message.content).slice(0, MAX_ENTRY_TEXT));
      return;
    }

    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
      if (update.type === "thinking_delta" && typeof update.delta === "string") {
        this.appendDelta("thinking", `thinking:${index}`, update.delta);
      } else if (update.type === "text_delta" && typeof update.delta === "string") {
        this.appendDelta("text", `text:${index}`, update.delta);
      } else if (update.type === "toolcall_end" && isRecord(update.toolCall)) {
        const call = update.toolCall;
        const name = typeof call.name === "string" ? call.name : "tool";
        let args = "";
        try {
          args = JSON.stringify(call.arguments) ?? "";
        } catch {
          args = String(call.arguments);
        }
        this.currentKey = "";
        this.push("tool", args.slice(0, MAX_RESULT_TEXT), name);
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const text = isRecord(event.result) ? firstText(event.result.content) : "";
      this.currentKey = "";
      this.push("tool_result", text.slice(0, MAX_RESULT_TEXT), event.isError === true ? `${name} (error)` : name);
      return;
    }

    if (event.type === "agent_end") {
      this.currentKey = "";
    }
  }
}
