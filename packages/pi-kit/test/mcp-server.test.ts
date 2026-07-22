import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaneMcpServer,
  type LaneMcpCoordinator,
} from "../mcp/create-server.ts";
import {
  LaneCoordinator,
  type LaneCoordinatorJournal,
  type LaneRunnerPort,
  type RunSnapshotDto,
} from "../src/lane-coordinator.ts";
import type { RunnerOptions } from "../src/runner.ts";
import type { LaneProjection, LaneSpec, RunProjection } from "../src/schema.ts";

const solSpec: LaneSpec = {
  lane: "worker",
  task: "Run the fixture task",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
  mode: "read-only",
};

class ProtocolRunner implements LaneRunnerPort {
  readonly finished = Promise.withResolvers<LaneProjection[]>();
  readonly view: RunProjection;
  readonly abandoned: Array<{ lane?: string; reason: string }> = [];

  constructor(options: RunnerOptions) {
    this.view = {
      run: options.runId,
      origin: options.origin ?? "mcp",
      createdAt: "runner timestamp",
      ended: false,
      lanes: new Map(),
      totalCost: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };
  }

  projection(): RunProjection {
    return this.view;
  }

  dispatch(specs: LaneSpec[]): Promise<LaneProjection[]> {
    for (const spec of specs) {
      this.view.lanes.set(spec.lane, {
        spec,
        state: "running",
        pid: 123,
        tokensIn: 10,
        tokensOut: 2,
        cost: 0.25,
        context: 12,
      });
    }
    return this.finished.promise;
  }

  abandon(lane: string, reason: string): void {
    this.abandoned.push({ lane, reason });
    const projection = this.view.lanes.get(lane);
    if (projection) {
      projection.state = "abandoned";
      projection.abandonReason = reason;
    }
  }

  abandonAll(reason: string): void {
    this.abandoned.push({ reason });
    for (const projection of this.view.lanes.values()) {
      projection.state = "abandoned";
      projection.abandonReason = reason;
    }
  }

  shutdown(reason: string): Promise<void> {
    this.abandonAll(reason);
    return this.finished.promise.then(() => undefined);
  }

  settle(state: LaneProjection["state"] = "done"): void {
    for (const projection of this.view.lanes.values()) projection.state = state;
    this.view.ended = true;
    this.finished.resolve([...this.view.lanes.values()]);
  }
}

function realCoordinatorHarness() {
  const runners: ProtocolRunner[] = [];
  const journal: LaneCoordinatorJournal = { append() {}, rawDir: (run) => `/raw/${run}` };
  const coordinator = new LaneCoordinator({
    origin: "mcp",
    journal,
    newRunId: () => "run-mcp",
    clock: () => new Date("2026-07-21T12:00:00.000Z"),
    createRunner(options) {
      const runner = new ProtocolRunner(options);
      runners.push(runner);
      return runner;
    },
  });
  return { coordinator, runners };
}

const connected: Array<{ client: Client; server: ReturnType<typeof createLaneMcpServer>["server"] }> = [];

