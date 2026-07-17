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
  clearTimer?: NodeJS.Timeout;
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

function renderWidgetUnsafe(ctx: WidgetContext, run: LastRun): void {
  const lanes = [...run.projection.lanes.values()];
  const glyphs: Record<LaneProjection["state"], string> = {
    queued: "◷",
    running: "●",
    done: "✔",
    failed: "✖",
    abandoned: "⊘",
  };
  const lines = [
    `run ${run.id} · ${lanes.length} lanes · $${run.projection.totalCost.toFixed(4)} · ${run.projection.totalTokensIn}/${run.projection.totalTokensOut} tokens`,
    ...lanes.map((lane) => {
      const prefix = `${glyphs[lane.state]} ${lane.spec.lane} · ${lane.spec.model}:${lane.spec.effort} · tok ${lane.tokensIn}/${lane.tokensOut} · $${lane.cost.toFixed(4)}`;
      const activity = lane.currentTool ?? lane.lastStatus ?? "";
      return activity ? `${prefix} · ${activity}`.slice(0, 100) : prefix.slice(0, 100);
    }),
  ];
  ctx.ui.setWidget("pi-lanes", lines);
  const running = lanes.filter((lane) => lane.state === "running").length;
  ctx.ui.setStatus("pi-lanes", running > 0 ? `${running} running · $${run.projection.totalCost.toFixed(4)}` : undefined);
}

export default function lanesExtension(pi: ExtensionAPI): void {
  let lastRun: LastRun | undefined;

  pi.registerTool({
    name: "lanes_spawn",
    label: "Spawn lanes",
    description: `Run independent Pi lanes concurrently. You MUST state an explicit model and effort for every lane. Any effort off|minimal|low|medium|high|xhigh is allowed per lane (the value in parentheses is only that model's starting prior). Models: ${MODEL_TABLE.map((row) => `${row.selector} (prior ${row.prior})`).join(", ")}.`,
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

      const runId = newRunId();
      const startedAt = Date.now();
      let view: LastRun | undefined;
      let timer: NodeJS.Timeout | undefined;
      let runner: LaneRunner | undefined;
      const onAbort = () => runner?.abandonAll("aborted by parent");
      try {
        appendEvent({
          v: 1,
          t: new Date().toISOString(),
          run: runId,
          type: "run_created",
          lanes: specs.length,
          origin: "lanes_spawn",
        });

        const activeRunner = new LaneRunner({
          runId,
          append: appendEvent,
          onUpdate() {
            if (view && lastRun === view) renderWidget(ctx, view);
          },
        });
        runner = activeRunner;
        view = { id: runId, runner: activeRunner, projection: activeRunner.projection(), hidden: false };
        clearTimeout(lastRun?.clearTimer);
        lastRun = view;
        renderWidget(ctx, view);

        signal?.addEventListener("abort", onAbort, { once: true });
        timer = ctx.hasUI ? setInterval(() => renderWidget(ctx, view!), 1_000) : undefined;
        timer?.unref();
        const projections = await activeRunner.dispatch(specs);

        const ok = projections.every((lane) => lane.state === "done");
        appendEvent({
          v: 1,
          t: new Date().toISOString(),
          run: runId,
          type: "run_end",
          ok,
          durationMs: Date.now() - startedAt,
        });
        renderWidget(ctx, view);
        if (ctx.hasUI) {
          const closingView = view;
          closingView.clearTimer = setTimeout(() => {
            if (lastRun === closingView) {
              closingView.hidden = true;
              try {
                ctx.ui.setWidget("pi-lanes", undefined);
                ctx.ui.setStatus("pi-lanes", undefined);
              } catch {
                // UI teardown races are non-fatal.
              }
            }
          }, 30_000);
          closingView.clearTimer.unref();
        }

        const text = projections
          .map((lane) => {
            const answer = lane.answer?.replace(/\s+/g, " ").trim().slice(0, 400) ?? "";
            const failure = lane.state !== "done" ? ` · ${lane.abandonReason ?? "failed"}` : "";
            return `${lane.spec.lane}: ${lane.state} · ${lane.spec.model}:${lane.spec.effort} · tok ${lane.tokensIn}/${lane.tokensOut} · $${lane.cost.toFixed(4)}${failure}${answer ? ` · ${answer}` : ""}`;
          })
          .join("\n");
        return { content: [{ type: "text" as const, text }], details: projections, isError: !ok };
      } catch (error) {
        runner?.abandonAll("lanes_spawn error");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `lanes_spawn failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      } finally {
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
      }
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
          ctx.ui.notify("Usage: /lanes abandon <lane>", "warning");
          return;
        }
        lastRun.runner.abandon(lane, "user");
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
        clearTimeout(lastRun.clearTimer);
        lastRun.clearTimer = undefined;
        lastRun.hidden = false;
        renderWidget(ctx, lastRun);
        return;
      }
      ctx.ui.notify("Usage: /lanes [show|hide|last|abandon <lane>]", "warning");
    },
  });
}
