import { describe, expect, it, vi } from "vitest";

import { createFlags, type FlagOverrideStore } from "../src/index";

describe("createFlags", () => {
  it("defaults omitted flags to off", () => {
    const flags = createFlags({
      draftExport: { description: "Gate draft export" },
    });

    expect(flags.isEnabled("draftExport")).toBe(false);
  });

  it("uses explicit true defaults", () => {
    const flags = createFlags({
      quickShare: { description: "Gate quick share", default: true },
    });

    expect(flags.isEnabled("quickShare")).toBe(true);
  });

  it("lets boolean overrides win over defaults", () => {
    const flags = createFlags({
      betaPanel: { description: "Gate beta panel", default: true },
      timeline: { description: "Gate timeline" },
    });

    flags.setOverride("betaPanel", false);
    flags.setOverride("timeline", true);

    expect(flags.isEnabled("betaPanel")).toBe(false);
    expect(flags.isEnabled("timeline")).toBe(true);
  });

  it("clears overrides back to defaults", () => {
    const flags = createFlags({
      assistant: { description: "Gate assistant", default: true },
    });

    flags.setOverride("assistant", false);
    flags.setOverride("assistant", undefined);

    expect(flags.isEnabled("assistant")).toBe(true);
  });

  it("lists flags in definition order with effective state", () => {
    const flags = createFlags({
      first: { description: "First flag", default: true },
      second: { description: "Second flag" },
      third: { description: "Third flag", default: true },
    });

    flags.setOverride("second", true);

    expect(flags.list()).toEqual([
      {
        key: "first",
        description: "First flag",
        defaultValue: true,
        override: undefined,
        enabled: true,
      },
      {
        key: "second",
        description: "Second flag",
        defaultValue: false,
        override: true,
        enabled: true,
      },
      {
        key: "third",
        description: "Third flag",
        defaultValue: true,
        override: undefined,
        enabled: true,
      },
    ]);
  });

  it("notifies subscribers synchronously and stops after unsubscribe", () => {
    const flags = createFlags({
      editor: { description: "Gate editor" },
    });
    const listener = vi.fn(() => {
      expect(flags.isEnabled("editor")).toBe(true);
    });

    const unsubscribe = flags.subscribe(listener);
    flags.setOverride("editor", true);
    unsubscribe();
    unsubscribe();
    flags.setOverride("editor", false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("throws TypeError for unknown keys", () => {
    const flags = createFlags({
      known: { description: "Known flag" },
    });

    expect(() => flags.isEnabled("missing" as never)).toThrow(TypeError);
    expect(() => flags.isEnabled("missing" as never)).toThrow("missing");
    expect(() => flags.setOverride("missing" as never, true)).toThrow(TypeError);
    expect(() => flags.setOverride("missing" as never, true)).toThrow("missing");
  });

  it("uses a custom store for reads and writes", () => {
    const values = new Map<string, boolean | undefined>();
    const store: FlagOverrideStore = {
      get: vi.fn((key) => values.get(key)),
      set: vi.fn((key, value) => {
        values.set(key, value);
      }),
    };
    const flags = createFlags(
      {
        sync: { description: "Gate sync" },
      },
      { store },
    );

    expect(flags.isEnabled("sync")).toBe(false);
    flags.setOverride("sync", true);
    expect(flags.isEnabled("sync")).toBe(true);
    flags.setOverride("sync", undefined);

    expect(store.get).toHaveBeenCalledWith("sync");
    expect(store.set).toHaveBeenNthCalledWith(1, "sync", true);
    expect(store.set).toHaveBeenNthCalledWith(2, "sync", undefined);
  });

  it("ignores non-boolean store values", () => {
    const store: FlagOverrideStore = {
      get: vi.fn(() => "yes" as unknown as boolean),
      set: vi.fn(),
    };
    const flags = createFlags(
      {
        billing: { description: "Gate billing" },
      },
      { store },
    );

    expect(flags.isEnabled("billing")).toBe(false);
    expect(flags.list()[0]?.override).toBeUndefined();
  });
});
