import { resolveScopeKey, type ScopeKey } from "@commonfabric/memory/v2";
import { getAuthoredDebugSource } from "../harness/authored-debug-source.ts";
import { startReadStats } from "../read-stats.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { CfcRefusalDetail } from "../cfc/refusal-detail.ts";
import { sortAndCompactPaths } from "../reactive-dependencies.ts";
import type { Runtime } from "../runtime.ts";
import { normalizeCellScope } from "../scope.ts";
import { waveSettlementOf } from "../executor/wave.ts";
import { createDuplicateWorkTransaction } from "../storage/extended-storage-transaction.ts";
import type {
  ChangeGroup,
  CommitError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import {
  localReadsReady,
  releaseLocalReadBasis,
  requireLocalReadCondition,
  usesLocalReads,
  validateLocalReadBasis,
} from "../storage/local-read-policy.ts";
import {
  isConflictRejection,
  isPermanentRejection,
  isStorageTransactionInconsistent,
  isTerminalRejection,
} from "../storage/rejection.ts";
import type {
  ActionReadStats,
  NonIdempotentReport,
  SchedulerActionInfo,
} from "../telemetry.ts";
import { reportDroppedCfcRejectedWrite } from "./cfc-rejection-report.ts";
import {
  MAX_ACTION_RUN_TRACE_HISTORY,
  MAX_RETRIES_FOR_REACTIVE,
  OFF_BUDGET_RETRY_WARN_INTERVAL,
} from "./constants.ts";
import {
  captureDiagnosisRecord,
  type DiagnosisRecord,
  runIdempotencyRecheck,
} from "./diagnosis.ts";
import {
  getSchedulerActionName,
  toActionRunTraceAddress,
} from "./diagnostics.ts";
import {
  dirtyFanOutKey,
  type FanOutInstance,
  fanOutInstances,
  fanOutInstancesToRun,
  type FanOutNodeState,
  fanOutRunFinished,
  fanOutRunStarted,
  fanOutUnionLog,
  keyAtRatchet,
  newFanOutNodeState,
  pruneFanOutInstances,
} from "./fan-out.ts";
import {
  addInvalidCause,
  type MarkInvalidOptions,
  restoreInvalidCauses,
  takeInvalidCauses,
} from "./invalidation.ts";
import type { NodeRegistry } from "./node-record.ts";
import { txToReactivityLog } from "./reactivity.ts";
import { RetryImmediately } from "./retry-immediately.ts";
import { type ActionTimingState, recordActionTime } from "./timing.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  ReactivityLog,
  TelemetryAnnotations,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

/**
 * Which action a `scheduler/run/action` span belongs to.
 *
 * The key stays `scheduler/run/action` for every one of them, because a key
 * names a place in the code and the statistics are keyed by it — naming the
 * action there would multiply the rows by every action the runtime has ever
 * run. The timeline is where an occurrence can be identified, so this rides
 * along on the emitted measure instead, and only when emission is on.
 *
 * The module or pattern name is what a reader recognizes; the action id is the
 * fallback for an action that carries neither, and for one that carries an
 * empty string — which is a name a reader cannot use, not a name.
 *
 * Two property reads, and called only when a measure is actually being
 * emitted. Both halves of that matter and were measured: the full telemetry
 * builder formats every annotated read and write on its way to these same two
 * names, which costs about 675ns per action — more than twice the timing pair
 * it would sit inside — so a label asks for a name rather than for telemetry.
 * Deferring what remains costs about 4ns and saves about 19ns per action on the
 * ordinary path, where emission is off.
 */
function actionMeasureDetail(action: Action, actionId: string): string {
  return getSchedulerActionName(action) || actionId;
}

export type ActionInvocationResult =
  | { ok: true; result: any }
  | { ok: false; error: unknown };

export function invokeReactiveAction(state: {
  readonly runtime: Runtime;
  readonly setExecutingAction: (action: Action, actionId: string) => void;
  readonly clearExecutingAction: () => void;
}, args: {
  readonly action: Action;
  readonly actionId: string;
  readonly tx: IExtendedStorageTransaction;
  readonly actionStartTime: number;
}): Promise<ActionInvocationResult> {
  // A thunk, not a value: the logger calls it only when it will emit, so an
  // ordinary run never builds it. Outside the `try` because the failure paths
  // below name the action too.
  const measureDetail = () => actionMeasureDetail(args.action, args.actionId);
  try {
    // Track executing action for parent-child relationship tracking.
    state.setExecutingAction(args.action, args.actionId);
    logger.timeStart("scheduler", "run", "action");
    return Promise.resolve(
      state.runtime.harness.invoke(() => {
        state.runtime.scheduler.prepareViewAction(args.tx, args.action);
        state.runtime.scheduler.beginViewAction(args.action);
        return args.action(args.tx);
      }),
    )
      .then((actionResult) => {
        logger.timeEndDetailed(measureDetail, "scheduler", "run", "action");
        state.clearExecutingAction();
        logger.debug("schedule-action-timing", () => {
          const duration = ((performance.now() - args.actionStartTime) / 1000)
            .toFixed(3);
          return [
            `Action ${args.actionId} completed in ${duration}s`,
          ];
        });
        return { ok: true as const, result: actionResult };
      })
      .catch((error) => {
        logger.timeEndDetailed(measureDetail, "scheduler", "run", "action");
        state.clearExecutingAction();
        return { ok: false as const, error };
      });
  } catch (error) {
    logger.timeEndDetailed(measureDetail, "scheduler", "run", "action");
    state.clearExecutingAction();
    return Promise.resolve({ ok: false as const, error });
  }
}

export function startReactiveActionCommit(state: {
  readonly runtime: Runtime;
  readonly tx: IExtendedStorageTransaction;
}, options: {
  readonly beforeCommit?: () => void;
} = {}): ReturnType<IExtendedStorageTransaction["commit"]> {
  logger.timeStart("scheduler", "run", "commit");
  try {
    state.runtime.prepareTxForCommit(state.tx);
  } catch (error) {
    // A throw escaping prep must become a FAILED COMMIT, not an escaped
    // exception: the finalize path re-enters this function from the run
    // promise's rejection handler, so a deterministic prep throw used to
    // throw AGAIN there — an unhandled rejection, an unresolved run
    // promise, and a transaction that never settled (no rollback
    // callbacks). Abort the transaction with the real cause; `commit()` on
    // the settled transaction below then reports it through the ordinary
    // failed-commit path (retry classification, error surfacing). The CFC
    // prep class is already converted to a modeled refusal inside
    // `prepareCfc` — this is the backstop for everything else.
    if (state.tx.status().status === "ready") {
      state.tx.abort(error);
    }
  }
  options.beforeCommit?.();
  const commitPromise = state.tx.commit();
  logger.timeEnd("scheduler", "run", "commit");
  return commitPromise;
}

export function watchReactiveActionCommit(state: {
  /** Whether this run may retry or wake consumers of its registration. */
  readonly canRetry: () => boolean;

  /** Waits for catch-up and scoped conflict pulls before requeueing. */
  readonly awaitRetryReadiness: (error: unknown) => Promise<void>;

  readonly action: Action;
  readonly tx: IExtendedStorageTransaction;
  readonly log: ReactivityLog;
  readonly retries: WeakMap<Action, number>;
  readonly offBudgetRetries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly commitPromise: ReturnType<IExtendedStorageTransaction["commit"]>;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markInvalid: (
    action: Action,
    options?: MarkInvalidOptions,
  ) => void;
  readonly queueExecution: () => void;
  readonly restoreInvalidCauses: () => void;
  readonly getActionId: (action: Action) => string;
  readonly reportTerminalRejection?: (error: Error) => void;
  readonly handleUnavailable?: () => boolean;

  /** Whether a live demander will wake this action when its gates expire. */
  readonly isLiveAction?: () => boolean;
  /** Whether this node or fan-out instance already has an accepted result. */
  readonly hasCommittedResult?: () => boolean;

  /** Wakes consumers after a successful commit of a still-active registration. */
  readonly onSuccess?: () => void;
}): Promise<void> {
  const handleResult = async (error: unknown): Promise<void> => {
    if (error && state.handleUnavailable?.()) return;
    if (!error) {
      // Retry counts belong to the action across registrations. A successful
      // commit ends the sequence even if its registration has been retired,
      // but only a live run may wake that registration's consumers.
      state.retries.delete(state.action);
      state.offBudgetRetries.delete(state.action);
      if (state.canRetry()) state.onSuccess?.();
      return;
    }

    logger.info(
      "schedule-run-error",
      "Error committing transaction",
      error,
    );

    // Permanent (precondition) and terminal (deterministic commit-rule refusal)
    // rejections end the retry sequence even when its registration is retired.
    // A later input-triggered run gets a fresh budget for transient failures.
    // A terminal refusal is a verdict on the action's output and reaches the
    // error channel (§7.6); a permanent lost idempotency race stays quiet.
    if (isPermanentRejection(error) || isTerminalRejection(error)) {
      state.retries.delete(state.action);
      state.offBudgetRetries.delete(state.action);
      if (isTerminalRejection(error)) {
        state.reportTerminalRejection?.(
          toTerminalRejectionError(error, state.action),
        );
      }
      abandonAction(state, error);
      return;
    }

    // Retry preparation refreshes the subscription, so check its lifetime
    // before restoring dependencies as well as after asynchronous recovery.
    if (!state.canRetry()) {
      abandonAction(state, error);
      return;
    }

    // A reactive compute is not a transactional retrier. A stale-basis rejection
    // means the value the action read is no longer current, so re-running against
    // fresh state and committing again converges. Two rejections are stale-basis.
    // A CONFLICT is an upstream stale read: the authoritative version is ahead of
    // this replica, and the action's read set is stale until the replica catches
    // up and the runtime pulls every scoped instance the conflict names. A
    // STORAGE-TRANSACTION-INCONSISTENT is the local analog: a value the
    // transaction read changed on this replica between the read and the commit,
    // which re-running against the settled replica resolves. It carries no
    // `readyToRetry`, so the re-queue below runs it afresh once the local write
    // completes. Wait for any catch-up, then re-queue the action to re-run
    // against fresh state; its subscription is already live, so the steps below
    // refresh it and restore the trigger reads the run consumed rather than
    // establishing a subscription that was torn down. Both are a WAIT, not a
    // failure, so neither consumes the retry budget —
    // otherwise sustained contention would exhaust the budget and strand the
    // compute as a zombie against rolled-back data. Only a rejection that
    // re-running cannot resolve (transport, malformed store) takes the bounded
    // budget below.
    //
    // Reader-dirty propagation also re-triggers the action when the catch-up
    // write lands as a fresh notification, but that does not cover every
    // conflict: when the write that caused the conflict has already been
    // delivered (it is what triggered this run), no further dirty arrives, and
    // relying on reader-dirty alone would leave the action stranded with its
    // stale committed value. So the re-queue here is the recovery mechanism;
    // reader-dirty is a redundant fast path (the re-dirty/pending/queue calls
    // coalesce). Restore the consumed trigger reads (§8.9.2) so the re-run's
    // transaction still carries their flow labels.
    if (isConflictRejection(error) || isStorageTransactionInconsistent(error)) {
      // Scoped recovery pulls and live subscriptions supply the fresh basis.
      // Repeated rejection without convergence warrants a diagnostic without
      // charging the bounded budget used for other failure classes. The count
      // clears on the next successful, permanent, or terminal commit.
      const offBudgetRetries = (state.offBudgetRetries.get(state.action) ?? 0) +
        1;
      state.offBudgetRetries.set(state.action, offBudgetRetries);
      if (offBudgetRetries % OFF_BUDGET_RETRY_WARN_INTERVAL === 0) {
        logger.error(
          "reactive-retry-not-converging",
          () => [
            `reactive action ${state.getActionId(state.action)} re-queued ` +
            `${offBudgetRetries} times on a stale-basis rejection without ` +
            `converging; its subscription may never deliver the awaited value`,
          ],
        );
      }
      // Re-arm immediately (restore the consumed trigger reads §8.9.2, then
      // resubscribe) so the subscription stays fresh and a concurrent
      // reader-dirty can re-trigger the action while we wait for the catch-up.
      state.restoreInvalidCauses();
      state.resubscribe(state.action, state.log);
      const waitedForCatchUp = isConflictRejection(error);
      if (waitedForCatchUp) {
        // The catch-up marker covers the watched view. Scoped pulls also load
        // validation dependencies that the action ignores for scheduling.
        try {
          await state.awaitRetryReadiness(error);
        } catch (readyError) {
          logger.debug(
            "conflict-retry-readiness-aborted",
            "conflict recovery aborted; checking whether the action may retry",
            readyError,
          );
        }
        // Removal, replacement, or write teardown can retire this run while
        // recovery is pending. Its completion must not revive that lifetime.
        if (state.handleUnavailable?.()) return;
        if (!state.canRetry()) {
          abandonAction(state, error);
          return;
        }
      }
      // A re-run that waited on the catch-up gate is the scheduler's own,
      // not a fresh input change: the wait was its delay, and the refused
      // run left nothing durable behind. So it is queued past the node's
      // freshness gates — `retry` skips the trailing-debounce re-arm and
      // releases an armed debounce or throttle readiness (§8.3; the
      // convergence backoff stays). Held behind its debounce, the retry would
      // be a deferred re-run of an "already-ran" computation, which is not
      // idle work and gets its expiry wake only from a live demander; a
      // one-shot `pull()` has none once it resolves, so the refused first
      // output would stand in for the answer. An empty reactive commit also
      // releases those gates if it has no accepted result yet or no live
      // demander to wake it. A live node with a prior result keeps its gates.
      // Other local inconsistencies waited on nothing, so their re-run
      // keeps the debounce: that is the spacing between it and the local
      // writer it raced (an interval `#now` tick's own write, for one).
      const emptyReactiveCommit = isStorageTransactionInconsistent(error) &&
        isObjectOrArray(error) &&
        "emptyReactiveCommit" in error && error.emptyReactiveCommit === true;
      state.markInvalid(state.action, {
        retry: waitedForCatchUp ||
          (emptyReactiveCommit &&
            (state.hasCommittedResult?.() !== true ||
              state.isLiveAction?.() !== true)),
      });
      state.pending.add(state.action);
      state.queueExecution();
      return;
    }

    // Non-conflict failures are NOT re-triggered by reader-dirty — a transient
    // transport or malformed-store error — so they still warrant a bounded
    // retry to make progress. Unlike a stale basis (a conflict or the local
    // same-replica-race guard, both handled off-budget above), re-running does
    // not resolve them, so the budget bounds the wasted attempts. On every
    // attempt we still resubscribe, so even after the budget is exhausted the
    // action is re-triggered when its input data changes.
    const retries = (state.retries.get(state.action) ?? 0) + 1;
    state.retries.set(state.action, retries);
    if (retries < MAX_RETRIES_FOR_REACTIVE) {
      // Resubscribe sets up dependencies/triggers from the log so the action
      // re-runs when its inputs change. The run still exists only because of the
      // consumed trigger reads (§8.9.2), so restore them for its tx.
      state.restoreInvalidCauses();
      state.resubscribe(state.action, state.log);
      state.markInvalid(state.action);
      state.pending.add(state.action);
      state.queueExecution();
    } else {
      // WATCH(scheduler-v2): exhausted retries can leave a piece registered
      // against rolled-back data (accepted zombie — spec §15 decision 9).
      // The counters stay set, unlike the success and permanent arms. A spent
      // budget is spent until this action commits something: clearing it here
      // would hand every later failure a fresh budget, which under a failure
      // that persists is a retry loop with no bound at all. So a run that a
      // later input change triggers gets one attempt, and abandoning here is
      // what an action that has not committed through a whole budget has
      // earned.
      abandonAction(state, error);
    }
  };
  return state.commitPromise.then(
    ({ error }) => handleResult(error),
    (reason) =>
      handleResult(
        reason || new Error("Storage commit promise rejected without a reason"),
      ),
  ).catch((error) => {
    logger.error(
      "schedule-error",
      "Commit result handling failed in finalizeAction:",
      error,
    );
  });
}

/**
 * Tell the work staged on this run's transaction that no further attempt at it
 * is coming, and report the write if CFC enforcement is what refused it.
 *
 * The scheduler is the only party that knows this. A rejection does not say
 * whether another attempt would fare better — CFC enforcement refuses a commit
 * both for a verdict on the data and for metadata this replica has not read
 * yet, and only the second converges by re-running — so a builtin waiting on
 * the commit cannot tell a pause from an ending. This is the ending.
 */
function abandonAction(
  state: {
    readonly action: Action;
    readonly tx: IExtendedStorageTransaction;
    readonly getActionId: (action: Action) => string;
  },
  error: unknown,
): void {
  const actionId = state.getActionId(state.action);
  reportDroppedCfcRejectedWrite(
    error as { name?: string; message?: string },
    actionId,
  );
  state.tx.abandonStagedWork(error as CommitError);
}

export function appendActionRunTrace(state: {
  readonly actionRunTrace: ActionRunTraceEntry[];
  readonly nodes: NodeRegistry;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
}, args: {
  readonly action: Action;
  readonly actionId: string;
  readonly durationMs: number;
  readonly log: ReactivityLog;
  readonly recordedAt?: number;
  readonly maxHistory?: number;
  readonly instanceKey?: string;
}): void {
  const parentAction = state.nodes.parentActionOf(args.action);
  const declaredWrites = (state.getSchedulingWrites(args.action) ?? []).map(
    toActionRunTraceAddress,
  );
  const actualWrites = sortAndCompactPaths(args.log.writes).map(
    toActionRunTraceAddress,
  );

  state.actionRunTrace.push({
    recordedAt: args.recordedAt ?? performance.now(),
    actionId: args.actionId,
    actionType: state.nodes.isKnownEffect(args.action)
      ? "effect"
      : "computation",
    parentActionId: parentAction ? state.getActionId(parentAction) : undefined,
    durationMs: args.durationMs,
    declaredWrites,
    actualWrites,
    ...(args.instanceKey !== undefined
      ? { instanceKey: args.instanceKey }
      : {}),
  });
  if (
    state.actionRunTrace.length >
      (args.maxHistory ?? MAX_ACTION_RUN_TRACE_HISTORY)
  ) {
    state.actionRunTrace.shift();
  }
}

export interface SchedulerActionRunState {
  readonly runtime: Runtime;
  readonly actionChangeGroups: WeakMap<Action, ChangeGroup>;
  readonly actionTimingState: ActionTimingState;
  readonly getReadStatsEnabled: () => boolean;
  readonly getReadAttemptAccountingEnabled: () => boolean;
  readonly retries: WeakMap<Action, number>;
  readonly offBudgetRetries: WeakMap<Action, number>;
  readonly pending: Set<Action>;
  readonly actionRunTrace: ActionRunTraceEntry[];
  readonly nodes: NodeRegistry;
  readonly diagnosisHistory: Map<string, DiagnosisRecord[]>;
  readonly diagnosisNonIdempotent: NonIdempotentReport[];
  readonly idempotencyViolations: NonIdempotentReport[];
  readonly getRunningPromise: () => Promise<unknown> | undefined;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getCollectActionRunTrace: () => boolean;
  readonly getDiagnosisEnabled: () => boolean;
  readonly getIdempotencyCheckMode: () => boolean;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    action: Action | EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getMaterializerWriteEnvelopes: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly getDebounce: (action: Action) => number | undefined;
  readonly getNoDebounce: (action: Action) => boolean | undefined;
  readonly getThrottle: (action: Action) => number | undefined;
  readonly maybeAutoDebounce: (action: Action) => void;
  readonly markActionHasRun: (action: Action) => void;
  readonly markNodeHasRun: (action: Action) => void;
  readonly handleError: (error: Error, action: Action) => void;
  readonly resubscribe: (action: Action, log: ReactivityLog) => void;
  readonly markInvalid: (action: Action, options?: MarkInvalidOptions) => void;
  readonly isLiveAction: (action: Action) => boolean;
  readonly isDisposed?: () => boolean;
  readonly parkLocalRead?: (action: Action, log: ReactivityLog) => void;
  readonly queueExecution: () => void;
  readonly setExecutingAction: (action: Action, actionId: string) => void;
  readonly clearExecutingAction: () => void;
}

export async function runSchedulerAction(
  state: SchedulerActionRunState,
  action: Action,
): Promise<any> {
  const readStatsEnabled = state.getReadStatsEnabled();
  const readAttemptsEnabled = state.getReadAttemptAccountingEnabled();
  logger.timeStart("scheduler", "run");
  const actionId = state.getActionId(action);
  state.runtime.telemetry.submit({
    type: "scheduler.run",
    actionId,
    actionInfo: state.getActionTelemetryInfo(action),
  });

  logger.debug("schedule-run-start", () => [
    `[RUN] Starting action: ${actionId}`,
  ]);

  const runningPromise = state.getRunningPromise();
  if (runningPromise) await runningPromise;

  const record = state.nodes.get(action);
  const registrationToken = record?.registrationToken;
  // A direct fan-out run registers after its first instance. All instances
  // share that subscription's lifetime; a registered run keeps its lifetime.
  const retryRegistration = {
    token: state.nodes.isEffect(action) || state.nodes.isComputation(action)
      ? registrationToken
      : undefined,
  };
  const invalidCauses = record ? takeInvalidCauses(record) : undefined;
  if (record) {
    // Consumes the owed retry at entry; a completion during this run can
    // establish a new retry that must survive this run's finalization.
    delete record.gate.retryOwed;
    record.cancelLocalReadWake?.();
    record.cancelLocalReadWake = undefined;
    state.nodes.setStatus(action, "clean");
  }

  // The per-(action × instance) run SUPPLY (server-execution v2 stage
  // P2-F; scopes.md §5 — the DEMAND supplies the run identity; fan-out
  // stage B — the demanders and the KNOWN-SCOPE RATCHET decide the
  // instances). On a serving runtime the SpaceServer's installed
  // resolver returns the DEMANDERS of this action's demand roots — the
  // (principal, session) pairs whose watches reach the piece, at ANY
  // address (a space-scoped root watch too: scopes.md §2's mechanism
  // sentence — a principal's demand at a broad address is demand for
  // THAT principal's instance of every node that narrows beneath it) —
  // and the scheduler derives the instance set from what THIS node has
  // discovered by running (scheduler/fan-out.ts): one PROBE run while
  // nothing scoped was ever read (a space node runs ONCE regardless of
  // demander count), one run per demanding principal once it narrowed
  // to user, one per demanding session for principals it narrowed to
  // session — ragged per principal. Instances live in keys, basis rows,
  // stamps and the per-node fan-out record — never as extra
  // dependency-graph nodes (C11b): the node, its status, and its ONE
  // subscription (the union of the instance logs) stay singular.
  // Everywhere else (`serverRunDemandersFor` undefined or empty) this is
  // exactly the old single wave-identity run.
  // The demand roots: the action's own piece root plus its ancestor
  // chain (Phase 7 — a nested piece's instances resolve through the
  // outer piece the client watches; see
  // SchedulerObservationIdentity.demandRootIds).
  const observationIdentity = (action as Partial<TelemetryAnnotations>)
    .schedulerObservationIdentity;
  const demandRootIds = observationIdentity?.demandRootIds ??
    (observationIdentity?.pieceRootId !== undefined
      ? [observationIdentity.pieceRootId]
      : undefined);
  const demanders = demandRootIds !== undefined
    ? state.runtime.serverRunDemandersFor(demandRootIds)
    : undefined;
  // A one-shot run of an unregistered action (`scheduler.run` on a raw
  // action — tests, internal probes) has no record to keep the ratchet on
  // and learns it afresh within this call; a registered node keeps it.
  const fanOut = demanders !== undefined &&
      demanders.some((d) => d.principal !== undefined)
    ? record !== undefined
      ? (record.fanOut ??= newFanOutNodeState())
      : newFanOutNodeState()
    : undefined;
  if (fanOut === undefined && record?.fanOut !== undefined) {
    // No demanders any more (or never a resolvable one): the node runs
    // as the wave-level fallback again and its subscription is that
    // run's; the ratchet is forgotten with the demand (re-learned by
    // the next probe — design §B1's "forgotten on park").
    record.fanOut = undefined;
  }

  const runOnce = (
    instance: FanOutInstance | undefined,
    causes: readonly IMemorySpaceAddress[] | undefined,
    startGen: number,
  ): Promise<{
    result: unknown;
    log: ReactivityLog | undefined;

    /** The run ended in `RetryImmediately` (an unresolved inSpace name):
     * its retry — if any budget is left — is QUEUED, never re-run in the
     * calling pass (see the fan-out loop's deferred set). */
    retryImmediately: boolean;
  }> => {
    const tx = state.runtime.edit({
      changeGroup: state.actionChangeGroups.get(action),
    });
    // §8.9.2 trigger reads: hand the addresses whose changes scheduled
    // this run to the transaction so flow-label derivation can taint its
    // writes even when this run's branch never re-reads them. Consumed
    // once per scheduling; a fanned-out instance run carries the causes
    // that dirtied ITS instance (B7) plus the untargeted ones. If a run
    // aborts and is retried (RetryImmediately, commit conflict) the
    // consumed addresses are restored below so the retry inherits them.
    if (causes !== undefined && causes.length > 0) {
      tx.addCfcTriggerReads(causes);
    }
    (tx.tx as { debugActionId?: string }).debugActionId = actionId;
    tx.tx.sourceAction = action;
    tx.tx.validateReactiveReads = true;
    // Server-execution v2 stage F (serving-loop.md §3d): a serving
    // runtime's installed stamper attaches the wave run context here —
    // the reactive-action choke point — so every scheduler-driven
    // derivation seals stamped. Stage P2-F/B: a demanded instance's run
    // carries the demand-supplied RESOLUTION identity and its instance
    // key, so its scoped addressing and basis rows classify under the
    // demanding principal's instance — and its ATTRIBUTION derives from
    // the scope the run discovers (protocol.md §1 as amended; design
    // §F), never eagerly from the pair. A no-op everywhere else (one
    // undefined check).
    state.runtime.stampServerRun(tx, {
      actionId,
      kind: "derivation",
      ...(instance !== undefined
        ? {
          scopeKeyIdentity: instance.identity,
          actionScopeKey: instance.key,
        }
        : {}),
    });
    const finishReads = readStatsEnabled
      ? startReadStats(
        tx,
        readAttemptsEnabled
          ? (reads) =>
            state.runtime.telemetry.submit({
              type: "scheduler.read-attempt",
              kind: "reactive",
              actionId,
              reads,
            })
          : undefined,
      )
      : undefined;
    const actionStartTime = performance.now();

    let result: any;
    let succeeded = false;
    return new Promise((resolve) => {
      let committedLog: ReactivityLog | undefined;
      let retryImmediately = false;
      const finalizeAction = (error?: unknown) => {
        const actionEndTime = performance.now();
        let reads: ActionReadStats | undefined;
        if (finishReads) {
          let dependencies = 0;
          try {
            const log = txToReactivityLog(tx);
            dependencies = sortAndCompactPaths(log.reads).length +
              sortAndCompactPaths(log.shallowReads, false).length;
          } finally {
            reads = finishReads(dependencies);
          }
        }
        finalizeSchedulerAction(state, {
          action,
          actionId,
          registrationToken,
          retryRegistration,
          tx,
          actionStartTime,
          actionEndTime,
          reads,
          registrationIsCurrent: () =>
            state.isDisposed?.() !== true &&
            record !== undefined &&
            record.registrationToken === registrationToken &&
            (state.nodes.effects.has(action) ||
              state.nodes.computations.has(action)),
          invalidCauses: causes,
          result,
          succeeded,
          error,
          resolve: (value) =>
            resolve({ result: value, log: committedLog, retryImmediately }),
          ...(fanOut !== undefined && instance !== undefined
            ? {
              fanOutRun: {
                state: fanOut,
                instance,
                startGen,
                collectLog: (log: ReactivityLog) => {
                  committedLog = log;
                },
                deferInstance: () => {
                  retryImmediately = true;
                },
              },
            }
            : {}),
        });
      };

      invokeReactiveAction({
        runtime: state.runtime,
        setExecutingAction: state.setExecutingAction,
        clearExecutingAction: state.clearExecutingAction,
      }, {
        action,
        actionId,
        tx,
        actionStartTime,
      })
        .then((invocation) => {
          if (invocation.ok) {
            succeeded = true;
            result = invocation.result;
            finalizeAction();
          } else {
            finalizeAction(invocation.error);
          }
        })
        .catch((error) => {
          finalizeAction(error);
        });
    });
  };

  const nextRunningPromise = (async () => {
    if (fanOut === undefined) {
      // The single wave-identity run: every client, the OFF arm, and a
      // served action nobody demands with an identity (the wave-level
      // fallback — design §B5's residual, counted at the seal when it
      // narrows).
      return (await runOnce(undefined, invalidCauses, 0)).result;
    }
    // The fan-out loop (design §B2/§B3): derive the instance set from
    // (ratchet × demanders), run the instances that are not current, and
    // re-derive after each run — a run that discovers narrowing moves
    // the ratchet, so its siblings APPEAR in the set and run in this
    // same pass (the discovery re-arm; W waits on them because they run
    // inside this running promise, which idle() awaits). Bounded: every
    // run marks its key clean unless a cause dirtied it meanwhile, the
    // ratchet moves at most twice per principal, and D is finite —
    // and a run that ends in `RetryImmediately` (an inSpace name that
    // did not resolve) leaves its key non-clean WITHOUT being re-run
    // here: it is DEFERRED for the rest of this pass and its retry rides
    // the queued execution `rescheduleActionForImmediateRetry` armed (a
    // macrotask boundary per attempt, the OFF arm's shape, bounded by
    // MAX_RETRIES_FOR_REACTIVE; exhausted → the accepted zombie, spec
    // §15 decision 9). Re-running it in-loop — the key never became
    // clean, so the set kept offering it — was an unbounded microtask
    // hot loop that starved the whole process's timers (independent
    // review F1: 2.2 M invocations in 25 s, no timer fired). Deferring
    // rather than breaking keeps the SIBLINGS running in this pass: one
    // principal's unresolvable name never starves another's instance.
    let lastResult: unknown;
    let ran = false;
    const deferred = new Set<ScopeKey>();
    // Deliberately NO cooperative macrotask yield between instance runs
    // (stage C tuning T3 considered and REJECTED it here): the settle
    // loop yields between ACTIONS (settle.ts); a yield inside this loop
    // let a run's own asynchronous seal refusal land mid-pass and dirty
    // its instance, which the next iteration's snapshot then re-ran in
    // THIS pass while the refusal's queued retry re-ran it again — two
    // durable emissions of one served event (executor-space-server's
    // LT6 early-emit arm caught it). The retry machinery's contract is
    // that a failed run's retry lands on the QUEUED pass, never this one;
    // the loop keeps its microtask shape so that holds. Cost: the flush
    // deadline is honest to within one action (all of its instance runs),
    // not one instance.
    for (;;) {
      const currentDemanders = state.runtime.serverRunDemandersFor(
        demandRootIds!,
      ) ?? [];
      const instances = fanOutInstances(fanOut, currentDemanders);
      pruneFanOutInstances(fanOut, instances);
      const toRun = fanOutInstancesToRun(fanOut, instances).filter(
        (instance) => !deferred.has(instance.key),
      );
      if (toRun.length === 0) break;
      const instance = toRun[0];
      const startGen = fanOutRunStarted(fanOut, instance);
      const causes = invalidCauses === undefined
        ? undefined
        : causesForInstance(invalidCauses, instance);
      const outcome = await runOnce(instance, causes, startGen);
      lastResult = outcome.result;
      ran = true;
      if (outcome.retryImmediately) deferred.add(instance.key);
    }
    if (ran || fanOut.instances.size > 0) {
      // The union of the instance runs' logs: each read carries ITS
      // instance (the transaction's stamped identity puts the scope key
      // on scoped addresses), so the trigger index registers N reads of
      // one doc — one per instance — and any instance's change wakes the
      // node; skipped (clean) instances keep their last log in the union
      // (B7), departed instances left it in the prune above.
      // sortAndCompactPaths keeps them apart by instance.
      logger.timeStart("scheduler", "run", "resubscribe");
      try {
        state.resubscribe(action, fanOutUnionLog(fanOut));
        retryRegistration.token ??= state.nodes.get(action)?.registrationToken;
      } finally {
        logger.timeEnd("scheduler", "run", "resubscribe");
      }
    }
    return lastResult;
  })();
  state.setRunningPromise(nextRunningPromise);

  return nextRunningPromise.then((result) => {
    logger.timeEnd("scheduler", "run");
    return result;
  });
}

/** B7: the causes a fanned-out instance run carries as its CFC trigger
 * reads — those that dirtied ITS instance (a keyed cause resolving on the
 * instance identity's own chain) plus every untargeted one. */
function causesForInstance(
  causes: readonly IMemorySpaceAddress[],
  instance: FanOutInstance,
): IMemorySpaceAddress[] {
  const chain = new Set<string>(["space"]);
  try {
    chain.add(resolveScopeKey("user", instance.identity));
    chain.add(resolveScopeKey("session", instance.identity));
  } catch {
    // whatever resolved is the chain
  }
  return causes.filter((cause) =>
    cause.scopeKey === undefined || chain.has(cause.scopeKey)
  );
}

/** One run of a fanned-out node (stage B): the node's fan-out record, the
 * instance this run served, its dirtiness generation at start, and the
 * sink for its committed log. Each run subscribes to the union of the
 * instance logs so its reads stay watched while later instances run. */
interface FanOutRunArgs {
  readonly state: FanOutNodeState;
  readonly instance: FanOutInstance;
  readonly startGen: number;
  readonly collectLog: (log: ReactivityLog) => void;

  /** The run ended in `RetryImmediately`: tell the loop not to offer this
   * instance again in the current pass (its retry, if any budget is
   * left, is queued — never re-run in-loop). */
  readonly deferInstance: () => void;
}

/** Disposes unavailable work and parks its still-live registration. */
function parkUnavailableRun(state: SchedulerActionRunState, args: {
  action: Action;
  tx: IExtendedStorageTransaction;
  registrationIsCurrent: () => boolean;
  resolve: (value: unknown) => void;
}): boolean {
  if (usesLocalReads(args.tx) && !args.registrationIsCurrent()) {
    if (args.tx.status().status === "ready") {
      args.tx.abort("local action registration retired");
    }
    releaseLocalReadBasis(args.tx);
    args.resolve(undefined);
    return true;
  }
  const unavailable = validateLocalReadBasis(args.tx);
  if (unavailable !== undefined) {
    const attempted = txToReactivityLog(args.tx);
    const log = {
      reads: [...attempted.reads, unavailable.address],
      shallowReads: attempted.shallowReads,
      writes: [],
    };
    if (args.tx.status().status === "ready") args.tx.abort(unavailable);
    if (!args.registrationIsCurrent()) {
      releaseLocalReadBasis(args.tx);
      args.resolve(undefined);
      return true;
    }
    state.pending.delete(args.action);
    state.parkLocalRead?.(args.action, log);
    state.nodes.setStatus(args.action, "unavailable");
    // Subscribe first, then recheck: delivery may have arrived during an await
    // after the failed read and before its wake subscription was installed.
    if (localReadsReady(args.tx)) {
      state.markInvalid(args.action);
      state.queueExecution();
    }
    releaseLocalReadBasis(args.tx);
    args.resolve(undefined);
    return true;
  }

  return false;
}

function finalizeSchedulerAction(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly registrationToken: object | undefined;
    readonly retryRegistration: { token: object | undefined };
    readonly tx: IExtendedStorageTransaction;
    readonly actionStartTime: number;
    readonly actionEndTime: number;
    readonly reads?: ActionReadStats;
    readonly registrationIsCurrent: () => boolean;
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
    readonly result: unknown;
    readonly succeeded: boolean;
    readonly error?: unknown;
    readonly resolve: (value: unknown) => void;
    readonly fanOutRun?: FanOutRunArgs;
  },
): void {
  if (parkUnavailableRun(state, args)) return;
  if (usesLocalReads(args.tx)) {
    const log = txToReactivityLog(args.tx);
    const address = log.reads[0] ?? log.shallowReads[0] ?? log.writes[0];
    if (address !== undefined) {
      requireLocalReadCondition(
        args.tx.tx,
        address,
        args.registrationIsCurrent,
      );
    }
  }

  // Record action execution time for cycle-aware scheduling
  const elapsed = args.actionEndTime - args.actionStartTime;
  recordActionTime(
    state.actionTimingState,
    args.action,
    elapsed,
    args.actionEndTime,
    args.reads,
  );
  state.runtime.telemetry.submit({
    type: "scheduler.run.complete",
    actionId: args.actionId,
    actionInfo: state.getActionTelemetryInfo(args.action),
    durationMs: elapsed,
    ...(args.reads
      ? {
        reads: args.reads,
        src: getAuthoredDebugSource(
          (args.action as Partial<TelemetryAnnotations>).module?.implementation,
        )?.src,
      }
      : {}),
    ...(args.error !== undefined
      ? { error: args.error instanceof Error ? args.error.message : "error" }
      : {}),
  });
  state.maybeAutoDebounce(args.action);
  state.markActionHasRun(args.action);
  state.markNodeHasRun(args.action);

  // A RetryImmediately signal means the action referenced an inSpace("name")
  // target that has now been resolved into the runtime cache. Abort this run's
  // transaction and re-run the action so it resolves the name synchronously.
  if (args.error instanceof RetryImmediately) {
    rescheduleActionForImmediateRetry(state, args);
    return;
  }

  try {
    if (args.error) {
      logger.error("schedule-error", () => [
        `[RUN] Action failed: ${args.actionId}`,
        `Error: ${args.error}`,
      ]);
      state.handleError(normalizeThrownError(args.error), args.action);
    }
  } finally {
    finalizeReactiveActionCommit(state, args, elapsed);
  }
}

