import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  LaneCoordinator,
  type RunSnapshotDto,
} from "../src/lane-coordinator.ts";
import type { LaneSpec } from "../src/schema.ts";

export interface LaneMcpCoordinator {
  spawn(specs: LaneSpec[]): Promise<RunSnapshotDto>;
  status(lane?: string): RunSnapshotDto;
  wait(signal?: AbortSignal): Promise<RunSnapshotDto>;
  abandon(input: { lane?: string; reason?: string }): RunSnapshotDto;
  shutdown(reason: string): Promise<void>;
}

export interface CreateLaneMcpServerOptions {
  coordinator?: LaneMcpCoordinator;
}

const effortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modeSchema = z.enum(["read-only", "workspace-write"]);
const stateSchema = z.enum(["queued", "running", "done", "failed", "abandoned"]);
const runStateSchema = z.enum(["active", "ended"]);

const laneSnapshotSchema = z.object({
  lane: z.string(),
  model: z.string(),
  effort: effortSchema,
  mode: modeSchema,
  state: stateSchema,
  currentTool: z.string().optional(),
  lastStatus: z.string().optional(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cost: z.number(),
  context: z.number(),
  answer: z.string().optional(),
  durationMs: z.number().optional(),
  abandonReason: z.string().optional(),
});

const runSnapshotSchema = z.object({
  run: z.string(),
  state: runStateSchema,
  ok: z.boolean().optional(),
  totals: z.object({
    cost: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
  }),
  lanes: z.array(laneSnapshotSchema),
});

type WireRunSnapshot = z.infer<typeof runSnapshotSchema>;

const spawnLaneSchema = z.object({
  lane: z.string().trim().min(1).optional(),
  task: z.string().min(1),
  model: z.string().min(1),
  effort: effortSchema,
  mode: modeSchema,
  cwd: z.string().optional(),
  rationale: z.string().optional(),
});

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function wireSnapshot(snapshot: RunSnapshotDto): WireRunSnapshot {
  return {
    run: snapshot.run,
    state: snapshot.state,
    ...(snapshot.ok !== undefined ? { ok: snapshot.ok } : {}),
    totals: {
      cost: finite(snapshot.totals.cost),
      tokensIn: finite(snapshot.totals.tokensIn),
      tokensOut: finite(snapshot.totals.tokensOut),
    },
    lanes: snapshot.lanes.map((lane) => ({
      lane: lane.lane,
      model: lane.model,
      effort: lane.effort,
      mode: lane.mode,
      state: lane.state,
      ...(lane.currentTool !== undefined ? { currentTool: lane.currentTool } : {}),
      ...(lane.lastStatus !== undefined ? { lastStatus: lane.lastStatus } : {}),
      tokensIn: finite(lane.tokensIn),
      tokensOut: finite(lane.tokensOut),
      cost: finite(lane.cost),
      context: finite(lane.context),
      ...(lane.answer !== undefined ? { answer: lane.answer } : {}),
      ...(lane.durationMs !== undefined ? { durationMs: finite(lane.durationMs) } : {}),
      ...(lane.abandonReason !== undefined ? { abandonReason: lane.abandonReason } : {}),
    })),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

function failure(tool: string, error: unknown) {
  return {
    content: [{ type: "text" as const, text: `${tool} failed: ${errorMessage(error)}` }],
    isError: true,
  };
}

function success(snapshot: RunSnapshotDto) {
  const dto = wireSnapshot(snapshot);
  const text = `run ${dto.run} (${dto.state}) · ${dto.lanes.length} lane${dto.lanes.length === 1 ? "" : "s"} · $${dto.totals.cost.toFixed(4)}`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: dto,
  };
}

export function createLaneMcpServer(options: CreateLaneMcpServerOptions = {}) {
  const coordinator = options.coordinator ?? new LaneCoordinator({ origin: "mcp" });
  const server = new McpServer({ name: "pickforge-lanes", version: "0.1.0" });

  server.registerTool(
    "lanes_spawn",
    {
      description: "Spawn one cross-provider lane run without blocking.",
      inputSchema: z.object({ lanes: z.array(spawnLaneSchema).min(1) }),
      outputSchema: runSnapshotSchema,
    },
    async ({ lanes }) => {
      try {
        const specs: LaneSpec[] = lanes.map((lane, index) => ({
          lane: lane.lane || `lane-${index + 1}`,
          task: lane.task,
          model: lane.model,
          effort: lane.effort,
          mode: lane.mode,
          ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}),
          ...(lane.rationale !== undefined ? { rationale: lane.rationale } : {}),
        }));
        return success(await coordinator.spawn(specs));
      } catch (error) {
        return failure("lanes_spawn", error);
      }
    },
  );

  server.registerTool(
    "lanes_status",
    {
      description: "Return the current run or one named lane without blocking.",
      inputSchema: z.object({ lane: z.string().min(1).optional() }),
      outputSchema: runSnapshotSchema,
    },
    async ({ lane }) => {
      try {
        return success(coordinator.status(lane));
      } catch (error) {
        return failure("lanes_status", error);
      }
    },
  );

  server.registerTool(
    "lanes_wait",
    {
      description: "Wait for the current run; cancellation detaches only this wait.",
      inputSchema: z.object({}),
      outputSchema: runSnapshotSchema,
    },
    async (_input, extra) => {
      try {
        return success(await coordinator.wait(extra.signal));
      } catch (error) {
        return failure("lanes_wait", error);
      }
    },
  );

  server.registerTool(
    "lanes_abandon",
    {
      description: "Abandon one named lane or every active lane in the current run.",
      inputSchema: z.object({
        lane: z.string().min(1).optional(),
        reason: z.string().optional(),
      }),
      outputSchema: runSnapshotSchema,
    },
    async ({ lane, reason }) => {
      try {
        return success(coordinator.abandon({
          ...(lane !== undefined ? { lane } : {}),
          ...(reason !== undefined ? { reason } : {}),
        }));
      } catch (error) {
        return failure("lanes_abandon", error);
      }
    },
  );

  return { server, coordinator };
}
