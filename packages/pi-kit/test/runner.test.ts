import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LaneEventParser,
  LaneExecutionAdapter,
  NormalizedLaneEvent,
} from "../src/execution-adapter.ts";
import { LaneRunner } from "../src/runner.ts";
import type { ExecutionRoute, KitEvent, LaneSpec } from "../src/schema.ts";
import { estimateCost } from "../src/table.ts";

const streamFixture = fileURLToPath(new URL("./fixtures/lane-stream.jsonl", import.meta.url));
const normalizedFixture = fileURLToPath(new URL("./fixtures/normalized-lane-stream.jsonl", import.meta.url));
const originalDataDir = process.env.PIKIT_DATA_DIR;
let dataDir: string;

const validSpec: LaneSpec = {
  lane: "worker",
  task: "Run the fixture task",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
};

async function executable(name: string, source: string): Promise<string> {
  const path = join(dataDir, name);
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} remained alive`);
}

async function waitForGroupDead(processGroup: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(-processGroup, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`Process group ${processGroup} remained alive`);
}

function normalizedAdapter(
  route: ExecutionRoute,
  binary: string,
  onEvent?: (event: NormalizedLaneEvent) => void,
  onEnd?: () => NormalizedLaneEvent[],
): LaneExecutionAdapter {
  return {
    route,
    preflight() {},
    build(spec) {
      return {
        command: binary,
        args: [],
        cwd: spec.cwd ?? process.cwd(),
        env: { ...process.env, PIKIT_CHILD: "1" },
      };
    },
    createParser() {
      let ended = false;
      return {
        feedLine(line): NormalizedLaneEvent[] {
          if (!line.trim()) return [];
          const event = JSON.parse(line) as NormalizedLaneEvent;
          onEvent?.(event);
          return [event];
        },
        end(): NormalizedLaneEvent[] {
          if (ended) throw new Error("parser.end called more than once");
          ended = true;
          return onEnd?.() ?? [];
        },
      } satisfies LaneEventParser;
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-kit-runner-"));
  process.env.PIKIT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PIKIT_DATA_DIR;
  else process.env.PIKIT_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("LaneRunner", () => {
  it("preserves the piBinary override while writing a canonical normalized transcript", async () => {
    const piBinary = await executable(
      "fixture-pi",
      `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nconst lines = readFileSync(${JSON.stringify(streamFixture)}, "utf8").trimEnd().split("\\n");\n(async () => { for (const line of lines) { console.log(line); await new Promise((resolve) => setTimeout(resolve, 10)); } })();\n`,
    );
    const events: KitEvent[] = [];
    const rawDir = join(dataDir, "raw");
    const runner = new LaneRunner({
      runId: "run-success",
      append: (event) => events.push(event),
      piBinary,
      rawDir,
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["lane_start", "lane_tool", "lane_usage", "lane_end"]),
    );
    expect(events.find((event) => event.type === "lane_created")).toMatchObject({
      spec: { mode: "workspace-write" },
    });
    expect(events.find((event) => event.type === "lane_tool")).toMatchObject({
      tool: "bash",
      summary: "printf 'fixture tool output'",
    });
    expect(events.find((event) => event.type === "lane_usage")).toMatchObject({
      input: 1200,
      output: 300,
      cacheRead: 40,
      context: 1550,
      cost: estimateCost(validSpec.model, 1200, 300),
    });
    expect(lane).toMatchObject({
      state: "done",
      tokensIn: 1200,
      tokensOut: 300,
      context: 1550,
      cost: estimateCost(validSpec.model, 1200, 300),
      answer: "Hello from lane.",
    });
    const transcript = (await readFile(join(rawDir, "worker.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript[0]).toEqual({ v: 1, type: "task", text: validSpec.task });
    expect(transcript.at(-1)).toEqual({ v: 1, type: "assistant_end", text: "Hello from lane." });
    expect(transcript.some((event) => event.type === "session")).toBe(false);
  });

  it("resolves the execution adapter from model-table route metadata", async () => {
    const binary = await executable(
      "normalized-claude",
      `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nprocess.stdout.write(readFileSync(${JSON.stringify(normalizedFixture)}));\n`,
    );
    const events: KitEvent[] = [];
    const spec: LaneSpec = {
      lane: "claude-worker",
      task: "Run the normalized fixture task",
      model: "anthropic/claude-fable-5",
      effort: "high",
      mode: "read-only",
    };
    const runner = new LaneRunner({
      runId: "run-route",
      append: (event) => events.push(event),
      adapters: [normalizedAdapter("claude-code", binary)],
    });

    const [lane] = await runner.dispatch([spec]);

    expect(lane).toMatchObject({
      state: "done",
      answer: "Normalized answer.",
      tokensIn: 120,
      tokensOut: 40,
      context: 230,
    });
    expect(events.find((event) => event.type === "lane_tool")).toMatchObject({ tool: "read", summary: "README.md" });
  });

  it("rejects traversal and separator lane ids before spawning or resolving transcripts", async () => {
    const marker = join(dataDir, "spawned");
    const binary = await executable("unsafe-lane", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const rawDir = join(dataDir, "raw");
    const runner = new LaneRunner({
      runId: "unsafe-lane",
      append() {},
      rawDir,
      adapters: [normalizedAdapter("pi", binary)],
    });

    await expect(
      runner.dispatch([
        { ...validSpec, lane: "../escape" },
        { ...validSpec, lane: "nested/lane" },
        { ...validSpec, lane: "nested\\lane" },
      ]),
    ).rejects.toThrow("lane id");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dataDir, "escape.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records preparation failures without spawning the provider process", async () => {
    const marker = join(dataDir, "provider-spawned");
    const binary = await executable("must-not-run", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const events: KitEvent[] = [];
    const adapter: LaneExecutionAdapter = {
      route: "pi",
      preflight() {},
      async prepare() {
        await Promise.resolve();
        throw new Error("version check failed");
      },
      build(spec) {
        return { command: binary, args: [], cwd: spec.cwd ?? process.cwd(), env: process.env };
      },
      createParser() {
        return { feedLine: () => [], end: () => [] };
      },
    };
    const runner = new LaneRunner({
      runId: "preparation-failure",
      append: (event) => events.push(event),
      adapters: [adapter],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({ state: "failed", answer: "version check failed" });
    expect(events.find((event) => event.type === "lane_end")).toMatchObject({
      ok: false,
      stopReason: "prepare:version check failed",
    });
    expect(events.some((event) => event.type === "lane_start")).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports spawn failures even when transcript capture also fails", async () => {
    const rawDir = join(dataDir, "unwritable-raw");
    await mkdir(join(rawDir, `${validSpec.lane}.jsonl`), { recursive: true });
    const missingBinary = join(dataDir, "does-not-exist");
    const runner = new LaneRunner({
      runId: "spawn-failure",
      append() {},
      rawDir,
      adapters: [normalizedAdapter("pi", missingBinary)],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({
      state: "failed",
      answer: expect.stringContaining("ENOENT"),
    });
  });

  it("keeps exact-one routing for every managed provider family", async () => {
    const binary = await executable(
      "route-fixture",
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({v:1,type:"assistant_end",text:"routed"}));\n`,
    );
    const seen = { pi: [] as string[], claude: [] as string[] };
    const routedAdapter = (route: ExecutionRoute, models: string[]): LaneExecutionAdapter => ({
      ...normalizedAdapter(route, binary),
      preflight(spec) {
        models.push(`${spec.model}:${spec.effort}`);
      },
    });
    const runner = new LaneRunner({
      runId: "all-routes",
      append() {},
      maxConcurrent: 6,
      adapters: [routedAdapter("pi", seen.pi), routedAdapter("claude-code", seen.claude)],
    });
    const specs: LaneSpec[] = [
      { ...validSpec, lane: "sol" },
      { ...validSpec, lane: "grok", model: "xai/grok-4.5", effort: "high" },
      { ...validSpec, lane: "glm", model: "ollama/glm-5.2:cloud" },
      { ...validSpec, lane: "fable", model: "anthropic/claude-fable-5", effort: "high" },
      { ...validSpec, lane: "opus", model: "anthropic/claude-opus-4-8", effort: "xhigh" },
      { ...validSpec, lane: "sonnet", model: "anthropic/claude-sonnet-5" },
    ];

    const lanes = await runner.dispatch(specs);

    expect(lanes.every((lane) => lane.state === "done")).toBe(true);
    expect(seen.pi).toEqual([
      "openai-codex/gpt-5.6-sol:medium",
      "xai/grok-4.5:high",
      "ollama/glm-5.2:cloud:medium",
    ]);
    expect(seen.claude).toEqual([
      "anthropic/claude-fable-5:high",
      "anthropic/claude-opus-4-8:xhigh",
      "anthropic/claude-sonnet-5:medium",
    ]);
  });

  it("rejects zero or multiple matching adapters before spawning", async () => {
    const marker = join(dataDir, "spawned");
    const binary = await executable("must-not-run", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const adapter = normalizedAdapter("pi", binary);

    await expect(
      new LaneRunner({ runId: "none", append() {}, adapters: [] }).dispatch([validSpec]),
    ).rejects.toThrow("exactly one execution adapter");
    await expect(
      new LaneRunner({ runId: "many", append() {}, adapters: [adapter, adapter] }).dispatch([validSpec]),
    ).rejects.toThrow("exactly one execution adapter");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates specs for their origin and normalizes Pi-origin mode", async () => {
    const marker = join(dataDir, "spawned");
    const binary = await executable("origin-fixture", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const events: KitEvent[] = [];
    const runner = new LaneRunner({
      runId: "origin",
      origin: "mcp",
      append: (event) => events.push(event),
      adapters: [normalizedAdapter("pi", binary)],
    });

    await expect(runner.dispatch([validSpec])).rejects.toThrow("mode is required for MCP-origin lanes");
    expect(events).toEqual([]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces cumulative usage snapshots and ignores malformed or duplicate reports", async () => {
    const binary = await executable(
      "usage-fixture",
      `#!/usr/bin/env node\nfor (const event of [
        {v:1,type:"task",text:"Run the fixture task"},
        {v:1,type:"usage",input:70,output:10,cacheRead:20,context:100},
        {v:1,type:"usage",input:70,output:10,cacheRead:20,context:100},
        {v:1,type:"usage",input:"bad",output:999,cacheRead:0,context:999},
        {v:1,type:"usage",input:120,output:40,cacheRead:50,context:230},
        {v:1,type:"assistant_end",text:"done"}
      ]) console.log(JSON.stringify(event));\nsetInterval(() => {}, 1000);\n`,
    );
    const events: KitEvent[] = [];
    const runner = new LaneRunner({
      runId: "usage",
      append: (event) => events.push(event),
      adapters: [normalizedAdapter("pi", binary)],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(events.filter((event) => event.type === "lane_usage")).toHaveLength(2);
    expect(lane).toMatchObject({ tokensIn: 120, tokensOut: 40, context: 230 });
  });

  it("does not settle success until close and flushes parser end once", async () => {
    const binary = await executable(
      "slow-success",
      `#!/usr/bin/env node\nprocess.on("SIGTERM", () => setTimeout(() => process.exit(0), 120));\nconsole.log(JSON.stringify({v:1,type:"task",text:"Run the fixture task"}));\nconsole.log(JSON.stringify({v:1,type:"assistant_end",text:"done"}));\nsetInterval(() => {}, 1000);\n`,
    );
    const assistantSeen = Promise.withResolvers<void>();
    let endCalls = 0;
    const runner = new LaneRunner({
      runId: "slow-success",
      append() {},
      adapters: [
        normalizedAdapter(
          "pi",
          binary,
          (event) => {
            if (event.type === "assistant_end") assistantSeen.resolve();
          },
          () => {
            endCalls++;
            return [];
          },
        ),
      ],
    });

    let settled = false;
    const dispatch = runner.dispatch([validSpec]).finally(() => {
      settled = true;
    });
    await assistantSeen.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await dispatch;
    expect(endCalls).toBe(1);
  });

  it("does not settle failure until close", async () => {
    const binary = await executable(
      "slow-failure",
      "#!/usr/bin/env node\nconsole.error('fixture failed');\nsetTimeout(() => process.exit(7), 120);\n",
    );
    const started = Promise.withResolvers<void>();
    const runner = new LaneRunner({
      runId: "slow-failure",
      append(event) {
        if (event.type === "lane_start") started.resolve();
      },
      adapters: [normalizedAdapter("pi", binary)],
    });

    let settled = false;
    const dispatch = runner.dispatch([validSpec]).finally(() => {
      settled = true;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    const [lane] = await dispatch;
    expect(lane).toMatchObject({ state: "failed", answer: expect.stringContaining("fixture failed") });
  });

  it("does not settle abandonment until close", async () => {
    const binary = await executable(
      "slow-abandon",
      `#!/usr/bin/env node\nprocess.on("SIGTERM", () => setTimeout(() => process.exit(0), 120));\nconsole.log(JSON.stringify({v:1,type:"task",text:"Run the fixture task"}));\nsetInterval(() => {}, 1000);\n`,
    );
    const ready = Promise.withResolvers<void>();
    const runner = new LaneRunner({
      runId: "slow-abandon",
      append() {},
      adapters: [
        normalizedAdapter("pi", binary, (event) => {
          if (event.type === "task") ready.resolve();
        }),
      ],
    });

    let settled = false;
    const dispatch = runner.dispatch([validSpec]).finally(() => {
      settled = true;
    });
    await ready.promise;
    runner.abandon(validSpec.lane, "test stop");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    const [lane] = await dispatch;
    expect(lane).toMatchObject({ state: "abandoned", abandonReason: "test stop" });
  });

  it("does not let a late spawn event overwrite immediate abandonment", async () => {
    const binary = await executable(
      "immediate-abandon",
      "#!/usr/bin/env node\nsetTimeout(() => {}, 2000);\n",
    );
    const events: KitEvent[] = [];
    const runner = new LaneRunner({
      runId: "immediate-abandon",
      append: (event) => events.push(event),
      adapters: [normalizedAdapter("pi", binary)],
    });

    const dispatch = runner.dispatch([validSpec]);
    runner.abandon(validSpec.lane, "immediate stop");
    const [lane] = await dispatch;

    expect(lane).toMatchObject({ state: "abandoned", abandonReason: "immediate stop" });
    const abandonedIndex = events.findIndex((event) => event.type === "lane_abandoned");
    expect(events.slice(abandonedIndex + 1).some((event) => event.type === "lane_start")).toBe(false);
  });

  it("caps an unterminated stdout record and canonical transcript at 4 MiB", async () => {
    const binary = await executable(
      "overflow",
      `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(4 * 1024 * 1024 + 1));\nsetInterval(() => {}, 1000);\n`,
    );
    const rawDir = join(dataDir, "overflow-raw");
    const runner = new LaneRunner({
      runId: "overflow",
      append() {},
      rawDir,
      adapters: [normalizedAdapter("pi", binary)],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({ state: "failed" });
    expect((await stat(join(rawDir, "worker.jsonl"))).size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("caps cumulative stdout bytes across newline-terminated valid, malformed, and ignored records", async () => {
    const binary = await executable(
      "newline-overflow",
      `#!/usr/bin/env node\nconst records = [\n  JSON.stringify({v:1,type:"thinking_delta",delta:"x".repeat(1000)}),\n  "malformed-" + "x".repeat(1000),\n  JSON.stringify({v:1,type:"ignored",text:"x".repeat(1000)}),\n];\nfor (let index = 0; index < 5000; index++) process.stdout.write(records[index % records.length] + "\\n");\nsetInterval(() => {}, 1000);\n`,
    );
    const counts = { valid: 0, malformed: 0, ignored: 0 };
    const adapter: LaneExecutionAdapter = {
      route: "pi",
      preflight() {},
      build(spec) {
        return { command: binary, args: [], cwd: spec.cwd ?? process.cwd(), env: process.env };
      },
      createParser() {
        return {
          feedLine(line) {
            if (line.startsWith("malformed-")) {
              counts.malformed++;
              return [];
            }
            const parsed = JSON.parse(line) as { type?: string };
            if (parsed.type === "ignored") {
              counts.ignored++;
              return [];
            }
            counts.valid++;
            return [parsed as NormalizedLaneEvent];
          },
          end() {
            return [];
          },
        };
      },
    };
    const events: KitEvent[] = [];
    const runner = new LaneRunner({
      runId: "newline-overflow",
      append: (event) => events.push(event),
      adapters: [adapter],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({ state: "failed" });
    expect(events.find((event) => event.type === "lane_end")).toMatchObject({ stopReason: "stdout-overflow" });
    expect(counts.valid).toBeGreaterThan(0);
    expect(counts.malformed).toBeGreaterThan(0);
    expect(counts.ignored).toBeGreaterThan(0);
  });

  it("updates projection and settles after journal appends fail during child callbacks", async () => {
    const binary = await executable(
      "append-failure",
      `#!/usr/bin/env node\nfor (const event of [\n  {v:1,type:"usage",input:12,output:3,cacheRead:1,context:16},\n  {v:1,type:"assistant_end",text:"completed despite journal failure"},\n]) console.log(JSON.stringify(event));\nsetInterval(() => {}, 1000);\n`,
    );
    let laneStarted = false;
    const attempted: KitEvent["type"][] = [];
    const runner = new LaneRunner({
      runId: "append-failure",
      append(event) {
        attempted.push(event.type);
        if (laneStarted) throw new Error("journal unavailable");
        if (event.type === "lane_start") laneStarted = true;
      },
      adapters: [normalizedAdapter("pi", binary)],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({
      state: "done",
      answer: "completed despite journal failure",
      tokensIn: 12,
      tokensOut: 3,
      context: 16,
    });
    expect(attempted).toContain("lane_usage");
    expect(attempted).toContain("lane_end");
  });

  it("fails an error assistant end even when the child exits zero", async () => {
    const binary = await executable("assistant-error", "#!/usr/bin/env node\n");
    const events: KitEvent[] = [];
    const runner = new LaneRunner({
      runId: "assistant-error",
      append: (event) => events.push(event),
      adapters: [
        normalizedAdapter("pi", binary, undefined, () => [
          { v: 1, type: "assistant_end", text: "Claude failed", isError: true },
        ]),
      ],
    });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({ state: "failed", answer: "Claude failed" });
    expect(events.find((event) => event.type === "lane_end")).toMatchObject({
      ok: false,
      stopReason: "assistant-error",
    });
  });

  it("shutdown cannot orphan prior or current process groups across sequential runs", async () => {
    const firstGrandchildFile = join(dataDir, "first-grandchild.pid");
    const secondGrandchildFile = join(dataDir, "second-grandchild.pid");
    const firstBinary = await executable(
      "first-process-tree",
      `#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\nconst child = spawn("sleep", ["30"]);\nwriteFileSync(${JSON.stringify(firstGrandchildFile)}, String(child.pid));\nconsole.log(JSON.stringify({v:1,type:"assistant_end",text:"first done"}));\nsetInterval(() => {}, 1000);\n`,
    );
    const firstEvents: KitEvent[] = [];
    const firstRunner = new LaneRunner({
      runId: "first-process-tree",
      append: (event) => firstEvents.push(event),
      adapters: [normalizedAdapter("pi", firstBinary)],
    });

    const [firstLane] = await firstRunner.dispatch([validSpec]);
    const firstProcessGroup = (firstEvents.find((event) => event.type === "lane_start") as Extract<KitEvent, { type: "lane_start" }>).pid;
    const firstGrandchild = Number((await readFile(firstGrandchildFile, "utf8")).trim());
    expect(firstLane).toMatchObject({ state: "done" });
    await waitForDead(firstGrandchild);
    await waitForGroupDead(firstProcessGroup);

    const secondBinary = await executable(
      "second-process-tree",
      `#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\nconst child = spawn("sleep", ["30"]);\nwriteFileSync(${JSON.stringify(secondGrandchildFile)}, String(child.pid));\nprocess.on("SIGTERM", () => setTimeout(() => process.exit(0), 120));\nsetInterval(() => {}, 1000);\n`,
    );
    const secondEvents: KitEvent[] = [];
    const secondRunner = new LaneRunner({
      runId: "second-process-tree",
      append: (event) => secondEvents.push(event),
      adapters: [normalizedAdapter("pi", secondBinary)],
    });
    const secondDispatch = secondRunner.dispatch([{ ...validSpec, lane: "second" }]);
    await waitForFile(secondGrandchildFile);
    const secondProcessGroup = (secondEvents.find((event) => event.type === "lane_start") as Extract<KitEvent, { type: "lane_start" }>).pid;
    const secondGrandchild = Number((await readFile(secondGrandchildFile, "utf8")).trim());

    let stopped = false;
    const shutdown = secondRunner.shutdown("session ended").then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);

    const [secondLane] = await secondDispatch;
    await shutdown;
    expect(secondLane).toMatchObject({ state: "abandoned", abandonReason: "session ended" });
    await waitForDead(secondGrandchild);
    await waitForGroupDead(secondProcessGroup);
  });

  it("reapAll kills the child process group used by the exit hook", async () => {
    const grandchildPidFile = join(dataDir, "grandchild.pid");
    const binary = await executable(
      "process-tree",
      `#!/usr/bin/env bash\nsleep 30 &\necho $! > ${JSON.stringify(grandchildPidFile)}\nwait\n`,
    );
    const runner = new LaneRunner({
      runId: "process-tree",
      append() {},
      adapters: [normalizedAdapter("pi", binary)],
    });

    const dispatch = runner.dispatch([validSpec]);
    await waitForFile(grandchildPidFile);
    const grandchildPid = Number((await readFile(grandchildPidFile, "utf8")).trim());
    runner.reapAll();
    await dispatch;

    await waitForDead(grandchildPid);
  });

  it("rejects every invalid spec before spawning", async () => {
    const marker = join(dataDir, "spawned");
    const piBinary = await executable("must-not-run-invalid", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const events: KitEvent[] = [];
    const runner = new LaneRunner({ runId: "run-invalid", append: (event) => events.push(event), piBinary });
    const invalid = [
      { ...validSpec, lane: "missing-model", model: "" },
      { ...validSpec, lane: "missing-task", task: "" },
    ] as LaneSpec[];

    await expect(runner.dispatch(invalid)).rejects.toThrow(
      "Invalid lane specs:\nmissing-model: model is required: state the full selector from the model table\nmissing-task: task is required and must be self-contained",
    );
    expect(events).toEqual([]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
