import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { pageHtml } from "../src/page.js";

const source = {
  id: "input-1",
  kind: "worktree",
  label: "Working tree",
  digest: "digest",
  content: [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const oldValue = 1;",
    "+const newValue = 2;",
    " context();",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "+export const b = true;",
  ].join("\n"),
};

const state = {
  protocol: "rt/1",
  input: source,
  models: [{ id: "model-1", label: "Model One", thinkingLevels: ["low"] }],
  questions: [],
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: { data: string }) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function boot(options: {
  width?: number;
  askResponse?: Promise<Response> | Response;
  entries?: unknown[];
  source?: typeof source;
  storedQuizIds?: string;
  stateResponses?: unknown[];
  failHeartbeat?: boolean;
} = {}) {
  FakeEventSource.instances = [];
  const window = new Window({ url: "http://127.0.0.1:43123/?session=secret-token" });
  Object.defineProperty(window, "innerWidth", { value: options.width ?? 1440, writable: true, configurable: true });
  if (options.storedQuizIds !== undefined) window.sessionStorage.setItem("reviewTutorQuizEntryIds", options.storedQuizIds);
  const script = pageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Inline page script was not composed");
  window.document.documentElement.innerHTML = pageHtml
    .replace(/^<!--[\s\S]*?-->\s*/, "")
    .replace(/<!doctype html>/i, "")
    .replace(/<script>[\s\S]*?<\/script>/, "");

  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const stateResponses = [...(options.stateResponses ?? [])];
  const bootState = { ...state, input: options.source ?? source };
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (path === "/api/state") {
      const response = stateResponses.shift() ?? bootState;
      if (response instanceof Error) throw response;
      return json(response);
    }
    if (path === "/api/log?limit=100") return json(options.entries ?? []);
    if (path === "/api/heartbeat" && options.failHeartbeat) return Promise.reject(new Error("heartbeat down"));
    if (path === "/api/ask") return options.askResponse ?? json({ id: "q-1", state: "queued", answer: "", createdAt: new Date().toISOString() });
    if (path.startsWith("/api/log/")) return json({});
    if (path.includes("/cancel")) return json({ id: "q-1", state: "cancelled", answer: "partial" });
    return json({});
  });
  Object.assign(window, {
    fetch,
    EventSource: FakeEventSource,
    Response,
    URL,
  });
  window.setInterval = vi.fn(() => 1) as never;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.eval(script);
  await flush();
  return { window, document: window.document, requests, events: FakeEventSource.instances[0] };
}

type TestDocument = InstanceType<typeof Window>["document"];

