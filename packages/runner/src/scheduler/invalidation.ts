import type { MemorySpace } from "@commonfabric/memory/interface";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";

import type {
  ChangeGroup,
  IMemoryChange,
  IMemorySpaceAddress,
  StorageNotification,
} from "../storage/interface.ts";
import { summarizeTriggerTraceValue } from "./diagnostics.ts";
import { dirtyFanOutAll, dirtyFanOutForCause } from "./fan-out.ts";
import type { MaterializerIndexState } from "./materializers.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { TriggerIndexState } from "./trigger-index.ts";
import type {
  Action,
  SpaceScopeAndURI,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
} from "./types.ts";
import { shaperInstanceGroupKey } from "./wake-shaping.ts";

export type SchedulerMode = "pull";

export function hasRegisteredTriggers(
  state: TriggerIndexState,
): boolean {
  return state.hasRegisteredTriggers();
}

// Timing side-channel mitigation (plan B, channels 4/5). Return the token-bucket
// group key for this change's subscriber wake when it should be shaped through the
// cell-notification shaper — i.e. the change is a shapable real-world-timing source
// (a renderer `$value` keystroke write, or a server push) AND the reader is a
// pattern instance (carries a pieceId). Internal machinery (no pieceId) and
// ordinary local computation (not a shapable source) return undefined and are
// never deferred, so normal reactivity is untouched.
//
// Only interactive input (renderer `$value` keystrokes) is shaped here, under a
// per-pattern `|input` bucket.
//
// Server pushes (`pull`/`integrate`) are NOT shaped. The original reason —
// observation adoption needed the push's readers marked dirty synchronously —
// deleted with the adoption machinery (server-execution v2 Phase 1 stage C;
// runtime-mapping.md N62), so whether pushes should now be shaped is an open
// re-check (N10), not something this comment decides.
//
// The security cost of leaving them unshaped is small and was already the
// design's stated position: a pattern cannot drive server pushes at
// sub-second cadence (it has no way to make the server push faster than real
// network traffic arrives), which is the same network-bounded assumption the
// separate `|push` bucket already rested on. See the channel-5 row in
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
export function shapableWakeGroupKey(
  state: StorageNotificationState,
  notification: StorageNotification,
  action: Action,
): string | undefined {
  // Space-qualified so two instances of one pattern in different spaces (which
  // can share a content-addressed pieceId) don't collide into one shaper bucket
  // (see shaperInstanceGroupKey). Undefined for internal machinery (no pieceId).
  const instanceKey = shaperInstanceGroupKey(
    (action as {
      schedulerObservationIdentity?: { ownerSpace?: string; pieceId?: string };
    }).schedulerObservationIdentity,
  );
  if (instanceKey === undefined) return undefined;
  if (
    notification.type === "commit" &&
    state.isRendererInputSource(notification.source)
  ) {
    return `${instanceKey}|input`;
  }
  return undefined;
}

