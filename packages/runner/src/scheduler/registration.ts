import { getLogger } from "@commonfabric/utils/logger";

import type { Cancel } from "../cancel.ts";
import { toMemorySpaceAddress } from "../link-utils.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { ChangeGroup, IMemorySpaceAddress } from "../storage/interface.ts";
import {
  type DependencyGraphState,
  hasInvalidUpstream,
  isLive,
  notifyNodeLivenessChange,
  setNodeProvisionalDemand,
  unregisterDependentEdge,
} from "./dependency-graph.ts";
import {
  type DependencyUpdateState,
  setSchedulerDependencies,
} from "./dependency-updates.ts";
import {
  type NodeKind,
  NodeRegistry,
  type SchedulerNode,
} from "./node-record.ts";
import { filterIgnoredAddresses } from "./reactivity.ts";
import { type WriterIndexState } from "./scheduling-writes.ts";
import {
  applyActionReadDelta,
  ensureCancelForActionTriggers,
  type TriggerSubscriptionState,
} from "./trigger-index.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

type SchedulerActionTypeState = {
  readonly nodes: NodeRegistry;
  readonly dependencyGraphState: DependencyGraphState;
  readonly getIdempotencyCheckMode: () => boolean;
  readonly queueExecution: () => void;
};

type SchedulerActionChangeGroupState = {
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly getActionId: (action: Action) => string;
};

type SchedulerParentChildState = {
  readonly getExecutingAction: () => Action | null;
  readonly nodes: NodeRegistry;
};

export type SchedulerSubscriptionState =
  & SchedulerActionTypeState
  & SchedulerActionChangeGroupState
  & SchedulerParentChildState;

export interface SchedulerSubscribeOptions {
  /** Validated synchronously with registration, before any action can run. */
  initialViewState?: { dependencies: ReactivityLog; identity: string };

  /** Skips provisional parent demand for a computation with declared outputs. */
  deferUntilDemand?: boolean;

  isEffect?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
  changeGroup?: ChangeGroup;
}

export interface SchedulerResubscribeOptions {
  isEffect?: boolean;
  changeGroup?: ChangeGroup;
}

interface SchedulerResubscribeLiveness {
  readonly wasLiveBeforeRootRegistration?: boolean;
}

export interface SchedulerSubscribeActionState {
  readonly subscriptionState: SchedulerSubscriptionState;
  readonly dependencyUpdateState: DependencyUpdateState;
  readonly triggerSubscriptionState: TriggerSubscriptionState;
  readonly markProvisionalDemand: (node: SchedulerNode) => void;
  readonly pending: Set<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly writeIndex: WriterIndexState;
  readonly adoptGateConfig: (action: Action) => void;
  readonly setDebounce: (action: Action, ms: number) => void;
  readonly setNoDebounce: (action: Action, optOut: boolean) => void;
  readonly setThrottle: (action: Action, ms: number) => void;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly isThrottled: (action: Action) => boolean;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly markInvalid: (action: Action) => void;
  readonly updateDependents: (action: Action, log: ReactivityLog) => void;
  readonly registerWriterDependents: (
    action: Action,
    writes: readonly IMemorySpaceAddress[],
  ) => void;
  readonly queueExecution: () => void;
  readonly getActionId: (action: Action) => string;
  readonly unsubscribe: (action: Action) => void;
  readonly submitSubscribeTelemetry: (
    event: {
      type: "scheduler.subscribe";
      actionId: string;
      isEffect: boolean;
    },
  ) => void;
}

