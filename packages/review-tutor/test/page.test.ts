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
    "@@ -0,0 +1,2 @@",
    "+import type { a } from './a.js';",
    "+export const b = true;",
  ].join("\n"),
};

const state = {
  protocol: "rt/1",
  input: source,
  models: [{ id: "model-1", label: "Model One", thinkingLevels: ["low"] }],
  questions: [],
};

const structure = {
  protocol: "rt/1",
  inputId: source.id,
  neighbours: { state: "off", count: 0 },
  comparison: {
    kind: "worktree",
    label: "Working tree",
    from: "index",
    to: "working tree",
    partial: true,
    reasons: ["One file exceeded the analysis limit."],
  },
  files: [
    { path: "src/b.ts", status: "added", additions: 2, deletions: 0, analyzed: true },
    { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, analyzed: true },
    { path: "src/old.ts", status: "removed", additions: 0, deletions: 2, analyzed: true },
    { path: "src/new.ts", status: "renamed", renamedFrom: "src/legacy.ts", additions: 0, deletions: 0, analyzed: true },
    { path: "vendor/generated.ts", status: "modified", additions: 3, deletions: 3, analyzed: false, reason: "File exceeded the statement limit." },
  ],
  edges: [
    { from: "src/b.ts", to: "src/a.ts", kind: "import", typeOnly: true, status: "added", specifier: "./a.js", evidence: [{ path: "src/b.ts", line: 1, text: "import type { a } from './a.js';" }] },
    { from: "src/a.ts", to: "src/new.ts", kind: "reexport", typeOnly: false, status: "modified", specifier: "./new.js", evidence: [{ path: "src/a.ts", line: 2, text: "export { value } from './new.js';" }] },
    { from: "src/old.ts", to: "src/a.ts", kind: "require", typeOnly: false, status: "removed", specifier: "./a", evidence: [{ path: "src/old.ts", line: 1, text: "require('./a');" }] },
    { from: "src/new.ts", to: "src/a.ts", kind: "dynamic-import", typeOnly: false, status: "unchanged", specifier: "./a.js", evidence: [] },
  ],
  limits: {
    maxFiles: 200,
    maxEdges: 2000,
    maxEvidencePerEdge: 4,
    truncated: true,
    omitted: [{ path: "src/skipped.ts", reason: "Edge limit reached." }],
  },
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

function logResponse(value: Promise<Response> | Response | unknown[] | undefined, fallback: unknown[]) {
  if (value instanceof Promise || value instanceof Response) return value;
  return json(value ?? fallback);
}

function stateResponse(value: unknown) {
  if (value instanceof Error) throw value;
  return json(value);
}

function structureResponse(value: Promise<Response> | Response | unknown | Error) {
  if (value instanceof Error) throw value;
  return value instanceof Promise || value instanceof Response ? value : json(value);
}

function blockStructureStorageReads(window: Window, options: { throwStructureModeRead?: boolean; throwStructureNeighboursRead?: boolean }) {
  if (!options.throwStructureModeRead && !options.throwStructureNeighboursRead) return;
  const getItem = window.sessionStorage.getItem.bind(window.sessionStorage);
  window.sessionStorage.getItem = vi.fn((key: string) => {
    if (options.throwStructureModeRead && key === "reviewTutorStructureMode") throw new Error("storage blocked");
    if (options.throwStructureNeighboursRead && key === "reviewTutorStructureNeighbours") throw new Error("storage blocked");
    return getItem(key);
  });
}

async function boot(options: {
  width?: number;
  askResponse?: Promise<Response> | Response;
  cancelResponse?: Promise<Response> | Response;
  entries?: unknown[];
  logResponses?: Array<Promise<Response> | Response | unknown[]>;
  source?: typeof source;
  storedPageId?: string;
  storedQuizIds?: string;
  storedStructureMode?: string;
  throwStructureModeRead?: boolean;
  storedStructureNeighbours?: string;
  throwStructureNeighboursRead?: boolean;
  stateResponses?: unknown[];
  structureResponses?: Array<Promise<Response> | Response | unknown | Error>;
  failHeartbeat?: boolean;
  railCollapsed?: boolean;
} = {}) {
  FakeEventSource.instances = [];
  const window = new Window({ url: "http://127.0.0.1:43123/?session=secret-token" });
  Object.defineProperty(window, "innerWidth", { value: options.width ?? 1440, writable: true, configurable: true });
  if (options.storedPageId !== undefined) window.sessionStorage.setItem("reviewTutorPageId", options.storedPageId);
  if (options.storedQuizIds !== undefined) window.sessionStorage.setItem("reviewTutorQuizEntryIds", options.storedQuizIds);
  if (options.storedStructureMode !== undefined) window.sessionStorage.setItem("reviewTutorStructureMode", options.storedStructureMode);
  if (options.storedStructureNeighbours !== undefined) window.sessionStorage.setItem("reviewTutorStructureNeighbours", options.storedStructureNeighbours);
  if (options.railCollapsed) window.sessionStorage.setItem("reviewTutorRailCollapsed", "1");
  blockStructureStorageReads(window, options);
  const script = pageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Inline page script was not composed");
  window.document.documentElement.innerHTML = pageHtml
    .replace(/^<!--[\s\S]*?-->\s*/, "")
    .replace(/<!doctype html>/i, "")
    .replace(/<script>[\s\S]*?<\/script>/, "");

  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const stateResponses = [...(options.stateResponses ?? [])];
  const logResponses = [...(options.logResponses ?? [])];
  const structureResponses = [...(options.structureResponses ?? [structure])];
  const bootState = { ...state, input: options.source ?? source };
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (path === "/api/state") return stateResponse(stateResponses.shift() ?? bootState);
    if (path === "/api/log?limit=100") return logResponse(logResponses.shift(), options.entries ?? []);
    if (path === "/api/structure" || path === "/api/structure?neighbours=1") return structureResponse(structureResponses.shift() ?? structure);
    if (path === "/api/heartbeat" && options.failHeartbeat) return Promise.reject(new Error("heartbeat down"));
    if (path === "/api/ask") return options.askResponse ?? json({ id: "q-1", state: "queued", answer: "", createdAt: new Date().toISOString() });
    if (path.startsWith("/api/log/")) return json({});
    if (path.includes("/cancel")) return options.cancelResponse ?? json({ id: "q-1", state: "cancelled", answer: "partial" });
    return json({});
  });
  let nextFrameId = 1;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const frames = {
    flush() {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      callbacks.forEach((callback) => callback(0));
    },
    get pending() { return pendingFrames.size; },
  };
  Object.assign(window, {
    fetch,
    EventSource: FakeEventSource,
    Response,
    URL,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => pendingFrames.delete(id),
  });
  window.setInterval = vi.fn(() => 1) as never;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.eval(script);
  await flush();
  return { window, document: window.document, requests, events: FakeEventSource.instances[0], frames };
}

type TestDocument = InstanceType<typeof Window>["document"];

