import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import delegation from "../extensions/delegation.ts";
import { readRun } from "../src/journal-core.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

function makeHarness(opts: { sessionId?: string; hasUI?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const statuses: Array<string | undefined> = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
    },
    sessionManager: {
      getSessionId: () => opts.sessionId,
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  delegation(pi);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return { emit, statuses };
}

function toolEvent(toolName: string, args: unknown = {}) {
  return { toolName, args };
}

describe("delegation extension wiring", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pi-kit-delegation-"));
    process.env.PIKIT_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.PIKIT_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows no status until the activity threshold is reached", () => {
    const { emit, statuses } = makeHarness({ sessionId: "abc" });
    emit("session_start");
    for (let i = 0; i < 4; i++) emit("tool_execution_start", toolEvent("bash"));
    expect(statuses).toEqual([]);
    emit("tool_execution_start", toolEvent("bash"));
    expect(statuses).toEqual(["delegation 0% · 0 lanes / 5 direct"]);
  });

  it("counts lanes from lanes_spawn args in the status", () => {
    const { emit, statuses } = makeHarness({ sessionId: "abc" });
    emit("session_start");
    for (let i = 0; i < 3; i++) emit("tool_execution_start", toolEvent("bash"));
    emit("tool_execution_start", toolEvent("lanes_spawn", { lanes: [{}, {}, {}] }));
    expect(statuses.at(-1)).toBe("delegation 50% · 3 lanes / 3 direct");
  });

  it("journals the summary under a dedicated delegation lane at shutdown", () => {
    const { emit } = makeHarness({ sessionId: "abc" });
    emit("session_start");
    emit("tool_execution_start", toolEvent("bash"));
    emit("tool_execution_start", toolEvent("lanes_spawn", { lanes: [{}] }));
    emit("session_shutdown");

    const events = readRun("sess-abc");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "lane_created", lane: "delegation" });
    expect(events[1]).toMatchObject({
      type: "lane_status",
      lane: "delegation",
      text: "delegation 50% · 1 lane / 1 direct",
    });
  });

  it("writes nothing at shutdown without activity or session id", () => {
    const idle = makeHarness({ sessionId: "idle" });
    idle.emit("session_start");
    idle.emit("session_shutdown");
    expect(readRun("sess-idle")).toEqual([]);

    const anonymous = makeHarness({ sessionId: undefined });
    anonymous.emit("session_start");
    anonymous.emit("tool_execution_start", toolEvent("bash"));
    anonymous.emit("session_shutdown");
    expect(readRun("sess-undefined")).toEqual([]);
  });

  it("suppresses the status without a UI", () => {
    const { emit, statuses } = makeHarness({ sessionId: "abc", hasUI: false });
    emit("session_start");
    for (let i = 0; i < 6; i++) emit("tool_execution_start", toolEvent("bash"));
    expect(statuses).toEqual([]);
  });
});
