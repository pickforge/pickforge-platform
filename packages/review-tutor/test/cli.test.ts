import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdleTracker,
  parseArguments,
  runCli,
  USAGE,
  type CliDeps,
  type DetachedChild,
} from "../src/cli.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { ExecFile } from "../src/inputs.ts";
import type { StartedReviewTutorServer } from "../src/server.ts";

const URL_LINE = "http://127.0.0.1:4321/?session=token";
const absentExecFile = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };

class FakeChild extends EventEmitter implements DetachedChild {
  stdout = new PassThrough();
  unref = vi.fn();
  kill = vi.fn(() => true);
}

function fakeServer(
  close = vi.fn(async () => {}),
  clientCount = () => 0,
  connectionGeneration = () => 0,
): StartedReviewTutorServer {
  return { url: URL_LINE, token: "token", port: 4321, close, clientCount, connectionGeneration };
}

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  close: ReturnType<typeof vi.fn>;
  started: Array<Record<string, unknown>>;
  children: FakeChild[];
  signal(): void;
}

function harness(overrides: Partial<CliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const close = vi.fn(async () => {});
  const started: Array<Record<string, unknown>> = [];
  const children: FakeChild[] = [];
  const handlers: Array<() => void> = [];
  const execFile: ExecFile = async () => ({ stdout: `${process.cwd()}\n`, stderr: "" });
  const deps: CliDeps = {
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    cwd: () => process.cwd(),
    execFile,
    createRegistry: () => createConnectorRegistry({
      piModels: [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }],
      which: async () => undefined,
      execFile: absentExecFile,
    }),
    startServer: async (options) => {
      started.push(options as unknown as Record<string, unknown>);
      return fakeServer(close);
    },
    openInBrowser: vi.fn(async () => true),
    signals: (handler) => { handlers.push(handler); },
    spawnDetached: vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }),
    ...overrides,
  };
  return {
    deps,
    out,
    err,
    close,
    started,
    children,
    signal: () => { for (const handler of handlers.splice(0)) handler(); },
  };
}

/** Yields to the real event loop under both timer modes so pending file-system work can land. */
async function settle(check: () => boolean = () => true): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // node:timers keeps the real setImmediate even while the global one is faked,
    // so file-system callbacks (realpath, spawn) can land before the next check.
    await new Promise((resolve) => yieldToEventLoop(resolve));
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    if (check()) return;
  }
  throw new Error("test barrier failed: expected condition within 200 attempts");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("command line parsing", () => {
  it("defaults to the worktree source", () => {
    expect(parseArguments([])).toMatchObject({
      source: { protocol: "rt/1", kind: "worktree" },
      open: true,
      detach: false,
      serveDetached: false,
    });
  });

  it.each([
    [["staged"], { source: { protocol: "rt/1", kind: "staged" } }],
    [["abc123"], { source: { protocol: "rt/1", kind: "commit", revision: "abc123" } }],
    [["main...topic"], { source: { protocol: "rt/1", kind: "range", from: "main", to: "topic" } }],
    [["--no-open"], { open: false }],
    [["--detach"], { detach: true }],
    [["--serve-detached"], { serveDetached: true }],
    [["--home", "/tmp/state"], { home: "/tmp/state" }],
    [["--detach", "--no-open", "staged"], { detach: true, open: false }],
  ])("parses %j", (argv, expected) => {
    expect(parseArguments(argv)).toMatchObject(expected);
  });

  it.each([["--nope"], ["--home"], ["--home", "--detach"], ["one", "two"]])(
    "rejects %j",
    (...argv) => {
      expect(() => parseArguments(argv)).toThrow();
    },
  );

  it.each([["$(id)"], ["a b"], ["x;y"], ["`ls`"], ["'q'"]])("refuses the source %j before it reaches Git or a shell", (source) => {
    expect(() => parseArguments([source])).toThrow(/source may only contain/);
  });

  it.each([["worktree"], ["staged"], ["main...HEAD"], ["abc123"], ["https://github.com/pickforge/pickforge-platform/pull/83"], ["v0.12.0~1^2"]])(
    "accepts the source %s",
    (source) => {
      expect(parseArguments([source]).source).toBeDefined();
    },
  );

  it("reports usage on stderr and exits 2 for an unknown flag", async () => {
    const { deps, out, err } = harness();
    await expect(runCli(["--nope"], deps)).resolves.toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain(USAGE);
  });

  it("prints usage on stdout for --help", async () => {
    const { deps, out, err } = harness();
    await expect(runCli(["--help"], deps)).resolves.toBe(0);
    expect(out.join("")).toBe(`${USAGE}\n`);
    expect(err).toEqual([]);
  });
});