function byId(document: TestDocument, id: string): any {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function selectableRows(document: TestDocument) {
  return Array.from(document.querySelectorAll(".diff-row[data-row]")) as any[];
}

function lineControl(row: any) {
  const control = row.querySelector(".line-select");
  if (!control) throw new Error("Missing selectable line control");
  return control;
}

function pressEnter(window: InstanceType<typeof Window>, control: any) {
  if (control.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    control.click();
}

function input(document: TestDocument, id: string, value: string) {
  const node = byId(document, id);
  node.value = value;
  const Event = document.defaultView!.Event;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return node;
}

type GraphPoint = { x: number; y: number };
type GraphRect = GraphPoint & { width: number; height: number };

function graphPathPoints(path: any): GraphPoint[] {
  const values = (path.getAttribute("d")?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
}

function segmentIntersectsRect(start: GraphPoint, end: GraphPoint, rect: GraphRect) {
  const inset = 0.001;
  const left = rect.x + inset, right = rect.x + rect.width - inset;
  const top = rect.y + inset, bottom = rect.y + rect.height - inset;
  let near = 0, far = 1;
  const dimensions: Array<[number, number, number, number]> = [
    [start.x, end.x - start.x, left, right],
    [start.y, end.y - start.y, top, bottom],
  ];
  for (const [origin, delta, minimum, maximum] of dimensions) {
    if (Math.abs(delta) < inset) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta, second = (maximum - origin) / delta;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return false;
  }
  return true;
}

function graphNodeRects(document: TestDocument): GraphRect[] {
  return Array.from(document.querySelectorAll(".structure-graph-node rect")).map((rect: any) => ({
    x: Number(rect.getAttribute("x")),
    y: Number(rect.getAttribute("y")),
    width: Number(rect.getAttribute("width")),
    height: Number(rect.getAttribute("height")),
  }));
}

function expectGraphPathsClearNodes(document: TestDocument) {
  const rects = graphNodeRects(document);
  for (const path of Array.from(document.querySelectorAll(".structure-graph-edge .structure-graph-line")) as any[]) {
    const points = graphPathPoints(path);
    for (let index = 1; index < points.length; index++)
      expect(rects.some((rect) => segmentIntersectsRect(points[index - 1]!, points[index]!, rect)), path.getAttribute("d")).toBe(false);
  }
}

describe("Review Tutor composed page", () => {
  it("contains safe local assets and an executable raw inline script", () => {
    expect(() => new Function(pageHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")).not.toThrow();
    for (const forbidden of [".innerHTML", "document.write", "eval(", "<script src=", "<link rel=", "https://fonts"]) {
      expect(pageHtml).not.toContain(forbidden);
    }
    expect(pageHtml).toContain("[hidden]");
    expect(pageHtml).toContain("@media(max-width:860px)");
    expect(pageHtml).toContain(".diff-pane {\nmin-width:0;min-height:0;");
    expect(pageHtml).toContain(".toolbar select {\nwidth:auto;flex:1 1 120px;min-width:120px;max-width:280px}");
    expect(pageHtml).toContain(".rail {\nmin-height:0;overflow-y:auto;");
    expect(pageHtml).toContain('role="region" aria-labelledby="tutor-title"');
    expect(pageHtml).toContain(".diff-pane>.tutor.open");
    expect(pageHtml).toContain("max-height:100%;overflow:auto");
    expect(pageHtml).toContain(".source-setup {\nmin-height:0;max-height:100%;overflow:auto");
    expect(pageHtml).toContain("--muted:#8b8b93");
    expect(pageHtml).toContain(".line-no {\ndisplay:flex;align-items:flex-start;justify-content:flex-end");
    expect(pageHtml).toContain("button.line-select {\ndisplay:flex;align-items:flex-start;justify-content:flex-end");
    expect(pageHtml).toContain("border:0;border-right:1px solid var(--hairline)");
    expect(pageHtml).toContain("function anchorComposer(forceDock = false)");
    expect(pageHtml).toContain("function renderDiff() {\n    anchorComposer(true)");
    expect(pageHtml).toContain('id="open-config" class="ghost open-config" aria-haspopup="dialog" aria-controls="config-dialog"');
    expect(pageHtml).toContain('<aside id="config-dialog" class="rail"');
  });

  it("wraps long diff lines instead of creating a horizontal scroll track", () => {
    expect(pageHtml).toContain(".rows {\nmin-width:0");
    expect(pageHtml).toContain("grid-template-columns:52px 52px 24px minmax(0,1fr)");
    expect(pageHtml).toContain("grid-template-columns:52px 24px minmax(0,1fr)");
    expect(pageHtml).toContain(".code {\nwhite-space:pre-wrap;overflow-wrap:anywhere");
    expect(pageHtml).not.toContain("min-width:max-content");
    expect(pageHtml).not.toContain("minmax(500px,1fr)");
  });

  it("keeps the CSS and JS stacked breakpoints in lockstep at 860", () => {
    expect(pageHtml.match(/MOBILE_BREAKPOINT = (\d+)/)?.[1]).toBe("860");
    expect(pageHtml.match(/@media\(max-width:(\d+)px\)/)?.[1]).toBe("860");
  });

  it("keeps a fluid tutor rail on the desktop grid without clipping the log header", () => {
    expect(pageHtml).toContain("grid-template-columns:minmax(0,1fr) clamp(320px,30vw,400px)");
    expect(pageHtml).toMatch(/\.log-head \{\n[^}]*flex-wrap:wrap/);
  });

  it("uses compact composer rhythm and a right-aligned selection action", () => {
    expect(pageHtml).toContain('class="selection-head"');
    expect(pageHtml).toMatch(/\.selection-head \{\n[^}]*display:flex[^}]*gap:10px/);
    expect(pageHtml).toMatch(/\.selection-head \.selection-meta \{\n[^}]*min-width:0[^}]*text-overflow:ellipsis/);
    expect(pageHtml).toContain(".ask-helper:empty");
    expect(pageHtml).toContain("margin-top:12px;padding-top:10px");
    expect(pageHtml).toContain(".tutored-badge::before");
    expect(pageHtml).toContain("inset:-2px");
    expect(pageHtml).toContain(".log-entry + .log-entry");
    expect(pageHtml).toContain("border-top:1px solid var(--hairline-strong);margin-top:20px;padding-top:20px");
  });

  it("scrolls stacked mode on a full-height body so pinned bars never unstick", () => {
    const media = pageHtml.slice(pageHtml.indexOf("@media(max-width:"));
    expect(media).toContain("body {\nheight:auto;min-height:100%");
    expect(media).toContain(".diff-scroll {\noverflow:visible}");
    expect(media).toContain(".file-head {\ntop:var(--filehead-top)");
    expect(pageHtml).toContain(".log-section {\ncontain:layout");
    expect(pageHtml).toContain("--filehead-top:calc(var(--topbar-h) + 50px)");
    expect(media).toContain("--filehead-top:calc(var(--topbar-h) + 105px)");
    expect(media).toContain("--filehead-top:calc(var(--topbar-h) + 153px)");
  });

  it("keeps the stacked toolbar unclipped with a full-width Change source button", () => {
    const media = pageHtml.slice(pageHtml.indexOf("@media(max-width:"));
    const toolbar = media.match(/\.toolbar \{\n([^}]*)\}/)?.[1] ?? "";
    expect(toolbar).toContain("flex-wrap:wrap");
    expect(toolbar).not.toContain("overflow:hidden");
    expect(media).toContain(".select-toggle,.source-change {\ndisplay:block;width:auto!important;padding:0 8px!important}");
    expect(media).toContain(".toolbar select {\nflex:1 1 100%}");
    expect(media).toContain(".toolbar {\ncolumn-gap:2px}");
    expect(media).toContain(".toolbar .totals {\nmargin-left:0}");
  });

  it("keeps native diff selection and the real line action affordance separate", () => {
    expect(pageHtml).toMatch(/\.marker \{\n[^}]*user-select:none/);
    expect(pageHtml).toMatch(/\.line-action \{\n[^}]*pointer-events:auto/);
    expect(pageHtml).not.toContain(".line-no:first-child:before");
    expect(pageHtml).toContain("Shift-click line numbers to extend the selection. Select + to ask.");
  });

  it("composes the Pickforge mark and token system instead of fake window dots", () => {
    const mark = pageHtml.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0];
    expect(mark).toBeDefined();
    expect(mark).toContain('stroke="#F2F2F3"');
    expect(mark).toContain('fill="#FF7A1A"');
    expect(pageHtml).not.toContain('class="dots"');
    expect(pageHtml).toContain('--control-h:36px');
    expect(pageHtml).toContain('--control-h-touch:44px');
    expect(pageHtml).toContain('class="connection" data-state="starting"');
    expect(pageHtml).toContain('.connection[data-state="connected"]');
  });

  it("splits stable composer, configuration, live regions, and learning log ownership", async () => {
    const { document } = await boot();
    const tutor = byId(document, "tutor");
    const config = byId(document, "config-section");
    for (const id of ["mode", "question", "ask", "cancel", "answer", "selection-summary"])
      expect(tutor.contains(byId(document, id))).toBe(true);
    for (const id of ["harness", "model", "thinking", "language", "match-1", "match-2", "match-3"])
      expect(config.contains(byId(document, id))).toBe(true);
    expect(byId(document, "error").parentElement).toBe(document.body);
    expect(byId(document, "lifecycle").parentElement).toBe(document.body);
    expect(byId(document, "log-section").parentElement).toBe(byId(document, "diff-scroll"));
    expect(byId(document, "structure-section").previousElementSibling).toBe(byId(document, "diff"));
    expect(byId(document, "log-section").previousElementSibling).toBe(byId(document, "structure-section"));
    expect(byId(document, "diff").getAttribute("role")).toBe("tabpanel");
    expect(byId(document, "structure-section").getAttribute("role")).toBe("tabpanel");
    expect(byId(document, "structure-content").getAttribute("role")).toBe("tabpanel");
    expect(byId(document, "structure-content").getAttribute("aria-labelledby")).toBe("structure-mode-list");
    expect(byId(document, "structure-content").tabIndex).toBe(0);
    expect(byId(document, "structure-graph").getAttribute("role")).toBe("tabpanel");
    expect(byId(document, "structure-graph").getAttribute("aria-labelledby")).toBe("structure-mode-graph");
    expect(byId(document, "structure-graph").tabIndex).toBe(0);
    expect(byId(document, "log-section").getAttribute("role")).toBe("tabpanel");
    expect(byId(document, "log-section").hidden).toBe(true);
    expect(byId(document, "view-diff").getAttribute("aria-selected")).toBe("true");
    expect(byId(document, "view-log").getAttribute("aria-selected")).toBe("false");
    expect(Array.from(byId(document, "harness").options).map((item: any) => [item.value, item.textContent])).toEqual([["pi", "Pi"]]);
  });

  it("adds Structure to the peer tablist with roving keyboard focus", async () => {
    const { window, document } = await boot();
    const tabs = Array.from(byId(document, "view-switch").querySelectorAll('[role="tab"]')) as any[];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Diff", "Structure", "Learning log"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    byId(document, "view-diff").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(byId(document, "view-structure"));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(Array.from(byId(document, "view-switch").querySelectorAll('.view-tab[tabindex="0"]'))).toEqual([byId(document, "view-structure")]);
    byId(document, "view-structure").dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(byId(document, "view-log"));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("defaults the Structure switch to List and persists Graph per tab without refetching", async () => {
    const loaded = await boot({ width: 860 });
    byId(loaded.document, "view-structure").click();
    await flush();

    expect(byId(loaded.document, "structure-mode-list").getAttribute("aria-selected")).toBe("true");
    expect(byId(loaded.document, "structure-content").hidden).toBe(false);
    expect(loaded.window.sessionStorage.getItem("reviewTutorStructureMode")).toBeNull();
    byId(loaded.document, "structure-mode-graph").click();
    expect(loaded.window.sessionStorage.getItem("reviewTutorStructureMode")).toBe("graph");
    expect(byId(loaded.document, "structure-content").hidden).toBe(true);
    expect(byId(loaded.document, "structure-graph").hidden).toBe(false);
    expect(byId(loaded.document, "structure-shared").contains(byId(loaded.document, "structure-partial"))).toBe(true);
    expect(loaded.requests.filter((request) => request.path === "/api/structure")).toHaveLength(1);
    expect(byId(loaded.document, "lifecycle").textContent).toBe("Structure graph mode.");

    const restored = await boot({ storedStructureMode: "graph" });
    byId(restored.document, "view-structure").click();
    await flush();
    expect(byId(restored.document, "structure-mode-graph").getAttribute("aria-selected")).toBe("true");
    expect(byId(restored.document, "structure-graph").hidden).toBe(false);

    const invalid = await boot({ storedStructureMode: "invalid" });
    byId(invalid.document, "view-structure").click();
    await flush();
    expect(byId(invalid.document, "structure-mode-list").getAttribute("aria-selected")).toBe("true");

    const readFailure = await boot({ throwStructureModeRead: true });
    byId(readFailure.document, "view-structure").click();
    await flush();
    expect(byId(readFailure.document, "structure-mode-list").getAttribute("aria-selected")).toBe("true");

    const writeFailure = await boot();
    byId(writeFailure.document, "view-structure").click();
    await flush();
    const setItem = writeFailure.window.sessionStorage.setItem.bind(writeFailure.window.sessionStorage);
    writeFailure.window.sessionStorage.setItem = vi.fn(() => { throw new Error("storage blocked"); });
    expect(() => byId(writeFailure.document, "structure-mode-graph").click()).not.toThrow();
    expect(byId(writeFailure.document, "structure-graph").hidden).toBe(false);
    writeFailure.window.sessionStorage.setItem = setItem;
  });

  it.each([
    ["off", false, false],
    ["on", true, false],
    ["unavailable", false, true],
  ])("keeps the labelled neighbours checkbox visible for snapshot state %s", async (neighbourState, checked, disabled) => {
    const reason = "Comparison cannot read neighbouring files.";
    const snapshot = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      limits: { ...structure.limits, truncated: false, omitted: [] },
      neighbours: neighbourState === "unavailable"
        ? { state: neighbourState, count: 0, reason }
        : { state: neighbourState, count: neighbourState === "on" ? 2 : 0 },
    };
    const { document } = await boot({ structureResponses: [snapshot] });
    byId(document, "view-structure").click();
    await flush();
    const label = byId(document, "structure-neighbours-label");
    const checkbox = byId(document, "structure-neighbours");
    expect(label.hidden).toBe(false);
    expect(label.textContent).toContain("Include unchanged neighbours");
    expect(label.parentElement).toBe(byId(document, "structure-mode-switch").parentElement);
    expect(checkbox.checked).toBe(checked);
    expect(checkbox.disabled).toBe(disabled);
    if (neighbourState === "unavailable") expect(byId(document, "structure-partial").textContent).toContain(reason);
  });

  it("refetches and caches structure per neighbours flag while persisting the choice", async () => {
    const withNeighbours = { ...structure, neighbours: { state: "on", count: 1 } };
    const loaded = await boot({ structureResponses: [structure, withNeighbours] });
    byId(loaded.document, "view-structure").click();
    await flush();
    const checkbox = byId(loaded.document, "structure-neighbours");
    checkbox.click();
    await flush();
    expect(loaded.requests.filter((request) => request.path.startsWith("/api/structure"))).toHaveLength(2);
    expect(loaded.requests.at(-1)?.path).toBe("/api/structure?neighbours=1");
    expect(loaded.window.sessionStorage.getItem("reviewTutorStructureNeighbours")).toBe("1");
    expect(byId(loaded.document, "lifecycle").textContent).toBe("Structure analysis complete. Neighbours included.");

    checkbox.click();
    await flush();
    expect(loaded.requests.filter((request) => request.path.startsWith("/api/structure"))).toHaveLength(2);
    expect(loaded.window.sessionStorage.getItem("reviewTutorStructureNeighbours")).toBe("0");
    expect(byId(loaded.document, "lifecycle").textContent).toBe("Neighbours hidden.");

    const restored = await boot({ storedStructureNeighbours: "1", structureResponses: [withNeighbours] });
    byId(restored.document, "view-structure").click();
    await flush();
    expect(restored.requests.find((request) => request.path.startsWith("/api/structure"))?.path).toBe("/api/structure?neighbours=1");
    expect(byId(restored.document, "structure-neighbours").checked).toBe(true);
  });

  it("disables the neighbours checkbox in flight and restores body focus after loading", async () => {
    let resolveNeighbours!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveNeighbours = resolve; });
    const loaded = await boot({ structureResponses: [structure, pending] });
    byId(loaded.document, "view-structure").click();
    await flush();
    const checkbox = byId(loaded.document, "structure-neighbours");
    checkbox.click();
    expect(checkbox.disabled).toBe(true);
    byId(loaded.document, "structure-title").focus();
    byId(loaded.document, "structure-title").blur();
    expect(loaded.document.activeElement).toBe(loaded.document.body);
    resolveNeighbours(json({ ...structure, neighbours: { state: "on", count: 1 } }));
    await flush();
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(true);
    expect(loaded.document.activeElement).toBe(checkbox);
  });

  it("keeps the requested neighbours control recoverable and restores body focus after a toggle error", async () => {
    let rejectNeighbours!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, reject) => { rejectNeighbours = reject; });
    const loaded = await boot({ structureResponses: [structure, pending] });
    byId(loaded.document, "view-structure").click();
    await flush();
    const checkbox = byId(loaded.document, "structure-neighbours");
    checkbox.click();
    byId(loaded.document, "structure-title").focus();
    byId(loaded.document, "structure-title").blur();
    expect(loaded.document.activeElement).toBe(loaded.document.body);
    rejectNeighbours(new Error("neighbour read failed"));
    await flush();
    expect(byId(loaded.document, "structure-error").textContent).toContain("neighbour read failed");
    expect(byId(loaded.document, "structure-mode-switch").hidden).toBe(true);
    expect(byId(loaded.document, "structure-neighbours-label").hidden).toBe(false);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(loaded.document.activeElement).toBe(checkbox);
    checkbox.click();
    await flush();
    expect(byId(loaded.document, "structure-comparison").textContent).toBe("index → working tree");
  });

  it("drops a pending toggle announcement when the source switches", async () => {
    let resolveNeighbours!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveNeighbours = resolve; });
    const next = { ...structure, inputId: "input-2", comparison: { ...structure.comparison, from: "main", to: "feature" } };
    const loaded = await boot({ structureResponses: [structure, pending, next] });
    byId(loaded.document, "view-structure").click();
    await flush();
    byId(loaded.document, "structure-neighbours").click();
    loaded.events?.emit("source", { ...source, id: "input-2" });
    await flush();
    resolveNeighbours(json({ ...structure, neighbours: { state: "on", count: 1 } }));
    await flush();
    byId(loaded.document, "view-structure").click();
    await flush();
    expect(byId(loaded.document, "structure-comparison").textContent).toBe("main → feature");
    expect(byId(loaded.document, "lifecycle").textContent).not.toContain("Neighbours");
  });

  it("appends the hidden announcement after an uncached toggle", async () => {
    const on = { ...structure, neighbours: { state: "on", count: 1 } };
    const loaded = await boot({ storedStructureNeighbours: "1", structureResponses: [on, structure] });
    byId(loaded.document, "view-structure").click();
    await flush();
    byId(loaded.document, "structure-neighbours").click();
    await flush();
    expect(loaded.requests.at(-1)?.path).toBe("/api/structure");
    expect(byId(loaded.document, "lifecycle").textContent).toBe("Structure analysis complete. Neighbours hidden.");
  });

  it("tolerates blocked neighbours storage reads and writes without blocking refetch", async () => {
    const readFailure = await boot({ throwStructureNeighboursRead: true });
    byId(readFailure.document, "view-structure").click();
    await flush();
    expect(byId(readFailure.document, "structure-neighbours").checked).toBe(false);

    const writeFailure = await boot({ structureResponses: [structure, { ...structure, neighbours: { state: "on", count: 1 } }] });
    byId(writeFailure.document, "view-structure").click();
    await flush();
    writeFailure.window.sessionStorage.setItem = vi.fn(() => { throw new Error("storage blocked"); });
    expect(() => byId(writeFailure.document, "structure-neighbours").click()).not.toThrow();
    await flush();
    expect(writeFailure.requests.at(-1)?.path).toBe("/api/structure?neighbours=1");
    expect(byId(writeFailure.document, "structure-neighbours").checked).toBe(true);
  });

  it("renders context targets inline, omits empty context groups, and keeps outgoing context groups", async () => {
    const contextSnapshot = {
      ...structure,
      files: [
        { path: "src/a.ts", status: "modified", analyzed: true },
        { path: "lib/target.dart", status: "context", analyzed: true },
        { path: "lib/outgoing.dart", status: "context", analyzed: true },
      ],
      edges: [
        { from: "src/a.ts", to: "lib/target.dart", kind: "part", typeOnly: false, status: "unchanged", evidence: [] },
        { from: "lib/outgoing.dart", to: "src/a.ts", kind: "part-of", typeOnly: false, status: "unchanged", evidence: [] },
      ],
    };
    const { document } = await boot({ structureResponses: [contextSnapshot] });
    byId(document, "view-structure").click();
    await flush();
    const groups = Array.from(document.querySelectorAll(".structure-file") as any) as any[];
    expect(groups.some((group) => group.querySelector(".structure-file-path")?.textContent === "lib/target.dart")).toBe(false);
    const outgoing = groups.find((group) => group.querySelector(".structure-file-path")?.textContent === "lib/outgoing.dart") as any;
    expect(outgoing.querySelector(".structure-file-status")?.textContent).toBe("context");
    expect(outgoing.querySelector(".structure-file-status")?.classList.contains("status-context")).toBe(true);
    const targetRow = groups.find((group) => group.querySelector(".structure-file-path")?.textContent === "src/a.ts")?.querySelector(".connection-row") as any;
    expect(targetRow.querySelector(".connection-target")?.textContent).toBe("lib/target.dart");
    expect(targetRow.querySelector(".connection-context")?.textContent).toBe("CONTEXT");
    expect(targetRow.querySelector(".connection-target")?.nextElementSibling).toBe(targetRow.querySelector(".connection-context"));
    byId(document, "structure-mode-graph").click();
    const node = document.querySelector('.structure-graph-node[data-path="lib/outgoing.dart"]') as any;
    expect(node.getAttribute("aria-label")).toBe("lib/outgoing.dart, context");
    expect(node.classList.contains("status-context")).toBe(true);
  });

  it("labels Dart and Rust connection kinds through the existing kind chip", async () => {
    const kinds = ["part", "part-of", "mod", "use", "include"];
    const kindSnapshot = {
      ...structure,
      files: [{ path: "src/a.ts", status: "modified", analyzed: true }],
      edges: kinds.map((kind, index) => ({ from: "src/a.ts", to: `target-${index}`, kind, typeOnly: false, status: "unchanged", evidence: [] })),
    };
    const { document } = await boot({ structureResponses: [kindSnapshot] });
    byId(document, "view-structure").click();
    await flush();
    expect(Array.from(document.querySelectorAll(".connection-kind")).map((chip: any) => chip.textContent)).toEqual([
      "part", "part of", "mod", "use", "include",
    ]);
    expect(pageHtml).toMatch(/\.status-chip,\.connection-kind,\.connection-type,\.connection-context \{\n[^}]*text-transform:uppercase/);
  });

  it("lays out DAGs and cycles deterministically with directory ordering", async () => {
    const dag = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: [
        { path: "z/a.ts", status: "added", analyzed: true },
        { path: "a/z.ts", status: "modified", analyzed: true },
        { path: "mid/b.ts", status: "modified", analyzed: true },
        { path: "end/d.ts", status: "unchanged", analyzed: true },
      ],
      edges: [
        { from: "z/a.ts", to: "mid/b.ts", kind: "import", typeOnly: false, status: "added", evidence: [] },
        { from: "a/z.ts", to: "mid/b.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: "mid/b.ts", to: "end/d.ts", kind: "import", typeOnly: false, status: "unchanged", evidence: [] },
      ],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const first = await boot({ structureResponses: [dag] });
    byId(first.document, "view-structure").click();
    await flush();
    byId(first.document, "structure-mode-graph").click();
    const firstSvg = first.document.querySelector(".structure-graph-svg") as any;
    const firstPaths = Array.from(firstSvg.querySelectorAll(".structure-graph-edge .structure-graph-line")).map((path: any) => path.getAttribute("d"));
    expect(firstSvg.dataset.layout).toBeTruthy();
    expect(firstPaths.every((path) => path?.startsWith("M") && path.includes("L") && !path.includes("Q"))).toBe(true);
    expect(Array.from(first.document.querySelectorAll(".structure-graph-node")).map((node: any) => [node.dataset.path, node.dataset.layer])).toEqual([
      ["a/z.ts", "0"],
      ["z/a.ts", "0"],
      ["mid/b.ts", "1"],
      ["end/d.ts", "2"],
    ]);

    const second = await boot({ structureResponses: [dag] });
    byId(second.document, "view-structure").click();
    await flush();
    byId(second.document, "structure-mode-graph").click();
    const secondSvg = second.document.querySelector(".structure-graph-svg") as any;
    expect(secondSvg.dataset.layout).toBe(firstSvg.dataset.layout);
    expect(Array.from(secondSvg.querySelectorAll(".structure-graph-edge .structure-graph-line")).map((path: any) => path.getAttribute("d"))).toEqual(firstPaths);

    const cycle = {
      ...dag,
      files: ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, status: "modified", analyzed: true })),
      edges: [
        { from: "a.ts", to: "b.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: "b.ts", to: "c.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: "c.ts", to: "a.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
      ],
    };
    const cycled = await boot({ structureResponses: [cycle] });
    byId(cycled.document, "view-structure").click();
    await flush();
    byId(cycled.document, "structure-mode-graph").click();
    expect(Array.from(cycled.document.querySelectorAll(".structure-graph-node")).map((node: any) => [node.dataset.path, node.dataset.layer])).toEqual([
      ["a.ts", "0"],
      ["b.ts", "1"],
      ["c.ts", "2"],
    ]);
  });

  it("routes long edges below every intermediate layer without crossing node boxes", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const longEdgeGraph = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: paths.map((path) => ({ path, status: "modified", analyzed: true })),
      edges: [
        { from: paths[0], to: paths[1], kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: paths[1], to: paths[2], kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: paths[0], to: paths[2], kind: "import", typeOnly: false, status: "added", evidence: [] },
      ],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const { document } = await boot({ structureResponses: [longEdgeGraph] });
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();

    const middleRect = document.querySelector('.structure-graph-node[data-path="src/b.ts"] rect') as any;
    const longPath = document.querySelector('.structure-graph-edge[data-from="src/a.ts"][data-to="src/c.ts"] path') as any;
    expect(longPath).toBeTruthy();
    expect(Math.max(...graphPathPoints(longPath).map((point) => point.y))).toBeGreaterThan(Number(middleRect.getAttribute("y")) + Number(middleRect.getAttribute("height")));
    expectGraphPathsClearNodes(document);
  });

  it("routes back edges through layer gutters without crossing crowded endpoint layers", async () => {
    const layer0 = ["a/0.ts", "a/1.ts", "a/2.ts"];
    const layer1 = ["b/0.ts", "b/1.ts", "b/2.ts"];
    const layer2 = ["c/0.ts", "c/1.ts", "c/2.ts"];
    const paths = [...layer0, ...layer1, ...layer2];
    const cycle = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: paths.map((path) => ({ path, status: "modified", analyzed: true })),
      edges: [
        ...layer0.map((from, index) => ({ from, to: layer1[index], kind: "import", typeOnly: false, status: "modified", evidence: [] })),
        ...layer1.map((from, index) => ({ from, to: layer2[index], kind: "import", typeOnly: false, status: "modified", evidence: [] })),
        { from: layer2[1], to: layer0[1], kind: "import", typeOnly: false, status: "removed", evidence: [] },
      ],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const { document } = await boot({ structureResponses: [cycle] });
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();

    const svg = document.querySelector(".structure-graph-svg") as any;
    const backPath = document.querySelector('.structure-graph-edge[data-from="c/1.ts"][data-to="a/1.ts"] .structure-graph-line') as any;
    const points = graphPathPoints(backPath);
    const sourceRect = document.querySelector('.structure-graph-node[data-path="c/1.ts"] rect') as any;
    const targetRect = document.querySelector('.structure-graph-node[data-path="a/1.ts"] rect') as any;
    expect(points[0]!.x).toBeCloseTo(Number(sourceRect.getAttribute("x")) + Number(sourceRect.getAttribute("width")));
    expect(points.at(-1)?.x).toBeCloseTo(Number(targetRect.getAttribute("x")) + Number(targetRect.getAttribute("width")));
    expect(Number(svg.getAttribute("viewBox").split(" ")[2])).toBeGreaterThan(Math.max(...points.map((point) => point.x)));
    expectGraphPathsClearNodes(document);
  });

  it("routes back edges below the drawing and extends the SVG viewBox", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const cycle = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: paths.map((path) => ({ path, status: "modified", analyzed: true })),
      edges: [
        { from: paths[0], to: paths[1], kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: paths[1], to: paths[2], kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: paths[2], to: paths[0], kind: "import", typeOnly: false, status: "removed", evidence: [] },
      ],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const { document } = await boot({ structureResponses: [cycle] });
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();

    const svg = document.querySelector(".structure-graph-svg") as any;
    const backPath = document.querySelector('.structure-graph-edge[data-from="src/c.ts"][data-to="src/a.ts"] .structure-graph-line') as any;
    const drawingBottom = Math.max(...graphNodeRects(document).map((rect) => rect.y + rect.height));
    const laneBottom = Math.max(...graphPathPoints(backPath).map((point) => point.y));
    expect(laneBottom).toBeGreaterThan(drawingBottom);
    expect(Number(svg.getAttribute("viewBox").split(" ")[3])).toBeGreaterThan(laneBottom);
    expectGraphPathsClearNodes(document);
  });

  it("offsets parallel and shared back-edge ports deterministically", async () => {
    const parallel = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: ["a.ts", "b.ts"].map((path) => ({ path, status: "modified", analyzed: true })),
      edges: ["dynamic-import", "import", "require"].map((kind) => ({ from: "a.ts", to: "b.ts", kind, typeOnly: false, status: "modified", evidence: [] })),
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const parallelPage = await boot({ structureResponses: [parallel] });
    byId(parallelPage.document, "view-structure").click();
    await flush();
    byId(parallelPage.document, "structure-mode-graph").click();
    const parallelPaths = Array.from(parallelPage.document.querySelectorAll(".structure-graph-line"), (path: any) => path.getAttribute("d"));
    expect(new Set(parallelPaths).size).toBe(3);

    const sharedBack = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, status: "modified", analyzed: true })),
      edges: [
        { from: "a.ts", to: "b.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: "b.ts", to: "c.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] },
        { from: "c.ts", to: "a.ts", kind: "import", typeOnly: false, status: "removed", evidence: [] },
        { from: "c.ts", to: "a.ts", kind: "require", typeOnly: false, status: "removed", evidence: [] },
      ],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const backPage = await boot({ structureResponses: [sharedBack] });
    byId(backPage.document, "view-structure").click();
    await flush();
    byId(backPage.document, "structure-mode-graph").click();
    const stems = Array.from(backPage.document.querySelectorAll('.structure-graph-edge[data-from="c.ts"][data-to="a.ts"] .structure-graph-line'), (path: any) => graphPathPoints(path)[0]!.y);
    expect(new Set(stems).size).toBe(2);
  });

  it("enforces inclusive graph size bounds and the zero-drawable copy", async () => {
    const inclusivePaths = Array.from({ length: 60 }, (_, index) => `src/i${String(index).padStart(2, "0")}.ts`);
    const inclusive = {
      ...structure,
      files: inclusivePaths.map((path) => ({ path, status: "modified", analyzed: true })),
      edges: Array.from({ length: 200 }, (_, index) => ({ from: inclusivePaths[index % 59], to: inclusivePaths[(index % 59) + 1], kind: "import", typeOnly: false, status: "modified", evidence: [] })),
    };
    const inclusivePage = await boot({ structureResponses: [inclusive] });
    byId(inclusivePage.document, "view-structure").click();
    await flush();
    byId(inclusivePage.document, "structure-mode-graph").click();
    expect(inclusivePage.document.querySelector(".structure-graph-svg")).not.toBeNull();

    const nodePaths = Array.from({ length: 61 }, (_, index) => `src/n${String(index).padStart(2, "0")}.ts`);
    const tooManyNodes = {
      ...structure,
      files: nodePaths.map((path) => ({ path, status: "modified", analyzed: true })),
      edges: nodePaths.slice(1).map((path, index) => ({ from: nodePaths[index], to: path, kind: "import", typeOnly: false, status: "modified", evidence: [] })),
    };
    const nodePage = await boot({ structureResponses: [tooManyNodes] });
    byId(nodePage.document, "view-structure").click();
    await flush();
    byId(nodePage.document, "structure-mode-graph").click();
    expect(byId(nodePage.document, "structure-graph").textContent).toBe("Graph is too large for this view (61 files, 60 connections). Use the list.");
    expect(nodePage.document.querySelector(".structure-graph-svg")).toBeNull();

    const tooManyEdges = {
      ...structure,
      files: [
        { path: "a.ts", status: "modified", analyzed: true },
        { path: "b.ts", status: "modified", analyzed: true },
      ],
      edges: Array.from({ length: 201 }, () => ({ from: "a.ts", to: "b.ts", kind: "import", typeOnly: false, status: "modified", evidence: [] })),
    };
    const edgePage = await boot({ structureResponses: [tooManyEdges] });
    byId(edgePage.document, "view-structure").click();
    await flush();
    byId(edgePage.document, "structure-mode-graph").click();
    expect(byId(edgePage.document, "structure-graph").textContent).toBe("Graph is too large for this view (2 files, 201 connections). Use the list.");

    const zero = await boot({ structureResponses: [{ ...structure, files: structure.files.map((file) => ({ ...file, analyzed: false })), edges: [] }] });
    byId(zero.document, "view-structure").click();
    await flush();
    byId(zero.document, "structure-mode-graph").click();
    expect(byId(zero.document, "structure-graph").textContent).toBe("No connections to draw.");
  });

  it("keeps graph selection exclusive, keyboard ordered, labelled, and Escape-restorable", async () => {
    const { window, document } = await boot();
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();
    const svg = document.querySelector(".structure-graph-svg") as any;
    expect(svg.getAttribute("role")).toBe("group");
    expect(svg.getAttribute("aria-label")).toBe("Structure graph, 4 files, 4 connections");
    expect(Array.from(svg.querySelectorAll("defs marker")).map((marker: any) => marker.id)).toEqual([
      "structure-arrow-added",
      "structure-arrow-removed",
      "structure-arrow-modified",
      "structure-arrow-unchanged",
      "structure-arrow-selected",
    ]);
    const controls = Array.from(svg.querySelectorAll('g[role="button"]')) as any[];
    const nodes = controls.filter((control) => control.classList.contains("structure-graph-node"));
    const edges = controls.filter((control) => control.classList.contains("structure-graph-edge"));
    expect(controls.slice(0, nodes.length)).toEqual(nodes);
    expect(edges.map((edge) => edge.getAttribute("aria-label"))).toEqual([
      "src/a.ts → src/new.ts, re-export, edited",
      "src/b.ts → src/a.ts, import, added",
      "src/new.ts → src/a.ts, dynamic, unchanged",
      "src/old.ts → src/a.ts, require, removed",
    ]);
    expect(nodes.map((node) => node.getAttribute("aria-label"))).toContain("src/a.ts, edited");
    expect(nodes.every((node) => node.tabIndex === 0 && node.getAttribute("aria-label"))).toBe(true);
    expect(svg.querySelector('.structure-graph-node[data-path="src/a.ts"] title')).toBeNull();
    expect(edges.every((edge) => edge.tabIndex === 0)).toBe(true);
    for (const edge of edges) {
      const hit = edge.querySelector(".structure-graph-hit"), line = edge.querySelector(".structure-graph-line");
      expect(hit).toBe(edge.firstElementChild);
      expect(hit.getAttribute("d")).toBe(line.getAttribute("d"));
      expect(hit.getAttribute("style")).toBe("fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke");
    }
    expect(pageHtml).toContain(".structure-graph-edge.type-only {\nopacity:.7}");
    expect(pageHtml).not.toContain("graph-focus-visible");
    expect(pageHtml).not.toContain("graph-endpoint");
    expect(pageHtml).not.toContain(".structure-mode-switch .view-tab");

    const editedNode = svg.querySelector('.structure-graph-node[data-path="src/a.ts"]') as any;
    editedNode.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(svg.querySelectorAll(".graph-selected")).toHaveLength(1);
    expect(byId(document, "lifecycle").textContent).toBe("src/a.ts, edited selected.");
    expect(Array.from(byId(document, "structure-graph-evidence").querySelectorAll(".connection-target"), (target: any) => target.textContent)).toEqual(["src/new.ts"]);
    editedNode.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(byId(document, "lifecycle").textContent).toBe("src/a.ts, edited selected.");
    edges[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(svg.querySelectorAll(".graph-selected")).toHaveLength(1);
    expect(edges[0].classList.contains("graph-selected")).toBe(true);
    expect(edges[0].querySelector(".structure-graph-line")?.getAttribute("marker-end")).toBe("url(#structure-arrow-selected)");
    expect(svg.querySelectorAll(".graph-endpoint,.graph-focus-visible")).toHaveLength(0);
    edges[0].focus();
    edges[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(svg.querySelectorAll(".graph-selected,.graph-endpoint")).toHaveLength(0);
    expect(edges[0].querySelector(".structure-graph-line")?.getAttribute("marker-end")).toBe("url(#structure-arrow-modified)");
    expect(byId(document, "lifecycle").textContent).toBe("Selection cleared.");
    expect(document.activeElement).toBe(byId(document, "structure-mode-graph"));
  });

  it("adds node titles only for ellipsised labels", async () => {
    const longPath = "src/" + "deep/".repeat(8) + "file.ts";
    const snapshot = {
      ...structure,
      files: [
        { path: "short.ts", status: "modified", analyzed: true },
        { path: longPath, status: "added", analyzed: true },
      ],
      edges: [{ from: "short.ts", to: longPath, kind: "import", typeOnly: false, status: "added", evidence: [] }],
    };
    const { document } = await boot({ structureResponses: [snapshot] });
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();
    expect(document.querySelector('.structure-graph-node[data-path="short.ts"] title')).toBeNull();
    expect(document.querySelector('.structure-graph-node[data-path="' + longPath + '"] title')?.textContent).toBe(longPath);
  });

  it("reuses graph evidence rendering and lands Open in Diff on the list's exact row", async () => {
    const graphPage = await boot();
    byId(graphPage.document, "view-structure").click();
    await flush();
    byId(graphPage.document, "structure-mode-graph").click();
    const graphEdge = Array.from(graphPage.document.querySelectorAll(".structure-graph-edge") as any).find((edge: any) => edge.dataset.from === "src/b.ts" && edge.dataset.to === "src/a.ts") as any;
    graphEdge.dispatchEvent(new graphPage.window.MouseEvent("click", { bubbles: true }));
    const graphPanel = byId(graphPage.document, "structure-graph-evidence");
    expect(graphPanel.previousElementSibling).toBe(byId(graphPage.document, "structure-graph"));
    expect(graphPanel.parentElement).toBe(byId(graphPage.document, "structure-section"));
    expect(graphPanel.querySelector(".connection-row")?.getAttribute("aria-expanded")).toBe("true");
    expect(graphPanel.querySelector(".evidence-code")?.textContent).toContain("import type");
    expect(graphPanel.querySelector(".ask-tutor-evidence")?.textContent).toBe("Ask the tutor");
    (graphPanel.querySelector(".open-in-diff") as any).click();
    const graphLanding = graphPage.document.querySelector(".diff-row.structure-landing") as any;

    const listPage = await boot();
    byId(listPage.document, "view-structure").click();
    await flush();
    const listRow = Array.from(listPage.document.querySelectorAll(".connection-row") as any).find((row: any) => row.textContent.includes("src/a.ts") && row.textContent.includes("import")) as any;
    listRow.click();
    (listRow.nextElementSibling.querySelector(".open-in-diff") as any).click();
    const listLanding = listPage.document.querySelector(".diff-row.structure-landing") as any;

    expect([graphLanding.dataset.file, graphLanding.dataset.row]).toEqual([listLanding.dataset.file, listLanding.dataset.row]);
    expect(graphPage.document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(1);
    byId(graphPage.document, "view-structure").click();
    byId(graphPage.document, "structure-mode-list").click();
    expect(graphPage.document.querySelector("#structure-graph-evidence")).toBeNull();
  });

  it("fetches structure once per input and refetches the new payload after a source switch", async () => {
    const nextSource = { ...source, id: "input-2", digest: "digest-2", label: "Next tree" };
    const nextStructure = {
      ...structure,
      inputId: nextSource.id,
      comparison: { ...structure.comparison, label: "Next tree", from: "main", to: "feature" },
    };
    const { document, requests, events } = await boot({ structureResponses: [structure, nextStructure] });

    byId(document, "view-structure").click();
    await flush();
    byId(document, "view-diff").click();
    byId(document, "view-structure").click();
    await flush();
    expect(requests.filter((request) => request.path === "/api/structure")).toHaveLength(1);
    expect(requests.find((request) => request.path === "/api/structure")?.init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });

    events?.emit("source", nextSource);
    byId(document, "view-structure").click();
    await flush();
    expect(requests.filter((request) => request.path === "/api/structure")).toHaveLength(2);
    expect(byId(document, "structure-comparison").textContent).toBe("main → feature");
  });

  it("shows a retryable error when a structure snapshot does not match the current input", async () => {
    const { document } = await boot({
      structureResponses: [{ ...structure, inputId: "other-input", comparison: { ...structure.comparison, from: "wrong", to: "snapshot" } }],
    });
    byId(document, "view-structure").click();
    await flush();
    expect(document.querySelector("#structure-comparison")).toBeNull();
    expect(byId(document, "structure-error").textContent).toBe("Structure analysis did not match the current source.");
    expect(byId(document, "structure-retry").textContent).toBe("Retry");
    expect(byId(document, "lifecycle").textContent).toBe("Structure analysis did not match the current source.");
  });

  it("ignores a fetched structure snapshot when an SSE source switch wins the race", async () => {
    let resolveOld!: (response: Response) => void;
    const oldPending = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const nextSource = { ...source, id: "input-2", digest: "digest-2", label: "Next tree" };
    const nextStructure = {
      ...structure,
      inputId: nextSource.id,
      comparison: { ...structure.comparison, from: "base", to: "next" },
    };
    const { document, events } = await boot({ structureResponses: [oldPending, nextStructure] });

    byId(document, "view-structure").click();
    resolveOld(json({ ...structure, inputId: "other-input", comparison: { ...structure.comparison, from: "wrong", to: "snapshot" } }));
    events?.emit("source", nextSource);
    await flush();
    expect(document.querySelector("#structure-comparison")).toBeNull();

    byId(document, "view-structure").click();
    await flush();
    expect(byId(document, "structure-comparison").textContent).toBe("base → next");
  });

  it("renders block empty states, announces view then loading, and focuses the title after Retry", async () => {
    let resolveStructure!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveStructure = resolve; });
    const typedError = new Response(JSON.stringify({ error: "structure unavailable" }), { status: 503, statusText: "Unavailable", headers: { "content-type": "application/json" } });
    const { document } = await boot({ structureResponses: [pending, structure] });
    const announcements: string[] = [];
    const observer = new document.defaultView!.MutationObserver((records) => {
      for (const record of records)
        announcements.push(Array.from(record.addedNodes).map((node: any) => node.textContent).join(""));
    });
    observer.observe(byId(document, "lifecycle"), { childList: true });

    byId(document, "view-structure").click();
    await Promise.resolve();
    expect(byId(document, "lifecycle").textContent).toBe("Analyzing structure…");
    expect(announcements.filter(Boolean)).toEqual(["Structure view.", "Analyzing structure…"]);
    expect(byId(document, "structure-content").firstElementChild?.tagName).toBe("P");
    resolveStructure(typedError);
    await flush();
    expect(byId(document, "structure-error").textContent).toBe("structure unavailable");
    expect(byId(document, "lifecycle").textContent).toBe("Structure analysis failed: structure unavailable");
    byId(document, "structure-retry").click();
    expect(document.activeElement).toBe(byId(document, "structure-title"));
    await flush();
    expect(byId(document, "structure-comparison").textContent).toBe("index → working tree");
    expect(document.activeElement).toBe(byId(document, "structure-title"));
    observer.disconnect();
  });

  it("clears stale connection state across an error, Retry, and loaded re-render", async () => {
    const nextSource = { ...source, id: "input-2", digest: "digest-2", label: "Next tree" };
    const nextStructure = { ...structure, inputId: nextSource.id };
    const typedError = new Response(JSON.stringify({ error: "structure unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    const { document, events } = await boot({ structureResponses: [structure, typedError, nextStructure] });

    byId(document, "view-structure").click();
    await flush();
    (document.querySelector(".connection-row") as any).click();
    events?.emit("source", nextSource);
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-retry").click();
    await flush();
    const rows = Array.from(document.querySelectorAll(".connection-row")) as any[];
    rows[1].click();
    expect(rows[1].getAttribute("aria-expanded")).toBe("true");
    expect(pageHtml).toContain("function renderStructure() {\n    selectedConnection = null;");
    expect(pageHtml).not.toContain("function structureText(");
    expect(pageHtml).not.toContain("message.textContent = structureSnapshot");
  });

  it("renders the locked structure hierarchy, statuses, partial disclosure, and empty copy", async () => {
    const { document } = await boot();
    byId(document, "view-structure").click();
    await flush();

    expect(byId(document, "structure-partial").textContent).toContain("Structure analysis is partial; some connections may be missing.");
    expect(byId(document, "structure-partial").querySelector("summary")?.textContent).toBe("2 reasons");
    expect(byId(document, "structure-partial").textContent).toContain("src/skipped.ts: Edge limit reached.");
    const groups = Array.from(document.querySelectorAll(".structure-file")) as any[];
    expect(groups).toHaveLength(5);
    expect(groups.every((group) => group.tagName === "SECTION" && group.getAttribute("aria-labelledby"))).toBe(true);
    expect(groups.map((group) => group.querySelector(".structure-file-status")?.textContent)).toEqual(["added", "modified", "removed", "renamed", "modified"]);
    expect(groups[3].textContent).toContain("renamed from src/legacy.ts");
    expect(groups[4].textContent).toContain("File exceeded the statement limit.");
    expect(groups[2].querySelector('.connection-row[data-status="removed"]')).not.toBeNull();
    expect(document.querySelector(".connection-type")?.textContent).toBe("type");
    expect(document.querySelector('.connection-row[data-status="modified"] .connection-status')?.textContent).toBe("edited");
    expect(groups.every((group) => !group.querySelector(".file-counts"))).toBe(true);
    expect(groups.every((group) => group.querySelector(".structure-file-path")?.getAttribute("title") === group.querySelector(".structure-file-path")?.textContent)).toBe(true);
    expect(pageHtml).toMatch(/\.structure-file-head \{\nposition:static/);

    const emptySnapshot = {
      ...structure,
      comparison: { ...structure.comparison, partial: false, reasons: [] },
      files: [
        { ...structure.files[3] },
        { ...structure.files[4] },
      ],
      edges: [],
      limits: { ...structure.limits, truncated: false, omitted: [] },
    };
    const emptyPage = await boot({ structureResponses: [emptySnapshot] });
    byId(emptyPage.document, "view-structure").click();
    await flush();
    expect(byId(emptyPage.document, "structure-content").textContent).toContain("No connections among changed files. Unchanged neighbours are outside this view.");
    const emptyGroups = emptyPage.document.querySelectorAll(".structure-file");
    expect(emptyGroups).toHaveLength(1);
    expect(emptyGroups.item(0)?.textContent).not.toContain("renamed from");
    expect(emptyGroups.item(0)?.textContent).toContain("File exceeded the statement limit.");
  });

  it("renders only a header and reason for an unanalyzed file without connections", async () => {
    const binarySnapshot = {
      ...structure,
      files: [{ path: "assets/logo.bin", status: "added", additions: 0, deletions: 0, analyzed: false, reason: "binary content: no import data" }],
      edges: [],
    };
    const { document } = await boot({ width: 390, structureResponses: [binarySnapshot] });
    byId(document, "view-structure").click();
    await flush();

    const group = document.querySelector(".structure-file") as unknown as HTMLElement;
    expect(Array.from(group.children).map((child) => child.className)).toEqual([
      "structure-file-head file-head",
      "structure-file-note",
    ]);
    expect(group.children.item(1)?.textContent).toBe("binary content: no import data");
  });

  it("supports Enter activation, same-row collapse, single selection, and evidence jumps", async () => {
    const { window, document } = await boot();
    byId(document, "view-structure").click();
    await flush();
    const rows = Array.from(document.querySelectorAll(".connection-row")) as any[];
    expect(rows[0].tagName).toBe("BUTTON");
    pressEnter(window, rows[0]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    expect(rows[0].classList.contains("selected")).toBe(true);
    expect(byId(document, rows[0].getAttribute("aria-controls")).tagName).toBe("UL");
    rows[0].click();
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    rows[0].click();
    rows[1].click();
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(rows[0].classList.contains("selected")).toBe(false);
    expect(rows[1].getAttribute("aria-expanded")).toBe("true");
    rows[0].click();
    const open = byId(document, rows[0].getAttribute("aria-controls")).querySelector(".open-in-diff") as any;
    open.click();
    expect(byId(document, "diff").hidden).toBe(false);
    expect(byId(document, "structure-section").hidden).toBe(true);
    expect(document.activeElement).toBe(lineControl(selectableRows(document).find((row) => row.dataset.file === "1" && row.dataset.row === "1")));
    expect(document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(1);
    lineControl(selectableRows(document)[0]).dispatchEvent(new document.defaultView!.Event("pointerdown", { bubbles: true }));
    expect(document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(0);
  });

  it("asks from graph evidence through the existing list selection path", async () => {
    const { document } = await boot();
    byId(document, "view-structure").click();
    await flush();
    expect(byId(document, "structure-neighbours-label").textContent).toContain("Include unchanged neighbours");
    byId(document, "structure-mode-graph").click();
    const edge = Array.from(document.querySelectorAll(".structure-graph-edge") as any).find((item: any) => item.dataset.from === "src/b.ts" && item.dataset.to === "src/a.ts") as any;
    edge.dispatchEvent(new document.defaultView!.MouseEvent("click", { bubbles: true }));
    input(document, "question", "replace this draft");
    input(document, "mode", "quiz");
    const panel = byId(document, "structure-graph-evidence");
    const askTutor = panel.querySelector(".ask-tutor-evidence") as any;
    expect(askTutor.textContent).toBe("Ask the tutor");
    expect(askTutor.nextElementSibling?.textContent).toBe("Open in Diff");
    askTutor.click();

    expect(byId(document, "diff").hidden).toBe(false);
    expect(byId(document, "structure-section").hidden).toBe(true);
    expect(byId(document, "selection-summary").textContent).toBe("src/b.ts · lines 1-1");
    const selected = document.querySelector(".diff-row.selected") as any;
    expect(selected?.classList.contains("addition")).toBe(true);
    expect(selected?.textContent).toContain("import type");
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(byId(document, "question").value).toBe("");
    expect(byId(document, "mode").value).toBe("explain");
    expect(document.activeElement).toBe(byId(document, "question"));
  });

  it("opens the evidence tutor dialog and focuses its textarea at the stacked breakpoint", async () => {
    const { document } = await boot({ width: 860 });
    byId(document, "view-structure").click();
    await flush();
    byId(document, "structure-mode-graph").click();
    const edge = Array.from(document.querySelectorAll(".structure-graph-edge") as any).find((item: any) => item.dataset.from === "src/b.ts" && item.dataset.to === "src/a.ts") as any;
    edge.dispatchEvent(new document.defaultView!.MouseEvent("click", { bubbles: true }));
    (byId(document, "structure-graph-evidence").querySelector(".ask-tutor-evidence") as any).click();
    expect(byId(document, "tutor").getAttribute("role")).toBe("dialog");
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(byId(document, "question"));
  });

  it.each([1440, 860])("refuses evidence Ask without changing view or selection while this tab is running (%dpx)", async (width) => {
    const { document, window, events } = await boot({ width });
    byId(document, "view-structure").click();
    await flush();
    const row = document.querySelector(".connection-row") as any;
    row.click();
    const pageId = window.sessionStorage.getItem("reviewTutorPageId");
    events?.emit("state", { input: source, questions: [{ id: "q-own", ownerPageId: pageId, state: "running", answer: "Working" }] });
    const beforeSelection = byId(document, "selection-summary").textContent;
    (row.nextElementSibling.querySelector(".ask-tutor-evidence") as any).click();
    expect(byId(document, "structure-section").hidden).toBe(false);
    expect(byId(document, "diff").hidden).toBe(true);
    expect(byId(document, "selection-summary").textContent).toBe(beforeSelection);
    expect(document.querySelector(".diff-row.selected")).toBeNull();
    expect(byId(document, "tutor").classList.contains("open")).toBe(false);
    expect(byId(document, "error").textContent).toContain("cancel or wait for the current answer");
    expect(byId(document, "lifecycle").textContent).toContain("Cancel or wait for the current answer");
  });

  it("allows foreign-tab activity to open an empty evidence draft while Ask stays disabled", async () => {
    const { document, events } = await boot();
    byId(document, "view-structure").click();
    await flush();
    const row = document.querySelector(".connection-row") as any;
    row.click();
    events?.emit("state", { input: source, questions: [{ id: "q-foreign", ownerPageId: "another-page", state: "running", answer: "Working" }] });
    (row.nextElementSibling.querySelector(".ask-tutor-evidence") as any).click();
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(byId(document, "question").value).toBe("");
    expect(byId(document, "ask").disabled).toBe(true);
  });

  it("resolves exact added evidence before a deletion-prefix match", async () => {
    const modifiedSource = {
      ...source,
      content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-import value\n+import value from './new.js'",
    };
    const modifiedStructure = {
      ...structure,
      files: [{ path: "a.ts", status: "modified", analyzed: true }],
      edges: [{
        from: "a.ts", to: "b.ts", kind: "use", typeOnly: false, status: "modified", specifier: "b",
        evidence: [{ path: "a.ts", line: 1, text: "import value" }, { path: "a.ts", line: 1, text: "import value from './new.js'" }],
      }],
    };
    const { document } = await boot({ source: modifiedSource, structureResponses: [modifiedStructure] });
    byId(document, "view-structure").click();
    await flush();
    (document.querySelector(".connection-row") as any).click();
    (document.querySelector(".ask-tutor-evidence") as any).click();
    const selected = document.querySelector(".diff-row.selected") as any;
    expect(selected?.classList.contains("addition")).toBe(true);
    expect(selected?.textContent).toContain("import value from './new.js'");
    expect(byId(document, "selection-preview").textContent).toBe("import value from './new.js'");
  });

  it("uses Open in Diff's fallback when tutor evidence cannot be anchored", async () => {
    const unavailable = {
      ...structure,
      files: [{ path: "src/a.ts", status: "modified", analyzed: true }],
      edges: [{
        from: "src/a.ts", to: "line.ts", kind: "include", typeOnly: false, status: "added", specifier: "line",
        evidence: [{ path: "src/a.ts", line: 99, text: "missing();" }],
      }],
    };
    const { document } = await boot({ structureResponses: [unavailable] });
    byId(document, "view-structure").click();
    await flush();
    (document.querySelector(".connection-row") as any).click();
    (document.querySelector(".ask-tutor-evidence") as any).click();
    expect(byId(document, "diff").hidden).toBe(false);
    expect(byId(document, "lifecycle").textContent).toBe("Line 99 is not in the diff view.");
    expect(document.activeElement).toBe(document.querySelector("#file-0 .file-head"));
    expect(byId(document, "tutor").classList.contains("open")).toBe(false);
    expect(byId(document, "selection-summary").textContent).toBe("No code selected");
  });

  it("anchors modified evidence to its old and new sides, preferring additions for identical text", async () => {
    const modifiedSource = {
      ...source,
      content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old value\n+new value",
    };
    const modifiedStructure = {
      ...structure,
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, analyzed: true }],
      edges: [{
        from: "a.ts", to: "b.ts", kind: "import", typeOnly: false, status: "modified", specifier: "./b.js",
        evidence: [{ path: "a.ts", line: 1, text: "old value" }, { path: "a.ts", line: 1, text: "new value" }],
      }],
    };
    const oldPage = await boot({ source: modifiedSource, structureResponses: [modifiedStructure] });
    byId(oldPage.document, "view-structure").click();
    await flush();
    (oldPage.document.querySelector(".connection-row") as any).click();
    const opens = Array.from(oldPage.document.querySelectorAll(".open-in-diff")) as any[];
    opens[0].click();
    expect(oldPage.document.querySelector(".diff-row.structure-landing")?.classList.contains("deletion")).toBe(true);

    byId(oldPage.document, "view-structure").click();
    (oldPage.document.querySelector(".connection-row") as any).click();
    (Array.from(oldPage.document.querySelectorAll(".open-in-diff")) as any[])[1].click();
    expect(oldPage.document.querySelector(".diff-row.structure-landing")?.classList.contains("addition")).toBe(true);
    expect(oldPage.document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(1);

    const identicalSource = { ...modifiedSource, content: modifiedSource.content.replace("old value", "same").replace("new value", "same") };
    const identicalStructure = {
      ...modifiedStructure,
      edges: [{ ...modifiedStructure.edges[0], evidence: [{ path: "a.ts", line: 1, text: "same" }, { path: "a.ts", line: 1, text: "same" }] }],
    };
    const identicalPage = await boot({ source: identicalSource, structureResponses: [identicalStructure] });
    byId(identicalPage.document, "view-structure").click();
    await flush();
    (identicalPage.document.querySelector(".connection-row") as any).click();
    (identicalPage.document.querySelector(".open-in-diff") as any).click();
    expect(identicalPage.document.querySelector(".diff-row.structure-landing")?.classList.contains("addition")).toBe(true);
  });

  it("matches analyzer-truncated evidence as a prefix of the full diff line", async () => {
    const prefix = "x".repeat(200);
    const prefixSource = {
      ...source,
      content: `diff --git a/long.ts b/long.ts\n--- /dev/null\n+++ b/long.ts\n@@ -0,0 +1 @@\n+${prefix} full suffix`,
    };
    const prefixStructure = {
      ...structure,
      files: [{ path: "long.ts", status: "added", additions: 1, deletions: 0, analyzed: true }],
      edges: [{
        from: "long.ts", to: "target.ts", kind: "import", typeOnly: false, status: "added", specifier: "./target",
        evidence: [{ path: "long.ts", line: 1, text: prefix }],
      }],
    };
    const loaded = await boot({ source: prefixSource, structureResponses: [prefixStructure] });
    byId(loaded.document, "view-structure").click();
    await flush();
    (loaded.document.querySelector(".connection-row") as any).click();
    (loaded.document.querySelector(".open-in-diff") as any).click();
    expect(loaded.document.querySelector(".diff-row.structure-landing")?.textContent).toContain("full suffix");
  });

  it("falls back to a matching line when the preferred diff side is absent", async () => {
    const fallbackSource = {
      ...source,
      content: "diff --git a/added.ts b/added.ts\n--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1 @@\n+only present here",
    };
    const fallbackStructure = {
      ...structure,
      files: [{ path: "added.ts", status: "added", additions: 1, deletions: 0, analyzed: true }],
      edges: [{
        from: "added.ts", to: "target.ts", kind: "import", typeOnly: false, status: "removed", specifier: "./target",
        evidence: [{ path: "added.ts", line: 1, text: "only present here" }],
      }],
    };
    const loaded = await boot({ source: fallbackSource, structureResponses: [fallbackStructure] });
    byId(loaded.document, "view-structure").click();
    await flush();
    (loaded.document.querySelector(".connection-row") as any).click();
    (loaded.document.querySelector(".open-in-diff") as any).click();
    expect(loaded.document.querySelector(".diff-row.structure-landing")?.classList.contains("addition")).toBe(true);
  });

  it("matches indented and removed-file evidence after whitespace normalization", async () => {
    const evidenceSource = {
      ...source,
      content: [
        "diff --git a/indented.ts b/indented.ts", "--- a/indented.ts", "+++ b/indented.ts", "@@ -0,0 +1 @@", "+  call(  value );",
        "diff --git a/removed.ts b/removed.ts", "--- a/removed.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone();",
      ].join("\n"),
    };
    const evidenceStructure = {
      ...structure,
      files: [
        { path: "indented.ts", status: "added", additions: 1, deletions: 0, analyzed: true },
        { path: "removed.ts", status: "removed", additions: 0, deletions: 1, analyzed: true },
      ],
      edges: [
        { from: "indented.ts", to: "value.ts", kind: "import", typeOnly: false, status: "added", specifier: "./value", evidence: [{ path: "indented.ts", line: 1, text: "call( value );" }] },
        { from: "removed.ts", to: "gone.ts", kind: "import", typeOnly: false, status: "removed", specifier: "./gone", evidence: [{ path: "removed.ts", line: 1, text: "gone();" }] },
      ],
    };
    const loaded = await boot({ source: evidenceSource, structureResponses: [evidenceStructure] });
    byId(loaded.document, "view-structure").click();
    await flush();
    const rows = Array.from(loaded.document.querySelectorAll(".connection-row")) as any[];
    rows[0].click();
    (loaded.document.querySelector(".open-in-diff") as any).click();
    expect(loaded.document.querySelector(".diff-row.structure-landing")?.classList.contains("addition")).toBe(true);

    byId(loaded.document, "view-structure").click();
    rows[1].click();
    (rows[1].nextElementSibling.querySelector(".open-in-diff") as any).click();
    expect(loaded.document.querySelector(".diff-row.structure-landing")?.classList.contains("deletion")).toBe(true);
    expect(loaded.document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(1);
  });

  it("announces unavailable evidence and only leaves Structure when the file is rendered", async () => {
    const unavailable = {
      ...structure,
      files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, analyzed: true }],
      edges: [
        { from: "src/a.ts", to: "line.ts", kind: "import", typeOnly: false, status: "added", specifier: "./line", evidence: [{ path: "src/a.ts", line: 99, text: "missing();" }] },
        { from: "src/a.ts", to: "file.ts", kind: "import", typeOnly: false, status: "added", specifier: "./file", evidence: [{ path: "not-rendered.ts", line: 1, text: "missing();" }] },
      ],
    };
    const { document } = await boot({ structureResponses: [unavailable] });
    byId(document, "view-structure").click();
    await flush();
    const rows = Array.from(document.querySelectorAll(".connection-row")) as any[];
    rows[0].click();
    (rows[0].nextElementSibling.querySelector(".open-in-diff") as any).click();
    expect(byId(document, "diff").hidden).toBe(false);
    expect(byId(document, "lifecycle").textContent).toBe("Line 99 is not in the diff view.");
    expect(document.activeElement).toBe(document.querySelector("#file-0 .file-head"));
    expect(document.querySelectorAll(".diff-row.structure-landing")).toHaveLength(0);

    byId(document, "view-structure").click();
    rows[1].click();
    (rows[1].nextElementSibling.querySelector(".open-in-diff") as any).click();
    expect(byId(document, "structure-section").hidden).toBe(false);
    expect(byId(document, "lifecycle").textContent).toBe("not-rendered.ts is not in the diff view.");
  });

  it("uses touch targets and compact chips without making structure heads sticky", async () => {
    expect(pageHtml).toContain("button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible");
    expect(pageHtml).toMatch(/\.status-chip,\.connection-kind,\.connection-type,\.connection-context \{\n[^}]*font:600 10px/);
    expect(pageHtml).toMatch(/@media\(max-width:860px\)[\s\S]*\.structure-error-card button,\.structure-partial summary,\.open-in-diff,\.ask-tutor-evidence \{\nmin-height:var\(--control-h-touch\)/);
    expect(pageHtml).toMatch(/@media\(max-width:520px\)[\s\S]*\.structure-file-path \{\n[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
    expect(pageHtml).toContain('grid-template-areas:"kind type status ." "target target target target"');
    expect(pageHtml).toContain(".structure-head:has(> :not([hidden]))");
    expect(pageHtml).not.toMatch(/\n\.ask-tutor-evidence \{/);
    expect(pageHtml).not.toContain('file.status === "context"');

    const mobileStyles = pageHtml.slice(pageHtml.indexOf("@media(max-width:860px)"));
    expect(mobileStyles).toMatch(/\.structure-partial summary \{\npadding:8px 4px\}/);
    expect(mobileStyles).not.toMatch(/\.structure-partial summary \{\n[^}]*display:flex/);
    expect(pageHtml).toMatch(/\.empty \{\ndisplay:block[^}]*\}/);
    expect(pageHtml).not.toMatch(/\.empty \{\n[^}]*text-align:center/);
    expect(pageHtml).toMatch(/\.diff-row\.structure-landing \{\nbox-shadow:inset 2px 0 var\(--ember\)\}/);
    expect(pageHtml).not.toMatch(/\.diff-row\.structure-landing \{\n[^}]*background/);
  });

  it("mirrors Diff's no-input block and renders the 360px structure DOM without a layout engine", async () => {
    const noInput = await boot({ width: 360, stateResponses: [{ ...state, input: undefined }] });
    byId(noInput.document, "view-structure").click();
    expect(byId(noInput.document, "structure-content").textContent).toBe("Load a source to begin reviewing.");
    expect(byId(noInput.document, "structure-content").firstElementChild?.tagName).toBe("P");
    expect(noInput.requests.filter((request) => request.path === "/api/structure")).toHaveLength(0);

    const loaded = await boot({ width: 360 });
    byId(loaded.document, "view-structure").click();
    await flush();
    const panel = byId(loaded.document, "structure-section");
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  });

  it("switches Diff and Learning log as stable peer views", async () => {
    const entry = { id: "entry-view", inputId: source.id, source, selection: { text: "" }, question: "Saved", answer: "Answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const { window, document } = await boot({ entries: [entry] });
    const note = document.querySelector(".log-entry textarea") as any;
    input(document, "question", "draft survives view switch");

    byId(document, "view-log").click();
    expect(byId(document, "diff").hidden).toBe(true);
    expect(byId(document, "log-section").hidden).toBe(false);
    expect(byId(document, "files").hidden).toBe(true);
    expect(byId(document, "mobile-ask").hidden).toBe(true);
    expect(byId(document, "change-source").hidden).toBe(false);
    expect(byId(document, "view-log").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".log-entry textarea")).toBe(note);

    byId(document, "view-log").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(byId(document, "view-structure"));
    byId(document, "view-structure").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(byId(document, "view-diff"));
    expect(byId(document, "diff").hidden).toBe(true);
    byId(document, "view-diff").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(byId(document, "diff").hidden).toBe(false);
    expect(byId(document, "log-section").hidden).toBe(true);
    expect(byId(document, "question").value).toBe("draft survives view switch");
  });

  it("selects a clicked line while keeping the composer closed and docked", async () => {
    const { window, document } = await boot();
    const rows = selectableRows(document);
    const tutor = byId(document, "tutor");
    lineControl(rows[1]).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(lineControl(rows[1]).getAttribute("aria-pressed")).toBe("true");
    expect(tutor.classList.contains("open")).toBe(false);
    expect(tutor.parentElement).toBe(byId(document, "diff-pane"));
    expect(tutor.nextElementSibling).toBe(byId(document, "diff-scroll"));
    expect(document.activeElement).toBe(lineControl(rows[1]));
  });

  it("preserves the composer's actual open state across responsive normalization", async () => {
    const { window, document } = await boot();
    const row = selectableRows(document)[0];
    const tutor = byId(document, "tutor");
    row.querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    window.innerWidth = 800;
    window.dispatchEvent(new window.Event("resize"));
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event("resize"));
    expect(tutor.classList.contains("open")).toBe(false);
    expect(tutor.nextElementSibling).toBe(byId(document, "diff-scroll"));

    byId(document, "open-composer").click();
    input(document, "question", "Keep this general draft");
    window.innerWidth = 800;
    window.dispatchEvent(new window.Event("resize"));
    expect(tutor.classList.contains("open")).toBe(false);
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event("resize"));
    expect(tutor.classList.contains("open")).toBe(true);
    expect(tutor.previousElementSibling).toBe(row);
    expect(byId(document, "question").value).toBe("Keep this general draft");
  });

  it("keeps question focus and caret through a desktop-only resize", async () => {
    const { window, document } = await boot();
    const row = selectableRows(document)[0];
    row.querySelector(".line-action").click();
    const question = byId(document, "question");
    input(document, "question", "Half-written question");
    question.setSelectionRange(5, 12);
    window.innerWidth = 1380;
    window.dispatchEvent(new window.Event("resize"));
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(question);
    expect([question.selectionStart, question.selectionEnd]).toEqual([5, 12]);
  });

  it("extends a gutter range before any composer insertion", async () => {
    const { window, document } = await boot();
    const rows = selectableRows(document);
    const tutor = byId(document, "tutor");
    rows[1].querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    rows[2].querySelector(".marker").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    expect(byId(document, "selection-summary").textContent).toBe("src/a.ts · lines 1-2");
    expect(document.querySelectorAll('.line-select[aria-pressed="true"]')).toHaveLength(2);
    expect(tutor.classList.contains("open")).toBe(false);
    expect(tutor.nextElementSibling).toBe(byId(document, "diff-scroll"));
  });

  it("creates real line actions that preserve a selected range and open after its end", async () => {
    const { window, document } = await boot();
    const rows = selectableRows(document);
    lineControl(rows[1]).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    rows[2].querySelector(".marker").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    const actions = Array.from(document.querySelectorAll(".line-action")) as any[];
    expect(actions).toHaveLength(rows.length);
    expect(actions.every((action) => action.textContent === "+" && action.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(actions.every((action) => action.parentElement === action.closest(".line-no") && !action.hasAttribute("role"))).toBe(true);
    rows[1].querySelector(".line-action").click();
    expect(byId(document, "selection-summary").textContent).toBe("src/a.ts · lines 1-2");
    expect(byId(document, "tutor").previousElementSibling).toBe(rows[2]);
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    const question = byId(document, "question");
    expect(document.activeElement).toBe(question);
    question.value = "caret survives";
    question.setSelectionRange(3, 8);
    rows[1].querySelector(".line-action").click();
    expect(document.activeElement).toBe(question);
    expect([question.selectionStart, question.selectionEnd]).toEqual([3, 8]);
  });

  it("marks tutored ranges, reopens saved answers, and clears state for a different range", async () => {
    const older = {
      id: "entry-old", inputId: "old-input", source: { kind: source.kind, label: source.label, digest: source.digest },
      selection: { file: "src/a.ts", startLine: 1, endLine: 2, text: "const newValue = 2;\ncontext();", context: "" },
      question: "Older question", answer: "Older answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false,
      createdAt: "2026-08-20T10:00:00.000Z",
    };
    const newer = { ...older, id: "entry-new", inputId: "another-input", question: "Newest question", answer: "## Newest answer", createdAt: "2026-08-21T10:00:00.000Z" };
    const { window, document } = await boot({ entries: [older, newer] });
    const badge = document.querySelector(".tutored-badge") as any;
    expect(badge?.textContent).toBe("2");
    expect(badge?.getAttribute("aria-label")).toContain("2 saved answers");

    badge.click();
    expect(byId(document, "selection-summary").textContent).toBe("src/a.ts · lines 1-2");
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(byId(document, "question").value).toBe("Newest question");
    expect(byId(document, "answer-text").querySelector("h2")?.textContent).toBe("Newest answer");
    expect(byId(document, "answer").hidden).toBe(false);
    expect(byId(document, "history-pager").hidden).toBe(false);
    expect(byId(document, "history-position").textContent).toBe("1 of 2");
    byId(document, "refresh").click();
    await flush();
    expect(document.querySelector(".tutored-badge")).toBe(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("true");

    byId(document, "history-next").click();
    expect(byId(document, "question").value).toBe("Older question");
    expect(byId(document, "answer-text").textContent).toBe("Older answer");
    expect(byId(document, "history-position").textContent).toBe("2 of 2");

    byId(document, "close-tutor").click();
    const otherRow = selectableRows(document).find((row: any) => row.dataset.file === "1") as any;
    otherRow.querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    otherRow.querySelector(".line-action").click();
    expect(byId(document, "question").value).toBe("");
    expect(byId(document, "answer-text").textContent).toBe("");
    expect(byId(document, "answer").hidden).toBe(true);
    expect(byId(document, "history-pager").hidden).toBe(true);
  });

  it("opens mobile configuration as the sole dialog and restores the desktop collapse preference", async () => {
    const { window, document } = await boot({ width: 390, railCollapsed: true });
    byId(document, "open-config").click();
    const rail = document.querySelector(".rail") as any;
    expect(rail.classList.contains("config-open")).toBe(true);
    expect(rail.getAttribute("role")).toBe("dialog");
    expect(rail.getAttribute("aria-modal")).toBe("true");
    expect(byId(document, "toggle-rail").hasAttribute("aria-expanded")).toBe(false);
    expect(byId(document, "toggle-rail").hasAttribute("aria-controls")).toBe(false);
    expect(byId(document, "config-section").hidden).toBe(false);
    expect(byId(document, "diff-pane").hasAttribute("inert")).toBe(true);
    expect(rail.hasAttribute("inert")).toBe(false);
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event("resize"));
    expect(rail.classList.contains("config-open")).toBe(false);
    expect(rail.hasAttribute("role")).toBe(false);
    expect(document.querySelector(".workbench")?.classList.contains("rail-collapsed")).toBe(true);
    expect(byId(document, "config-section").hidden).toBe(true);
    expect(byId(document, "toggle-rail").getAttribute("aria-expanded")).toBe("false");
    expect(byId(document, "toggle-rail").getAttribute("aria-controls")).toBe("config-section");
  });

  it("bootstraps the token, cleans the URL, connects, and renders an initial multi-file diff", async () => {
    const { window, document, events } = await boot();
    expect(window.sessionStorage.getItem("reviewTutorSession")).toBe("secret-token");
    expect(window.location.search).toBe("");
    events?.onopen?.();
    expect(document.getElementById("connection")?.textContent).toBe("connected");
    expect(byId(document, "connection").dataset.state).toBe("connected");
    events?.onerror?.();
    expect(byId(document, "connection").dataset.state).toBe("reconnecting");
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

  it("hides redundant ready and duplicate question-state labels", async () => {
    const { document } = await boot();
    input(document, "question", "Explain this");
    expect(byId(document, "ask-helper").textContent).toBe("");
    expect(byId(document, "question-state").hidden).toBe(true);
  });

  it("matches saved additions without rescanning a colliding large deletion hunk", async () => {
    const count = 2000;
    const content = [
      "diff --git a/large.ts b/large.ts",
      "--- a/large.ts",
      "+++ b/large.ts",
      "@@ -1," + count + " +1," + count + " @@",
      ...Array.from({ length: count }, (_, index) => "-old " + index),
      ...Array.from({ length: count }, (_, index) => "+new " + index),
    ].join("\n");
    const largeSource = { ...source, label: "Large", digest: "large", content };
    const entry = {
      id: "large-entry", inputId: "older", source: { kind: source.kind, label: "Large", digest: "large" },
      selection: { file: "large.ts", startLine: 1, endLine: 1, text: "new 0", context: "" },
      question: "Explain", answer: "Answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false,
      createdAt: new Date().toISOString(),
    };
    const entries = Array.from({ length: 20 }, (_, index) => ({ ...entry, id: "large-" + index }));
    const { document } = await boot({ source: largeSource, entries });
    expect(document.querySelector(".tutored-badge")?.textContent).toBe("20");
  });

  it("submits contiguous selection and applies a synchronous duplicate Ask lock", async () => {
    let resolveAsk!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveAsk = resolve; });
    const { window, document, requests, events } = await boot({ askResponse: pending });
    const rows = selectableRows(document);
    const reachable = lineControl(rows.find((row) => lineControl(row).tabIndex === 0));
    reachable.focus();
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const addition = lineControl(rows.find((row) => lineControl(row).tabIndex === 0));
    addition.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    addition.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    input(document, "question", "Explain this");
    const ask = byId(document, "ask");
    ask.click();
    ask.click();
    expect(ask.disabled).toBe(true);
    expect(ask.getAttribute("aria-busy")).toBe("true");
    expect(ask.textContent).toBe("Sending");
    expect(ask.querySelector(".busy-dot")?.getAttribute("aria-hidden")).toBe("true");
    expect(requests.filter((request) => request.path === "/api/ask")).toHaveLength(1);
    resolveAsk(json({ id: "q-1", state: "queued", answer: "", createdAt: new Date().toISOString() }));
    await flush();
    const payload = JSON.parse(requests.find((request) => request.path === "/api/ask")?.init?.body as string);
    expect(payload.selection).toMatchObject({ file: "src/a.ts", startLine: 1, endLine: 2, text: "const newValue = 2;\ncontext();" });
    expect(payload.ownerPageId).toBe(window.sessionStorage.getItem("reviewTutorPageId"));
    expect(payload.ownerPageId).toHaveLength(36);
    expect(payload).not.toHaveProperty("harness");
    expect(ask.getAttribute("aria-busy")).toBe("false");
    expect(ask.textContent).toBe("Queued");
    expect(ask.querySelector(".busy-dot")).not.toBeNull();
    expect(ask.classList.contains("busy-neutral")).toBe(true);
    events?.emit("question", { id: "q-1", state: "running", answer: "" });
    expect(ask.textContent).toBe("Answering");
    expect(ask.querySelector(".busy-dot")).not.toBeNull();
    events?.emit("question", { id: "q-1", state: "answered", answer: "Done" });
    expect(ask.textContent).toBe("Ask");
    expect(ask.querySelector(".busy-dot")).toBeNull();
  });

  it("keeps Space and Shift+Arrow selection-only, then opens and focuses on Enter", async () => {
    const { window, document } = await boot();
    expect(document.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("selectable lines");
    const rows = selectableRows(document);
    const tutor = byId(document, "tutor");
    expect(rows.filter((row) => lineControl(row).tabIndex === 0)).toHaveLength(1);
    const reachable = lineControl(rows.find((row) => lineControl(row).tabIndex === 0));
    reachable.focus();
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(reachable.getAttribute("aria-pressed")).toBe("true");
    expect(tutor.classList.contains("open")).toBe(false);
    reachable.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect(rows.filter((row) => lineControl(row).tabIndex === 0)).toHaveLength(1);
    expect(tutor.classList.contains("open")).toBe(false);
    const rangeEnd = lineControl(rows.find((row) => lineControl(row).tabIndex === 0));
    rangeEnd.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tutor.classList.contains("open")).toBe(true);
    expect(tutor.previousElementSibling).toBe(rangeEnd.closest(".diff-row"));
    expect(document.activeElement).toBe(byId(document, "question"));
    const clear = byId(document, "clear-selection");
    clear.focus();
    clear.click();
    expect(rows.filter((row) => lineControl(row).getAttribute("aria-pressed") === "true")).toHaveLength(0);
    expect(byId(document, "selection-summary").textContent).toBe("No code selected");
    expect(document.activeElement?.classList.contains("line-select")).toBe(true);
    const disclosure = document.querySelector(".file-head button") as any;
    disclosure.click();
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.getAttribute("aria-label")).toBe("Expand src/a.ts");
  });

  it("re-docks an open composer for gutter adjustment without clearing its draft", async () => {
    const { window, document } = await boot();
    const rows = selectableRows(document);
    rows[1].querySelector(".line-action").click();
    input(document, "question", "Keep this draft");
    rows[2].querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    const tutor = byId(document, "tutor");
    expect(tutor.classList.contains("open")).toBe(false);
    expect(tutor.nextElementSibling).toBe(byId(document, "diff-scroll"));
    expect(byId(document, "question").value).toBe("Keep this draft");
    expect(lineControl(rows[2]).getAttribute("aria-pressed")).toBe("true");
  });

  it("scrolls the stable composer nearest only when opening at a changed anchor", async () => {
    const { document } = await boot();
    const rows = selectableRows(document);
    const tutor = byId(document, "tutor");
    rows[1].querySelector(".line-action").click();
    expect(tutor.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(tutor.scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    rows[1].querySelector(".line-action").click();
    expect(tutor.scrollIntoView).toHaveBeenCalledTimes(1);
    byId(document, "close-tutor").click();
    rows[1].querySelector(".line-action").click();
    expect(tutor.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("leaves app selection and native code pointer behavior untouched", async () => {
    const { window, document } = await boot();
    const rows = selectableRows(document);
    rows[1].querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    const summary = byId(document, "selection-summary").textContent;
    rows[2].querySelector(".code").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(byId(document, "selection-summary").textContent).toBe(summary);
    expect(lineControl(rows[1]).getAttribute("aria-pressed")).toBe("true");
    expect(lineControl(rows[2]).getAttribute("aria-pressed")).toBe("false");
    const codeDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    rows[2].querySelector(".code").dispatchEvent(codeDown);
    expect(codeDown.defaultPrevented).toBe(false);
    const gutterDown = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    rows[1].querySelector(".line-no").dispatchEvent(gutterDown);
    expect(gutterDown.defaultPrevented).toBe(true);
  });

  it("keeps code readable while exposing line selection and saved history as sibling controls", async () => {
    const entry = {
      id: "entry-accessible", inputId: source.id, source,
      selection: { file: "src/a.ts", startLine: 1, endLine: 1, text: "const newValue = 2;", context: "" },
      question: "Saved", answer: "Answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false,
      createdAt: new Date().toISOString(),
    };
    const { document } = await boot({ entries: [entry] });
    const row = selectableRows(document)[1];
    const control = lineControl(row);
    const badge = row.querySelector(".tutored-badge");
    expect(row.hasAttribute("role")).toBe(false);
    expect(row.textContent).toContain("const newValue = 2;");
    expect(control.tagName).toBe("BUTTON");
    expect(control.getAttribute("aria-label")).toContain("src/a.ts line 1");
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(badge?.parentElement).toBe(row);
    expect(control.contains(badge)).toBe(false);
  });

  it("keeps touch selection gated behind the Select lines toggle with whole-row targets", async () => {
    const { window, document } = await boot({ width: 390 });
    const rows = selectableRows(document);
    const touchDown = () => new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" });
    rows[0].dispatchEvent(touchDown());
    expect(byId(document, "selection-summary").textContent).toBe("No code selected");
    byId(document, "select-lines").click();
    rows[1].querySelector(".code").dispatchEvent(touchDown());
    expect(lineControl(rows[1]).getAttribute("aria-pressed")).toBe("true");
    rows[2].querySelector(".code").dispatchEvent(touchDown());
    expect(byId(document, "selection-summary").textContent).toBe("src/a.ts · lines 1-2");
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
  });

  it("contains Tab and Shift-Tab when either dialog container has focus", async () => {
    const { window, document } = await boot({ width: 390 });
    const tutor = byId(document, "tutor");
    byId(document, "mobile-ask").click();
    const tutorTab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    tutor.dispatchEvent(tutorTab);
    expect(tutorTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(document, "close-tutor"));
    tutor.focus();
    const tutorBackTab = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    tutor.dispatchEvent(tutorBackTab);
    expect(tutorBackTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(document, "question"));
    byId(document, "open-config").click();
    const rail = document.querySelector(".rail") as any;
    const configTab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    rail.dispatchEvent(configTab);
    expect(configTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(document, "toggle-rail"));
    rail.focus();
    const configBackTab = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    rail.dispatchEvent(configBackTab);
    expect(configBackTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(document, "jump-log"));
  });

  it("locks body scroll for one mutually exclusive mobile dialog and cleans up every exit", async () => {
    const { window, document } = await boot({ width: 390 });
    const tutor = byId(document, "tutor");
    const rail = document.querySelector(".rail") as any;
    byId(document, "open-config").click();
    expect(document.body.classList.contains("modal-open")).toBe(true);
    expect(rail.classList.contains("config-open")).toBe(true);
    byId(document, "mobile-ask").click();
    expect(rail.classList.contains("config-open")).toBe(false);
    expect(rail.hasAttribute("role")).toBe(false);
    expect(tutor.getAttribute("role")).toBe("dialog");
    expect(document.body.classList.contains("modal-open")).toBe(true);
    byId(document, "close-tutor").click();
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    byId(document, "open-config").click();
    byId(document, "jump-log").click();
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(rail.classList.contains("config-open")).toBe(false);
    byId(document, "mobile-ask").click();
    window.innerWidth = 861;
    window.dispatchEvent(new window.Event("resize"));
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(tutor.getAttribute("role")).toBe("region");
    expect(tutor.hasAttribute("aria-modal")).toBe(false);
    expect(rail.classList.contains("config-open")).toBe(false);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(pageHtml).toContain("body.modal-open {\noverflow:hidden");
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
    expect(byId(document, "diff-scroll").hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".toolbar")?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".rail")?.hasAttribute("inert")).toBe(true);
    expect(tutor.hasAttribute("inert")).toBe(false);
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
    expect(parsed.document.querySelector(".context .line-no")?.lastChild?.textContent).toBe("8");
    const plain = await boot({ source: { ...source, label: "paste.ts", content: "@@decorator\n++value;\n--value;" } });
    expect(plain.document.querySelectorAll(".file.plain .line-select")).toHaveLength(3);
    expect(plain.document.querySelectorAll(".file.plain .line-no")).toHaveLength(3);
  });

  it("restores a saved range across a no-newline marker", async () => {
    const marked = {
      ...source,
      digest: "marked",
      content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n context",
    };
    const entry = {
      id: "entry-marked", inputId: "older", source: { kind: source.kind, label: source.label, digest: "marked" },
      selection: { file: "a.ts", startLine: 1, endLine: 2, text: "new\ncontext", context: "" },
      question: "Explain", answer: "Answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false,
      createdAt: new Date().toISOString(),
    };
    const { document } = await boot({ source: marked, entries: [entry] });
    expect(document.querySelector(".tutored-badge")?.getAttribute("aria-label")).toContain("lines 1–2");
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

  it("renders non-file diff preamble once without creating a phantom file", async () => {
    const withPreamble = {
      ...source,
      content: "#61 feat(review-tutor): redesign guided review interface\nold mode 100644\nnew mode 100644\n" + source.content,
    };
    const { document } = await boot({ source: withPreamble });
    const preamble = document.querySelector(".diff-preamble");
    expect(preamble?.textContent).toContain("#61 feat(review-tutor): redesign");
    expect(preamble?.textContent).toContain("old mode 100644");
    expect(document.querySelectorAll(".diff-preamble")).toHaveLength(1);
    expect(document.querySelectorAll(".file")).toHaveLength(2);
    expect(document.querySelectorAll("#files option")).toHaveLength(2);
    expect(byId(document, "totals").textContent).toBe("+3 −1");
  });

  it("omits fabricated coordinates for mixed old/new selection and reports count", async () => {
    const { window, document, requests } = await boot();
    const control = document.querySelector('.line-select[tabindex="0"]') as any;
    control.focus();
    control.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    control.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
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
    const rows = selectableRows(document);
    lineControl(rows[0]).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(byId(document, "selection-preview").textContent).toBe("ok");
    rows[1].querySelector(".line-no").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, shiftKey: true }));
    expect(byId(document, "error").textContent).toContain("16 KiB");
    expect(byId(document, "selection-preview").textContent).toBe("ok");
    lineControl(rows[0]).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    expect(byId(document, "error").textContent).toBe("");
    expect(byId(document, "selection-preview").textContent).toBe("ok");
  });

  it("tears down an open mobile dialog on resize and ignores same-source replay", async () => {
    const { window, document, events } = await boot({ width: 390 });
    const row = document.querySelector('.line-select[tabindex="0"]')?.closest(".diff-row") as any;
    lineControl(row).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    events?.emit("source", source);
    expect(byId(document, "selection-summary").textContent).not.toBe("No code selected");
    byId(document, "mobile-ask").click();
    window.innerWidth = 1200;
    window.dispatchEvent(new window.Event("resize"));
    expect(byId(document, "tutor").classList.contains("open")).toBe(true);
    expect(byId(document, "tutor").getAttribute("role")).toBe("region");
    expect(byId(document, "diff-scroll").hasAttribute("inert")).toBe(false);
    expect(byId(document, "tutor").previousElementSibling).toBe(row);
    expect(document.activeElement).toBe(byId(document, "tutor"));
  });

  it("keeps mobile answer links inside the dialog tab order", async () => {
    const { window, document, events } = await boot({ width: 390 });
    events?.emit("state", { input: source, questions: [{ id: "q-links", state: "running", answer: "[First](https://example.com/1) [Second](https://example.com/2)" }] });
    byId(document, "mobile-ask").click();
    const first = byId(document, "answer-text").querySelector("a") as any;
    first.focus();
    const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    byId(document, "tutor").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("recovers its owned question after reload with the persisted page id", async () => {
    const { document, events, window } = await boot({ storedPageId: "same-page" });
    events?.emit("state", { input: source, questions: [{ id: "q-own", ownerPageId: "same-page", state: "running", answer: "Owned answer" }] });
    expect(window.sessionStorage.getItem("reviewTutorPageId")).toBe("same-page");
    expect(byId(document, "question-state").textContent).toBe("running");
    expect(byId(document, "answer-text").textContent).toBe("Owned answer");
  });

  it("does not adopt another tab's question but keeps Ask disabled while it runs", async () => {
    const { document, events } = await boot({ storedPageId: "second-page" });
    input(document, "question", "Can I ask?");
    expect(byId(document, "ask").disabled).toBe(false);
    events?.emit("state", { input: source, questions: [{ id: "q-foreign", ownerPageId: "first-page", state: "running", answer: "Foreign answer" }] });
    expect(byId(document, "question-state").textContent).toBe("");
    expect(byId(document, "answer-text").textContent).toBe("");
    expect(byId(document, "ask").disabled).toBe(true);
    expect(byId(document, "ask-helper").textContent).toBe("Another tab is asking. Wait for it to finish.");
    expect(byId(document, "mobile-ask").textContent).toBe("Ask the tutor");
    expect(byId(document, "cancel").disabled).toBe(true);
    events?.emit("question", { id: "q-foreign", ownerPageId: "first-page", state: "answered", answer: "Foreign answer" });
    expect(byId(document, "ask").disabled).toBe(false);
  });

  it("keeps Ask disabled until every foreign active question finishes", async () => {
    const { document, events } = await boot({ storedPageId: "third-page" });
    input(document, "question", "Can I ask now?");
    events?.emit("state", {
      input: source,
      questions: [
        { id: "q-foreign-1", ownerPageId: "first-page", state: "queued", answer: "" },
        { id: "q-foreign-2", ownerPageId: "second-page", state: "running", answer: "" },
      ],
    });
    expect(byId(document, "ask").disabled).toBe(true);
    events?.emit("question", { id: "q-foreign-1", ownerPageId: "first-page", state: "answered", answer: "Done" });
    expect(byId(document, "ask").disabled).toBe(true);
    events?.emit("question", { id: "q-foreign-2", ownerPageId: "second-page", state: "failed", answer: "" });
    expect(byId(document, "ask").disabled).toBe(false);
  });

  it("keeps foreign activity out of composer reset and saved-answer ownership", async () => {
    const entry = {
      id: "entry-foreign", inputId: source.id, source,
      selection: { file: "src/a.ts", startLine: 1, endLine: 2, text: "const newValue = 2;\ncontext();", context: "" },
      question: "Saved question", answer: "Saved answer", modelId: "model-1", preferences: {}, note: "", reviewLater: false,
      createdAt: "2026-08-21T10:00:00.000Z",
    };
    const { window, document, events } = await boot({ storedPageId: "second-page", entries: [entry] });
    const otherRow = selectableRows(document).find((row: any) => row.dataset.file === "1") as any;
    otherRow.querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    otherRow.querySelector(".line-action").click();
    input(document, "question", "Draft for another range");

    events?.emit("state", { input: source, questions: [{ id: "q-foreign", ownerPageId: "first-page", state: "running", answer: "Foreign answer" }] });
    const firstRow = selectableRows(document).find((row: any) => row.dataset.file === "0") as any;
    firstRow.querySelector(".line-no").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    firstRow.querySelector(".line-action").click();
    expect(byId(document, "question").value).toBe("");

    const badge = document.querySelector(".tutored-badge") as any;
    badge.click();
    expect(byId(document, "question").value).toBe("Saved question");
    expect(byId(document, "answer-text").textContent).toBe("Saved answer");
    expect(byId(document, "error").textContent).toBe("");
  });

  it("adopts a legacy question without page ownership", async () => {
    const { document, events } = await boot({ storedPageId: "new-page" });
    events?.emit("state", { input: source, questions: [{ id: "q-legacy", state: "running", answer: "Legacy answer" }] });
    expect(byId(document, "question-state").textContent).toBe("running");
    expect(byId(document, "answer-text").textContent).toBe("Legacy answer");
  });

  it("renders streamed tutor Markdown as safe semantic content", async () => {
    const { document, events, frames } = await boot();
    expect(byId(document, "answer").hidden).toBe(true);
    events?.emit("state", { input: source, questions: [{ id: "q-md", state: "running", answer: "## What it" }] });
    events?.emit("answer_delta", {
      id: "q-md",
      text: " means\n\n`HUMAN_LANGUAGES` contains **ten** names.\n\n```js\nfill(language, HUMAN_LANGUAGES);\n```\n\n- English\n- Portuguese\n\n[Docs](https://example.com/docs) <img src=x onerror=alert(1)>",
    });
    frames.flush();

    const answer = byId(document, "answer-text");
    expect(byId(document, "answer").hidden).toBe(false);
    expect(answer.querySelector("h2")?.textContent).toBe("What it means");
    expect(answer.querySelector("p code")?.textContent).toBe("HUMAN_LANGUAGES");
    expect(answer.querySelector("strong")?.textContent).toBe("ten");
    expect(answer.querySelector("pre code")?.textContent).toBe("fill(language, HUMAN_LANGUAGES);");
    expect(Array.from(answer.querySelectorAll("li")).map((node: any) => node.textContent)).toEqual(["English", "Portuguese"]);
    expect(answer.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(answer.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(answer.querySelector("img")).toBeNull();
    expect(answer.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("bounds nested blockquotes from persisted untrusted answers", async () => {
    const entry = { id: "entry-depth", inputId: source.id, source, selection: { text: "" }, question: "Explain", answer: ">".repeat(5000) + " boom", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const { document, events } = await boot({ entries: [entry] });
    expect(events).toBeDefined();
    expect(document.querySelectorAll(".log-entry")).toHaveLength(1);
    expect(document.querySelector(".log-answer")?.textContent).toContain("boom");
  });

  it("renders persisted learning-log answers with the same Markdown semantics", async () => {
    const entry = { id: "entry-md", inputId: source.id, source, selection: { text: "" }, question: "Explain", answer: "### Result\n\nUse `const`.", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const { document } = await boot({ entries: [entry] });
    expect(document.querySelector(".log-answer h3")?.textContent).toBe("Result");
    expect(document.querySelector(".log-answer code")?.textContent).toBe("const");
  });

  it("coalesces a large stream by frame and synchronously renders the exact terminal answer", async () => {
    const { document, events, frames } = await boot();
    events?.emit("state", { input: source, questions: [{ id: "q-stream", state: "running", answer: "" }] });
    const answer = byId(document, "answer-text");
    const renders = vi.spyOn(answer, "replaceChildren");
    let canonical = "";
    for (let frame = 0; frame < 3; frame++) {
      for (let index = 0; index < 100; index++) {
        const delta = String((frame * 100 + index) % 10);
        canonical += delta;
        events?.emit("answer_delta", { id: "q-stream", text: delta });
      }
      expect(frames.pending).toBe(1);
      frames.flush();
    }
    canonical += " final";
    events?.emit("answer_delta", { id: "q-stream", text: " final" });
    expect(frames.pending).toBe(1);
    events?.emit("question", { id: "q-stream", state: "answered", answer: canonical });
    expect(frames.pending).toBe(0);
    expect(renders).toHaveBeenCalledTimes(4);
    expect(answer.textContent).toBe(canonical);
    frames.flush();
    expect(renders).toHaveBeenCalledTimes(4);
  });

  it("buffers pre-response question events when state reconciliation fails", async () => {
    let resolveAsk!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveAsk = resolve; });
    const { document, events, frames } = await boot({ askResponse: pending, stateResponses: [state, new Error("state unavailable")] });
    input(document, "question", "Race");
    byId(document, "ask").click();
    events?.emit("question", { id: "q-early", state: "running", answer: "early " });
    for (let index = 0; index < 300; index++) events?.emit("answer_delta", { id: "q-early", text: "x" });
    resolveAsk(json({ id: "q-early", state: "queued", answer: "" }));
    await flush();
    frames.flush();
    expect(byId(document, "question-state").textContent).toBe("running");
    expect(byId(document, "answer-text").textContent).toBe("early " + "x".repeat(300));
    expect(byId(document, "error").textContent).toContain("state unavailable");
  });

  it("blocks Ctrl+Enter while an accepted question remains queued", async () => {
    const { window, document, requests } = await boot();
    input(document, "question", "Only once");
    byId(document, "ask").click();
    await flush();
    byId(document, "question").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await flush();
    expect(requests.filter((request) => request.path === "/api/ask")).toHaveLength(1);
    expect(byId(document, "question-state").textContent).toBe("queued");
  });

  it("reconciles a pre-response ask race to canonical running answer and keeps later deltas", async () => {
    const canonical = { id: "q-race", state: "running", answer: "canonical " };
    const { document, events, frames } = await boot({
      askResponse: json({ id: "q-race", state: "queued", answer: "" }),
      stateResponses: [state, { ...state, questions: [canonical] }],
    });
    input(document, "question", "Race");
    byId(document, "ask").click();
    await flush();
    expect(byId(document, "answer-text").textContent).toBe("canonical ");
    events?.emit("answer_delta", { id: "q-race", text: "continued" });
    frames.flush();
    expect(byId(document, "answer-text").textContent).toBe("canonical continued");
    expect(byId(document, "lifecycle").textContent).toBe("Tutor is answering.");
  });

  it("recovers canonical terminal state when cancellation loses a completion race", async () => {
    const running = { id: "q-race", state: "running", answer: "partial" };
    const answered = { id: "q-race", state: "answered", answer: "Complete" };
    const conflict = new Response(JSON.stringify({ error: "question cancellation failed: expected a queued or running question; refresh state and retry" }), {
      status: 409,
      statusText: "Conflict",
      headers: { "content-type": "application/json" },
    });
    const { document } = await boot({
      askResponse: json({ id: "q-race", state: "queued", answer: "" }),
      cancelResponse: conflict,
      stateResponses: [state, { ...state, questions: [running] }, { ...state, questions: [answered] }],
    });
    input(document, "question", "Explain this");
    byId(document, "ask").click();
    await flush();
    expect(byId(document, "question-state").textContent).toBe("running");

    byId(document, "cancel").click();
    await flush();

    expect(byId(document, "question-state").textContent).toBe("answered");
    expect(byId(document, "answer-text").textContent).toBe("Complete");
    expect(byId(document, "cancel").disabled).toBe(true);
    expect(byId(document, "error").textContent).toBe("");
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

  it("keeps the newest concurrent log refresh result", async () => {
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const older = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<Response>((resolve) => { resolveNewer = resolve; });
    const first = { id: "entry-old", inputId: source.id, source, selection: { text: "" }, question: "Older", answer: "A", modelId: "model-1", preferences: {}, note: "", reviewLater: false, createdAt: new Date().toISOString() };
    const latest = { ...first, id: "entry-new", question: "Newest" };
    const { document, events } = await boot({ logResponses: [[], older, newer] });
    events?.emit("log_update", first);
    events?.emit("log_update", latest);
    resolveNewer(json([latest]));
    await flush();
    resolveOlder(json([first]));
    await flush();
    expect(Array.from(document.querySelectorAll(".log-entry h3")).map((node) => node.textContent)).toEqual(["Newest"]);
  });

  it("shows a failed current question and restores Ask actions", async () => {
    const { document, events } = await boot();
    input(document, "question", "Fail");
    byId(document, "ask").click();
    await flush();
    events?.emit("question", { id: "q-1", state: "failed", answer: "", error: { message: "provider stopped" } });
    expect(byId(document, "error").textContent).toContain("provider stopped");
    expect(byId(document, "ask").disabled).toBe(false);
    expect(byId(document, "cancel").disabled).toBe(true);
    expect(byId(document, "lifecycle").textContent).toBe("Question failed.");
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
