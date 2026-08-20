import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parsePiJson, type PiResult } from "./pi-json.ts";
import { LIMITS } from "./protocol.ts";

export interface ExecutionOptions {
  terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  stdoutLimit: number;
  stderrLimit: number;
  timeoutMs: number;
}

export class RunnerExecution {
  readonly completion: Promise<void>;
  private readonly parser = parsePiJson();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutBytes = 0;
  private stderr = "";
  private terminalError?: Error;
  private settled = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private escalation?: ReturnType<typeof setTimeout>;
  private complete!: () => void;
  private resolve!: (result: PiResult) => void;
  private reject!: (error: Error) => void;
  readonly result: Promise<PiResult>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: ExecutionOptions,
    private readonly onDelta: (text: string) => void,
    private readonly onSettled: () => void,
  ) {
    this.completion = new Promise<void>((resolve) => { this.complete = resolve; });
    this.result = new Promise<PiResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.attach();
  }

  start(prompt: string): void {
    this.timeout = this.options.setTimeout(
      () => this.stop(`timed out after ${this.options.timeoutMs} milliseconds`),
      this.options.timeoutMs,
    );
    try {
      this.child.stdin.end(prompt);
    } catch (error) {
      this.stop("stdin write failed", new Error(
        `question stdin failed: ${error instanceof Error ? error.message : String(error)}; retry the question`,
      ));
    }
  }

  stop(reason: string, error = new Error(
    `question failed: ${reason}; expected the child to finish normally, then retry or choose another model`,
  )): void {
    if (this.terminalError || this.settled) return;
    this.terminalError = error;
    try { this.options.terminate(this.child, "SIGTERM"); } catch {}
    this.escalation = this.options.setTimeout(() => {
      try { this.options.terminate(this.child, "SIGKILL"); } catch {}
      this.fail(this.terminalError!);
    }, 5000);
  }

  private attach(): void {
    this.child.stdin.on("error", this.onStdinError);
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.once("error", this.onError);
    this.child.once("close", this.onClose);
  }

  private readonly onStdinError = (error: Error): void => {
    this.stop("stdin write failed", new Error(`question stdin failed: ${error.message}; retry the question`));
  };

  private readonly onStdout = (chunk: Buffer): void => {
    if (this.settled) return;
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.options.stdoutLimit) {
      this.stop("stdout limit exceeded", new Error(
        `child stdout failed: expected at most ${this.options.stdoutLimit} bytes, received ${this.stdoutBytes}; ask a narrower question and retry`,
      ));
      return;
    }
    try { this.consume(this.stdoutDecoder.write(chunk)); } catch (error) {
      this.stop("Pi output handling failed", error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly onStderr = (chunk: Buffer): void => {
    if (this.settled) return;
    this.stderr += this.stderrDecoder.write(chunk);
    const bytes = Buffer.byteLength(this.stderr);
    if (bytes <= this.options.stderrLimit) return;
    this.stderr = Buffer.from(this.stderr).subarray(-this.options.stderrLimit).toString("utf8");
    this.stop("stderr limit exceeded", new Error(
      `child stderr failed: expected at most ${this.options.stderrLimit} bytes, received ${bytes}; inspect the model command and retry`,
    ));
  };

  private readonly onError = (error: Error): void => {
    this.fail(new Error(`question child spawn failed: ${error.message}; verify Pi is installed and retry`));
  };

  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.settled) return;
    try {
      this.consume(this.stdoutDecoder.end());
      this.stderr += this.stderrDecoder.end();
      if (this.terminalError) return this.fail(this.terminalError);
      if (code !== 0) return this.fail(new Error(
        `question child failed: expected exit code 0, received ${String(code)}${signal ? ` (${signal})` : ""}; stderr tail: ${this.stderr.slice(-LIMITS.stderr)}; check Pi model access and retry`,
      ));
      const result = this.parser.finish();
      if (this.cleanup()) this.resolve(result);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private consume(text: string): void {
    for (const event of this.parser.push(text)) this.onDelta(event.text);
  }

  private fail(error: Error): void {
    if (this.cleanup()) this.reject(error);
  }

  private cleanup(): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (this.timeout) this.options.clearTimeout(this.timeout);
    if (this.escalation) this.options.clearTimeout(this.escalation);
    this.child.stdin.off("error", this.onStdinError);
    this.child.stdout.off("data", this.onStdout);
    this.child.stderr.off("data", this.onStderr);
    this.child.off("error", this.onError);
    this.child.off("close", this.onClose);
    this.onSettled();
    this.complete();
    return true;
  }
}
