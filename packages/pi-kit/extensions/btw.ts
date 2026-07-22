import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { LaneCoordinator } from "../src/lane-coordinator.ts";
import type { Effort, LaneSpec } from "../src/schema.ts";
import { findModel, validateLaneSpec } from "../src/table.ts";

const MAX_NOTIFICATION_CHARS = 160;
const COLLAPSED_PREVIEW_CHARS = 280;

interface BtwEntryData {
  prompt: string;
  answer: string;
  state: "done" | "failed";
  model: string;
  effort: Effort;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Side-question UI is best effort.
  }
}

export default function btwExtension(pi: ExtensionAPI): void {
  const active = new Set<LaneCoordinator>();
  let shuttingDown = false;

  pi.registerMessageRenderer<BtwEntryData>("pi-btw", (message, { expanded }, theme) => {
    const data = message.details;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

    if (!data) {
      box.addChild(new Text(theme.fg("error", "▸ btw response unavailable"), 0, 0));
      return box;
    }

    const ok = data.state === "done";
    const label = theme.fg(ok ? "customMessageLabel" : "error", ok ? "▸ btw" : "▸ btw failed");
    const meta = theme.fg("dim", `${data.model} · ${data.effort}`);
    box.addChild(new Text(`${label}  ${meta}`, 0, 0));
    box.addChild(new Text(`${theme.fg("accent", "Q")} ${theme.fg("text", data.prompt)}`, 0, 0));

    const answer = data.answer.trim() || "No answer returned.";
    if (expanded) {
      box.addChild(new Text(theme.fg("accent", "A"), 0, 0));
      box.addChild(
        new Markdown(answer, 0, 0, getMarkdownTheme(), {
          color: (t) => theme.fg("customMessageText", t),
        }),
      );
    } else {
      const oneLine = answer.replace(/\s*\n+\s*/g, " ↵ ").trim();
      const preview =
        oneLine.length > COLLAPSED_PREVIEW_CHARS
          ? `${oneLine.slice(0, COLLAPSED_PREVIEW_CHARS - 1)}…`
          : oneLine;
      box.addChild(new Text(`${theme.fg("accent", "A")} ${theme.fg("customMessageText", preview)}`, 0, 0));
      box.addChild(new Text(theme.fg("dim", "ctrl+o expand · full answer in transcript"), 0, 0));
    }

    return box;
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    await Promise.allSettled([...active].map((coordinator) => coordinator.shutdown("session ended")));
  });

  pi.registerCommand("btw", {
    description: "Ask a secondary Pi process a side question without queueing or interrupting the parent session",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        notify(ctx, "Usage: /btw <question>", "warning");
        return;
      }

      try {
        const selector = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
        const model = findModel(selector);
        if (!model) {
          notify(ctx, `The current model cannot run /btw in the managed background pool: ${selector || "none"}`, "error");
          return;
        }

        const effort = pi.getThinkingLevel() as Effort;
        const spec: LaneSpec = {
          lane: "btw",
          task: [
            "Answer this side question independently and concisely.",
            "Do not modify files, continue the parent task, or ask the parent agent to act.",
            "",
            prompt,
          ].join("\n"),
          model: model.selector,
          effort,
          mode: "read-only",
          cwd: ctx.cwd,
          rationale: "Independent /btw side question",
        };
        const violation = validateLaneSpec(spec);
        if (violation) {
          notify(ctx, `Cannot start /btw: ${violation}`, "error");
          return;
        }

        const coordinator = new LaneCoordinator({ origin: "pi" });
        active.add(coordinator);
        notify(ctx, "btw running in a secondary process", "info");

        void coordinator
          .spawn([spec])
          .then(() => coordinator.wait())
          .then((snapshot) => {
            const lane = snapshot.lanes[0];
            const done = lane?.state === "done";
            if (shuttingDown) return;
            const answer = lane?.answer?.trim() || lane?.abandonReason || "No answer returned.";
            pi.sendMessage<BtwEntryData>(
              {
                customType: "pi-btw",
                content: answer,
                display: true,
                details: {
                  prompt,
                  answer,
                  state: done ? "done" : "failed",
                  model: model.selector,
                  effort,
                },
              },
              { deliverAs: "nextTurn" },
            );
            const toast = done
              ? `btw done — ${answer.slice(0, MAX_NOTIFICATION_CHARS)}${answer.length > MAX_NOTIFICATION_CHARS ? "…" : ""}`
              : `btw failed — ${answer.slice(0, MAX_NOTIFICATION_CHARS)}`;
            notify(ctx, toast, done ? "info" : "error");
          })
          .catch((error: unknown) => {
            if (shuttingDown) return;
            const answer = error instanceof Error ? error.message : String(error);
            pi.sendMessage<BtwEntryData>(
              {
                customType: "pi-btw",
                content: answer,
                display: true,
                details: {
                  prompt,
                  answer,
                  state: "failed",
                  model: model.selector,
                  effort,
                },
              },
              { deliverAs: "nextTurn" },
            );
            notify(ctx, `btw failed — ${answer.slice(0, MAX_NOTIFICATION_CHARS)}`, "error");
          })
          .finally(() => active.delete(coordinator));
      } catch (error) {
        notify(ctx, `Cannot start /btw: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
