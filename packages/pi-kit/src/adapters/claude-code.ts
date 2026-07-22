import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createChildEnvironment } from "../child-env.ts";
import type {
  LaneEventParser,
  LaneExecutionAdapter,
  LaneProcessPlan,
  NormalizedLaneEvent,
} from "../execution-adapter.ts";
import type { LaneSpec } from "../schema.ts";
import { findModel } from "../table.ts";

export const CLAUDE_CODE_MIN_VERSION = "2.1.216";

const WRAPPER_PREFIX_BYTES = 64 * 1024;
const VERSION_OUTPUT_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_LIMIT = 240;

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
const WORKSPACE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;

interface JsonRecord {
  [key: string]: unknown;
}

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  context: number;
}

interface PendingTool {
  id: unknown;
  name: string;
  input: unknown;
  partialJson: string;
}

export interface ClaudeCodeAdapterOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(record: JsonRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function readUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value, "input_tokens", "inputTokens", "input");
  const output = finiteNumber(value, "output_tokens", "outputTokens", "output");
  const cacheRead = finiteNumber(value, "cache_read_input_tokens", "cacheReadInputTokens", "cacheRead");
  const cacheCreation = finiteNumber(
    value,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cacheCreation",
  );
  if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) return undefined;
  const reportedContext = finiteNumber(value, "context_tokens", "contextTokens", "context");
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    context: reportedContext || input + output + cacheRead + cacheCreation,
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

function executableCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    return [isAbsolute(binary) ? binary : resolve(binary)];
  }
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, binary));
}

