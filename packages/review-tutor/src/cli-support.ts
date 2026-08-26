import { execFile as nodeExecFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { ExecFile } from "./inputs.ts";
import type { SourceRequest } from "./protocol.ts";
import type { ReviewTutorServer } from "./server.ts";

type NodeExecFile = typeof nodeExecFile;

const COMMAND_BUFFER = 1024 * 1024;

export function createExecFileAdapter(execFile: NodeExecFile = nodeExecFile): ExecFile {
  return (file, argv, options) => new Promise((resolve, reject) => {
    execFile(file, argv, {
      cwd: options.cwd,
      encoding: options.encoding,
      maxBuffer: options.maxBuffer,
      timeout: 30_000,
      shell: false,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        (error as Error & { stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function sourceFromArgument(argument: string): SourceRequest | undefined {
  const value = argument.trim();
  if (!value) return undefined;
  if (/^https:\/\/github\.com\//.test(value)) {
    return { protocol: "rt/1", kind: "pr", url: value };
  }
  if (value === "worktree") return { protocol: "rt/1", kind: "worktree" };
  if (value === "staged") return { protocol: "rt/1", kind: "staged" };

  const range = value.split("...");
  if (range.length === 2) {
    return {
      protocol: "rt/1",
      kind: "range",
      from: range[0]!,
      to: range[1]!,
    };
  }
  return { protocol: "rt/1", kind: "commit", revision: value };
}

export async function resolveRepository(cwd: string, execFile: ExecFile): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: COMMAND_BUFFER,
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `repository resolution failed: expected git rev-parse to succeed, received code ${String(code ?? "unknown")}; run /review-tutor inside a Git worktree`,
    );
  }
  return realpath(stdout.trim());
}

export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform,
  execFile: ExecFile,
): Promise<boolean> {
  const command = platform === "darwin"
    ? "open"
    : platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = platform === "win32"
    ? ["/c", "start", "", url]
    : [url];

  try {
    await execFile(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: COMMAND_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

export interface ServerLifecycle {
  start(
    factory: (signal: AbortSignal) => Promise<ReviewTutorServer>,
  ): Promise<ReviewTutorServer | undefined>;
  shutdown(): Promise<void>;
}

export function createServerLifecycle(): ServerLifecycle {
  let server: ReviewTutorServer | undefined;
  let starting: Promise<ReviewTutorServer> | undefined;
  let startupController: AbortController | undefined;
  let stopping: Promise<void> | undefined;
  let shuttingDown = false;

  return {
    async start(factory) {
      if (server) return server;
      if (shuttingDown) return undefined;
      if (!starting) {
        const controller = new AbortController();
        const attempt = Promise.resolve().then(() => factory(controller.signal));
        startupController = controller;
        starting = attempt;
        void attempt.then(
          (started) => {
            server = started;
          },
          () => {},
        ).finally(() => {
          if (starting === attempt) starting = undefined;
          if (startupController === controller) startupController = undefined;
        });
      }

      const attempt = starting;
      try {
        const started = await attempt;
        if (shuttingDown) {
          if (server === started) server = undefined;
          await started.close();
          return undefined;
        }
        return started;
      } catch (error) {
        if (shuttingDown) return undefined;
        throw error;
      }
    },

    async shutdown() {
      if (stopping) {
        await stopping;
        return;
      }

      shuttingDown = true;
      const controller = startupController;
      controller?.abort();
      const attempt = starting;
      const current = server;
      server = undefined;
      const stop = (async () => {
        try {
          if (current) {
            await current.close();
          } else if (attempt) {
            const started = await attempt;
            if (server === started) server = undefined;
            await started.close();
          }
        } catch {
          // Shutdown must remain contained inside the caller.
        }
      })();
      stopping = stop;
      try {
        await stop;
      } finally {
        if (starting === attempt) starting = undefined;
        if (startupController === controller) startupController = undefined;
        if (stopping === stop) stopping = undefined;
        shuttingDown = false;
      }
    },
  };
}
