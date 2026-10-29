import { BoundedKeyMap } from "@commonfabric/utils/cache";
import type { ActionReadStats, ActionStats } from "../telemetry.ts";
import type { Action } from "./types.ts";

export interface ActionTimingState {
  readonly actionStats: BoundedKeyMap<string, ActionStats>;
  readonly getActionId: (action: Action) => string;
}

export function recordActionTime(
  state: ActionTimingState,
  action: Action,
  elapsed: number,
  now = performance.now(),
  reads?: ActionReadStats,
): void {
  const actionId = state.getActionId(action);
  const existing = state.actionStats.get(actionId);
  if (existing) {
    existing.lastRunReads = reads;
    if (reads) {
      const total = existing.reads;
      existing.reads = total
        ? {
          proxyAccesses: total.proxyAccesses + reads.proxyAccesses,
          linkResolutions: total.linkResolutions + reads.linkResolutions,
          distinctDocuments: total.distinctDocuments + reads.distinctDocuments,
          registeredDependencies: total.registeredDependencies +
            reads.registeredDependencies,
        }
        : { ...reads };
    }
    existing.runCount++;
    existing.totalTime += elapsed;
    existing.averageTime = existing.totalTime / existing.runCount;
    existing.lastRunTime = elapsed;
    existing.lastRunTimestamp = now;
    // Setting it again moves it to the young end, so the map ages entries by
    // when their action last ran.
    state.actionStats.set(actionId, existing);
    return;
  }
  state.actionStats.set(actionId, {
    ...(reads ? { reads: { ...reads }, lastRunReads: reads } : {}),
    runCount: 1,
    totalTime: elapsed,
    averageTime: elapsed,
    lastRunTime: elapsed,
    lastRunTimestamp: now,
  });
}

export function getActionStats(
  state: ActionTimingState,
  action: Action | string,
): ActionStats | undefined {
  const actionId = typeof action === "string"
    ? action
    : state.getActionId(action);
  return state.actionStats.get(actionId);
}
