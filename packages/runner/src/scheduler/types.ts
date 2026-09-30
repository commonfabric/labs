import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { ScopeKey, ScopeKeyIdentity } from "@commonfabric/memory/v2";

import type { Module, Pattern } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MediaType,
  ReplicaLoadFailure,
} from "../storage/interface.ts";
import type {
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
} from "../telemetry.ts";

export type TelemetryAnnotations = {
  viewNodeId?: string;
  viewLocalOnly?: boolean;
  viewPiece?: NormalizedFullLink;
  pattern: Pattern;
  module: Module;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
  materializerWriteEnvelopes?: NormalizedFullLink[];
  ignoredSchedulingWrites?: NormalizedFullLink[];

  /**
   * Concrete structural surface for a transformer-proven complete source lift.
   * This is runner-owned metadata; raw modules, handlers, and unresolved
   * redirect surfaces leave it absent and therefore remain fail-closed.
   */
  completeSchedulerScopeSummary?: {
    complete: true;
    piece: NormalizedFullLink;
    reads: NormalizedFullLink[];
    writes: NormalizedFullLink[];
    materializerWriteEnvelopes: NormalizedFullLink[];
    directOutputs: NormalizedFullLink[];
  };

  schedulerObservationIdentity?: SchedulerObservationIdentity;
};

export type SchedulerObservationIdentity = {
  ownerSpace?: MemorySpace;
  branch?: string;
  pieceId: string;
  processGeneration?: number;

  /** The piece root's RAW doc id (no scope-key prefix — `pieceId` above
   * is instance-keyed for shaper buckets). The per-(action × instance)
   * run supply (server-execution v2 stage P2-F) resolves an action's
   * demanded instances through this id at the reactive-action choke
   * point. */
  pieceRootId?: string;

  /** The DEMAND roots this action's instances resolve through (Phase 7):
   * `pieceRootId` plus every ANCESTOR piece root that instantiated it —
   * a nested pattern node's or a result-as-pattern child's actions are
   * demanded through the outer piece the client actually watches, so
   * the run supply resolves their instances at any root in the chain
   * (dedupe per instance). Absent means `[pieceRootId]`. Pre-Phase-7 a
   * nested piece's scoped derivations fell to the wave-level identity —
   * the serving session's own — and landed in the SERVICE identity's
   * instances, unread by any demander (the lunch-gate wall's last
   * mechanism; protocol.md §2's S1: "there is no third source of run
   * identity"). */
  demandRootIds?: readonly string[];
};

export type Action = (tx: IExtendedStorageTransaction) => any;
export type AnnotatedAction = Action & TelemetryAnnotations;
export type EventHandler =
  & ((tx: IExtendedStorageTransaction, event: any) => any)
  & {
    /**
     * Alternative implementation at a shared stream address. Implementations
     * coexist by key; `matches()` reads the selector through the event actor's
     * transaction so dependency preflight and dispatch track the same inputs.
     */
    implementationSelection?: {
      key: string;
      matches(tx: IExtendedStorageTransaction): boolean;
    };

    /**
     * Optional callback to populate a transaction with the handler's read dependencies.
     * Called by the scheduler to discover what cells the handler will read.
     * The callback should read all cells (using .get({ traverseCells: true })) that
     * the handler will access, so the transaction captures all dependencies.
     * The event is passed so dependencies can be resolved from links in the event.
     */
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void;

    /**
     * Optional callback to ensure the handler's input docs are locally
     * available before the handler body runs. A handler reads its asCell
     * inputs (e.g. a SqliteDb handle) synchronously from the local replica;
     * the scheduler awaits this before dispatching the event so those reads
     * don't race the doc-carrying storage responses. The event is passed so
     * inputs reachable only through the event can be covered too. A SERVED
     * event's dispatch passes the event's server-stamped actor as
     * `identity` (server-execution v2 stage A — the runner's
     * explicit-instance read): the handler runs AS that actor (LD1) and
     * reads that actor's instances of its scoped inputs, so the presync
     * loads THOSE instances — the served save handler must find the
     * actor's own draft, not the service instance's empty one (the R7
     * wall). Absent on every client-side event. Materialization reads use
     * `tx`, whose lifetime covers this callback and whose actor matches
     * `identity`; the scheduler closes it before opening the event transaction.
     */
    presyncInputs?: (
      event: any,
      identity: ScopeKeyIdentity | undefined,
      tx: IExtendedStorageTransaction,
    ) => Promise<void>;
  };
