import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeConnector } from "../src/connectors/claude-code.ts";
import type { ParseSink } from "../src/connectors/types.ts";
import { TutorRunner } from "../src/runner.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123;
  kill = vi.fn();
}

const fixtureRoot = fileURLToPath(new URL("fixtures/claude-code/", import.meta.url));
const request = {
  model: "sonnet",
  thinking: "low",
  cwd: "/repo",
  prompt: "Reply with the single word ok.",
};

function sink() {
  let answer: string | undefined;
  let answerUsage: Record<string, number> | undefined;
  return {
    get answer() { return answer; },
    get answerUsage() { return answerUsage; },
    deltas: [] as string[],
    usages: [] as Array<Record<string, number>>,
    finals: [] as string[],
    delta(text: string) { this.deltas.push(text); },
    usage(value: Record<string, number>) {
      answerUsage = value;
      this.usages.push(value);
    },
    final(next: string) {
      answer = next;
      this.finals.push(next);
    },
  } satisfies ParseSink & {
    deltas: string[];
    usages: Array<Record<string, number>>;
    finals: string[];
  };
}

async function parseFixture(name: string) {
  const connector = new ClaudeCodeConnector();
  const target = sink();
  const fixture = await readFile(`${fixtureRoot}${name}.jsonl`, "utf8");
  for (const line of fixture.split("\n")) {
    if (line) connector.parseLine(line, target);
  }
  return { connector, target };
}

describe("Claude Code discovery", () => {
  it("reports an absent binary", async () => {
    const connector = new ClaudeCodeConnector();
    const which = vi.fn(async () => undefined);
    await expect(connector.discover({ piModels: [], which })).resolves.toEqual({
      available: false,
      reason: "Claude Code is not installed (claude not found on PATH).",
    });
    expect(which).toHaveBeenCalledWith("claude");
  });

  it("rejects versions before 2.1.0", async () => {
    const connector = new ClaudeCodeConnector();
    await expect(connector.discover({ piModels: [], which: async () => "2.0.9 (Claude Code)" })).resolves.toEqual({
      available: false,
      reason: "Claude Code 2.0.9 is too old; 2.1.0 or newer is required.",
    });
  });

  it("offers the three documented aliases and reviewer effort levels", async () => {
    const connector = new ClaudeCodeConnector();
    await expect(connector.discover({ piModels: [], which: async () => "2.1.245 (Claude Code)" })).resolves.toEqual({
      available: true,
      version: "2.1.245",
      models: [
        { id: "claude-code:fable", label: "Claude Fable 5", thinkingLevels: ["low", "medium", "high", "xhigh"] },
        { id: "claude-code:opus", label: "Claude Opus 5", thinkingLevels: ["low", "medium", "high", "xhigh"] },
        { id: "claude-code:sonnet", label: "Claude Sonnet 5", thinkingLevels: ["low", "medium", "high", "xhigh"] },
      ],
    });
  });

  it("reports an unparseable version", async () => {
    const connector = new ClaudeCodeConnector();
    await expect(connector.discover({ piModels: [], which: async () => "garbage" })).resolves.toEqual({
      available: false,
      reason: "Claude Code version could not be parsed.",
    });
  });
});

