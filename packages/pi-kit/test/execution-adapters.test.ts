import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiExecutionAdapter } from "../src/adapters/pi.ts";
import type { LaneSpec } from "../src/schema.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/lane-stream.jsonl", import.meta.url));

const baseSpec: LaneSpec = {
  lane: "worker",
  task: "Run the fixture task",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
  mode: "read-only",
  cwd: "/workspace with spaces",
};

describe("PiExecutionAdapter", () => {
  it("builds the existing JSON invocation with an injectable binary and read-only tools", () => {
    const adapter = new PiExecutionAdapter("/opt/pi test/bin/pi");

    expect(adapter.build(baseSpec)).toMatchObject({
      command: "/opt/pi test/bin/pi",
      cwd: "/workspace with spaces",
      args: [
        "--mode",
        "json",
        "--no-extensions",
        "--no-session",
        "-p",
        "--tools",
        "read,grep,find,ls",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
        "--thinking",
        "medium",
        "Task:\nRun the fixture task",
      ],
      env: expect.objectContaining({ PIKIT_CHILD: "1" }),
    });
  });

  it.each(["@prompt.md", "-", "--dangerously-skip-permissions"])(
    "prefixes positional task %s with a non-option literal",
    (task) => {
      const plan = new PiExecutionAdapter().build({ ...baseSpec, task });

      expect(plan.args.at(-1)).toBe(`Task:\n${task}`);
      expect(plan.args.at(-1)?.startsWith("Task:\n")).toBe(true);
    },
  );

  it("does not inherit sensitive environment variables", () => {
    const plan = new PiExecutionAdapter("pi", {
      PATH: "/usr/bin",
      HOME: "/home/lane",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "sentinel-secret",
      AWS_SECRET_ACCESS_KEY: "sentinel-aws",
      GOOGLE_APPLICATION_CREDENTIALS: "/sentinel/gcp.json",
      AZURE_CLIENT_SECRET: "sentinel-azure",
      SSH_AUTH_SOCK: "/sentinel/agent.sock",
    }).build(baseSpec);

    expect(plan.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/lane",
      LANG: "en_US.UTF-8",
      PIKIT_CHILD: "1",
    });
    expect(Object.values(plan.env)).not.toContain("sentinel-secret");
  });

  it("uses table runtime mappings for every Pi-routed model", () => {
    const adapter = new PiExecutionAdapter();
    const cases = [
      ["openai-codex/gpt-5.6-sol", "medium", "openai-codex", "gpt-5.6-sol"],
      ["xai/grok-4.5", "high", "xai", "grok-4.5"],
      ["ollama/glm-5.2:cloud", "medium", "ollama", "glm-5.2:cloud"],
    ] as const;

    for (const [selector, effort, provider, model] of cases) {
      const args = adapter.build({ ...baseSpec, model: selector, effort }).args;
      expect(args.slice(args.indexOf("--provider"), args.indexOf("--thinking"))).toEqual([
        "--provider",
        provider,
        "--model",
        model,
      ]);
    }
  });

  it("uses normal harness tools for workspace-write mode", () => {
    const plan = new PiExecutionAdapter().build({ ...baseSpec, mode: "workspace-write" });

    expect(plan.args).toContain("--no-extensions");
    expect(plan.args).not.toContain("-e");
    expect(plan.args).not.toContain("--extension");
    expect(plan.args).not.toContain("--tools");
  });

  it("normalizes Pi JSONL one line at a time", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const parser = new PiExecutionAdapter().createParser(baseSpec);
    const events = fixture.trimEnd().split("\n").flatMap((line) => parser.feedLine(line));
    events.push(...parser.feedLine("not json"), ...parser.end());

    expect(events).toEqual([
      { v: 1, type: "task", text: "Run the fixture task" },
      { v: 1, type: "tool_start", tool: "bash", input: { command: "printf 'fixture tool output'" } },
      { v: 1, type: "text_delta", delta: "Hello from " },
      { v: 1, type: "text_delta", delta: "lane." },
      { v: 1, type: "usage", input: 1200, output: 300, cacheRead: 40, context: 1550 },
      { v: 1, type: "assistant_end", text: "Hello from lane." },
    ]);
  });

  it("normalizes thinking and tool results", () => {
    const parser = new PiExecutionAdapter().createParser(baseSpec);
    const lines = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "consider" } }),
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "read",
        result: { content: [{ type: "text", text: "first" }, { type: "text", text: " second" }] },
        isError: true,
      }),
    ];

    expect(lines.flatMap((line) => parser.feedLine(line))).toEqual([
      { v: 1, type: "task", text: "Run the fixture task" },
      { v: 1, type: "thinking_delta", delta: "consider" },
      { v: 1, type: "tool_end", tool: "read", text: "first second", isError: true },
    ]);
  });
});
