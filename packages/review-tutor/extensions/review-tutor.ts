import { execFile as nodeExecFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { ExecFile } from "../src/inputs.ts";
import type { ModelChoice, SourceRequest } from "../src/protocol.ts";
import {
  startReviewTutorServer,
  type ReviewTutorServer,
} from "../src/server.ts";

const skillPath = fileURLToPath(
  new URL("../skills/review-tutor/SKILL.md", import.meta.url),
);

type NodeExecFile = typeof nodeExecFile;

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
          // Shutdown must remain contained inside the extension.
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

function safeNotify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Pi UI calls are fallible and must not escape extension handlers.
  }
}

function safeStatus(ctx: ExtensionCommandContext, value?: string): void {
  try {
    ctx.ui.setStatus("review-tutor", value);
  } catch {
    // Pi UI calls are fallible and must not escape extension handlers.
  }
}

function sourceFromArgument(argument: string): SourceRequest | undefined {
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

function modelChoice(
  model: { provider: string; id: string; name?: string; reasoning?: boolean },
  pinnedThinkingLevel?: string,
): ModelChoice {
  const id = `${model.provider}/${model.id}`;
  return {
    id,
    label: model.name || id,
    thinkingLevels: pinnedThinkingLevel
      ? [pinnedThinkingLevel]
      : model.reasoning
        ? ["off", "minimal", "low", "medium", "high", "xhigh"]
        : ["off"],
  };
}

export function modelChoices(ctx: ExtensionCommandContext): ModelChoice[] {
  if (ctx.scopedModels.length) {
    return ctx.scopedModels.map((scoped) => modelChoice(scoped.model, scoped.thinkingLevel));
  }
  return ctx.modelRegistry.getAvailable().map((model) => modelChoice(model));
}

async function repositoryRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `repository resolution failed: expected git rev-parse to succeed, received code ${result.code}; run /review-tutor inside a Git worktree`,
    );
  }
  return realpath(result.stdout.trim());
}

async function openBrowser(pi: ExtensionAPI, url: string): Promise<boolean> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32"
    ? ["/c", "start", "", url]
    : [url];

  try {
    const result = await pi.exec(command, args, { timeout: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

function notifyBrowserResult(
  ctx: ExtensionCommandContext,
  opened: boolean,
  url: string,
): void {
  if (opened) {
    safeNotify(ctx, "Review Tutor opened.", "info");
  } else {
    safeNotify(ctx, `Review Tutor could not open the browser. Open ${url}`, "warning");
  }
}

export default function reviewTutorExtension(pi: ExtensionAPI): void {
  const lifecycle = createServerLifecycle();
  const execFile = createExecFileAdapter();

  pi.registerCommand("review-tutor", {
    description: "Open the local Review Tutor for a PR, diff, commit, or pasted code",
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "tui") {
          safeNotify(
            ctx,
            "Review Tutor requires Pi TUI mode. Start Pi interactively and run /review-tutor.",
            "error",
          );
          return;
        }

        const server = await lifecycle.start(async (startupSignal) => {
          const cwd = await realpath(ctx.cwd);
          const canonicalRepo = await repositoryRoot(pi, cwd);
          const piModels = modelChoices(ctx);
          if (!piModels.length) {
            throw new Error(
              "model snapshot failed: expected at least one available model; configure a Pi model and retry",
            );
          }
          const registry = createConnectorRegistry({ piModels });
          return startReviewTutorServer({
            cwd,
            canonicalRepo,
            registry,
            skillPath,
            initialSource: sourceFromArgument(args),
            startupSignal,
            execFile,
          });
        });
        if (!server) return;

        safeStatus(ctx, "Review Tutor running");
        const opened = await openBrowser(pi, server.url);
        notifyBrowserResult(ctx, opened, server.url);
      } catch (error) {
        safeStatus(ctx);
        safeNotify(
          ctx,
          `Review Tutor failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await lifecycle.shutdown();
  });
}