export type AnnotatedEventHandler = EventHandler & TelemetryAnnotations;

/**
 * Reactivity log.
 *
 * Used to log reads and writes to docs. Used by scheduler to keep track of
 * dependencies and to topologically sort pending actions before executing them.
 */
export type ReactivityLog = {
  reads: IMemorySpaceAddress[];

  /** Reads that should not invalidate on child writes unless they add a new key */
  shallowReads: IMemorySpaceAddress[];

  writes: IMemorySpaceAddress[];
};

export type EventPreflightTraceContext = SchedulerEventPreflightStats & {
  actionSummaries: Map<Action, SchedulerEventPreflightActionSummary>;
  rootDirectWriterActions: Set<Action>;
};

/**
 * In-memory identity keys carry the scope INSTANCE (the shared `ScopeKey`
 * vocabulary), never the scope NAME (scopes.md §7 M2, stage E). Built by
 * `entityKey` — see `keys.ts` for the identity-threading contract.
 */
export type SpaceScopeAndURI = `${MemorySpace}/${ScopeKey}/${URI}`;

export type SpaceScopeURIAndType =
  `${MemorySpace}/${ScopeKey}/${URI}/${MediaType}`;

/** Per-iteration stats captured during the settle loop. */
export type SettleIterationStats = {
  workSetSize: number;
  orderSize: number;
  actionsRun: number;

  /** Action IDs in the work set (truncated to top entries) */
  actions: { id: string; type: "effect" | "computation" }[];

  durationMs: number;
};

/** Stats for the entire settle loop of one execute() call. */
export type SettleStats = {
  iterations: SettleIterationStats[];
  totalDurationMs: number;
  settledEarly: boolean;
  initialSeedCount: number;
};

/** One recorded settle stats entry from execute() history. */
export type SettleStatsHistoryEntry = {
  recordedAt: number;
  stats: SettleStats;
};

export type ActionRunTraceEntry = {
  recordedAt: number;
  actionId: string;
  actionType: "effect" | "computation";
  parentActionId?: string;
  durationMs: number;
  declaredWrites: ActionRunTraceAddress[];
  actualWrites: ActionRunTraceAddress[];

  /** Server-execution v2 fan-out stage B: the instance key a fanned-out
   * run was stamped with (`space` for the probe, `user:…`/`session:…`
   * otherwise); absent on every other run. */
  instanceKey?: string;
};

export type ActionRunTraceAddress = {
  space: MemorySpace;
  entityId: URI;
  path: string[];
};

export type TriggerTraceValueKind =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object"
  | "other";

export type TriggerTraceValueSummary = {
  kind: TriggerTraceValueKind;
  size?: number;
  preview?: string | number | boolean | null;
};

export type TriggerTraceActionRecord = {
  actionId: string;
  actionType: "effect" | "computation";
  mode: "pull";
  decision:
    | "mark-invalid"
    | "already-invalid"
    | "skip-own-commit-source"
    | "skip-same-change-group";
  pendingBefore: boolean;
  pendingAfter: boolean;
  dirtyBefore: boolean;
  dirtyAfter: boolean;
};

export type TriggerTraceEntry = {
  recordedAt: number;
  notificationType: string;
  changeIndex: number;
  matchedActionCount: number;
  mode: "pull";
  writerActionId?: string;
  space: MemorySpace;
  entityId: URI;
  path: string[];
  before: TriggerTraceValueSummary;
  after: TriggerTraceValueSummary;
  triggered: TriggerTraceActionRecord[];
};

/** The `reason.message` of the seal-destination refusal an LT1
 * in-process copy receives when it seals OUTSIDE its appending wave
 * (server-execution v2 stage C build W3, (α); events.md §4). The
 * scheduler's event dispatch recognizes it to settle the copy QUIETLY:
 * the refusal is the invariant working, not a failed commit — the
 * durable entry is the truth and the drain delivers it. */
export const LT1_LATE_SEAL_REFUSED = "lt1-late-seal-refused";

