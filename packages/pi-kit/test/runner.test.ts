import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaneRunner } from "../src/runner.ts";
import type { KitEvent, LaneSpec } from "../src/schema.ts";
import { estimateCost } from "../src/table.ts";

const streamFixture = fileURLToPath(new URL("./fixtures/lane-stream.jsonl", import.meta.url));
const originalDataDir = process.env.PIKIT_DATA_DIR;
let dataDir: string;

const validSpec: LaneSpec = {
  lane: "worker",
  task: "Run the fixture task",
  model: "openai-codex/gpt-5.6-sol",
  effort: "medium",
};

async function executable(name: string, source: string): Promise<string> {
  const path = join(dataDir, name);
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-kit-runner-"));
  process.env.PIKIT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PIKIT_DATA_DIR;
  else process.env.PIKIT_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe("LaneRunner", () => {
  it("journals a JSON child stream and returns cumulative usage", async () => {
    // This process-level integration fixture deliberately spaces JSONL writes to exercise chunked streaming.
    const piBinary = await executable(
      "fixture-pi",
      `#!/usr/bin/env node\nconst { readFileSync } = require("node:fs");\nconst lines = readFileSync(${JSON.stringify(streamFixture)}, "utf8").trimEnd().split("\\n");\n(async () => { for (const line of lines) { console.log(line); await new Promise((resolve) => setTimeout(resolve, 10)); } })();\n`,
    );
    const events: KitEvent[] = [];
    const runner = new LaneRunner({ runId: "run-success", append: (event) => events.push(event), piBinary });

    const [lane] = await runner.dispatch([validSpec]);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["lane_start", "lane_tool", "lane_usage", "lane_end"]),
    );
    const tool = events.find((event) => event.type === "lane_tool");
    expect(tool).toMatchObject({ tool: "bash", summary: "printf 'fixture tool output'" });
    const usage = events.find((event) => event.type === "lane_usage");
    expect(usage).toMatchObject({
      input: 1200,
      output: 300,
      cacheRead: 40,
      context: 1550,
      cost: estimateCost(validSpec.model, 1200, 300),
    });
    expect(lane).toMatchObject({
      state: "done",
      tokensIn: 1200,
      tokensOut: 300,
      context: 1550,
      cost: estimateCost(validSpec.model, 1200, 300),
      answer: "Hello from lane.",
    });
    expect(events.at(-1)).toMatchObject({ type: "lane_end", ok: true, answer: "Hello from lane." });
  });

  it("captures a nonzero child exit as a failed lane", async () => {
    const piBinary = await executable("failing-pi", "#!/usr/bin/env bash\necho 'fixture failed' >&2\nexit 7\n");
    const events: KitEvent[] = [];
    const runner = new LaneRunner({ runId: "run-failure", append: (event) => events.push(event), piBinary });

    const [lane] = await runner.dispatch([validSpec]);

    expect(lane).toMatchObject({ state: "failed", answer: expect.stringContaining("fixture failed") });
    expect(events.at(-1)).toMatchObject({
      type: "lane_end",
      ok: false,
      stopReason: "exit:7",
      answer: expect.stringContaining("fixture failed"),
    });
  });

  it("rejects every invalid spec before spawning", async () => {
    const marker = join(dataDir, "spawned");
    const piBinary = await executable("must-not-run", `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    const events: KitEvent[] = [];
    const runner = new LaneRunner({ runId: "run-invalid", append: (event) => events.push(event), piBinary });
    const invalid = [
      { ...validSpec, lane: "missing-model", model: "" },
      { ...validSpec, lane: "missing-task", task: "" },
    ] as LaneSpec[];

    await expect(runner.dispatch(invalid)).rejects.toThrow(
      "Invalid lane specs:\nmissing-model: model is required: state the full selector from the model table\nmissing-task: task is required and must be self-contained",
    );
    expect(events).toEqual([]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("abandons a running child and journals the reason", async () => {
    const piBinary = await executable("sleeping-pi", "#!/usr/bin/env bash\nexec sleep 10\n");
    const events: KitEvent[] = [];
    const started = Promise.withResolvers<void>();
    const runner = new LaneRunner({
      runId: "run-abandon",
      append(event) {
        events.push(event);
        if (event.type === "lane_start") started.resolve();
      },
      piBinary,
    });

    const dispatch = runner.dispatch([validSpec]);
    await started.promise;
    runner.abandon(validSpec.lane, "test stop");
    const [lane] = await dispatch;

    expect(lane).toMatchObject({ state: "abandoned", abandonReason: "test stop" });
    expect(events.at(-1)).toMatchObject({ type: "lane_abandoned", reason: "test stop" });
    expect(events.some((event) => event.type === "lane_end")).toBe(false);
  });
});
