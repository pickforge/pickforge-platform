/** Pure delegation-ratio accounting, kept separate from extension wiring for testability. */

export interface DelegationCounts {
  /** Orchestrator tool executions, excluding lane dispatches. */
  direct: number;
  /** lanes_spawn calls. */
  dispatches: number;
  /** Total lanes spawned across all dispatches. */
  lanes: number;
}

export function emptyCounts(): DelegationCounts {
  return { direct: 0, dispatches: 0, lanes: 0 };
}

export function recordTool(counts: DelegationCounts, toolName: string, laneCount: number): DelegationCounts {
  if (toolName === "lanes_spawn") {
    return { ...counts, dispatches: counts.dispatches + 1, lanes: counts.lanes + Math.max(1, laneCount) };
  }
  return { ...counts, direct: counts.direct + 1 };
}

/** Share of tool work delegated to lanes, 0..1. */
export function delegationRatio(counts: DelegationCounts): number {
  const total = counts.direct + counts.lanes;
  if (total === 0) return 0;
  return counts.lanes / total;
}

export function summarize(counts: DelegationCounts): string {
  const pct = Math.round(delegationRatio(counts) * 100);
  return `delegation ${pct}% · ${counts.lanes} lane${counts.lanes === 1 ? "" : "s"} / ${counts.direct} direct`;
}
