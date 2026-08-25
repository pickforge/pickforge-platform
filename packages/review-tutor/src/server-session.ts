import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { exportLearningHtml } from "./export-html.ts";
import { loadInput, type ExecFile } from "./inputs.ts";
import { appendEntry, foldLog, persistInput, updateEntry } from "./log.ts";
import { buildTutorPrompt } from "./prompt.ts";
import { LIMITS, validateAskRequest, validateLogPatch, validateSourceRequest, type AskRequest, type InputSnapshot, type LearningEntry, type ModelChoice, type QuestionView, type StructureSnapshot } from "./protocol.ts";
import type { StatePaths } from "./paths.ts";
import type { SseHub } from "./sse.ts";
import { structureSnapshotWithNeighbours } from "./structure.ts";

export interface RunnerLike {
  run(request: { provider: string; model: string; thinking: string; cwd: string; prompt: string }, delta: (text: string) => void): Promise<{ answer: string; usage?: Record<string, number> }>;
  cancel(reason?: string): void;
  shutdown(): Promise<void>;
}

export interface SessionReply { status: number; value: unknown }

interface SessionOptions {
  cwd: string;
  canonicalRepo: string;
  models: ModelChoice[];
  execFile: ExecFile;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > LIMITS.body) throw new Error(
      `request body failed: expected at most ${LIMITS.body} bytes, received more; send a smaller request and retry`,
    );
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {
    throw new Error("request body failed: expected valid JSON; correct it and retry");
  }
}

function validateEmptyObject(value: unknown, name: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error(`${name} failed: expected an empty object; remove all fields and retry`);
  }
}

/** `neighbours=1` turns the bounded one-hop neighbour read on; anything else is a typed error. */
function parseNeighboursFlag(value: string | null): boolean {
  if (value === null || value === "0") return false;
  if (value === "1") return true;
  throw new Error("neighbours query failed: expected 1, 0, or absent; correct it and retry");
}

function parseLogLimit(value: string | null): number {
  if (value === null) return 100;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(
    `log limit failed: expected an integer from 0 through 1000, received '${value}'; correct it and retry`,
  );
  const limit = Number(value);
  if (limit > 1000) throw new Error(
    `log limit failed: expected an integer from 0 through 1000, received '${value}'; correct it and retry`,
  );
  return limit;
}

export class ReviewTutorSession {
  private readonly questions = new Map<string, QuestionView>();
  private readonly requests = new Map<string, AskRequest>();
  private readonly inputs = new Map<string, InputSnapshot>();
  private readonly queue: string[] = [];
  private readonly threadHistory: LearningEntry[] = [];
  private currentInput?: InputSnapshot;
  private readonly structureCache = new Map<string, StructureSnapshot>();
  private running?: string;
  private lastHeartbeat = 0;
  private closing = false;

  constructor(
    private readonly options: SessionOptions,
    private readonly paths: StatePaths,
    private readonly rubric: string,
    private readonly runner: RunnerLike,
    private readonly hub: SseHub,
  ) {}

  private pruneInputs(): void {
    const protectedIds = new Set([...this.requests.values()].map((request) => request.inputId));
    if (this.currentInput) protectedIds.add(this.currentInput.id);
    for (const id of this.inputs.keys()) {
      if (this.inputs.size <= 32) break;
      if (!protectedIds.has(id)) this.inputs.delete(id);
    }
  }

  private retainQuestions(): void {
    const terminal = [...this.questions.values()].filter((view) =>
      ["answered", "failed", "cancelled"].includes(view.state));
    for (const view of terminal.slice(0, Math.max(0, terminal.length - 100))) {
      this.questions.delete(view.id);
    }
  }

  private finishQuestion(view: QuestionView): void {
    this.requests.delete(view.id);
    this.retainQuestions();
    this.pruneInputs();
  }

  async processQueue(): Promise<void> {
    if (this.running || this.closing) return;
    const id = this.queue.shift();
    if (!id) return;
    const view = this.questions.get(id);
    const ask = this.requests.get(id);
    if (!view || !ask) return;
    this.startQuestion(id, view);
    const source = this.inputs.get(ask.inputId);
    if (!source) return this.failMissingInput(view);
    try {
      await this.executeQuestion(id, view, ask, source);
    } catch (error) {
      this.failQuestion(id, view, error);
    } finally {
      this.finishQuestion(view);
      this.running = undefined;
      void this.processQueue();
    }
  }