describe("foreground run", () => {
  it("prints one URL line, summarises discovery, and closes on a signal", async () => {
    const context = harness();
    const run = runCli([], context.deps);
    await settle(() => context.out.length > 0);
    expect(context.out).toEqual([`${URL_LINE}\n`]);
    expect(context.err.join("")).toBe(
      "Pi: 1 model\nClaude Code unavailable: Claude Code is not installed (claude not found on PATH).\nCodex unavailable: Codex is not installed (codex not found on PATH).\n",
    );
    expect(context.deps.openInBrowser).toHaveBeenCalledWith(URL_LINE);
    expect(context.started[0]).toMatchObject({ initialSource: { kind: "worktree" } });
    expect(context.close).not.toHaveBeenCalled();

    context.signal();
    await expect(run).resolves.toBe(0);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.out).toEqual([`${URL_LINE}\n`]);
  });

  it("keeps the browser closed with --no-open and forwards --home", async () => {
    const context = harness();
    const run = runCli(["--no-open", "--home", "/tmp/review-tutor-cli"], context.deps);
    await settle(() => context.out.length > 0);
    expect(context.deps.openInBrowser).not.toHaveBeenCalled();
    expect(context.started[0]).toMatchObject({ home: "/tmp/review-tutor-cli" });
    context.signal();
    await expect(run).resolves.toBe(0);
  });

  it("explains a browser that will not open", async () => {
    const context = harness({ openInBrowser: vi.fn(async () => false) });
    const run = runCli([], context.deps);
    await settle(() => context.err.join("").includes("Could not open"));
    expect(context.err.join("")).toContain("Could not open a browser.");
    context.signal();
    await expect(run).resolves.toBe(0);
  });

  it("shuts down once for a signal that arrives while the browser is still opening", async () => {
    let openBrowser!: (opened: boolean) => void;
    const context = harness({
      openInBrowser: vi.fn(() => new Promise<boolean>((resolve) => { openBrowser = resolve; })),
    });
    const run = runCli([], context.deps);
    await settle(() => openBrowser !== undefined);

    context.signal();
    await settle();
    expect(context.close).not.toHaveBeenCalled();

    openBrowser(true);
    await expect(run).resolves.toBe(0);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the repository cannot be resolved", async () => {
    const context = harness({
      execFile: async () => { throw Object.assign(new Error("not a repository"), { code: 128 }); },
    });
    await expect(runCli([], context.deps)).resolves.toBe(1);
    expect(context.err.join("")).toContain("repository resolution failed");
    expect(context.out).toEqual([]);
  });
});

describe("detached handshake", () => {
  it("prints the child's URL, unrefs it, and returns immediately", async () => {
    const context = harness();
    const run = runCli(["--detach"], context.deps);
    await settle(() => context.children.length > 0);
    const child = context.children[0]!;
    expect(context.deps.spawnDetached).toHaveBeenCalledWith(["--serve-detached", "--detach"]);
    child.stdout.write(`${URL_LINE}\n`);
    await expect(run).resolves.toBe(0);
    expect(context.out).toEqual([`${URL_LINE}\n`]);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(context.deps.openInBrowser).toHaveBeenCalledWith(URL_LINE);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("fails plainly when the child never reports a URL", async () => {
    vi.useFakeTimers();
    const context = harness();
    const run = runCli(["--detach"], context.deps);
    await settle(() => context.children.length > 0);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(run).resolves.toBe(1);
    const child = context.children[0]!;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(context.err.join("")).toContain("expected a URL within 30 seconds");
    expect(context.out).toEqual([]);
  });

  it("fails when the child exits before reporting a URL", async () => {
    const context = harness();
    const run = runCli(["--detach"], context.deps);
    await settle(() => context.children.length > 0);
    context.children[0]!.emit("exit", 1, null);
    await expect(run).resolves.toBe(1);
    expect(context.err.join("")).toContain("exited before reporting a URL");
    expect(context.children[0]!.stdout.destroyed).toBe(true);
    expect(context.children[0]!.unref).toHaveBeenCalledTimes(1);
  });
});

describe("detached idle exit", () => {
  it("expires only after a whole window without clients", () => {
    const tracker = new IdleTracker(1_000);
    expect(tracker.expired(0, 0, 0)).toBe(false);
    expect(tracker.expired(0, 0, 900)).toBe(false);
    expect(tracker.expired(1, 1, 950)).toBe(false);
    expect(tracker.expired(0, 1, 1_000)).toBe(false);
    expect(tracker.expired(0, 1, 1_999)).toBe(false);
    expect(tracker.expired(0, 1, 2_000)).toBe(true);
  });

  it("restarts the window for a connection that came and went between two polls", () => {
    const tracker = new IdleTracker(1_000);
    expect(tracker.expired(0, 3, 0)).toBe(false);
    expect(tracker.expired(0, 4, 900)).toBe(false);
    expect(tracker.expired(0, 4, 1_000)).toBe(false);
    expect(tracker.expired(0, 4, 1_999)).toBe(false);
    expect(tracker.expired(0, 4, 2_000)).toBe(true);
  });

  it("closes a detached server once it has been idle for the whole window", async () => {
    vi.useFakeTimers();
    let clients = 1;
    let generation = 1;
    const close = vi.fn(async () => {});
    const context = harness({
      startServer: async () => fakeServer(close, () => clients, () => generation),
    });

    const run = runCli(["--serve-detached", "--no-open"], context.deps);
    await settle(() => context.out.length > 0);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(close).not.toHaveBeenCalled();

    clients = 0;
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await expect(run).resolves.toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("delays exit by a full window when a page connects between two polls", async () => {
    vi.useFakeTimers();
    let generation = 1;
    const close = vi.fn(async () => {});
    const context = harness({
      startServer: async () => fakeServer(close, () => 0, () => generation),
    });

    const run = runCli(["--serve-detached", "--no-open"], context.deps);
    await settle(() => context.out.length > 0);
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    generation += 1;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25 * 60_000);
    await expect(run).resolves.toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never opens a browser from the detached child", async () => {
    const context = harness();
    const run = runCli(["--serve-detached"], context.deps);
    await settle(() => context.out.length > 0);
    expect(context.deps.openInBrowser).not.toHaveBeenCalled();
    expect(context.out).toEqual([`${URL_LINE}\n`]);
    context.signal();
    await expect(run).resolves.toBe(0);
  });
});
