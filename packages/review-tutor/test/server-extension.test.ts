import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecFileAdapter,
  createServerLifecycle,
  modelChoices,
} from "../extensions/review-tutor.ts";
import { pageHtml } from "../src/page.ts";
import { resolveStatePaths } from "../src/paths.ts";
import type { AskRequest } from "../src/protocol.ts";
import { startReviewTutorServer, type ReviewTutorServer } from "../src/server.ts";

const skillPath = fileURLToPath(
  new URL("../skills/review-tutor/SKILL.md", import.meta.url),
);
const temporaryRoots: string[] = [];

interface DeferredResult {
  promise: Promise<{ answer: string }>;
  resolve: (value: { answer: string }) => void;
}

function deferredResult(): DeferredResult {
  let resolve!: (value: { answer: string }) => void;
  const promise = new Promise<{ answer: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledRunner {
  readonly calls: Array<{ prompt: string; deferred: DeferredResult }> = [];
  cancelCalls = 0;
  shutdownCalls = 0;
  completedCalls = 0;

  async run(request: { prompt: string }, delta: (text: string) => void) {
    const deferred = deferredResult();
    this.calls.push({ prompt: request.prompt, deferred });
    delta("live");
    try {
      return await deferred.promise;
    } finally {
      this.completedCalls += 1;
    }
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "review-tutor-server-"));
  temporaryRoots.push(home);
  return home;
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("test barrier failed: expected condition within 200 attempts");
}

async function start(
  runner = new ControlledRunner(),
  overrides: Partial<Parameters<typeof startReviewTutorServer>[0]> = {},
) {
  const home = await temporaryHome();
  let sourceNumber = 0;
  const server = await startReviewTutorServer({
    cwd: "/repo",
    canonicalRepo: "/repo",
    models: [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }],
    skillPath,
    home,
    runner,
    execFile: async () => ({
      stdout: `source-${++sourceNumber}`,
      stderr: "",
    }),
    ...overrides,
  });
  return { server, runner, home };
}