export function subscribePullSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  immediateLog: ReactivityLog | undefined,
  options: SchedulerSubscribeOptions = {},
): Cancel {
  const {
    isEffect = false,
    debounce,
    noDebounce,
    throttle,
  } = options;

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  const actionIsEffect = updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
    {
      queueExecution: true,
      queueComputation: state.subscriptionState.getIdempotencyCheckMode(),
    },
  );
  state.adoptGateConfig(action);

  if (debounce !== undefined) {
    state.setDebounce(action, debounce);
  }
  if (noDebounce !== undefined) {
    state.setNoDebounce(action, noDebounce);
  }
  if (throttle !== undefined) {
    state.setThrottle(action, throttle);
  }

  registerParentChildAction(state.subscriptionState, action);
  const record = state.subscriptionState.nodes.get(action);
  if (record) {
    record.declaredReads = resolveDeclaredReads(action);
  }
  const parentRecord = state.subscriptionState.nodes.parentOf(action);
  if (
    !actionIsEffect &&
    !options.deferUntilDemand &&
    record &&
    parentRecord &&
    isLive(state.subscriptionState.dependencyGraphState, parentRecord)
  ) {
    state.markProvisionalDemand(record);
    state.queueExecution();
  }

  logger.debug(
    "schedule",
    () => [
      "Subscribing to action:",
      action,
      actionIsEffect ? "effect" : "computation",
    ],
  );

  const initialViewState = actionIsEffect
    ? undefined
    : options.initialViewState;
  immediateLog = initialViewState?.dependencies ?? immediateLog;
  const declaredSurface = resolveRegistrationSurface(action, immediateLog);
  const surface = initialViewState === undefined
    ? declaredSurface
    : sortAndCompactPaths([
      ...declaredSurface,
      ...initialViewState.dependencies.writes,
    ]);
  if (!actionIsEffect && surface.length > 0) {
    state.writeIndex.setSurface(action, surface);
    state.registerWriterDependents(action, surface);
  } else if (!actionIsEffect && !immediateLog) {
    state.pending.add(action);
  }

  if (immediateLog) {
    const { previousLog, log: schedulingLog } = setSchedulerDependencies(
      state.dependencyUpdateState,
      action,
      immediateLog,
    );
    state.updateDependents(action, schedulingLog);
    applyActionReadDelta(
      state.triggerSubscriptionState,
      action,
      previousLog,
      schedulingLog,
    );
    ensureCancelForActionTriggers(
      state.triggerSubscriptionState,
      action,
    );
  }

  if (initialViewState !== undefined && record !== undefined) {
    record.adoptedViewIdentity = initialViewState.identity;
    record.hasCommittedResult = true;
    state.subscriptionState.nodes.setStatus(action, "clean");
    state.pending.delete(action);
  } else {
    state.markInvalid(action);
  }

  const actionId = state.getActionId(action);
  state.submitSubscribeTelemetry({
    type: "scheduler.subscribe",
    actionId,
    isEffect: actionIsEffect,
  });

  return () => state.unsubscribe(action);
}

export function resolveRegistrationSurface(
  action: Action,
  immediateLog: ReactivityLog | undefined,
): IMemorySpaceAddress[] {
  const annotated = action as Partial<TelemetryAnnotations>;
  const annotatedSurface = annotated.writes ?? [];
  const surface = annotatedSurface.length > 0
    ? annotatedSurface.map(toMemorySpaceAddress)
    : (immediateLog?.writes ?? []);
  return sortAndCompactPaths(
    filterIgnoredAddresses(surface, annotated.ignoredSchedulingWrites ?? []),
  );
}

export function resolveDeclaredReads(action: Action): IMemorySpaceAddress[] {
  const annotated = action as Partial<TelemetryAnnotations>;
  return sortAndCompactPaths(
    (annotated.reads ?? []).map(toMemorySpaceAddress),
  );
}

