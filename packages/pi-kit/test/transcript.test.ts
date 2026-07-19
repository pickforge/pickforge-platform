import { describe, expect, it } from "vitest";
import { LaneTranscript } from "../src/transcript.ts";

const line = (obj: unknown) => JSON.stringify(obj);

describe("LaneTranscript", () => {
  it("reduces a raw pi json stream into ordered entries", () => {
    const t = new LaneTranscript();
    t.feed(line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "do the task" }] } }));
    t.feed(line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm " } }));
    t.feed(line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ok" } }));
    t.feed(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer: " } }));
    t.feed(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "42" } }));
    t.feed(
      line({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: { name: "bash", arguments: { command: "echo hi" } },
        },
      }),
    );
    t.feed(
      line({
        type: "tool_execution_end",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "hi\n" }] },
      }),
    );

    expect(t.entries.map((entry) => entry.kind)).toEqual(["task", "thinking", "text", "tool", "tool_result"]);
    expect(t.entries[0]!.text).toBe("do the task");
    expect(t.entries[1]!.text).toBe("hmm ok");
    expect(t.entries[2]!.text).toBe("Answer: 42");
    expect(t.entries[3]!.title).toBe("bash");
    expect(t.entries[4]!.text).toBe("hi\n");
  });

  it("ignores malformed lines and keeps version monotonic", () => {
    const t = new LaneTranscript();
    t.feedChunk("not json\n{}\n");
    expect(t.entries).toEqual([]);
    const before = t.version;
    t.feed(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }));
    expect(t.version).toBeGreaterThan(before);
  });
});
