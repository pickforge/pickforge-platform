import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendEvent, newRunId } from "../src/journal-core.ts";
import { LaneRunner } from "../src/runner.ts";
import type { LaneProjection, LaneSpec, RunProjection } from "../src/schema.ts";
import { MODEL_TABLE, validateLaneSpec } from "../src/table.ts";

interface LastRun {
  id: string;
  runner: LaneRunner;
  projection: RunProjection;
  hidden: boolean;
  /** Resolves when every lane settles. */
  settled: Promise<LaneProjection[]>;
  /** True once run_end was journaled and the summary is available. */
  ended: boolean;
  /** True once the model has consumed the final results (wait or nudge). */
  reported: boolean;
  /** Number of lanes_wait calls currently attached; suppresses the settle nudge. */
  waiters: number;
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
    // Widget rendering must never break the runner or the session.
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
  const lanes = [...run.projection.lanes.values()];
  spinnerTick = (spinnerTick + 1) % SPINNER.length;

  const stateGlyph = (state: LaneProjection["state"]): string => {
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
    theme.fg("warning", `$${run.projection.totalCost.toFixed(4)}`),
    theme.fg("muted", `↑${fmtTokens(run.projection.totalTokensIn)} ↓${fmtTokens(run.projection.totalTokensOut)}`),
  ].join(dot);

