import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { Effort, KitEvent } from "../src/schema.ts";
import { appendEvent, newRunId } from "../src/journal-core.ts";

type JournalEvent = KitEvent extends infer Event
  ? Event extends KitEvent
    ? Omit<Event, "v" | "t" | "run">
    : never
  : never;

export default function journal(pi: ExtensionAPI) {
  let runId: string | undefined;
  let startedAt = 0;
  let mainCreated = false;
  let ended = false;
  let warned = false;

  function warn(ctx: ExtensionContext): void {
    if (warned) return;
    warned = true;
    try {
      ctx.ui.setStatus("pi-kit-journal", "journal unavailable");
    } catch {
      // The journal must never affect the parent session.
    }
  }

  function record(ctx: ExtensionContext, event: JournalEvent): void {
    if (!runId) return;
    try {
      appendEvent({ ...event, v: 1, t: new Date().toISOString(), run: runId } as KitEvent);
    } catch {
      warn(ctx);
    }
  }

  function ensureMain(ctx: ExtensionContext): void {
    if (mainCreated || !runId) return;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
    record(ctx, {
      type: "lane_created",
      lane: "main",
      spec: {
        lane: "main",
        task: "parent session",
        model,
        effort: pi.getThinkingLevel() as Effort,
        rationale: "parent session",
      },
    });
    mainCreated = true;
  }

  pi.on("session_start", (_event, ctx) => {
    warned = false;
    runId = undefined;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      runId = sessionId ? `sess-${sessionId}` : newRunId();
      startedAt = Date.now();
      mainCreated = false;
      ended = false;
      record(ctx, { type: "run_created", lanes: 1, origin: "session" });
    } catch {
      runId = undefined;
      warn(ctx);
    }
  });

  pi.on("turn_end", (event, ctx) => {
    try {
      ensureMain(ctx);
      const text = event.message.role === "assistant"
        ? event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" ")
            .replaceAll(/\s+/g, " ")
            .trim()
            .slice(0, 120)
        : "";
      if (text) record(ctx, { type: "lane_status", lane: "main", text });
    } catch {
      warn(ctx);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    try {
      ensureMain(ctx);
      const args = event.args as Record<string, unknown> | undefined;
      const detail = typeof args?.command === "string"
        ? args.command.slice(0, 60)
        : typeof args?.path === "string"
          ? args.path
          : JSON.stringify(args ?? {}) ?? "";
      const summary = detail.replaceAll(/\s+/g, " ").trim().slice(0, 120);
      record(ctx, { type: "lane_tool", lane: "main", tool: event.toolName, summary });
    } catch {
      warn(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ended) return;
    try {
      record(ctx, {
        type: "run_end",
        ok: true,
        durationMs: startedAt ? Date.now() - startedAt : 0,
      });
      ended = true;
    } catch {
      warn(ctx);
    }
  });
}
