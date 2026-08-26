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
import { TutorRunner } from "../src/runner.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123;
  kill = vi.fn();
}

const models = [{ id: "anthropic/model", label: "Model", thinkingLevels: ["low"] }];

function registry() {
  return createConnectorRegistry({ piModels: models });
}

const request = {
  connector: new PiConnector(),
  model: "anthropic/model",
  thinking: "low",
  cwd: "/repo",
  prompt: "prompt",
};

describe("connector registry", () => {
  it("registers Pi, Claude Code, and Codex in that order", () => {
    expect(registry().connectors().map((connector) => connector.id)).toEqual(["pi", "claude-code", "codex"]);
  });

  it("resolves namespaced and legacy Pi ids and rejects unknown harnesses", () => {
    expect(registry().resolve("pi:anthropic/model")).toMatchObject({ model: "anthropic/model" });
    expect(registry().resolve("anthropic/model")).toMatchObject({ model: "anthropic/model" });
    expect(registry().resolve("ollama/qwen3:8b")).toMatchObject({
      connector: { id: "pi" },
      model: "ollama/qwen3:8b",
    });
    expect(registry().resolve("pi:ollama/qwen3:8b")).toMatchObject({
      connector: { id: "pi" },
      model: "ollama/qwen3:8b",
    });
    expect(registry().resolve("codex:x")).toMatchObject({ model: "x" });
    expect(registry().resolve("unknown:x")).toBeUndefined();
  });

  it("namespaces Pi discovery without spawning a process", async () => {
    const connector = new PiConnector();
    await expect(connector.discover({
      piModels: models,
      piVersion: "1.2.3",
      which: async () => undefined,
    })).resolves.toEqual({
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
    ["url: https://provider.invalid/path", "[redacted]"],
    ["cf-ray: ray_fixture", "[redacted]"],
    ["request id: req_fixture", "[redacted]"],
    ["thread_id: thread_fixture", "[redacted]"],
    ["thread id thread_fixture", "[redacted]"],
  ])("redacts %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("redacts a child stderr tail before the failure leaves the runner", async () => {
    const child = new FakeChild();
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run(request, () => {});
    child.stderr.end("sk-livefakefakefake");
    child.emit("close", 1, null);
    await expect(done).rejects.toThrow(/\[redacted\]/);
    await expect(done).rejects.not.toThrow(/sk-livefakefakefake/);
  });

  it("reports a connector failure for an empty answer", async () => {
    const child = new FakeChild();
    const connector: HarnessConnector = {
      id: "pi",
      label: "Pi",
      discover: async () => ({ available: true, version: "unknown", models: [] }),
      spawnSpec: () => ({ command: "fake", args: [] }),
      parseLine: () => {},
      finish: (_sink: ParseSink) => {
        throw new ConnectorError("empty answer");
      },
    };
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run({ ...request, connector }, () => {});
    child.emit("close", 0, null);
    const error = await done.catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "empty answer" });
  });

  it("terminates once and redacts a parse failure on the second line", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    let lines = 0;
    const connector: HarnessConnector = {
      id: "pi",
      label: "Pi",
      discover: async () => ({ available: true, version: "unknown", models: [] }),
      spawnSpec: () => ({ command: "fake", args: [] }),
      parseLine: () => {
        lines += 1;
        if (lines === 2) throw new Error("parse failed with sk-abcdefgh");
      },
      finish: () => ({ answer: "unused" }),
    };
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const done = runner.run({ ...request, connector }, () => {});
    let rejections = 0;
    void done.catch(() => { rejections += 1; });

    child.stdout.write("first\nsecond\n");
    child.emit("close", null, "SIGTERM");

    await expect(done).rejects.toThrow(/parse failed with \[redacted\]/);
    await expect(done).rejects.not.toThrow(/sk-abcdefgh/);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(rejections).toBe(1);
  });

  it("keeps answer state per execution on a shared connector", async () => {
    const connector = new PiConnector();
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const children = [firstChild, secondChild];
    const runner = new TutorRunner({ spawn: () => children.shift() as never });
    const sharedRequest = { ...request, connector };

    const first = runner.run(sharedRequest, () => {});
    firstChild.stdout.end(`${JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "first" }],
    })}\n`);
    firstChild.emit("close", 0, null);
    await expect(first).resolves.toEqual({ answer: "first" });

    const second = runner.run(sharedRequest, () => {});
    secondChild.emit("close", 0, null);
    await expect(second).rejects.toThrow(/empty/);
  });

  it("returns usage reported through the runner-owned sink", async () => {
    const child = new FakeChild();
    const connector: HarnessConnector = {
      id: "pi",
      label: "Pi",
      discover: async () => ({ available: true, version: "unknown", models: [] }),
      spawnSpec: () => ({ command: "fake", args: [] }),
      parseLine: (_line, sink) => {
        sink.usage({ input: 3 });
        sink.final("answer");
      },
      finish: (sink) => ({
        answer: sink.answer!,
        ...(sink.answerUsage ? { usage: sink.answerUsage } : {}),
      }),
    };
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run({ ...request, connector }, () => {});
    child.stdout.end("event\n");
    child.emit("close", 0, null);
    await expect(done).resolves.toEqual({ answer: "answer", usage: { input: 3 } });
  });

  it("settles once when cancelled before, during, or after execution", async () => {
    const beforeChild = new FakeChild();
    const beforeRunner = new TutorRunner({ spawn: () => beforeChild as never });
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
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const cancelled = runner.run(request, () => {});
    runner.cancel();
    child.emit("close", null, "SIGTERM");
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(terminate).toHaveBeenCalledTimes(1);

    const completedChild = new FakeChild();
    const completedTerminate = vi.fn();
    const completedRunner = new TutorRunner({
      spawn: () => completedChild as never,
      terminate: completedTerminate,
    });
    const completed = completedRunner.run(request, () => {});
    completedChild.stdout.end(`${JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: "done" }],
    })}\n`);
    completedChild.emit("close", 0, null);
    const completedResult = await completed;
    completedRunner.cancel();
    expect(completedResult).toEqual({ answer: "done" });
    expect(completedTerminate).not.toHaveBeenCalled();
  });
});
