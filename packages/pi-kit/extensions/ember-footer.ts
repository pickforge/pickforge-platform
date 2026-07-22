/**
 * pi-kit ember footer — Pickforge-style replacement for the built-in footer
 * and pi-bar.
 *
 * Line 1: model · thinking · context pressure · git branch
 * Line 2 (only when present): extension statuses, deduplicated — status text
 * is shown as published, never prefixed with its key (no more `mode:mode:`).
 *
 * Toggle with /footer. Requires pi-bar to be uninstalled or hidden, since
 * both replace the footer.
 */
import { calculateCost, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Status keys whose text is already surfaced elsewhere in the footer. */
const HIDDEN_STATUS_KEYS = new Set(["pi-bar"]);

function fmtTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
  return `${count}`;
}

function fmtDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

function pricedCost(ctx: ExtensionContext, message: AssistantMessage): number {
  if (message.usage.cost.total > 0) return message.usage.cost.total;
  try {
    const provider = message.provider;
    const modelId = message.model;
    if (!provider || !modelId || message.usage.totalTokens <= 0) return 0;
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model || !Object.values(model.cost).some((rate) => typeof rate === "number" && rate > 0)) return 0;
    const estimatedUsage: Usage = {
      ...message.usage,
      cost: { ...message.usage.cost },
    };
    return calculateCost(model, estimatedUsage).total;
  } catch {
    return 0;
  }
}

export default function emberFooter(pi: ExtensionAPI) {
  let enabled = true;

  // Cost accumulation is O(session length); cache it and refresh only when the
  // entry count changes instead of walking the session every render frame.
  let cachedCost = 0;
  let cachedEntryCount = -1;
  let sessionStartedAt = Date.now();
  let workingStartedAt: number | null = null;
  let workedElapsedMs: number | null = null;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;

  function sessionCost(ctx: ExtensionContext): number {
    try {
      const entries = ctx.sessionManager.getEntries();
      if (entries.length !== cachedEntryCount) {
        cachedEntryCount = entries.length;
        cachedCost = 0;
        for (const entry of entries) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            cachedCost += pricedCost(ctx, entry.message as AssistantMessage);
          } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
            cachedCost += entry.message.usage.cost.total;
          } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            cachedCost += entry.usage.cost.total;
          }
        }
      }
    } catch {
      // Footer must never break the session.
    }
    return cachedCost;
  }

  function stopClock(): void {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = undefined;
  }

  function startClock(): void {
    stopClock();
    clockTimer = setInterval(() => requestRender?.(), 1_000);
    clockTimer.unref?.();
  }

  function install(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const render = () => {
          try {
            tui.requestRender();
          } catch {
            // Rendering callbacks must never break the session.
          }
        };
        requestRender = render;
        const unsubscribe = footerData.onBranchChange(render);
        const sep = theme.fg("dim", " · ");

        return {
          dispose() {
            try {
              unsubscribe();
            } catch {
              // Footer cleanup is best-effort.
            }
            if (requestRender === render) requestRender = undefined;
          },
          invalidate() {},
          render(width: number): string[] {
            const cost = sessionCost(ctx);
            let contextTokens: number | null = null;
            let contextWindow = 0;
            try {
              const usage = ctx.getContextUsage();
              contextTokens = usage?.tokens ?? null;
              contextWindow = usage?.contextWindow ?? 0;
            } catch {
              // Footer must never break the session.
            }

            const model = ctx.model?.id ?? "no-model";
            const thinking = pi.getThinkingLevel();
            const pressurePct =
              contextTokens !== null && contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null;
            const pressureColor =
              pressurePct === null ? "muted" : pressurePct < 50 ? "success" : pressurePct < 80 ? "warning" : "error";
            const pressure =
              pressurePct === null ? "—" : `${pressurePct.toFixed(0)}% of ${fmtTokens(contextWindow)}`;
            const branch = footerData.getGitBranch();
            const now = Date.now();
            let costText = `$${cost.toFixed(2)}`;
            try {
              if (ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model)) costText += " est";
            } catch {
              // Footer must never break the session.
            }

            const left = [
              theme.fg("accent", model),
              theme.fg("muted", `think ${thinking}`),
              theme.fg(pressureColor, pressure),
              theme.fg("muted", `session ${fmtDuration(now - sessionStartedAt)}`),
              ...(workingStartedAt !== null
                ? [theme.fg("warning", `working ${fmtDuration(now - workingStartedAt)}`)]
                : workedElapsedMs !== null
                  ? [theme.fg("muted", `worked ${fmtDuration(workedElapsedMs)}`)]
                  : []),
            ].join(sep);
            const right = [
              ...(branch ? [theme.fg("muted", ` ${branch}`)] : []),
              theme.fg("dim", costText),
            ].join(sep);

            const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
            const lines = [truncateToWidth(left + pad + right, width)];

            // Line 2: extension statuses, text only, deduplicated.
            const seen = new Set<string>();
            const statuses: string[] = [];
            for (const [key, text] of footerData.getExtensionStatuses()) {
              if (HIDDEN_STATUS_KEYS.has(key)) continue;
              const clean = text.trim();
              if (!clean || seen.has(clean)) continue;
              seen.add(clean);
              statuses.push(clean);
            }
            if (statuses.length > 0) {
              lines.push(truncateToWidth(statuses.join(sep), width));
            }
            return lines;
          },
        };
      });
    } catch {
      // Footer installation must never break the session.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionStartedAt = Date.now();
    workingStartedAt = null;
    workedElapsedMs = null;
    cachedEntryCount = -1;
    stopClock();
    try {
      await ctx.modelRegistry.refresh();
    } catch {
      // Existing registry data is still safe to render.
    }
    if (ctx.hasUI && enabled) startClock();
    if (enabled) install(ctx);
  });

  pi.on("agent_start", () => {
    if (workingStartedAt === null) {
      workedElapsedMs = null;
      workingStartedAt = Date.now();
    }
    requestRender?.();
  });

  pi.on("agent_settled", () => {
    if (workingStartedAt !== null) {
      workedElapsedMs = Date.now() - workingStartedAt;
      workingStartedAt = null;
    }
    requestRender?.();
  });

  pi.on("session_shutdown", () => {
    stopClock();
    workingStartedAt = null;
    workedElapsedMs = null;
  });

  pi.registerCommand("footer", {
    description: "Toggle the Pickforge ember footer",
    handler: async (_args, ctx) => {
      try {
        enabled = !enabled;
        if (enabled) {
          startClock();
          install(ctx);
          ctx.ui.notify("ember footer on", "info");
        } else {
          stopClock();
          ctx.ui.setFooter(undefined);
          ctx.ui.notify("built-in footer restored", "info");
        }
      } catch {
        // Footer commands must never break the session.
      }
    },
  });
}
