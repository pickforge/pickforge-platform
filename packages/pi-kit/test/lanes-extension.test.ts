import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import lanesExtension from "../extensions/lanes.ts";

const streamFixture = fileURLToPath(new URL("./fixtures/lane-stream.jsonl", import.meta.url));
const originalDataDir = process.env.PIKIT_DATA_DIR;
const originalPath = process.env.PATH;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<ToolResult>;

function makeHarness(opts: { idle?: boolean } = {}) {
  const tools = new Map<string, { execute: ToolExecute }>();
  const sent: Array<{ content: string; options?: unknown }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: ToolExecute }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    on: () => {},
    sendUserMessage: (content: string, options?: unknown) => {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    isIdle: () => opts.idle ?? true,
    ui: {},
  } as unknown as ExtensionContext;
  lanesExtension(pi);
  const call = (name: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute("tc", params, signal, undefined, ctx);
  };
  return { call, sent, tools };
}

let dataDir: string;

async function fixtureBinary(name: string, source: string): Promise<void> {
  const path = join(dataDir, name);
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

/** Fake `pi` on PATH that replays the fixture stream after a short delay. */
async function installSlowPi(delayMs: number): Promise<void> {
  await fixtureBinary(
    "pi",
    `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nconst lines = readFileSync(${JSON.stringify(streamFixture)}, "utf8").trimEnd().split("\\n");\nsetTimeout(() => { for (const line of lines) console.log(line); }, ${delayMs});\n`,
  );
  process.env.PATH = `${dataDir}:${originalPath}`;
}

const spec = { lane: "worker", task: "fixture task", model: "openai-codex/gpt-5.6-sol", effort: "medium" };

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-kit-lanes-ext-"));
  process.env.PIKIT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PIKIT_DATA_DIR;
  else process.env.PIKIT_DATA_DIR = originalDataDir;
  process.env.PATH = originalPath;
  await rm(dataDir, { recursive: true, force: true });
});

describe("async lanes extension", () => {
  it("lanes_spawn returns immediately while lanes keep running", async () => {
    await installSlowPi(300);
    const { call } = makeHarness();
    const started = Date.now();
    const result = await call("lanes_spawn", { lanes: [spec] });
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("non-blocking");
    expect(result.content[0]!.text).toContain("worker");

    const status = await call("lanes_status", {});
    expect(status.content[0]!.text).toMatch(/worker: (queued|running)/);

    const final = await call("lanes_wait", {});
    expect(final.isError).toBeFalsy();
    expect(final.content[0]!.text).toContain("worker: done");
    expect(final.content[0]!.text).toContain("Hello from lane.");
  });

  it("lanes_status with a lane filter returns the detailed single-lane view", async () => {
    await installSlowPi(10);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });
    await call("lanes_wait", {});

    const detail = await call("lanes_status", { lane: "worker" });
    expect(detail.content[0]!.text).toContain("worker: done");

    const unknown = await call("lanes_status", { lane: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain('Unknown lane "nope"');
    expect(unknown.content[0]!.text).toContain("worker");
  });

  it("rejects a second spawn while a run is active, allows it after settlement", async () => {
    await installSlowPi(300);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });
    const second = await call("lanes_spawn", { lanes: [spec] });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain("still active");

    await call("lanes_wait", {});
    const third = await call("lanes_spawn", { lanes: [{ ...spec, lane: "again" }] });
    expect(third.isError).toBeFalsy();
    await call("lanes_wait", {});
  });

  it("aborting lanes_wait detaches the wait without stopping lanes", async () => {
    await installSlowPi(400);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });

    const controller = new AbortController();
    const waiting = call("lanes_wait", {}, controller.signal);
    controller.abort();
    const detached = await waiting;
    expect(detached.content[0]!.text).toContain("keeps running");

    const final = await call("lanes_wait", {});
    expect(final.content[0]!.text).toContain("worker: done");
  });

  it("lanes_abandon stops a named lane and reports unknown lanes", async () => {
    await installSlowPi(2_000);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });

    const unknown = await call("lanes_abandon", { lane: "nope" });
    expect(unknown.isError).toBe(true);

    const result = await call("lanes_abandon", { lane: "worker", reason: "test stop" });
    expect(result.content[0]!.text).toContain("worker: abandoned");
    const final = await call("lanes_wait", {});
    expect(final.isError).toBe(true);
    expect(final.content[0]!.text).toContain("test stop");
  });

  it("nudges an idle session once when the run settles unobserved", async () => {
    await installSlowPi(50);
    const { call, sent } = makeHarness({ idle: true });
    await call("lanes_spawn", { lanes: [spec] });
    await waitFor(() => sent.length > 0);
    expect(sent[0]!.content).toContain("settled");
    expect(sent[0]!.content).toContain("lanes_status");
  });

  it("does not nudge when the results were already collected via lanes_wait", async () => {
    await installSlowPi(50);
    const { call, sent } = makeHarness({ idle: true });
    await call("lanes_spawn", { lanes: [spec] });
    await call("lanes_wait", {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toEqual([]);
  });
});

describe("session shutdown", () => {
  it("abandons an active run and suppresses the nudge on session_shutdown", async () => {
    await installSlowPi(2_000);
    const handlers = new Map<string, () => void>();
    const tools = new Map<string, { execute: ToolExecute }>();
    const sent: unknown[] = [];
    const pi = {
      registerTool: (tool: { name: string; execute: ToolExecute }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      sendUserMessage: (content: unknown) => sent.push(content),
      on: (name: string, handler: () => void) => handlers.set(name, handler),
    } as unknown as ExtensionAPI;
    const ctx = { hasUI: false, isIdle: () => true, ui: {} } as unknown as ExtensionContext;
    lanesExtension(pi);
    await tools.get("lanes_spawn")!.execute("tc", { lanes: [spec] }, undefined, undefined, ctx);

    handlers.get("session_shutdown")!();

    const status = await tools.get("lanes_status")!.execute("tc", {}, undefined, undefined, ctx);
    expect(status.content[0]!.text).toContain("worker: abandoned");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
  });
});
