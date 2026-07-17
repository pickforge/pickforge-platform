import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { KitEvent, LaneProjection, LaneSpec, RunProjection } from "./schema.ts";
import { estimateCost, validateLaneSpec } from "./table.ts";

export interface RunnerOptions {
  runId: string;
  append: (ev: KitEvent) => void;
  maxConcurrent?: number;
  piBinary?: string;
  onUpdate?: () => void;
}

interface LaneRuntime {
  child: ChildProcessByStdio<null, Readable, Readable>;
  finish: () => void;
  settled: boolean;
  startedAt: number;
  stdoutBuffer: string;
  stderrTail: string;
  answer: string;
  statusTail: string;
  statusTimer?: NodeJS.Timeout;
  lastStatusAt: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

type JsonRecord = Record<string, unknown>;

const MAX_STDOUT_BUFFER = 4 * 1024 * 1024;

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

function usageNumber(usage: JsonRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function messageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  let text = "";
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text || undefined;
}

function toolSummary(tool: string, args: unknown): string {
  let summary: string | undefined;
  if (isRecord(args)) {
    if (tool === "bash" && typeof args.command === "string") summary = args.command;
    if (["read", "write", "edit"].includes(tool) && typeof args.path === "string") summary = args.path;
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

export class LaneRunner {
  private readonly append: (ev: KitEvent) => void;
  private readonly maxConcurrent: number;
  private readonly onUpdate?: () => void;
  private readonly piBinary: string;
  private readonly runId: string;
  private readonly runtimes = new Map<string, LaneRuntime>();
  private readonly live: RunProjection;
  private dispatching = false;

  constructor(opts: RunnerOptions) {
    this.runId = opts.runId;
    this.append = opts.append;
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 4));
    this.piBinary = opts.piBinary ?? "pi";
    this.onUpdate = opts.onUpdate;
    this.live = {
      run: opts.runId,
      origin: "runner",
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

  async dispatch(specs: LaneSpec[]): Promise<LaneProjection[]> {
    if (this.dispatching) throw new Error("LaneRunner.dispatch may only be called once");

    const violations: string[] = [];
    const seen = new Set<string>();
    specs.forEach((spec, index) => {
      const reason = validateLaneSpec(spec);
      if (reason) violations.push(`${spec.lane || `lane-${index + 1}`}: ${reason}`);
      if (spec.lane) {
        if (seen.has(spec.lane)) violations.push(`${spec.lane}: duplicate lane id`);
        seen.add(spec.lane);
      }
    });
    if (violations.length > 0) throw new Error(`Invalid lane specs:\n${violations.join("\n")}`);

    this.dispatching = true;
    installExitHook();
    ACTIVE_RUNNERS.add(this);
    for (const spec of specs) {
      this.record({ v: 1, t: new Date().toISOString(), run: this.runId, lane: spec.lane, type: "lane_created", spec });
    }

    let next = 0;
    const workers = Array.from({ length: Math.min(this.maxConcurrent, specs.length) }, async () => {
      while (next < specs.length) {
        const spec = specs[next++];
        if (spec && this.live.lanes.get(spec.lane)?.state === "queued") await this.runLane(spec);
      }
    });
    await Promise.all(workers);
    ACTIVE_RUNNERS.delete(this);

    this.live.ended = true;
    this.live.ok = [...this.live.lanes.values()].every((lane) => lane.state === "done");
    this.onUpdate?.();
    return [...this.live.lanes.values()];
  }

  abandon(lane: string, reason: string): void {
    const projection = this.live.lanes.get(lane);
    if (!projection || ["done", "failed", "abandoned"].includes(projection.state)) return;

    const runtime = this.runtimes.get(lane);
    if (runtime) {
      runtime.settled = true;
      clearTimeout(runtime.statusTimer);
      this.terminate(runtime);
    }

    this.record({ v: 1, t: new Date().toISOString(), run: this.runId, lane, type: "lane_abandoned", reason });
    if (runtime) {
      this.runtimes.delete(lane);
      runtime.finish();
    }
  }

  /** Abandon every non-terminal lane (abort signal, shutdown). */
  abandonAll(reason: string): void {
    for (const [lane, projection] of this.live.lanes) {
      if (!["done", "failed", "abandoned"].includes(projection.state)) this.abandon(lane, reason);
    }
  }

  /** Synchronous last-resort kill of every live child. Called from the process exit hook. */
  reapAll(): void {
    for (const runtime of this.runtimes.values()) killTree(runtime.child, "SIGKILL");
  }

  /** SIGTERM the child's process group now, escalate to SIGKILL after 5s. */
  private terminate(runtime: LaneRuntime): void {
    killTree(runtime.child, "SIGTERM");
    const killTimer = setTimeout(() => killTree(runtime.child, "SIGKILL"), 5_000);
    killTimer.unref();
    runtime.child.once("close", () => clearTimeout(killTimer));
  }

  private record(event: KitEvent): void {
    this.append(event);
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
            break;
        }
      }
    }
    this.onUpdate?.();
  }

