import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MIN_VERSION,
  createClaudeCodeAdapter,
} from "../src/adapters/claude-code.ts";
import type { LaneSpec } from "../src/schema.ts";

const fixture = fileURLToPath(new URL("./fixtures/claude-lane-stream.jsonl", import.meta.url));
let sandbox: string;

const baseSpec: LaneSpec = {
  lane: "claude-worker",
  task: "Inspect the workspace and report.",
  model: "anthropic/claude-fable-5",
  effort: "high",
  mode: "read-only",
};

async function fakeClaude(directory: string, version = "2.1.216", body = ""): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "claude");
  await writeFile(
    path,
    `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"${version} (Claude Code)\"; exit 0; fi\n${body}\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-kit-claude-adapter-"));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("Claude Code command policy", () => {
  it("builds the complete read-only argv with the task after --", async () => {
    const binary = await fakeClaude(join(sandbox, "bin"));
    const adapter = createClaudeCodeAdapter({ binary });

    await adapter.prepare(baseSpec);
    const plan = adapter.build(baseSpec);

    expect(plan.command).toBe(await realpath(binary));
    expect(plan.args).toEqual([
      "-p",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "fable",
      "--effort",
      "high",
      "--tools",
      "Read,Glob,Grep",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "--",
      baseSpec.task,
    ]);
    expect(plan.cwd).toBe(process.cwd());
  });

  it("builds unrestricted workspace-write tools without bespoke command policy", async () => {
    const binary = await fakeClaude(join(sandbox, "bin"));
    const adapter = createClaudeCodeAdapter({ binary });
    const task = "--dangerously-skip-permissions $(touch should-not-run)";

    await adapter.prepare(baseSpec);
    const plan = adapter.build({ ...baseSpec, task, mode: "workspace-write" });

    expect(plan.args).toEqual([
      "-p",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "fable",
      "--effort",
      "high",
      "--tools",
      "Read,Glob,Grep,Edit,Write,Bash",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash",
      "--",
      task,
    ]);
    expect(plan.args.slice(0, -1)).not.toContain("--dangerously-skip-permissions");
    expect(plan.args).not.toContain("--bare");
    expect(plan.args).not.toContain("bypassPermissions");
    expect(plan.args).not.toContain("max");
    expect(plan.args.at(-1)).toBe(task);
  });

  it("defaults existing Pi-origin specs to workspace-write", async () => {
    const binary = await fakeClaude(join(sandbox, "bin"));
    const adapter = createClaudeCodeAdapter({ binary });
    await adapter.prepare(baseSpec);
    const plan = adapter.build({ ...baseSpec, mode: undefined });

    expect(plan.args).toContain("Read,Glob,Grep,Edit,Write,Bash");
  });

  it("does not inherit sensitive environment variables", async () => {
    const binary = await fakeClaude(join(sandbox, "bin"));
    const adapter = createClaudeCodeAdapter({
      binary,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/lane",
        TERM: "xterm-256color",
        ANTHROPIC_AUTH_TOKEN: "sentinel-auth",
        COOKIE: "sentinel-cookie",
        AWS_SESSION_TOKEN: "sentinel-aws",
        GOOGLE_APPLICATION_CREDENTIALS: "/sentinel/gcp.json",
        AZURE_CLIENT_SECRET: "sentinel-azure",
        SSH_AUTH_SOCK: "/sentinel/agent.sock",
      },
    });
    await adapter.prepare(baseSpec);
    const plan = adapter.build(baseSpec);

    expect(plan.env).toEqual({ PATH: "/usr/bin", HOME: "/home/lane", TERM: "xterm-256color" });
    expect(Object.values(plan.env)).not.toContain("sentinel-auth");
  });
});

describe("Claude Code executable preflight", () => {
  it("resolves PATH candidates, skips unsafe wrappers, and returns a real executable", async () => {
    await fakeClaude(
      join(sandbox, "unsafe"),
      "2.1.216",
      "exec /usr/bin/false --permission-mode bypassPermissions \"$@\"",
    );
    const safe = await fakeClaude(join(sandbox, "safe"));
    const linkedDirectory = join(sandbox, "linked");
    await mkdir(linkedDirectory);
    await symlink(safe, join(linkedDirectory, "claude"));
    const adapter = createClaudeCodeAdapter({
      env: { ...process.env, PATH: [join(sandbox, "unsafe"), linkedDirectory].join(":") },
    });

    await adapter.prepare(baseSpec);
    expect(adapter.build(baseSpec).command).toBe(await realpath(safe));
  });

  it("rejects dangerous wrappers and non-executable candidates", async () => {
    await fakeClaude(join(sandbox, "unsafe"), "2.1.216", "exec claude --dangerously-skip-permissions \"$@\"");
    const nonExecutable = join(sandbox, "plain", "claude");
    await mkdir(join(sandbox, "plain"));
    await writeFile(nonExecutable, "#!/bin/sh\necho '2.1.216 (Claude Code)'\n", "utf8");
    const adapter = createClaudeCodeAdapter({
      env: { ...process.env, PATH: [join(sandbox, "unsafe"), join(sandbox, "plain")].join(":") },
    });

    expect(() => adapter.preflight(baseSpec)).toThrow("No safe Claude Code executable");
  });

  it.each([
    ["2.1.215", false],
    [CLAUDE_CODE_MIN_VERSION, true],
    ["2.1.217", true],
  ])("handles Claude Code version %s", async (version, supported) => {
    const binary = await fakeClaude(join(sandbox, version), version);
    const adapter = createClaudeCodeAdapter({ binary });

    if (supported) await expect(adapter.prepare(baseSpec)).resolves.toBeUndefined();
    else await expect(adapter.prepare(baseSpec)).rejects.toThrow(`requires ${CLAUDE_CODE_MIN_VERSION} or newer`);
  });

  it("runs version preparation asynchronously without invoking the provider", async () => {
    const marker = join(sandbox, "version-started");
    const release = join(sandbox, "release-version");
    const provider = join(sandbox, "provider-invoked");
    const binary = join(sandbox, "claude");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nconst { existsSync, writeFileSync } = require("node:fs");\nif (process.argv[2] === "--version") {\n  writeFileSync(${JSON.stringify(marker)}, "started");\n  const timer = setInterval(() => {\n    if (existsSync(${JSON.stringify(release)})) {\n      clearInterval(timer);\n      console.log("2.1.216 (Claude Code)");\n      process.exit(0);\n    }\n  }, 10);\n} else {\n  writeFileSync(${JSON.stringify(provider)}, "invoked");\n}\n`,
      "utf8",
    );
    await chmod(binary, 0o755);
    const adapter = createClaudeCodeAdapter({ binary });

    let settled = false;
    const preparation = adapter.prepare(baseSpec).finally(() => {
      settled = true;
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await expect(access(marker)).resolves.toBeUndefined();
    expect(settled).toBe(false);
    await expect(access(provider)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(release, "release", "utf8");
    await preparation;
    expect(adapter.build(baseSpec).command).toBe(await realpath(binary));
    await expect(access(provider)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects prohibited efforts before command construction", async () => {
    const binary = await fakeClaude(join(sandbox, "bin"));
    const adapter = createClaudeCodeAdapter({ binary });

    expect(() => adapter.build({ ...baseSpec, effort: "max" as LaneSpec["effort"] })).toThrow("unsupported effort");
  });
});

