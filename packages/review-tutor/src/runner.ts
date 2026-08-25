import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { redact } from "./connectors/redact.ts";
import type { HarnessConnector, ParsedAnswer } from "./connectors/types.ts";
import { LIMITS } from "./protocol.ts";
import { RunnerExecution } from "./runner-execution.ts";

const KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES",
  "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION",
  "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE", "TERM", "COLORTERM",
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
] as const;

export function createChildEnvironment(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...KEYS, ...extraKeys]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.REVIEW_TUTOR_CHILD = "1";
  return env;
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

type Terminate = (
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) => void;

export function platformTerminate(
  platform: NodeJS.Platform,
  kill: typeof process.kill = process.kill,
): Terminate {
  return (child, signal) => {
    if (!child.pid) return;
    if (platform === "win32") child.kill(signal);
    else kill(-child.pid, signal);
  };
}

interface RunnerOptions {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  terminate?: Terminate;
  platform?: NodeJS.Platform;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  stdoutLimit?: number;
  stderrLimit?: number;
  timeoutMs?: number;
}

export interface RunRequest {
  connector: HarnessConnector;
  model: string;
  thinking: string;
  cwd: string;
  prompt: string;
}

function safeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redact(message));
}

export class TutorRunner {
  private child?: ChildProcessWithoutNullStreams;
  private execution?: RunnerExecution;
  private readonly options: Required<Omit<RunnerOptions, "terminate">> & {
    terminate: Terminate;
  };

  constructor(options: RunnerOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.options = {
      spawn: options.spawn ?? (nodeSpawn as Spawn),
      env: options.env ?? process.env,
      terminate: options.terminate ?? platformTerminate(platform),
      platform,
      setTimeout: options.setTimeout ?? setTimeout,
      clearTimeout: options.clearTimeout ?? clearTimeout,
      stdoutLimit: options.stdoutLimit ?? LIMITS.stdout,
      stderrLimit: options.stderrLimit ?? LIMITS.stderr,
      timeoutMs: options.timeoutMs ?? LIMITS.timeoutMs,
    };
  }

  async run(request: RunRequest, onDelta: (text: string) => void): Promise<ParsedAnswer> {
    if (this.child) {
      throw new Error(
        "question runner failed: expected no running child, but one is active; wait or cancel it before retrying",
      );
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(request);
    } catch (error) {
      throw safeError(error);
    }
    this.child = child;
    const execution = new RunnerExecution(child, request.connector, this.options, onDelta, () => {
      if (this.child === child) this.child = undefined;
      if (this.execution === execution) this.execution = undefined;
    });
    this.execution = execution;
    execution.start(request.prompt);
    try {
      return await execution.result;
    } catch (error) {
      throw safeError(error);
    } finally {
      if (this.child === child) this.child = undefined;
      if (this.execution === execution) this.execution = undefined;
    }
  }

  private spawn(request: RunRequest): ChildProcessWithoutNullStreams {
    const spec = request.connector.spawnSpec(request);
    try {
      return this.options.spawn(spec.command, spec.args, {
        cwd: request.cwd,
        detached: this.options.platform !== "win32",
        env: createChildEnvironment(this.options.env, request.connector.envKeys),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        `question child spawn failed: ${error instanceof Error ? error.message : String(error)}; verify ${request.connector.label} is installed and retry`,
      );
    }
  }

  cancel(reason = "cancelled by user"): void {
    this.execution?.stop(reason);
  }

  async shutdown(): Promise<void> {
    if (!this.child || !this.execution) return;
    const execution = this.execution;
    execution.stop("server shutdown");
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        execution.completion,
        new Promise<void>((resolve) => {
          fallback = this.options.setTimeout(resolve, 5500);
        }),
      ]);
    } finally {
      if (fallback !== undefined) this.options.clearTimeout(fallback);
    }
  }
}