  private runLane(spec: LaneSpec): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
      const slash = spec.model.indexOf("/");
      const provider = spec.model.slice(0, slash);
      const modelId = spec.model.slice(slash + 1);
      const child = spawn(
        this.piBinary,
        [
          "--mode",
          "json",
          "--no-extensions",
          "--no-session",
          "-p",
          "--provider",
          provider,
          "--model",
          modelId,
          "--thinking",
          spec.effort,
          spec.task,
        ],
        {
          cwd: spec.cwd ?? process.cwd(),
          env: { ...process.env, PIKIT_CHILD: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );

      const runtime: LaneRuntime = {
        child,
        finish: resolve,
        settled: false,
        startedAt: Date.now(),
        stdoutBuffer: "",
        stderrTail: "",
        answer: "",
        statusTail: "",
        lastStatusAt: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      this.runtimes.set(spec.lane, runtime);

      const finish = (ok: boolean, answer: string, stopReason?: string) => {
        if (runtime.settled) return;
        runtime.settled = true;
        clearTimeout(runtime.statusTimer);
        this.runtimes.delete(spec.lane);
        this.terminate(runtime);
        this.record({
          v: 1,
          t: new Date().toISOString(),
          run: this.runId,
          lane: spec.lane,
          type: "lane_end",
          ok,
          ...(stopReason ? { stopReason } : {}),
          answer: answer.slice(0, 4_000),
          durationMs: Date.now() - runtime.startedAt,
        });
        resolve();
      };

      const emitStatus = () => {
        runtime.statusTimer = undefined;
        if (runtime.settled || !runtime.statusTail) return;
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

      const handleEvent = (event: unknown) => {
        if (runtime.settled || !isRecord(event) || typeof event.type !== "string") return;
        if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
          this.record({
            v: 1,
            t: new Date().toISOString(),
            run: this.runId,
            lane: spec.lane,
            type: "lane_tool",
            tool: event.toolName,
            summary: toolSummary(event.toolName, event.args),
          });
          return;
        }
        if (event.type === "message_start" && isRecord(event.message) && event.message.role === "assistant") {
          runtime.answer = "";
          runtime.statusTail = "";
          return;
        }
        if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta" && typeof update.delta === "string") {
            if (runtime.answer.length < 4_000) runtime.answer += update.delta.slice(0, 4_000 - runtime.answer.length);
            runtime.statusTail = `${runtime.statusTail}${update.delta}`.replace(/\s+/g, " ").trim().slice(-120);
            const elapsed = Date.now() - runtime.lastStatusAt;
            if (elapsed >= 1_000) emitStatus();
            else if (!runtime.statusTimer) {
              runtime.statusTimer = setTimeout(emitStatus, 1_000 - elapsed);
              runtime.statusTimer.unref();
            }
          }
          return;
        }
        if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
          const completeText = messageText(event.message);
          if (completeText !== undefined) runtime.answer = completeText.slice(0, 4_000);
          if (isRecord(event.message.usage)) {
            const usage = event.message.usage;
            runtime.tokensIn += usageNumber(usage, "input", "inputTokens", "input_tokens");
            runtime.tokensOut += usageNumber(usage, "output", "outputTokens", "output_tokens");
            runtime.cacheRead += usageNumber(usage, "cacheRead", "cacheReadTokens", "cache_read");
            runtime.cacheWrite += usageNumber(usage, "cacheWrite", "cacheWriteTokens", "cache_write");
            const reportedTotal = usageNumber(usage, "totalTokens", "total_tokens", "total", "contextTokens");
            this.record({
              v: 1,
              t: new Date().toISOString(),
              run: this.runId,
              lane: spec.lane,
              type: "lane_usage",
              input: runtime.tokensIn,
              output: runtime.tokensOut,
              cacheRead: runtime.cacheRead,
              cost: estimateCost(spec.model, runtime.tokensIn, runtime.tokensOut),
              context: reportedTotal || runtime.tokensIn + runtime.tokensOut,
            });
          }
          return;
        }
        if (event.type === "agent_end") {
          if (Array.isArray(event.messages)) {
            for (let index = event.messages.length - 1; index >= 0; index--) {
              const text = messageText(event.messages[index]);
              if (text !== undefined) {
                runtime.answer = text.slice(0, 4_000);
                break;
              }
            }
          }
          finish(true, runtime.answer);
        }
      };

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Ignore malformed child output; process exit still yields a terminal lane event.
        }
      };

      child.once("spawn", () => {
        if (!runtime.settled) {
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
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (runtime.stdoutBuffer.length + chunk.length > MAX_STDOUT_BUFFER) {
          finish(false, runtime.answer, "stdout-overflow");
          return;
        }
        runtime.stdoutBuffer += chunk;
        const lines = runtime.stdoutBuffer.split("\n");
        runtime.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        runtime.stderrTail = `${runtime.stderrTail}${chunk}`.slice(-500);
      });
      child.once("error", (error) => finish(false, runtime.stderrTail || error.message, `spawn:${error.message}`));
      child.once("close", (code) => {
        if (runtime.stdoutBuffer) consumeLine(runtime.stdoutBuffer);
        if (!runtime.settled) finish(false, runtime.stderrTail, `exit:${code ?? "signal"}`);
      });
    return promise;
  }
}