function rescheduleActionForImmediateRetry(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
    readonly error?: unknown;
    readonly resolve: (value: unknown) => void;
    readonly fanOutRun?: FanOutRunArgs;
  },
): void {
  if (args.tx.status().status === "ready") args.tx.abort(args.error);
  // A fanned-out instance's aborted run is DEFERRED for the rest of the
  // calling pass — in both branches below (independent review F1): its
  // key stays non-clean either way, and the loop must not offer it again
  // until the queued retry (a macrotask away) or, once exhausted, the
  // next real invalidation. Note it BEFORE `resolve`, which is what
  // returns control to the loop.
  args.fanOutRun?.deferInstance();
  const retries = (state.retries.get(args.action) ?? 0) + 1;
  state.retries.set(args.action, retries);
  if (retries < MAX_RETRIES_FOR_REACTIVE) {
    // The retry run still exists only because of the consumed trigger
    // reads (§8.9.2); restore them so its transaction joins their labels.
    const record = state.nodes.get(args.action);
    if (
      record &&
      args.invalidCauses !== undefined &&
      args.invalidCauses.length > 0
    ) {
      restoreInvalidCauses(state.nodes, args.action, args.invalidCauses);
    }
    // A fanned-out instance's aborted run re-runs THAT instance (B7):
    // its key is dirtied, its siblings stay current — on the QUEUED
    // pass, never this one (deferred above).
    if (args.fanOutRun !== undefined) {
      dirtyFanOutKey(args.fanOutRun.state, args.fanOutRun.instance.key);
      state.markInvalid(args.action, { fanOutInstances: "keep" });
    } else {
      state.markInvalid(args.action);
    }
    state.pending.add(args.action);
    state.queueExecution();
  } else {
    // WATCH(scheduler-v2): exhausted retries can leave a piece registered
    // against rolled-back data (accepted zombie — spec §15 decision 9).
    // A fanned-out instance's exhausted key stays non-clean and unqueued:
    // it runs again on the node's next real invalidation, with a fresh
    // budget — the same "until its input data changes" shape as OFF's.
    state.retries.delete(args.action);
    abandonAction({
      action: args.action,
      tx: args.tx,
      getActionId: state.getActionId,
    }, args.error);
    logger.error(
      "schedule-error",
      `Action ${args.actionId} exhausted retries resolving inSpace names`,
    );
  }
  args.resolve(undefined);
}

function normalizeThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A commit rejection is a plain result object, not an Error, so the error
 * channel gets a constructed one preserving the rejection's name and, for a
 * CFC refusal, its structured `reasons` and `refusals` — the discriminants a
 * consumer needs to tell a policy refusal from a thrown computation, and the
 * remedy detail that names the inputs behind it. A thrown computation
 * carries a pattern frame the error decoration reads piece attribution from;
 * a commit rejection has none, so the attribution comes from the action's own
 * observation identity, with the scope prefix stripped back to the result
 * cell's id.
 */
function toTerminalRejectionError(error: unknown, action: Action): Error {
  const rejection = error as {
    name?: string;
    message?: string;
    reasons?: readonly string[];
    refusals?: readonly CfcRefusalDetail[];
  };
  const surfaced = new Error(
    typeof rejection?.message === "string" ? rejection.message : String(error),
  );
  if (typeof rejection?.name === "string") surfaced.name = rejection.name;
  if (rejection?.reasons !== undefined) {
    (surfaced as { reasons?: readonly string[] }).reasons = rejection.reasons;
  }
  if (rejection?.refusals !== undefined) {
    (surfaced as { refusals?: readonly CfcRefusalDetail[] }).refusals =
      rejection.refusals;
  }
  const identity = (action as Partial<TelemetryAnnotations>)
    .schedulerObservationIdentity;
  if (identity !== undefined) {
    const context = surfaced as Error & { pieceId?: string; space?: string };
    // `pieceRootId` is the raw result-cell id. `pieceId` is a SCOPE KEY plus
    // that id, and a scope key is not one segment — `user:<principal>` and
    // `session:<principal>:<sessionId>` both carry colons — so slicing at the
    // first one leaves principal segments on a scoped piece and misattributes
    // it.
    const rootId = identity.pieceRootId;
    if (rootId !== undefined) context.pieceId = rootId;
    if (identity.ownerSpace !== undefined) {
      context.space = identity.ownerSpace;
    }
  }
  return surfaced;
}