  private startQuestion(id: string, view: QuestionView): void {
    this.running = id;
    view.state = "running";
    view.startedAt = new Date().toISOString();
    this.hub.emit("question", view);
  }

  private failMissingInput(view: QuestionView): void {
    view.state = "failed";
    view.error = { code: "input_missing", message: "question failed: expected the accepted input snapshot to remain available; reload it and retry" };
    view.finishedAt = new Date().toISOString();
    this.hub.emit("question", view);
    this.finishQuestion(view);
    this.running = undefined;
    void this.processQueue();
  }

  private async executeQuestion(id: string, view: QuestionView, ask: AskRequest, source: InputSnapshot): Promise<void> {
    const [provider, ...modelParts] = ask.modelId.split("/");
    const result = await this.runner.run({
      provider: provider!, model: modelParts.join("/"), thinking: ask.thinkingLevel,
      cwd: this.options.canonicalRepo,
      prompt: buildTutorPrompt(this.rubric, { ...ask, input: source, history: this.threadHistory }),
    }, (text) => {
      if (view.state !== "running") return;
      view.answer += text;
      this.hub.emit("answer_delta", { id, text });
    });
    if (this.questions.get(id)?.state === "cancelled") return;
    await this.answerQuestion(view, ask, source, result);
  }

  private async answerQuestion(view: QuestionView, ask: AskRequest, source: InputSnapshot, result: { answer: string; usage?: Record<string, number> }): Promise<void> {
    const now = new Date().toISOString();
    const entry: LearningEntry = {
      id: randomUUID(), inputId: source.id,
      source: { kind: source.kind, label: source.label, digest: source.digest,
        ...(source.githubUrl ? { githubUrl: source.githubUrl } : {}),
        ...(source.headSha ? { headSha: source.headSha } : {}) },
      selection: ask.selection, question: ask.question, answer: result.answer,
      modelId: ask.modelId, preferences: ask.preferences, note: "", reviewLater: false,
      createdAt: now, updatedAt: now,
    };
    await appendEntry(this.paths, entry);
    this.threadHistory.push(entry);
    if (this.threadHistory.length > 6) this.threadHistory.splice(0, this.threadHistory.length - 6);
    this.hub.emit("log_update", entry);
    view.answer = result.answer;
    view.usage = result.usage;
    view.state = "answered";
    view.finishedAt = now;
    this.hub.emit("question", view);
  }

  private failQuestion(id: string, view: QuestionView, error: unknown): void {
    if (this.questions.get(id)?.state === "cancelled") return;
    view.state = "failed";
    view.error = { code: "question_failed", message: error instanceof Error ? error.message : String(error) };
    view.finishedAt = new Date().toISOString();
    this.hub.emit("error", view.error);
    this.hub.emit("question", view);
  }

  async acceptSource(loaded: InputSnapshot, announce: boolean): Promise<void> {
    await persistInput(this.paths, loaded.id, loaded.content);
    this.currentInput = loaded;
    this.inputs.set(loaded.id, loaded);
    this.pruneInputs();
    if (announce) this.hub.emit("source", loaded);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.hub.close();
    await this.runner.shutdown();
  }

  state(): SessionReply {
    return { status: 200, value: { protocol: "rt/1", models: this.options.models,
      input: this.currentInput, questions: [...this.questions.values()], lastHeartbeat: this.lastHeartbeat } };
  }

  async source(request: IncomingMessage): Promise<SessionReply> {
    const sourceRequest = validateSourceRequest(await readBody(request));
    const loaded = await loadInput(sourceRequest, this.options.cwd, this.options.execFile);
    await this.acceptSource(loaded, true);
    return { status: 201, value: loaded };
  }

  async ask(request: IncomingMessage): Promise<SessionReply> {
    const ask = validateAskRequest(await readBody(request));
    if (!this.inputs.has(ask.inputId)) return { status: 409, value: {
      error: "ask input failed: expected an input loaded during this server session; reload the source and retry" } };
    const model = this.options.models.find((candidate) => candidate.id === ask.modelId);
    if (!model || !model.thinkingLevels.includes(ask.thinkingLevel)) return { status: 400, value: {
      error: "model selection failed: expected an available model and thinking level; refresh state and retry" } };
    if (this.queue.length >= LIMITS.queue) return { status: 429, value: {
      error: `question queue failed: expected depth at most ${LIMITS.queue}, received ${this.queue.length + 1}; wait for a question to finish` } };
    const view: QuestionView = {
      id: randomUUID(),
      ...(ask.ownerPageId !== undefined ? { ownerPageId: ask.ownerPageId } : {}),
      state: "queued",
      answer: "",
      createdAt: new Date().toISOString(),
    };
    this.questions.set(view.id, view);
    this.requests.set(view.id, ask);
    this.queue.push(view.id);
    this.hub.emit("question", view);
    void this.processQueue();
    return { status: 202, value: view };
  }

