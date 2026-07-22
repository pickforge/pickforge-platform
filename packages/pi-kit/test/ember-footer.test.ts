import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import emberFooter from "../extensions/ember-footer.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type FooterFactory = (
  tui: { requestRender(): void },
  theme: Theme,
  data: FooterData,
) => FooterComponent;
type FooterComponent = { render(width: number): string[]; dispose?(): void };
type Theme = { fg(_color: string, text: string): string };
type FooterData = {
  onBranchChange(callback: () => void): () => void;
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
};

function usage(input: number, output: number, total = 0) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function makeHarness(
  opts: {
    stalePricing?: boolean;
    throwRender?: boolean;
    throwTheme?: boolean;
    throwFooterData?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  let footerFactory: FooterFactory | undefined;
  let renders = 0;
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: usage(1_000, 500),
      },
    },
  ];
  const pricedModel = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  };
  const staleModel = {
    ...pricedModel,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const model = opts.stalePricing ? staleModel : pricedModel;
  let registeredModel = model;
  const ctx = {
    hasUI: true,
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id
          ? registeredModel
          : undefined,
      refresh: async () => {
        await Promise.resolve();
        registeredModel = pricedModel;
      },
      isUsingOAuth: () => true,
    },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 272_000 }),
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getLeafId: () => "leaf",
    },
    ui: {
      setFooter: (factory: FooterFactory | undefined) => {
        footerFactory = factory;
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  const pi = {
    getThinkingLevel: () => "high",
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  emberFooter(pi);

  const emit = async (name: string, event: unknown = {}) => {
    await handlers.get(name)?.(event, ctx);
  };
  const render = () => {
    if (!footerFactory) throw new Error("footer not installed");
    const component = footerFactory(
      {
        requestRender: () => {
          if (opts.throwRender) throw new Error("render unavailable");
          renders++;
        },
      },
      {
        fg: (_color, text) => {
          if (opts.throwTheme) throw new Error("theme unavailable");
          return text;
        },
      },
      {
        onBranchChange: () => {
          if (opts.throwFooterData) throw new Error("footer data unavailable");
          return () => {};
        },
        getGitBranch: () => null,
        getExtensionStatuses: () => {
          if (opts.throwFooterData) throw new Error("footer data unavailable");
          return new Map();
        },
      },
    );
    return component.render(200).join("\n");
  };

  return { emit, render, getRenderRequests: () => renders };
}

describe("ember footer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recomputes missing persisted cost from the message model pricing", async () => {
    const { emit, render } = makeHarness();
    await emit("session_start");

    expect(render()).toContain("$0.02 est");
  });

  it("refreshes stale model pricing when extensions reload", async () => {
    const { emit, render } = makeHarness({ stalePricing: true });
    await emit("session_start");

    expect(render()).toContain("$0.02 est");
  });

  it("contains deferred footer factory and render failures", async () => {
    const themeHarness = makeHarness({ throwTheme: true });
    await themeHarness.emit("session_start");
    expect(() => themeHarness.render()).not.toThrow();

    const dataHarness = makeHarness({ throwFooterData: true });
    await dataHarness.emit("session_start");
    expect(() => dataHarness.render()).not.toThrow();
  });

  it("contains timer and agent render callback failures", async () => {
    const { emit, render } = makeHarness({ throwRender: true });
    await emit("session_start");
    render();

    await expect(emit("agent_start")).resolves.toBeUndefined();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    await expect(emit("agent_settled")).resolves.toBeUndefined();
  });

  it("times the whole agent run and retains the final worked duration", async () => {
    const { emit, render, getRenderRequests } = makeHarness();
    await emit("session_start");
    expect(render()).toContain("session 00:00");
    expect(render()).not.toContain("working");
    expect(render()).not.toContain("worked");

    emit("agent_start");
    vi.advanceTimersByTime(30_000);
    emit("message_end", { message: { role: "assistant" } });
    vi.advanceTimersByTime(35_000);
    expect(render()).toContain("session 01:05");
    expect(render()).toContain("working 01:05");
    expect(getRenderRequests()).toBeGreaterThan(0);

    emit("agent_settled");
    expect(render()).toContain("worked 01:05");
    expect(render()).not.toContain("working");
    vi.advanceTimersByTime(10_000);
    expect(render()).toContain("worked 01:05");

    emit("agent_start");
    expect(render()).toContain("working 00:00");
    expect(render()).not.toContain("worked");
    emit("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
  });
});