  const nameWidth = Math.min(24, Math.max(...lanes.map((l) => l.spec.lane.length), 4));
  const lines = [
    header,
    ...lanes.map((lane) => {
      const name =
        lane.state === "running"
          ? theme.fg("text", lane.spec.lane.padEnd(nameWidth))
          : theme.fg("muted", lane.spec.lane.padEnd(nameWidth));
      const model = theme.fg("dim", `${shortModel(lane.spec.model)}:${lane.spec.effort}`);
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
      ? theme.fg("accent", `▸ ${running} lane${running === 1 ? "" : "s"} running · $${run.projection.totalCost.toFixed(4)}`)
      : failed > 0
        ? theme.fg("error", `▸ lanes: ${done}✔ ${failed}✖`)
        : theme.fg("success", `▸ lanes: ${done}/${lanes.length} ✔`),
  );
}

export default function lanesExtension(pi: ExtensionAPI): void {
  let lastRun: LastRun | undefined;

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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const specs: LaneSpec[] = params.lanes.map((lane: SpawnLaneInput, index: number) => ({
        lane: lane.lane?.trim() || `lane-${index + 1}`,
        task: lane.task,
        model: lane.model,
        effort: lane.effort as LaneSpec["effort"],
        ...(lane.cwd ? { cwd: lane.cwd } : {}),
        ...(lane.rationale ? { rationale: lane.rationale } : {}),
      }));
      const violations = specs.flatMap((spec) => {
        const reason = validateLaneSpec(spec);
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

      const runId = newRunId();
      const startedAt = Date.now();
      appendEvent({
        v: 1,
        t: new Date().toISOString(),
        run: runId,
        type: "run_created",
        lanes: specs.length,
        origin: "lanes_spawn",
      });

      let view: LastRun;
      const activeRunner = new LaneRunner({
        runId,
        append: appendEvent,
        onUpdate() {
          if (view && lastRun === view) renderWidget(ctx, view);
        },
      });

      // Deliberately NOT wired to the tool-call abort signal: lanes survive
      // ESC / turn cancellation. Stopping a run is explicit via lanes_abandon
      // or /lanes abandon.
      const timer = ctx.hasUI ? setInterval(() => renderWidget(ctx, view), 1_000) : undefined;
      timer?.unref();

      const settled = activeRunner
        .dispatch(specs)
        .then((projections) => {
          const ok = projections.every((lane) => lane.state === "done");
          appendEvent({
            v: 1,
            t: new Date().toISOString(),
            run: runId,
            type: "run_end",
            ok,
            durationMs: Date.now() - startedAt,
          });
          return projections;
        })
        .catch((error: unknown) => {
          activeRunner.abandonAll("lanes run error");
          appendEvent({
            v: 1,
            t: new Date().toISOString(),
            run: runId,
            type: "run_end",
            ok: false,
            durationMs: Date.now() - startedAt,
          });
          return [...activeRunner.projection().lanes.values()];
        })
        .finally(() => {
          clearInterval(timer);
          view.ended = true;
          // Widget stays visible after completion; only /lanes hide or a new run replaces it.
          if (lastRun === view) renderWidget(ctx, view);
          // Nudge the model when it is idle and never collected the results.
          if (lastRun === view && !view.reported && view.waiters === 0) {
            try {
              if (ctx.isIdle()) {
                view.reported = true;
                pi.sendUserMessage(
                  `[lanes] run ${runId} settled. Call lanes_status for the results, then continue where we left off.`,
                );
              } else {
                pi.sendUserMessage(
                  `[lanes] run ${runId} settled — results available via lanes_status/lanes_wait when convenient.`,
                  { deliverAs: "followUp" },
                );
              }
            } catch {
              // Nudge is best-effort; lanes_status still works.
            }
          }
        });

      view = {
        id: runId,
        runner: activeRunner,
        projection: activeRunner.projection(),
        hidden: false,
        settled,
        ended: false,
        reported: false,
        waiters: 0,
      };
      lastRun = view;
      renderWidget(ctx, view);

      const text = [
        `Run ${runId} spawned with ${specs.length} lane${specs.length === 1 ? "" : "s"} (non-blocking):`,
        ...specs.map((spec) => `  ${spec.lane}: ${spec.model}:${spec.effort}`),
        "Lanes run in the background and survive turn cancellation.",
        "Use lanes_status to check progress or answer questions about a lane, lanes_wait to block for final results, lanes_abandon to stop lanes.",
        "You can keep working with the user meanwhile — do not poll lanes_status in a loop.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: { run: runId, lanes: specs.length } };
    },
  });

  function summarizeLane(lane: LaneProjection, verbose: boolean): string {
    const answerLimit = verbose ? 4_000 : 400;
    const answer = lane.answer?.replace(/\s+/g, " ").trim().slice(0, answerLimit) ?? "";
    const failure = lane.state === "failed" || lane.state === "abandoned" ? ` · ${lane.abandonReason ?? "failed"}` : "";
    const activity =
      lane.state === "running" ? ` · ${(lane.currentTool ?? lane.lastStatus ?? "working").slice(0, verbose ? 200 : 60)}` : "";
    const duration = lane.durationMs !== undefined ? ` · ${fmtDuration(lane.durationMs)}` : "";
    return `${lane.spec.lane}: ${lane.state} · ${lane.spec.model}:${lane.spec.effort} · tok ${lane.tokensIn}/${lane.tokensOut} · $${lane.cost.toFixed(4)}${duration}${failure}${activity}${answer ? ` · ${answer}` : ""}`;
  }

  function summarizeRun(run: LastRun, laneFilter?: string): { text: string; lanes: LaneProjection[]; missing?: string } {
    const all = [...run.projection.lanes.values()];
    if (laneFilter) {
      const lane = run.projection.lanes.get(laneFilter);
      if (!lane) return { text: "", lanes: [], missing: laneFilter };
      return { text: `run ${run.id} (${run.ended ? "ended" : "active"})\n${summarizeLane(lane, true)}`, lanes: [lane] };
    }
    const header = `run ${run.id} (${run.ended ? "ended" : "active"}) · $${run.projection.totalCost.toFixed(4)} · tok ${run.projection.totalTokensIn}/${run.projection.totalTokensOut}`;
    return { text: [header, ...all.map((lane) => summarizeLane(lane, run.ended))].join("\n"), lanes: all };
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
      if (!lastRun) {
        return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
      }
      const { text, missing } = summarizeRun(lastRun, params.lane);
      if (missing) {
        const known = [...lastRun.projection.lanes.keys()].join(", ");
        return {
          content: [{ type: "text" as const, text: `Unknown lane "${missing}". Lanes in run ${lastRun.id}: ${known}` }],
          details: undefined,
          isError: true,
        };
      }
      if (lastRun.ended) lastRun.reported = true;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "lanes_wait",
    label: "Wait for lanes",
    description:
      "Block until the current lane run settles and return the final per-lane results. Call this when you have nothing else to do for the user, or when the user asks for the results. Cancelling this wait does NOT stop the lanes — they keep running and lanes_status/lanes_wait remain available.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (!lastRun) {
        return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
      }
      const run = lastRun;
      if (!run.ended) {
        // Wait for settlement or the tool call being aborted — abort only
        // detaches the wait, it never touches the lanes themselves.
        run.waiters++;
        try {
          await Promise.race([
            run.settled,
            new Promise<void>((resolve) => {
              if (!signal) return;
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        } finally {
          run.waiters--;
        }
        if (!run.ended) {
          return {
            content: [
              { type: "text" as const, text: `Wait detached; run ${run.id} keeps running. Use lanes_status or lanes_wait again.` },
            ],
            details: undefined,
          };
        }
      }
      run.reported = true;
      const { text, lanes } = summarizeRun(run);
      const ok = lanes.every((lane) => lane.state === "done");
      return { content: [{ type: "text" as const, text }], details: lanes, isError: !ok };
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
      if (!lastRun) {
        return { content: [{ type: "text" as const, text: "No lane run has been spawned this session." }], details: undefined };
      }
      const reason = params.reason?.trim() || "abandoned by model";
      if (params.lane) {
        if (!lastRun.projection.lanes.has(params.lane)) {
          const known = [...lastRun.projection.lanes.keys()].join(", ");
          return {
            content: [{ type: "text" as const, text: `Unknown lane "${params.lane}". Lanes: ${known}` }],
            details: undefined,
            isError: true,
          };
        }
        lastRun.runner.abandon(params.lane, reason);
      } else {
        lastRun.runner.abandonAll(reason);
      }
      renderWidget(ctx, lastRun);
      const { text } = summarizeRun(lastRun);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.registerCommand("lanes", {
    description: "Show, hide, summarize, or abandon lanes",
    handler: async (args, ctx) => {
      const [command = "show", lane] = (args.trim() || "show").split(/\s+/, 2);
      if (command === "hide") {
        if (lastRun) lastRun.hidden = true;
        ctx.ui.setWidget("pi-lanes", undefined);
        ctx.ui.setStatus("pi-lanes", undefined);
        return;
      }
      if (!lastRun) {
        ctx.ui.notify("No lane run is available", "info");
        return;
      }
      if (command === "abandon") {
        if (!lane) {
          ctx.ui.notify("Usage: /lanes abandon <lane|all>", "warning");
          return;
        }
        if (lane === "all") {
          lastRun.runner.abandonAll("user");
        } else {
          lastRun.runner.abandon(lane, "user");
        }
        renderWidget(ctx, lastRun);
        return;
      }
      if (command === "last") {
        const lanes = [...lastRun.projection.lanes.values()];
        const running = lanes.filter((item) => item.state === "running").length;
        ctx.ui.notify(
          `run ${lastRun.id} · ${running} running · ${lanes.length} lanes · $${lastRun.projection.totalCost.toFixed(4)} · ${lastRun.projection.totalTokensIn}/${lastRun.projection.totalTokensOut} tokens`,
          "info",
        );
        return;
      }
      if (command === "show") {
        lastRun.hidden = false;
        renderWidget(ctx, lastRun);
        return;
      }
      ctx.ui.notify("Usage: /lanes [show|hide|last|abandon <lane|all>]", "warning");
    },
  });
}