function finalizeReactiveActionCommit(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly registrationToken: object | undefined;
    readonly retryRegistration: { token: object | undefined };
    readonly registrationIsCurrent: () => boolean;
    readonly tx: IExtendedStorageTransaction;
    readonly invalidCauses: readonly IMemorySpaceAddress[] | undefined;
    readonly result: unknown;
    readonly succeeded: boolean;
    readonly error?: unknown;
    readonly resolve: (value: unknown) => void;
    readonly fanOutRun?: FanOutRunArgs;
  },
  elapsed: number,
): void {
  // Set up new reactive subscriptions after the action runs

  // Commit the transaction. The code continues synchronously after
  // kicking off the commit, i.e. it assumes the commit will be
  // successful. If it isn't, the data will be rolled back and all other
  // reactive functions based on it will be retriggered. But also, the
  // retry logic below will have re-scheduled this action, so
  // topological sorting should move it before the dependencies.
  let log: ReactivityLog | undefined;
  // Captured at commit kickoff (after prepareTxForCommit populates the CFC
  // outbox, before the async flush clears it): does this commit have
  // asynchronous post-commit work that `settled()` must wait on?
  let hasPostCommitEffects = false;
  const commitPromise = startReactiveActionCommit({
    runtime: state.runtime,
    tx: args.tx,
  }, {
    beforeCommit: () => {
      log = txToReactivityLog(args.tx);
      if (validateLocalReadBasis(args.tx) !== undefined) return;
      warnOnWriteSurfaceViolations(state, args, log);
      hasPostCommitEffects = args.tx.hasPendingPostCommitEffects();
      if (args.fanOutRun !== undefined) {
        // The DISCOVERY half of stage B's ratchet (design §B3): the run's
        // narrowest read scope — the transaction's ratchet, complete once
        // the body and its result write ran (the write path's diff-base
        // read at the narrower instance and identity consumption ratchet
        // it too) — is what this node has LEARNED. Read here, at commit
        // kickoff, before the asynchronous seal: a seal the wave refuses
        // still leaves the lesson (the retry runs at the moved ratchet).
        // The run's key at the (possibly moved) ratchet is marked clean
        // — unless a cause dirtied its stamped key while it ran — and
        // keeps this committed log for the union subscription (B7).
        fanOutRunFinished(args.fanOutRun.state, args.fanOutRun.instance, {
          discovered: normalizeCellScope(args.tx.getNarrowestReadScope()),
          startGen: args.fanOutRun.startGen,
          log,
        });
      }
    },
  });
  if (parkUnavailableRun(state, args)) return;
  if (!log) {
    throw new Error("scheduler action commit did not build a reactivity log");
  }
  // Track the effect layer as in-flight async builtin work so
  // `runtime.settled()` waits for the post-commit outbox flush (the sqlite
  // query RPC + writeback; also the barrier that guarantees a
  // fire-and-forget builtin's flush has registered its own network/LLM
  // work). The effect layer, not the commit promise: effects run at the
  // verdict, while the promise additionally waits for the subscribed view
  // to cover the write — an incoming-frame wait quiescence must not depend
  // on. Registered before this run's running promise resolves, so a reader
  // observes the settled result rather than racing the flush. `idle()`
  // deliberately stays free of this. Commits with no post-commit effects
  // keep the fire-and-forget fast path.
  if (hasPostCommitEffects) {
    state.runtime.trackAsyncWork(args.tx.postCommitEffectsSettled());
  }
  const committedLog = log;
  state.runtime.scheduler.recordViewActionOutcome(
    args.action,
    args.tx,
    committedLog,
    args.succeeded,
    commitPromise,
    args.error,
  );
  const fanOutRun = args.fanOutRun;
  const commitState: Parameters<typeof watchReactiveActionCommit>[0] = {
    isLiveAction: () => state.isLiveAction(args.action),
    hasCommittedResult: () => owner?.hasCommittedResult === true,
    canRetry: () =>
      !state.runtime.writeTeardownSignal.aborted &&
      state.isDisposed?.() !== true &&
      (args.retryRegistration.token === undefined ||
        (state.nodes.get(args.action)?.registrationToken ===
            args.retryRegistration.token &&
          (state.nodes.isEffect(args.action) ||
            state.nodes.isComputation(args.action)))),
    awaitRetryReadiness: (error) =>
      state.runtime.awaitCommitRetryReadiness(
        error,
        state.runtime.writeTeardownSignal,
      ),
    action: args.action,
    tx: args.tx,
    log: committedLog,
    retries: state.retries,
    offBudgetRetries: state.offBudgetRetries,
    pending: state.pending,
    commitPromise,
    onSuccess: () => {
      if (args.succeeded && owner !== undefined) {
        owner.hasCommittedResult = true;
      }
      state.runtime.scheduler.noteViewActionCurrent(args.action);
    },
    // A fanned-out instance's retry paths (a conflict, a refused seal —
    // the early-emit guard's fail-closed refusal among them) re-arm THAT
    // instance: its key is dirtied, its siblings stay current, and the
    // subscription refreshed here is the UNION of the instance logs (this
    // run's log is already recorded on the node) — never this one run's
    // log alone, which would replace the siblings' reads (F9's shape on
    // the retry paths, closed with B7).
    resubscribe: (target, log) => {
      state.resubscribe(
        target,
        fanOutRun === undefined ? log : fanOutUnionLog(fanOutRun.state),
      );
      args.retryRegistration.token ??= state.nodes.get(target)
        ?.registrationToken;
    },
    markInvalid: fanOutRun === undefined
      ? state.markInvalid
      : (target, options) => {
        dirtyFanOutKey(
          fanOutRun.state,
          keyAtRatchet(fanOutRun.state, fanOutRun.instance.identity) ??
            fanOutRun.instance.key,
        );
        state.markInvalid(target, { ...options, fanOutInstances: "keep" });
      },
    queueExecution: state.queueExecution,
    getActionId: state.getActionId,
    restoreInvalidCauses: () => {
      const record = state.nodes.get(args.action);
      if (
        record &&
        args.invalidCauses !== undefined &&
        args.invalidCauses.length > 0
      ) {
        restoreInvalidCauses(state.nodes, args.action, args.invalidCauses);
      }
    },
    handleUnavailable: () => parkUnavailableRun(state, args),
    reportTerminalRejection: (error) => state.handleError(error, args.action),
  };
  const handled = watchReactiveActionCommit(commitState);
  // The barrier entry commit() registered settles with the commit promise,
  // but the disposition above — a conflict's catch-up-then-requeue in
  // particular — runs afterwards. Register the handled chain too, so
  // idleWithPendingCommits cannot release in the window between a
  // rejection settling and its retry being requeued (the event path in
  // events.ts registers the same way).
  state.runtime.storageManager.trackPendingCommit(handled);

  logger.debug("schedule-run-complete", () => [
    `[RUN] Action completed: ${args.actionId}`,
    `Reads: ${committedLog.reads.length}`,
    `Writes: ${committedLog.writes.length}`,
    `Elapsed: ${elapsed.toFixed(2)}ms`,
  ]);

  recordOptionalActionRunDiagnostics(state, args, committedLog, elapsed);

  if (args.fanOutRun !== undefined) {
    args.fanOutRun.collectLog(committedLog);
  }
  {
    logger.timeStart("scheduler", "run", "resubscribe");
    try {
      // Each instance's commit and subscription share this synchronous turn;
      // later instances can await while these dependencies remain watched.
      state.resubscribe(
        args.action,
        fanOutRun === undefined
          ? committedLog
          : fanOutUnionLog(fanOutRun.state),
      );
      args.retryRegistration.token ??= state.nodes.get(args.action)
        ?.registrationToken;
    } finally {
      logger.timeEnd("scheduler", "run", "resubscribe");
    }
  }
  const node = state.nodes.get(args.action);
  const instanceRecord = fanOutRun === undefined
    ? undefined
    : fanOutRun.state.instances.get(
      keyAtRatchet(fanOutRun.state, fanOutRun.instance.identity) ??
        fanOutRun.instance.key,
    );
  const owner = fanOutRun === undefined ? node : instanceRecord;
  const registrationToken = args.registrationToken;
  // Sealing is not durable acceptance. A withdrawn contribution can have read
  // an unchanged field through another contribution's pending document; rolling
  // that document back produces no value change at the field to wake its reader.
  // Observe the rollback separately from the pending-commit barrier: the serving
  // loop must finish that barrier before it can commit the wave being observed.
  void commitPromise.then(async ({ error }) => {
    if (
      error !== undefined || owner === undefined || node === undefined ||
      node.registrationToken !== registrationToken
    ) return;
    const settlement = waveSettlementOf(args.tx);
    if (settlement === undefined) return;
    // A run with no contribution has no new publication. Only another sealed
    // contribution can supersede this run's recovery obligation, even if a
    // no-op refreshed reads.
    const token = {};
    owner.pendingWaveRun = token;
    const outcome = await settlement;
    if (owner.pendingWaveRun !== token) return;
    delete owner.pendingWaveRun;
    if (
      node.registrationToken !== registrationToken ||
      outcome.error?.readDependencyWithdrawn !== true ||
      outcome.error?.waveWithdrawalCause !== "contribution-dropped" ||
      (!state.nodes.isEffect(args.action) &&
        !state.nodes.isComputation(args.action))
    ) return;
    const record = state.nodes.get(args.action);
    const current = fanOutRun === undefined
      ? record === node
      : record?.fanOut === fanOutRun.state &&
        fanOutRun.state.instances.get(
            keyAtRatchet(fanOutRun.state, fanOutRun.instance.identity) ??
              fanOutRun.instance.key,
          ) === instanceRecord;
    if (!current || record === undefined) return;
    for (const cause of args.invalidCauses ?? []) {
      addInvalidCause(record, cause);
    }
    commitState.markInvalid(args.action, { retry: true });
    state.pending.add(args.action);
    state.queueExecution();
  }).catch((error) => {
    logger.error(
      "wave-withdrawal-rearm-failed",
      "Could not re-arm a withdrawn reactive run",
      error,
    );
  });
  args.resolve(args.result);
}

