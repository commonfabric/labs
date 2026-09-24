import { getLogger } from "@commonfabric/utils/logger";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { createRef } from "../create-ref.ts";
import { toURI } from "../uri-utils.ts";
import { loadStoredCfcEnvelope } from "../cfc/prepare.ts";
import {
  recordTrustedEventPolicyInputs,
  type StoredSchemaResolver,
} from "../cfc/ui-contract.ts";
import type { Cancel } from "../cancel.ts";
import {
  ensurePieceRunningVerdict,
  type EnsurePieceVerdict,
} from "../ensure-piece-running.ts";
import { waveRunContextOf, waveSettlementOf } from "../executor/wave.ts";
import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
} from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IPreconditionFailedError,
  MemorySpace,
} from "../storage/interface.ts";
import {
  localReadFailure,
  releaseLocalReadBasis,
  validateLocalReadBasis,
} from "../storage/local-read-policy.ts";
import {
  isConflictRejection,
  isPermanentRejection,
  isStorageTransactionInconsistent,
  isTerminalRejection,
} from "../storage/rejection.ts";
import {
  type CommitBackpressurePolicy,
  CommitConvergenceError,
  computeBackoffDelayMs,
  EventHandlerNotRunError,
  HANDLER_NOT_RUN_BACKOFF_LIMIT,
} from "./backpressure.ts";
import type {
  SchedulerActionInfo,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";
import { MAX_EVENT_BACKLOG_PER_STREAM } from "./constants.ts";
import { createEventPreflightTraceContext } from "./diagnostics.ts";
import { mintEventId } from "./event-identity.ts";
import { planEventInvalidDependencyScheduling } from "./execution.ts";
import type { OriginStatus } from "./lineage.ts";
import type { NodeRegistry } from "./node-record.ts";
import { RetryImmediately } from "./retry-immediately.ts";
import {
  hasAnnotatedWrites,
  trustedEventWriteCandidatesFromTransaction,
  txToReactivityLog,
} from "./reactivity.ts";
import {
  isCfcRejectedCommitError,
  reportDroppedCfcRejectedWrite,
} from "./cfc-rejection-report.ts";
import {
  type Action,
  type EventHandler,
  type EventPreflightTraceContext,
  LT1_LATE_SEAL_REFUSED,
  type QueuedEvent,
  type ReactivityLog,
  type ServedEventFailureOutcome,
  type TelemetryAnnotations,
} from "./types.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});
const EVENT_COMMIT_TELEMETRY_WRITE_LIMIT = 25;

const guardedImplementations = Symbol("guarded event implementations");

type GuardedDispatcher = EventHandler & {
  [guardedImplementations]: {
    implementations: Map<string, { handler: EventHandler }>;
    current(): EventHandler | undefined;
  };
};

/** Whether a registered callback dispatches among guarded implementations. */
function isGuardedDispatcher(
  handler: EventHandler,
): handler is GuardedDispatcher {
  return guardedImplementations in handler;
}

/** Enumerates the implementations retained by a live stream registration. */
export function eventHandlerImplementations(
  handler: EventHandler,
): readonly EventHandler[] {
  if (!isGuardedDispatcher(handler)) return [handler];
  return [...handler[guardedImplementations].implementations.values()]
    .map(({ handler }) => handler);
}

/** Resolve exactly one implementation while recording every selector read. */
export function selectEventImplementation(
  handler: EventHandler,
  tx: IExtendedStorageTransaction,
): EventHandler | undefined {
  if (!isGuardedDispatcher(handler)) return handler;
  const registration = handler[guardedImplementations];
  const current = registration.current();
  if (current !== handler) {
    return current === undefined
      ? undefined
      : selectEventImplementation(current, tx);
  }
  let selected: EventHandler | undefined;
  let ambiguous = false;
  for (
    const { handler: implementation } of registration.implementations.values()
  ) {
    if (implementation.implementationSelection!.matches(tx)) {
      if (selected !== undefined) ambiguous = true;
      selected = implementation;
    }
  }
  return ambiguous ? undefined : selected;
}

/** Stable queued callback whose selection follows the live stream registry. */
function createGuardedDispatcher(
  ref: NormalizedFullLink,
  eventHandlers: readonly [NormalizedFullLink, EventHandler][],
): GuardedDispatcher {
  const dispatcher: GuardedDispatcher = Object.assign(
    (tx: IExtendedStorageTransaction, event: unknown) => {
      const implementation = selectEventImplementation(dispatcher, tx);
      if (implementation === undefined) {
        tx.dispatchedHandlerNotRun = {
          reason: "no unique event implementation matches the current program",
        };
        return;
      }
      return implementation(tx, event);
    },
    {
      [guardedImplementations]: {
        implementations: new Map<string, { handler: EventHandler }>(),
        current: () => findEventHandler(eventHandlers, ref),
      },
    },
  );
  Object.defineProperty(dispatcher, "name", {
    value: `event-dispatcher:${toURI(createRef(ref, "event dispatcher"))}`,
  });
  Object.defineProperty(dispatcher, "schedulerObservationIdentity", {
    get: () => {
      const registration = dispatcher[guardedImplementations];
      const current = registration.current();
      if (current !== dispatcher) {
        return (current as Partial<TelemetryAnnotations> | undefined)
          ?.schedulerObservationIdentity;
      }
      const identities = [...registration.implementations.values()].flatMap(
        ({ handler }) => {
          const identity = (handler as Partial<TelemetryAnnotations>)
            .schedulerObservationIdentity;
          return identity === undefined ? [] : [identity];
        },
      );
      if (identities.length <= 1) return identities[0];
      // A queued event supplies its actor to every candidate root before
      // selection: the selector itself can need that actor's cold inputs.
      // Dispatch and its diagnostics use the selected handler's own identity.
      return {
        ...identities[0],
        demandRootIds: [
          ...new Set(identities.flatMap((identity) =>
            identity.demandRootIds ??
              (identity.pieceRootId === undefined ? [] : [identity.pieceRootId])
          )),
        ],
      };
    },
  });
  dispatcher.populateDependencies = (tx, event) => {
    selectEventImplementation(dispatcher, tx)?.populateDependencies?.(
      tx,
      event,
    );
  };
  return dispatcher;
}

/** The actor used by both selection probes and the eventual stamped dispatch. */
function eventScopeIdentity(event: QueuedEvent): ScopeKeyIdentity | undefined {
  const firedAt = event.served?.firedAt;
  if (firedAt !== undefined) {
    return {
      principal: firedAt.user,
      sessionId: firedAt.session === "server" ? undefined : firedAt.session,
    } as ScopeKeyIdentity;
  }
  return event.originTx !== undefined
    ? waveRunContextOf(event.originTx)?.scopeKeyIdentity
    : undefined;
}

type EventCommitError = {
  readonly name?: string;
  readonly message: string;
  readonly precondition?: IPreconditionFailedError["precondition"];
};

/**
 * The error handed to work staged on an event's transaction when the event ends
 * without a commit verdict at all — the handler threw, the caller opted out of
 * retrying, or the seal was refused. There is no rejection to pass on in those
 * cases, and the staged work needs to hear that none is coming.
 */
function eventAbandonError(reason: string): CommitError {
  return {
    name: "StorageTransactionAborted",
    message: `event abandoned before it committed: ${reason}`,
    reason: new Error(reason),
  } as CommitError;
}

/**
 * Reads each written document's stored envelope through `tx` exactly as the
 * commit boundary loads it, so the trusted-event recorder finds the contract
 * the boundary will verify. An envelope that does not load reads as none
 * here; the boundary refuses the write on its own. Nothing is read once `tx`
 * is no longer open: a handler that aborted it commits nothing, and the
 * abort it reported is the outcome to keep.
 */
function storedSchemaIn(tx: IExtendedStorageTransaction): StoredSchemaResolver {
  return (write) => {
    if (tx.status().status !== "ready") return undefined;
    const stored = loadStoredCfcEnvelope(tx, write);
    return stored.status === "loaded" ? stored.schema : undefined;
  };
}

function normalizeEventCommitRejection(reason: unknown): EventCommitError {
  if (reason instanceof Error) {
    return reason as EventCommitError;
  }
  if (isObjectOrArray(reason)) {
    const candidate = reason as Partial<EventCommitError>;
    const precondition = candidate.precondition === "origin-committed" ||
        candidate.precondition === "receipt-exists"
      ? candidate.precondition
      : undefined;
    return {
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      message: typeof candidate.message === "string"
        ? candidate.message
        : "Storage commit promise rejected",
      ...(precondition ? { precondition } : {}),
    };
  }
  return new Error(
    reason
      ? String(reason)
      : "Storage commit promise rejected without a reason",
  );
}

/** Report a served event's durable outcome without letting an observer failure
 * escape into scheduler control flow. The callback is notification-only: a
 * broken observer must neither change the event disposition nor skip later
 * settlement work. */
export function reportServedEventFailure(
  served: Pick<NonNullable<QueuedEvent["served"]>, "onFailure"> | undefined,
  outcome: ServedEventFailureOutcome,
): void {
  try {
    served?.onFailure?.(outcome);
  } catch (callbackError) {
    logger.error(
      "schedule-error",
      "Error in served event failure callback:",
      callbackError,
    );
  }
}

/** Whether a failed event transaction carries positive producer evidence that
 * an explicit local abort discarded it before storage. Other errors in the
 * same family can describe ambiguous commit failures and are not terminal
 * evidence. */
export function isExplicitTransactionAbort(
  error:
    | { name?: string; message?: string; abortedBeforeStorage?: unknown }
    | undefined,
): error is {
  name: "StorageTransactionAborted";
  abortedBeforeStorage: true;
} {
  return error?.name === "StorageTransactionAborted" &&
    error.abortedBeforeStorage === true;
}

export function isHeadEventParked(
  state: { readonly eventQueue: readonly QueuedEvent[] },
  now: number = performance.now(),
): boolean {
  const headEvent = state.eventQueue[0];
  return headEvent?.handlerLoadPending === true ||
    headEvent?.retryReadinessPending === true ||
    (headEvent?.notBefore !== undefined && headEvent.notBefore > now);
}

export interface EventDependencyPreflightResult {
  shouldSkipEvent: boolean;
  deps: ReactivityLog;
  invalidDeps: Set<Action>;
  hasInvalidDependencies: boolean;
  dirtySizeBefore: number;
  pendingSizeBefore: number;
  populateMs: number;
  txToLogMs: number;
  depCommitMs: number;
  collectMs: number;
  scheduleMs: number;
  preflightStats: EventPreflightTraceContext;
}

export interface SchedulerEventQueueState {
  readonly runtime: Runtime;
  readonly eventHandlers: readonly [NormalizedFullLink, EventHandler][];
  readonly eventQueue: QueuedEvent[];
  readonly backgroundTasks: Set<Promise<unknown>>;
  readonly loadPieceForEvent?: (
    runtime: Runtime,
    eventLink: NormalizedFullLink,
  ) => Promise<EnsurePieceVerdict>;
  readonly queueExecution: () => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly releaseLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
}

/**
 * Settle an event that will never be dispatched. The onCommit contract is that
 * it runs after the final outcome of the event, including failure — a dropped
 * event is such an outcome. Callers awaiting onCommit (e.g. stream.send with a
 * commit callback) would otherwise wait forever; that is how a space whose
 * default pattern fails to instantiate turned `cf piece new` into an
 * indefinite hang. The callback receives an aborted transaction so
 * `tx.status()` reports `error` with the drop reason.
 */
function notifyEventDropped(
  state: Pick<SchedulerEventQueueState, "runtime">,
  args: {
    readonly eventLink: NormalizedFullLink;
    readonly onCommit?: QueuedEvent["onCommit"];
    readonly served?: QueuedEvent["served"];
  },
  reason: string,
  servedKind: "dropped" | "deferred" = "dropped",
  options: {
    quiet?: boolean;
    servedOutcome?: ServedEventFailureOutcome;

    /** The transaction the callback settles on, when the drop has one:
     * a dispatched attempt whose commit was refused. Absent, an aborted
     * one is minted for it. */
    callbackTx?: IExtendedStorageTransaction;
  } = {},
): void {
  if (options.quiet === true) {
    // A routine, counted pre-dispatch removal (the serving loop's LT1
    // leftover purge, stage C build W3): debug, not warn.
    logger.debug("scheduler", () => [reason, { eventLink: args.eventLink }]);
  } else {
    logger.warn("scheduler", reason, { eventLink: args.eventLink });
  }
  // The serving drain's terminal arms (events.md §5): `dropped` — no
  // runnable handler, the drain writes the dropped-event notice as the
  // event's consequence and advances the stream past it (non-wedging);
  // `deferred` — the handler was UNREACHABLE (a cold-view load, or a
  // required replica load that failed at the dispatch preflight's
  // park), no consequence is written and a later wave re-drains the
  // entry. `cause` tells the two deferrals apart for the drain's retry
  // budget (see ServedEventDispatch.onFailure).
  const outcome: ServedEventFailureOutcome = options.servedOutcome ??
    (servedKind === "dropped"
      ? { kind: "dropped", message: reason }
      : { kind: "deferred", message: reason });
  reportServedEventFailure(args.served, outcome);
  if (!args.onCommit) return;
  let tx = options.callbackTx;
  if (tx === undefined) {
    tx = state.runtime.edit();
    tx.abort(new Error(reason));
  }
  try {
    args.onCommit(tx);
  } catch (callbackError) {
    logger.error(
      "schedule-error",
      "Error in event commit callback:",
      callbackError,
    );
  }
}

/**
 * Remove and settle a queued event that will never dispatch. All pre-dispatch
 * cancellation paths use this chokepoint so lineage cancellation, piece-load
 * failure, dependency-preflight failure, and load-gate failure cannot leave an
 * onCommit waiter hanging or notify it twice.
 */
export function dropQueuedEvent(
  state:
    & Pick<SchedulerEventQueueState, "runtime" | "eventQueue">
    & Partial<Pick<SchedulerEventQueueState, "releaseLineageEvent">>,
  event: QueuedEvent,
  reason: string,
  servedKind: "dropped" | "deferred" = "dropped",
  options: {
    quiet?: boolean;
    servedOutcome?: ServedEventFailureOutcome;
    callbackTx?: IExtendedStorageTransaction;
  } = {},
): void {
  const index = state.eventQueue.indexOf(event);
  if (index >= 0) state.eventQueue.splice(index, 1);
  if (event.originTx !== undefined) {
    state.releaseLineageEvent?.(event.originTx, event);
  }
  if (event.finalOutcomeNotified) return;
  event.finalOutcomeNotified = true;
  notifyEventDropped(state, event, reason, servedKind, options);
}

/**
 * events.md §2's per-space ARRIVAL-ORDER BARRIER, carried by a deferral
 * (the in-queue sweep `failHeadEventLoadPark` performs in facade.ts,
 * shared here by the deferral arms that live in this module — the
 * handler-not-run withdrawal and the piece-start deferral): when a
 * served event DEFERS — its durable entry left pending for a later
 * drain — every later-arrived durable served entry queued behind it in
 * the SAME SPACE defers with it, or a later arrival's consequence lands
 * ahead of an earlier one (the b01 register class, re-demonstrated on
 * the handler-not-run withdrawal as review-6459 F1: the drain queues a
 * pass's pending entries together, so a healthy follower dispatches —
 * and SEALS — right behind the deferred head). The exclusions mirror
 * the load-park arm's, deliberately: cross-space queue neighbours
 * (§2's order is per-space) and LT1 in-process copies (`served` with
 * no `streamEntry`) — a running event's same-wave cascade children,
 * not later arrivals. The enqueueSeq guard scopes the sweep to LATER
 * arrivals, which the facade arm gets implicitly (its failing event is
 * the un-dispatched queue head, so everything queued is later): these
 * arms run after the deferring event left the queue (dispatch) or off
 * the head slot (piece load), and an earlier event requeued by a
 * concurrent commit verdict must not be barred behind an event that
 * arrived after it. Sweeping is order-safe by construction — a swept
 * entry re-drains in arrival order on a later pass — so a spurious
 * sweep costs one deferral round, never disorder.
 */
export function deferLaterSameSpaceServedEvents(
  state:
    & Pick<SchedulerEventQueueState, "runtime" | "eventQueue">
    & Partial<Pick<SchedulerEventQueueState, "releaseLineageEvent">>,
  behind: Pick<QueuedEvent, "id" | "eventLink" | "enqueueSeq">,
  deferralReason: string,
): void {
  for (const later of [...state.eventQueue]) {
    if (later.eventLink.space !== behind.eventLink.space) continue;
    if (later.served?.streamEntry === undefined) continue;
    if (later.enqueueSeq <= behind.enqueueSeq) continue;
    dropQueuedEvent(
      state,
      later,
      `Event deferred: held behind ${behind.id}, ${deferralReason}; ` +
        `later-arrived events wait behind it`,
      "deferred",
      {
        quiet: true,
        servedOutcome: {
          kind: "deferred",
          cause: "arrival-barrier",
          blockedBy: behind.id,
        },
      },
    );
  }
}

function findEventHandler(
  handlers: readonly [NormalizedFullLink, EventHandler][],
  eventLink: NormalizedFullLink,
): EventHandler | undefined {
  return handlers.find(([link]) => areNormalizedLinksSame(link, eventLink))
    ?.[1];
}

// Source of QueuedEvent.enqueueSeq stamps. Process-global monotonicity is a
// superset of the per-queue monotonicity the ordered requeue insert needs.
let nextEnqueueSeq = 1;

/**
 * Returns a retried event to its original dispatch slot: before the first
 * queued event with a later enqueue stamp. A plain unshift is only order-
 * preserving while a single (head) event is in failure at a time; with
 * commits not awaited, several in-flight events can be rejected together,
 * and unshifting each as its verdict arrives would make the LAST-rejected
 * event the new head regardless of send order.
 */
function insertInEnqueueOrder(
  queue: QueuedEvent[],
  event: QueuedEvent,
): void {
  let index = 0;
  while (index < queue.length && queue[index].enqueueSeq < event.enqueueSeq) {
    index++;
  }
  queue.splice(index, 0, event);
}

function readyQueuedEvent(args: {
  readonly id: string;
  readonly eventLink: NormalizedFullLink;
  readonly event: unknown;
  readonly handler: EventHandler;
  readonly retries: boolean;
  readonly onCommit?: QueuedEvent["onCommit"];
  readonly eventId?: string;
  readonly originTx?: IExtendedStorageTransaction;
  readonly time?: number;
  readonly runtimeInjectedEventKeys?: readonly string[];
  readonly served?: QueuedEvent["served"];
  readonly parentEventId?: string;
}): QueuedEvent {
  return {
    id: args.id,
    ...(args.eventId !== undefined ? { callerSuppliedId: true } : {}),
    enqueueSeq: nextEnqueueSeq++,
    time: args.time,
    originTx: args.originTx,
    eventLink: args.eventLink,
    action: (tx) => args.handler(tx, args.event),
    handler: args.handler,
    event: args.event,
    runtimeInjectedEventKeys: args.runtimeInjectedEventKeys,
    retry: args.retries,
    onCommit: args.onCommit,
    served: args.served,
    parentEventId: args.parentEventId,
  };
}

type OnCommit = NonNullable<QueuedEvent["onCommit"]>;

// A commit callback that runs a flat list of callbacks in order, isolating each
// throw so one failure neither skips the rest nor propagates to the caller.
interface ChainedOnCommit extends OnCommit {
  callbacks: OnCommit[];
}

function isChainedOnCommit(fn: OnCommit): fn is ChainedOnCommit {
  return Array.isArray((fn as Partial<ChainedOnCommit>).callbacks);
}

// Combine two commit callbacks. Chaining APPENDS to a flat list rather than
// nesting closures: a stream that collapses many times under the W4 backlog cap
// (all same-origin, so each overflow chains onto the surviving entry) would
// otherwise build a deeply nested chain that recurses once per collapse when it
// finally runs, overflowing the stack for a large enough burst. The flat list
// runs iteratively, so the depth is constant regardless of how many callbacks
// were chained.
function chainOnCommit(
  a: QueuedEvent["onCommit"],
  b: QueuedEvent["onCommit"],
): QueuedEvent["onCommit"] {
  if (!a) return b;
  if (!b) return a;
  if (isChainedOnCommit(a)) {
    a.callbacks.push(b);
    return a;
  }
  const callbacks: OnCommit[] = [a, b];
  const chained = ((tx) => {
    for (const callback of callbacks) {
      try {
        callback(tx);
      } catch (error) {
        logger.error("onCommit-callback-error", () => [error]);
      }
    }
  }) as ChainedOnCommit;
  chained.callbacks = callbacks;
  return chained;
}

export function queueSchedulerEvent(state: SchedulerEventQueueState, args: {
  readonly eventLink: NormalizedFullLink;
  readonly event: unknown;
  readonly retries: boolean;
  readonly onCommit?: QueuedEvent["onCommit"];
  readonly doNotLoadPieceIfNotRunning: boolean;
  readonly eventId?: string;
  readonly originTx?: IExtendedStorageTransaction;
  readonly time?: number;
  readonly runtimeInjectedEventKeys?: readonly string[];
  readonly served?: QueuedEvent["served"];
  readonly parentEventId?: string;
}): void {
  // `eventId` here is an already-durable delivery id, used verbatim — an
  // ingress caller's opaque idempotency key is bound to its stream earlier,
  // at the send surface (cell.ts), via scopeCallerEventId.
  const id = args.eventId ?? mintEventId(args.eventLink, args.originTx);
  const handler = findEventHandler(state.eventHandlers, args.eventLink);

  if (handler) {
    // W4: bound the per-(stream, handler) in-queue backlog. Below the cap,
    // events queue normally (ordinary delivery is unchanged); at the cap,
    // collapse the newest into the last pending entry (last-wins) instead of
    // growing the backlog, so a pattern cannot observe an unbounded post-block
    // event count.
    //
    // Caller-supplied durable ids are excluded from that merge in BOTH
    // directions. The handling's receipt address derives from the delivery id
    // (spec §7.6), so collapsing such an event away would leave its receipt
    // address never written — a later same-pair retry would find no receipt
    // and re-execute instead of deduplicating — and rewriting a queued
    // caller-id entry's payload would durably record a result its owner never
    // sent. At the cap a caller-id send coalesces onto an already-queued entry
    // with the SAME delivery id (the same invocation; first payload wins,
    // matching the create-only receipt arbitration the pair gets after
    // dispatch) and is otherwise refused loudly before dispatch.
    if (
      // The matching (stream, handler) count can only reach the cap once the
      // whole queue is at it, so this O(queue) scan runs only after a backlog
      // has already formed — ordinary enqueue stays O(1).
      state.eventQueue.length >= MAX_EVENT_BACKLOG_PER_STREAM &&
      // Events-down (server-execution v2 Phase 3; events.md §2): the
      // last-wins collapse would DESTROY durable intent ids — the root
      // fire's committed append id, a cascade id bound for
      // `consequenceOf` — so under the flag collapse is DISABLED and
      // backpressure is shaped at the binding layer instead (README
      // §3.8; ledger L8 records the collapse-but-list alternative).
      state.runtime.experimental.serverExecution !== true
    ) {
      let pending = 0;
      let lastSameOrigin: QueuedEvent | undefined;
      let sameDeliveryId: QueuedEvent | undefined;
      for (const q of state.eventQueue) {
        if (
          q.handler === handler &&
          areNormalizedLinksSame(q.eventLink, args.eventLink)
        ) {
          pending++;
          if (args.eventId !== undefined && q.id === id) sameDeliveryId = q;
          // Collapse only within the same origin transaction. Coalescing an
          // event from a different origin would misattribute speculation
          // lineage: the surviving entry keeps its original originTx, so the
          // single dispatch-time release would key off the wrong origin. A
          // caller-id entry is never the survivor either — last-wins would
          // rewrite the payload its receipt is about to witness.
          if (q.originTx === args.originTx && q.callerSuppliedId !== true) {
            lastSameOrigin = q;
          }
        }
      }
      if (
        pending >= MAX_EVENT_BACKLOG_PER_STREAM && args.eventId !== undefined
      ) {
        if (
          sameDeliveryId !== undefined &&
          sameDeliveryId.originTx === args.originTx
        ) {
          // The same invocation is already pending: ride it rather than refuse
          // it. First payload wins — after dispatch, a differing retry payload
          // would lose the create-only receipt race and read the original back
          // anyway — and both senders settle on that one outcome.
          sameDeliveryId.onCommit = chainOnCommit(
            sameDeliveryId.onCommit,
            args.onCommit,
          );
          state.queueExecution();
          return;
        }
        notifyEventDropped(
          state,
          args,
          `Event backlog for this stream is full ` +
            `(${MAX_EVENT_BACKLOG_PER_STREAM} pending), so this send was ` +
            `refused before dispatch: nothing executed, no receipt was ` +
            `created, and the same invocation id is safe to send again once ` +
            `the backlog drains.`,
        );
        return;
      }
      if (
        pending >= MAX_EVENT_BACKLOG_PER_STREAM &&
        lastSameOrigin !== undefined
      ) {
        // Collapse is silent by design. A per-collapse log here would fire on
        // every enqueue during an adversarial burst, turning observability
        // into a log-flood amplifier; any telemetry added later must be
        // rate-limited.
        lastSameOrigin.event = args.event;
        lastSameOrigin.action = (tx) => handler(tx, args.event);
        // Last-wins takes the newest event's injection provenance with its
        // payload — the marker must describe the payload that dispatches.
        lastSameOrigin.runtimeInjectedEventKeys = args.runtimeInjectedEventKeys;
        // Last-wins takes the newest event's time too, so the dispatched
        // handler's clock reflects the event it actually runs. For a same-origin
        // handler flood every collapsed event already shares one frozen instant,
        // so this is a no-op there; it matters for origin-less events (bare
        // `queueEvent` / internal sends, which share the `undefined` origin but
        // carry distinct fresh instants).
        lastSameOrigin.time = args.time;
        lastSameOrigin.onCommit = chainOnCommit(
          lastSameOrigin.onCommit,
          args.onCommit,
        );
        if (args.originTx !== undefined) {
          // Same origin as the surviving entry, so this re-record is idempotent.
          state.recordLineageEvent(args.originTx, lastSameOrigin);
        }
        state.queueExecution();
        return;
      }
    }
    const queuedEvent = readyQueuedEvent({ ...args, id, handler });
    state.eventQueue.push(queuedEvent);
    if (args.originTx !== undefined) {
      state.recordLineageEvent(args.originTx, queuedEvent);
    }
    state.queueExecution();
    return;
  }

  // If no handler was found, try to start the piece that should handle this event.
  if (!args.doNotLoadPieceIfNotRunning) {
    // Reserve the FIFO position before starting asynchronous work. The
    // placeholder is hydrated in place once the handler exists, so a later
    // event with an already-registered handler cannot overtake this one.
    const unavailableHandler: EventHandler = () => {
      throw new Error(`Event ${id} dispatched before its handler loaded`);
    };
    const queuedEvent = readyQueuedEvent({
      ...args,
      id,
      handler: unavailableHandler,
    });
    queuedEvent.handlerLoadPending = true;
    state.eventQueue.push(queuedEvent);
    if (args.originTx !== undefined) {
      state.recordLineageEvent(args.originTx, queuedEvent);
    }
    state.queueExecution();

    const startTask = (async () => {
      try {
        const verdict = await (state.loadPieceForEvent ??
          ensurePieceRunningVerdict)(
            state.runtime,
            args.eventLink,
          );
        // The origin may have failed while the piece was loading.
        if (
          queuedEvent.finalOutcomeNotified ||
          !state.eventQueue.includes(queuedEvent)
        ) return;

        const loadedHandler = findEventHandler(
          state.eventHandlers,
          args.eventLink,
        );
        if (loadedHandler) {
          queuedEvent.handler = loadedHandler;
          queuedEvent.action = (tx) => loadedHandler(tx, args.event);
          delete queuedEvent.handlerLoadPending;
        } else if (
          verdict.started && verdict.graphIsInstalled?.() !== false
        ) {
          // The piece is running with its pattern graph installed and
          // registered NOTHING for this stream — events.md §5's drop
          // predicate ("no runnable handler"). A verdict carrying no
          // graph probe reads as installed: only a start walk mints
          // one, and its absence says nothing about the piece.
          dropQueuedEvent(
            state,
            queuedEvent,
            `Event dropped: no handler registered for ${args.eventLink.id} after starting its piece`,
          );
        } else {
          // Either the piece could not be STARTED, or it has no
          // pattern graph installed: a refused instantiation commit
          // retires the graph the start walk installed, and the runner
          // then either re-instantiates once from a caught-up view or
          // retires the registration with it. The walk ran before any
          // of that, so `started` reports a piece that has nothing
          // registered for any of its streams. Neither shape is the
          // drop predicate — the handler is missing because the commit
          // was raced, not because there is none, and events.md §5
          // calls for a requeue there. For a served (drained) event
          // that is a deferral: the durable entry stays pending and a
          // later wave re-drains it, under the serving loop's bounded
          // deferral budget — a condition that outlasts the budget
          // hardens into §5's drop notice rather than wedging the
          // stream. Client-side the distinction is moot (no durable
          // entry to re-drain) and the drop keeps its existing shape.
          const pieceState = verdict.started
            ? "has no pattern graph installed"
            : "could not be started";
          dropQueuedEvent(
            state,
            queuedEvent,
            `Event dropped: no handler registered for ${args.eventLink.id} and its piece ${pieceState}`,
            queuedEvent.served !== undefined ? "deferred" : "dropped",
          );
          if (queuedEvent.served !== undefined) {
            // A deferral carries the drain's arrival-order barrier
            // (events.md §2; review-6459 F1's sibling arm), exactly as
            // the handler-not-run withdrawal and the facade's load-park
            // arm do.
            deferLaterSameSpaceServedEvents(
              state,
              queuedEvent,
              `whose piece ${pieceState}`,
            );
          }
        }
      } catch (error) {
        // Unlike the arms above, this one is reachable with the event
        // ALREADY SETTLED: the finalOutcomeNotified/queue-membership
        // recheck runs after the load await resolves, and a rejection
        // never crosses it. A settled head holds no barrier — its
        // disposition was someone else's (e.g. a lineage drop mid-load).
        const alreadySettled = queuedEvent.finalOutcomeNotified === true;
        dropQueuedEvent(
          state,
          queuedEvent,
          `Event dropped: starting the piece for ${args.eventLink.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          queuedEvent.served !== undefined ? "deferred" : "dropped",
        );
        if (!alreadySettled && queuedEvent.served !== undefined) {
          // Same deferral disposition as the arm above — same barrier.
          deferLaterSameSpaceServedEvents(
            state,
            queuedEvent,
            "whose piece failed to start",
          );
        }
      } finally {
        state.queueExecution();
      }
    })();
    state.backgroundTasks.add(startTask);
    startTask.finally(() => {
      state.backgroundTasks.delete(startTask);
    });
  } else {
    // Second pass after a piece start that still registered no handler for
    // this stream (e.g. the piece "started" but its nodes failed to
    // instantiate). Trying again won't change this, so settle the event now.
    notifyEventDropped(
      state,
      args,
      `Event dropped: no handler registered for ${args.eventLink.id} ` +
        `after starting its piece`,
    );
  }
}

export function addSchedulerEventHandler(state: {
  readonly eventHandlers: [NormalizedFullLink, EventHandler][];
}, args: {
  readonly handler: EventHandler;
  readonly ref: NormalizedFullLink;
  readonly populateDependencies?: (
    tx: Parameters<EventHandler>[0],
    event: Parameters<EventHandler>[1],
  ) => void;
}): Cancel {
  if (args.populateDependencies) {
    args.handler.populateDependencies = args.populateDependencies;
  }
  const existingIndex = state.eventHandlers.findIndex(([existing]) =>
    areNormalizedLinksSame(existing, args.ref)
  );
  const existing = state.eventHandlers[existingIndex]?.[1];
  if (args.handler.implementationSelection !== undefined) {
    const dispatcher = existing && isGuardedDispatcher(existing)
      ? existing
      : createGuardedDispatcher(args.ref, state.eventHandlers);
    if (dispatcher !== existing) {
      if (existingIndex !== -1) state.eventHandlers.splice(existingIndex, 1);
      state.eventHandlers.push([args.ref, dispatcher]);
    }
    const key = args.handler.implementationSelection.key;
    const registration = { handler: args.handler };
    dispatcher[guardedImplementations].implementations.set(key, registration);
    return () => {
      const { implementations } = dispatcher[guardedImplementations];
      if (implementations.get(key) !== registration) return;
      implementations.delete(key);
      if (implementations.size === 0) {
        const index = state.eventHandlers.findIndex(([, h]) =>
          h === dispatcher
        );
        if (index !== -1) state.eventHandlers.splice(index, 1);
      }
    };
  }
  if (existingIndex !== -1) {
    if (existing && isGuardedDispatcher(existing)) {
      existing[guardedImplementations].implementations.clear();
    }
    state.eventHandlers.splice(existingIndex, 1);
    logger.warn("event-handler-replaced", () => [
      "Replacing existing event handler for link",
      { linkId: args.ref.id },
    ]);
  }
  state.eventHandlers.push([args.ref, args.handler]);
  return () => {
    const index = state.eventHandlers.findIndex(([r, h]) =>
      r === args.ref && h === args.handler
    );
    if (index !== -1) state.eventHandlers.splice(index, 1);
  };
}

export interface SchedulerEventExecutionState {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly backpressure: CommitBackpressurePolicy;
  readonly collectPendingLoadParkKeys: (
    event: QueuedEvent,
    deps: ReactivityLog,
  ) => string[];
  readonly capturePendingLoadGenerations: () => void;
  readonly parkHeadEventForLoads: (
    event: QueuedEvent,
    keys: readonly string[],
  ) => void;
  readonly isHeadEventLoadParked: (event: QueuedEvent) => boolean;
  readonly nodes: NodeRegistry;
  readonly pending: Set<Action>;
  readonly eventPreflightTelemetryEnabled: boolean;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    handler: EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly handleError: (
    error: Error,
    action: Action | EventHandler,
  ) => void;
  readonly queueExecution: () => void;
  readonly setEventPreflightTraceContext: (
    trace: EventPreflightTraceContext | undefined,
  ) => void;
  readonly collectInvalidUpstreamForLog: (
    deps: ReactivityLog,
    invalidDeps: Set<Action>,
  ) => boolean;

  /** The transient-demander preflight (fan-out stage B, review F2):
   * re-arm the fanned-out nodes in a served handler's closure whose
   * instance for the actor is not current. Undefined off the serving
   * posture. */
  readonly rearmNotCurrentFanOutForActor?: (
    deps: ReactivityLog,
    actor: ScopeKeyIdentity,
  ) => Action[];

  readonly setEventPassDemandRefresh: (
    refresh: ((demand: Set<Action>) => void) | undefined,
  ) => void;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleWake: (notBefore: number) => void;
  readonly lineageStatus: (
    originTx: IExtendedStorageTransaction,
  ) => OriginStatus;
  readonly releaseLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly dropEvent: (event: QueuedEvent, reason: string) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly getOriginLocalSeq: (
    originTx: IExtendedStorageTransaction,
    space: MemorySpace,
  ) => number | undefined;
  readonly snapshotEventPreflightTraceContext: (
    trace: EventPreflightTraceContext,
  ) => SchedulerEventPreflightStats;
}

export function preflightQueuedEventDependencies(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly nodes: NodeRegistry;
  readonly pending: ReadonlySet<Action>;
  readonly pendingActions: Set<Action>;
  readonly eventBlockingDeps: Set<Action>;
  readonly handleError: (error: Error, handler: EventHandler) => void;
  readonly setEventPreflightTraceContext: (
    trace: EventPreflightTraceContext | undefined,
  ) => void;
  readonly collectInvalidUpstreamForLog: (
    deps: ReactivityLog,
    invalidDeps: Set<Action>,
  ) => boolean;

  /** The transient-demander preflight (server-execution v2 fan-out
   * stage B, review F2): re-arm the fanned-out nodes in a served
   * handler's closure whose instance for the ACTOR is not current, so
   * the actor's own per-user derivation is materialized before the
   * handler reads it. Returns the re-armed nodes (the event waits on
   * them). Undefined off the serving posture. */
  readonly rearmNotCurrentFanOutForActor?: (
    deps: ReactivityLog,
    actor: ScopeKeyIdentity,
  ) => Action[];

  readonly collectPendingLoadParkKeys: (
    event: QueuedEvent,
    deps: ReactivityLog,
  ) => string[];
  readonly parkHeadEventForLoads: (
    event: QueuedEvent,
    keys: readonly string[],
  ) => void;
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
  readonly getNextDebounceRunTime: (action: Action) => number | undefined;
  readonly getNextEligibleRunTime: (action: Action) => number | undefined;
  readonly scheduleWake: (notBefore: number) => void;
  readonly dropEvent: (event: QueuedEvent, reason: string) => void;
}, queuedEvent: QueuedEvent): EventDependencyPreflightResult {
  const { handler, event: eventValue } = queuedEvent;
  const preflightStats = createEventPreflightTraceContext();
  // Diagnostic-only stat: read the maintained invalid-node index (O(1)) rather
  // than scanning every node per queued event (was O(N) on a hot path).
  const dirtySizeBefore = state.nodes.getInvalidNodes().size;
  const pendingSizeBefore = state.pending.size;
  let populateMs = 0;
  let txToLogMs = 0;
  let depCommitMs = 0;
  let collectMs = 0;
  let scheduleMs = 0;
  let shouldSkipEvent = false;

  // Get the handler's dependencies (read-only, just capturing what will be read)
  const depTx = state.runtime.edit();
  let failureReported = false;
  const reportFailure = (error: unknown) => {
    if (failureReported) return;
    failureReported = true;
    try {
      state.handleError(
        error instanceof Error ? error : new Error(String(error)),
        queuedEvent.preflightImplementation ?? handler,
      );
    } catch {
      throw error;
    } finally {
      state.dropEvent(
        queuedEvent,
        `Event dropped: dependency preflight failed for ${queuedEvent.eventLink.id}`,
      );
    }
  };
  try {
    state.runtime.scheduler.beginReadAttempt(depTx, "preflight");
    depTx.setReadOnly?.("scheduler.populateDependencies()");
    // Selection and input probes use the dispatch actor. Their scoped reads
    // register that actor's instance loads before dispatch.
    const probeIdentity = eventScopeIdentity(queuedEvent);
    if (probeIdentity !== undefined) depTx.tx.scopeKeyIdentity = probeIdentity;
    let stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullPopulateDependencies",
    );
    try {
      const implementation = selectEventImplementation(handler, depTx);
      queuedEvent.preflightImplementation = implementation;
      if (implementation !== undefined) {
        state.runtime.scheduler.prepareViewAction(depTx, implementation);
        implementation.populateDependencies?.(depTx, eventValue);
      }
    } catch (error) {
      if (localReadFailure(depTx) === undefined) {
        reportFailure(error);
        shouldSkipEvent = true;
      }
    } finally {
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "pullPopulateDependencies",
      );
    }
    populateMs = performance.now() - stepStart;

    stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullTxToReactivityLog",
    );
    const deps: ReactivityLog = shouldSkipEvent
      ? { reads: [], shallowReads: [], writes: [] }
      : txToReactivityLog(depTx);
    logger.timeEnd(
      "scheduler",
      "execute",
      "event",
      "pullTxToReactivityLog",
    );
    txToLogMs = performance.now() - stepStart;

    // Commit the read-only inspection tx as a no-op so dependency discovery
    // does not participate in CFC prepare or commit gating. Do this even
    // after populateDependencies errors so the transaction is closed.
    stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullDepCommitStart",
    );
    depTx.commit();
    logger.timeEnd(
      "scheduler",
      "execute",
      "event",
      "pullDepCommitStart",
    );
    depCommitMs = performance.now() - stepStart;

    const invalidDeps = new Set<Action>();
    stepStart = performance.now();
    logger.timeStart(
      "scheduler",
      "execute",
      "event",
      "pullCollectInvalidUpstream",
    );
    let hasInvalidDependencies = false;
    state.setEventPreflightTraceContext(preflightStats);
    try {
      hasInvalidDependencies = state.collectInvalidUpstreamForLog(
        deps,
        invalidDeps,
      );
    } finally {
      state.setEventPreflightTraceContext(undefined);
      logger.timeEnd(
        "scheduler",
        "execute",
        "event",
        "pullCollectInvalidUpstream",
      );
    }
    collectMs = performance.now() - stepStart;

    if (!shouldSkipEvent && hasInvalidDependencies) {
      stepStart = performance.now();
      logger.timeStart(
        "scheduler",
        "execute",
        "event",
        "pullScheduleInvalidUpstream",
      );
      try {
        const eventDirtyPlan = planEventInvalidDependencyScheduling({
          invalidDeps,
          isDebouncedComputationWaiting: (dep) =>
            state.isDebouncedComputationWaiting(dep),
          getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
          getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
        });
        for (const dep of eventDirtyPlan.runnableDeps) {
          state.pendingActions.add(dep);
          state.eventBlockingDeps.add(dep);
        }
        if (eventDirtyPlan.runnableDeps.length > 0) {
          shouldSkipEvent = true;
        } else if (eventDirtyPlan.nextEligibleAt !== undefined) {
          queuedEvent.notBefore = eventDirtyPlan.nextEligibleAt;
          state.scheduleWake(eventDirtyPlan.nextEligibleAt);
          shouldSkipEvent = true;
        }
      } finally {
        logger.timeEnd(
          "scheduler",
          "execute",
          "event",
          "pullScheduleInvalidUpstream",
        );
      }
      scheduleMs = performance.now() - stepStart;
    }

    // The transient-demander preflight (server-execution v2 fan-out stage B,
    // design §B5's motivating case; independent review F2). A SERVED event's
    // actor whose handler reads a per-user DERIVATION she does not watch has
    // no instance of that node — the node is node-level CLEAN (it ran for
    // the watchers), so the invalid-upstream pass above found nothing, and
    // the handler would read the actor's MISSING instance (its argument
    // fails the schema and the run is skipped — which, until the
    // mark/effects-atomicity fix below in `finalize`, sealed the entry
    // consequenced with no error: silent event loss. The finalize now
    // withdraws a skipped served dispatch, so the residual cost of a miss
    // here is a deferral-and-re-drain cycle, not a lost event — this
    // preflight remains what makes the FIRST delivery succeed). B7 made
    // cleanliness
    // per instance: re-arm the fanned-out nodes in the handler's closure
    // whose instance for THIS actor is not current, materializing her own
    // instance (as her transient demand) before the handler runs. The
    // handler then reads a current instance instead of losing its event.
    // Runs even when the node-level pass already skipped (a dirty input can
    // coexist with a never-run actor instance — the review's dirty-input
    // variant); the two schedule the same node, and the fan-out loop runs
    // both the dirty watcher instance and the actor's uncomputed one. Off
    // the serving posture `rearmNotCurrentFanOutForActor` is undefined and
    // this is inert.
    const actorFiredAt = queuedEvent.served?.firedAt;
    if (
      !shouldSkipEvent && actorFiredAt?.user !== undefined &&
      state.rearmNotCurrentFanOutForActor !== undefined
    ) {
      const actor: ScopeKeyIdentity = {
        principal: actorFiredAt.user,
        ...(actorFiredAt.session !== undefined &&
            actorFiredAt.session !== "server"
          ? { sessionId: actorFiredAt.session as never }
          : {}),
      };
      const rearmed = state.rearmNotCurrentFanOutForActor(deps, actor);
      if (rearmed.length > 0) {
        for (const dep of rearmed) {
          state.pendingActions.add(dep);
          state.eventBlockingDeps.add(dep);
        }
        shouldSkipEvent = true;
      }
    }

    // Replica-staleness gate (CT-1795): with no invalid upstream left, an
    // address the closure depends on may still have a load in flight — the
    // wish shape, where a computation settles CLEAN on a provisional value
    // while its fire-and-forget pull is outstanding. Handlers are at-most-once
    // (D7), so park the head until those loads complete (absent counts as
    // complete); load completion is the wake source, mirroring the lineage
    // park.
    if (!shouldSkipEvent && !hasInvalidDependencies) {
      const parkKeys = state.collectPendingLoadParkKeys(queuedEvent, deps);
      if (parkKeys.length > 0) {
        state.parkHeadEventForLoads(queuedEvent, parkKeys);
        shouldSkipEvent = true;
      }
    }

    return {
      shouldSkipEvent,
      deps,
      invalidDeps,
      hasInvalidDependencies,
      dirtySizeBefore,
      pendingSizeBefore,
      populateMs,
      txToLogMs,
      depCommitMs,
      collectMs,
      scheduleMs,
      preflightStats,
    };
  } catch (error) {
    if (depTx.status().status === "ready") {
      depTx.clearReadOnly?.();
      depTx.abort(error);
    }
    try {
      reportFailure(error);
    } catch {
      // The event's failure notification and queue removal finalize the failure.
    }
    return {
      shouldSkipEvent: true,
      deps: { reads: [], shallowReads: [], writes: [] },
      invalidDeps: new Set(),
      hasInvalidDependencies: false,
      dirtySizeBefore,
      pendingSizeBefore,
      populateMs,
      txToLogMs,
      depCommitMs,
      collectMs,
      scheduleMs,
      preflightStats,
    };
  }
}

export async function processPullQueuedEventDuringExecute(
  state: SchedulerEventExecutionState,
  eventBlockingDeps: Set<Action>,
): Promise<void> {
  const queuedEvent = state.eventQueue[0];
  if (!queuedEvent) return;

  if (queuedEvent.originTx !== undefined) {
    const originStatus = state.lineageStatus(queuedEvent.originTx);
    const sameSpace = state.getOriginLocalSeq(
      queuedEvent.originTx,
      queuedEvent.eventLink.space,
    ) !== undefined;
    if (originStatus === "failed") {
      state.dropEvent(
        queuedEvent,
        `Event dropped: lineage origin failed before ${queuedEvent.id} dispatched`,
      );
      logger.debug("scheduler-lineage", () => [
        "Dropping event from failed lineage origin",
        { eventId: queuedEvent.id },
      ]);
      return;
    }
    if (!sameSpace && originStatus === "pending") {
      return;
    }
  }

  // The head reserved its FIFO slot before its handler's piece loaded. Piece
  // completion hydrates the same object and queues a fresh execution tick.
  if (queuedEvent.handlerLoadPending) return;

  // The head is a stale-basis retry holding its slot while the state it
  // re-runs against arrives; the readiness continuation queues a fresh tick.
  if (queuedEvent.retryReadinessPending) return;

  // Head is parked on in-flight closure loads; loadsSettled re-queues after
  // success or drops the event after an explicit load failure.
  if (state.isHeadEventLoadParked(queuedEvent)) {
    return;
  }

  if (
    queuedEvent.notBefore !== undefined &&
    queuedEvent.notBefore > performance.now()
  ) {
    state.scheduleWake(queuedEvent.notBefore);
    return;
  }

  delete queuedEvent.notBefore;

  const { handler } = queuedEvent;

  let shouldSkipEvent = false;
  if (handler.populateDependencies) {
    // Snapshot generations that were already in flight before preflight reads
    // can kick their own fire-and-forget loads. A later generation that existed
    // here is a genuine concurrent refresh and must re-park; one first created
    // by this preflight is the self-kick that load history suppresses.
    state.capturePendingLoadGenerations();
    const preflight = preflightQueuedEventDependencies({
      runtime: state.runtime,
      eventQueue: state.eventQueue,
      nodes: state.nodes,
      pending: state.pending,
      pendingActions: state.pending,
      eventBlockingDeps,
      handleError: (error, target) => state.handleError(error, target),
      setEventPreflightTraceContext: (trace) => {
        state.setEventPreflightTraceContext(trace);
      },
      collectInvalidUpstreamForLog: (deps, invalidDeps) =>
        state.collectInvalidUpstreamForLog(
          deps,
          invalidDeps,
        ),
      ...(state.rearmNotCurrentFanOutForActor !== undefined
        ? {
          rearmNotCurrentFanOutForActor: state.rearmNotCurrentFanOutForActor,
        }
        : {}),
      collectPendingLoadParkKeys: (event, deps) =>
        state.collectPendingLoadParkKeys(event, deps),
      parkHeadEventForLoads: (event, keys) =>
        state.parkHeadEventForLoads(event, keys),
      isDebouncedComputationWaiting: (dep) =>
        state.isDebouncedComputationWaiting(dep),
      getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
      getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
      scheduleWake: (notBefore) => state.scheduleWake(notBefore),
      dropEvent: (event, reason) => state.dropEvent(event, reason),
    }, queuedEvent);
    shouldSkipEvent = preflight.shouldSkipEvent;

    if (eventBlockingDeps.size > 0) {
      // The event closure is a transient demand root for the WHOLE settle pass.
      // Re-run the same decision-15 inverted query each iteration so a clean
      // intermediate that becomes invalid mid-pass joins the demand set. This
      // avoids both a full upstream-cone walk and an alternating-cycle escape
      // into unbounded execute/preflight ticks.
      state.setEventPassDemandRefresh((demand) => {
        demand.clear();
        const invalidDeps = new Set<Action>();
        if (!state.collectInvalidUpstreamForLog(preflight.deps, invalidDeps)) {
          return;
        }
        const plan = planEventInvalidDependencyScheduling({
          invalidDeps,
          isDebouncedComputationWaiting: (dep) =>
            state.isDebouncedComputationWaiting(dep),
          getNextDebounceRunTime: (dep) => state.getNextDebounceRunTime(dep),
          getNextEligibleRunTime: (dep) => state.getNextEligibleRunTime(dep),
        });
        for (const dep of plan.runnableDeps) demand.add(dep);
      });
    }

    if (state.eventPreflightTelemetryEnabled) {
      state.runtime.telemetry.submit({
        type: "scheduler.event.preflight",
        handlerId: state.getActionId(
          queuedEvent.preflightImplementation ?? handler,
        ),
        handlerInfo: state.getActionTelemetryInfo(
          queuedEvent.preflightImplementation ?? handler,
        ),
        readCount: preflight.deps.reads.length,
        shallowReadCount: preflight.deps.shallowReads.length,
        dirtySizeBefore: preflight.dirtySizeBefore,
        pendingSizeBefore: preflight.pendingSizeBefore,
        dirtyDependencyCount: preflight.invalidDeps.size,
        hasDirtyDependencies: preflight.hasInvalidDependencies,
        skipped: shouldSkipEvent,
        populateMs: preflight.populateMs,
        txToLogMs: preflight.txToLogMs,
        depCommitMs: preflight.depCommitMs,
        collectMs: preflight.collectMs,
        scheduleMs: preflight.scheduleMs,
        stats: state.snapshotEventPreflightTraceContext(
          preflight.preflightStats,
        ),
      });
    }
  }

  if (shouldSkipEvent) return;

  await dispatchQueuedEvent({
    runtime: state.runtime,
    eventQueue: state.eventQueue,
    backpressure: state.backpressure,
    setRunningPromise: (promise) => {
      state.setRunningPromise(promise);
    },
    getActionId: (target) => state.getActionId(target),
    getActionTelemetryInfo: (target) => state.getActionTelemetryInfo(target),
    handleError: (error, target) => state.handleError(error, target),
    queueExecution: () => state.queueExecution(),
    lineageStatus: (originTx) => state.lineageStatus(originTx),
    releaseLineageEvent: (originTx, event) =>
      state.releaseLineageEvent(originTx, event),
    recordLineageEvent: (originTx, event) =>
      state.recordLineageEvent(originTx, event),
    getOriginLocalSeq: (originTx, space) =>
      state.getOriginLocalSeq(originTx, space),
    collectPendingLoadParkKeys: (event, log) =>
      state.collectPendingLoadParkKeys(event, log),
    parkHeadEventForLoads: (event, keys) =>
      state.parkHeadEventForLoads(event, keys),
  }, queuedEvent);
}

export async function dispatchQueuedEvent(state: {
  readonly runtime: Runtime;
  readonly eventQueue: QueuedEvent[];
  readonly backpressure: CommitBackpressurePolicy;
  readonly setRunningPromise: (promise: Promise<unknown>) => void;
  readonly getActionId: (action: Action | EventHandler) => string;
  readonly getActionTelemetryInfo: (
    handler: EventHandler,
  ) => SchedulerActionInfo | undefined;
  readonly handleError: (error: Error, action: Action) => void;
  readonly queueExecution: () => void;
  readonly lineageStatus: (
    originTx: IExtendedStorageTransaction,
  ) => OriginStatus;
  readonly releaseLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly recordLineageEvent: (
    originTx: IExtendedStorageTransaction,
    event: QueuedEvent,
  ) => void;
  readonly getOriginLocalSeq: (
    originTx: IExtendedStorageTransaction,
    space: MemorySpace,
  ) => number | undefined;
  readonly collectPendingLoadParkKeys: (
    event: QueuedEvent,
    log: ReactivityLog,
  ) => string[];
  readonly parkHeadEventForLoads: (
    event: QueuedEvent,
    keys: readonly string[],
  ) => void;
}, queuedEvent: QueuedEvent): Promise<void> {
  const { action, handler, event: eventValue, retry, onCommit } = queuedEvent;
  // Presync follows the actor-scoped dependency probe. Dispatch rechecks the
  // selection after the await so a replacement cannot run with stale inputs.
  const presyncedImplementation = isGuardedDispatcher(handler)
    ? queuedEvent.preflightImplementation
    : handler;
  const diagnosticHandler = presyncedImplementation ?? handler;
  const handlerId = state.getActionId(diagnosticHandler);

  state.runtime.telemetry.submit({
    type: "scheduler.invocation",
    handlerId,
    handlerInfo: state.getActionTelemetryInfo(diagnosticHandler),
  });

  // Ensure the handler's input docs are locally available before the body
  // runs (see EventHandler.presyncInputs). Fail open: a presync error should
  // surface as the handler's own read failure, not silently drop the event.
  if (typeof presyncedImplementation?.presyncInputs === "function") {
    const presyncTx = state.runtime.edit();
    try {
      state.runtime.scheduler.beginReadAttempt(presyncTx, "presync", handlerId);
      presyncTx.setReadOnly?.("scheduler.presyncInputs()");
      const identity = eventScopeIdentity(queuedEvent);
      if (identity !== undefined) presyncTx.tx.scopeKeyIdentity = identity;
      // The presync materializes the whole argument eagerly, so it is timed
      // on its own key beside the dispatch's other phases. The key is kept per
      // process with one active start, like every dispatch timer on this
      // logger, so two runtimes presyncing at once record one sample, possibly
      // understated, and lose the other, and nothing else: no caller reads
      // what `timeEnd()` returns.
      logger.timeStart("scheduler", "execute", "event", "presyncInputs");
      try {
        // Materialization and synchronization use the same event actor.
        await presyncedImplementation.presyncInputs(
          eventValue,
          identity,
          presyncTx,
        );
      } finally {
        logger.timeEnd("scheduler", "execute", "event", "presyncInputs");
      }
    } catch (error) {
      logger.warn(
        "scheduler",
        "handler input presync failed; dispatching anyway",
        { error, handlerId },
      );
    } finally {
      presyncTx.clearReadOnly?.();
      if (presyncTx.status().status === "ready") presyncTx.abort();
    }
  }

  // Lineage may fail while presync is awaiting I/O. Keep the event in its FIFO
  // slot until that await completes so the lineage callback can still find and
  // settle it. A failed origin removes the event through dropQueuedEvent; never
  // continue into the handler or notify its final callback a second time.
  if (
    queuedEvent.finalOutcomeNotified ||
    state.eventQueue[0] !== queuedEvent
  ) {
    return;
  }
  state.eventQueue.shift();

  const tx = state.runtime.edit();
  let viewHandler = presyncedImplementation ?? handler;
  const served = queuedEvent.served;
  let lineageReleased = false;
  const releaseLineage = () => {
    if (lineageReleased || queuedEvent.originTx === undefined) return;
    lineageReleased = true;
    state.releaseLineageEvent(queuedEvent.originTx, queuedEvent);
  };
  const runFinalCommitCallback = () => {
    if (queuedEvent.finalOutcomeNotified) return;
    queuedEvent.finalOutcomeNotified = true;
    if (!onCommit) {
      return;
    }
    try {
      onCommit(tx);
    } catch (callbackError) {
      logger.error(
        "schedule-error",
        "Error in event commit callback:",
        callbackError,
      );
    }
  };

  let failureFinalized = false;
  // A failed setup or handler completes every owner notification once, even
  // when one observer throws. The original failure remains the event outcome.
  const finalizeFailure = (error: unknown) => {
    if (failureFinalized) return;
    failureFinalized = true;
    const handlerError = error instanceof Error
      ? error
      : new Error(String(error));
    for (
      const complete of [
        () => {
          if (tx.status().status === "ready") {
            tx.clearReadOnly?.();
            tx.abort(handlerError);
          }
        },
        releaseLineage,
        () => state.handleError(handlerError, action),
        () =>
          reportServedEventFailure(served, {
            kind: "error",
            message: handlerError.message,
          }),
        runFinalCommitCallback,
        () => tx.abandonStagedWork(eventAbandonError("event execution failed")),
      ]
    ) {
      try {
        complete();
      } catch (notificationError) {
        logger.error(
          "schedule-error",
          "Error completing failed event:",
          notificationError,
        );
      }
    }
  };

  try {
    tx.dispatchedEventId = queuedEvent.id;
    state.runtime.scheduler.beginReadAttempt(tx, "event", handlerId);
    tx.dispatchedEventTime = queuedEvent.time;
    tx.dispatchedRuntimeInjectedEventKeys =
      queuedEvent.runtimeInjectedEventKeys;
    tx.tx.immediate = true;
    tx.tx.sourceAction = action;
    // Server-execution v2 stage F (serving-loop.md §3d): the event-dispatch
    // choke point — a serving runtime's installed stamper attaches the wave
    // run context (kind event-handler, the durable event id) before the
    // handler runs. A no-op everywhere else. The action identity is the
    // HANDLER's durable id (`handlerId`, computed above): the queued
    // `action` is a per-event wrapper closure, and stamping IT hands the
    // basis index a non-durable identity — the wrapper's inferred name
    // collapses every handler onto one constant id (rows overwrite across
    // handlers), while the requeue paths' anonymous wrappers split rows
    // per event; scheduler_basis requires "durable ... restart-stable"
    // (serving-loop.md §3b).
    //
    // Stage P2-F — the LT6 inheritance rule (events.md §2, RULED
    // 2026-08-03: "an event emitted by ANY run carries that run's acting
    // identity — events run as the session they originated from"): a
    // server-side event whose ORIGIN transaction ran under a stamped
    // per-run identity hands that identity to the handler run, so a
    // cascade rooted in a demanded (user, session) derivation preserves
    // the acting pair hop by hop instead of blanking to the userless
    // service fallback. Off the serving posture `waveRunContextOf` finds
    // no stamp and this is inert. Phase 3's events carry the
    // server-stamped `firedAt` through their own carriage (`served`,
    // below), and that explicit carriage WINS where it speaks: a drained
    // entry's stamp is the event's own durable actor, while the origin
    // inheritance covers the in-process queueEvent shapes that carry no
    // served stamp.
    const originContext = queuedEvent.originTx !== undefined
      ? waveRunContextOf(queuedEvent.originTx)
      : undefined;
    state.runtime.stampServerRun(tx, {
      actionId: handlerId,
      kind: "event-handler",
      eventId: queuedEvent.id,
      // The same-wave cascade's fold key (C8d; review 2026-08-11 M2):
      // the emitter's own eventId, threaded from the emission's
      // dispatch carriage so the wave can roll a cascade child back
      // with its requeued parent. The client-echo thread
      // (QueuedEvent.parentEventId, independent review M1) carries the
      // same fact on a flag-ON client's speculative cascade, where the
      // navigate capture derives its ATTEMPT-MINTED tag from it
      // (navigate-context.ts) — the speculation stamp is never a wave
      // context, so the fold semantics stay server-only.
      ...((served?.parentEventId ?? queuedEvent.parentEventId) !== undefined
        ? {
          parentEventId: served?.parentEventId ?? queuedEvent.parentEventId,
        }
        : {}),
      ...(served?.firedAt !== undefined
        ? {
          // LD1 (protocol.md §2, scopes.md §5): the handler runs AS the
          // event's server-stamped actor — its scoped reads and writes
          // resolve against the acting identity, and the attribution
          // annotations carry it. A run with NO acting user carries no
          // attribution at all (protocol.md §1); a sessionless chain
          // supplies no session component, so a session-scoped write
          // fails closed in resolveScopeKey (events.md §2's
          // sessionless-actor error).
          ...(served.firedAt.user !== undefined
            ? {
              acting: {
                user: served.firedAt.user,
                ...(served.firedAt.session !== undefined &&
                    served.firedAt.session !== "server"
                  ? { session: served.firedAt.session }
                  : {}),
              },
            }
            : {}),
          scopeKeyIdentity: {
            principal: served.firedAt.user,
            sessionId: served.firedAt.session === "server"
              ? undefined
              : served.firedAt.session,
          } as never,
        }
        : originContext?.scopeKeyIdentity !== undefined
        ? { scopeKeyIdentity: originContext.scopeKeyIdentity }
        : {}),
      ...(originContext?.actionScopeKey !== undefined
        ? { actionScopeKey: originContext.actionScopeKey }
        : {}),
      ...(served?.streamEntry !== undefined
        ? { streamEntry: served.streamEntry }
        : {}),
      // The LT1 in-process copy's appending-wave identity (stage C build
      // W3, (α)): the emitter's transaction, resolved by the SpaceServer's
      // stamper to the wave that carries this event's durable entry.
      ...(served?.lt1 !== undefined ? { lt1: served.lt1 } : {}),
    });
    if (queuedEvent.originTx !== undefined) {
      const originLocalSeq = state.getOriginLocalSeq(
        queuedEvent.originTx,
        queuedEvent.eventLink.space,
      );
      if (
        originLocalSeq !== undefined &&
        state.lineageStatus(queuedEvent.originTx) === "pending" &&
        state.runtime.experimental.commitPreconditions === true &&
        // Events-down (runtime-mapping N26): the receipt/precondition
        // exactly-once machinery is SUBSUMED by the stream's
        // `eventWatermark` (events.md §4) and the two mechanisms MUST NOT
        // be active for the same event. Under the flag the handler run is
        // a diverted echo (client) or a wave-sealed run (server) — its
        // tx never carries wire preconditions.
        state.runtime.experimental.serverExecution !== true
      ) {
        tx.addCommitPrecondition?.(queuedEvent.eventLink.space, {
          kind: "origin-committed",
          originLocalSeq,
        });
      }
      releaseLineage();
    }
    const actionId = state.getActionId(action);

    // Re-queue this event for an immediate re-run. This is the inSpace-name
    // resolution path (RetryImmediately): the run referenced a pattern space by
    // name that has now been resolved, so re-running resolves it synchronously from
    // the cache. No count guards this loop — name resolution is monotonic (each
    // re-run resolves at least one previously-unresolved name, and a resolved name
    // never becomes pending again), so a handler with finitely many distinct
    // inSpace names terminates. Dispatch released the lineage registration above,
    // so the fresh QueuedEvent must be re-recorded: otherwise an origin that fails
    // while the retry is queued cannot remove it, and the post-settlement
    // originStatus() fallback ("confirmed") would let a descendant of a failed
    // origin run.
    const requeueForNameResolution = () => {
      // A served name-resolution retry re-enters this scheduler settle. If it
      // runs before the flush deadline, the installed destination seals its
      // warmed-cache run into the current wave; a cut instead leaves the
      // existing LT1-purge/durable-drain cadence in charge. The retry keeps the
      // served carriage: acting identity, stream-entry consequence mark, LT1
      // ownership, and failure hook. This does not opt the event into commit
      // retries; `retry` remains false and a failed commit still belongs to the
      // wave/drain cadence.
      const requeued: QueuedEvent = {
        id: queuedEvent.id,
        // The flag rides every requeue with the id it describes: dropping it
        // would let a later same-origin send select this entry as a collapse
        // survivor and rewrite the payload its receipt is about to witness.
        callerSuppliedId: queuedEvent.callerSuppliedId,
        enqueueSeq: queuedEvent.enqueueSeq,
        time: queuedEvent.time,
        originTx: queuedEvent.originTx,
        action,
        eventLink: queuedEvent.eventLink,
        handler,
        event: eventValue,
        runtimeInjectedEventKeys: queuedEvent.runtimeInjectedEventKeys,
        retry,
        onCommit,
        ...(queuedEvent.served !== undefined
          ? { served: queuedEvent.served }
          : {}),
        ...(queuedEvent.parentEventId !== undefined
          ? { parentEventId: queuedEvent.parentEventId }
          : {}),
        // The intent's retry budget rides along: a name resolution in the
        // middle of a retry sequence is settlement, not a fresh start.
        ...(queuedEvent.retryAttempts !== undefined
          ? { retryAttempts: queuedEvent.retryAttempts }
          : {}),
        ...(queuedEvent.retryDeadline !== undefined
          ? { retryDeadline: queuedEvent.retryDeadline }
          : {}),
        ...(queuedEvent.notRunBackoffs !== undefined
          ? { notRunBackoffs: queuedEvent.notRunBackoffs }
          : {}),
      };
      insertInEnqueueOrder(state.eventQueue, requeued);
      if (requeued.originTx !== undefined) {
        state.recordLineageEvent(requeued.originTx, requeued);
      }
      state.queueExecution();
    };

    // Re-queue a transient outcome for a later retry. With `runAt` the retry is
    // parked via notBefore so the scheduler backs off (capped exponential delay)
    // instead of busy-looping; without it the caller parks the requeued head on
    // something else, such as a load. idle()/settled() wait for a parked head
    // either way, so a converging write still completes within a settle. The
    // retry attempt count and deadline are carried forward; `retry` is preserved
    // untouched (it gates whether this event retries at all, which a windowed
    // re-queue does not change).
    const requeueForRetry = (
      attempts: number,
      deadline: number,
      runAt: number | undefined,
      notRunBackoffs: number | undefined = queuedEvent.notRunBackoffs,
    ): QueuedEvent => {
      // Same served-absence assert as the name-resolution requeue above:
      // served copies queue with retries: false, so a stale-basis failure
      // classifies give-up "opt-out" and never reaches the backoff window —
      // the wave is a served copy's retry cadence. A served entry rebuilt
      // here would silently shed the acting identity and the failure hook;
      // served retry semantics are undecided, so fail loudly instead.
      if (queuedEvent.served !== undefined) {
        throw new Error(
          "requeueForBackoff reached with a served event; served retry " +
            "semantics are undecided (see the comment at this assert)",
        );
      }
      const requeued: QueuedEvent = {
        id: queuedEvent.id,
        // Same as the name-resolution requeue above: the flag travels with the
        // id, or the collapse-survivor exclusion silently ends at the first
        // retry.
        callerSuppliedId: queuedEvent.callerSuppliedId,
        enqueueSeq: queuedEvent.enqueueSeq,
        time: queuedEvent.time,
        originTx: queuedEvent.originTx,
        action,
        eventLink: queuedEvent.eventLink,
        handler,
        event: eventValue,
        runtimeInjectedEventKeys: queuedEvent.runtimeInjectedEventKeys,
        retry,
        onCommit,
        retryAttempts: attempts,
        retryDeadline: deadline,
        ...(runAt !== undefined ? { notBefore: runAt } : {}),
        ...(notRunBackoffs !== undefined ? { notRunBackoffs } : {}),
        // A cascade child stays one: the dispatch stamp reads the emitting
        // run's id off the requeued entry as it did off the first.
        ...(queuedEvent.parentEventId !== undefined
          ? { parentEventId: queuedEvent.parentEventId }
          : {}),
      };
      insertInEnqueueOrder(state.eventQueue, requeued);
      if (requeued.originTx !== undefined) {
        state.recordLineageEvent(requeued.originTx, requeued);
      }
      state.queueExecution();
      return requeued;
    };

    // A stale-basis rejection re-runs the handler against fresh state, and
    // the requeued event holds its slot until that state arrives: the
    // replica's catch-up to the conflict point (the rejection's
    // `readyToRetry`) and the pull of the document the conflict names, the
    // same readiness `Runtime.editWithRetry` and the reactive path (run.ts)
    // await before their re-runs. The event re-enters the queue at once, by
    // `enqueueSeq`, marked `retryReadinessPending` so dispatch passes over it
    // and idle stays open; a later event cannot overtake it, and a cascade
    // victim whose own readiness resolves first queues up behind it. The
    // backoff step stays as the pacing floor: `runAt` was fixed when the
    // rejection was classified, so a readiness that outlasts the delay
    // dispatches the re-run as soon as it resolves, and one that resolves
    // sooner leaves the event parked until the step elapses. The retry window
    // is untouched either way; the deadline rides the requeued event. The
    // returned promise is part of the tracked `handled` chain, so the
    // pending-commit barrier stays open across the wait.
    const requeueAfterRetryReadiness = async (
      error: CommitError,
      step: Extract<CommitDisposition, { kind: "backoff" }>,
    ): Promise<void> => {
      const teardown = state.runtime.writeTeardownSignal;
      const readiness = state.runtime.awaitCommitRetryReadiness(
        error,
        teardown,
      );
      const requeued = requeueForRetry(
        step.attempts,
        step.deadline,
        step.runAt,
      );
      requeued.retryReadinessPending = true;
      await readiness;
      // An event a failed origin dropped while it waited is already out of
      // the queue and settled; clearing the mark and the tick below are
      // no-ops for it, and the drop chokepoint tolerates a second drop.
      delete requeued.retryReadinessPending;
      if (teardown.aborted) {
        // The runtime stopped minting write work while the event waited, so
        // no re-run is coming: the drop settles the callback on the refused
        // transaction, the staged work hears the rejection as it does on the
        // give-up arm, and the execution tick wakes an idle waiter parked on
        // the head this was.
        dropQueuedEvent(
          state,
          requeued,
          "Event dropped: commit retry abandoned because the runtime is " +
            "tearing down",
          "dropped",
          { callbackTx: tx },
        );
        tx.abandonStagedWork(error);
      }
      state.queueExecution();
    };

    const finalize = (error?: unknown): void => {
      const unavailable = validateLocalReadBasis(tx);
      if (unavailable !== undefined) {
        if (tx.status().status === "ready") tx.abort(unavailable);
        releaseLocalReadBasis(tx);
        runFinalCommitCallback();
        return;
      }
      // A RetryImmediately signal means the handler referenced an inSpace("name")
      // target that has now been resolved into the runtime cache. Abort this run's
      // transaction and re-queue the event so the handler re-runs and resolves the
      // name synchronously.
      if (error instanceof RetryImmediately) {
        if (tx.status().status === "ready") {
          tx.abort(error);
        }
        if (retry || served !== undefined) {
          requeueForNameResolution();
        } else {
          // An unserved retries:false event is a one-shot; it does not re-run to
          // resolve names. Served events take the same-wave arm above because
          // the server, not a later client speculation, owns their result.
          logger.warn(
            "scheduler",
            "Event handler needed inSpace-name resolution but opted out of " +
              "retry (retries: false); dropping",
            { handlerId },
          );
          runFinalCommitCallback();
          tx.abandonStagedWork(eventAbandonError("retry opted out"));
        }
        return;
      }

      if (error) {
        finalizeFailure(error);
        return;
      }

      // A dispatch whose handler body DID NOT RUN seals nothing (events.md
      // §5). The runner records the skip when the handler's argument reads
      // as `undefined`, and on a replica that is still loading what the
      // argument reaches that is a cold read, not a schema mismatch: a
      // computation that reads a document the replica does not hold yet
      // publishes `undefined` until the load lands, so a handler reading
      // through it finds its argument unresolved in exactly that window.
      // Both arms below withdraw the transaction and run the handler again
      // once the replica has moved; what differs is who re-delivers. Under
      // events-down (server-execution v2 Phase 3) a dispatch without a served
      // carriage is the client's speculative echo of an entry the server
      // handles authoritatively and re-drains itself, so it takes neither arm:
      // its skip seals as an empty speculative commit the authoritative
      // consequence replaces.
      if (
        tx.dispatchedHandlerNotRun !== undefined &&
        (served !== undefined ||
          state.runtime.experimental.serverExecution !== true)
      ) {
        const reason = tx.dispatchedHandlerNotRun.reason;
        // Taken before the abort, since the read set is what the client arm
        // parks on.
        const runLog = txToReactivityLog(tx);
        if (tx.status().status === "ready") {
          tx.abort(new Error(`handler did not run: ${reason}`));
        }
        if (served !== undefined) {
          // Mark/effects atomicity (events.md §4, RULED 2026-08-27 — the
          // a04 write-side member). The dispatch stamper wrote the entry's
          // `consequenced` mark into this tx BEFORE the body ran
          // (space-server.ts), so sealing the skipped run would commit a
          // 1-op mark-only consequence — the entry permanently consumed
          // with zero effects and no error (a04's seqs 53/56: two Create
          // clicks lost to a transient argument-resolution failure). The
          // withdrawal leaves the entry pending-unconsequenced, the drain
          // re-delivers it (a drain copy's plain-deferral arm releases the
          // in-flight guard and arms the rescan; the 8-deferral threshold
          // hardens a permanently unresolvable argument into the visible
          // §5 DROP notice), and the retried handler's cause-derived
          // idempotent writes converge. An LT1 in-process copy carries no
          // onFailure — its abort alone leaves the durable entry unmarked
          // and the next wave's drain delivers it once, WITH a streamEntry
          // (C8b).
          reportServedEventFailure(served, {
            kind: "deferred",
            cause: "handler-not-run",
            message: reason,
          });
          // The withdrawal is a deferral, and a deferral carries the
          // drain's arrival-order BARRIER (events.md §2; review-6459 F1):
          // the drain queues a pass's pending entries together, so
          // same-space followers already sit behind this head and would
          // dispatch — and SEAL — next, landing a later arrival's
          // consequence ahead of the withdrawn entry's re-drain (the b01
          // overtake: durable log ["B","A"] against arrival [a1, b1]).
          deferLaterSameSpaceServedEvents(
            state,
            queuedEvent,
            `whose served handler did not run (${reason})`,
          );
          runFinalCommitCallback();
          return;
        }
        // A client dispatch has no durable entry, so the scheduler is its
        // only re-deliverer. Sealing the skip would fire the commit callback
        // on a transaction that wrote nothing, which a caller reads as the
        // handling having completed. A one-shot (retries: false) is not
        // re-run, and its callback sees the aborted transaction instead.
        if (!retry) {
          logger.warn(
            "scheduler",
            "Event handler did not run and the caller opted out of retry " +
              "(retries: false); dropping",
            { handlerId, reason },
          );
          runFinalCommitCallback();
          tx.abandonStagedWork(eventAbandonError("retry opted out"));
          return;
        }
        // Re-run within the same window a stale-basis rejection gets. The
        // requeued head goes through the dependency preflight again, which
        // waits for an invalid upstream computation; a computation that
        // already settled clean on `undefined` is what the load park is
        // for. Parked on the loads the run's own reads registered when any
        // are in flight, since their landing is what re-invalidates that
        // computation; otherwise after the backoff step, so a replica with
        // nothing in flight neither busy-loops nor waits on a load that is
        // not coming. The requeued event holds the head, so a re-run with
        // nothing to park on is also counted against
        // `HANDLER_NOT_RUN_BACKOFF_LIMIT`: an argument nothing in flight
        // will resolve fails after those few short steps rather than
        // holding every later event for the window. Either bound fails the
        // handling loudly.
        const failHandlerNotRun = (attempts: number, elapsedMs: number) => {
          runFinalCommitCallback();
          tx.abandonStagedWork(eventAbandonError(reason));
          state.handleError(
            new EventHandlerNotRunError({
              handlerId,
              reason,
              attempts,
              elapsedMs,
            }),
            action,
          );
        };
        const parkKeys = state.collectPendingLoadParkKeys(queuedEvent, runLog);
        const step = nextRetryStep(queuedEvent, state.backpressure);
        if (step.kind === "convergence-failed") {
          failHandlerNotRun(step.attempts, step.elapsedMs);
          return;
        }
        const notRunBackoffs = (queuedEvent.notRunBackoffs ?? 0) +
          (parkKeys.length === 0 ? 1 : 0);
        if (notRunBackoffs > HANDLER_NOT_RUN_BACKOFF_LIMIT) {
          failHandlerNotRun(
            step.attempts,
            state.backpressure.retryWindowMs -
              (step.deadline - performance.now()),
          );
          return;
        }
        const wait = parkKeys.length > 0
          ? `parked on ${parkKeys.length} load(s)`
          : `after ${Math.round(step.delayMs)}ms`;
        logger.debug(
          "scheduler",
          `Event handler did not run (${reason}); re-running ` +
            `(attempt ${step.attempts}, ${wait})`,
          { handlerId },
        );
        const requeued = requeueForRetry(
          step.attempts,
          step.deadline,
          parkKeys.length > 0 ? undefined : step.runAt,
          notRunBackoffs,
        );
        if (parkKeys.length > 0) {
          state.parkHeadEventForLoads(requeued, parkKeys);
        }
        return;
      }

      try {
        state.runtime.prepareTxForCommit(tx);
      } catch (error) {
        if (localReadFailure(tx) === undefined) throw error;
        finalize(error);
        return;
      }
      if (validateLocalReadBasis(tx) !== undefined) {
        finalize();
        return;
      }
      const log = txToReactivityLog(tx);
      const telemetryWrites = log.writes
        .slice(0, EVENT_COMMIT_TELEMETRY_WRITE_LIMIT)
        .map(formatEventCommitAddress);
      // Do not await event commits here. commit() applies the transaction
      // locally before returning, and the scheduler must let later client work
      // continue against that speculative state while server confirmation is in
      // flight. Downstream dirtying below is based on those locally applied
      // changed writes, not server-confirmed durability. If the server rejects
      // the commit, dependent speculative transactions are rejected as well and
      // the normal retry path reruns the event. Durability is still observable:
      // commit() registers itself with the storage manager's pending-commit
      // barrier, which the client-facing idle (Scheduler.idleWithPendingCommits)
      // waits on without blocking the scheduler loop here. The backoff arm
      // returns the promise of its readiness-gated requeue, which the tracked
      // `handled` chain below flattens into the same barrier.
      const handleCommitResult = (
        error: EventCommitError | undefined,
      ): void | Promise<void> => {
        if (validateLocalReadBasis(tx) !== undefined) {
          releaseLocalReadBasis(tx);
          runFinalCommitCallback();
          return;
        }
        if (
          served !== undefined && error !== undefined &&
          isLt1LateSealRefusal(error)
        ) {
          // The serving loop REFUSED this LT1 in-process copy's seal
          // because it completed outside its appending wave (stage C
          // build W3, (α); events.md §4's one-entry-one-completed-run
          // sentence): the invariant working, not a failed commit — the
          // durable entry is the truth and the drain delivers it with a
          // streamEntry. Settle the copy quietly (no retry, no warn; the
          // SpaceServer counted it — `events.lt1LateSealsRefused`). This
          // early return also SKIPS the `scheduler.event.commit` telemetry
          // submit below for the refused copy (deliberate: the copy is
          // not a commit outcome; the drain's copy of the same entry
          // reports its own).
          logger.debug("lt1-late-seal-refused", () => [
            `LT1 in-process copy of ${queuedEvent.id} sealed outside its ` +
            "appending wave and was refused; the drain delivers the entry",
          ]);
          // No abandonment: the durable entry is still the truth and the drain
          // delivers it, so a further attempt at this event is coming and work
          // staged on it is waiting for something rather than nothing.
          runFinalCommitCallback();
          return;
        }
        if (served !== undefined && error !== undefined) {
          logger.warn("served-event-commit-failed", () => [
            `served event ${queuedEvent.id} commit failed`,
            error,
          ]);
        }
        const permanentRejection = error && isPermanentRejection(error)
          ? error.precondition
          : undefined;
        // Classify the commit outcome. A committed write that represents user
        // intent must converge or fail loudly: a stale-basis rejection backs off
        // and retries within a bounded window rather than being dropped; a
        // permanent or non-stale-basis rejection is not retried; an unconverged
        // write surfaces a terminal error.
        const disposition = classifyCommitDisposition(
          error,
          queuedEvent,
          state.backpressure,
        );

        let telemetryFailure: { readonly error: unknown } | undefined;
        try {
          state.runtime.telemetry.submit({
            type: "scheduler.event.commit",
            handlerId,
            handlerInfo: state.getActionTelemetryInfo(diagnosticHandler),
            readCount: log.reads.length + log.shallowReads.length,
            writeCount: log.writes.length,
            changedWriteCount: log.writes.length,
            writes: telemetryWrites,
            ...(log.writes.length > EVENT_COMMIT_TELEMETRY_WRITE_LIMIT
              ? { writesTruncated: true }
              : {}),
            ...(error ? { error: error.message } : {}),
            ...(permanentRejection !== undefined ? { permanentRejection } : {}),
            ...(disposition.kind === "backoff"
              ? {
                retryAttempt: disposition.attempts,
                backoffMs: disposition.delayMs,
              }
              : {}),
            ...(disposition.kind === "convergence-failed"
              ? { retryAttempt: disposition.attempts, terminal: "convergence" }
              : {}),
            ...(disposition.kind === "permanent"
              ? { terminal: "permanent" }
              : {}),
            ...(disposition.kind === "terminal" ? { terminal: "rule" } : {}),
          });
        } catch (error) {
          telemetryFailure = { error };
        }

        // A served event's DETERMINISTIC CFC pre-storage refusal seals an
        // error consequence (events.md §5: the error IS the consequence — the
        // same honesty as the throw arm in `finalize` above). Without one the
        // durable entry stays unconsequenced and every wave re-drains it into
        // the identical refusal. Scoped to exactly the class
        // `reportDroppedCfcRejectedWrite` reports: every other non-retried
        // outcome has its own explicit routing below: typed delivery failures
        // checkpoint, proven-no-commit failures terminalize, and a handler abort
        // seals a safe error consequence. Called before the commit callback on
        // both paths that carry a refusal, so the drain's in-flight guard sees
        // the staged notice ("marked") rather than releasing the still-"queued"
        // copy.
        const sealCfcRefusalConsequence = (): void => {
          if (served === undefined || !isCfcRejectedCommitError(error)) return;
          reportServedEventFailure(served, {
            kind: "error",
            message: error.message,
          });
        };
        const deferCommitPreparationFailure = (): void => {
          if (
            served === undefined || error?.name !== "CommitPreparationError"
          ) {
            return;
          }
          reportServedEventFailure(served, {
            kind: "deferred",
            cause: "delivery-failure",
            role: "failed-head",
            phase: "commit-preparation",
            failure: {
              failureClass: "unknown",
              recoveryEpoch: "commit-preparation",
              permanentEvidence: false,
            },
          });
        };
        const routeProvenNoCommitFailure = (): void => {
          if (served === undefined || error === undefined) return;
          const rowLabelRefusal = error.name === "RowLabelCommitError";
          const aclRevision = (error as { aclRevision?: unknown }).aclRevision;
          const authorizationRefusal = error.name === "AuthorizationError" &&
            (error as { permanentEvidence?: unknown }).permanentEvidence ===
              true &&
            typeof aclRevision === "number";
          if (!rowLabelRefusal && !authorizationRefusal) return;
          reportServedEventFailure(served, {
            kind: "deferred",
            cause: "delivery-failure",
            role: "failed-head",
            phase: "commit-finalization",
            failure: {
              failureClass: rowLabelRefusal ? "protocol" : "authorization",
              recoveryEpoch: rowLabelRefusal
                ? "row-label-verdict"
                : `acl:${aclRevision}`,
              permanentEvidence: true,
            },
          });
        };
        const sealExplicitHandlerAbort = (): void => {
          if (served === undefined || !isExplicitTransactionAbort(error)) {
            return;
          }
          reportServedEventFailure(served, {
            kind: "error",
            message: "Event handler aborted its transaction",
          });
        };

        let requeue: Promise<void> | undefined;
        switch (disposition.kind) {
          case "success": {
            const viewActor = waveRunContextOf(tx)?.scopeKeyIdentity;
            if (viewActor !== undefined) {
              const settlement = waveSettlementOf(tx);
              if (settlement === undefined) {
                state.runtime.scheduler.recordViewHandlerLog(
                  viewHandler,
                  viewActor,
                  log,
                );
              } else {
                void settlement.then((result) => {
                  if (result.error === undefined) {
                    state.runtime.scheduler.recordViewHandlerLog(
                      viewHandler,
                      viewActor,
                      log,
                    );
                  }
                });
              }
            }
            runFinalCommitCallback();
            break;
          }
          case "give-up":
            deferCommitPreparationFailure();
            routeProvenNoCommitFailure();
            sealExplicitHandlerAbort();
            sealCfcRefusalConsequence();
            runFinalCommitCallback();
            reportDroppedCfcRejectedWrite(error, handlerId);
            // No further attempt at this event is coming, so anything staged on
            // the transaction and waiting for it to commit is waiting for
            // nothing.
            tx.abandonStagedWork(error as CommitError);
            logger.warn(
              "scheduler",
              disposition.reason === "non-retryable"
                ? "Event handler commit failed with a non-stale-basis rejection " +
                  "that re-running cannot resolve; dropping the write without retry"
                : "Event handler commit failed and the caller opted out of " +
                  "retry (retries: false); dropping the write",
              { error, handlerId },
            );
            break;
          case "backoff":
            logger.debug(
              "scheduler",
              `Event handler commit failed transiently; backing off ` +
                `${Math.round(disposition.delayMs)}ms ` +
                `(attempt ${disposition.attempts})`,
              { handlerId },
            );
            requeue = requeueAfterRetryReadiness(
              error as CommitError,
              disposition,
            );
            break;
          case "terminal":
            // A deterministic commit-rule refusal: run the final callback and
            // stop. No retry (would recompute the identical refused write) and no
            // handleError — the rejection is observable via the commit telemetry
            // marker (`terminal: "rule"`), mirroring the permanent path; surfacing
            // a scheduler error here is reserved for non-deterministic failures.
            // A CFC boundary refusal is classified terminal rather than
            // give-up, so both of the give-up path's CFC obligations have to
            // hold here too: seal the served entry's error consequence, and
            // report the dropped write. Neither is optional — see
            // `sealCfcRefusalConsequence` for what an unconsequenced entry
            // costs, and `reportDroppedCfcRejectedWrite` for why the
            // `logger.warn` below is not enough on its own.
            deferCommitPreparationFailure();
            routeProvenNoCommitFailure();
            sealCfcRefusalConsequence();
            runFinalCommitCallback();
            reportDroppedCfcRejectedWrite(error, handlerId);
            tx.abandonStagedWork(error as CommitError);
            logger.warn(
              "scheduler",
              "Event handler commit terminally rejected (deterministic refusal); " +
                "not retrying",
              { error, handlerId },
            );
            break;
          case "permanent":
            runFinalCommitCallback();
            tx.abandonStagedWork(error as CommitError);
            if (permanentRejection === "receipt-exists") {
              logger.warn(
                "event-lost-race",
                () => [
                  "Event handling lost the receipt race",
                  { eventId: queuedEvent.id, handlerId },
                ],
              );
            }
            logger.warn(
              "scheduler",
              "Event handler commit permanently rejected; not retrying",
              { error, handlerId, permanentRejection },
            );
            break;
          case "convergence-failed": {
            runFinalCommitCallback();
            tx.abandonStagedWork(error as CommitError);
            logger.error(
              "commit-convergence-failed",
              () => [
                "Committed write did not converge within the retry window",
                { handlerId, attempts: disposition.attempts },
              ],
            );
            state.handleError(
              new CommitConvergenceError({
                handlerId,
                attempts: disposition.attempts,
                elapsedMs: disposition.elapsedMs,
                cause: error,
              }),
              action,
            );
            break;
          }
        }
        if (telemetryFailure !== undefined) {
          // Surfaced once the requeue has settled, so a failed telemetry
          // submission never detaches a pending retry from the tracked chain.
          const failure = telemetryFailure.error;
          if (requeue === undefined) throw failure;
          return requeue.then(() => {
            throw failure;
          });
        }
        return requeue;
      };
      const handled = tx.commit().then(
        ({ error }) => handleCommitResult(error),
        (reason) => handleCommitResult(normalizeEventCommitRejection(reason)),
      ).catch((error) => {
        logger.error(
          "schedule-error",
          "Event handler commit result handling failed:",
          error,
        );
      });
      // The barrier entry commit() registered settles with the commit
      // promise, but the disposition above runs later — a conflict's backoff
      // requeue only once its readiness resolves. Register the handled chain
      // too, so the pending-commit barrier cannot release in the gap between
      // a rejection settling and its retry being requeued.
      state.runtime.storageManager.trackPendingCommit(handled);
    };

    try {
      let implementation = handler;
      if (isGuardedDispatcher(handler)) {
        const selected = selectEventImplementation(handler, tx);
        if (selected === undefined || selected !== presyncedImplementation) {
          tx.dispatchedHandlerNotRun = {
            reason:
              "event implementation changed or is unavailable after presync",
          };
        } else {
          implementation = selected;
        }
      }
      viewHandler = implementation;
      if (hasAnnotatedWrites(implementation)) {
        recordTrustedEventPolicyInputs(
          tx,
          implementation.writes,
          eventValue,
          storedSchemaIn(tx),
        );
      }
      const actionStartTime = performance.now();
      logger.timeStart(
        "scheduler",
        "execute",
        "event",
        "handlerAction",
      );
      try {
        const runningPromise = Promise.resolve(
          state.runtime.harness.invoke(() => {
            if (tx.dispatchedHandlerNotRun !== undefined) return undefined;
            state.runtime.scheduler.prepareViewAction(tx, implementation);
            return isGuardedDispatcher(handler)
              ? implementation(tx, eventValue)
              : action(tx);
          }),
        ).then(() => {
          const trustedEventCandidates =
            trustedEventWriteCandidatesFromTransaction(tx, implementation, [
              queuedEvent.eventLink.space,
            ]);
          recordTrustedEventPolicyInputs(
            tx,
            trustedEventCandidates,
            eventValue,
            storedSchemaIn(tx),
          );
          const duration = (performance.now() - actionStartTime) / 1000;
          if (duration > 10) {
            console.warn(`Slow action: ${duration.toFixed(3)}s`, action);
          }
          logger.debug("action-timing", () => {
            return [
              `Action ${actionId} completed in ${duration.toFixed(3)}s`,
            ];
          });
          finalize();
        }).catch((error) => finalize(error));
        state.setRunningPromise(runningPromise);
        await runningPromise;
      } finally {
        logger.timeEnd(
          "scheduler",
          "execute",
          "event",
          "handlerAction",
        );
      }
    } catch (error) {
      finalize(error);
    }
  } catch (error) {
    finalizeFailure(error);
  }
}

function formatEventCommitAddress(address: {
  space: string;
  id: string;
  path: readonly string[];
}): string {
  return `${address.space}/${address.id}/${address.path.join("/")}`;
}

type CommitDisposition =
  | { kind: "success" }
  | { kind: "permanent" }
  | { kind: "terminal" }
  | {
    kind: "backoff";
    attempts: number;
    deadline: number;
    delayMs: number;
    runAt: number;
  }
  | { kind: "convergence-failed"; attempts: number; elapsedMs: number }
  | { kind: "give-up"; reason: "non-retryable" | "opt-out" };

/**
 * Decides what to do with an event-handler commit result.
 *
 *  - success: nothing more to do.
 *  - permanent: a commit-time precondition failure (receipt-exists,
 *    origin-committed). Re-running can never succeed and would double-handle the
 *    event, so it is never retried.
 *  - terminal: a deterministic refusal of the committed data on its own merits
 *    (`isTerminalRejection`) — the server's CFC row-label commit rule, or the
 *    client's CFC boundary refusing before storage; never retried —
 *    re-running recomputes the identical refused write, and the doomed re-runs'
 *    speculative rev bumps would starve concurrent siblings. Surfaced as a
 *    terminal outcome (telemetry `terminal: "rule"`) rather than a silent drop.
 *  - give-up (reason "non-retryable"): a non-permanent rejection that is neither
 *    a stale basis nor a terminal commit-rule refusal — an authorization denial,
 *    a malformed store operation, a transport error, a handler `tx.abort()`.
 *    Re-running against fresher confirmed state cannot resolve it, so the write
 *    drops fast rather than burning the retry window on a rejection that will
 *    recur identically.
 *  - give-up (reason "opt-out"): the caller sent with `retries: false` (a
 *    speculative lineage origin, an internal one-shot) and opted out of retrying.
 *    The failed write drops deterministically so a descendant of a failed origin
 *    does not run.
 *  - backoff / convergence-failed: a stale-basis rejection — a server-side
 *    ConflictError under contention, or the local StorageTransactionInconsistent
 *    guard (the same-replica race the rehydration storm produces). Re-running the
 *    handler against fresh confirmed state and committing again can succeed, so a
 *    committed write that represents user intent backs off with capped
 *    exponential delay and retries until it lands or the retry window elapses,
 *    after which it surfaces a terminal CommitConvergenceError rather than being
 *    silently dropped. This is the backpressure path.
 *
 * Only a stale basis is windowed, because only a stale basis converges by
 * re-running: the confirmed timeline moved on, and reading it fresh resolves the
 * commit. StorageTransactionInconsistent is windowed unconditionally — the
 * generalization of an earlier version that windowed it only when the commit
 * carried a mergeable op, which made the mergeable-op gate unnecessary. Every
 * other non-permanent rejection is deterministic with respect to confirmed
 * state: retrying it would waste the whole window arriving at the same refusal
 * (and, for an authorization denial, retry a security denial), so it fails fast
 * with the permanent precondition failures. There is no fixed retry count either
 * way — a stale basis is bounded by the retry window, and a non-stale-basis
 * rejection drops on the first attempt.
 */

/** Whether a served event's commit error is the serving loop's
 * LT1-late-seal refusal (stage C build W3, (α)) — carried as the
 * `reason` Error's message, the sentinel `LT1_LATE_SEAL_REFUSED`. */
function isLt1LateSealRefusal(error: EventCommitError): boolean {
  const reason = (error as { reason?: unknown }).reason;
  return reason instanceof Error && reason.message === LT1_LATE_SEAL_REFUSED;
}

function classifyCommitDisposition(
  error: { name?: string } | undefined,
  queuedEvent: QueuedEvent,
  policy: CommitBackpressurePolicy,
): CommitDisposition {
  if (!error) {
    return { kind: "success" };
  }
  if (isPermanentRejection(error)) {
    return { kind: "permanent" };
  }
  // A deterministic commit-rule refusal is terminal, and distinct from the
  // fast-drop below: re-running recomputes the identical refused write (and the
  // doomed re-runs' speculative rev bumps would starve concurrent siblings), so
  // it must not back off, and it is surfaced as a terminal outcome (telemetry
  // `terminal: "rule"`) rather than a silent drop. Checked before the stale-basis
  // split because it is not a stale basis.
  if (isTerminalRejection(error)) {
    return { kind: "terminal" };
  }
  // Only a stale-basis rejection — a server-side ConflictError, or the local
  // StorageTransactionInconsistent guard — converges by re-running against
  // fresher confirmed state. Any other non-permanent rejection (authorization,
  // malformed store op, transport, handler abort) will recur identically, so it
  // drops fast rather than burning the retry window.
  const staleBasis = isConflictRejection(error) ||
    isStorageTransactionInconsistent(error);
  if (!staleBasis) {
    return { kind: "give-up", reason: "non-retryable" };
  }
  // A caller that sent with retries: false (a speculative lineage origin, an
  // internal one-shot) opted out of retrying; honor that so a descendant of a
  // failed origin drops deterministically. retries: true opts into the retry
  // window, which bounds the retries by time rather than by a count.
  if (!queuedEvent.retry) {
    return { kind: "give-up", reason: "opt-out" };
  }
  return nextRetryStep(queuedEvent, policy);
}

/**
 * Where a client event that has to run again stands in its retry window: the
 * next backoff step, or the window spent. The window opens at the first
 * transient outcome and rides the requeued event, so every such outcome of one
 * intent — a stale-basis rejection, a dispatch whose handler body did not run
 * — draws on the same budget.
 */
function nextRetryStep(
  queuedEvent: QueuedEvent,
  policy: CommitBackpressurePolicy,
): Extract<CommitDisposition, { kind: "backoff" | "convergence-failed" }> {
  const attempts = (queuedEvent.retryAttempts ?? 0) + 1;
  const now = performance.now();
  const deadline = queuedEvent.retryDeadline ?? (now + policy.retryWindowMs);
  if (now >= deadline) {
    // The window is measured from the first failure (deadline minus window);
    // elapsed time is at least the full window.
    const elapsedMs = policy.retryWindowMs + (now - deadline);
    return { kind: "convergence-failed", attempts, elapsedMs };
  }
  // Exponential backoff from the first failure. The early steps are sub-5ms
  // (near-immediate), so a transient failure that clears once fresh state
  // arrives converges fast; the delay only grows into real spacing once the
  // failure persists.
  const delayMs = computeBackoffDelayMs(attempts, policy);
  return { kind: "backoff", attempts, deadline, delayMs, runAt: now + delayMs };
}
