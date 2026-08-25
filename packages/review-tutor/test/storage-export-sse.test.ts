import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import { exportLearningHtml } from "../src/export-html.ts";
import { createReviewTutorFlags } from "../src/flags.ts";
import {
  appendEntry,
  foldLog,
  initProjectPaths,
  updateEntry,
} from "../src/log.ts";
import { resolveStatePaths } from "../src/paths.ts";
import type { LearningEntry, QuizOutcome } from "../src/protocol.ts";
import { SseHub } from "../src/sse.ts";

const dirs: string[] = [];
const exportRegistry = createConnectorRegistry({
  flags: createReviewTutorFlags(),
  piModels: [],
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function entry(quizOutcome?: QuizOutcome): LearningEntry {
  return {
    id: `e-${quizOutcome ?? "none"}`,
    inputId: "i",
    source: {
      kind: "pr",
      label: "<PR>",
      digest: "d",
      githubUrl: "https://github.com/a/b/pull/1",
      headSha: "abc",
    },
    selection: {
      text: "<script>x</script>",
      context: "& hostile <img src=x>",
    },
    question: "<q>",
    answer: "<a>",
    modelId: "p/m",
    preferences: {
      explanationLanguage: "English",
      comparisonLanguages: ["Dart", "Rust"],
    },
    note: "<note>",
    reviewLater: true,
    ...(quizOutcome ? { quizOutcome } : {}),
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

async function temporaryPaths() {
  const home = await mkdtemp(join(tmpdir(), "rt-home-"));
  dirs.push(home);
  return resolveStatePaths("/repo", home);
}

describe("private persistence", () => {
  it("rejects relative overrides and appends, folds, and updates privately", async () => {
    expect(() => resolveStatePaths("/repo", "relative")).toThrow(/absolute/);
    expect(() => resolveStatePaths("/repo", "")).toThrow(/non-empty/);
    const paths = await temporaryPaths();
    await initProjectPaths(paths, "/repo");
    expect((await stat(paths.projectDir)).mode & 0o077).toBe(0);
    await appendEntry(paths, entry());
    await updateEntry(paths, "e-none", { note: "new", reviewLater: false });
    expect(await foldLog(paths)).toMatchObject([{
      id: "e-none",
      note: "new",
      reviewLater: false,
    }]);
    await expect(updateEntry(paths, "missing", { note: "x" })).rejects.toThrow(/exist/);
    await writeFile(paths.logFile, `${await readFile(paths.logFile, "utf8")}{bad`);
    expect(await foldLog(paths)).toHaveLength(1);
    await writeFile(
      paths.logFile,
      `{bad\n${JSON.stringify({ type: "entry", entry: entry() })}\n`,
    );
    await expect(foldLog(paths)).rejects.toThrow(/line 1/);
  });

  it.each([
    ["malformed", "{bad", /valid JSON/],
    [
      "mismatched",
      JSON.stringify({
        protocol: "rt/1",
        canonicalRepo: "/other",
        projectKey: "wrong",
      }),
      /mismatched metadata/,
    ],
  ])("fails closed for %s existing project metadata", async (_name, content, error) => {
    const paths = await temporaryPaths();
    await initProjectPaths(paths, "/repo");
    await writeFile(paths.projectFile, content);
    await expect(initProjectPaths(paths, "/repo")).rejects.toThrow(error);
  });

  it("separates a valid final JSON record from the next append", async () => {
    const paths = await temporaryPaths();
    await initProjectPaths(paths, "/repo");
    await writeFile(
      paths.logFile,
      JSON.stringify({ type: "entry", entry: entry() }),
    );

    await appendEntry(paths, { ...entry(), id: "e2", inputId: "i2" });

    expect((await foldLog(paths)).map((value) => value.id)).toEqual(["e-none", "e2"]);
    const raw = await readFile(paths.logFile, "utf8");
    expect(raw).toContain("}\n{");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("standalone export", () => {
  it("exports complete safe records and supports zero entries", () => {
    const html = exportLearningHtml([
      entry("got_it"),
      entry("almost"),
      entry("review_again"),
      { ...entry(), id: "colon-model", modelId: "ollama/qwen3:8b" },
      { ...entry(), id: "namespaced-colon-model", modelId: "pi:ollama/qwen3:8b" },
      { ...entry(), id: "invalid-model", modelId: 42 } as unknown as LearningEntry,
      { ...entry(), id: "disabled-harness", modelId: "codex:gpt-5.6-sol" },
    ], exportRegistry);
    expect(html).toContain("Private code warning");
    expect(html).toContain("GitHub is the source of truth");
    expect(html).toContain("https://github.com/a/b/pull/1");
    expect(html).toContain("abc");
    expect(html).toContain("Dart, Rust");
    expect(html).toContain("Got it");
    expect(html).toContain("Almost");
    expect(html).toContain("Review again");
    expect(html.match(/<dt>Harness<\/dt><dd>Pi<\/dd>/g)).toHaveLength(6);
    expect(html.match(/<dt>Model<\/dt><dd>ollama\/qwen3:8b<\/dd>/g)).toHaveLength(2);
    expect(html).toContain("<dt>Model</dt><dd>42</dd>");
    expect(html).toContain("<dt>Harness</dt><dd>codex</dd>");
    expect(html).toContain("<dt>Model</dt><dd>gpt-5.6-sol</dd>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&amp; hostile &lt;img src=x&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);

    const empty = exportLearningHtml([], exportRegistry);
    expect(empty).toContain("No learning entries yet");
    expect(empty).not.toContain("<article>");
  });
});

describe("SSE replay", () => {
  it("uses monotonic ids and bounded clean replay", () => {
    const hub = new SseHub(2);
    expect(hub.emit("hello", {})).toMatchObject({ id: 1 });
    hub.emit("state", {});
    hub.emit("bye", {});
    expect(hub.since(1).map((event) => event.id)).toEqual([2, 3]);
    expect(hub.since(3)).toEqual([]);
  });

  it("unicasts without ids, replay changes, or delivery to another client", () => {
    const hub = new SseHub();
    const firstWrite = vi.fn(() => true);
    const secondWrite = vi.fn(() => true);
    const first = {
      destroyed: false,
      writableEnded: false,
      write: firstWrite,
    } as unknown as ServerResponse;
    const second = {
      destroyed: false,
      writableEnded: false,
      write: secondWrite,
    } as unknown as ServerResponse;
    hub.connect(first, 0);
    hub.connect(second, 0);

    expect(hub.unicast(first, "state", { local: true })).toBe(true);
    expect(firstWrite).toHaveBeenCalledWith(
      'event: state\ndata: {"local":true}\n\n',
    );
    expect(secondWrite).not.toHaveBeenCalled();
    expect(hub.since(0)).toEqual([]);
    expect(hub.emit("bye", {})).toMatchObject({ id: 1 });
    expect(secondWrite).toHaveBeenCalledTimes(1);
  });

  it("removes dead responses without throwing and preserves replay ids", () => {
    const hub = new SseHub();
    hub.emit("hello", {});
    hub.emit("state", {});
    const write = vi.fn(() => {
      throw new Error("socket closed");
    });
    const response = {
      destroyed: false,
      writableEnded: false,
      write,
    } as unknown as ServerResponse;

    expect(() => hub.connect(response, 0)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(() => hub.emit("bye", {})).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(hub.since(0).map((event) => event.id)).toEqual([1, 2, 3]);

    const deadWrite = vi.fn();
    const dead = {
      destroyed: true,
      writableEnded: false,
      write: deadWrite,
    } as unknown as ServerResponse;
    hub.connect(dead, 0);
    expect(deadWrite).not.toHaveBeenCalled();
  });
});