function warnOnWriteSurfaceViolations(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
  },
  log: ReactivityLog,
): void {
  if (state.nodes.isKnownEffect(args.action)) return;
  if ((state.getMaterializerWriteEnvelopes(args.action) ?? []).length > 0) {
    return;
  }

  const surface = state.getSchedulingWrites(args.action) ?? [];
  for (const write of log.writes) {
    // Per-user/per-session slots are runtime-mediated writes (scope-default
    // initialization, UI state) that authored surfaces do not declare —
    // exempt them so this declaration-gap diagnostic tracks authored
    // space-scoped writes only.
    // WATCH(scheduler-v2): re-include once scoped-slot writes are declared.
    if (normalizeCellScope(write.scope) !== "space") {
      continue;
    }
    if (
      surface.some((surfaceWrite) => surfaceCoversWrite(surfaceWrite, write))
    ) {
      continue;
    }
    // Declaration-gap diagnostics, not enforcement (work order 05 step 5) —
    // debug level because known gaps remain (builtins minting cause-keyed
    // internal docs inside their run, e.g. ifElse/unless/fetchJson) and
    // cf test fails tests on console warnings. Counted regardless of level:
    // assert via getLoggerCountsBreakdown().scheduler["write-surface-violation"].
    logger.debug("write-surface-violation", () => [
      `Action ${args.actionId} wrote outside its declared surface`,
      write,
    ]);
  }
}

