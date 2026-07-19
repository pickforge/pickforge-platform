import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, rawRunDir } from "../src/journal-core.ts";
import { RunView } from "../src/lanes-tui.ts";

const originalDataDir = process.env.PIKIT_DATA_DIR;
let dataDir: string;

const spec = { lane: "worker", task: "t", model: "openai-codex/gpt-5.6-sol", effort: "medium" as const };

function textEvent(text: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-kit-tui-"));
  process.env.PIKIT_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PIKIT_DATA_DIR;
  else process.env.PIKIT_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("RunView incremental transcript polling", () => {
  it("tails multibyte content across polls without dropping events", () => {
    const runId = "run-tui-test";
    appendEvent({ v: 1, t: new Date().toISOString(), run: runId, type: "run_created", lanes: 1, origin: "test" });
    appendEvent({ v: 1, t: new Date().toISOString(), run: runId, lane: "worker", type: "lane_created", spec });
    const dir = rawRunDir(runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "worker.jsonl");

    // First chunk: multibyte chars make byte length > UTF-16 length.
    appendFileSync(file, `${textEvent("héllo — ✔ mündo")}\n`);
    const view = new RunView(runId);
    const first = view.transcript("worker");
    expect(first.entries.some((entry) => entry.text.includes("mündo"))).toBe(true);

    // Second chunk after the multibyte offset: must not be skipped or split.
    appendFileSync(file, `${textEvent("segunda línea — completa")}\n`);
    const second = view.transcript("worker");
    expect(second.entries.some((entry) => entry.text.includes("completa"))).toBe(true);
  });

  it("holds a partial trailing line until its newline arrives", () => {
    const runId = "run-tui-partial";
    appendEvent({ v: 1, t: new Date().toISOString(), run: runId, type: "run_created", lanes: 1, origin: "test" });
    appendEvent({ v: 1, t: new Date().toISOString(), run: runId, lane: "worker", type: "lane_created", spec });
    const dir = rawRunDir(runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "worker.jsonl");

    const full = `${textEvent("only after newline")}\n`;
    appendFileSync(file, full.slice(0, 25)); // half-flushed line
    const view = new RunView(runId);
    expect(view.transcript("worker").entries.length).toBe(0);

    appendFileSync(file, full.slice(25)); // rest arrives
    const done = view.transcript("worker");
    expect(done.entries.some((entry) => entry.text.includes("only after newline"))).toBe(true);
  });
});
