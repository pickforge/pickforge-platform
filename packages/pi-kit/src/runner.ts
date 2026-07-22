import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createClaudeCodeAdapter } from "./adapters/claude-code.ts";
import { PiExecutionAdapter } from "./adapters/pi.ts";
import type {
  LaneEventParser,
  LaneExecutionAdapter,
  LaneProcessPlan,
  NormalizedLaneEvent,
} from "./execution-adapter.ts";
import type { KitEvent, LaneOrigin, LaneProjection, LaneSpec, RunProjection } from "./schema.ts";
import { estimateCost, findModel, normalizeLaneSpec, validateLaneSpec } from "./table.ts";

export interface RunnerOptions {
  runId: string;
  append: (ev: KitEvent) => void;
  maxConcurrent?: number;
  maxAttempts?: number;
  piBinary?: string;
  adapters?: readonly LaneExecutionAdapter[];
  origin?: LaneOrigin;
  onUpdate?: () => void;
  /** Directory for canonical per-lane JSONL transcripts (`<rawDir>/<lane>.jsonl`). */
  rawDir?: string;
}

type TerminalOutcome =
  | { type: "end"; ok: boolean; answer: string; stopReason?: string }
  | { type: "abandoned" };

interface LaneRuntime {
  child: ChildProcessByStdio<null, Readable, Readable>;
  parser: LaneEventParser;
  raw?: WriteStream;
  terminal?: TerminalOutcome;
  closed: boolean;
  terminating: boolean;
  parserEnded: boolean;
  startedAt: number;
  stdoutBuffer: string;
  stdoutOverflow: boolean;
  stderrTail: string;
  answer: string;
  statusTail: string;
  statusTimer?: NodeJS.Timeout;
  lastStatusAt: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  context: number;
  rawBytes: number;
  rawCapped: boolean;
  taskWritten: boolean;
}

interface PreparedLane {
  spec: LaneSpec;
  adapter: LaneExecutionAdapter;
}

interface LaneAttemptResult {
  outcome: TerminalOutcome;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: number;
}

interface AttemptUsage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

type JsonRecord = Record<string, unknown>;

const MAX_STREAM_BYTES = 4 * 1024 * 1024;

/** Live runners with children, reaped synchronously if the parent dies. */
const ACTIVE_RUNNERS = new Set<LaneRunner>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const runner of ACTIVE_RUNNERS) runner.reapAll();
  });
}