export function resubscribePullSchedulerAction(
  state: SchedulerSubscribeActionState,
  action: Action,
  log: ReactivityLog,
  options: SchedulerResubscribeOptions = {},
  liveness: SchedulerResubscribeLiveness = {},
): void {
  const { isEffect } = options;
  const existingRecord = state.subscriptionState.nodes.get(action);
  const wasLive = liveness.wasLiveBeforeRootRegistration ??
    (existingRecord !== undefined &&
      isLive(
        state.subscriptionState.dependencyGraphState,
        existingRecord,
      ));

  updateSchedulerActionChangeGroup(
    state.subscriptionState,
    action,
    options,
  );

  const { previousLog, log: schedulingLog } = setSchedulerDependencies(
    state.dependencyUpdateState,
    action,
    log,
  );

  updateSchedulerActionType(
    state.subscriptionState,
    action,
    isEffect,
  );
  const record = state.subscriptionState.nodes.get(action);
  if (record?.status === "never-ran") {
    state.subscriptionState.nodes.setStatus(action, "clean");
  }
  const actionId = state.getActionId(action);

  state.updateDependents(action, schedulingLog);

  registerParentChildAction(state.subscriptionState, action, {
    allowExisting: false,
  });

  const { triggerPathsByEntity } = applyActionReadDelta(
    state.triggerSubscriptionState,
    action,
    previousLog,
    schedulingLog,
  );

  logger.debug("schedule-resubscribe", () => [
    `Action: ${actionId}`,
    `Entities: ${triggerPathsByEntity.size}`,
    `Reads: ${schedulingLog.reads.length}`,
  ]);

  ensureCancelForActionTriggers(
    state.triggerSubscriptionState,
    action,
  );

  // Resubscribe can make a dormant action live by turning it into an effect or
  // materializer root, or by restoring computation demand through its updated
  // edges. No later value change remains to wake work invalidated while it was
  // dormant, so queue the false-to-true transition when either this action or
  // one of its upstream dependencies is already invalid. Preserve an invalid
  // status observed between the completed run and this resubscribe; only the
  // never-ran sentinel above is normalized to clean.
  if (
    !wasLive && record !== undefined &&
    isLive(state.subscriptionState.dependencyGraphState, record) &&
    (record.status === "invalid" ||
      hasInvalidUpstream(
        state.subscriptionState.dependencyGraphState,
        action,
      ))
  ) {
    state.queueExecution();
  }
}

export function updateSchedulerActionType(
  state: SchedulerActionTypeState,
  action: Action,
  isEffect: boolean | undefined,
  options: { queueExecution?: boolean; queueComputation?: boolean } = {},
): boolean {
  const kind: NodeKind = isEffect === true ||
      state.nodes.isKnownEffect(action)
    ? "effect"
    : "computation";
  const existing = state.nodes.get(action);
  const wasLive = existing
    ? isLive(state.dependencyGraphState, existing)
    : false;
  state.nodes.register(action, kind);
  notifyNodeLivenessChange(state.dependencyGraphState, action, wasLive);
  const actionIsEffect = kind === "effect";

  if (actionIsEffect) {
    if (options.queueExecution) {
      state.queueExecution();
    }
  } else {
    if (
      options.queueExecution &&
      (options.queueComputation ?? true)
    ) {
      state.queueExecution();
    }
  }

  return actionIsEffect;
}

export function updateSchedulerActionChangeGroup(
  state: SchedulerActionChangeGroupState,
  action: Action,
  options: { changeGroup?: ChangeGroup },
): void {
  if (
    !Object.prototype.hasOwnProperty.call(options, "changeGroup")
  ) {
    return;
  }
  const previousChangeGroup = state.actionChangeGroups.get(action);
  const actionId = state.getActionId(action);
  if (
    previousChangeGroup !== undefined &&
    state.changeGroupToActionId.get(previousChangeGroup) === actionId
  ) {
    state.changeGroupToActionId.delete(previousChangeGroup);
  }
  if (options.changeGroup === undefined) {
    state.actionChangeGroups.delete(action);
  } else {
    state.actionChangeGroups.set(action, options.changeGroup);
    state.changeGroupToActionId.set(options.changeGroup, actionId);
  }
}

export function registerParentChildAction(
  state: SchedulerParentChildState,
  action: Action,
  options: { allowExisting?: boolean } = {},
): void {
  const { allowExisting = true } = options;
  const parent = state.getExecutingAction();
  state.nodes.linkParent(
    action,
    parent && parent !== action ? parent : undefined,
    { allowExisting },
  );
}