function wrapperHasPermissionBypass(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const bytes = Buffer.allocUnsafe(WRAPPER_PREFIX_BYTES);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const prefix = bytes.subarray(0, count).toString("utf8");
    if (!prefix.startsWith("#!")) return false;
    return (
      prefix.includes("--dangerously-skip-permissions") ||
      /--permission-mode(?:=|\s+)bypassPermissions/.test(prefix)
    );
  } catch {
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function versionOf(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolveVersion) => {
    const child = spawn(command, ["--version"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let outputBytes = 0;
    let invalid = false;
    let settled = false;

    const settle = (version: string | undefined) => {
      if (settled) return;
      settled = true;
      resolveVersion(version);
    };
    const kill = () => {
      invalid = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const capture = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > VERSION_OUTPUT_BYTES) {
        kill();
        return;
      }
      output += chunk.toString("utf8");
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(kill, VERSION_TIMEOUT_MS);
    timeout.unref();
    const reapOnExit = () => kill();
    process.once("exit", reapOnExit);
    child.once("error", () => {
      invalid = true;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      process.removeListener("exit", reapOnExit);
      settle(!invalid && code === 0 ? parseVersion(output) : undefined);
    });
  });
}

function boundedDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Malformed Claude stream JSON: ${detail}`.replace(/[\r\n\t]+/g, " ").slice(0, DIAGNOSTIC_LIMIT);
}

function isErrorResult(record: JsonRecord): boolean {
  return record.is_error === true || (typeof record.subtype === "string" && /^error(?:_|$)/.test(record.subtype));
}

function boundedResultError(record: JsonRecord): string {
  const subtype = typeof record.subtype === "string" ? record.subtype : "error";
  const detail = typeof record.result === "string" && record.result.trim() ? `: ${record.result}` : "";
  return `Claude Code ${subtype}${detail}`.replace(/[\r\n\t]+/g, " ").slice(0, DIAGNOSTIC_LIMIT);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  let text = "";
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") text += part.text;
    else if (typeof part.content === "string") text += part.content;
  }
  return text;
}

class ClaudeCodeStreamParser implements LaneEventParser {
  private readonly task: string;
  private readonly startedTools = new Set<string>();
  private readonly toolNames = new Map<string, string>();
  private readonly pendingTools = new Map<number, PendingTool>();
  private taskEmitted = false;
  private ended = false;
  private resultReceived = false;
  private currentText = "";
  private currentThinking = "";
  private lastAssistantText = "";
  private usage: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, context: 0 };
  private lastEmittedUsage = "";

  constructor(spec: LaneSpec) {
    this.task = spec.task;
  }

  feedLine(line: string): NormalizedLaneEvent[] {
    if (this.ended) return [];
    const events = this.emitTask();
    if (!line.trim()) return events;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      events.push({
        v: 1,
        type: "tool_end",
        tool: "claude-code-parser",
        text: boundedDiagnostic(error),
        isError: true,
      });
      return events;
    }
    if (isRecord(parsed)) events.push(...this.handleRecord(parsed));
    return events;
  }

  end(): NormalizedLaneEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const events = this.emitTask();
    if (!this.resultReceived && this.lastAssistantText) {
      events.push({ v: 1, type: "assistant_end", text: this.lastAssistantText });
    }
    return events;
  }

  private emitTask(): NormalizedLaneEvent[] {
    if (this.taskEmitted) return [];
    this.taskEmitted = true;
    return [{ v: 1, type: "task", text: this.task }];
  }

  private handleRecord(record: JsonRecord): NormalizedLaneEvent[] {
    if (record.type === "stream_event" && isRecord(record.event)) return this.handleStreamEvent(record.event);
    if (record.type === "assistant" && isRecord(record.message)) return this.handleAssistant(record.message);
    if (record.type === "user" && isRecord(record.message)) return this.handleUser(record.message);
    if (record.type === "result") return this.handleResult(record);
    return [];
  }

  private handleStreamEvent(event: JsonRecord): NormalizedLaneEvent[] {
    if (event.type === "message_start") {
      this.currentText = "";
      this.currentThinking = "";
      return [];
    }
    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "tool_use" && typeof block.name === "string" && typeof event.index === "number") {
        this.pendingTools.set(event.index, {
          id: block.id,
          name: block.name,
          input: block.input,
          partialJson: "",
        });
      }
      return [];
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const pending = this.pendingTools.get(event.index);
      if (!pending) return [];
      this.pendingTools.delete(event.index);
      let input = pending.input;
      if (pending.partialJson) {
        try {
          input = JSON.parse(pending.partialJson);
        } catch {
          input = pending.input;
        }
      }
      return this.startTool(pending.id, pending.name, input);
    }
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) return [];
    const delta = event.delta;
    if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string" &&
      typeof event.index === "number"
    ) {
      const pending = this.pendingTools.get(event.index);
      if (pending) pending.partialJson += delta.partial_json;
      return [];
    }
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      this.currentText += delta.text;
      this.lastAssistantText = this.currentText;
      return [{ v: 1, type: "text_delta", delta: delta.text }];
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      this.currentThinking += delta.thinking;
      return [{ v: 1, type: "thinking_delta", delta: delta.thinking }];
    }
    return [];
  }

  private handleAssistant(message: JsonRecord): NormalizedLaneEvent[] {
    const events: NormalizedLaneEvent[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part)) continue;
        if (part.type === "thinking" && typeof part.thinking === "string") {
          const delta = this.missingSuffix(part.thinking, this.currentThinking);
          if (delta) events.push({ v: 1, type: "thinking_delta", delta });
          this.currentThinking = part.thinking;
        } else if (part.type === "text" && typeof part.text === "string") {
          const delta = this.missingSuffix(part.text, this.currentText);
          if (delta) events.push({ v: 1, type: "text_delta", delta });
          this.currentText = part.text;
          this.lastAssistantText = part.text;
        } else if (part.type === "tool_use" && typeof part.name === "string") {
          events.push(...this.startTool(part.id, part.name, part.input));
        }
      }
    }
    const snapshot = readUsage(message.usage);
    if (snapshot) {
      this.usage = {
        input: this.usage.input + snapshot.input,
        output: this.usage.output + snapshot.output,
        cacheRead: this.usage.cacheRead + snapshot.cacheRead,
        cacheCreation: this.usage.cacheCreation + snapshot.cacheCreation,
        context: this.usage.context + snapshot.context,
      };
      events.push(...this.emitUsage(this.usage));
    }
    return events;
  }

  private handleUser(message: JsonRecord): NormalizedLaneEvent[] {
    if (!Array.isArray(message.content)) return [];
    const events: NormalizedLaneEvent[] = [];
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool_result") continue;
      const id = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
      events.push({
        v: 1,
        type: "tool_end",
        tool: this.toolNames.get(id) ?? (id || "unknown"),
        text: contentText(part.content),
        isError: part.is_error === true,
      });
    }
    return events;
  }

  private handleResult(record: JsonRecord): NormalizedLaneEvent[] {
    if (this.resultReceived) return [];
    this.resultReceived = true;
    const events: NormalizedLaneEvent[] = [];
    const snapshot = readUsage(record.usage);
    if (snapshot) {
      this.usage = snapshot;
      events.push(...this.emitUsage(snapshot));
    }
    if (isErrorResult(record)) {
      const text = boundedResultError(record);
      this.lastAssistantText = text;
      events.push({ v: 1, type: "assistant_end", text, isError: true });
      return events;
    }
    const text = typeof record.result === "string" ? record.result : this.lastAssistantText;
    this.lastAssistantText = text;
    events.push({ v: 1, type: "assistant_end", text });
    return events;
  }

  private startTool(idValue: unknown, name: string, input: unknown): NormalizedLaneEvent[] {
    const id = typeof idValue === "string" ? idValue : `${name}:${this.startedTools.size}`;
    this.toolNames.set(id, name);
    if (this.startedTools.has(id)) return [];
    this.startedTools.add(id);
    return [{ v: 1, type: "tool_start", tool: name, input: input ?? {} }];
  }

  private emitUsage(snapshot: UsageSnapshot): NormalizedLaneEvent[] {
    const key = `${snapshot.input}:${snapshot.output}:${snapshot.cacheRead}:${snapshot.context}`;
    if (key === this.lastEmittedUsage) return [];
    this.lastEmittedUsage = key;
    return [
      {
        v: 1,
        type: "usage",
        input: snapshot.input,
        output: snapshot.output,
        cacheRead: snapshot.cacheRead,
        context: snapshot.context,
      },
    ];
  }

  private missingSuffix(complete: string, partial: string): string {
    if (!partial) return complete;
    return complete.startsWith(partial) ? complete.slice(partial.length) : "";
  }
}

export class ClaudeCodeExecutionAdapter implements LaneExecutionAdapter {
  readonly route = "claude-code" as const;
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  private command?: string;
  private candidates?: string[];
  private preparation?: Promise<void>;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.env = createChildEnvironment(options.env ?? process.env);
  }

  preflight(spec: LaneSpec): void {
    const row = findModel(spec.model);
    if (!row || row.route !== this.route) throw new Error(`Model ${spec.model} is not routed through Claude Code`);
    if (!row.allowedEfforts.includes(spec.effort)) {
      throw new Error(`Claude Code model ${spec.model} has unsupported effort ${spec.effort}`);
    }
    if (this.command || this.candidates) return;

    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const candidate of executableCandidates(this.binary, this.env)) {
      try {
        accessSync(candidate, constants.X_OK);
        const resolved = realpathSync(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        if (!statSync(resolved).isFile()) continue;
        accessSync(resolved, constants.X_OK);
        if (!wrapperHasPermissionBypass(resolved)) candidates.push(resolved);
      } catch {
        // Try the next PATH candidate without exposing wrapper contents or environment values.
      }
    }
    if (candidates.length === 0) throw new Error("No safe Claude Code executable was found on PATH");
    this.candidates = candidates;
  }

  async prepare(spec: LaneSpec): Promise<void> {
    this.preflight(spec);
    if (this.command) return;
    this.preparation ??= this.prepareExecutable();
    await this.preparation;
  }

  private async prepareExecutable(): Promise<void> {
    let unsupportedVersion: string | undefined;
    for (const candidate of this.candidates ?? []) {
      const version = await versionOf(candidate, this.env);
      if (!version) continue;
      if (compareVersions(version, CLAUDE_CODE_MIN_VERSION) < 0) {
        unsupportedVersion = version;
        continue;
      }
      this.command = candidate;
      return;
    }
    if (unsupportedVersion) {
      throw new Error(
        `Claude Code ${unsupportedVersion} is unsupported; this adapter requires ${CLAUDE_CODE_MIN_VERSION} or newer`,
      );
    }
    throw new Error("No supported Claude Code executable was found on PATH");
  }

  build(spec: LaneSpec): LaneProcessPlan {
    this.preflight(spec);
    if (!this.command) throw new Error("Claude Code adapter preparation has not completed");
    const row = findModel(spec.model)!;
    const mode = spec.mode ?? "workspace-write";
    const args = [
      "-p",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      row.runtimeModel,
      "--effort",
      spec.effort,
    ];
    if (mode === "read-only") {
      args.push("--tools", READ_ONLY_TOOLS.join(","), "--allowedTools", ...READ_ONLY_TOOLS);
    } else if (mode === "workspace-write") {
      args.push("--tools", WORKSPACE_TOOLS.join(","), "--allowedTools", ...WORKSPACE_TOOLS);
    } else {
      throw new Error(`Unsupported Claude Code lane mode: ${String(mode)}`);
    }
    args.push("--", spec.task);
    return {
      command: this.command!,
      args,
      cwd: spec.cwd ?? process.cwd(),
      env: this.env,
    };
  }

  createParser(spec: LaneSpec): LaneEventParser {
    return new ClaudeCodeStreamParser(spec);
  }
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): ClaudeCodeExecutionAdapter {
  return new ClaudeCodeExecutionAdapter(options);
}
