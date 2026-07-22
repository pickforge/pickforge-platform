import { describe, expect, it } from "vitest";
import {
  LaneCoordinator,
  type LaneCoordinatorJournal,
  type LaneRunnerPort,
} from "../src/lane-coordinator.ts";
import type { LaneExecutionAdapter, NormalizedLaneEvent } from "../src/execution-adapter.ts";
import { LaneRunner, type RunnerOptions } from "../src/runner.ts";
import type { KitEvent, LaneProjection, LaneSpec, RunProjection } from "../src/schema.ts";

const solSpec: LaneSpec = {
  lane: "worker",
  task: "Run the fixture task",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
};

class FakeRunner implements LaneRunnerPort {
  readonly dispatched = Promise.withResolvers<void>();
  readonly finished = Promise.withResolvers<LaneProjection[]>();
  readonly abandoned: Array<{ lane?: string; reason: string }> = [];
  readonly view: RunProjection;
  shutdownCalls = 0;
  private dispatchPromise?: Promise<LaneProjection[]>;

  constructor(readonly options: RunnerOptions) {
    this.view = {
      run: options.runId,
      origin: options.origin ?? "pi",
      createdAt: "runner-clock-must-not-leak",
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
    this.dispatched.resolve();
    this.dispatchPromise = this.finished.promise.then((lanes) => {
      this.view.ended = true;
      this.view.ok = lanes.every((lane) => lane.state === "done");
      return lanes;
    });
    return this.dispatchPromise;
  }

  settle(state: LaneProjection["state"] = "done"): void {
    for (const lane of this.view.lanes.values()) lane.state = state;
    this.finished.resolve([...this.view.lanes.values()]);
  }

  fail(error: Error): void {
    this.finished.reject(error);
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
    for (const lane of this.view.lanes.values()) {
      if (lane.state === "queued" || lane.state === "running") {
        lane.state = "abandoned";
        lane.abandonReason = reason;
      }
    }
  }

  async shutdown(reason: string): Promise<void> {
    this.shutdownCalls++;
    this.abandonAll(reason);
    await this.dispatchPromise?.catch(() => {});
  }
}

function captureUnhandledRejections(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const onUnhandledRejection = (error: unknown) => errors.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  return {
    errors,
    stop: () => process.off("unhandledRejection", onUnhandledRejection),
  };
}

function harness(origin: "pi" | "mcp" = "pi") {
  const events: KitEvent[] = [];
  const runners: FakeRunner[] = [];
  const journal: LaneCoordinatorJournal = {
    append: (event) => events.push(event),
    rawDir: (runId) => `/raw/${runId}`,
  };
  let nowMs = Date.parse("2026-07-21T12:00:00.000Z");
  const coordinator = new LaneCoordinator({
    origin,
    journal,
    clock: () => new Date(nowMs),
    newRunId: () => `run-${runners.length + 1}`,
    createRunner: (options) => {
      const runner = new FakeRunner(options);
      runners.push(runner);
      return runner;
    },
  });
  return {
    coordinator,
    events,
    runners,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("LaneCoordinator", () => {
  it("spawns nonblocking, defaults Pi mode, journals through injected seams, and permits only one active run", async () => {
    const { coordinator, events, runners, advance } = harness();

    const first = await coordinator.spawn([solSpec]);

    expect(first).toMatchObject({
      run: "run-1",
      state: "active",
      totals: { cost: 0, tokensIn: 0, tokensOut: 0 },
      lanes: [{ lane: "worker", model: solSpec.model, effort: "medium", mode: "workspace-write", state: "running" }],
    });
    expect(runners[0]?.options).toMatchObject({ runId: "run-1", origin: "pi", rawDir: "/raw/run-1" });
    expect(events[0]).toEqual({
      v: 1,
      t: "2026-07-21T12:00:00.000Z",
      run: "run-1",
      type: "run_created",
      lanes: 1,
      origin: "pi",
    });
    await expect(coordinator.spawn([{ ...solSpec, lane: "second" }])).rejects.toThrow("still active");

    advance(250);
    runners[0]!.settle();
    await coordinator.wait();
    expect(events.at(-1)).toMatchObject({ type: "run_end", ok: true, durationMs: 250 });

    await coordinator.spawn([{ ...solSpec, lane: "second" }]);
    expect(runners).toHaveLength(2);
    runners[1]!.settle();
    await coordinator.wait();
  });

  it("keeps spawn active when the run_created journal append throws", async () => {
    const events: KitEvent[] = [];
    const runners: FakeRunner[] = [];
    const unhandled = captureUnhandledRejections();
    const coordinator = new LaneCoordinator({
      origin: "pi",
      journal: {
        append(event) {
          if (event.type === "run_created") throw new Error("run_created journal unavailable");
          events.push(event);
        },
        rawDir: () => "/raw/run-created-failure",
      },
      newRunId: () => "run-created-failure",
      createRunner: (options) => {
        const runner = new FakeRunner(options);
        runners.push(runner);
        return runner;
      },
    });

    try {
      await expect(coordinator.spawn([solSpec])).resolves.toMatchObject({ state: "active" });
      expect(runners).toHaveLength(1);
      runners[0]!.settle();
      await expect(coordinator.wait()).resolves.toMatchObject({ state: "ended", ok: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled.errors).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "run_end", ok: true });
    } finally {
      unhandled.stop();
    }
  });

  it("keeps settlement successful when the run_end journal append throws", async () => {
    const runners: FakeRunner[] = [];
    const unhandled = captureUnhandledRejections();
    const coordinator = new LaneCoordinator({
      origin: "pi",
      journal: {
        append(event) {
          if (event.type === "run_end") throw new Error("run_end journal unavailable");
        },
        rawDir: () => "/raw/run-end-failure",
      },
      newRunId: () => "run-end-failure",
      createRunner: (options) => {
        const runner = new FakeRunner(options);
        runners.push(runner);
        return runner;
      },
    });

    try {
      await coordinator.spawn([solSpec]);
      runners[0]!.settle();
      await expect(coordinator.wait()).resolves.toMatchObject({ state: "ended", ok: true });
      expect(coordinator.status()).toMatchObject({ state: "ended", ok: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled.errors).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("keeps shutdown successful when its run_end journal append throws", async () => {
    const runners: FakeRunner[] = [];
    const unhandled = captureUnhandledRejections();
    const coordinator = new LaneCoordinator({
      origin: "pi",
      journal: {
        append(event) {
          if (event.type === "run_end") throw new Error("shutdown journal unavailable");
        },
        rawDir: () => "/raw/shutdown-failure",
      },
      newRunId: () => "shutdown-failure",
      createRunner: (options) => {
        const runner = new FakeRunner(options);
        runners.push(runner);
        return runner;
      },
    });

    try {
      await coordinator.spawn([solSpec]);
      const shutdown = coordinator.shutdown("session ended");
      runners[0]!.settle("abandoned");
      await expect(shutdown).resolves.toBeUndefined();
      expect(coordinator.status()).toMatchObject({ state: "ended", ok: false });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled.errors).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("returns while runner preparation is pending and keeps status and wait responsive", async () => {
    const preparation = Promise.withResolvers<void>();
    const events: KitEvent[] = [];
    const adapter: LaneExecutionAdapter = {
      route: "pi",
      preflight() {},
      async prepare() {
        await preparation.promise;
      },
      build(spec) {
        return {
          command: process.execPath,
          args: ["-e", 'console.log(JSON.stringify({v:1,type:"assistant_end",text:"prepared"}))'],
          cwd: spec.cwd ?? process.cwd(),
          env: process.env,
        };
      },
      createParser() {
        return {
          feedLine(line) {
            return [JSON.parse(line) as NormalizedLaneEvent];
          },
          end() {
            return [];
          },
        };
      },
    };
    const coordinator = new LaneCoordinator({
      origin: "pi",
      journal: { append: (event) => events.push(event), rawDir: () => "/unused" },
      newRunId: () => "run-preparing",
      createRunner: (options) => new LaneRunner({
        runId: options.runId,
        append: options.append,
        origin: options.origin,
        adapters: [adapter],
      }),
    });

    const spawned = await Promise.race([
      coordinator.spawn([solSpec]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("spawn blocked on preparation")), 250)),
    ]);

    expect(spawned).toMatchObject({ state: "active", lanes: [{ state: "queued" }] });
    expect(coordinator.status()).toMatchObject({ state: "active", lanes: [{ state: "queued" }] });
    const controller = new AbortController();
    const detachedWait = coordinator.wait(controller.signal);
    controller.abort();
    await expect(detachedWait).resolves.toMatchObject({ state: "active", lanes: [{ state: "queued" }] });
    expect(events.some((event) => event.type === "lane_start")).toBe(false);

    preparation.resolve();
    await expect(coordinator.wait()).resolves.toMatchObject({
      state: "ended",
      ok: true,
      lanes: [{ state: "done", answer: "prepared" }],
    });
    expect(events.some((event) => event.type === "lane_start")).toBe(true);
  });

  it("requires explicit MCP mode and rejects MCP Anthropic lanes through existing policy", async () => {
    const { coordinator, runners } = harness("mcp");

    await expect(coordinator.spawn([solSpec])).rejects.toThrow("mode is required for MCP-origin lanes");
    await expect(
      coordinator.spawn([
        {
          lane: "anthropic",
          task: "Do not run",
          model: "anthropic/claude-fable-5",
          effort: "high",
          mode: "read-only",
        },
      ]),
    ).rejects.toThrow("unavailable from mcp");
    expect(runners).toHaveLength(0);
  });

  it("returns exact whole-run and filtered JSON-safe DTOs without sensitive process or prompt fields", async () => {
    const { coordinator, runners } = harness();
    await coordinator.spawn([
      { ...solSpec, cwd: "/sensitive/worktree", rationale: "private routing reason" },
      { ...solSpec, lane: "other" },
    ]);
    const projection = runners[0]!.view;
    projection.totalCost = Number.POSITIVE_INFINITY;
    projection.totalTokensIn = Number.NaN;
    projection.totalTokensOut = Number.NEGATIVE_INFINITY;
    const worker = projection.lanes.get("worker")!;
    worker.tokensIn = Number.NaN;
    worker.tokensOut = Number.POSITIVE_INFINITY;
    worker.cost = Number.NEGATIVE_INFINITY;
    worker.context = Number.NaN;
    worker.durationMs = Number.POSITIVE_INFINITY;

    const all = coordinator.status();
    const filtered = coordinator.status("worker");

    expect(all.lanes.map((lane) => lane.lane)).toEqual(["worker", "other"]);
    expect(filtered).toEqual({
      run: "run-1",
      state: "active",
      totals: { cost: 0, tokensIn: 0, tokensOut: 0 },
      lanes: [{
        lane: "worker",
        model: solSpec.model,
        effort: "medium",
        mode: "workspace-write",
        state: "running",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
        durationMs: 0,
      }],
    });
    const json = JSON.stringify(filtered);
    expect(json).not.toContain("Run the fixture task");
    expect(json).not.toContain("/sensitive/worktree");
    expect(json).not.toContain("private routing reason");
    for (const field of ["task", "cwd", "rationale", "pid", "origin", "createdAt"]) {
      expect(filtered).not.toHaveProperty(field);
      expect(filtered.lanes[0]).not.toHaveProperty(field);
    }
    expect(JSON.parse(json)).toEqual(filtered);
    await expect(Promise.resolve().then(() => coordinator.status("missing"))).rejects.toThrow('Unknown lane "missing"');

    runners[0]!.settle();
    await coordinator.wait();
  });

  it("waits for settlement but detaches an aborted wait without abandoning lanes", async () => {
    const { coordinator, runners } = harness();
    await coordinator.spawn([solSpec]);
    const controller = new AbortController();

    const detached = coordinator.wait(controller.signal);
    controller.abort();

    await expect(detached).resolves.toMatchObject({ state: "active", lanes: [{ state: "running" }] });
    expect(runners[0]!.abandoned).toEqual([]);

    const settled = coordinator.wait();
    runners[0]!.settle();
    await expect(settled).resolves.toMatchObject({ state: "ended", ok: true, lanes: [{ state: "done" }] });
  });

  it("abandons a named lane or the whole run and rejects operations without a run", async () => {
    const empty = harness().coordinator;
    expect(() => empty.status()).toThrow("No lane run");
    await expect(empty.wait()).rejects.toThrow("No lane run");
    expect(() => empty.abandon({})).toThrow("No lane run");

    const { coordinator, runners } = harness();
    await coordinator.spawn([solSpec, { ...solSpec, lane: "other" }]);

    expect(coordinator.abandon({ lane: "worker", reason: "named stop" })).toMatchObject({
      lanes: [{ lane: "worker", state: "abandoned" }, { lane: "other", state: "running" }],
    });
    expect(() => coordinator.abandon({ lane: "missing" })).toThrow('Unknown lane "missing"');
    expect(coordinator.abandon({ reason: "all stop" }).lanes).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "abandoned", abandonReason: expect.any(String) })]),
    );
    expect(runners[0]!.abandoned).toEqual([
      { lane: "worker", reason: "named stop" },
      { reason: "all stop" },
    ]);

    runners[0]!.settle("abandoned");
    await coordinator.wait();
  });

  it("settles and journals a failed run when dispatch rejects", async () => {
    const { coordinator, events, runners } = harness();
    await coordinator.spawn([solSpec]);

    runners[0]!.fail(new Error("child setup failed"));

    await expect(coordinator.wait()).resolves.toMatchObject({ state: "ended", ok: false });
    expect(runners[0]!.shutdownCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "run_end", ok: false });
  });

  it("shutdown abandons and awaits the active runner close", async () => {
    const { coordinator, runners } = harness();
    await coordinator.spawn([solSpec]);

    let stopped = false;
    const shutdown = coordinator.shutdown("session ended").then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(runners[0]!.shutdownCalls).toBe(1);
    expect(runners[0]!.abandoned).toEqual([{ reason: "session ended" }]);

    runners[0]!.settle("abandoned");
    await shutdown;
    expect(stopped).toBe(true);
    expect(coordinator.status()).toMatchObject({ state: "ended", ok: false });
  });
});
