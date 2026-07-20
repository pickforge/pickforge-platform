import { describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import grillReview from "../extensions/grill-review.ts";

type RegisteredTool = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
};

type RegisteredCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type PlannotatorRequest = {
  action: string;
  payload: { gate?: boolean };
  respond: (response: unknown) => void;
};

function makeHarness(options: {
  plannotatorLoaded?: boolean;
  waitForIdle?: Promise<void>;
  helper?: { code: number; stdout: string } | "reject" | "pending";
} = {}) {
  let tool: RegisteredTool | undefined;
  let command: RegisteredCommand | undefined;
  let request: PlannotatorRequest | undefined;
  const sent: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const pi = {
    registerTool: (definition: RegisteredTool) => {
      tool = definition;
    },
    registerCommand: (_name: string, definition: RegisteredCommand) => {
      command = definition;
    },
    getCommands: () => options.plannotatorLoaded === false
      ? [{ name: "grill-review" }]
      : [{ name: "grill-review" }, { name: "plannotator-last" }],
    events: {
      emit: (_channel: string, value: PlannotatorRequest) => {
        request = value;
      },
    },
    sendUserMessage: (message: string, sendOptions?: { deliverAs?: string }) => {
      sent.push({ message, options: sendOptions });
    },
    exec: async (_command: string, _args: string[], execOptions?: { signal?: AbortSignal }) => {
      if (options.helper === "reject") throw new Error("helper unavailable");
      if (options.helper === "pending") {
        return new Promise((_, reject) => {
          execOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return options.helper ?? { code: 0, stdout: "https://dev.tailnet.ts.net:19432/\n", stderr: "" };
    },
  } as unknown as ExtensionAPI;

  grillReview(pi);

  const ctx = {
    waitForIdle: () => options.waitForIdle ?? Promise.resolve(),
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;

  return {
    get tool() {
      return tool!;
    },
    get command() {
      return command!;
    },
    get request() {
      return request!;
    },
    ctx,
    sent,
    notifications,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("grill review extension", () => {
  it("registers a model-visible tool and manual command", () => {
    const harness = makeHarness();

    expect(harness.tool.name).toBe("grill_review");
    expect(harness.tool.promptSnippet).toContain("question batch");
    expect(harness.tool.promptGuidelines?.join(" ")).toContain("Use grill_review");
    expect(harness.command).toBeDefined();
  });

  it("returns feedback from Plannotator to the calling model", async () => {
    const harness = makeHarness();
    const resultPromise = harness.tool.execute("tool-1", {}, undefined, undefined, harness.ctx);
    await flushAsync();

    expect(harness.notifications[0]).toEqual({
      message: "Open Plannotator: https://dev.tailnet.ts.net:19432/",
      level: "info",
    });
    expect(harness.request.action).toBe("annotate-last");
    expect(harness.request.payload.gate).toBe(true);
    harness.request.respond({ status: "handled", result: { feedback: "Prefer option B" } });

    const result = await resultPromise;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("Prefer option B");
  });

  it("fails clearly without advertising a URL when Plannotator is not loaded", async () => {
    const harness = makeHarness({ plannotatorLoaded: false });

    await expect(harness.tool.execute("tool-1", {}, undefined, undefined, harness.ctx))
      .rejects.toThrow("Plannotator is not loaded");
    expect(harness.notifications).toEqual([]);
  });

  it("throws when Plannotator reports a startup error", async () => {
    const harness = makeHarness();
    const resultPromise = harness.tool.execute("tool-1", {}, undefined, undefined, harness.ctx);
    await flushAsync();

    harness.request.respond({ status: "error", error: "server failed" });
    await expect(resultPromise).rejects.toThrow("server failed");
  });

  it("waits for an active turn to settle before reviewing and queues feedback safely", async () => {
    let releaseIdle!: () => void;
    const waitForIdle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const harness = makeHarness({ waitForIdle });
    const commandPromise = harness.command.handler("", harness.ctx);
    await flushAsync();

    expect(harness.request).toBeUndefined();
    expect(harness.notifications).toEqual([]);
    releaseIdle();
    await flushAsync();
    expect(harness.notifications[0]?.message).toContain("https://dev.tailnet.ts.net:19432/");
    harness.request.respond({ status: "handled", result: { feedback: "Split question 2" } });
    await commandPromise;

    expect(harness.sent).toEqual([{
      message: "Grill review feedback:\n\nSplit question 2",
      options: { deliverAs: "followUp" },
    }]);
  });

  it("does not advertise a URL when cancelled while resolving it", async () => {
    const harness = makeHarness({ helper: "pending" });
    const controller = new AbortController();
    const resultPromise = harness.tool.execute("tool-1", {}, controller.signal, undefined, harness.ctx);

    controller.abort();
    await expect(resultPromise).rejects.toThrow("cancelled before opening");
    expect(harness.notifications).toEqual([]);
    expect(harness.request).toBeUndefined();
  });

  it("keeps an opened review authoritative after the tool signal aborts", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    let settled = false;
    const resultPromise = harness.tool.execute("tool-1", {}, controller.signal, undefined, harness.ctx)
      .then((result) => {
        settled = true;
        return result;
      });
    await flushAsync();

    controller.abort();
    await flushAsync();
    expect(settled).toBe(false);

    harness.request.respond({ status: "handled", result: { feedback: "Keep question 3" } });
    const result = await resultPromise;
    expect(result.content[0]?.text).toContain("Keep question 3");
  });

  it("does not start another turn when the batch is approved", async () => {
    const harness = makeHarness();
    const commandPromise = harness.command.handler("", harness.ctx);
    await flushAsync();
    harness.request.respond({ status: "handled", result: { feedback: "", approved: true } });
    await commandPromise;

    expect(harness.sent).toEqual([]);
    expect(harness.notifications.at(-1)).toEqual({ message: "Grill review approved.", level: "info" });
  });

  it("falls back to the loopback URL when plannotator-url fails", async () => {
    const harness = makeHarness({ helper: "reject" });
    const commandPromise = harness.command.handler("", harness.ctx);
    await flushAsync();

    expect(harness.notifications[0]).toEqual({
      message: `Open Plannotator: http://localhost:${process.env.PLANNOTATOR_PORT || "19432"}/`,
      level: "info",
    });
    harness.request.respond({ status: "handled", result: { approved: true } });
    await commandPromise;
  });
});
