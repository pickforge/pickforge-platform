import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import lanesExtension, { type LanesCoordinatorPort } from "../extensions/lanes.ts";
import { readRun } from "../src/journal-core.ts";
import type { RunSnapshotDto } from "../src/lane-coordinator.ts";
import type { LaneSpec } from "../src/schema.ts";
import { MODEL_TABLE } from "../src/table.ts";

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

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ShutdownHandler = () => Promise<void> | void;

function makeHarness(
  opts: {
    idle?: boolean;
    hasUI?: boolean;
    ui?: ExtensionContext["ui"];
    createCoordinator?: () => LanesCoordinatorPort;
  } = {},
) {
  const tools = new Map<string, { name: string; description: string; execute: ToolExecute }>();
  const commands = new Map<string, CommandHandler>();
  const handlers = new Map<string, ShutdownHandler>();
  const sent: Array<{ content: string; options?: unknown }> = [];
  const pi = {
    registerTool: (tool: { name: string; description: string; execute: ToolExecute }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => commands.set(name, command.handler),
    on: (name: string, handler: ShutdownHandler) => handlers.set(name, handler),
    sendUserMessage: (content: string, options?: unknown) => {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: opts.hasUI ?? false,
    isIdle: () => opts.idle ?? true,
    ui: opts.ui ?? {},
  } as unknown as ExtensionContext;
  lanesExtension(pi, { createCoordinator: opts.createCoordinator });
  const call = (name: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute("tc", params, signal, undefined, ctx);
  };
  return { call, commands, ctx, handlers, sent, tools };
}

class FaultCoordinator implements LanesCoordinatorPort {
  snapshot?: RunSnapshotDto;
  fail?: "spawn" | "status" | "wait" | "abandon" | "shutdown";
  shutdownImpl: (reason: string) => Promise<void> = async () => {};

  async spawn(specs: LaneSpec[]): Promise<RunSnapshotDto> {
    if (this.fail === "spawn") throw new Error("injected spawn failure");
    this.snapshot = {
      run: "run-injected",
      state: "active",
      durationMs: 65_000,
      totals: { cost: 0, tokensIn: 0, tokensOut: 0 },
      lanes: specs.map((lane) => ({
        lane: lane.lane,
        model: lane.model,
        effort: lane.effort,
        mode: lane.mode ?? "workspace-write",
        state: "running",
        durationMs: 5_000,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      })),
    };
    return this.snapshot;
  }

  status(lane?: string): RunSnapshotDto {
    if (this.fail === "status") throw new Error("injected status failure");
    const snapshot = this.requireSnapshot();
    if (lane === undefined) return snapshot;
    const found = snapshot.lanes.find((item) => item.lane === lane);
    if (!found) throw new Error(`Unknown lane "${lane}"`);
    return { ...snapshot, lanes: [found] };
  }

  async wait(_signal?: AbortSignal): Promise<RunSnapshotDto> {
    if (this.fail === "wait") throw new Error("injected wait failure");
    return new Promise<RunSnapshotDto>(() => {});
  }

  abandon(input: { lane?: string; reason?: string }): RunSnapshotDto {
    if (this.fail === "abandon") throw new Error("injected abandon failure");
    const snapshot = this.requireSnapshot();
    for (const lane of snapshot.lanes) {
      if (input.lane === undefined || input.lane === lane.lane) {
        lane.state = "abandoned";
        lane.abandonReason = input.reason ?? "abandoned";
      }
    }
    return snapshot;
  }

  shutdown(reason: string): Promise<void> {
    if (this.fail === "shutdown") return Promise.reject(new Error("injected shutdown failure"));
    return this.shutdownImpl(reason);
  }

  private requireSnapshot(): RunSnapshotDto {
    if (!this.snapshot) throw new Error("No lane run is available");
    return this.snapshot;
  }
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


/** Poll until the coordinated run has settled, then return lanes_wait results. */
async function collectWhenSettled(
  call: (name: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>,
  timeoutMs = 5_000,
): Promise<ToolResult> {
  let lastStatus = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = await call("lanes_status", {});
    lastStatus = status.content[0]?.text ?? "";
    if (!status.isError && lastStatus.includes("(ended)")) {
      return call("lanes_wait", {});
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`collectWhenSettled timeout: ${lastStatus || "no status"}`);
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
  it("keeps the four public tool names and descriptions frozen", () => {
    const { tools } = makeHarness();
    expect([...tools.keys()]).toEqual(["lanes_spawn", "lanes_status", "lanes_wait", "lanes_abandon"]);
    expect(tools.get("lanes_spawn")!.description).toBe(
      `Spawn independent Pi lanes that run concurrently in the background (non-blocking: this tool returns immediately; lanes survive turn cancellation). Never wait on an active run: finish the parent turn so the user can keep messaging, inspect progress with lanes_status only when needed, and collect results after the run settles with lanes_wait or lanes_status. Stop lanes only with lanes_abandon. You MUST state an explicit model and effort for every lane. Any effort off|minimal|low|medium|high|xhigh is allowed per lane (the value in parentheses is only that model's starting prior). Models: ${MODEL_TABLE.map((row) => `${row.selector} (prior ${row.prior})`).join(", ")}.`,
    );
    expect(tools.get("lanes_status")!.description).toBe(
      "Report live status of the current lane run without blocking: per-lane state, current activity, tokens, cost, and (for settled lanes) answers. Pass `lane` for a detailed view of one lane — use this when the user asks about a specific lane. Do not call in a polling loop.",
    );
    expect(tools.get("lanes_wait")!.description).toBe(
      "Return final results only after the current lane run has settled. This tool never blocks an active parent session: while lanes are running it returns immediately so the model can finish the turn and the user can keep messaging.",
    );
    expect(tools.get("lanes_abandon")!.description).toBe(
      "Explicitly stop lanes of the current run. Pass `lane` to stop one lane, omit it to stop all. This is the only way to stop lanes — they are not cancelled by ESC or turn cancellation.",
    );
  });

  it("lanes_spawn returns immediately while lanes keep running", async () => {
    await installSlowPi(300);
    const { call } = makeHarness();
    const started = Date.now();
    const result = await call("lanes_spawn", { lanes: [spec] });
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.isError).toBeFalsy();
    const run = (result.details as { run: string }).run;
    expect(result.content[0]!.text).toBe(
      [
        `Run ${run} spawned with 1 lane (non-blocking):`,
        "  worker: openai-codex/gpt-5.6-sol:medium",
        "Lanes run in the background and survive turn cancellation.",
        "Finish the parent turn now so the user can keep messaging while lanes run.",
        "Use lanes_status only when progress is needed; collect results after completion with lanes_wait or lanes_status; use lanes_abandon to stop lanes.",
      ].join("\n"),
    );
    expect(readRun(run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_created", origin: "pi" }),
        expect.objectContaining({ type: "lane_created", spec: expect.objectContaining({ mode: "workspace-write" }) }),
      ]),
    );

    const status = await call("lanes_status", {});
    expect(status.content[0]!.text).toMatch(/worker: (queued|running)/);

    const final = await collectWhenSettled(call);
    expect(final.isError).toBeFalsy();
    expect(final.content[0]!.text).toContain("worker: done");
    expect(final.content[0]!.text).toContain("Hello from lane.");
  });

  it("renders live whole-run and per-lane durations in the widget and status summary", async () => {
    const coordinator = new FaultCoordinator();
    const widgets: string[][] = [];
    const ui = {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_id: string, lines?: string[]) => { if (lines) widgets.push(lines); },
      setStatus: () => {},
    } as unknown as ExtensionContext["ui"];
    const { call, handlers } = makeHarness({ hasUI: true, ui, createCoordinator: () => coordinator });

    await call("lanes_spawn", { lanes: [spec] });
    const rendered = widgets.at(-1)!.join("\n");
    expect(rendered).toContain("1m05s");
    expect(rendered).toContain("5s");

    const status = await call("lanes_status", {});
    expect(status.content[0]!.text).toContain("(active) · 1m05s");
    expect(status.content[0]!.text).toContain("$0.0000 · 5s");
    await handlers.get("session_shutdown")!();
  });

  it("lanes_status with a lane filter returns the detailed single-lane view", async () => {
    await installSlowPi(10);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });
    await collectWhenSettled(call);

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

    await collectWhenSettled(call);
    const third = await call("lanes_spawn", { lanes: [{ ...spec, lane: "again" }] });
    expect(third.isError).toBeFalsy();
    await collectWhenSettled(call);
  });

  it("lanes_wait never blocks the parent session while lanes are active", async () => {
    await installSlowPi(400);
    const { call } = makeHarness();
    await call("lanes_spawn", { lanes: [spec] });

    const started = Date.now();
    const active = await call("lanes_wait", {});
    expect(Date.now() - started).toBeLessThan(250);
    expect(active.content[0]!.text).toContain("keeps running in the background");

    const final = await collectWhenSettled(call);
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
    const final = await collectWhenSettled(call);
    expect(final.isError).toBe(true);
    expect(final.content[0]!.text).toContain("test stop");
  });

  it("does not start a parent turn when a background run settles", async () => {
    await installSlowPi(50);
    const { call, sent } = makeHarness({ idle: true });
    await call("lanes_spawn", { lanes: [spec] });
    await collectWhenSettled(call);
    expect(sent).toEqual([]);
  });
});