export function processStorageNotification(
  state: StorageNotificationState,
  notification: StorageNotification,
): void {
  const space = notification.space;

  if (!("changes" in notification)) {
    return;
  }

  // One charge per notification (one commit or one push): every reader wake this
  // notification produces observes the same instant, so they share one burst token
  // in the cell-notification shaper rather than each spending their own.
  const commitChargeKey = {};

  const sourceChangeGroup = notification.type === "commit"
    ? notification.source?.changeGroup
    : undefined;
  const hasSourceChangeGroup = notification.type === "commit" &&
    sourceChangeGroup !== undefined;
  const collectTriggerTrace = state.getCollectTriggerTrace();
  const diagnosisEnabled = state.getDiagnosisEnabled();

  let changeIndex = 0;
  for (const change of notification.changes) {
    changeIndex++;
    state.recordCellUpdate(change);

    if (!hasRegisteredTriggers(state.triggerIndex)) {
      continue;
    }

    const {
      entity: spaceAndURI,
      hasMatchingTriggerPaths,
      triggeredActions,
    } = collectTriggeredActionsForChange(
      state.triggerIndex,
      space,
      change,
    );

    if (!hasMatchingTriggerPaths) {
      continue;
    }

    const writerActionId = hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ? state.changeGroupToActionId.get(sourceChangeGroup)
      : undefined;
    const triggerTraceEntry: TriggerTraceEntry | null = collectTriggerTrace
      ? createTriggerTraceEntry({
        notificationType: notification.type,
        changeIndex,
        matchedActionCount: triggeredActions.length,
        mode: "pull",
        writerActionId,
        space,
        change,
      })
      : null;

    for (const action of triggeredActions) {
      if (
        diagnosisEnabled && hasSourceChangeGroup &&
        sourceChangeGroup !== undefined
      ) {
        const writerActionId = state.changeGroupToActionId.get(
          sourceChangeGroup,
        );
        if (writerActionId) {
          state.recordCausalEdge({
            writer: writerActionId,
            cell: spaceAndURI,
            triggered: state.getActionId(action),
            timestamp: performance.now(),
          });
        }
      }

      const actionChangeGroup = state.actionChangeGroups.get(action);
      const actionId = state.getActionId(action);
      const actionIsEffect = state.effects.has(action);
      const actionType = actionIsEffect ? "effect" : "computation";
      const pendingBefore = state.pending.has(action);
      const dirtyBefore = state.isInvalid(action);
      // Own-commit-source skip (spec scheduler-v2 P5), and its
      // speculation twin (server-execution v2, speculation.md §4 — the
      // "own retirement is not a trigger" rider, RULED 2026-08-16): the
      // `integrate` a retiring echo produces carries the echo's own
      // transaction as `source`, so the writer does not re-run for the
      // flip of its OWN output to the authoritative value.
      const isOwnCommitSource =
        (notification.type === "commit" || notification.type === "integrate") &&
        notification.source !== undefined &&
        notification.source.sourceAction === action;
      const plan = planPullTriggeredAction({
        invalidBefore: dirtyBefore,
        isOwnCommitSource,
        hasSourceChangeGroup,
        actionChangeGroup,
        sourceChangeGroup,
      });
      const cause: IMemorySpaceAddress = { ...change.address, space };
      const shapeGroupKey = plan.operation !== "none"
        ? shapableWakeGroupKey(state, notification, action)
        : undefined;
      if (shapeGroupKey !== undefined) {
        // Defer this pattern reader's wake through the cell-notification
        // shaper, coalesced per (reader, cell) and released with the pattern's
        // window. The reader re-reads current cell state when it runs, so
        // nothing is lost. Record the invalid cause now as well as at release
        // (addInvalidCause dedups by address): an interleaved unshaped wake may
        // run the action and consume its recorded causes before the deferred
        // release, and the deferred rerun must still carry the "this change
        // triggered me" flow label.
        const record = state.nodes.get(action);
        if (record) addInvalidCause(record, cause);
        state.holdShapedNotification(
          shapeGroupKey,
          `${actionId}|${spaceAndURI}`,
          commitChargeKey,
          () => applyPullTriggeredActionPlan(state, action, plan, cause),
        );
      } else {
        applyPullTriggeredActionPlan(state, action, plan, cause);
      }

      triggerTraceEntry?.triggered.push(
        createTriggerTraceActionRecord({
          actionId,
          actionType,
          mode: "pull",
          decision: plan.decision,
          pendingBefore,
          pendingAfter: state.pending.has(action),
          dirtyBefore,
          dirtyAfter: state.isInvalid(action),
        }),
      );
    }

    if (
      triggerTraceEntry &&
      shouldRecordTriggerTraceEntry(triggerTraceEntry)
    ) {
      state.recordTriggerTrace(triggerTraceEntry);
    }
  }
}

export function collectTriggeredActionsForChange(
  state: TriggerIndexState,
  space: MemorySpace,
  change: IMemoryChange,
): {
  entity: SpaceScopeAndURI;
  hasMatchingTriggerPaths: boolean;
  triggeredActions: Action[];
} {
  return state.collectTriggeredActionsForChange(space, change);
}

export interface MarkInvalidOptions {
  /** Server-execution v2 fan-out stage B (B7): how a fanned-out node's
   * per-instance dirtiness responds to an UNTARGETED invalidation (no
   * cause). "all" (the default) dirties every instance — the
   * conservative meaning of "this node must run". "keep" leaves the
   * instance record alone: the caller already dirtied exactly the
   * instances that must re-run (a retried instance's own key; an
   * arriving demander, whose instances have never run and so are not
   * clean), and the siblings stay current. A CAUSE-bearing invalidation
   * ignores this: the cause names its instance (or all). */
  fanOutInstances?: "all" | "keep";

