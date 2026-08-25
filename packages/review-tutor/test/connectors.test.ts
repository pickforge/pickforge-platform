import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PiConnector } from "../src/connectors/pi.ts";
import { redact } from "../src/connectors/redact.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import {
  ConnectorError,
  type HarnessConnector,
  type ParseSink,
} from "../src/connectors/types.ts";
import { createReviewTutorFlags } from "../src/flags.ts";
import { TutorRunner } from "../src/runner.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123;
  kill = vi.fn();
}

const models = [{ id: "anthropic/model", label: "Model", thinkingLevels: ["low"] }];

function flags(enabled: boolean) {
  return createReviewTutorFlags({
    get: () => enabled,
    set: () => {},
  });
}

function registry(enabled = false) {
  return createConnectorRegistry({ flags: flags(enabled), piModels: models });
}

const request = {
  model: "anthropic/model",
  thinking: "low",
  cwd: "/repo",
  prompt: "prompt",
};

describe("connector registry", () => {
  it("reads the environment override once when flags are created", () => {
    const previous = process.env.REVIEW_TUTOR_FLAGS;
    try {
      process.env.REVIEW_TUTOR_FLAGS = "reviewTutorHarnessConnectors";
      const snapshot = createReviewTutorFlags();
      process.env.REVIEW_TUTOR_FLAGS = "";
      expect(snapshot.isEnabled("reviewTutorHarnessConnectors")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.REVIEW_TUTOR_FLAGS;
      else process.env.REVIEW_TUTOR_FLAGS = previous;
    }
  });

  it("keeps only the explicitly registered Pi connector with the flag off or on", () => {
    expect(registry(false).connectors().map((connector) => connector.id)).toEqual(["pi"]);
    expect(registry(true).connectors().map((connector) => connector.id)).toEqual(["pi"]);
  });

  it("resolves namespaced and legacy Pi ids and rejects unknown harnesses", () => {
    expect(registry().resolve("pi:anthropic/model")).toMatchObject({ model: "anthropic/model" });
    expect(registry().resolve("anthropic/model")).toMatchObject({ model: "anthropic/model" });
    expect(registry().resolve("codex:x")).toBeUndefined();
  });

  it("namespaces Pi discovery without spawning a process", async () => {
    const connector = new PiConnector();
    await expect(connector.discover({ piModels: models, piVersion: "1.2.3" })).resolves.toEqual({
      available: true,
      version: "1.2.3",
      models: [{ ...models[0], id: "pi:anthropic/model" }],
    });
  });
});

describe("connector failure boundary", () => {
  it.each([
    ["sk-abcdefgh", "[redacted]"],
    ["Bearer abc.def", "[redacted]"],
    ["OPENAI_API_KEY=value", "[redacted]"],
    ["token=value", "[redacted]"],
    ["ghp_abcdefgh", "[redacted]"],
    ["gho_abcdefgh", "[redacted]"],
  ])("redacts %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("redacts a child stderr tail before the failure leaves the runner", async () => {
    const child = new FakeChild();
    const runner = new TutorRunner({
      connector: new PiConnector(),
      spawn: () => child as never,
    });
    const done = runner.run(request, () => {});
    child.stderr.end("sk-livefakefakefake");
    child.emit("close", 1, null);
    await expect(done).rejects.toThrow(/\[redacted\]/);
    await expect(done).rejects.not.toThrow(/sk-livefakefakefake/);
  });

  it("preserves a typed connector failure for an empty answer", async () => {
    const child = new FakeChild();
    const connector: HarnessConnector = {
      id: "pi",
      label: "Pi",
      discover: async () => ({ available: true, version: "unknown", models: [] }),
      spawnSpec: () => ({ command: "fake", args: [] }),
      parseLine: () => {},
      finish: (_sink: ParseSink) => {
        throw new ConnectorError("empty_answer", "empty answer");
      },
    };
    const runner = new TutorRunner({ connector, spawn: () => child as never });
    const done = runner.run(request, () => {});
    child.emit("close", 0, null);
    const error = await done.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "empty_answer", message: "empty answer" });
  });

  it("settles once when cancelled before, during, or after execution", async () => {
    const beforeChild = new FakeChild();
    const beforeRunner = new TutorRunner({ connector: new PiConnector(), spawn: () => beforeChild as never });
    beforeRunner.cancel();
    const before = beforeRunner.run(request, () => {});
    beforeChild.stdout.end(`${JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "started" }],
    })}\n`);
    beforeChild.emit("close", 0, null);
    await expect(before).resolves.toMatchObject({ answer: "started" });

    const child = new FakeChild();
    const terminate = vi.fn();
    const runner = new TutorRunner({ connector: new PiConnector(), spawn: () => child as never, terminate });
    const cancelled = runner.run(request, () => {});
    runner.cancel();
    child.emit("close", null, "SIGTERM");
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(terminate).toHaveBeenCalledTimes(1);

    const completedChild = new FakeChild();
    const completedRunner = new TutorRunner({ connector: new PiConnector(), spawn: () => completedChild as never });
    const completed = completedRunner.run(request, () => {});
    completedChild.stdout.end(`${JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "done" }],
    })}\n`);
    completedChild.emit("close", 0, null);
    await expect(completed).resolves.toMatchObject({ answer: "done" });
    completedRunner.cancel();
  });
});
