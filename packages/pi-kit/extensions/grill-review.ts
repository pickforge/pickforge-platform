import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";

type AnnotationResult = {
  feedback?: string;
  approved?: boolean;
  exit?: boolean;
};

type PlannotatorResponse =
  | { status: "handled"; result: AnnotationResult }
  | { status: "unavailable"; error?: string }
  | { status: "error"; error: string };

export type GrillReviewOutcome =
  | { status: "feedback"; feedback: string }
  | { status: "approved" }
  | { status: "closed" }
  | { status: "error"; error: string };

type NotificationContext = Pick<ExtensionCommandContext | ExtensionContext, "ui">;

function safeNotify(ctx: NotificationContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Review UX must never break the parent session.
  }
}

function fallbackPlannotatorUrl(): string {
  return `http://localhost:${process.env.PLANNOTATOR_PORT || "19432"}/`;
}

async function notifyPlannotatorUrl(
  pi: ExtensionAPI,
  ctx: NotificationContext,
  signal?: AbortSignal,
): Promise<void> {
  let url = fallbackPlannotatorUrl();
  try {
    const result = await pi.exec("plannotator-url", [], { timeout: 1_500, signal });
    const candidate = result.stdout.trim();
    if (result.code === 0 && /^https?:\/\/\S+\/$/.test(candidate)) {
      url = candidate;
    }
  } catch {
    // The loopback URL remains usable when the managed helper is unavailable.
  }
  if (signal?.aborted) {
    throw new Error("Grill review was cancelled before opening.");
  }
  safeNotify(ctx, `Open Plannotator: ${url}`, "info");
}

function hasPlannotator(pi: ExtensionAPI): boolean {
  try {
    return pi.getCommands().some((command) =>
      command.name === "plannotator-last" || command.name.startsWith("plannotator-last:"),
    );
  } catch {
    return false;
  }
}

export function openGrillReview(pi: ExtensionAPI, signal?: AbortSignal): Promise<GrillReviewOutcome> {
  if (!hasPlannotator(pi)) {
    return Promise.resolve({
      status: "error",
      error: "Plannotator is not loaded. Enable npm:@plannotator/pi-extension and reload Pi.",
    });
  }

  if (signal?.aborted) {
    return Promise.resolve({ status: "error", error: "Grill review was cancelled before opening." });
  }

  return new Promise((resolve) => {
    let settled = false;

    // Plannotator owns the browser session and exposes no cancellation handle.
    // Once opened, its human decision remains authoritative even if Pi is interrupted.
    const finish = (outcome: GrillReviewOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
        requestId: randomUUID(),
        action: "annotate-last",
        payload: {
          filePath: "assistant-message",
          mode: "annotate-last",
          gate: true,
        },
        respond: (response: PlannotatorResponse) => {
          if (response.status === "error" || response.status === "unavailable") {
            finish({ status: "error", error: response.error ?? "Plannotator review is unavailable." });
            return;
          }

          const feedback = response.result.feedback?.trim();
          if (feedback) {
            finish({ status: "feedback", feedback });
          } else if (response.result.approved) {
            finish({ status: "approved" });
          } else {
            finish({ status: "closed" });
          }
        },
      });
    } catch (error) {
      finish({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function outcomeText(outcome: GrillReviewOutcome): string {
  switch (outcome.status) {
    case "feedback":
      return `Grill review feedback:\n\n${outcome.feedback}`;
    case "approved":
      return "Grill review approved. Continue with the current direction.";
    case "closed":
      return "Grill review closed without feedback.";
    case "error":
      return outcome.error;
  }
}

export default function grillReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grill_review",
    label: "Grill review",
    description: "Open Plannotator on the latest assistant question batch and return the human's annotations as structured feedback.",
    promptSnippet: "Open Plannotator to review the latest question batch",
    promptGuidelines: [
      "Use grill_review after presenting a compact numbered batch of related decisions or clarification questions when inline annotation would make answering easier; do not use it for a single simple question or facts the agent can discover itself.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (!hasPlannotator(pi)) {
        throw new Error("Plannotator is not loaded. Enable npm:@plannotator/pi-extension and reload Pi.");
      }
      if (signal?.aborted) {
        throw new Error("Grill review was cancelled before opening.");
      }

      await notifyPlannotatorUrl(pi, ctx, signal);
      const outcome = await openGrillReview(pi, signal);
      if (outcome.status === "error") {
        throw new Error(outcome.error);
      }
      return {
        content: [{ type: "text" as const, text: outcomeText(outcome) }],
        details: outcome,
      };
    },
  });

  pi.registerCommand("grill-review", {
    description: "Review the latest assistant question batch in Plannotator",
    handler: async (_args, ctx) => {
      try {
        await ctx.waitForIdle();
        if (!hasPlannotator(pi)) {
          safeNotify(ctx, "Plannotator is not loaded. Enable npm:@plannotator/pi-extension and reload Pi.", "error");
          return;
        }
        await notifyPlannotatorUrl(pi, ctx);
        const outcome = await openGrillReview(pi);
        if (outcome.status === "feedback") {
          pi.sendUserMessage(`Grill review feedback:\n\n${outcome.feedback}`, { deliverAs: "followUp" });
          return;
        }
        if (outcome.status === "approved") {
          safeNotify(ctx, "Grill review approved.", "info");
          return;
        }
        if (outcome.status === "closed") {
          safeNotify(ctx, "Grill review closed without feedback.", "info");
          return;
        }
        safeNotify(ctx, outcome.error, "error");
      } catch (error) {
        safeNotify(ctx, `Grill review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
