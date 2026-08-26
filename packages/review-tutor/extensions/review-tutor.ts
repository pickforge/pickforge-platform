import { realpath } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createExecFileAdapter,
  createServerLifecycle,
  openInBrowser,
  resolveRepository,
  sourceFromArgument,
} from "../src/cli-support.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import { defaultSkillPath } from "../src/paths.ts";
import type { ExecFile } from "../src/inputs.ts";
import type { ModelChoice } from "../src/protocol.ts";
import { startReviewTutorServer } from "../src/server.ts";

export { createExecFileAdapter, createServerLifecycle } from "../src/cli-support.ts";

const skillPath = defaultSkillPath();

/** Repository resolution and browser opening stay on the host's own exec, with the host's timeouts. */
export function piExecFile(pi: ExtensionAPI): ExecFile {
  return async (file, argv, options) => {
    const result = await pi.exec(file, argv, {
      cwd: options.cwd,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    if (result.code !== 0) {
      throw Object.assign(new Error(`${file} exited with code ${result.code}`), {
        code: result.code,
        stderr: result.stderr,
      });
    }
    return { stdout: result.stdout, stderr: result.stderr };
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
  const hostExecFile = piExecFile(pi);

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
          const canonicalRepo = await resolveRepository(cwd, hostExecFile);
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
        const opened = await openInBrowser(server.url, process.platform, hostExecFile);
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
