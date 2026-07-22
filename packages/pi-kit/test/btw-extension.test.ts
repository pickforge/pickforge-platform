import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import btwExtension from "../extensions/btw.ts";
import { listRuns, readRun } from "../src/journal-core.ts";

const streamFixture = fileURLToPath(new URL("./fixtures/lane-stream.jsonl", import.meta.url));
const originalDataDir = process.env.PIKIT_DATA_DIR;
const originalPath = process.env.PATH;

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type ShutdownHandler = () => Promise<void> | void;

function makeHarness() {
  let handler: CommandHandler | undefined;
  let shutdown: ShutdownHandler | undefined;
  const sent: unknown[] = [];
  const messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    registerCommand: (_name: string, command: { handler: CommandHandler }) => {
      handler = command.handler;
    },
    registerMessageRenderer: () => {},
    getThinkingLevel: () => "medium",
    on: (name: string, listener: ShutdownHandler) => {
      if (name === "session_shutdown") shutdown = listener;
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => messages.push({ message, options }),
    sendUserMessage: (content: unknown) => sent.push(content),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dataDir,
    hasUI: false,
    isIdle: () => false,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  btwExtension(pi);
  return {
    invoke: (args: string) => {
      if (!handler) throw new Error("btw command not registered");
      return handler(args, ctx);
    },
    messages,
    notifications,
    sent,
    shutdown: () => {
      if (!shutdown) throw new Error("session_shutdown handler not registered");
      return shutdown();
    },
  };
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-kit-btw-"));
  process.env.PIKIT_DATA_DIR = dataDir;
  const binary = join(dataDir, "pi");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nconst lines = readFileSync(${JSON.stringify(streamFixture)}, "utf8").trimEnd().split("\\n");\nsetTimeout(() => { for (const line of lines) console.log(line); }, 300);\n`,
    "utf8",
  );
  await chmod(binary, 0o755);
  process.env.PATH = `${dataDir}:${originalPath}`;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PIKIT_DATA_DIR;
  else process.env.PIKIT_DATA_DIR = originalDataDir;
  process.env.PATH = originalPath;
  await rm(dataDir, { recursive: true, force: true });
});

describe("btw extension", () => {
  it("runs in a secondary background process without queueing a parent message", async () => {
    const harness = makeHarness();
    const started = Date.now();

    await harness.invoke("what is the answer?");

    expect(Date.now() - started).toBeLessThan(250);
    expect(harness.sent).toEqual([]);
    expect(harness.messages).toEqual([]);

    const deadline = Date.now() + 5_000;
    while (harness.messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(harness.sent).toEqual([]);
    expect(harness.messages).toHaveLength(1);
    expect(harness.notifications).toContainEqual({ message: "btw done — Hello from lane.", level: "info" });
    expect(harness.messages[0]).toMatchObject({
      message: {
        customType: "pi-btw",
        content: "Hello from lane.",
        display: true,
        details: {
          prompt: "what is the answer?",
          answer: "Hello from lane.",
          state: "done",
        },
      },
      options: { deliverAs: "nextTurn" },
    });
    const run = listRuns()[0]!;
    expect(readRun(run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "lane_created",
          spec: expect.objectContaining({ lane: "btw", mode: "read-only" }),
        }),
      ]),
    );
  });

  it("awaits background cleanup on session shutdown without delivering a stale answer", async () => {
    const harness = makeHarness();
    await harness.invoke("what is the answer?");

    await harness.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(harness.messages).toEqual([]);
  });

  it("rejects an empty side question without starting work", async () => {
    const harness = makeHarness();
    await harness.invoke("  ");
    expect(harness.sent).toEqual([]);
    expect(harness.messages).toEqual([]);
    expect(harness.notifications).toContainEqual({ message: "Usage: /btw <question>", level: "warning" });
  });
});
