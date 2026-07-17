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
        // Widget stays visible after completion; only /lanes hide or a new run replaces it.
        renderWidget(ctx, view);

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