/** SIGTERM/SIGKILL the child's whole process group, falling back to the direct child. */
function killTree(child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already gone.
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function toolSummary(tool: string, args: unknown): string {
  let summary: string | undefined;
  if (isRecord(args)) {
    if (tool.toLowerCase() === "bash" && typeof args.command === "string") summary = args.command;
    for (const key of ["path", "file_path", "filePath"]) {
      if (summary === undefined && typeof args[key] === "string") summary = args[key];
    }
  }
  if (summary === undefined) {
    try {
      summary = JSON.stringify(args) ?? "";
    } catch {
      summary = String(args);
    }
  }
  return summary.replace(/\s+/g, " ").trim().slice(0, 80);
}

function validUsage(event: Extract<NormalizedLaneEvent, { type: "usage" }>): boolean {
  return [event.input, event.output, event.cacheRead, event.context].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
}

function isAssistantError(event: Extract<NormalizedLaneEvent, { type: "assistant_end" }>): boolean {
  return event.isError === true;
}

export class LaneRunner {
  private readonly append: (ev: KitEvent) => void;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly onUpdate?: () => void;
  private readonly adapters: readonly LaneExecutionAdapter[];
  private readonly origin: LaneOrigin;
  private readonly rawDir?: string;
  private readonly runId: string;
  private readonly runtimes = new Map<string, LaneRuntime>();
  private readonly live: RunProjection;
  private dispatching = false;
  private shuttingDown = false;
  private dispatchPromise?: Promise<LaneProjection[]>;
  private shutdownPromise?: Promise<void>;

  constructor(opts: RunnerOptions) {
    this.runId = opts.runId;
    this.append = opts.append;
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 4));
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 2));
    this.adapters = opts.adapters ?? [new PiExecutionAdapter(opts.piBinary), createClaudeCodeAdapter()];
    this.origin = opts.origin ?? "pi";
    if (opts.rawDir) this.rawDir = opts.rawDir;
    this.onUpdate = opts.onUpdate;
    this.live = {
      run: opts.runId,
      origin: this.origin,
      createdAt: new Date().toISOString(),
      ended: false,
      lanes: new Map(),
      totalCost: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };
  }

  projection(): RunProjection {
    return this.live;
  }

  dispatch(specs: LaneSpec[]): Promise<LaneProjection[]> {
    if (this.shuttingDown) return Promise.reject(new Error("LaneRunner is shutting down"));
    if (this.dispatching) return Promise.reject(new Error("LaneRunner.dispatch may only be called once"));
    const promise = this.dispatchRun(specs);
    this.dispatchPromise = promise;
    return promise;
  }

  private async dispatchRun(specs: LaneSpec[]): Promise<LaneProjection[]> {
    const violations: string[] = [];
    const seen = new Set<string>();
    const prepared: PreparedLane[] = [];
    specs.forEach((input, index) => {
      const label = input.lane || `lane-${index + 1}`;
      const reason = validateLaneSpec(input, { origin: this.origin });
      if (reason) violations.push(`${label}: ${reason}`);
      if (input.lane) {
        if (seen.has(input.lane)) violations.push(`${input.lane}: duplicate lane id`);
        seen.add(input.lane);
      }
      if (reason) return;

      try {
        const spec = normalizeLaneSpec(input, { origin: this.origin });
        const row = findModel(spec.model)!;
        const matches = this.adapters.filter((adapter) => adapter.route === row.route);
        if (matches.length !== 1) {
          violations.push(
            `${label}: expected exactly one execution adapter for route ${row.route}; found ${matches.length}`,
          );
          return;
        }
        const adapter = matches[0]!;
        adapter.preflight(spec);
        prepared.push({ spec, adapter });
      } catch (error) {
        violations.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (violations.length > 0) throw new Error(`Invalid lane specs:\n${violations.join("\n")}`);

    this.dispatching = true;
    installExitHook();
    ACTIVE_RUNNERS.add(this);
    for (const { spec } of prepared) {
      this.record({ v: 1, t: new Date().toISOString(), run: this.runId, lane: spec.lane, type: "lane_created", spec });
    }

    let next = 0;
    const workers = Array.from({ length: Math.min(this.maxConcurrent, prepared.length) }, async () => {
      while (next < prepared.length) {
        const lane = prepared[next++];
        if (lane && this.live.lanes.get(lane.spec.lane)?.state === "queued") await this.runLane(lane);
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      ACTIVE_RUNNERS.delete(this);
    }

    this.live.ended = true;
    this.live.ok = [...this.live.lanes.values()].every((lane) => lane.state === "done");
    this.notify();
    return [...this.live.lanes.values()];
  }

  abandon(lane: string, reason: string): void {
    const projection = this.live.lanes.get(lane);
    if (!projection || ["done", "failed", "abandoned"].includes(projection.state)) return;

    const runtime = this.runtimes.get(lane);
    if (runtime?.terminal) return;
    this.record({ v: 1, t: new Date().toISOString(), run: this.runId, lane, type: "lane_abandoned", reason });
    if (runtime) this.requestTerminal(runtime, { type: "abandoned" });
  }

  /** Abandon every non-terminal lane (abort signal, shutdown). */
  abandonAll(reason: string): void {
    for (const [lane, projection] of this.live.lanes) {
      if (!["done", "failed", "abandoned"].includes(projection.state)) this.abandon(lane, reason);
    }
  }

  /** Abandon active lanes and wait until dispatch has observed every child close. */
  shutdown(reason: string): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = this.finishShutdown(reason);
    }
    return this.shutdownPromise;
  }

  /** Synchronous last-resort kill of every live child. Called from the process exit hook. */
  reapAll(): void {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) killTree(runtime.child, "SIGKILL");
  }

  private async finishShutdown(reason: string): Promise<void> {
    this.abandonAll(reason);
    try {
      await this.dispatchPromise;
    } catch {
      // Dispatch validation/preflight errors own no live children.
    } finally {
      ACTIVE_RUNNERS.delete(this);
    }
  }

  /** SIGTERM the child's process group now, escalate to SIGKILL after 5s. */
  private terminate(runtime: LaneRuntime): void {
    if (runtime.terminating || runtime.closed) return;
    runtime.terminating = true;
    killTree(runtime.child, "SIGTERM");
    const killTimer = setTimeout(() => killTree(runtime.child, "SIGKILL"), 5_000);
    killTimer.unref();
    runtime.child.once("close", () => clearTimeout(killTimer));
  }

  private requestTerminal(runtime: LaneRuntime, outcome: TerminalOutcome): void {
    if (runtime.terminal) return;
    runtime.terminal = outcome;
    clearTimeout(runtime.statusTimer);
    this.terminate(runtime);
  }

  private record(event: KitEvent): void {
    if (event.type === "lane_created") {
      this.live.lanes.set(event.spec.lane, {
        spec: event.spec,
        state: "queued",
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      });
    } else if (event.lane) {
      const lane = this.live.lanes.get(event.lane);
      if (lane) {
        switch (event.type) {
          case "lane_start":
            lane.state = "running";
            lane.pid = event.pid;
            lane.startedAtMs ??= Date.parse(event.t);
            break;
          case "lane_tool":
            lane.currentTool = `${event.tool}: ${event.summary}`;
            break;
          case "lane_status":
            lane.lastStatus = event.text;
            break;
          case "lane_usage":
            this.live.totalTokensIn += event.input - lane.tokensIn;
            this.live.totalTokensOut += event.output - lane.tokensOut;
            this.live.totalCost += event.cost - lane.cost;
            lane.tokensIn = event.input;
            lane.tokensOut = event.output;
            lane.cost = event.cost;
            lane.context = event.context;
            break;
          case "lane_end":
            lane.state = event.ok ? "done" : "failed";
            lane.answer = event.answer;
            lane.durationMs = event.durationMs;
            break;
          case "lane_abandoned":
            lane.state = "abandoned";
            lane.abandonReason = event.reason;
            if (lane.startedAtMs !== undefined) {
              lane.durationMs = Math.max(0, Date.parse(event.t) - lane.startedAtMs);
            }
            break;
        }
      }
    }
    try {
      this.append(event);
    } catch {}
    this.notify();
  }

  private notify(): void {
    try {
      this.onUpdate?.();
    } catch {}
  }

  private transcriptPath(lane: string): { directory: string; path: string } {
    const directory = resolve(this.rawDir!);
    const path = resolve(directory, `${lane}.jsonl`);
    const childPath = relative(directory, path);
    if (childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
      throw new Error(`Transcript path for lane ${lane} escapes rawDir`);
    }
    return { directory, path };
  }

  private async runLane(prepared: PreparedLane): Promise<void> {
    const startedAt = Date.now();
    let usage: AttemptUsage = { tokensIn: 0, tokensOut: 0, cost: 0 };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await this.runLaneAttempt(prepared, usage);
      usage = {
        tokensIn: usage.tokensIn + result.tokensIn,
        tokensOut: usage.tokensOut + result.tokensOut,
        cost: usage.cost + result.cost,
      };
      if (result.outcome.type === "abandoned") return;
      if (result.outcome.ok || attempt === this.maxAttempts || this.shuttingDown) {
        this.record({
          v: 1,
          t: new Date().toISOString(),
          run: this.runId,
          lane: prepared.spec.lane,
          type: "lane_end",
          ok: result.outcome.ok,
          ...(result.outcome.stopReason ? { stopReason: result.outcome.stopReason } : {}),
          answer: result.outcome.answer.slice(0, 4_000),
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const projection = this.live.lanes.get(prepared.spec.lane);
      if (projection) projection.currentTool = undefined;
      this.record({
        v: 1,
        t: new Date().toISOString(),
        run: this.runId,
        lane: prepared.spec.lane,
        type: "lane_status",
        text: `attempt ${attempt} failed${result.outcome.stopReason ? ` (${result.outcome.stopReason})` : ""}; retrying`,
      });
    }
  }

  private async runLaneAttempt({ spec, adapter }: PreparedLane, prior: AttemptUsage): Promise<LaneAttemptResult> {
    try {
      await adapter.prepare?.(spec);
    } catch (error) {
      if (this.live.lanes.get(spec.lane)?.state !== "abandoned") {
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: { type: "end", ok: false, stopReason: `prepare:${message}`, answer: message },
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          context: 0,
        };
      }
      return {
        outcome: { type: "abandoned" },
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      };
    }
    if (this.live.lanes.get(spec.lane)?.state === "abandoned") {
      return { outcome: { type: "abandoned" }, tokensIn: 0, tokensOut: 0, cost: 0, context: 0 };
    }

    let plan: LaneProcessPlan;
    let parser: LaneEventParser;
    try {
      plan = adapter.build(spec);
      parser = adapter.createParser(spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: { type: "end", ok: false, stopReason: `setup:${message}`, answer: message },
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      };
    }

    const { promise, resolve } = Promise.withResolvers<LaneAttemptResult>();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        outcome: { type: "end", ok: false, stopReason: `spawn:${message}`, answer: message },
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        context: 0,
      });
      return promise;
    }

    let raw: WriteStream | undefined;
    if (this.rawDir) {
      try {
        const transcript = this.transcriptPath(spec.lane);
        mkdirSync(transcript.directory, { recursive: true });
        raw = createWriteStream(transcript.path, { flags: "a" });
        raw.on("error", () => {
          // Transcript capture is best-effort; the lane must still run and settle.
        });
      } catch {
        // Transcript capture is best-effort; the lane must still run.
      }
    }

    const runtime: LaneRuntime = {
      child,
      parser,
      ...(raw ? { raw } : {}),
      closed: false,
      terminating: false,
      parserEnded: false,
      startedAt: Date.now(),
      stdoutBuffer: "",
      stdoutOverflow: false,
      stderrTail: "",
      answer: "",
      statusTail: "",
      lastStatusAt: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      context: 0,
      rawBytes: 0,
      rawCapped: false,
      taskWritten: false,
    };
    this.runtimes.set(spec.lane, runtime);
    this.writeCanonical(runtime, { v: 1, type: "task", text: spec.task });

    const emitStatus = () => {
      runtime.statusTimer = undefined;
      if (runtime.terminal || !runtime.statusTail) return;
      runtime.lastStatusAt = Date.now();
      this.record({
        v: 1,
        t: new Date().toISOString(),
        run: this.runId,
        lane: spec.lane,
        type: "lane_status",
        text: runtime.statusTail.slice(-120),
      });
    };

    const handleEvent = (event: NormalizedLaneEvent, allowSuccess = true) => {
      if (!isRecord(event) || event.v !== 1 || typeof event.type !== "string") return;
      if (event.type === "task") {
        if (!runtime.taskWritten) this.writeCanonical(runtime, { v: 1, type: "task", text: spec.task });
        return;
      }
      if (event.type === "usage") {
        if (!validUsage(event)) return;
        if (
          event.input === runtime.tokensIn &&
          event.output === runtime.tokensOut &&
          event.cacheRead === runtime.cacheRead &&
          event.context === runtime.context
        ) {
          return;
        }
      }
      this.writeCanonical(runtime, event);

      switch (event.type) {
        case "thinking_delta":
          break;
        case "text_delta": {
          if (runtime.answer.length < 4_000) runtime.answer += event.delta.slice(0, 4_000 - runtime.answer.length);
          runtime.statusTail = `${runtime.statusTail}${event.delta}`.replace(/\s+/g, " ").trim().slice(-120);
          const elapsed = Date.now() - runtime.lastStatusAt;
          if (elapsed >= 1_000) emitStatus();
          else if (!runtime.statusTimer) {
            runtime.statusTimer = setTimeout(emitStatus, 1_000 - elapsed);
            runtime.statusTimer.unref();
          }
          break;
        }
        case "tool_start":
          this.record({
            v: 1,
            t: new Date().toISOString(),
            run: this.runId,
            lane: spec.lane,
            type: "lane_tool",
            tool: event.tool,
            summary: toolSummary(event.tool, event.input),
          });
          break;
        case "tool_end":
          break;
        case "usage":
          runtime.tokensIn = event.input;
          runtime.tokensOut = event.output;
          runtime.cacheRead = event.cacheRead;
          runtime.context = event.context;
          this.record({
            v: 1,
            t: new Date().toISOString(),
            run: this.runId,
            lane: spec.lane,
            type: "lane_usage",
            input: prior.tokensIn + event.input,
            output: prior.tokensOut + event.output,
            cacheRead: event.cacheRead,
            cost: prior.cost + estimateCost(spec.model, event.input, event.output),
            context: event.context,
          });
          break;
        case "assistant_end":
          runtime.answer = event.text.slice(0, 4_000);
          if (isAssistantError(event)) {
            this.requestTerminal(runtime, {
              type: "end",
              ok: false,
              answer: runtime.answer,
              stopReason: "assistant-error",
            });
          } else if (allowSuccess) {
            this.requestTerminal(runtime, { type: "end", ok: true, answer: runtime.answer });
          }
          break;
      }
    };

    const feedParser = (line: string) => {
      try {
        for (const event of parser.feedLine(line)) handleEvent(event);
      } catch (error) {
        this.requestTerminal(runtime, {
          type: "end",
          ok: false,
          answer: runtime.stderrTail,
          stopReason: `parser:${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    child.once("spawn", () => {
      if (!runtime.closed && !runtime.terminal) {
        this.record({
          v: 1,
          t: new Date().toISOString(),
          run: this.runId,
          lane: spec.lane,
          type: "lane_start",
          pid: child.pid!,
        });
      }
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const failStdoutOverflow = () => {
      runtime.stdoutOverflow = true;
      runtime.stdoutBuffer = "";
      this.requestTerminal(runtime, {
        type: "end",
        ok: false,
        answer: runtime.answer,
        stopReason: "stdout-overflow",
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (runtime.stdoutOverflow) return;
      runtime.stdoutBuffer += stdoutDecoder.write(chunk);
      let newline = runtime.stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = runtime.stdoutBuffer.slice(0, newline);
        runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_STREAM_BYTES) {
          failStdoutOverflow();
          return;
        }
        if (line.trim()) feedParser(line);
        newline = runtime.stdoutBuffer.indexOf("\n");
      }
      if (Buffer.byteLength(runtime.stdoutBuffer) > MAX_STREAM_BYTES) failStdoutOverflow();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      runtime.stderrTail = `${runtime.stderrTail}${chunk}`.slice(-500);
    });
    child.once("error", (error) => {
      this.requestTerminal(runtime, {
        type: "end",
        ok: false,
        answer: runtime.stderrTail || error.message,
        stopReason: `spawn:${error.message}`,
      });
    });
    child.once("close", (code) => {
      runtime.closed = true;
      clearTimeout(runtime.statusTimer);
      if (!runtime.stdoutOverflow) {
        runtime.stdoutBuffer += stdoutDecoder.end();
        if (runtime.stdoutBuffer) feedParser(runtime.stdoutBuffer);
      }
      runtime.stdoutBuffer = "";

      if (!runtime.parserEnded) {
        runtime.parserEnded = true;
        try {
          for (const event of parser.end()) handleEvent(event, code === 0);
        } catch (error) {
          if (!runtime.terminal) {
            runtime.terminal = {
              type: "end",
              ok: false,
              answer: runtime.stderrTail,
              stopReason: `parser:${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      }
      if (!runtime.terminal) {
        runtime.terminal = {
          type: "end",
          ok: false,
          answer: runtime.stderrTail || runtime.answer,
          stopReason: `exit:${code ?? "signal"}`,
        };
      }

      const outcome = runtime.terminal;
      this.runtimes.delete(spec.lane);

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve({
          outcome,
          tokensIn: runtime.tokensIn,
          tokensOut: runtime.tokensOut,
          cost: estimateCost(spec.model, runtime.tokensIn, runtime.tokensOut),
          context: runtime.context,
        });
      };
      if (runtime.raw && !runtime.raw.destroyed) {
        runtime.raw.once("error", finish);
        runtime.raw.end(finish);
      } else {
        finish();
      }
    });
    return promise;
  }

  private writeCanonical(runtime: LaneRuntime, event: NormalizedLaneEvent): void {
    if (event.type === "task") {
      if (runtime.taskWritten) return;
      runtime.taskWritten = true;
    }
    if (!runtime.raw?.writable || runtime.rawCapped) return;
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (runtime.rawBytes + bytes > MAX_STREAM_BYTES) {
      runtime.rawCapped = true;
      return;
    }
    runtime.rawBytes += bytes;
    runtime.raw.write(line);
  }
}