function surfaceCoversWrite(
  surface: IMemorySpaceAddress,
  write: IMemorySpaceAddress,
): boolean {
  return surface.space === write.space &&
    surface.id === write.id &&
    normalizeCellScope(surface.scope) === normalizeCellScope(write.scope) &&
    surface.path.length <= write.path.length &&
    surface.path.every((segment, index) => segment === write.path[index]);
}

export function schedulerImplementationFingerprint(
  action: Action,
  actionId: string,
  telemetry: SchedulerActionInfo | undefined,
): string {
  // The implementation FINGERPRINT is the per-module content-addressed identity
  // `cf:module/<hash>:<symbol>` — stable across reloads, entry points, and TCB
  // upgrades (see docs/specs/content-addressed-action-identity.md). It is
  // deliberately per-SYMBOL (it identifies the implementation code), with NO
  // per-instance key — unlike the action id (`getSchedulerActionId`). It is
  // read from the stamp set at action creation (`applyImplementationHash`) —
  // the single identity channel; no re-derivation here, and `.src` is never
  // consulted (the prior `src:` fallback depended on the source-map path).
  const implementationHash = (action as { implementationHash?: unknown })
    .implementationHash;
  if (typeof implementationHash === "string" && implementationHash.length > 0) {
    return `impl:${implementationHash}`;
  }
  const telemetryId = [
    telemetry?.patternName,
    telemetry?.moduleName,
  ].filter((part): part is string => !!part).join(":") || `action:${actionId}`;
  return `action:${telemetryId}:${actionId}`;
}

