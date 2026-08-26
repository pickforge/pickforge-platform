import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const url = "http://127.0.0.1:1/?session=secret";
const startReviewTutorServer = vi.fn(async () => ({
  url,
  token: "secret",
  port: 1,
  close: async () => {},
  clientCount: () => 0,
  connectionGeneration: () => 0,
}));
const nodeExecFile = vi.fn(() => {
  throw new Error("node:child_process must not run host operations under Pi");
});

vi.mock("../src/server.ts", () => ({ startReviewTutorServer }));
vi.mock("node:child_process", () => ({ execFile: nodeExecFile }));

const { default: reviewTutorExtension } = await import("../extensions/review-tutor.ts");

const browserCommand = process.platform === "darwin"
  ? "open"
  : process.platform === "win32"
    ? "cmd"
    : "xdg-open";
const browserArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runCommand() {
  const cwd = await mkdtemp(join(tmpdir(), "review-tutor-host-"));
  roots.push(cwd);
  const exec = vi.fn(async (file: string) => ({
    code: 0,
    stdout: file === "git" ? `${cwd}\n` : "",
    stderr: "",
  }));
  const notify = vi.fn();
  const handlers = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    exec,
    registerCommand: (name: string, spec: never) => { handlers.set(name, spec); },
    on: () => {},
  };
  reviewTutorExtension(pi as never);
  await handlers.get("review-tutor")!.handler("", {
    mode: "tui",
    cwd,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model", name: "Model", reasoning: true }] },
    ui: { notify, setStatus: vi.fn() },
  });
  return { cwd, exec, notify };
}

describe("extension host execution", () => {
  it("resolves the repository and opens the browser through pi.exec with the host timeouts", async () => {
    const { cwd, exec, notify } = await runCommand();

    expect(exec).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 5_000,
    });
    expect(exec).toHaveBeenNthCalledWith(2, browserCommand, browserArgs, {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(nodeExecFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Review Tutor opened.", "info");
    expect(startReviewTutorServer).toHaveBeenCalledTimes(1);
  });
});
