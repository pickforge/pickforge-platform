import type { ExecFile } from "./inputs.ts";
import { NEIGHBOUR_LIMITS, type InputSnapshot, type StructureOmission } from "./protocol.ts";

/**
 * Bounded, read-only neighbour reader. Every byte comes from the Git object
 * store through argv-only `git cat-file`; the working tree is never read, so no
 * symlink can be followed and no path outside the repository can be reached.
 */
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^{}@+-]{0,255}$/;
const UNSAFE_PATH = /(?:^|[/])[.][.](?:[/]|$)|^[/]|:|[\u0000-\u001F]/;

export interface NeighbourSource { prefix: string; reason?: string }
export interface NeighbourUnavailable { unavailable: string }

function revisionOf(value: string): string | undefined {
  return !value.startsWith("-") && REVISION.test(value) ? value : undefined;
}

/** The Git object prefix whose content matches the `to` side of this comparison. */
export function neighbourSourceFor(input: InputSnapshot): NeighbourSource | NeighbourUnavailable {
  if (input.kind === "paste") {
    return { unavailable: "pasted code has no Git provenance, so neighbour files cannot be read" };
  }
  if (input.kind === "pr") {
    return { unavailable: "pull-request patch: base and head objects are not read locally, so neighbour files cannot be read" };
  }
  if (input.kind === "worktree") return { prefix: ":", reason: "neighbour content read from the index" };
  if (input.kind === "staged") return { prefix: ":" };
  const raw = input.kind === "commit" ? input.revision : input.rangeTo;
  const revision = raw === undefined ? undefined : revisionOf(raw);
  if (!revision) {
    return { unavailable: "neighbour revision missing: expected the snapshot to carry its Git revision, received none; reload the source and retry" };
  }
  return { prefix: `${revision}:` };
}

export interface NeighbourReaderOptions {
  execFile: ExecFile;
  cwd: string;
  prefix: string;
  now?: () => number;
  signal?: AbortSignal;
  /** Injectable wall-clock deadline; defaults to `AbortSignal.timeout(timeoutMs)`. */
  deadline?: AbortSignal;
}

const CAP_REASONS = {
  count: `neighbour cap reached: expected at most ${NEIGHBOUR_LIMITS.maxFiles} neighbour files, received more; later neighbours are not read`,
  bytes: `neighbour byte cap reached: expected at most ${NEIGHBOUR_LIMITS.maxTotalBytes} neighbour bytes, received more; later neighbours are not read`,
  time: `neighbour time cap reached: expected at most ${NEIGHBOUR_LIMITS.timeoutMs} ms of neighbour reads, received more; later neighbours are not read`,
  probes: `neighbour lookup cap reached: expected at most ${NEIGHBOUR_LIMITS.maxProbes} Git lookups, received more; later neighbours are not read`,
} as const;

export class NeighbourReader {
  readonly omissions: StructureOmission[] = [];
  truncated = false;
  private files = 0;
  private bytes = 0;
  private probes = 0;
  private exhausted = false;
  private readonly now: () => number;
  private readonly started: number;
  private readonly deadline: AbortSignal;
  private readonly signal: AbortSignal;