async function protocolHarness(coordinator: LaneMcpCoordinator) {
  const created = createLaneMcpServer({ coordinator });
  const client = new Client({ name: "pi-kit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server: created.server });
  return { ...created, client };
}

function textOf(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) return "";
  const first: unknown = result.content[0];
  return typeof first === "object" && first !== null && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string"
    ? first.text
    : "";
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function waitForFile(path: string): Promise<void> {
  await waitUntil(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }, `Timed out waiting for ${path}`, 5_000);
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(connected.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

describe("lane MCP protocol", () => {
  it("registers only the four lane tools and returns text-only no-run errors", async () => {
    const { coordinator } = realCoordinatorHarness();
    const { client } = await protocolHarness(coordinator);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "lanes_spawn",
      "lanes_status",
      "lanes_wait",
      "lanes_abandon",
    ]);

    for (const [name, args] of [
      ["lanes_status", {}],
      ["lanes_wait", {}],
      ["lanes_abandon", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain("No lane run");
      expect("structuredContent" in result).toBe(false);
    }
  });

  it("spawns nonblocking, rejects Anthropic and duplicate runs, filters status, and abandons", async () => {
    const { coordinator, runners } = realCoordinatorHarness();
    const { client } = await protocolHarness(coordinator);

    const anthropic = await client.callTool({
      name: "lanes_spawn",
      arguments: {
        lanes: [{ ...solSpec, lane: "claude", model: "anthropic/claude-fable-5", effort: "high" }],
      },
    });
    expect(anthropic).toMatchObject({ isError: true });
    expect(textOf(anthropic)).toContain("native Claude workflow");
    expect(runners).toHaveLength(0);

    const spawned = await client.callTool({
      name: "lanes_spawn",
      arguments: {
        lanes: [
          { ...solSpec, cwd: "/sensitive/worktree", rationale: "private routing reason" },
          { ...solSpec, lane: "other" },
        ],
      },
    });
    expect(spawned.isError).not.toBe(true);
    expect(textOf(spawned)).toContain("run-mcp");
    expect(spawned.structuredContent).toMatchObject({
      run: "run-mcp",
      state: "active",
      totals: { cost: 0, tokensIn: 0, tokensOut: 0 },
      lanes: [
        { lane: "worker", model: solSpec.model, effort: "medium", mode: "read-only", state: "running" },
        { lane: "other", model: solSpec.model, effort: "medium", mode: "read-only", state: "running" },
      ],
    });
    const spawnedJson = JSON.stringify(spawned.structuredContent);
    expect(spawnedJson).not.toContain("Run the fixture task");
    expect(spawnedJson).not.toContain("/sensitive/worktree");
    expect(spawnedJson).not.toContain("private routing reason");
    for (const field of ["task", "cwd", "rationale", "pid", "origin", "createdAt"]) {
      expect(spawned.structuredContent).not.toHaveProperty(field);
      expect((spawned.structuredContent as { lanes: unknown[] }).lanes[0]).not.toHaveProperty(field);
    }

    const duplicate = await client.callTool({ name: "lanes_spawn", arguments: { lanes: [solSpec] } });
    expect(duplicate).toMatchObject({ isError: true });
    expect(textOf(duplicate)).toContain("still active");
    expect("structuredContent" in duplicate).toBe(false);

    const filtered = await client.callTool({ name: "lanes_status", arguments: { lane: "worker" } });
    expect(filtered.structuredContent).toMatchObject({ lanes: [{ lane: "worker", state: "running" }] });
    expect((filtered.structuredContent as { lanes: unknown[] }).lanes).toHaveLength(1);

    const abandoned = await client.callTool({
      name: "lanes_abandon",
      arguments: { lane: "worker", reason: "protocol stop" },
    });
    expect((abandoned.structuredContent as { lanes: unknown[] }).lanes[0]).toMatchObject({
      lane: "worker",
      state: "abandoned",
      abandonReason: "protocol stop",
    });
    expect(runners[0]!.abandoned).toEqual([{ lane: "worker", reason: "protocol stop" }]);

    runners[0]!.settle("abandoned");
    await coordinator.wait();
  });

  it("passes the request signal to wait so cancellation detaches without abandonment", async () => {
    let waitSignal: AbortSignal | undefined;
    let abandonCalls = 0;
    const snapshot = finiteSnapshot();
    const coordinator: LaneMcpCoordinator = {
      async spawn() { return snapshot; },
      status() { return snapshot; },
      wait(signal) {
        waitSignal = signal;
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(snapshot), { once: true }));
      },
      abandon() { abandonCalls++; return snapshot; },
      async shutdown() {},
    };
    const { client } = await protocolHarness(coordinator);
    const controller = new AbortController();

    const waiting = client.callTool({ name: "lanes_wait", arguments: {} }, undefined, { signal: controller.signal });
    await waitUntil(() => waitSignal !== undefined, "wait handler did not receive a signal");
    controller.abort();

    await expect(waiting).rejects.toThrow();
    await waitUntil(() => waitSignal?.aborted === true, "wait handler signal was not aborted");
    expect(abandonCalls).toBe(0);
    expect((await client.callTool({ name: "lanes_status", arguments: {} })).structuredContent).toMatchObject({ state: "active" });
  });

  it("converts every coordinator handler exception to a bounded text-only tool error", async () => {
    const coordinator: LaneMcpCoordinator = {
      async spawn() { throw new Error("spawn boom"); },
      status() { throw new Error("status boom"); },
      async wait() { throw new Error("wait boom"); },
      abandon() { throw new Error("abandon boom"); },
      async shutdown() {},
    };
    const { client } = await protocolHarness(coordinator);
    const calls = [
      ["lanes_spawn", { lanes: [solSpec] }, "spawn boom"],
      ["lanes_status", {}, "status boom"],
      ["lanes_wait", {}, "wait boom"],
      ["lanes_abandon", {}, "abandon boom"],
    ] as const;

    for (const [name, args, message] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toContain(message);
      expect(textOf(result).length).toBeLessThanOrEqual(280);
      expect("structuredContent" in result).toBe(false);
    }
  });

  it("normalizes every non-finite numeric DTO field before schema validation", async () => {
    const snapshot = finiteSnapshot();
    snapshot.totals.cost = Number.POSITIVE_INFINITY;
    snapshot.totals.tokensIn = Number.NaN;
    snapshot.totals.tokensOut = Number.NEGATIVE_INFINITY;
    Object.assign(snapshot.lanes[0]!, {
      tokensIn: Number.NaN,
      tokensOut: Number.POSITIVE_INFINITY,
      cost: Number.NEGATIVE_INFINITY,
      context: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
    });
    const coordinator: LaneMcpCoordinator = {
      async spawn() { return snapshot; },
      status() { return snapshot; },
      async wait() { return snapshot; },
      abandon() { return snapshot; },
      async shutdown() {},
    };
    const { client } = await protocolHarness(coordinator);

    const result = await client.callTool({ name: "lanes_status", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      totals: { cost: 0, tokensIn: 0, tokensOut: 0 },
      lanes: [{ tokensIn: 0, tokensOut: 0, cost: 0, context: 0, durationMs: 0 }],
    });
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toEqual(result.structuredContent);
  });
});

function finiteSnapshot(): RunSnapshotDto {
  return {
    run: "run-test",
    state: "active",
    totals: { cost: 0.25, tokensIn: 10, tokensOut: 2 },
    lanes: [{
      lane: solSpec.lane,
      model: solSpec.model,
      effort: solSpec.effort,
      mode: "read-only",
      state: "running",
      tokensIn: 10,
      tokensOut: 2,
      cost: 0.25,
      context: 12,
      durationMs: 50,
    }],
  };
}

describe("lane MCP stdio process", () => {
  it("treats EOF as shutdown, exits cleanly, and leaves no lane process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-kit-mcp-process-"));
    const binDir = join(root, "bin");
    const piBinary = join(binDir, "pi");
    const processGroupFile = join(root, "lane-process-group.pid");
    const grandchildFile = join(root, "lane-grandchild.pid");
    const fixture = fileURLToPath(new URL("./fixtures/mcp-lane-process.cjs", import.meta.url));
    const serverPath = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
    await mkdir(binDir);
    await writeFile(
      piBinary,
      `#!/usr/bin/env node\nprocess.env.MCP_FIXTURE_PROCESS_GROUP_FILE = ${JSON.stringify(processGroupFile)};\nprocess.env.MCP_FIXTURE_GRANDCHILD_FILE = ${JSON.stringify(grandchildFile)};\nrequire(${JSON.stringify(fixture)});\n`,
    );
    await chmod(piBinary, 0o755);

    const child = spawn("bun", [serverPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PIKIT_DATA_DIR: join(root, "data"),
        MCP_FIXTURE_PROCESS_GROUP_FILE: processGroupFile,
        MCP_FIXTURE_GRANDCHILD_FILE: grandchildFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let processGroup: number | undefined;
    let grandchild: number | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "process-test", version: "1.0.0" },
        },
      })}\n`);
      await waitUntil(
        () => stdout.split("\n").some((line) => line.includes('"id":1')),
        "MCP initialize did not complete",
        5_000,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lanes_spawn", arguments: { lanes: [solSpec] } },
      })}\n`);
      await waitForFile(processGroupFile);
      await waitForFile(grandchildFile);
      const spawnedProcessGroup = Number((await readFile(processGroupFile, "utf8")).trim());
      const spawnedGrandchild = Number((await readFile(grandchildFile, "utf8")).trim());
      processGroup = spawnedProcessGroup;
      grandchild = spawnedGrandchild;

      child.stdin.end();
      expect(await waitForProcessExit(child, 4_000)).toBe(0);
      await waitUntil(() => {
        try { process.kill(-spawnedProcessGroup, 0); return false; } catch { return true; }
      }, `Process group ${spawnedProcessGroup} remained alive`, 4_000);
      await waitUntil(() => {
        try { process.kill(spawnedGrandchild, 0); return false; } catch { return true; }
      }, `Grandchild ${spawnedGrandchild} remained alive`, 4_000);
      expect(stderr).toBe("");
      expect(stdout.trim().split("\n").every((line) => {
        try { JSON.parse(line); return true; } catch { return false; }
      })).toBe(true);
    } finally {
      if (processGroup !== undefined) {
        try { process.kill(-processGroup, "SIGKILL"); } catch {}
      }
      if (child.exitCode === null) child.kill("SIGKILL");
      await waitForProcessExit(child, 1_000).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
