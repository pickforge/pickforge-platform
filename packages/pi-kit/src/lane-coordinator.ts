import { appendEvent, newRunId as createDefaultRunId, rawRunDir } from "./journal-core.ts";
import { LaneRunner, type RunnerOptions } from "./runner.ts";
import type {
  KitEvent,
  Effort,
  LaneMode,
  LaneOrigin,
  LaneProjection,
  LaneSpec,
  LaneState,
  RunProjection,
} from "./schema.ts";
import { normalizeLaneSpec, validateLaneSpec } from "./table.ts";

export interface LaneRunnerPort {
  projection(): RunProjection;
  dispatch(specs: LaneSpec[]): Promise<LaneProjection[]>;
  abandon(lane: string, reason: string): void;
  abandonAll(reason: string): void;
  shutdown(reason: string): Promise<void>;
}

export interface LaneCoordinatorJournal {
  append(event: KitEvent): void;
  rawDir(runId: string): string;
}

export interface LaneCoordinatorOptions {
  origin: LaneOrigin;
  createRunner?: (options: RunnerOptions) => LaneRunnerPort;
  journal?: LaneCoordinatorJournal;
  clock?: () => Date;
  newRunId?: () => string;
}

export interface LaneSnapshotDto {
  lane: string;
  model: string;
  effort: Effort;
  mode: LaneMode;
  state: LaneState;
  currentTool?: string;
  lastStatus?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  context: number;
  answer?: string;
  durationMs?: number;
  abandonReason?: string;
}

export interface RunSnapshotDto {
  run: string;
  state: "active" | "ended";
  ok?: boolean;
  durationMs: number;
  totals: {
    cost: number;
    tokensIn: number;
    tokensOut: number;
  };
  lanes: LaneSnapshotDto[];
}

interface CoordinatedRun {
  id: string;
  createdAt: string;
  startedAt: number;
  runner: LaneRunnerPort;
  ended: boolean;
  ok?: boolean;
  durationMs?: number;
  settled: Promise<void>;
}

const DEFAULT_JOURNAL: LaneCoordinatorJournal = {
  append: appendEvent,
  rawDir: rawRunDir,
};

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function snapshotLane(lane: LaneProjection, nowMs: number): LaneSnapshotDto {
  const durationMs = lane.durationMs ??
    (lane.state === "running" && lane.startedAtMs !== undefined
      ? Math.max(0, nowMs - lane.startedAtMs)
      : undefined);
  return {
    lane: lane.spec.lane,
    model: lane.spec.model,
    effort: lane.spec.effort,
    mode: lane.spec.mode ?? "workspace-write",
    state: lane.state,
    ...(lane.currentTool !== undefined ? { currentTool: lane.currentTool } : {}),
    ...(lane.lastStatus !== undefined ? { lastStatus: lane.lastStatus } : {}),
    tokensIn: finite(lane.tokensIn),
    tokensOut: finite(lane.tokensOut),
    cost: finite(lane.cost),
    context: finite(lane.context),
    ...(lane.answer !== undefined ? { answer: lane.answer } : {}),
    ...(durationMs !== undefined ? { durationMs: finite(durationMs) } : {}),
    ...(lane.abandonReason !== undefined ? { abandonReason: lane.abandonReason } : {}),
  };
}