async function call(
  port: number,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function statusWithHost(
  port: number,
  token: string,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/state",
      headers: {
        Authorization: `Bearer ${token}`,
        Host: host,
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

async function loadSource(port: number, token: string) {
  const response = await call(port, token, "/api/source", {
    method: "POST",
    body: JSON.stringify({ protocol: "rt/1", kind: "worktree" }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; content: string }>;
}

function askBody(inputId: string, ownerPageId?: string): AskRequest {
  return {
    protocol: "rt/1",
    inputId,
    ...(ownerPageId ? { ownerPageId } : {}),
    selection: { text: "selected" },
    question: "Why?",
    modelId: "provider/model",
    thinkingLevel: "low",
    preferences: {
      explanationLanguage: "English",
      comparisonLanguages: [],
    },
    mode: "explain",
  };
}

async function ask(port: number, token: string, inputId: string) {
  return call(port, token, "/api/ask", {
    method: "POST",
    body: JSON.stringify(askBody(inputId)),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
    })),
  );
});

describe("local server security", () => {
  it("serves page recovery HTML while preserving API authorization", async () => {
    const { server } = await start();
    try {
      const bootstrap = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get("content-type")).toContain("text/html");
      const bootstrapBody = await bootstrap.text();
      expect(bootstrapBody).toContain('sessionStorage.getItem("reviewTutorSession")');
      expect(bootstrapBody).toContain("location.replace");
      expect(bootstrapBody).toContain("Review Tutor session not found in this tab. Reopen /review-tutor in Pi, or paste the full tutor link.");
      expect(bootstrapBody).not.toContain(server.token);

      const stale = await fetch(`http://127.0.0.1:${server.port}/?session=wrong`);
      expect(stale.status).toBe(401);
      expect(stale.headers.get("content-type")).toContain("text/html");
      const staleBody = await stale.text();
      expect(staleBody).toContain('sessionStorage.removeItem("reviewTutorSession")');
      expect(staleBody).toContain("This Review Tutor session has ended. Reopen /review-tutor in Pi.");
      expect(staleBody).not.toContain("location.replace");
      expect(staleBody).not.toContain(server.token);

      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      await expect(page.text()).resolves.toBe(pageHtml);

      const api = await fetch(`http://127.0.0.1:${server.port}/api/state`);
      expect(api.status).toBe(401);
      expect(api.headers.get("content-type")).toContain("application/json");
    } finally {
      await server.close();
    }
  });

  it("rejects missing tokens, wrong hosts, wrong origins, and OPTIONS", async () => {
    const { server } = await start();
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status).toBe(401);
      expect(await statusWithHost(server.port, server.token, "localhost")).toBe(403);
      expect((await call(server.port, server.token, "/api/state", {
        headers: { Origin: "http://evil.test" },
      })).status).toBe(403);
      expect((await call(server.port, server.token, "/api/state", {
        method: "OPTIONS",
      })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("keeps a failed source persistence attempt out of current state", async () => {
    const { server, home } = await start();
    try {
      const paths = resolveStatePaths("/repo", home);
      await rm(paths.inputsDir, { recursive: true, force: true });
      await writeFile(paths.inputsDir, "not a directory");

      const failed = await call(server.port, server.token, "/api/source", {
        method: "POST",
        body: JSON.stringify({ protocol: "rt/1", kind: "worktree" }),
      });
      expect(failed.status).toBe(500);

      const state = await (await call(
        server.port,
        server.token,
        "/api/state",
      )).json() as { input?: unknown };
      expect(state.input).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns JSON instead of escaping when export reads a corrupt log", async () => {
    const { server, home } = await start();
    try {
      const paths = resolveStatePaths("/repo", home);
      await writeFile(paths.logFile, "{bad\n{}\n");

      const response = await call(server.port, server.token, "/api/export");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/valid JSONL at line 1/),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects unknown fields, oversized bodies, and non-empty heartbeats", async () => {
    const { server } = await start();
    try {
      const unknown = await call(server.port, server.token, "/api/source", {
        method: "POST",
        body: JSON.stringify({ protocol: "rt/1", kind: "worktree", extra: true }),
      });
      expect(unknown.status).toBe(400);

      const oversized = await call(server.port, server.token, "/api/source", {
        method: "POST",
        body: JSON.stringify({ content: "x".repeat(1024 * 1024 + 1) }),
      });
      expect(oversized.status).toBe(400);

      const heartbeat = await call(server.port, server.token, "/api/heartbeat", {
        method: "POST",
        body: JSON.stringify({ extra: true }),
      });
      expect(heartbeat.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it.each(["-1", "1.5", "NaN", "1001", "", "+1"])(
    "rejects invalid log limit %j",
    async (limit) => {
      const { server } = await start();
      try {
        expect((await call(
          server.port,
          server.token,
          `/api/log?limit=${encodeURIComponent(limit)}`,
        )).status).toBe(400);
      } finally {
        await server.close();
      }
    },
  );
});

describe("local server question lifecycle", () => {
  it("stores and echoes question page ownership", async () => {
    const { server } = await start();
    try {
      const loaded = await loadSource(server.port, server.token);
      const response = await call(server.port, server.token, "/api/ask", {
        method: "POST",
        body: JSON.stringify(askBody(loaded.id, "page-1")),
      });
      expect(response.status).toBe(202);
      const question = await response.json() as { id: string; ownerPageId?: string };
      expect(question.ownerPageId).toBe("page-1");
      const snapshot = await (await call(server.port, server.token, "/api/state")).json() as {
        questions: Array<{ id: string; ownerPageId?: string }>;
      };
      expect(snapshot.questions.find((item) => item.id === question.id)?.ownerPageId).toBe("page-1");
    } finally {
      await server.close();
    }
  });

  it("uses a queued question's accepted snapshot after another source loads", async () => {
    const { server, runner } = await start();
    try {
      const firstSource = await loadSource(server.port, server.token);
      const firstAsk = await ask(server.port, server.token, firstSource.id);
      expect(firstAsk.status).toBe(202);
      await waitFor(() => runner.calls.length === 1);

      const queuedAsk = await ask(server.port, server.token, firstSource.id);
      expect(queuedAsk.status).toBe(202);
      const secondSource = await loadSource(server.port, server.token);
      expect(secondSource.content).toBe("source-2");

      runner.calls[0]!.deferred.resolve({ answer: "first" });
      await waitFor(() => runner.calls.length === 2);
      expect(runner.calls[1]!.prompt).toContain("source-1");
      expect(runner.calls[1]!.prompt).not.toContain("source-2");
      runner.calls[1]!.deferred.resolve({ answer: "second" });
      await waitFor(() => runner.completedCalls === 2);
    } finally {
      await server.close();
    }
  });

  it("prunes old snapshots but retains a snapshot referenced by queued work", async () => {
    const { server, runner } = await start();
    try {
      const protectedSource = await loadSource(server.port, server.token);
      expect((await ask(server.port, server.token, protectedSource.id)).status).toBe(202);
      await waitFor(() => runner.calls.length === 1);
      expect((await ask(server.port, server.token, protectedSource.id)).status).toBe(202);

      const staleSource = await loadSource(server.port, server.token);
      for (let index = 0; index < 32; index += 1) {
        await loadSource(server.port, server.token);
      }

      expect((await ask(server.port, server.token, staleSource.id)).status).toBe(409);
      expect((await ask(server.port, server.token, protectedSource.id)).status).toBe(202);

      runner.calls[0]!.deferred.resolve({ answer: "first" });
      await waitFor(() => runner.calls.length === 2);
      expect(runner.calls[1]!.prompt).toContain(protectedSource.content);
      runner.calls[1]!.deferred.resolve({ answer: "second" });
      await waitFor(() => runner.calls.length === 3);
      runner.calls[2]!.deferred.resolve({ answer: "third" });
      await waitFor(() => runner.completedCalls === 3);
    } finally {
      await server.close();
    }
  });

  it("keeps a cancelled running question cancelled after a late result and writes no entry", async () => {
    const { server, runner } = await start();
    try {
      const source = await loadSource(server.port, server.token);
      const view = await (await ask(server.port, server.token, source.id)).json() as { id: string };
      await waitFor(() => runner.calls.length === 1);

      const cancelled = await call(
        server.port,
        server.token,
        `/api/questions/${view.id}/cancel`,
        { method: "POST", body: "{}" },
      );
      expect(cancelled.status).toBe(200);
      expect(runner.cancelCalls).toBe(1);

      runner.calls[0]!.deferred.resolve({ answer: "late answer" });
      await waitFor(() => runner.completedCalls === 1);
      const state = await (await call(server.port, server.token, "/api/state")).json() as {
        questions: Array<{ id: string; state: string }>;
      };
      expect(state.questions.find((question) => question.id === view.id)?.state).toBe("cancelled");
      expect(await (await call(server.port, server.token, "/api/log")).json()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("admits one running and four queued questions, then rejects the next", async () => {
    const { server, runner } = await start();
    try {
      const source = await loadSource(server.port, server.token);
      expect((await ask(server.port, server.token, source.id)).status).toBe(202);
      await waitFor(() => runner.calls.length === 1);
      for (let queued = 0; queued < 4; queued += 1) {
        expect((await ask(server.port, server.token, source.id)).status).toBe(202);
      }
      expect((await ask(server.port, server.token, source.id)).status).toBe(429);
    } finally {
      await server.close();
    }
  });

  it("persists an answer before answered state is observable", async () => {
    const { server, runner } = await start();
    try {
      const source = await loadSource(server.port, server.token);
      const view = await (await ask(server.port, server.token, source.id)).json() as { id: string };
      await waitFor(() => runner.calls.length === 1);
      runner.calls[0]!.deferred.resolve({ answer: "final answer" });

      await waitFor(async () => {
        const state = await (await call(server.port, server.token, "/api/state")).json() as {
          questions: Array<{ id: string; state: string }>;
        };
        return state.questions.find((question) => question.id === view.id)?.state === "answered";
      });
      const log = await (await call(server.port, server.token, "/api/log")).json() as Array<{ answer: string }>;
      expect(log).toMatchObject([{ answer: "final answer" }]);
    } finally {
      await server.close();
    }
  });
});

describe("local server startup and shutdown", () => {
  it("shuts down the runner when initial-source loading fails after listen", async () => {
    const runner = new ControlledRunner();
    const home = await temporaryHome();
    await expect(startReviewTutorServer({
      cwd: "/repo",
      canonicalRepo: "/repo",
      models: [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }],
      skillPath,
      home,
      runner,
      initialSource: { protocol: "rt/1", kind: "worktree" },
      execFile: async () => {
        throw new Error("initial source unavailable");
      },
    })).rejects.toThrow(/initial source unavailable/);
    expect(runner.shutdownCalls).toBe(1);
  });

  it("closes idempotently", async () => {
    const { server, runner } = await start();
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(runner.shutdownCalls).toBe(1);
    await expect(fetch(`http://127.0.0.1:${server.port}/api/state`)).rejects.toThrow();
  });
});

describe("extension lifecycle and command execution", () => {
  function fakeServer(close = vi.fn(async () => {})): ReviewTutorServer {
    return {
      url: "http://127.0.0.1:1/?session=secret",
      token: "secret",
      port: 1,
      close,
    };
  }

  it("reuses one concurrent startup and closes a startup completed during shutdown", async () => {
    const lifecycle = createServerLifecycle();
    const deferred = deferredResult();
    const server = fakeServer();
    const factory = vi.fn(async () => {
      await deferred.promise;
      return server;
    });

    const first = lifecycle.start(factory);
    const second = lifecycle.start(factory);
    expect(factory).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    deferred.resolve({ answer: "ready" });
    await expect(Promise.all([first, second])).resolves.toEqual([server, server]);

    const closingLifecycle = createServerLifecycle();
    const closingDeferred = deferredResult();
    const close = vi.fn(async () => {});
    const starting = closingLifecycle.start(async () => {
      await closingDeferred.promise;
      return fakeServer(close);
    });
    const shutdown = closingLifecycle.shutdown();
    closingDeferred.resolve({ answer: "ready" });
    await expect(starting).resolves.toBeUndefined();
    await shutdown;
    expect(close).toHaveBeenCalled();

    const restarted = fakeServer();
    await expect(closingLifecycle.start(async () => restarted)).resolves.toBe(restarted);
    await closingLifecycle.shutdown();
  });

  it("aborts pending startup during shutdown and can start again", async () => {
    const lifecycle = createServerLifecycle();
    let startupAborted = false;
    const starting = lifecycle.start((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        startupAborted = true;
        reject(new Error("startup aborted"));
      }, { once: true });
    }));
    await Promise.resolve();

    await lifecycle.shutdown();

    expect(startupAborted).toBe(true);
    await expect(starting).resolves.toBeUndefined();
    const restarted = fakeServer();
    await expect(lifecycle.start(async () => restarted)).resolves.toBe(restarted);
    await lifecycle.shutdown();
  });

  it("executes with argv, no shell, timeout, and the requested maxBuffer", async () => {
    const nodeExec = vi.fn((file, argv, options, callback) => {
      callback(null, "out", "err");
      return {};
    });
    const exec = createExecFileAdapter(nodeExec as never);

    const controller = new AbortController();
    await expect(exec("gh", ["pr", "view", "url"], {
      cwd: "/repo",
      encoding: "utf8",
      maxBuffer: 1234,
      signal: controller.signal,
    })).resolves.toEqual({ stdout: "out", stderr: "err" });
    expect(nodeExec).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "url"],
      {
        cwd: "/repo",
        encoding: "utf8",
        maxBuffer: 1234,
        timeout: 30_000,
        shell: false,
        signal: controller.signal,
      },
      expect.any(Function),
    );
  });
});

describe("scoped model discovery", () => {
  const sol = { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true };
  const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true };
  const basic = { provider: "local", id: "basic", name: "", reasoning: false };

  function context(
    scoped: Array<{ model: unknown; thinkingLevel?: string }>,
    available: unknown[],
  ) {
    return {
      scopedModels: scoped,
      modelRegistry: { getAvailable: () => available },
    } as never;
  }

  it("lists only session-scoped models when a scope is configured", () => {
    expect(modelChoices(context([{ model: sol }], [sol, luna]))).toEqual([
      {
        id: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      },
    ]);
  });

  it("falls back to the availability snapshot without a scope", () => {
    expect(modelChoices(context([], [sol, basic])).map((choice) => choice.id)).toEqual([
      "openai/gpt-5.6-sol",
      "local/basic",
    ]);
  });

  it("labels unnamed models canonically and limits thinking for non-reasoning models", () => {
    expect(modelChoices(context([{ model: basic }], [sol]))).toEqual([
      { id: "local/basic", label: "local/basic", thinkingLevels: ["off"] },
    ]);
  });

  it("narrows thinking to an explicitly pinned scope level", () => {
    const chosen = modelChoices(context([{ model: sol, thinkingLevel: "high" }], []));
    expect(chosen[0]!.thinkingLevels).toEqual(["high"]);
  });
});

describe("placeholder page and extension boundaries", () => {
  it("uses safe DOM insertion and accessible status regions", () => {
    expect(pageHtml).not.toContain(".innerHTML");
    expect(pageHtml).toContain('role="status"');
    expect(pageHtml).toContain('role="alert"');
    expect(pageHtml).toContain("node.textContent = label");
    expect(pageHtml).toContain("function renderMarkdown(container, markdown, depth = 0)");
    expect(pageHtml).toContain("if (typeof question.answer === \"string\") setAnswer(question.answer)");
    expect(pageHtml).toContain("function updateActions(questionState = currentQuestionState)");
    expect(pageHtml).toContain('events.addEventListener("state"');
    expect(pageHtml).toContain("showError(error, action");
    expect(pageHtml).toContain('question.state === "failed"');
    expect(pageHtml).toContain("setTimeout(() => URL.revokeObjectURL(objectUrl), 100)");
  });

  it("avoids forbidden APIs and keeps successful notifications token-free", async () => {
    const source = await readFile(
      new URL("../extensions/review-tutor.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "send" + "Message",
      "send" + "UserMessage",
      "append" + "Entry",
      "getProvider" + "Auth",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('safeNotify(ctx, "Review Tutor opened.", "info")');
    expect(source).not.toMatch(/safeNotify\(ctx,\s*server\.url/);
  });
});