  constructor(private readonly options: NeighbourReaderOptions) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.deadline = options.deadline ?? AbortSignal.timeout(NEIGHBOUR_LIMITS.timeoutMs);
    this.signal = options.signal ? AbortSignal.any([options.signal, this.deadline]) : this.deadline;
  }

  get count(): number { return this.files; }

  private note(omission: StructureOmission): void {
    if (this.omissions.some((existing) => existing.path === omission.path && existing.reason === omission.reason)) return;
    this.omissions.push(omission);
  }

  private stop(reason: string): void {
    this.exhausted = true;
    this.truncated = true;
    this.note({ reason });
  }

  /**
   * A caller that abandoned the request is not a resource cap: stop every further
   * lookup and say so, rather than spending the probe budget on doomed calls and
   * blaming the cap for the missing neighbours.
   */
  private cancelled(): boolean {
    if (this.deadline.aborted || !this.signal.aborted) return false;
    this.exhausted = true;
    this.note({ reason: "neighbour reads stopped: request aborted" });
    return true;
  }

  /** True while another bounded Git lookup is allowed. */
  private ready(): boolean {
    if (this.exhausted) return false;
    if (this.deadline.aborted) { this.stop(CAP_REASONS.time); return false; }
    if (this.cancelled()) return false;
    if (this.now() - this.started > NEIGHBOUR_LIMITS.timeoutMs) { this.stop(CAP_REASONS.time); return false; }
    if (this.probes >= NEIGHBOUR_LIMITS.maxProbes) { this.stop(CAP_REASONS.probes); return false; }
    return true;
  }

  private safe(path: string): boolean {
    if (path && path.length <= 1024 && !path.startsWith("-") && !UNSAFE_PATH.test(path)) return true;
    this.note({
      path,
      reason: `neighbour path rejected: expected a repo-relative path without '..' or ':', received '${path}'; no import data for that neighbour`,
    });
    return false;
  }

  private async git(args: string[], maxBuffer: number): Promise<string | undefined> {
    this.probes += 1;
    try {
      const result = await this.options.execFile("git", args, {
        cwd: this.options.cwd,
        maxBuffer,
        encoding: "utf8",
        signal: this.signal,
      });
      return result.stdout;
    } catch {
      if (this.deadline.aborted) this.stop(CAP_REASONS.time);
      else this.cancelled();
      return undefined;
    }
  }

  private async sizeOf(path: string): Promise<number | undefined> {
    const stdout = await this.git(["cat-file", "-s", `${this.options.prefix}${path}`], 64);
    if (stdout === undefined) return undefined;
    const digits = stdout.trim();
    return /^[0-9]{1,15}$/.test(digits) ? Number(digits) : undefined;
  }

  /** Reads one blob, charging it against the file, byte, and time budgets. */
  private async take(path: string, size: number, countFile: boolean, silent = false): Promise<string | undefined> {
    if (size > NEIGHBOUR_LIMITS.maxFileBytes) {
      this.truncated = true;
      this.note({
        path,
        reason: `neighbour file too large: expected at most ${NEIGHBOUR_LIMITS.maxFileBytes} bytes, received ${size}; no import data for that neighbour`,
      });
      return undefined;
    }
    if (this.bytes + size > NEIGHBOUR_LIMITS.maxTotalBytes) { this.stop(CAP_REASONS.bytes); return undefined; }
    if (!this.ready()) return undefined;
    const content = await this.git(["cat-file", "blob", `${this.options.prefix}${path}`], NEIGHBOUR_LIMITS.maxFileBytes + 4096);
    if (content === undefined) {
      if (!silent) this.note({ path, reason: "neighbour read failed: expected a readable Git blob, received none; no import data for that neighbour" });
      return undefined;
    }
    this.bytes += size;
    if (countFile) this.files += 1;
    return content;
  }

  /** The first candidate that exists in the Git object store, with its content. */
  async find(paths: string[]): Promise<{ path: string; content: string } | undefined> {
    if (this.exhausted || this.cancelled()) return undefined;
    if (this.files >= NEIGHBOUR_LIMITS.maxFiles) { this.stop(CAP_REASONS.count); return undefined; }
    for (const path of paths) {
      if (!this.ready()) return undefined;
      if (!this.safe(path)) continue;
      const size = await this.sizeOf(path);
      if (size === undefined) continue;
      const content = await this.take(path, size, true);
      return content === undefined ? undefined : { path, content };
    }
    return undefined;
  }

  /** Reads a bounded support file (a pubspec) without spending a neighbour slot. */
  async support(path: string): Promise<string | undefined> {
    if (!this.ready() || !this.safe(path)) return undefined;
    const size = await this.sizeOf(path);
    if (size === undefined) return undefined;
    return this.take(path, size, false, true);
  }
}