  /** The invalidation is a RETRY the scheduler owes after a WAIT: a run
   * whose commit was refused for a stale basis, re-queued once the
   * conflict's catch-up gate resolved, or a builtin whose output waited for
   * document confirmation. Not an input change — the trailing
   * debounce coalesces input churn and a throttle spaces runs that produced
   * output, while a refused run left nothing durable and its wait was its
   * delay — so the retry is queued past both: the debounce is not re-armed,
   * and an armed debounce or throttle readiness is released (the
   * convergence backoff stays). Further invalidations preserve the release
   * until the owed run starts. Held behind its debounce, a retry would run
   * only when a live demander armed the expiry wake, and a one-shot `pull()`
   * has none once it resolves. An empty reactive rejection also bypasses
   * gates when the node or instance has no accepted result yet, or has no
   * live demander to wake it. Live nodes with accepted results, other local
   * inconsistencies, and transport errors keep their gates: there the debounce
   * is the spacing between the re-run and the local writer it raced.
   *
   * Consumed by the scheduler facade's invalid-setter (`#markActionInvalid`),
   * which owns the gates; {@link markInvalid} below records status and
   * causes only and does not read it. */
  retry?: boolean;
}

/**
 * Record an invalidating address on `record`. Consumed by the next run,
 * whose transaction joins the addresses' labels into the flow-label
 * derivation: the decision to run now was influenced by the changed values
 * even if that run's branch never re-reads them.
 *
 * On a fanned-out node (stage B) the cause also decides WHICH instances
 * re-run (B7, precise per-instance dirtiness): a keyed cause dirties the
 * instances whose reads covered that instance; an unkeyed one, or no
 * cause at all, dirties every instance unless the caller says "keep".
 */
export function markInvalid(
  nodes: NodeRegistry,
  action: Action,
  cause?: IMemorySpaceAddress,
  options: MarkInvalidOptions = {},
): void {
  const record = nodes.get(action);
  if (!record) return;
  if (cause !== undefined) {
    addInvalidCause(record, cause);
  }
  if (record.fanOut !== undefined) {
    if (cause !== undefined) {
      dirtyFanOutForCause(record.fanOut, cause);
    } else if (options.fanOutInstances !== "keep") {
      dirtyFanOutAll(record.fanOut);
    }
  }
  // Status transition goes through the registry so the invalid-node index
  // stays in lockstep; never-ran nodes keep their status (already indexed).
  if (record.status === "clean" || record.status === "unavailable") {
    nodes.setStatus(action, "invalid");
  }
}

/**
 * The key a pending invalid cause is recorded under. Scope participates (an
 * omitted scope normalizes to `space`, matching storage). The three address
 * fields precede the path segments, keeping empty and split paths distinct.
 */
function invalidCauseKey(address: IMemorySpaceAddress): string {
  return stringTupleKey([
    address.space,
    address.scope ?? "space",
    address.id,
    ...address.path,
  ]);
}

/**
 * Record a pending invalid cause. An address already recorded — by an
 * earlier notification, or by a retry restoring what its run took — stays
 * recorded once, at the position it first arrived.
 */
export function addInvalidCause(
  record: SchedulerNode,
  address: IMemorySpaceAddress,
): void {
  const key = invalidCauseKey(address);
  if (record.invalidCauses.has(key)) return;
  record.invalidCauses.set(key, address);
}

/**
 * Hand the pending invalid causes to the run that consumes them, in arrival
 * order, leaving none recorded.
 */
export function takeInvalidCauses(
  record: SchedulerNode,
): readonly IMemorySpaceAddress[] | undefined {
  if (record.invalidCauses.size === 0) return undefined;
  const causes = [...record.invalidCauses.values()];
  record.invalidCauses.clear();
  return causes;
}

export function restoreInvalidCauses(
  nodes: NodeRegistry,
  action: Action,
  addresses: readonly IMemorySpaceAddress[],
): void {
  for (const address of addresses) {
    markInvalid(nodes, action, address);
  }
}

export function createTriggerTraceEntry(state: {
  readonly notificationType: string;
  readonly changeIndex: number;
  readonly matchedActionCount: number;
  readonly mode: SchedulerMode;
  readonly writerActionId?: string;
  readonly space: MemorySpace;
  readonly change: IMemoryChange;
  readonly now?: number;
}): TriggerTraceEntry {
  return {
    recordedAt: state.now ?? performance.now(),
    notificationType: state.notificationType,
    changeIndex: state.changeIndex,
    matchedActionCount: state.matchedActionCount,
    mode: state.mode,
    writerActionId: state.writerActionId,
    space: state.space,
    entityId: state.change.address.id,
    path: [...state.change.address.path],
    before: summarizeTriggerTraceValue(state.change.before),
    after: summarizeTriggerTraceValue(state.change.after),
    triggered: [],
  };
}

export interface TriggeredActionPlan {
  decision: TriggerTraceActionRecord["decision"];
  operation: "none" | "schedule" | "invalidate";
}