describe("Claude Code stream parsing", () => {
  it("uses partial deltas and the authoritative result", async () => {
    const { connector, target } = await parseFixture("success");
    expect(target.deltas).toEqual(["o", "k"]);
    expect(target.usages).toEqual([{ input_tokens: 3, output_tokens: 1, total_cost_usd: 0.01 }]);
    expect(target.finals).toEqual(["partial assistant copy", "ok"]);
    expect(connector.finish(target)).toEqual({
      answer: "ok",
      usage: { input_tokens: 3, output_tokens: 1, total_cost_usd: 0.01 },
    });
  });

  it("maps an authentication failure", async () => {
    await expect(parseFixture("auth-error")).rejects.toThrow(
      "Claude Code is not logged in. Run `claude` once and sign in, then ask again.",
    );
  });

  it.each([
    ["rate limit 429", "Claude Code is rate-limited right now. Try again in a few minutes."],
    ["invalid model alias", "Claude Code rejected model sonnet."],
  ])("maps result failure %j", (result, message) => {
    const connector = new ClaudeCodeConnector();
    const target = sink();
    connector.parseLine(JSON.stringify({ type: "system", subtype: "init", model: "sonnet" }), target);
    expect(() => connector.parseLine(JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true, result,
    }), target)).toThrow(message);
  });

  it("bounds and redacts an unmapped result failure", () => {
    const connector = new ClaudeCodeConnector();
    const result = `sk-ant-fakefakefake ${"x".repeat(220)}`;
    expect(() => connector.parseLine(JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true, result,
    }), sink())).toThrow(`[redacted] ${"x".repeat(180)}`);
  });

  it("rejects an empty answer", async () => {
    const { connector, target } = await parseFixture("empty-answer");
    expect(() => connector.finish(target)).toThrow("Claude Code returned an empty answer.");
  });

  it("ignores malformed lines", async () => {
    const { connector, target } = await parseFixture("malformed-line");
    expect(connector.finish(target)).toMatchObject({ answer: "ok" });
  });

  it("does not report usage when the result omits it", () => {
    const connector = new ClaudeCodeConnector();
    const target = sink();
    connector.parseLine(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "ok",
    }), target);
    expect(target.usages).toEqual([]);
    expect(connector.finish(target)).toEqual({ answer: "ok" });
  });

  it("keeps answers isolated across sequential asks", () => {
    const connector = new ClaudeCodeConnector();
    const first = sink();
    connector.parseLine(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: "first" }] },
    }), first);
    connector.parseLine(JSON.stringify({ type: "result", subtype: "success" }), first);
    expect(connector.finish(first).answer).toBe("first");

    const second = sink();
    connector.parseLine(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: "second" }] },
    }), second);
    connector.parseLine(JSON.stringify({ type: "result", subtype: "success" }), second);
    expect(connector.finish(second).answer).toBe("second");
    expect(second.answer).not.toContain("first");
  });

  it("clears terminal state when finishing throws", () => {
    const connector = new ClaudeCodeConnector();
    const empty = sink();
    connector.parseLine(JSON.stringify({ type: "result", subtype: "success", result: "" }), empty);
    expect(() => connector.finish(empty)).toThrow("Claude Code returned an empty answer.");
    expect(() => connector.finish(sink())).toThrow("Claude Code exited without a result.");
  });

  it("refuses an init event with a write-capable tool", async () => {
    const connector = new ClaudeCodeConnector();
    const target = sink();
    const fixture = await readFile(`${fixtureRoot}unsafe-init.jsonl`, "utf8");
    expect(() => connector.parseLine(fixture.trim(), target)).toThrow(
      "Claude Code did not honour the read-only tool set; refusing to continue.",
    );
  });

  it("refuses an init event with the wrong permission mode", () => {
    const connector = new ClaudeCodeConnector();
    expect(() => connector.parseLine(JSON.stringify({
      type: "system", subtype: "init", permissionMode: "default", tools: ["Read", "Grep", "Glob"],
    }), sink())).toThrow("Claude Code did not honour the read-only tool set; refusing to continue.");
  });

  it("rejects a stream without a result event", async () => {
    const { connector, target } = await parseFixture("missing-result");
    expect(() => connector.finish(target)).toThrow("Claude Code exited without a result.");
  });
});

describe("Claude Code runner integration", () => {
  it("pins invocation, cwd, environment, and prompt", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as never);
    const runner = new TutorRunner({
      spawn,
      env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/config", ANTHROPIC_API_KEY: "excluded" },
    });
    let prompt = "";
    child.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
    const done = runner.run({ ...request, connector: new ClaudeCodeConnector() }, () => {});
    child.stdout.end(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} })}\n`);
    child.emit("close", 0, null);
    await expect(done).resolves.toMatchObject({ answer: "ok" });
    expect(spawn).toHaveBeenCalledWith("claude", [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", "sonnet", "--effort", "low", "--tools", "Read,Grep,Glob",
      "--permission-mode", "dontAsk", "--strict-mcp-config", "--setting-sources", "",
      "--disable-slash-commands", "--no-session-persistence", "--max-turns", "8",
    ], expect.objectContaining({
      cwd: "/repo",
      env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/config", REVIEW_TUTOR_CHILD: "1" },
    }));
    expect(prompt).toBe("Reply with the single word ok.");
  });

  it("settles once when cancelled mid-stream", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const done = runner.run({ ...request, connector: new ClaudeCodeConnector() }, () => {});
    child.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "o" } } })}\n`);
    runner.cancel();
    child.emit("close", null, "SIGTERM");
    await expect(done).rejects.toThrow(/cancelled/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("redacts stderr before it leaves the runner", async () => {
    const child = new FakeChild();
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run({ ...request, connector: new ClaudeCodeConnector() }, () => {});
    child.stderr.end("sk-ant-fakefakefake");
    child.emit("close", 1, null);
    const error = await done.then(() => undefined, (value: unknown) => value as Error);
    expect(error?.message).toContain("[redacted]");
    expect(error?.message).not.toContain("sk-ant-fakefakefake");
  });
});
