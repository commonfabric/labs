import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { type SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, ReactivityLog } from "./types.ts";

export interface DependencyUpdateState {
  readonly writeIndex: SchedulerWriteIndex;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
}

export function setSchedulerDependencies(
  state: DependencyUpdateState,
  action: Action,
  log: ReactivityLog,
): {
  previousLog: ReactivityLog;
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  log: ReactivityLog;
} {
  const previousLog = state.dependencies.get(action) ?? {
    reads: [],
    shallowReads: [],
    writes: [],
  };
  const reads = sortAndCompactPaths(log.reads);
  const shallowReads = sortAndCompactPaths(log.shallowReads, false);
  const schedulingLog: ReactivityLog = {
    reads,
    shallowReads,
    writes: state.writeIndex.getSchedulingWrites(action) ?? [],
  };
  state.dependencies.set(action, schedulingLog);
  return { previousLog, reads, shallowReads, log: schedulingLog };
}
