import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BANNED, EFFORT_PINS } from "../src/table.ts";

export default function tablePolicy(pi: ExtensionAPI) {
  pi.on("model_select", async (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (BANNED.some((pattern) => pattern.test(selected))) {
      const previous = event.previousModel;
      if (previous && !BANNED.some((pattern) => pattern.test(`${previous.provider}/${previous.id}`))) {
        await pi.setModel(previous);
        ctx.ui.notify(
          `pi-kit: ${selected} is banned; reverted to ${previous.provider}/${previous.id}`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `pi-kit: ${selected} is banned (Haiku/Luna/Terra). Pick another model.`,
          "error",
        );
      }
      return;
    }

    const pin = EFFORT_PINS.find(({ match }) => match.test(selected));
    if (pin && pi.getThinkingLevel() !== pin.level) {
      pi.setThinkingLevel(pin.level);
      ctx.ui.notify(`pi-kit: ${selected} pinned to ${pin.level} effort`, "info");
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.model) return;
    const selected = `${ctx.model.provider}/${ctx.model.id}`;
    if (BANNED.some((pattern) => pattern.test(selected))) {
      ctx.ui.notify(`pi-kit: session started on banned model ${selected} — switch models`, "error");
    }
  });
}