describe("failure containment", () => {
  it.each(["spawn", "status", "abandon"] as const)(
    "returns a concise isError tool result when coordinator %s throws",
    async (operation) => {
      const coordinator = new FaultCoordinator();
      coordinator.fail = operation;
      const { call } = makeHarness({ createCoordinator: () => coordinator });
      if (operation !== "spawn") {
        coordinator.fail = undefined;
        await call("lanes_spawn", { lanes: [spec] });
        coordinator.fail = operation;
      }

      const params = operation === "abandon" ? { lane: "worker" } : operation === "spawn" ? { lanes: [spec] } : {};
      const result = await call(`lanes_${operation}`, params);

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: `lanes_${operation} failed: injected ${operation} failure` },
      ]);
    },
  );

  it("contains a coordinator status failure while collecting settled results", async () => {
    const coordinator = new FaultCoordinator();
    const { call } = makeHarness({ createCoordinator: () => coordinator });
    await call("lanes_spawn", { lanes: [spec] });
    coordinator.snapshot!.state = "ended";
    await call("lanes_status", {});
    coordinator.fail = "status";

    const result = await call("lanes_wait", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "lanes_wait failed: injected status failure" }]);
  });

  it("contains throwing UI calls across spawn and every command path", async () => {
    const coordinator = new FaultCoordinator();
    const throwingUi = {
      theme: { fg: () => { throw new Error("theme failure"); } },
      setWidget: () => { throw new Error("widget failure"); },
      setStatus: () => { throw new Error("status failure"); },
      notify: () => { throw new Error("notify failure"); },
      custom: async () => { throw new Error("tui failure"); },
    } as unknown as ExtensionContext["ui"];
    const { call, commands, ctx } = makeHarness({
      hasUI: true,
      ui: throwingUi,
      createCoordinator: () => coordinator,
    });

    const spawned = await call("lanes_spawn", { lanes: [spec] });
    expect(spawned.isError).toBeFalsy();
    const command = commands.get("lanes")!;
    for (const args of ["show", "hide", "last", "tui", "abandon worker", "unknown"]) {
      await expect(command(args, ctx)).resolves.toBeUndefined();
    }
  });

  it("contains coordinator failures from commands", async () => {
    const coordinator = new FaultCoordinator();
    const notifications: string[] = [];
    const ui = {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: () => {},
      setStatus: () => {},
      notify: (message: string) => notifications.push(message),
    } as unknown as ExtensionContext["ui"];
    const { call, commands, ctx } = makeHarness({ hasUI: true, ui, createCoordinator: () => coordinator });
    await call("lanes_spawn", { lanes: [spec] });
    coordinator.fail = "abandon";

    await expect(commands.get("lanes")!("abandon worker", ctx)).resolves.toBeUndefined();
    expect(notifications).toContain("lanes command failed: injected abandon failure");
  });
});

describe("session shutdown", () => {
  it("abandons an active run without starting a parent turn on session_shutdown", async () => {
    await installSlowPi(2_000);
    const { call, handlers, sent } = makeHarness({ idle: true });
    await call("lanes_spawn", { lanes: [spec] });

    await handlers.get("session_shutdown")!();

    const status = await call("lanes_status", {});
    expect(status.content[0]!.text).toContain("worker: abandoned");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
  });

  it("awaits async coordinator shutdown and contains rejection", async () => {
    const coordinator = new FaultCoordinator();
    const released = Promise.withResolvers<void>();
    coordinator.shutdownImpl = async () => released.promise;
    const { handlers } = makeHarness({ createCoordinator: () => coordinator });

    let completed = false;
    const shutdown = Promise.resolve(handlers.get("session_shutdown")!()).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    released.resolve();
    await expect(shutdown).resolves.toBeUndefined();

    const rejecting = new FaultCoordinator();
    rejecting.fail = "shutdown";
    const rejectedHarness = makeHarness({ createCoordinator: () => rejecting });
    await expect(rejectedHarness.handlers.get("session_shutdown")!()).resolves.toBeUndefined();
  });
});