export class LaneCoordinator {
  readonly origin: LaneOrigin;
  private readonly createRunner: (options: RunnerOptions) => LaneRunnerPort;
  private readonly journal: LaneCoordinatorJournal;
  private readonly clock: () => Date;
  private readonly createRunId: () => string;
  private current?: CoordinatedRun;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: LaneCoordinatorOptions) {
    this.origin = options.origin;
    this.createRunner = options.createRunner ?? ((runnerOptions) => new LaneRunner(runnerOptions));
    this.journal = options.journal ?? DEFAULT_JOURNAL;
    this.clock = options.clock ?? (() => new Date());
    this.createRunId = options.newRunId ?? createDefaultRunId;
  }

  async spawn(specs: LaneSpec[]): Promise<RunSnapshotDto> {
    if (this.closed) throw new Error("Lane coordinator is shut down");
    if (this.current && !this.current.ended) {
      throw new Error(`Run ${this.current.id} is still active`);
    }
    const normalized = this.validateAndNormalize(specs);
    const id = this.createRunId();
    const created = this.clock();
    const createdAt = created.toISOString();
    const runner = this.createRunner({
      runId: id,
      origin: this.origin,
      append: (event) => this.journal.append(event),
      rawDir: this.journal.rawDir(id),
    });
    const run: CoordinatedRun = {
      id,
      createdAt,
      startedAt: created.getTime(),
      runner,
      ended: false,
      settled: Promise.resolve(),
    };
    this.current = run;
    this.appendLifecycleEvent({
      v: 1,
      t: createdAt,
      run: id,
      type: "run_created",
      lanes: normalized.length,
      origin: this.origin,
    });

    const dispatch = runner.dispatch(normalized);
    run.settled = dispatch.then(
      (lanes) => {
        this.finish(run, lanes.every((lane) => lane.state === "done"));
      },
      async () => {
        await runner.shutdown("lane run failed");
        this.finish(run, false);
      },
    );
    return this.snapshot(run);
  }

  status(lane?: string): RunSnapshotDto {
    const run = this.requireRun();
    return this.snapshot(run, lane);
  }

  async wait(signal?: AbortSignal): Promise<RunSnapshotDto> {
    const run = this.requireRun();
    if (!run.ended) {
      if (!signal) {
        await run.settled;
      } else if (!signal.aborted) {
        const detached = Promise.withResolvers<void>();
        const onAbort = () => detached.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([run.settled, detached.promise]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }
    return this.snapshot(run);
  }

  abandon(input: { lane?: string; reason?: string }): RunSnapshotDto {
    const run = this.requireRun();
    const reason = input.reason?.trim() || "abandoned";
    if (input.lane !== undefined) {
      if (!run.runner.projection().lanes.has(input.lane)) {
        throw new Error(`Unknown lane "${input.lane}"`);
      }
      run.runner.abandon(input.lane, reason);
    } else {
      run.runner.abandonAll(reason);
    }
    return this.snapshot(run);
  }

  shutdown(reason: string): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.shutdownPromise = this.finishShutdown(reason);
    }
    return this.shutdownPromise;
  }

  private validateAndNormalize(specs: LaneSpec[]): LaneSpec[] {
    if (specs.length === 0) throw new Error("At least one lane is required");
    const violations: string[] = [];
    const seen = new Set<string>();
    const normalized: LaneSpec[] = [];
    specs.forEach((spec, index) => {
      const label = spec.lane || `lane-${index + 1}`;
      const reason = validateLaneSpec(spec, { origin: this.origin });
      if (reason) violations.push(`${label}: ${reason}`);
      if (spec.lane) {
        if (seen.has(spec.lane)) violations.push(`${spec.lane}: duplicate lane id`);
        seen.add(spec.lane);
      }
      if (!reason) normalized.push(normalizeLaneSpec(spec, { origin: this.origin }));
    });
    if (violations.length > 0) throw new Error(`Invalid lane specs:\n${violations.join("\n")}`);
    return normalized;
  }

  private requireRun(): CoordinatedRun {
    if (!this.current) throw new Error("No lane run is available");
    return this.current;
  }

  private snapshot(run: CoordinatedRun, laneName?: string): RunSnapshotDto {
    const projection = run.runner.projection();
    let lanes: LaneProjection[];
    if (laneName === undefined) {
      lanes = [...projection.lanes.values()];
    } else {
      const lane = projection.lanes.get(laneName);
      if (!lane) throw new Error(`Unknown lane "${laneName}"`);
      lanes = [lane];
    }
    const nowMs = this.clock().getTime();
    return {
      run: run.id,
      state: run.ended ? "ended" : "active",
      ...(run.ended ? { ok: run.ok ?? false } : {}),
      durationMs: run.durationMs ?? Math.max(0, nowMs - run.startedAt),
      totals: {
        cost: finite(projection.totalCost),
        tokensIn: finite(projection.totalTokensIn),
        tokensOut: finite(projection.totalTokensOut),
      },
      lanes: lanes.map((lane) => snapshotLane(lane, nowMs)),
    };
  }

  private appendLifecycleEvent(event: KitEvent): void {
    try {
      this.journal.append(event);
    } catch {}
  }

  private finish(run: CoordinatedRun, ok: boolean): void {
    if (run.ended) return;
    run.ended = true;
    run.ok = ok;
    const endedAt = this.clock();
    const elapsed = endedAt.getTime() - run.startedAt;
    run.durationMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    this.appendLifecycleEvent({
      v: 1,
      t: endedAt.toISOString(),
      run: run.id,
      type: "run_end",
      ok,
      durationMs: run.durationMs,
    });
  }

  private async finishShutdown(reason: string): Promise<void> {
    const run = this.current;
    if (!run || run.ended) return;
    await run.runner.shutdown(reason);
    await run.settled;
  }
}