describe("Claude Code stream parser", () => {
  it("normalizes partial text, thinking, tool lifecycle, cumulative usage, and final result", async () => {
    const lines = (await readFile(fixture, "utf8")).trimEnd().split("\n");
    const parser = createClaudeCodeAdapter({ binary: "/unused" }).createParser(baseSpec);
    const events = lines.flatMap((line) => parser.feedLine(line));

    expect(events[0]).toEqual({ v: 1, type: "task", text: baseSpec.task });
    expect(events).toContainEqual({ v: 1, type: "thinking_delta", delta: "Inspecting fixture." });
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { v: 1, type: "text_delta", delta: "Adapter " },
      { v: 1, type: "text_delta", delta: "complete." },
    ]);
    expect(events).toContainEqual({
      v: 1,
      type: "tool_start",
      tool: "Read",
      input: { file_path: "README.md" },
    });
    expect(events).toContainEqual({
      v: 1,
      type: "tool_end",
      tool: "Read",
      text: "fixture contents",
      isError: false,
    });
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { v: 1, type: "usage", input: 70, output: 10, cacheRead: 20, context: 105 },
      { v: 1, type: "usage", input: 120, output: 40, cacheRead: 50, context: 230 },
    ]);
    expect(events.at(-1)).toEqual({ v: 1, type: "assistant_end", text: "Adapter complete." });
    expect(parser.end()).toEqual([]);
  });

  it.each([
    { case: "is_error", subtype: "failure", is_error: true, result: `auth failed ${"x".repeat(500)}` },
    { case: "error subtype", subtype: "error_max_turns", is_error: false, result: "turn limit reached" },
  ])("normalizes a zero-exit $case result as a bounded failed assistant end", (result) => {
    const parser = createClaudeCodeAdapter({ binary: "/unused" }).createParser(baseSpec);

    const events = parser.feedLine(JSON.stringify({ type: "result", ...result }));
    const end = events.at(-1);

    expect(end).toMatchObject({ v: 1, type: "assistant_end", isError: true });
    expect(end && "text" in end ? end.text.length : 0).toBeLessThanOrEqual(240);
    expect(parser.end()).toEqual([]);
  });

  it("turns malformed JSON into a bounded diagnostic event without throwing", () => {
    const parser = createClaudeCodeAdapter({ binary: "/unused" }).createParser(baseSpec);

    const events = parser.feedLine(`{"type":"assistant","private":"${"x".repeat(2_000)}`);
    const diagnostic = events.find((event) => event.type === "tool_end");

    expect(diagnostic).toMatchObject({ v: 1, type: "tool_end", tool: "claude-code-parser", isError: true });
    expect(diagnostic && "text" in diagnostic ? diagnostic.text.length : 0).toBeLessThanOrEqual(240);
  });

  it("ignores unknown events and ends partial output once", () => {
    const parser = createClaudeCodeAdapter({ binary: "/unused" }).createParser(baseSpec);

    expect(parser.feedLine('{"type":"future_event","payload":true}')).toEqual([
      { v: 1, type: "task", text: baseSpec.task },
    ]);
    expect(
      parser.feedLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}',
      ),
    ).toEqual([{ v: 1, type: "text_delta", delta: "partial" }]);
    expect(parser.end()).toEqual([{ v: 1, type: "assistant_end", text: "partial" }]);
    expect(parser.end()).toEqual([]);
  });

  it("emits only the task when an empty stream ends", () => {
    const parser = createClaudeCodeAdapter({ binary: "/unused" }).createParser(baseSpec);
    expect(parser.end()).toEqual([{ v: 1, type: "task", text: baseSpec.task }]);
  });
});