function byId(document: TestDocument, id: string): any {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function input(document: TestDocument, id: string, value: string) {
  const node = byId(document, id);
  node.value = value;
  const Event = document.defaultView!.Event;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return node;
}

describe("Review Tutor composed page", () => {
  it("contains safe local assets and an executable raw inline script", () => {
    expect(() => new Function(pageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")).not.toThrow();
    for (const forbidden of [".innerHTML", "document.write", "eval(", "<script src=", "<link rel=", "https://fonts"]) {
      expect(pageHtml).not.toContain(forbidden);
    }
    expect(pageHtml).toContain("[hidden]");
    expect(pageHtml).toContain("@media(max-width:1040px)");
    expect(pageHtml).toContain(".diff-pane {\nmin-width:0;min-height:0;");
    expect(pageHtml).toContain(".rail {\nmin-height:0;overflow-y:auto;");
    expect(pageHtml).toContain('role="region" aria-labelledby="tutor-title"');
  });

  it("bootstraps the token, cleans the URL, connects, and renders an initial multi-file diff", async () => {
    const { window, document, events } = await boot();
    expect(window.sessionStorage.getItem("reviewTutorSession")).toBe("secret-token");
    expect(window.location.search).toBe("");
    events?.onopen?.();
    expect(document.getElementById("connection")?.textContent).toBe("connected");
    expect(document.querySelectorAll(".file")).toHaveLength(2);
    expect(document.querySelectorAll("#files option")).toHaveLength(2);
    expect(document.getElementById("top-source")?.textContent).toBe("Working tree");
    expect(document.getElementById("error")?.textContent).toBe("");
  });

  it("shows only the selected source-kind fields and deduplicates language matches", async () => {
    const { document } = await boot();
    input(document, "kind", "range");
    expect(byId(document, "range-field").hidden).toBe(false);
    expect(byId(document, "revision-field").hidden).toBe(true);
    expect(byId(document, "pr-field").hidden).toBe(true);
    expect(document.querySelectorAll("#language option")).toHaveLength(10);
    input(document, "match-1", "TypeScript");
    const duplicate = (Array.from(byId(document, "match-2").options) as any[]).find((option) => option.value === "TypeScript");
    expect(duplicate?.disabled).toBe(true);
  });

  it("submits contiguous selection and applies a synchronous duplicate Ask lock", async () => {
    let resolveAsk!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveAsk = resolve; });
    const { window, document, requests } = await boot({ askResponse: pending });
    const rows = Array.from(document.querySelectorAll('.diff-row[role="button"]')) as any[];
    const reachable = rows.find((row) => row.tabIndex === 0);
    reachable.focus();
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const addition = rows.find((row) => row.tabIndex === 0);
    addition.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    addition.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    input(document, "question", "Explain this");
    const ask = byId(document, "ask");
    ask.click();
    ask.click();
    expect(ask.disabled).toBe(true);
    expect(ask.getAttribute("aria-busy")).toBe("true");
    expect(ask.textContent).toContain("Asking…");
    expect(requests.filter((request) => request.path === "/api/ask")).toHaveLength(1);
    resolveAsk(json({ id: "q-1", state: "queued", answer: "", createdAt: new Date().toISOString() }));
    await flush();
    const payload = JSON.parse(requests.find((request) => request.path === "/api/ask")?.init?.body as string);
    expect(payload.selection).toMatchObject({ file: "src/a.ts", startLine: 1, endLine: 2, text: "const newValue = 2;\ncontext();" });
    expect(ask.getAttribute("aria-busy")).toBe("false");
    expect(ask.textContent).toBe("Queued");
    expect(ask.classList.contains("busy-neutral")).toBe(true);
  });

  it("provides one reachable roving button and keyboard selection", async () => {
    const { window, document } = await boot();
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("selectable lines");
    const rows = Array.from(document.querySelectorAll('.diff-row[role="button"]')) as any[];
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const reachable = rows.find((row) => row.tabIndex === 0);
    reachable.focus();
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(reachable.getAttribute("aria-pressed")).toBe("true");
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const clear = byId(document, "clear-selection");
    clear.focus();
    clear.click();
    expect(rows.filter((row) => row.getAttribute("aria-pressed") === "true")).toHaveLength(0);
    expect(byId(document, "selection-summary").textContent).toBe("No code selected");
    expect(document.activeElement?.classList.contains("diff-row")).toBe(true);
    const disclosure = document.querySelector(".file-head button") as any;
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.getAttribute("aria-label")).toBe("Expand src/a.ts");
  });

  it("switches stable tutor semantics only for mobile, permits close while queued, and restores focus", async () => {
    const { document } = await boot({ width: 390 });
    const tutor = byId(document, "tutor");
    const opener = byId(document, "mobile-ask");
    expect(tutor.getAttribute("role")).toBe("region");
    opener.focus();
    opener.click();
    expect(tutor.getAttribute("role")).toBe("dialog");
    expect(tutor.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById("diff-pane")?.hasAttribute("inert")).toBe(true);
    input(document, "question", "Continue in background");
    (byId(document, "ask")).click();
    await flush();
    byId(document, "close-tutor").click();
    expect(tutor.getAttribute("role")).toBe("region");
    expect(tutor.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(opener.textContent).toContain("queued");
  });

  it("associates quiz controls only with the matching result and persists its entry id", async () => {
    const { window, document, events } = await boot();
    input(document, "question", "Quiz this");
    input(document, "mode", "quiz");
    byId(document, "ask").click();
    await flush();
    const base = { inputId: source.id, source, selection: { text: "" }, modelId: "model-1", createdAt: new Date().toISOString() };
    events?.emit("log_update", { ...base, id: "unrelated", question: "Different question" });
    expect(window.sessionStorage.getItem("reviewTutorQuizEntryIds")).toBeNull();
    events?.emit("log_update", { ...base, id: "quiz-entry", question: "Quiz this" });
    expect(JSON.parse(window.sessionStorage.getItem("reviewTutorQuizEntryIds") ?? "[]")).toEqual(["quiz-entry"]);
  });

  it("parses only real unified diffs and preserves ++/-- code inside hunks", async () => {
    const special = { ...source, content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -7,2 +7,2 @@\n---i\n+++i\n context" };
    const parsed = await boot({ source: special });
    expect(parsed.document.querySelector(".deletion .code")?.textContent).toBe("--i");
    expect(parsed.document.querySelector(".addition .code")?.textContent).toBe("++i");
    expect(parsed.document.querySelector(".context .line-no")?.textContent).toBe("8");
    const plain = await boot({ source: { ...source, label: "paste.ts", content: "@@decorator\n++value;\n--value;" } });
    expect(plain.document.querySelectorAll(".file.plain .diff-row[role=button]")).toHaveLength(3);
    expect(plain.document.querySelectorAll(".file.plain .line-no")).toHaveLength(3);
  });

  it.each(["{bad", "{}", "42"])("recovers from corrupt quiz storage %s", async (storedQuizIds) => {
    const { document, window } = await boot({ storedQuizIds });
    expect(document.querySelectorAll(".file")).toHaveLength(2);
    expect(byId(document, "connection").textContent).toBe("starting");
    expect(window.sessionStorage.getItem("reviewTutorQuizEntryIds")).toBeNull();
  });

  it.each([
    ["plain", ["diff --git a/src/my file.ts b/src/my file.ts", "@@ -1 +1 @@", "+export const spaced = true;"]],
    ["quoted", ['diff --git "a/src/my file.ts" "b/src/my file.ts"', "@@ -1 +1 @@", "+export const spaced = true;"]],
  ])("parses diff headers with spaces in file paths (%s)", async (_variant, contentLines) => {
    const spaced = { ...source, content: contentLines.join("\n") };
    const { document } = await boot({ source: spaced });
    expect(document.querySelector(".file-path")?.textContent).toBe("src/my file.ts");
  });

  it("keeps heartbeat failures out of the persistent error banner", async () => {
    const { window, document } = await boot({ failHeartbeat: true });
    const tick = (window.setInterval as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as (() => void) | undefined;
    if (!tick) throw new Error("Heartbeat interval was not registered");
    tick();
    await flush();
    expect(byId(document, "error").textContent).toBe("");
    expect(byId(document, "lifecycle").textContent).toBe("Heartbeat failed.");
  });

  it("omits fabricated coordinates for mixed old/new selection and reports count", async () => {
    const { window, document, requests } = await boot();
    const row = document.querySelector('.diff-row[role="button"][tabindex="0"]') as any;
    row.focus();
    row.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect(byId(document, "selection-summary").textContent).toBe("src/a.ts · 2 selected lines");
    input(document, "question", "Mixed?");
    byId(document, "ask").click();
    await flush();
    const payload = JSON.parse(requests.find((request) => request.path === "/api/ask")!.init!.body as string);
    expect(payload.selection).toMatchObject({ file: "src/a.ts", text: "const oldValue = 1;\nconst newValue = 2;" });
    expect(payload.selection).not.toHaveProperty("startLine");
    expect(payload.selection).not.toHaveProperty("endLine");
  });

  it("refuses UTF-8 oversized selection and preserves the prior valid selection", async () => {
    const huge = { ...source, content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n+ok\n+" + "é".repeat(9000) };
    const { window, document } = await boot({ source: huge });
    const rows = Array.from(document.querySelectorAll('.diff-row[role="button"]')) as any[];
    rows[0].dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(byId(document, "selection-preview").textContent).toBe("ok");
    rows[1].dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    expect(byId(document, "error").textContent).toContain("16 KiB");
    expect(byId(document, "selection-preview").textContent).toBe("ok");
    rows[0].dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(byId(document, "error").textContent).toBe("");
    expect(byId(document, "selection-preview").textContent).toBe("ok");
  });

  it("tears down an open mobile dialog on resize and ignores same-source replay", async () => {
    const { window, document, events } = await boot({ width: 390 });
    const row = document.querySelector('.diff-row[role="button"][tabindex="0"]') as any;
    row.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    events?.emit("source", source);
    expect(byId(document, "selection-summary").textContent).not.toBe("No code selected");
    byId(document, "mobile-ask").click();
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event("resize"));
    expect(byId(document, "tutor").classList.contains("open")).toBe(false);
    expect(byId(document, "tutor").getAttribute("role")).toBe("region");
    expect(byId(document, "diff-pane").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("reconciles a pre-response ask race to canonical running answer and keeps later deltas", async () => {
    const canonical = { id: "q-race", state: "running", answer: "canonical " };
    const { document, events } = await boot({
      askResponse: json({ id: "q-race", state: "queued", answer: "" }),
      stateResponses: [state, { ...state, questions: [canonical] }],
    });
    input(document, "question", "Race");
    byId(document, "ask").click();
    await flush();
    expect(byId(document, "answer-text").textContent).toBe("canonical ");
    events?.emit("answer_delta", { id: "q-race", text: "continued" });
    expect(byId(document, "answer-text").textContent).toBe("canonical continued");
    expect(byId(document, "lifecycle").textContent).toBe("Tutor is answering.");
  });

  it("keeps an accepted question queued when state reconciliation fails", async () => {
    const { document } = await boot({
      askResponse: json({ id: "q-accepted", state: "queued", answer: "" }),
      stateResponses: [state, new Error("state unavailable")],
    });
    input(document, "question", "Still accepted?");
    byId(document, "ask").click();
    await flush();
    expect(byId(document, "question-state").textContent).toBe("queued");
    expect(byId(document, "ask").textContent).toBe("Queued");
    expect(byId(document, "error").textContent).toContain("State reconciliation failed:");
    expect(byId(document, "error").textContent).toContain("state unavailable");
  });

  it("rejects an older identical quiz PATCH echo and preserves focused drafts during log updates", async () => {
    const entry = { id: "entry-1", inputId: source.id, source, selection: { text: "" }, question: "Same quiz", answer: "A", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const { window, document, events } = await boot({ entries: [entry] });
    const note = document.querySelector(".log-entry textarea") as any;
    note.focus();
    note.value = "draft in progress";
    note.dispatchEvent(new window.Event("input", { bubbles: true }));
    events?.emit("log_update", { ...entry, id: "other-entry", question: "Other" });
    await flush();
    expect(document.activeElement).toBe(note);
    expect(note.value).toBe("draft in progress");
    input(document, "question", "Same quiz");
    input(document, "mode", "quiz");
    byId(document, "ask").click();
    await flush();
    events?.emit("log_update", { ...entry, id: "old-identical", createdAt: new Date(Date.now() - 1000).toISOString() });
    expect(window.sessionStorage.getItem("reviewTutorQuizEntryIds")).toBeNull();
  });

  it("renders deferred log entries after a note save blurs", async () => {
    const entry = { id: "entry-1", inputId: source.id, source, selection: { text: "" }, question: "First", answer: "A", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const entries = [entry];
    const { window, document, events, requests } = await boot({ entries });
    const note = document.querySelector(".log-entry textarea") as any;
    note.focus();
    note.value = "draft in progress";
    note.dispatchEvent(new window.Event("input", { bubbles: true }));
    entries.push({ ...entry, id: "entry-2", question: "Arrived while editing" });
    events?.emit("log_update", { ...entry, id: "entry-2", question: "Arrived while editing" });
    await flush();
    expect(document.querySelectorAll(".log-entry")).toHaveLength(1);
    note.blur();
    await flush();
    expect(requests.some((request) => request.path === "/api/log/entry-1" && JSON.parse(request.init?.body as string).note === "draft in progress")).toBe(true);
    expect(document.querySelectorAll(".log-entry")).toHaveLength(2);
    expect(Array.from(document.querySelectorAll(".log-entry h3")).map((node) => node.textContent)).toEqual(["Arrived while editing", "First"]);
  });

  it("renders terminal answers and sends exact note, review-later, and quiz PATCH payloads", async () => {
    const entry = { id: "entry-1", inputId: source.id, source, selection: { text: "x" }, question: "Why?", answer: "Line one\nLine two", modelId: "model-1", preferences: {}, note: "", reviewLater: false, quizOutcome: "almost", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const { document, requests, events } = await boot({ entries: [entry] });
    events?.emit("state", { input: source, questions: [{ id: "q-1", state: "running", answer: "" }] });
    events?.emit("question", { id: "q-1", state: "answered", answer: "Final answer" });
    expect(document.getElementById("answer-text")?.textContent).toBe("Final answer");
    const note = document.querySelector(".log-entry textarea") as any;
    if (!note) throw new Error("Missing note field");
    note.value = "Remember this";
    note.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    note.dispatchEvent(new document.defaultView!.Event("blur"));
    (document.querySelector(".review") as any)?.click();
    const quiz = (Array.from(document.querySelectorAll(".entry-actions button")) as any[]).find((button) => button.textContent === "Got it");
    expect(document.querySelector('.quiz-outcome[aria-pressed="true"]')?.textContent).toBe("Almost");
    quiz?.click();
    await vi.waitFor(() => {
      expect(requests.some((request) => request.path === "/api/log/entry-1" && JSON.parse(request.init?.body as string).quizOutcome === "got_it")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(byId(document, "error").textContent).toBe("");
      expect(Array.from(document.querySelectorAll(".quiz-outcome")).map((button) => `${button.textContent}:${button.getAttribute("aria-pressed")}`)).toEqual([
        "Got it:true",
        "Almost:false",
        "Review again:false",
      ]);
    });
    const patches = requests.filter((request) => request.path === "/api/log/entry-1").map((request) => JSON.parse(request.init?.body as string));
    expect(patches).toEqual(expect.arrayContaining([{ note: "Remember this" }, { reviewLater: true }, { quizOutcome: "got_it" }]));
    expect(document.querySelector(".log-answer")?.tagName).toBe("DIV");
  });
});