interface TriggeredActionSkipState {
  readonly isOwnCommitSource: boolean;
  readonly hasSourceChangeGroup: boolean;
  readonly actionChangeGroup: ChangeGroup | undefined;
  readonly sourceChangeGroup: ChangeGroup | undefined;
}

function planSkippedTriggeredAction(
  state: TriggeredActionSkipState,
): TriggeredActionPlan | undefined {
  if (state.isOwnCommitSource) {
    return { decision: "skip-own-commit-source", operation: "none" };
  }

  // changeGroup is a user-facing suppression feature: external
  // subscribers (e.g. cf-code-editor sinks) group their own writes so
  // their subscription ignores them. It is NOT scheduler-internal
  // self-suppression — that is tx.sourceAction (spec scheduler-v2 P5).
  if (
    state.hasSourceChangeGroup &&
    state.actionChangeGroup !== undefined &&
    Object.is(state.actionChangeGroup, state.sourceChangeGroup)
  ) {
    return { decision: "skip-same-change-group", operation: "none" };
  }

  return undefined;
}

export function planPullTriggeredAction(
  state: TriggeredActionSkipState & {
    readonly invalidBefore: boolean;
  },
): TriggeredActionPlan {
  const skipped = planSkippedTriggeredAction(state);
  if (skipped) return skipped;

  return {
    decision: state.invalidBefore ? "already-invalid" : "mark-invalid",
    operation: "invalidate",
  };
}

export function createTriggerTraceActionRecord(state: {
  readonly actionId: string;
  readonly actionType: "effect" | "computation";
  readonly mode: SchedulerMode;
  readonly decision: TriggerTraceActionRecord["decision"];
  readonly pendingBefore: boolean;
  readonly pendingAfter: boolean;
  readonly dirtyBefore: boolean;
  readonly dirtyAfter: boolean;
}): TriggerTraceActionRecord {
  return {
    actionId: state.actionId,
    actionType: state.actionType,
    mode: state.mode,
    decision: state.decision,
    pendingBefore: state.pendingBefore,
    pendingAfter: state.pendingAfter,
    dirtyBefore: state.dirtyBefore,
    dirtyAfter: state.dirtyAfter,
  };
}

export function shouldRecordTriggerTraceEntry(
  entry: TriggerTraceEntry,
): boolean {
  return entry.triggered.length > 0 || entry.matchedActionCount > 0;
}

export function applyPullTriggeredActionPlan(
  state: StorageNotificationState,
  action: Action,
  plan: TriggeredActionPlan,
  cause: IMemorySpaceAddress,
): void {
  if (plan.operation === "schedule") {
    state.scheduleWithDebounce(action);
    return;
  }

  if (plan.operation === "invalidate") {
    state.markInvalid(action, cause);
  }
}

interface CausalEdge {
  writer: string;
  cell: string;
  triggered: string;
  timestamp: number;
}

export interface StorageNotificationState {
  readonly triggerIndex: TriggerIndexState;
  readonly nodes: NodeRegistry;
  readonly getDiagnosisEnabled: () => boolean;
  readonly getCollectTriggerTrace: () => boolean;
  readonly changeGroupToActionId: Map<ChangeGroup, string>;
  readonly recordCausalEdge: (edge: CausalEdge) => void;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly effects: ReadonlySet<Action>;
  readonly pending: ReadonlySet<Action>;
  readonly getActionId: (action: Action) => string;
  readonly recordCellUpdate: (change: IMemoryChange) => void;
  readonly recordTriggerTrace: (entry: TriggerTraceEntry) => void;
  readonly scheduleWithDebounce: (action: Action) => void;
  readonly markInvalid: (
    action: Action,
    cause: IMemorySpaceAddress,
  ) => void;
  readonly isInvalid: (action: Action) => boolean;
  readonly materializerIndex: MaterializerIndexState;
  readonly queueExecution: () => void;
  // Timing side-channel mitigation (plan B, channels 4/5). Whether a committed
  // change came from a renderer `$value` keystroke write — its notification
  // `source` carries the renderer-input mark — so the resulting subscriber wake
  // should be shaped.
  readonly isRendererInputSource: (source: object | undefined) => boolean;
  // Defer a shapable subscriber wake through the cell-notification shaper.
  // groupKey identifies the observing pattern instance (so a pattern's shaped
  // wakes share one window); itemKey is the (reader, cell) coalescing unit;
  // deliver performs the wake once the shaping window releases. chargeKey
  // identifies the source commit so all its reader wakes share one burst token.
  readonly holdShapedNotification: (
    groupKey: string,
    itemKey: string,
    chargeKey: object,
    deliver: () => void,
  ) => void;
}
