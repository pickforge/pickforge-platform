import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PiConnector } from "../src/connectors/pi.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { DiscoveryDeps } from "../src/connectors/types.ts";

const table = await readFile(
  fileURLToPath(new URL("fixtures/pi/list-models.txt", import.meta.url)),
  "utf8",
);
const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh"];

function fakeDiscovery(outputs: Record<string, string | Error>): DiscoveryDeps {
  return {
    which: async () => undefined,
    execFile: vi.fn(async (_file, args) => {
      const key = args.join(" ");
      const output = outputs[key];
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error(`unexpected command: ${key}`);
      return { stdout: output, stderr: "" };
    }),
  };
}

describe("Pi discovery without a host", () => {
  it("reports a missing executable", async () => {
    const missing = Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
    await expect(new PiConnector().discover(fakeDiscovery({ "--version": missing }))).resolves.toEqual({
      available: false,
      reason: "Pi is not installed (pi not found on PATH).",
    });
  });

  it.each([
    new Error("timed out"),
    "not a version\n",
  ])("distinguishes other version failures from a missing executable", async (failure) => {
    await expect(new PiConnector().discover(fakeDiscovery({ "--version": failure }))).resolves.toEqual({
      available: false,
      reason: "Pi could not report a supported version.",
    });
  });

  it("rejects versions below the supported extension API", async () => {
    await expect(new PiConnector().discover(fakeDiscovery({ "--version": "0.82.9\n" }))).resolves.toEqual({
      available: false,
      reason: "Pi 0.82.9 is too old; version 0.83.0 or newer is required.",
    });
  });

  it("parses the model table through bounded, scrubbed execution", async () => {
    const deps = fakeDiscovery({ "--version": "0.84.2\n", "--list-models": table });
    await expect(new PiConnector().discover(deps)).resolves.toEqual({
      available: true,
      version: "0.84.2",
      models: [
        { id: "pi:openai-codex/gpt-5.6-sol", label: "openai-codex: gpt-5.6-sol", thinkingLevels: REASONING },
        { id: "pi:anthropic/claude-fable-5", label: "anthropic: claude-fable-5", thinkingLevels: REASONING },
        { id: "pi:ollama/qwen3:8b", label: "ollama: qwen3:8b", thinkingLevels: REASONING },
        { id: "pi:deepseek-official/deepseek-v4-flash", label: "deepseek-official: deepseek-v4-flash", thinkingLevels: REASONING },
        { id: "pi:local/basic", label: "local: basic", thinkingLevels: ["off"] },
      ],
    });
    expect(deps.execFile).toHaveBeenNthCalledWith(1, "pi", ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      signal: expect.any(AbortSignal),
      timeout: 10_000,
    });
    expect(deps.execFile).toHaveBeenNthCalledWith(2, "pi", ["--list-models"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      signal: expect.any(AbortSignal),
      timeout: 10_000,
    });
    expect(deps.execFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    "openai-codex  gpt-5.6-sol  272K  128K  yes  yes\n",
    "provider  model  context  max-out  thinking  images\n",
    "",
    new Error("timed out"),
  ])("reports malformed or failing tables as unavailable", async (failure) => {
    await expect(new PiConnector().discover(fakeDiscovery({
      "--version": "0.84.2\n",
      "--list-models": failure,
    }))).resolves.toEqual({ available: false, reason: "Pi could not list its models." });
  });

  it("keeps the hosted path free of process execution", async () => {
    const deps = fakeDiscovery({});
    const hosted = { ...deps, piModels: [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }] };
    await expect(new PiConnector().discover(hosted)).resolves.toEqual({
      available: true,
      version: "unknown",
      models: [{ id: "pi:provider/model", label: "Model", thinkingLevels: ["low"] }],
    });
    expect(deps.execFile).not.toHaveBeenCalled();
  });
});

describe("Pi registry without a host", () => {
  it("discovers Pi through the registry when no model snapshot is supplied", async () => {
    const registry = createConnectorRegistry({
      which: async () => undefined,
      execFile: fakeDiscovery({ "--version": "0.84.2\n", "--list-models": table }).execFile,
    });
    const discoveries = await registry.discoveries();
    expect(discoveries.find(({ connector }) => connector.id === "pi")?.discovery).toMatchObject({
      available: true,
      version: "0.84.2",
    });
  });
});
