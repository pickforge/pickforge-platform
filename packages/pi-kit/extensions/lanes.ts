import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  LaneCoordinator,
  type LaneSnapshotDto,
  type RunSnapshotDto,
} from "../src/lane-coordinator.ts";
import { LanesTuiComponent } from "../src/lanes-tui.ts";
import { LaneRunner } from "../src/runner.ts";
import type { LaneSpec } from "../src/schema.ts";
import { MODEL_TABLE, validateLaneSpec } from "../src/table.ts";

export interface LanesCoordinatorPort {
  spawn(specs: LaneSpec[]): Promise<RunSnapshotDto>;
  status(lane?: string): RunSnapshotDto;
  wait(signal?: AbortSignal): Promise<RunSnapshotDto>;
  abandon(input: { lane?: string; reason?: string }): RunSnapshotDto;
  shutdown(reason: string): Promise<void>;
}

export interface LanesExtensionOptions {
  createCoordinator?: () => LanesCoordinatorPort;
}

interface LastRun {
  id: string;
  snapshot: RunSnapshotDto;
  ctx: ExtensionContext;
  hidden: boolean;
  /** True once the coordinated run has settled and the summary is available. */
  ended: boolean;
  /** True once the model has consumed the final results (wait or nudge). */
  reported: boolean;
  /** Number of lanes_wait calls currently attached; suppresses the settle nudge. */
  waiters: number;
  timer?: NodeJS.Timeout;
}

interface SpawnLaneInput {
  lane?: string;
  task: string;
  model: string;
  effort: string;
  cwd?: string;
  rationale?: string;
}

type WidgetContext = Pick<ExtensionContext, "hasUI" | "ui">;

