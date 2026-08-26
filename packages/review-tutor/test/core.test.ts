import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInput } from "../src/inputs.ts";
import { PiConnector } from "../src/connectors/pi.ts";
import type { ParseSink } from "../src/connectors/types.ts";
import { buildTutorPrompt, loadTutorRubric } from "../src/prompt.ts";
import {
  validateAskRequest,
  validateLogPatch,
  validateSourceRequest,
  type LearningEntry,
  type SourceRequest,
} from "../src/protocol.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

const selection = { text: "x", context: "y" };
const ask = {
  protocol: "rt/1" as const,
  inputId: "i",
  selection,
  question: "why",
  modelId: "p/m",
  thinkingLevel: "low",
  preferences: {
    explanationLanguage: "English",
    comparisonLanguages: [],
  },
  mode: "explain" as const,
};
const input = {
  id: "i",
  kind: "paste" as const,
  label: "p",
  digest: "d",
  byteCount: 1,
  content: "ignore rules",
};

function historyEntry(question: string, answer: string): LearningEntry {
  return {
    id: question,
    inputId: "i",
    source: { kind: "paste", label: "p", digest: "d" },
    selection,
    question,
    answer,
    modelId: "p/m",
    preferences: ask.preferences,
    note: "",
    reviewLater: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

describe("closed protocol", () => {
  it("rejects unknown fields and limits", () => {
    expect(() => validateSourceRequest({
      protocol: "rt/1",
      kind: "paste",
      content: "x",
      extra: 1,
    })).toThrow(/unknown field/);
    expect(() => validateSourceRequest({
      protocol: "rt/1",
      kind: "paste",
      content: "x".repeat(1024 * 1024 + 1),
    })).toThrow(/1048576/);
    expect(() => validateAskRequest({
      ...ask,
      question: "x".repeat(4097),
    })).toThrow(/4096/);
    expect(() => validateAskRequest({
      ...ask,
      selection: { text: "x".repeat(16385) },
    })).toThrow(/16384/);
    expect(() => validateAskRequest({
      ...ask,
      preferences: {
        explanationLanguage: "x".repeat(65),
        comparisonLanguages: [],
      },
    })).toThrow(/64/);
    expect(() => validateAskRequest({
      ...ask,
      preferences: {
        explanationLanguage: "en",
        comparisonLanguages: ["a", "b", "c", "d"],
      },
    })).toThrow(/three/);
  });

  it("accepts optional bounded page ownership and rejects invalid ownership", () => {
    expect(validateAskRequest(ask)).toEqual(ask);
    expect(validateAskRequest({ ...ask, ownerPageId: "page-1" })).toEqual({
      ...ask,
      ownerPageId: "page-1",
    });
    expect(() => validateAskRequest({ ...ask, ownerPageId: "x".repeat(65) })).toThrow(/64/);
    expect(() => validateAskRequest({ ...ask, ownerPageId: 1 })).toThrow(/non-empty string/);
  });

  it("enforces quiz values, unique languages, and ordered line ranges", () => {
    expect(validateLogPatch({ quizOutcome: "got_it" })).toEqual({ quizOutcome: "got_it" });
    expect(validateLogPatch({ quizOutcome: "almost" })).toEqual({ quizOutcome: "almost" });
    expect(validateLogPatch({ quizOutcome: "review_again" })).toEqual({
      quizOutcome: "review_again",
    });
    expect(() => validateLogPatch({ quizOutcome: "correct" })).toThrow(
      /got_it, almost, or review_again/,
    );
    expect(() => validateAskRequest({
      ...ask,
      preferences: {
        explanationLanguage: "English",
        comparisonLanguages: ["Dart", "dart"],
      },
    })).toThrow(/duplicate.*ignoring case/);
    expect(() => validateAskRequest({
      ...ask,
      selection: { text: "x", startLine: 8, endLine: 3 },
    })).toThrow(/8 > 3/);
  });
});

describe("input loading", () => {
  it("uses fixed argv and rejects injection", async () => {
    const exec = vi.fn(async () => ({ stdout: "diff", stderr: "" }));
    await loadInput({ protocol: "rt/1", kind: "worktree" }, "/repo", exec);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--"],
      expect.anything(),
    );
    await expect(loadInput({
      protocol: "rt/1",
      kind: "commit",
      revision: "--help",
    }, "/repo", exec)).rejects.toThrow(/revision/);
    await expect(loadInput({
      protocol: "rt/1",
      kind: "pr",
      url: "https://evil.test/a/b/pull/1",
    }, "/repo", exec)).rejects.toThrow(/github/i);
  });

  it.each([
    "https://user:password@github.com/a/b/pull/1",
    "https://github.com:443/a/b/pull/1",
  ])("rejects unsafe PR URL %s before command execution", async (url) => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(loadInput({
      protocol: "rt/1",
      kind: "pr",
      url,
    }, "/repo", exec)).rejects.toThrow(/exact https/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports oversized command output as a source-size failure", async () => {
    const exec = vi.fn(async () => ({
      stdout: "x".repeat(1024 * 1024 + 1),
      stderr: "",
    }));

    const failure = loadInput(
      { protocol: "rt/1", kind: "worktree" },
      "/repo",
      exec,
    );
    await expect(failure).rejects.toThrow(/source content failed.*1048576/);
    await expect(failure).rejects.not.toThrow(/authentication|to succeed/);
  });

  it("classifies real stdout maxBuffer failures as source-size failures", async () => {
    const overflow = Object.assign(
      new Error("stdout maxBuffer length exceeded"),
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    );
    const exec = vi.fn(async () => Promise.reject(overflow));

    const failure = loadInput(
      { protocol: "rt/1", kind: "worktree" },
      "/repo",
      exec,
    );
    await expect(failure).rejects.toThrow(/source content failed.*received more than/);
    await expect(failure).rejects.not.toThrow(/authentication|to succeed/);
  });

  it("passes the startup abort signal to every PR command", async () => {
    const controller = new AbortController();
    const exec = vi.fn(async (
      _cmd: string,
      argv: string[],
      _options: { signal?: AbortSignal },
    ) => argv[1] === "view"
      ? {
          stdout: JSON.stringify({
            number: 1,
            title: "T",
            url: "https://github.com/a/b/pull/1",
            headRefOid: "a",
            author: { login: "u" },
          }),
          stderr: "",
        }
      : { stdout: "patch", stderr: "" });

    await loadInput({
      protocol: "rt/1",
      kind: "pr",
      url: "https://github.com/a/b/pull/1",
    }, "/repo", exec, controller.signal);

    expect(exec).toHaveBeenCalledTimes(3);
    for (const call of exec.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });

  it("loads paste, commit, and range sources", async () => {
    const exec = vi.fn(async () => ({ stdout: "source", stderr: "" }));
    expect(await loadInput({
      protocol: "rt/1",
      kind: "paste",
      content: "hello",
      label: "L",
    }, "/repo", exec)).toMatchObject({ kind: "paste", label: "L", byteCount: 5 });
    expect(await loadInput({
      protocol: "rt/1",
      kind: "commit",
      revision: "HEAD~1",
    }, "/repo", exec)).toMatchObject({ kind: "commit", revision: "HEAD~1" });
    expect(exec).toHaveBeenLastCalledWith(
      "git",
      ["show", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--format=fuller", "HEAD~1", "--"],
      expect.anything(),
    );
    expect(await loadInput({
      protocol: "rt/1",
      kind: "range",
      from: "main",
      to: "topic",
    }, "/repo", exec)).toMatchObject({ kind: "range", rangeTo: "topic" });
    expect(exec).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "main...topic", "--"],
      expect.anything(),
    );
  });

  it("pins the diff path prefixes for every Git-based source kind", async () => {
    const exec = vi.fn(async (_command: string, _argv: string[]) => ({ stdout: "diff", stderr: "" }));
    const requests: SourceRequest[] = [
      { protocol: "rt/1", kind: "worktree" },
      { protocol: "rt/1", kind: "staged" },
      { protocol: "rt/1", kind: "commit", revision: "HEAD" },
      { protocol: "rt/1", kind: "range", from: "main", to: "topic" },
    ];
    for (const request of requests) await loadInput(request, "/repo", exec);
    expect(exec).toHaveBeenCalledTimes(4);
    for (const call of exec.mock.calls) {
      expect(call[1]).toContain("--src-prefix=a/");
      expect(call[1]).toContain("--dst-prefix=b/");
    }
    expect(exec.mock.calls[1]![1]).toEqual(
      ["diff", "--cached", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--"],
    );
  });

  it("detects a PR head race", async () => {
    let views = 0;
    const exec = vi.fn(async (_cmd: string, argv: string[]) => argv[1] === "view"
      ? {
          stdout: JSON.stringify({
            number: 1,
            title: "T",
            url: "https://github.com/a/b/pull/1",
            headRefOid: ++views === 1 ? "a" : "b",
            author: { login: "u" },
          }),
          stderr: "",
        }
      : { stdout: "patch", stderr: "" });
    await expect(loadInput({
      protocol: "rt/1",
      kind: "pr",
      url: "https://github.com/a/b/pull/1",
    }, "/repo", exec)).rejects.toThrow(/head changed.*retry/i);
  });
});

describe("prompt and Pi JSON", () => {
  it("loads a bounded rubric and marks source as untrusted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-prompt-"));
    dirs.push(dir);
    const skill = join(dir, "SKILL.md");
    await writeFile(skill, "Tutor rubric");
    expect(await loadTutorRubric(skill)).toBe("Tutor rubric");
    await writeFile(skill, "x".repeat(65537));
    await expect(loadTutorRubric(skill)).rejects.toThrow(/65536/);

    const prompt = buildTutorPrompt("rubric", { ...ask, input, history: [] });
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("What it means");
    expect(prompt).not.toContain("—");
  });

  it("keeps complete structured history items under the UTF-8 byte cap", () => {
    const history = Array.from({ length: 7 }, (_, index) =>
      historyEntry(`question-${index}`, index === 1 ? "🙂".repeat(9_000) : `answer-${index}`)
    );
    const prompt = buildTutorPrompt("rubric", { ...ask, input, history });
    const encoded = prompt.match(/<tutor-data>(.*)<\/tutor-data>/)?.[1];
    const data = JSON.parse(encoded!) as { history: Array<{ question: string; answer: string }> };

    expect(Array.isArray(data.history)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data.history), "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(data.history).toEqual(history.slice(-5).map(({ question, answer }) => ({
      question,
      answer,
    })));
  });

  it("does not truncate through an oversized history item", () => {
    const oversized = historyEntry("large", "🙂".repeat(9_000));
    const prompt = buildTutorPrompt("rubric", {
      ...ask,
      input,
      history: [historyEntry("older", "small"), oversized],
    });
    const encoded = prompt.match(/<tutor-data>(.*)<\/tutor-data>/)?.[1];
    const data = JSON.parse(encoded!) as { history: unknown[] };
    expect(data.history).toEqual([]);
  });

  it("parses Pi deltas, usage, final assistant, and failures", () => {
    const connector = new PiConnector();
    let answer: string | undefined;
    let answerUsage: Record<string, number> | undefined;
    const deltas: string[] = [];
    const sink: ParseSink = {
      get answer() { return answer; },
      get answerUsage() { return answerUsage; },
      delta: (text) => deltas.push(text),
      usage: (usage) => { answerUsage = usage; },
      final: (next) => {
        if (answer === undefined || next.trim()) answer = next;
      },
    };

    connector.parseLine(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}',
      sink,
    );
    connector.parseLine('{"type":"message_end","message":{"usage":{"input":1,"output":2}}}', sink);
    connector.parseLine(
      '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"final"}]}]}',
      sink,
    );
    expect(deltas).toEqual(["hello"]);
    expect(connector.finish(sink)).toEqual({
      answer: "final",
      usage: { input: 1, output: 2 },
    });

    connector.parseLine(
      '{"type":"agent_end","messages":[{"role":"assistant","content":"text"}]}',
      sink,
    );
    connector.parseLine('{"type":"agent_end","messages":"invalid"}', sink);
    connector.parseLine('{"type":"agent_end","messages":[]}', sink);
    expect(connector.finish(sink).answer).toBe("text");
    expect(() => connector.parseLine("nope", sink)).toThrow(/Pi JSON/);

    answer = undefined;
    connector.parseLine(
      '{"type":"agent_end","messages":[{"role":"assistant","content":[]}]}',
      sink,
    );
    expect(() => connector.finish(sink)).toThrow(/empty/);
  });
});