export function schedulerRuntimeFingerprint(): string {
  return "runner:scheduler:v3";
}

function recordOptionalActionRunDiagnostics(
  state: SchedulerActionRunState,
  args: {
    readonly action: Action;
    readonly actionId: string;
    readonly tx: IExtendedStorageTransaction;
    readonly fanOutRun?: FanOutRunArgs;
  },
  log: ReactivityLog,
  elapsed: number,
): void {
  if (state.getCollectActionRunTrace()) {
    appendActionRunTrace({
      actionRunTrace: state.actionRunTrace,
      nodes: state.nodes,
      getActionId: state.getActionId,
      getSchedulingWrites: state.getSchedulingWrites,
    }, {
      action: args.action,
      actionId: args.actionId,
      durationMs: elapsed,
      log,
      // Stage B: the instance a fanned-out run served (its stamped key),
      // so a trace reader can attribute runs per instance.
      ...(args.fanOutRun !== undefined
        ? { instanceKey: args.fanOutRun.instance.key }
        : {}),
    });
  }

  // Diagnosis capture: record read/write values for idempotency checking
  if (state.getDiagnosisEnabled()) {
    captureDiagnosisRecord({
      diagnosisHistory: state.diagnosisHistory,
      diagnosisNonIdempotent: state.diagnosisNonIdempotent,
      createReadTx: () => state.runtime.edit(),
      getActionTelemetryInfo: state.getActionTelemetryInfo,
    }, {
      actionId: args.actionId,
      action: args.action,
      tx: args.tx,
      log,
    });
  }

  // Inline idempotency re-run: when the mode is on, every
  // computation gets a second synchronous run against post-commit
  // state. An idempotent computation produces the same writes
  // both times. Uses the registry's known kind (persists past unsubscribe)
  // since execute() calls unsubscribe() before run().
  if (
    state.getIdempotencyCheckMode() &&
    !state.nodes.isKnownEffect(args.action)
  ) {
    logger.timeStart("scheduler", "run", "idempotencyRecheck");
    try {
      runIdempotencyRecheck(
        {
          idempotencyViolations: state.idempotencyViolations,
          // The recheck re-runs the action only to compare its writes with the
          // run that already happened, then throws the transaction away.
          createTx: () => createDuplicateWorkTransaction(state.runtime.edit()),
          invoke: (fn) => state.runtime.harness.invoke(fn),
          getActionId: state.getActionId,
          getActionTelemetryInfo: state.getActionTelemetryInfo,
        },
        args.action,
        args.tx,
        log,
      );
    } finally {
      logger.timeEnd("scheduler", "run", "idempotencyRecheck");
    }
  }
}