export interface SchedulerUnsubscribeActionState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly dependencies: WeakMap<Action, ReactivityLog>;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly pending: Set<Action>;
  readonly reverseDependencies: WeakMap<Action, Set<Action>>;
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly dependencyGraphState: DependencyGraphState;
  readonly nodes: NodeRegistry;
  readonly writeIndex: WriterIndexState;
  readonly getActionId: (action: Action) => string;
  readonly clearInvalid: (action: Action) => void;
  readonly cancelDebounceTimer: (action: Action) => void;
  readonly clearComputationDebounceState: (
    action: Action,
    options?: { cancelTimer?: boolean },
  ) => void;
  readonly recomputeWakeAfterClear: () => void;
}

export function unsubscribeSchedulerAction(
  state: SchedulerUnsubscribeActionState,
  action: Action,
  options: {
    preserveChangeGroup?: boolean;
  } = {},
): void {
  const { preserveChangeGroup = false } = options;
  cancelActionSubscription(state, action);
  state.dependencies.delete(action);
  clearActionChangeGroup(state, action, preserveChangeGroup);
  clearActionSchedulingState(state, action);
  removeReverseDependencyEdges(state, action);
  clearActionTypeTracking(state, action);
  removeActionWriteIndexes(state, action);
  // NOTE: We intentionally keep parent-child relationships intact.
  // They're needed for cycle detection (identifying obsolete children
  // when parent is re-running). They'll be cleaned up when parent is
  // garbage collected (WeakMap).
  clearActionDelayState(state, action);
}

function cancelActionSubscription(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.cancels.get(action)?.();
  state.cancels.delete(action);
}

function clearActionChangeGroup(
  state: SchedulerUnsubscribeActionState,
  action: Action,
  preserveChangeGroup: boolean,
): void {
  if (preserveChangeGroup) return;

  const changeGroup = state.actionChangeGroups.get(action);
  const actionId = state.getActionId(action);
  if (
    changeGroup !== undefined &&
    state.changeGroupToActionId.get(changeGroup) === actionId
  ) {
    state.changeGroupToActionId.delete(changeGroup);
  }
  state.actionChangeGroups.delete(action);
}

function clearActionSchedulingState(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.pending.delete(action);
  const record = state.nodes.get(action);
  if (record) {
    record.invalidCauses.clear();
    // Stage B: the fan-out record (known-scope ratchet, per-instance
    // logs) is scheduling state of the LIVE subscription — a re-registered
    // action starts unnarrowed and re-learns by its probe run.
    record.fanOut = undefined;
  }
  state.clearInvalid(action);
}

function removeReverseDependencyEdges(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  const dependencies = state.reverseDependencies.get(action);
  if (dependencies) {
    for (const dependency of [...dependencies]) {
      unregisterDependentEdge(
        state.dependencyGraphState,
        dependency,
        action,
      );
    }
  }

  const dependents = state.dependents.get(action);
  if (dependents) {
    for (const dependent of [...dependents]) {
      unregisterDependentEdge(
        state.dependencyGraphState,
        action,
        dependent,
      );
    }
  }
}

function clearActionTypeTracking(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  const record = state.nodes.get(action);
  if (record?.provisionalDemand) {
    setNodeProvisionalDemand(state.dependencyGraphState, record, false);
  }
  state.nodes.remove(action);
}

function removeActionWriteIndexes(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.writeIndex.clearAction(action);
}

function clearActionDelayState(
  state: SchedulerUnsubscribeActionState,
  action: Action,
): void {
  state.cancelDebounceTimer(action);
  state.clearComputationDebounceState(action, { cancelTimer: false });
  // The unsubscribed node may have held the shared wake; recompute it so a
  // stale deadline does not keep idle() blocked (#4108).
  state.recomputeWakeAfterClear();
}
