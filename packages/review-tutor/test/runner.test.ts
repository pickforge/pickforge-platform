import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  TutorRunner,
  createChildEnvironment,
  platformTerminate,
} from "../src/runner.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123;
  kill = vi.fn();
}

const request = {
  provider: "p",
  model: "m",
  thinking: "low",
  cwd: "/repo",
  prompt: "secret prompt",
};

function finalEvent(answer: string): string {
  return `${JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
  })}\n`;
}

describe("tutor runner", () => {
  it("uses exact argv, stdin, detached group, and stripped env", async () => {
    const child = new FakeChild();
    let stdin = "";
    child.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    const spawn = vi.fn(() => child as never);
    const runner = new TutorRunner({
      spawn,
      env: {
        PATH: "/bin",
        HOME: "/h",
        PI_SESSION_ID: "secret",
        AWS_SECRET: "x",
      },
      platform: "linux",
    });

    const done = runner.run(request, () => {});
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledWith(
      "pi",
      [
        "--mode", "json", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-context-files", "--no-session", "-p",
        "--tools", "read,grep,find,ls", "--provider", "p", "--model", "m",
        "--thinking", "low",
      ],
      expect.objectContaining({ cwd: "/repo", detached: true }),
    );
    const call = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(call[2].env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      REVIEW_TUTOR_CHILD: "1",
    });
    expect(JSON.stringify(call[1])).not.toContain("secret prompt");
    expect(stdin).toBe("secret prompt");

    child.stdout.end(finalEvent("ok"));
    child.emit("close", 0, null);
    await expect(done).resolves.toMatchObject({ answer: "ok" });
  });

  it("decodes a Unicode character split across stdout chunks", async () => {
    const child = new FakeChild();
    const deltas: string[] = [];
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run(request, (text) => deltas.push(text));
    const line = Buffer.from(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "🙂" },
    })}\n`);
    const split = line.indexOf(Buffer.from("🙂")) + 1;

    child.stdout.write(line.subarray(0, split));
    child.stdout.write(line.subarray(split));
    child.stdout.end(finalEvent("🙂"));
    child.emit("close", 0, null);

    await expect(done).resolves.toMatchObject({ answer: "🙂" });
    expect(deltas).toEqual(["🙂"]);
  });

  it("contains asynchronous stdin errors and terminates exactly once", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const done = runner.run(request, () => {});
    let rejections = 0;
    void done.catch(() => { rejections += 1; });

    child.stdin.emit("error", new Error("EPIPE"));
    child.stdin.emit("error", new Error("EPIPE again"));
    child.emit("close", null, "SIGTERM");

    await expect(done).rejects.toThrow(/stdin failed.*EPIPE/);
    expect(rejections).toBe(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
    expect(child.stdin.listenerCount("error")).toBe(0);
  });

  it("terminates after a synchronous stdin write failure", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    vi.spyOn(child.stdin, "end").mockImplementation(() => {
      throw new Error("pipe closed");
    });
    const runner = new TutorRunner({ spawn: () => child as never, terminate });

    const done = runner.run(request, () => {});
    expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(done).rejects.toThrow(/stdin failed.*pipe closed/);
  });

  it("rejects child spawn errors without hanging", async () => {
    const child = new FakeChild();
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run(request, () => {});

    child.emit("error", new Error("ENOENT"));

    await expect(done).rejects.toThrow(/spawn failed.*ENOENT/);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("contains delta callback errors and terminates the child", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const done = runner.run(request, () => {
      throw new Error("render failed");
    });

    child.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    })}\n`);
    child.emit("close", null, "SIGTERM");

    await expect(done).rejects.toThrow(/render failed/);
    expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it.each([
    ["cancel", (runner: TutorRunner, fireTimeout: () => void) => runner.cancel(), /cancelled/],
    ["timeout", (_runner: TutorRunner, fireTimeout: () => void) => fireTimeout(), /timed out/],
  ] as const)("%s settles once and escalates through the termination seam", async (_name, stop, message) => {
    const child = new FakeChild();
    const terminate = vi.fn();
    const timers: Array<() => void> = [];
    const clearTimeout = vi.fn();
    const runner = new TutorRunner({
      spawn: () => child as never,
      terminate,
      setTimeout: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as never;
      }) as unknown as typeof setTimeout,
      clearTimeout: clearTimeout as typeof globalThis.clearTimeout,
      timeoutMs: 10,
    });
    const done = runner.run(request, () => {});
    let settlements = 0;
    void done.then(
      () => { settlements += 1; },
      () => { settlements += 1; },
    );

    stop(runner, timers[0]!);
    expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
    timers[1]!();
    expect(terminate).toHaveBeenCalledWith(child, "SIGKILL");
    await expect(done).rejects.toThrow(message);
    child.emit("close", null, "SIGKILL");
    await Promise.resolve();
    expect(settlements).toBe(1);
  });

  it("does not schedule shutdown fallback after the child settles", async () => {
    const child = new FakeChild();
    const delays: number[] = [];
    const runner = new TutorRunner({
      spawn: () => child as never,
      setTimeout: ((callback: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        return delays.length as never;
      }) as unknown as typeof setTimeout,
      clearTimeout: vi.fn() as typeof globalThis.clearTimeout,
    });
    const done = runner.run(request, () => {});

    child.stdout.end(finalEvent("ok"));
    child.emit("close", 0, null);
    await runner.shutdown();

    expect(delays).toEqual([300_000]);
    await expect(done).resolves.toMatchObject({ answer: "ok" });
  });

  it("clears the shutdown fallback when a live child closes", async () => {
    const child = new FakeChild();
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const clearTimeout = vi.fn();
    const runner = new TutorRunner({
      spawn: () => child as never,
      terminate: vi.fn(),
      setTimeout: ((callback: () => void, delay?: number) => {
        callbacks.push(callback);
        delays.push(delay ?? 0);
        return callbacks.length as never;
      }) as unknown as typeof setTimeout,
      clearTimeout: clearTimeout as typeof globalThis.clearTimeout,
    });
    void runner.run(request, () => {}).catch(() => {});

    const shutdown = runner.shutdown();
    child.emit("close", null, "SIGTERM");
    await shutdown;

    expect(delays).toEqual([300_000, 5_000, 5_500]);
    expect(clearTimeout).toHaveBeenCalledWith(3);
  });

  it("uses process groups on POSIX and direct children on Windows", () => {
    const child = new FakeChild();
    const kill = vi.fn();

    platformTerminate("linux", kill)(child as never, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");

    platformTerminate("win32", kill)(child as never, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails on stdout and stderr caps", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const child = new FakeChild();
      const terminate = vi.fn();
      const runner = new TutorRunner({
        spawn: () => child as never,
        terminate,
        stdoutLimit: 4,
        stderrLimit: 4,
      });
      const done = runner.run(request, () => {});
      child[stream].write("12345");
      child.emit("close", 1, null);
      await expect(done).rejects.toThrow(stream);
      expect(terminate).toHaveBeenCalledWith(child, "SIGTERM");
    }
  });

  it("keeps only the child environment allowlist", () => {
    expect(createChildEnvironment({
      PI_SESSION_X: "x",
      LANG: "en",
      XDG_DATA_HOME: "/x",
      RANDOM: "no",
    })).toEqual({
      LANG: "en",
      XDG_DATA_HOME: "/x",
      REVIEW_TUTOR_CHILD: "1",
    });
  });
});