function renderWidget(ctx: WidgetContext, run: LastRun): void {
  if (!ctx.hasUI || run.hidden) return;
  try {
    renderWidgetUnsafe(ctx, run);
  } catch {
    // Widget rendering must never break the coordinator or the session.
  }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTick = 0;

function shortModel(selector: string): string {
  return selector.slice(selector.indexOf("/") + 1);
}

function fmtTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function renderWidgetUnsafe(ctx: WidgetContext, run: LastRun): void {
  const theme = ctx.ui.theme;
  const lanes = run.snapshot.lanes;
  spinnerTick = (spinnerTick + 1) % SPINNER.length;

  const stateGlyph = (state: LaneSnapshotDto["state"]): string => {
    switch (state) {
      case "queued":
        return theme.fg("dim", "◌");
      case "running":
        return theme.fg("accent", SPINNER[spinnerTick]!);
      case "done":
        return theme.fg("success", "✔");
      case "failed":
        return theme.fg("error", "✖");
      case "abandoned":
        return theme.fg("warning", "⊘");
    }
  };

  const done = lanes.filter((l) => l.state === "done").length;
  const running = lanes.filter((l) => l.state === "running").length;
  const failed = lanes.filter((l) => l.state === "failed" || l.state === "abandoned").length;
  const settled = done + failed;

  const progress = lanes
    .map((l) =>
      l.state === "done"
        ? theme.fg("success", "■")
        : l.state === "running"
          ? theme.fg("accent", "▣")
          : l.state === "queued"
            ? theme.fg("dim", "□")
            : theme.fg("error", "■"),
    )
    .join("");

  const dot = theme.fg("dim", " · ");
  const header = [
    theme.fg("accent", "▸ lanes"),
    theme.fg("muted", run.id),
    `${progress} ${theme.fg("text", `${settled}/${lanes.length}`)}`,
    theme.fg("warning", `$${run.snapshot.totals.cost.toFixed(4)}`),
    theme.fg("muted", `↑${fmtTokens(run.snapshot.totals.tokensIn)} ↓${fmtTokens(run.snapshot.totals.tokensOut)}`),
  ].join(dot);

  const nameWidth = Math.min(24, Math.max(...lanes.map((l) => l.lane.length), 4));
  const lines = [
    header,
    ...lanes.map((lane) => {
      const name =
        lane.state === "running"
          ? theme.fg("text", lane.lane.padEnd(nameWidth))
          : theme.fg("muted", lane.lane.padEnd(nameWidth));
      const model = theme.fg("dim", `${shortModel(lane.model)}:${lane.effort}`);
      const tokens = theme.fg("muted", `↑${fmtTokens(lane.tokensIn)} ↓${fmtTokens(lane.tokensOut)}`);
      const cost = theme.fg("warning", `$${lane.cost.toFixed(4)}`);
      const parts = [`${stateGlyph(lane.state)} ${name}`, model, tokens, cost];
      if (lane.durationMs !== undefined) parts.push(theme.fg("dim", fmtDuration(lane.durationMs)));
      if (lane.state === "failed" || lane.state === "abandoned") {
        parts.push(theme.fg("error", (lane.abandonReason ?? "failed").slice(0, 40)));
      } else {
        const activity = lane.currentTool ?? lane.lastStatus ?? "";
        if (activity) parts.push(theme.fg("dim", activity.slice(0, 44)));
      }
      return `  ${parts.join(dot)}`;
    }),
  ];
  ctx.ui.setWidget("pi-lanes", lines);
  ctx.ui.setStatus(
    "pi-lanes",
    running > 0
      ? theme.fg("accent", `▸ ${running} lane${running === 1 ? "" : "s"} running · $${run.snapshot.totals.cost.toFixed(4)}`)
      : failed > 0
        ? theme.fg("error", `▸ lanes: ${done}✔ ${failed}✖`)
        : theme.fg("success", `▸ lanes: ${done}/${lanes.length} ✔`),
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function toolFailure(name: string, error: unknown) {
  return {
    content: [{ type: "text" as const, text: `${name} failed: ${errorMessage(error)}` }],
    details: undefined,
    isError: true,
  };
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Notifications are best-effort.
  }
}

function clearWidget(ctx: ExtensionContext): void {
  try {
    ctx.ui.setWidget("pi-lanes", undefined);
  } catch {
    // UI cleanup is best-effort.
  }
  try {
    ctx.ui.setStatus("pi-lanes", undefined);
  } catch {
    // UI cleanup is best-effort.
  }
}

export default function lanesExtension(pi: ExtensionAPI, options: LanesExtensionOptions = {}): void {
  let lastRun: LastRun | undefined;
  const coordinator =
    options.createCoordinator?.() ??
    new LaneCoordinator({
      origin: "pi",
      createRunner: (runnerOptions) =>
        new LaneRunner({
          ...runnerOptions,
          onUpdate() {
            try {
              if (lastRun?.id === runnerOptions.runId) renderLiveWidget(lastRun.ctx, lastRun);
            } catch {
              // Runner updates must never escape into the coordinated lifecycle.
            }
          },
        }),
    });

  function updateRun(run: LastRun, snapshot: RunSnapshotDto): void {
    if (snapshot.run !== run.id) return;
    run.snapshot = snapshot;
    run.ended = snapshot.state === "ended";
  }

  function refreshRun(run: LastRun): void {
    updateRun(run, coordinator.status());
  }

  function renderLiveWidget(ctx: ExtensionContext, run: LastRun): void {
    try {
      refreshRun(run);
    } catch {
      // A stale snapshot is sufficient for best-effort UI rendering.
    }
    renderWidget(ctx, run);
  }

  function sendSettleNudge(run: LastRun, ctx: ExtensionContext): void {
    if (lastRun !== run || !run.ended || run.reported || run.waiters > 0) return;
    try {
      if (ctx.isIdle()) {
        run.reported = true;
        pi.sendUserMessage(
          `[lanes] run ${run.id} settled. Call lanes_status for the results, then continue where we left off.`,
        );
      } else {
        pi.sendUserMessage(
          `[lanes] run ${run.id} settled — results available via lanes_status/lanes_wait when convenient.`,
          { deliverAs: "followUp" },
        );
      }
    } catch {
      // Nudge is best-effort; lanes_status still works.
    }
  }

  async function monitorSettlement(run: LastRun, ctx: ExtensionContext): Promise<void> {
    try {
      updateRun(run, await coordinator.wait());
    } catch {
      return;
    } finally {
      clearInterval(run.timer);
      if (lastRun === run) renderWidget(ctx, run);
    }
    sendSettleNudge(run, ctx);
  }

  // Lanes survive ESC/turn cancellation, but not the session itself: on
  // shutdown (/new, reload, exit) active children are stopped and reaped.
  pi.on("session_shutdown", async () => {
    if (lastRun) lastRun.reported = true;
    try {
      await coordinator.shutdown("session ended");
      if (lastRun) {
        try {
          refreshRun(lastRun);
        } catch {
          // Shutdown status refresh is best-effort.
        }
        renderWidget(lastRun.ctx, lastRun);
      }
    } catch {
      // Session shutdown must never escape into the parent session.
    } finally {
      if (lastRun) clearInterval(lastRun.timer);
    }
  });

  pi.registerTool({
    name: "lanes_spawn",
    label: "Spawn lanes",
    description: `Spawn independent Pi lanes that run concurrently in the background (non-blocking: this tool returns immediately; lanes survive turn cancellation). Collect results with lanes_wait, inspect progress or a specific lane with lanes_status, stop lanes only with lanes_abandon. While lanes run you can keep working with the user. You MUST state an explicit model and effort for every lane. Any effort off|minimal|low|medium|high|xhigh is allowed per lane (the value in parentheses is only that model's starting prior). Models: ${MODEL_TABLE.map((row) => `${row.selector} (prior ${row.prior})`).join(", ")}.`,
    parameters: Type.Object({
      lanes: Type.Array(
        Type.Object({
          lane: Type.Optional(Type.String()),
          task: Type.String(),
          model: Type.String(),
          effort: Type.String(),
          cwd: Type.Optional(Type.String()),
          rationale: Type.Optional(Type.String()),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const specs: LaneSpec[] = params.lanes.map((lane: SpawnLaneInput, index: number) => ({
          lane: lane.lane?.trim() || `lane-${index + 1}`,
          task: lane.task,
          model: lane.model,
          effort: lane.effort as LaneSpec["effort"],
          ...(lane.cwd ? { cwd: lane.cwd } : {}),
          ...(lane.rationale ? { rationale: lane.rationale } : {}),
        }));
        const violations = specs.flatMap((spec) => {
          const reason = validateLaneSpec(spec, { origin: "pi" });
          return reason ? [`${spec.lane}: ${reason}`] : [];
        });
        if (violations.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Invalid lane specs:\n${violations.join("\n")}` }],
            details: { violations },
            isError: true,
          };
        }

        if (lastRun && !lastRun.ended) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Run ${lastRun.id} is still active. Use lanes_status to inspect it, lanes_wait to collect it, or lanes_abandon to stop it before spawning a new run.`,
              },
            ],
            details: { activeRun: lastRun.id },
            isError: true,
          };
        }

        // Deliberately NOT wired to the tool-call abort signal: lanes survive
        // ESC / turn cancellation. Stopping is explicit via lanes_abandon.
        const snapshot = await coordinator.spawn(specs);
        const view: LastRun = {
          id: snapshot.run,
          snapshot,
          ctx,
          hidden: false,
          ended: snapshot.state === "ended",
          reported: false,
          waiters: 0,
        };
        if (ctx.hasUI && !view.ended) {
          view.timer = setInterval(() => renderLiveWidget(ctx, view), 1_000);
          view.timer.unref();
        }
        lastRun = view;
        renderWidget(ctx, view);
        void monitorSettlement(view, ctx);

        const text = [
          `Run ${view.id} spawned with ${specs.length} lane${specs.length === 1 ? "" : "s"} (non-blocking):`,
          ...specs.map((spec) => `  ${spec.lane}: ${spec.model}:${spec.effort}`),
          "Lanes run in the background and survive turn cancellation.",
          "Use lanes_status to check progress or answer questions about a lane, lanes_wait to block for final results, lanes_abandon to stop lanes.",
          "You can keep working with the user meanwhile — do not poll lanes_status in a loop.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }], details: { run: view.id, lanes: specs.length } };
      } catch (error) {
        return toolFailure("lanes_spawn", error);
      }
    },
  });

  function summarizeLane(lane: LaneSnapshotDto, verbose: boolean): string {
    const answerLimit = verbose ? 4_000 : 400;
    const answer = lane.answer?.replace(/\s+/g, " ").trim().slice(0, answerLimit) ?? "";
    const failure = lane.state === "failed" || lane.state === "abandoned" ? ` · ${lane.abandonReason ?? "failed"}` : "";
    const activity =
      lane.state === "running" ? ` · ${(lane.currentTool ?? lane.lastStatus ?? "working").slice(0, verbose ? 200 : 60)}` : "";
    const duration = lane.durationMs !== undefined ? ` · ${fmtDuration(lane.durationMs)}` : "";
    return `${lane.lane}: ${lane.state} · ${lane.model}:${lane.effort} · tok ${lane.tokensIn}/${lane.tokensOut} · $${lane.cost.toFixed(4)}${duration}${failure}${activity}${answer ? ` · ${answer}` : ""}`;
  }

  function summarizeRun(snapshot: RunSnapshotDto, laneFilter?: string): { text: string; lanes: LaneSnapshotDto[] } {
    if (laneFilter) {
      const lane = snapshot.lanes[0]!;
      return {
        text: `run ${snapshot.run} (${snapshot.state})\n${summarizeLane(lane, true)}`,
        lanes: [lane],
      };
    }
    const header = `run ${snapshot.run} (${snapshot.state}) · $${snapshot.totals.cost.toFixed(4)} · tok ${snapshot.totals.tokensIn}/${snapshot.totals.tokensOut}`;
    return { text: [header, ...snapshot.lanes.map((lane) => summarizeLane(lane, snapshot.state === "ended"))].join("\n"), lanes: snapshot.lanes };
  }

  pi.registerTool({
    name: "lanes_status",
    label: "Lane status",
    description:
      "Report live status of the current lane run without blocking: per-lane state, current activity, tokens, cost, and (for settled lanes) answers. Pass `lane` for a detailed view of one lane — use this when the user asks about a specific lane. Do not call in a polling loop; prefer lanes_wait when you only need the final results.",
    parameters: Type.Object({
      lane: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!lastRun) {
          return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
        }
        if (params.lane && !lastRun.snapshot.lanes.some((lane) => lane.lane === params.lane)) {
          const known = lastRun.snapshot.lanes.map((lane) => lane.lane).join(", ");
          return {
            content: [{ type: "text" as const, text: `Unknown lane "${params.lane}". Lanes in run ${lastRun.id}: ${known}` }],
            details: undefined,
            isError: true,
          };
        }
        const snapshot = coordinator.status(params.lane);
        if (!params.lane) updateRun(lastRun, snapshot);
        else lastRun.ended = snapshot.state === "ended";
        if (snapshot.state === "ended") lastRun.reported = true;
        const { text } = summarizeRun(snapshot, params.lane);
        return { content: [{ type: "text" as const, text }], details: undefined };
      } catch (error) {
        return toolFailure("lanes_status", error);
      }
    },
  });

  pi.registerTool({
    name: "lanes_wait",
    label: "Wait for lanes",
    description:
      "Block until the current lane run settles and return the final per-lane results. Call this when you have nothing else to do for the user, or when the user asks for the results. Cancelling this wait does NOT stop the lanes — they keep running and lanes_status/lanes_wait remain available.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      let attachedRun: LastRun | undefined;
      try {
        if (!lastRun) {
          return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
        }
        const run = lastRun;
        let snapshot = run.snapshot;
        if (run.ended) {
          snapshot = coordinator.status();
          updateRun(run, snapshot);
        } else {
          run.waiters++;
          attachedRun = run;
          snapshot = await coordinator.wait(signal);
          updateRun(run, snapshot);
          if (snapshot.state !== "ended") {
            return {
              content: [
                { type: "text" as const, text: `Wait detached; run ${run.id} keeps running. Use lanes_status or lanes_wait again.` },
              ],
              details: undefined,
            };
          }
        }
        run.reported = true;
        const { text, lanes } = summarizeRun(snapshot);
        const ok = lanes.every((lane) => lane.state === "done");
        return { content: [{ type: "text" as const, text }], details: lanes, isError: !ok };
      } catch (error) {
        return toolFailure("lanes_wait", error);
      } finally {
        if (attachedRun) attachedRun.waiters--;
      }
    },
  });

  pi.registerTool({
    name: "lanes_abandon",
    label: "Abandon lanes",
    description:
      "Explicitly stop lanes of the current run. Pass `lane` to stop one lane, omit it to stop all. This is the only way to stop lanes — they are not cancelled by ESC or turn cancellation.",
    parameters: Type.Object({
      lane: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (!lastRun) {
          return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
        }
        if (params.lane && !lastRun.snapshot.lanes.some((lane) => lane.lane === params.lane)) {
          const known = lastRun.snapshot.lanes.map((lane) => lane.lane).join(", ");
          return {
            content: [{ type: "text" as const, text: `Unknown lane "${params.lane}". Lanes: ${known}` }],
            details: undefined,
            isError: true,
          };
        }
        const reason = params.reason?.trim() || "abandoned by model";
        updateRun(lastRun, coordinator.abandon({ ...(params.lane ? { lane: params.lane } : {}), reason }));
        renderWidget(ctx, lastRun);
        const { text } = summarizeRun(lastRun.snapshot);
        return { content: [{ type: "text" as const, text }], details: undefined };
      } catch (error) {
        return toolFailure("lanes_abandon", error);
      }
    },
  });

  pi.registerCommand("lanes", {
    description: "Show, hide, summarize, abandon lanes, or open the full-screen TUI",
    handler: async (args, ctx) => {
      try {
        const [command = "show", lane] = (args.trim() || "show").split(/\s+/, 2);
        if (command === "tui") {
          if (!ctx.hasUI) {
            safeNotify(ctx, "lanes tui requires interactive mode", "warning");
            return;
          }
          await ctx.ui.custom<void>(
            (tui, theme, _keybindings, done) => new LanesTuiComponent(tui, theme, () => done(undefined), lastRun?.id),
            {
              overlay: true,
              overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 },
            },
          );
          return;
        }
        if (command === "hide") {
          if (lastRun) lastRun.hidden = true;
          clearWidget(ctx);
          return;
        }
        if (!lastRun) {
          safeNotify(ctx, "No lane run is available", "info");
          return;
        }
        if (command === "abandon") {
          if (!lane) {
            safeNotify(ctx, "Usage: /lanes abandon <lane|all>", "warning");
            return;
          }
          if (lane !== "all" && !lastRun.snapshot.lanes.some((item) => item.lane === lane)) return;
          updateRun(
            lastRun,
            coordinator.abandon(lane === "all" ? { reason: "user" } : { lane, reason: "user" }),
          );
          renderWidget(ctx, lastRun);
          return;
        }
        if (command === "last") {
          refreshRun(lastRun);
          const lanes = lastRun.snapshot.lanes;
          const running = lanes.filter((item) => item.state === "running").length;
          safeNotify(
            ctx,
            `run ${lastRun.id} · ${running} running · ${lanes.length} lanes · $${lastRun.snapshot.totals.cost.toFixed(4)} · ${lastRun.snapshot.totals.tokensIn}/${lastRun.snapshot.totals.tokensOut} tokens`,
            "info",
          );
          return;
        }
        if (command === "show") {
          lastRun.hidden = false;
          renderLiveWidget(ctx, lastRun);
          return;
        }
        safeNotify(ctx, "Usage: /lanes [show|hide|last|tui|abandon <lane|all>]", "warning");
      } catch (error) {
        safeNotify(ctx, `lanes command failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