export type ServedEventFailureOutcome =
  | {
    kind: "error" | "dropped";
    message: string;
  }
  | {
    kind: "deferred";
    message: string;
  }
  | {
    kind: "deferred";
    cause: "load-park";
    role: "failed-head";
    failure: ReplicaLoadFailure;
  }
  | {
    kind: "deferred";
    cause: "arrival-barrier";
    blockedBy: string;
  }
  | {
    /** Mark/effects atomicity (events.md §4, RULED 2026-08-27): the
     * dispatched handler's BODY did not run (the runner's
     * argument-did-not-resolve skip), so the transaction — carrying the
     * pre-stamped `consequenced` mark and nothing else — was WITHDRAWN
     * instead of sealed. No consequence: the entry stays pending and the
     * drain re-delivers it; the deferral threshold hardens a permanently
     * unresolvable argument into the visible §5 DROP notice. */
    kind: "deferred";

    cause: "handler-not-run";
    message: string;
  }
  | {
    kind: "deferred";
    cause: "delivery-failure";
    role: "failed-head";
    phase: "commit-preparation" | "commit-finalization";
    failure: ReplicaLoadFailure;
  };

/** The serving drain's per-event carriage (see QueuedEvent.served). */
export type ServedEventDispatch = {
  firedAt?: { user?: string; session?: string };
  streamEntry?: { sidecarId: string; index: number; seq: number };

  /** The EMITTING run's durable event id for a same-wave cascade
   * (C8d; review 2026-08-11 M2): cell.ts's LT1 same-space emission
   * queues the emitted event in-process with the emitter's own
   * `eventId` here, and the dispatch stamp threads it into the wave
   * run context as `parentEventId` — the fold key that rolls a
   * cascade child back with its requeued parent. Absent for root
   * (drain-dispatched) events and for derivation emitters (no
   * eventId to fold on; a requeued derivation withdraws the entry
   * with its own contribution). */
  parentEventId?: string;

  /** The LT1 same-space in-process copy's APPENDING-WAVE identity
   * (server-execution v2 stage C build W3, (α); events.md §4's RULED
   * one-entry-one-completed-run sentence): the EMITTING run's
   * transaction. Its seal chose the wave that carries this event's
   * durable entry, so the copy must COMPLETE (seal) into that same wave
   * or not at all — the SpaceServer's seal destination refuses a copy
   * sealing into any other wave (`events.lt1LateSealsRefused`), and
   * the durable entry is then the truth the drain re-runs WITH a
   * `streamEntry`. Present only on cell.ts's LT1 emission (a
   * `streamEntry`-less served copy); absent on the drain's copies and
   * everywhere client-side. */
  lt1?: { emitterTx: IExtendedStorageTransaction };

  /** The outcome is discriminated so an arrival-barrier follower can never
   * inherit the failing head's checkpoint or typed failure evidence. */
  onFailure?: (outcome: ServedEventFailureOutcome) => void;
};

