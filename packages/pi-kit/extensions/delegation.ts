/**
 * pi-kit delegation observability — measures how much tool work the
 * orchestrator does directly vs. delegates to lanes.
 *
 * Shows `delegation N% · X lanes / Y direct` in the footer once the session
 * has meaningful tool activity, and journals the final counts at shutdown.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../src/journal-core.ts";
import { emptyCounts, recordTool, summarize, type DelegationCounts } from "../src/delegation-core.ts";

const MIN_TOOLS_FOR_STATUS = 5;

export default function delegation(pi: ExtensionAPI) {
  let counts: DelegationCounts = emptyCounts();
  let sessionId: string | undefined;

  function refresh(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      if (counts.direct + counts.lanes >= MIN_TOOLS_FOR_STATUS) {
        ctx.ui.setStatus("pi-delegation", summarize(counts));
      }
    } catch {
      // Observability must never break the session.
    }
  }

  pi.on("session_start", (_event, ctx) => {
    counts = emptyCounts();
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      sessionId = undefined;
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const args = event.args as { lanes?: unknown[] } | undefined;
    const laneCount = Array.isArray(args?.lanes) ? args.lanes.length : 1;
    counts = recordTool(counts, event.toolName, laneCount);
    refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    if (counts.direct + counts.lanes === 0 || !sessionId) return;
    try {
      appendEvent({
        v: 1,
        t: new Date().toISOString(),
        run: `sess-${sessionId}`,
        type: "lane_status",
        lane: "main",
        text: summarize(counts),
      });
    } catch {
      // Journal is best effort.
    }
  });
}
