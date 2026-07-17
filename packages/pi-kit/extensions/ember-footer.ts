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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Status keys whose text is already surfaced elsewhere in the footer. */
const HIDDEN_STATUS_KEYS = new Set(["pi-bar"]);

function fmtTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}k`;
  return `${count}`;
}

export default function emberFooter(pi: ExtensionAPI) {
  let enabled = true;

  function install(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const sep = theme.fg("dim", " · ");

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          // Context usage from the session branch.
          let tokens = 0;
          let cost = 0;
          let contextTokens: number | null = null;
          let contextWindow = 0;
          try {
            for (const entry of ctx.sessionManager.getBranch()) {
              if (entry.type === "message" && entry.message.role === "assistant") {
                const message = entry.message as AssistantMessage;
                tokens += message.usage.input + message.usage.output;
                cost += message.usage.cost.total;
              }
            }
            const usage = ctx.getContextUsage?.();
            contextTokens = usage?.tokens ?? null;
            contextWindow = usage?.contextWindow ?? 0;
          } catch {
            // Footer must never break the session.
          }

          const model = ctx.model?.id ?? "no-model";
          const thinking = pi.getThinkingLevel();
          const pressurePct =
            contextTokens !== null && contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null;
          const pressureColor = pressurePct === null ? "muted" : pressurePct < 50 ? "success" : pressurePct < 80 ? "warning" : "error";
          const pressure =
            pressurePct === null ? "—" : `${pressurePct.toFixed(0)}% of ${fmtTokens(contextWindow)}`;
          const branch = footerData.getGitBranch();

          const left = [
            theme.fg("accent", model),
            theme.fg("muted", `think ${thinking}`),
            theme.fg(pressureColor, pressure),
          ].join(sep);
          const right = [
            ...(branch ? [theme.fg("muted", ` ${branch}`)] : []),
            theme.fg("dim", `$${cost.toFixed(2)}`),
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
  }

  pi.on("session_start", (_event, ctx) => {
    if (enabled) install(ctx);
  });

  pi.registerCommand("footer", {
    description: "Toggle the Pickforge ember footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        install(ctx);
        ctx.ui.notify("ember footer on", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("built-in footer restored", "info");
      }
    },
  });
}