export type QueuedEvent = {
  /** Durable event id minted at send (spec §7.5). */
  readonly id: string;

  /** The EMITTING run's event id for a CLIENT-side same-wave cascade
   * echo (independent review M1, 2026-08-11): cell.ts's plain
   * queueEvent threads it when the send came from within a
   * speculation-stamped handler run, so the dispatch stamp can mark
   * the run's navigate capture ATTEMPT-MINTED (the cascade's id is
   * fresh per attempt and diverges from the server's — see
   * navigate-context.ts). Deliberately NOT carried on `served`:
   * `served`'s PRESENCE classifies a no-handler outcome as
   * deferred-vs-dropped (the drain's cold-view deferral), and a
   * client echo must keep today's dropped shape. */
  readonly parentEventId?: string;

  /**
   * Whether `id` was supplied by the caller rather than minted at enqueue. A
   * caller-supplied id is a durable delivery id: the handling's receipt
   * address derives from it, so the entry is excluded from the backlog-cap
   * last-wins merge in both directions — never collapsed away, and never
   * chosen as a collapse survivor whose payload a later send rewrites
   * (spec §7.6, the backlog-cap exclusions).
   */
  readonly callerSuppliedId?: boolean;

  /**
   * Monotonic stamp minted at first enqueue and carried unchanged across
   * requeues (backoff, name-resolution). Commits are not awaited, so several
   * dispatched events can fail together and requeue in whatever order their
   * verdicts arrive; inserting by this stamp instead of at the front keeps
   * same-stream events in send order — an event never overtakes one sent
   * before it.
   */
  readonly enqueueSeq: number;

  /**
   * The wall-clock instant (ms) bound to this event, captured at its causal
   * origin: carried forward unchanged from the emitting handler's frame, or a
   * fresh reading for a renderer/root event. The dispatching handler's ambient
   * clock reads this (coarsened) instead of the live clock. See Frame.eventTime.
   * Mutable because the backlog-cap collapse rewrites the surviving entry with
   * the newest event's payload and time (last-wins), so the dispatched handler
   * reads the instant of the event that actually dispatches.
   */
  time?: number;

  /** The transaction whose handler sent this event, when transactional. */
  readonly originTx?: IExtendedStorageTransaction;

  eventLink: NormalizedFullLink;
  action: Action;
  handler: EventHandler;
  event: any;

  /** Guarded implementation whose input dependencies passed preflight. */
  preflightImplementation?: EventHandler;

  /**
   * Payload keys the RUNTIME itself injected into `event`'s value (send's
   * internal `runtimeInjectedEventKeys` option — the LLM tool-call path's
   * `result` cell). Dispatch stamps this onto the handling transaction
   * (`tx.dispatchedRuntimeInjectedEventKeys`), where the closed-world gate
   * exempts exactly these keys. Mutable for the same last-wins reason as
   * `time`: the backlog-cap collapse rewrites the surviving entry with the
   * newest event's payload, and the marker must describe THAT payload.
   */
  runtimeInjectedEventKeys?: readonly string[];

  /**
   * The FIFO slot was reserved before its handler's piece finished loading.
   * A loading head parks the whole event queue so later, already-registered
   * handlers cannot overtake it.
   */
  handlerLoadPending?: boolean;

  /**
   * The FIFO slot is held while the stale-basis retry that requeued this
   * event waits for the state it will re-run against (the conflict's
   * catch-up and the pull of the document it names). The head parks the
   * queue for that wait as it does for a loading handler, so a later event
   * cannot overtake the retry; the readiness continuation clears the flag
   * and queues an execution.
   */
  retryReadinessPending?: boolean;

  /** Internal exactly-once guard for terminal pre-dispatch drops. */
  finalOutcomeNotified?: boolean;

  /**
   * Whether a transient failure for this event should be retried. `true` routes
   * a transient commit failure through the exponential-backoff window and lets
   * the inSpace-name resolution path (RetryImmediately) re-run the handler;
   * `false` drops an unserved one-shot on either failure. A served event still
   * re-runs RetryImmediately in its current wave: the server owns the result,
   * while transient commit retries remain disabled and belong to the drain's
   * wave cadence. There is no name-resolution retry count: RetryImmediately is
   * bounded by the monotonic space-name cache (each re-run resolves at least one
   * previously-unresolved name, and a resolved name never becomes pending again).
   */
  retry: boolean;

  onCommit?: (tx: IExtendedStorageTransaction) => void;

  /**
   * Server-execution v2 Phase 3 (events-down): the serving drain's
   * per-event carriage. `firedAt` is the server-stamped acting identity
   * the handler runs as (LD1); `streamEntry` locates the durable entry
   * whose `consequenced` mark rides the handler's own transaction; and
   * `onFailure` is the drain's hook for the arms that need a
   * consequence written OUTSIDE the handler tx — the handler THREW, the
   * commit was refused pre-storage by deterministic CFC enforcement
   * (the give-up arm's discriminated call; both: the error is the
   * consequence, events.md §5), or the event DROPPED (no
   * runnable handler — the §5 drop predicate). Success needs no
   * callback: the mark rode the tx. Absent on every client-side event.
   */
  served?: ServedEventDispatch;

  notBefore?: number;

  /**
   * Number of transient commit failures this intent has hit. Drives the
   * exponential backoff exponent; carried across backoff retries. Covers every
   * transient commit failure, not only conflicts.
   */
  retryAttempts?: number;

  /**
   * Wall-clock deadline (performance.now()) after which a still-failing intent
   * surfaces a terminal error instead of retrying. Set from the first transient
   * failure and carried across backoff retries.
   */
  retryDeadline?: number;

  /**
   * How many backoff re-runs this event has taken after its handler body did
   * not run, counted against `HANDLER_NOT_RUN_BACKOFF_LIMIT`. A re-run parked
   * on a load is not counted. Carried across requeues.
   */
  notRunBackoffs?: number;
};