  async cancel(request: IncomingMessage, id: string): Promise<SessionReply> {
    validateEmptyObject(await readBody(request), "question cancellation body");
    const view = this.questions.get(id);
    if (!view || !["queued", "running"].includes(view.state)) return { status: 409, value: {
      error: "question cancellation failed: expected a queued or running question; refresh state and retry" } };
    view.state = "cancelled";
    view.finishedAt = new Date().toISOString();
    this.requests.delete(view.id);
    this.pruneInputs();
    if (this.running === view.id) this.runner.cancel("cancelled by user");
    else {
      const index = this.queue.indexOf(view.id);
      if (index >= 0) this.queue.splice(index, 1);
      this.retainQuestions();
    }
    this.hub.emit("question", view);
    return { status: 200, value: view };
  }

  events(request: IncomingMessage, response: ServerResponse, url: URL, headers: Record<string, string>): void {
    const rawSince = url.searchParams.get("since") ?? request.headers["last-event-id"] ?? "0";
    const since = Number(rawSince);
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let disconnect = (): void => {};
    const cleanConnection = (): void => { if (keepalive) clearInterval(keepalive); disconnect(); };
    response.on("error", cleanConnection);
    request.on("close", cleanConnection);
    response.writeHead(200, { ...headers, "Content-Type": "text/event-stream", Connection: "keep-alive" });
    disconnect = this.hub.connect(response, Number.isSafeInteger(since) && since >= 0 ? since : 0);
    const connected = this.hub.unicast(response, "hello", { protocol: "rt/1" })
      && this.hub.unicast(response, "state", { input: this.currentInput, questions: [...this.questions.values()] });
    if (!connected) return this.endEvents(response, cleanConnection);
    keepalive = setInterval(() => this.keepalive(response, cleanConnection), 15_000);
  }

  private endEvents(response: ServerResponse, clean: () => void): void {
    clean();
    if (!response.destroyed && !response.writableEnded) response.end();
  }

  private keepalive(response: ServerResponse, clean: () => void): void {
    try { if (!response.destroyed && !response.writableEnded) response.write(": keepalive\n\n"); } catch {
      clean();
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }

  async structure(url: URL): Promise<SessionReply> {
    const input = this.currentInput;
    if (!input) return { status: 409, value: {
      error: "structure failed: expected a loaded input snapshot, received none; load a source and retry" } };
    const neighbours = parseNeighboursFlag(url.searchParams.get("neighbours"));
    const key = `${input.id} ${String(neighbours)}`;
    const cached = this.structureCache.get(key);
    if (cached) return { status: 200, value: cached };
    const snapshot = await structureSnapshotWithNeighbours(input, {
      neighbours, cwd: this.options.cwd, execFile: this.options.execFile,
    });
    if (this.structureCache.size >= 4) this.structureCache.clear();
    this.structureCache.set(key, snapshot);
    return { status: 200, value: snapshot };
  }

  async log(url: URL): Promise<SessionReply> {
    const limit = parseLogLimit(url.searchParams.get("limit"));
    const entries = await foldLog(this.paths);
    return { status: 200, value: limit === 0 ? [] : entries.slice(-limit) };
  }

  async patchLog(request: IncomingMessage, id: string): Promise<SessionReply> {
    const patch = validateLogPatch(await readBody(request));
    await updateEntry(this.paths, id, patch);
    const entry = (await foldLog(this.paths)).find((candidate) => candidate.id === id);
    this.hub.emit("log_update", entry);
    return { status: 200, value: entry };
  }

  async export(): Promise<string> { return exportLearningHtml(await foldLog(this.paths)); }

  async heartbeat(request: IncomingMessage): Promise<SessionReply> {
    validateEmptyObject(await readBody(request), "heartbeat body");
    this.lastHeartbeat = Date.now();
    return { status: 200, value: { ok: true } };
  }
}
