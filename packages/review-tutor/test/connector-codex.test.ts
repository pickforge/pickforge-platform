import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexConnector, discoveryEnvironment } from "../src/connectors/codex.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { DiscoveryDeps, ParseSink } from "../src/connectors/types.ts";
import { createReviewTutorFlags } from "../src/flags.ts";
import { TutorRunner } from "../src/runner.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 123;
  kill = vi.fn();
}

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/codex/${name}`, import.meta.url));
const catalog = await readFile(fixture("models.json"), "utf8");
const piModels = [{ id: "provider/model", label: "Model", thinkingLevels: ["low"] }];

function fakeDiscovery(outputs: Record<string, string | Error>): DiscoveryDeps {
  return {
    piModels,
    execFile: vi.fn(async (_file, args) => {
      const key = args.join(" ");
      const output = outputs[key];
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error(`unexpected command: ${key}`);
      return { stdout: output, stderr: "" };
    }),
  };
}

function sink() {
  let answer: string | undefined;
  let answerUsage: Record<string, number> | undefined;
  return {
    get answer() { return answer; },
    get answerUsage() { return answerUsage; },
    deltas: [] as string[],
    usages: [] as Record<string, number>[],
    finals: [] as string[],
    delta(text: string) { this.deltas.push(text); },
    usage(value: Record<string, number>) { answerUsage = value; this.usages.push(value); },
    final(value: string) { answer = value; this.finals.push(value); },
  } satisfies ParseSink & { deltas: string[]; usages: Record<string, number>[]; finals: string[] };
}

async function parseFixture(name: string, connector = new CodexConnector()) {
  const output = sink();
  for (const line of (await readFile(fixture(name), "utf8")).split("\n")) {
    if (line) connector.parseLine(line, output);
  }
  return { connector, output };
}

const request = {
  model: "gpt-5.6-sol",
  thinking: "low",
  cwd: "/repo",
  prompt: "Reply with the single word ok.",
};

describe("Codex discovery", () => {
  it("filters discovery environment credentials", () => {
    expect(discoveryEnvironment({
      PATH: "/bin",
      CODEX_HOME: "/tmp/codex-home",
      OPENAI_API_KEY: "sk-proj-fakefakefake",
    })).toEqual({ PATH: "/bin", CODEX_HOME: "/tmp/codex-home" });
  });

  it("reports a missing executable", async () => {
    const connector = new CodexConnector();
    const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    await expect(connector.discover(fakeDiscovery({ "--version": missing }))).resolves.toEqual({
      available: false,
      reason: "Codex is not installed (codex not found on PATH).",
    });
  });

  it("distinguishes other version failures from a missing executable", async () => {
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({ "--version": new Error("timed out") }))).resolves.toEqual({
      available: false,
      reason: "Codex could not report a supported version.",
    });
  });

  it("rejects unverified old versions", async () => {
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({ "--version": "codex-cli 0.120.0\n" }))).resolves.toEqual({
      available: false,
      reason: "Codex 0.120.0 is too old; version 0.140.0 or newer is required.",
    });
  });

  it("accepts the exact minimum version", async () => {
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({
      "--version": "codex-cli 0.140.0\n",
      "debug models": catalog,
    }))).resolves.toMatchObject({ available: true, version: "0.140.0" });
  });

  it("rejects unrecognized version output", async () => {
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({ "--version": "codex 1.2.3\n" }))).resolves.toEqual({
      available: false,
      reason: "Codex could not report a supported version.",
    });
  });

  it("discovers, sorts, namespaces, and filters the object catalog", async () => {
    const deps = fakeDiscovery({ "--version": "codex-cli 0.147.0\n", "debug models": catalog });
    const connector = new CodexConnector();
    await expect(connector.discover(deps)).resolves.toEqual({
      available: true,
      version: "0.147.0",
      models: [
        { id: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", thinkingLevels: ["low", "medium", "high"] },
        { id: "codex:gpt-5.5", label: "gpt-5.5", thinkingLevels: ["low", "medium", "high"] },
      ],
    });
    expect(deps.execFile).toHaveBeenNthCalledWith(1, "codex", ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    expect(deps.execFile).toHaveBeenNthCalledWith(2, "codex", ["debug", "models"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    expect(deps.execFile).toHaveBeenCalledTimes(2);
  });

  it("accepts a bare-array catalog", async () => {
    const bare = JSON.stringify(JSON.parse(catalog).models);
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({
      "--version": "codex-cli 0.147.0\n",
      "debug models": bare,
    }))).resolves.toMatchObject({ available: true, models: expect.arrayContaining([
      expect.objectContaining({ id: "codex:gpt-5.6-sol" }),
    ]) });
  });

  it.each(["not json", new Error("timed out")])("reports malformed or failing catalogs as unavailable", async (failure) => {
    const connector = new CodexConnector();
    await expect(connector.discover(fakeDiscovery({
      "--version": "codex-cli 0.147.0\n",
      "debug models": failure,
    }))).resolves.toEqual({ available: false, reason: "Codex could not list its models." });
  });
});

describe("Codex parsing", () => {
  it("parses a completed turn", async () => {
    const { connector, output } = await parseFixture("success.jsonl");
    expect(connector.finish(output)).toEqual({
      answer: "ok",
      usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 4, reasoning_output_tokens: 2 },
    });
    expect(output.deltas).toEqual(["ok"]);
    expect(output.finals).toEqual(["ok"]);
  });

  it.each([
    ["429 rate limit exceeded", "Codex is rate-limited or out of quota right now. Try again later."],
    ["unknown model", "Codex rejected model gpt-5.6-sol."],
  ])("maps %s failures", (message, expected) => {
    const connector = new CodexConnector();
    connector.spawnSpec(request);
    expect(() => connector.parseLine(JSON.stringify({
      type: "turn.failed",
      error: { message },
    }), sink())).toThrow(expected);
  });

  it("maps a final 401 without exposing provider internals", async () => {
    const connector = new CodexConnector();
    connector.spawnSpec(request);
    const output = sink();
    const lines = (await readFile(fixture("unauthorized.jsonl"), "utf8")).trim().split("\n");
    connector.parseLine(lines[0]!, output);
    connector.parseLine(lines[1]!, output);
    expect(() => connector.parseLine(lines[2]!, output)).toThrow(
      "Codex is not logged in. Run `codex login`, then ask again.",
    );
    expect(() => connector.parseLine(lines[2]!, output)).not.toThrow(/url:|request id:/i);
  });

  it("rejects an empty answer", async () => {
    const { connector, output } = await parseFixture("empty.jsonl");
    expect(() => connector.finish(output)).toThrow("Codex returned an empty answer.");
  });

  it("ignores malformed lines", () => {
    const connector = new CodexConnector();
    const output = sink();
    expect(() => connector.parseLine("not json", output)).not.toThrow();
  });

  it("rejects output without turn.completed", async () => {
    const { connector, output } = await parseFixture("incomplete.jsonl");
    expect(() => connector.finish(output)).toThrow("Codex exited without completing the turn.");
  });

  it("maps the last error when a turn exits before completion", () => {
    const connector = new CodexConnector();
    const output = sink();
    connector.parseLine(JSON.stringify({
      type: "error",
      message: "401 unauthorized url: https://provider.invalid request id: req_fixture",
    }), output);
    expect(() => connector.finish(output)).toThrow(
      "Codex is not logged in. Run `codex login`, then ask again.",
    );
  });

  it("strips provider internals from fallback errors", () => {
    const connector = new CodexConnector();
    connector.spawnSpec(request);
    const output = sink();
    expect(() => connector.parseLine(JSON.stringify({
      type: "turn.failed",
      error: { message: "provider failed url: https://provider.invalid cf-ray: ray_fixture request id: req_fixture" },
    }), output)).toThrow("provider failed");
    expect(() => connector.parseLine(JSON.stringify({
      type: "turn.failed",
      error: { message: "provider failed url: https://provider.invalid cf-ray: ray_fixture request id: req_fixture" },
    }), output)).not.toThrow(/url:|cf-ray:|request id:/i);
  });
});

describe("Codex runner integration", () => {
  it("pins argv and writes the prompt to stdin", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child as never);
    let prompt = "";
    child.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
    const connector = new CodexConnector();
    const runner = new TutorRunner({
      spawn,
      env: {
        PATH: "/bin",
        CODEX_HOME: "/tmp/codex-home",
        OPENAI_API_KEY: "sk-proj-fakefakefake",
      },
    });
    const done = runner.run({ ...request, connector }, () => {});
    child.stdout.end(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
    child.emit("close", 0, null);
    await expect(done).resolves.toMatchObject({ answer: "ok" });
    expect(prompt).toBe(request.prompt);
    expect(child.stdin.writableEnded).toBe(true);
    expect(spawn.mock.calls[0]?.[0]).toBe("codex");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "exec", "--json", "--ephemeral", "--skip-git-repo-check",
      "-s", "read-only", "-C", "/repo",
      "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"low\"",
      "-c", "shell_environment_policy.inherit=\"none\"",
      "-c", "model_verbosity=\"low\"", "-",
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: "/repo",
      env: {
        PATH: "/bin",
        CODEX_HOME: "/tmp/codex-home",
        REVIEW_TUTOR_CHILD: "1",
      },
    });
    expect(spawn.mock.calls[0]?.[2]).not.toMatchObject({
      env: { OPENAI_API_KEY: expect.anything() },
    });
  });

  it("settles once when cancelled mid-run", async () => {
    const child = new FakeChild();
    const terminate = vi.fn();
    const connector = new CodexConnector();
    const runner = new TutorRunner({ spawn: () => child as never, terminate });
    const done = runner.run({ ...request, connector }, () => {});
    runner.cancel();
    child.emit("close", null, "SIGTERM");
    await expect(done).rejects.toThrow(/cancelled/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("redacts Codex stderr failures", async () => {
    const child = new FakeChild();
    const connector = new CodexConnector();
    const runner = new TutorRunner({ spawn: () => child as never });
    const done = runner.run({ ...request, connector }, () => {});
    child.stderr.end("sk-proj-fakefakefake");
    child.emit("close", 1, null);
    await expect(done).rejects.toThrow(/\[redacted\]/);
    await expect(done).rejects.not.toThrow(/sk-proj-fakefakefake/);
  });
});

describe("Codex registry", () => {
  it("registers Codex only with the flag and preserves unavailable discovery", async () => {
    const off = createConnectorRegistry({
      flags: createReviewTutorFlags({ get: () => false, set: () => {} }),
      piModels,
    });
    const on = createConnectorRegistry({
      flags: createReviewTutorFlags({ get: () => true, set: () => {} }),
      piModels,
      execFile: fakeDiscovery({
        "--version": Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
      }).execFile,
    });
    expect(off.connectors().map(({ id }) => id)).toEqual(["pi"]);
    expect(on.connectors().map(({ id }) => id)).toEqual(["pi", "codex"]);
    const discoveries = await on.discoveries();
    expect(discoveries.find(({ connector }) => connector.id === "codex")).toEqual({
      connector: on.byId("codex"),
      discovery: {
        available: false,
        reason: "Codex is not installed (codex not found on PATH).",
      },
    });
  });
});
