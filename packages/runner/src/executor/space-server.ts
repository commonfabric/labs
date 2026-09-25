// The SpaceServer (server-execution v2 stage F, serving-loop.md §1, §3):
// one committing runtime per ACTIVE space. It owns the lease (renewed on
// a timer — stage B's cycle finally gets its cadence), the serving
// Runtime (flag ON, builtins registered, the pattern-update posture
// flipped server-side — §3e), the accepted-commit subscription (the
// host's in-process feed — plane (d)), and the wave loop: wake on
// accepted commit, run the affected graph to fixpoint through the
// stage-D wave machinery, commit ONE derived transaction per wave
// carrying the watermark (protocol.md §4).
//
// What activation LOADS (RULED 2026-08-02): there is NO piece-start
// policy. The space is one lazy reactive graph; activation loads graph
// structure sufficient to resolve the DEMANDED values (client
// subscriptions — the server's watch registry) and queued events — via
// `ensurePieceRunning`, the sanctioned prior art (the no-handler
// auto-load path), per demanded root, never "instantiate the pieces" as
// a step of its own. Undemanded derivations stay dirty-unmaterialized
// indefinitely.
//
// Phase-1 bounds, stated (the stage cut, plan Phase 1):
// - no events on the wire until Phase 3 (the event seam exists in the
//   wave machinery; this loop has no producers to drain), so
//   `events.*` counters stay 0 and the activation criterion
//   "undelivered events" has no instances yet;
// - demand at OFF-arm cardinality: per-run demanded identities plug in
//   at `#stampRun` (M1's seam); in Phase 1 the loop serves the graph
//   under its wave identity.
//
// Stage G lands the effect channel (serving-loop.md §4–§5): sealed
// post-commit effects defer to the per-space outbox and fire after the
// wave commit; effectful builtins' writebacks — marked with their
// effect key — commit as their OWN derived-class COMPLETION commits
// (never through the wave: §4's "never passes through §3d's sealing"),
// annotated from the outbox carriage captured at the original run's
// seal; the durable outbound-append rows deliver and retire through
// the outbox; `memo.*`/`outbox.*` counters are live.
import { debugStr } from "@commonfabric/data-model";
import {
  canResolveScopeKey,
  type CellScope,
  type ConfirmedRead,
  type DeliveryAttention,
  type DeliveryDeferral,
  eventAttentionEntryKey,
  eventAttentionIndexKey,
  identityOfScopeKey,
  resolveScopeKey,
  type ScopeKey,
  scopeKeyApplicableTo,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type StreamEventEntry,
  type StreamEventsDocValue,
  toDirtyKey,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { readGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";

import { ViewPlanPublisher } from "./view-plan-publisher.ts";

/** The deferral backstop cadence: with NO input arriving at all, a
 * deferred event retries once per tick and hardens into the DROP
 * after the full budget — bounded unrunnable-event cleanup (the park
 * criterion needs the drop) without racing the creation window. */
const EVENT_DEFERRAL_REARM_MS = 250;

/** The default bound on the tenure's awaited space-root ensure
 * (SpaceServerPolicy.rootEnsureDeadlineMs): generous — a cold compile
 * of the system root is seconds, not tens of seconds — because the
 * cost of firing early is only deferring the root to the client-era
 * creation path, while the cost of NO bound is a wedged tenure that
 * keeps its lease. */
const DEFAULT_ROOT_ENSURE_DEADLINE_MS = 30_000;

import {
  markRuntimeInjectedEventKeys,
  sanitizeRuntimeInjectedEventKeys,
} from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import {
  EXECUTION_LEASE_RENEW_INTERVAL_MS,
  EXECUTION_LEASE_TTL_MS,
  ExecutionLeaseCycle,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  selectForeignBasisRows,
  selectStaleBasisInstances,
} from "@commonfabric/memory/v2/scheduler-basis";
import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  ISpaceReplica,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  StoreReadThrough,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import {
  ensurePieceRunningVerdict,
  type EnsurePieceVerdict,
  type OwningRootAddress,
} from "../ensure-piece-running.ts";
import { ensureSpaceRootPattern } from "../ensure-space-root.ts";
import { asPatternIdentityRef } from "../meta-seam.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  type WaveCommitOutcome,
  type WaveCommitSink,
  waveRunContextOf,
  type WaveWriteAnnotation,
} from "./wave.ts";
import { engineReadThrough } from "./engine-read-through.ts";
import { EngineWaveCommitSink } from "./engine-wave-sink.ts";
import { readWatermarkSeq, watermarkDocLink } from "./watermark.ts";
import {
  bumpDerivedCommits,
  type ServingLoopStats,
  updateDeliveryCheckpointStats,
} from "./stats.ts";
import { type SealedEffectBatch, SpaceOutbox } from "./outbox.ts";
import { abandonRunnerAcceptanceEffects } from "./runner-acceptance.ts";
import { effectCompletionKeyOf } from "./effect-completion.ts";
import { markRendererTrustedEvent } from "../cfc/ui-contract.ts";
import { EVENT_DEFERRAL_DROP_THRESHOLD } from "../scheduler/constants.ts";
import { LT1_LATE_SEAL_REFUSED } from "../scheduler/types.ts";
import type { PostCommitSideEffect } from "../cfc/types.ts";
import {
  attentionForExpiredDeliveryFailure,
  MAX_EVENT_DELIVERY_FAILURE_BUDGET,
  observeDeliveryFailure,
  observeDeliveryRecovery,
  sameDeliveryAttention,
  sameDeliveryDeferral,
  spentDeliveryFailureMs,
} from "./delivery-failure.ts";

const logger = getLogger("space-server", { enabled: true, level: "warn" });

/**
 * Timing-only logger for the wave's phases. The §7 counters say how many
 * waves ran and how many hit the deadline; these say how long they took and
 * where inside one the time went. Recorded whether or not a logger is
 * enabled, and reported by `/api/health/stats` as `timingStats.executor` —
 * so a serving toolshed answers "how long is a wave" over HTTP, with
 * nothing switched on.
 */
const timing = getLogger("executor", { enabled: false });

/** Consecutive not-yet-loadable deferrals of ONE demanded root after
 * which the root counts as STUCK (`stats.structureLoadStuck`, once per
 * crossing) and the loop WARNS (`structure-load-stuck`, again at each
 * doubling of the streak). An observability knob, not a contract: the
 * routine creation race resolves in one or two cycles, so any streak
 * this long names a root whose piece cannot start — the OW46 class
 * (a demanded piece whose program docs never materialized parks in the
 * retry arm forever, invisible in the aggregate `structureLoadDeferred`
 * and logged only at debug level). */
export const STRUCTURE_LOAD_STUCK_AFTER = 8;

/** What one demanded root's structure-load attempt resolved: the verdict its
 * caller acts on, and every chain terminus the attempt read a pattern pointer
 * at — the demanded instance's, plus the space fallback's where that ran. A
 * `no-pattern-meta` verdict is the joint answer of those documents, so a
 * caller putting the question again puts it to all of them. */
type StructureLoadAttempt = {
  verdict: EnsurePieceVerdict;
  termini: readonly OwningRootAddress[];
};

/** Consecutive cycles a feed record's store refresh may fail before the
 * loop gives the space up to a `loop-failed` park (see
 * `SpaceServer.#refreshHeldDocuments`). Bounded so a permanently failing
 * engine read parks rather than spins, and above one so a single failed
 * read costs a retry rather than a tenure. */
export const STORE_REFRESH_ATTEMPTS = 3;

/** Consecutive pre-queue drain deferrals (the arrival-order barrier's
 * view-lag, sidecar-sync-failure, and queue-time-throw arms) after
 * which the blocking key counts as STUCK (`stats.events.preQueueDeferralStuck`, once per
 * crossing) — the pre-queue mirror of `STRUCTURE_LOAD_STUCK_AFTER`.
 * Neither arm reaches the queued class's `#eventDeferrals`, so the §5
 * DROP hardening never applies before queueing; this counter is the
 * detectability floor, and the order-preserving hardening (a persistent
 * streak becomes a notice IN ARRIVAL POSITION) is the OW45 row's owed
 * follow-up. */
export const EVENT_PREQUEUE_STUCK_AFTER = 8;

/** The sanctioned internal stamp kind's durable action id (serving-loop.md
 * §3d, RULED 2026-08-05: stage F names the kinds when it installs the
 * seal destination). */
const WATERMARK_ACTION_ID = "server-execution/watermark";

/** The acked-effect retirement's durable action id (Phase 4,
 * protocol.md §5: "the next wave retires acked entries" — a
 * bookkeeping-stamped wave write among protocol.md §1's
 * service-identity writes; serving-loop.md §3d names it with the
 * watermark advance). */
const EFFECTS_RETIREMENT_ACTION_ID = "server-execution/effects-retirement";

export type SpaceServerPolicy = {
  /** serving-loop.md §3's consequence-flush deadline T_flush (order
   * 50–100 ms; a policy knob tuned in Phase 6 — the toolshed bootstrap
   * reads SERVER_EXECUTION_FLUSH_DEADLINE_MS). */
  flushDeadlineMs?: number;

  /** Phase 6 (serving-loop.md §5's per-space budgets; README §3.8):
   * cap on dispatched-but-unsettled NETWORK effects per space —
   * "outstanding LLM calls". Undefined = unbounded. */
  maxOutstandingEffects?: number;

  /** Phase 6: per-space network-effect egress pacing (dispatches per
   * second, token bucket). Undefined = unpaced. */
  egressRatePerSecond?: number;

  /** OW45 arm-B stage 1 (review F2): the bound on the tenure's
   * awaited space-root ensure. The ensure's resolve path fetches with
   * no timeout of its own and can point at a remote host, and the
   * renew timer is independent of the wave loop — so an UNBOUNDED
   * await here would let one wedged fetch hold the first cycle open
   * forever while the tenure keeps the lease (no failover, events
   * queueing, no loop-failed park). On the deadline the ensure lands
   * in its counted-failure arm and the tenure proceeds serving; the
   * detached work's eventual writes stay safe — the CREATION arm
   * converges by address (cause-derived id + the OCC re-check), the
   * UPDATE arm by OCC refusal (the transition's stillMatches baseline
   * refuses a moved root, so stale-over-new is impossible). */
  rootEnsureDeadlineMs?: number;

  /** serving-loop.md §1's IDLE_PARK_MS. */
  idleParkMs?: number;

  renewIntervalMs?: number;

  /** OW54's owner-ratified cumulative confirmed failed-state budget. */
  deliveryFailureBudgetMs?: number;

  /** Injected wall clock for deterministic delivery-budget verification. */
  deliveryFailureNow?: () => number;

  /** The execution lease's TTL (serving-loop.md §2; production takes the
   * wire default EXECUTION_LEASE_TTL_MS). A knob so tests can pin the
   * mid-wave renew (stage C tuning T3) with a short tenure instead of
   * waiting out the 15-s default; the mid-wave renew fires once a wave
   * has run longer than TTL/3 without a renewal. */
  leaseTtlMs?: number;

  /** Deadline on the park's runtime dispose (park LIVENESS): a serving
   * runtime killed mid-wave can hang `runtime.dispose()` forever, and a
   * park gated on it never resolves `whenParked` — wedging every
   * chained recovery. On overrun the dispose is abandoned (loudly,
   * counted) and the park completes anyway. */
  parkDisposeTimeoutMs?: number;

  /** The host's failure-park re-activation backoff (read by the
   * ExecutorHost, not the SpaceServer): after N consecutive parks of one
   * space other than idle parks and parks on a rival's lease, its next
   * re-activation is delayed `min(base·2^(N−1), max)` — a permanently
   * failing space rebuilds at a bounded rate. An idle park or a
   * successfully committed wave clears the streak. */
  failureParkBackoffBaseMs?: number;

  failureParkBackoffMaxMs?: number;

  /**
   * Serve the serving runtime's HOME-space reads straight from the
   * engine: a document the replica does not hold is read synchronously
   * on first access, a `sync()` resolves from the engine without a
   * session watch, and the feed's admitted commits refresh the
   * documents the replica holds (`IStorageManager.installStoreReadThrough`
   * and `integrateStoreWrites`). Off, every load rides the loopback
   * session and the memory server's schema walk delivers the closure.
   * Foreign-space reads stay on the session either way. The toolshed
   * bootstrap reads SERVER_EXECUTION_STORE_READ_THROUGH.
   */
  storeReadThrough?: boolean;
};

/** What a SpaceServer hands its runtime factory (see
 * SpaceServerOptions.createRuntime). */
export type RuntimeFactoryContext = {
  /** The tenure's store read-through, present under
   * `SpaceServerPolicy.storeReadThrough`, for a factory to install on its
   * storage manager before any home-space read it performs itself. */
  storeReadThrough?: StoreReadThrough;
};

export type SpaceServerOptions = {
  space: MemorySpace;
  server: MemoryServer;
  engine: Engine.Engine;

  /** The service identity (DID) the DR1 holder is minted from — also the
   * loopback session's principal, which is what the read-row admission
   * matches (protocol.md §2). */
  serviceIdentity: string;

  /** Build the serving runtime over the LOOPBACK storage plane
   * (serving-loop.md §1 plane (a)). The factory owns auth and options;
   * the SpaceServer asserts the posture (flag ON). A factory that reads
   * the home space before returning installs `context.storeReadThrough`
   * on its storage manager first, when the context carries one; the
   * SpaceServer installs it on the returned runtime either way. */
  createRuntime: (context: RuntimeFactoryContext) => Promise<{
    runtime: Runtime;
    dispose: () => Promise<void>;
  }>;

  /** The process-lifetime localSeq counter for this space's wave sink
   * (engine-wave-sink.ts's replay keying — the host owns it). */
  localSeqRef: { value: number };

  /** The host's shared counters (serving-loop.md §7). */
  stats: ServingLoopStats;

  /** OW45 arm-B stage 1, RULED 2026-08-24 (the owner, verbatim in the
   * stage-1 report): production spaces always get a default pattern —
   * "in production there is no reason for a space to not have a
   * default pattern" — but tests may switch the tenure's space-root
   * ensure OFF ("for tests this is annoying overhead … a setting in
   * the in-memory version"). Default ON; `false` disables the
   * activation arming entirely (no ensure, no skip, no re-arm, no
   * counter movement). Per-space discrimination is explicitly
   * DEFERRED by the same ruling — this is a whole-instance switch,
   * never a policy about which spaces deserve roots. */
  ensureSpaceRoots?: boolean;

  policy?: SpaceServerPolicy;
  onParked?: (reason: string) => void;

  /** Internal deterministic-verification seam around the engine-direct wave
   * sink. Production omits it; tests can causally reject one identified wave
   * without replacing storage or parsing logs. */
  decorateWaveCommitSink?: (
    sink: WaveCommitSink,
    space: MemorySpace,
  ) => WaveCommitSink;

  /** Fired on each successfully committed wave — the host's
   * failure-streak reset signal (real served progress, as opposed to an
   * activation that merely got as far as building a runtime). */
  onWaveCommitted?: () => void;

  /** DIAGNOSTIC (tests): called as each wave cycle ends — committed or
   * not, and thrown or not. Most of the loop's counters — coverage
   * accounting, the demand pass's structure loads, the watermark clamp
   * — move inside a cycle and are visible only as numbers afterwards.
   * See `docs/development/waiting-in-tests.md`. */
  onWaveCycle?: () => void;

  /** DIAGNOSTIC (tests): called as each drain pass ends, with the
   * number of events it queued — `stats.events.processed` moves here.
   * A pass ends before the settle that follows it, so this is earlier
   * than the cycle edge above by as much as a flush deadline. */
  onEventDrainPass?: (queued: number) => void;

  /** DIAGNOSTIC (tests): called beside each deferral counter as a
   * served dispatch defers. A dispatch defers from the scheduler, which
   * runs free while a drain pass waits on a sidecar's sync, so this
   * fires inside a pass rather than at its end. */
  onEventDeferred?: () => void;

  /** DIAGNOSTIC (tests): called beside each `drainInFlightSkips`
   * increment, naming the event whose re-drain the in-flight guard
   * turned away. The check happens inside a drain pass, and so does
   * this. */
  onDrainInFlightSkip?: (eventId: string) => void;

  /** DIAGNOSTIC (tests): forwarded to this tenure's outbox — see
   * `SpaceOutbox`. */
  onEffectRetired?: () => void;

  /** DIAGNOSTIC (tests): the outcome of each space-root ensure attempt,
   * reported as the counters beside it move. The counters can only be
   * polled; a test that has to act once an attempt has landed waits on
   * this instead. */
  onRootEnsure?: (
    outcome: "created" | "resolved" | "skipped-no-owner" | "failed",
  ) => void;
};

const DEFAULT_FLUSH_DEADLINE_MS = 100;
const DEFAULT_IDLE_PARK_MS = 30_000;
const DEFAULT_PARK_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Phase 5's foreign re-mark decision (serving-loop.md §3b's cross-space
 * bullet; §6 step 2): the (action, instance) set whose recorded FOREIGN
 * inputs moved — each basis row whose `entity_space` is not the home
 * space is judged against THAT space's own co-hosted engine's head,
 * exactly like the home scan judges home rows. Returns only instances
 * NOT already in `alreadyStale` (the home scan's findings), in row
 * order. Extracted from the activation scan so the decision is
 * unit-pinned (the F5 fix — the catch in `activate` converts any
 * breakage here into a `basis-foreign-remark-failed` warn, an
 * invisible-by-design degradation, so the helper itself must hold the
 * test surface).
 */
export async function selectForeignStaleInstances(
  engine: Engine.Engine,
  scope: { branch: string; space: string },
  engineForSpace: (space: MemorySpace) => Promise<Engine.Engine>,
  alreadyStale: ReadonlyArray<{ action: string; actionScopeKey: string }>,
): Promise<Array<{ action: string; actionScopeKey: string }>> {
  const foreignRows = selectForeignBasisRows(engine, scope);
  const staleKeys = new Set(
    alreadyStale.map((entry) => `${entry.action}\0${entry.actionScopeKey}`),
  );
  const added: Array<{ action: string; actionScopeKey: string }> = [];
  for (const row of foreignRows) {
    const key = `${row.action}\0${row.actionScopeKey}`;
    if (staleKeys.has(key)) continue;
    const foreignEngine = await engineForSpace(row.entitySpace as MemorySpace);
    const head = Engine.selectDocHead(foreignEngine, {
      id: row.entity,
      scopeKey: row.entityScopeKey,
    });
    if (head > row.seq) {
      staleKeys.add(key);
      added.push({
        action: row.action,
        actionScopeKey: row.actionScopeKey,
      });
    }
  }
  return added;
}

/** The well-known never-a-piece id classes excluded from piece demand
 * (RULED 2026-08-07): a `computed:` doc is a derivation result, a
 * `cid:` doc is a content-addressed bundle, and the watermark doc is
 * the settledness subscription — none can ever carry `patternIdentity`
 * meta, so an `ensurePieceRunning` attempt (and its retry churn) is
 * structurally futile. Remaining `of:` ids are NOT distinguishable by
 * id class (a not-yet-created piece and a never-a-piece value doc look
 * alike) — the complete terminal-state design is the owed follow-up. */

/** The dedupe key of a demanding (principal, session) pair in the
 * registry (stage B): both components, so two sessions of one user are
 * two demanders (a node beneath the root may narrow to session for that
 * user). */
const demanderPairKey = (identity: ScopeKeyIdentity): string =>
  `${identity.principal ?? ""}\0${
    identity.sessionId === undefined ? "" : String(identity.sessionId)
  }`;

/** Coalesces demand notifications into one pending wake callback. Input
 * cycles can reconcile demand before it fires, and notifications racing a
 * pass can require another pass. The grace is separate from the active
 * wave's consequence-flush deadline. */
const DEMAND_WAKE_GRACE_MS = 300;

const neverAPieceRootId = (id: string): boolean =>
  id === SERVER_EXECUTION_WATERMARK_DOC_ID ||
  // Phase 4: the effects doc is a session-scoped VALUE doc every
  // flag-ON client subscribes to (protocol.md §5) — it can never carry
  // `patternIdentity` meta, so piece demand for it is structurally
  // futile (the same never-a-piece class as the watermark doc).
  id === SERVER_EXECUTION_EFFECTS_DOC_ID ||
  id.startsWith("computed:") ||
  id.startsWith("cid:");

/**
 * A pattern-lifecycle verb the serving loop runs on the space's runtime on
 * a requester's behalf — an `upload`, `instantiate`, or `setsrc` request
 * (docs/features/server-pattern-lifecycle.md). The loop runs `run` as a
 * step of a wave cycle, ahead of that cycle's event drain, so a transaction
 * the verb seals joins the cycle's wave, and one it stamps `directCommit`
 * commits to the store on its own. The request settles once that wave has
 * committed and `confirm` has passed.
 */
export type LifecycleVerb<T> = {
  /** The verb's name, for logs. */
  name: string;

  /** Runs the verb on the serving runtime and returns its receipt. */
  run: (runtime: Runtime) => Promise<T>;

  /**
   * Reads the durable state the verb was to leave and throws when it is
   * not there. Called after the carrying wave's commit step, so it is
   * the request's durability witness: a seal's acceptance is not
   * durability, since the wave commit can withdraw a contribution
   * (serving-loop.md §3d), and a withdrawn contribution leaves no trace
   * for this read to find.
   */
  confirm?: (runtime: Runtime, receipt: T) => Promise<void>;

  /**
   * The document ids of the piece roots the verb staged, which the loop
   * takes as warm demand for the rest of the tenure — the identity-less
   * root key the explicit warm request uses (serving-loop.md §1) — so the
   * cycle's demand pass loads and derives them. The verb's own commit is
   * the loop's, never its input, and a graph instantiated ahead of any
   * demand is not live; naming the root here is what gets a staged piece
   * derived. The receipt does not wait for that derivation: it follows
   * the wave commit, when the piece is durable and the loop owes its
   * first run.
   */
  demandRoots?: (receipt: T) => ReadonlyArray<string>;
};

/**
 * The message a queued verb rejects with when its space parks before the
 * verb ran; the host runs such a verb again on the successor tenure.
 */
export const LIFECYCLE_VERB_SPACE_PARKED =
  "the space parked before the lifecycle verb ran";

type QueuedLifecycleVerb = {
  verb: LifecycleVerb<unknown>;
  resolve: (receipt: unknown) => void;
  reject: (error: unknown) => void;
};

type RanLifecycleVerb = QueuedLifecycleVerb & {
  outcome: { failed: false; ok: unknown } | { failed: true; error: unknown };

  /**
   * The verb's own contributions, each by the wave it sealed into and its
   * index there — what the wave's commit outcome is read by to settle the
   * verb. Empty when the verb sealed nothing.
   */
  contributions: ReadonlyArray<{ wave: WaveAccumulator; index: number }>;

  /** The roots the verb named as demand, loaded once its wave committed. */
  demandRoots: ReadonlyArray<string>;

  /**
   * Every space-scoped document the verb's transactions wrote, the roots
   * included — what the warm re-announcement carries.
   */
  stagedWrites: ReadonlyArray<{ id: string; scopeKey: "space" }>;

  /**
   * The store seqs of the verb's direct commits, durable before the verb
   * returned; the latest of them and the cycle's wave commit is the seq the
   * warm re-announcement names.
   */
  directCommitSeqs: ReadonlyArray<number>;
};

/**
 * One space's serving loop. The SpaceServer IS the seal destination — a
 * stable dispatcher over rotating wave accumulators, so an action tx
 * that commits between waves opens the next wave rather than erroring
 * (natural double-buffering: commits arriving mid-wave belong to the
 * NEXT wave, serving-loop.md §3).
 */
export class SpaceServer implements TransactionSealDestination {
  readonly #options: SpaceServerOptions;
  readonly #holder: string;
  #lease: ExecutionLeaseCycle | undefined;
  #initializing = false;
  #runtime: Runtime | undefined;
  #viewPlanPublisher = new ViewPlanPublisher();
  #disposeRuntime: (() => Promise<void>) | undefined;
  #sink: WaveCommitSink | undefined;
  #renewTimer: ReturnType<typeof setInterval> | undefined;

  /** Wall-clock of the last successful acquire/renew (stage C tuning T3):
   * the mid-wave renew fires from the scheduler's cooperative yield once
   * `now − lastRenewAt ≥ TTL/3`, i.e. exactly when the interval timer
   * would have fired had the wave's settle let it. */
  #lastRenewAt = 0;

  /** The drain's IN-FLIGHT copies (stage C tuning, T3's companion guard
   * — see `events.drainInFlightSkips`): eventId → phase. A re-drain must
   * not queue a SECOND copy of an entry whose first copy is still queued,
   * shaper-held, running, OR whose consequence mark is sealed into a wave
   * the store has not yet committed. Phases: `queued` — the copy sits in
   * the scheduler (queued/held/running) and nothing of it has reached a
   * wave; `marked` — a consequence (the handler tx's mark, or the
   * drain's error/drop notice) is sealed into, or being staged for, an
   * OPEN wave. Release points, each a store-visible or provably-markless
   * end of the copy: the WAVE OUTCOME (`committedEventIds` ∪
   * `requeuedEventIds` after `commitWave` — every abort arm reports its
   * event-handler contributions as requeued), a DEFERRED dispatch (no
   * mark, `#armDeferredRescan` retries), the queued copy's final callback
   * while still `queued` (an aborted run — no mark), a notice that
   * failed to stage/seal, and park (the queue dies
   * with the runtime). Releasing at the copy's SEAL was not enough (self-
   * review finding 1): the mark rides an uncommitted wave while the entry
   * is still pending in the store, and a re-drain that hit a real await
   * in that window queued the second copy. Every id here was queued WITH
   * its `streamEntry` (the mark path), which is #5969's stated safety
   * condition for skipping a re-drain on the strength of another copy;
   * the LT1 in-process cascade copy (no streamEntry) is a different
   * producer and is deliberately NOT tracked here. */
  readonly #drainInFlight = new Map<string, "queued" | "marked">();

  #currentWave: WaveAccumulator | undefined;
  #sealChain: Promise<unknown> = Promise.resolve();
  #feed: AdmittedCommitNotice[] = [];
  #feedArrived: PromiseWithResolvers<void> | undefined;

  /** The feed record whose store refresh is failing and how many cycles in
   * a row it has: the drain holds that record and everything behind it for
   * the next cycle, and gives up at `STORE_REFRESH_ATTEMPTS`. */
  #storeRefreshFailure: { seq: number; attempts: number } | undefined;

  /**
   * Whether a shadow flip fired while no input waiter was installed; consumed
   * by the next `#waitForInput()` so the wake is never dropped between cycles.
   */
  #pendingShadowFlipWake = false;

  #inputHead = 0;

  /** Highest NON-self-echo seq drained — the watermark's advance
   * target. The loop's own derived commits return on the feed above W
   * and must not count as coverage-owed input, or every wave commit
   * would trigger a watermark-only successor chasing its own seq — a
   * self-inflicted commit storm (the v1 failure class §7's
   * amplification budget exists to catch). S1 (RULED 2026-08-19,
   * protocol.md §4) covers the same tail WITHOUT the storm: the
   * drain-settle quiescence advance below fires at most once per
   * quiescence transition — armed only by CONTENT-carrying derived
   * commits, never by its own bookkeeping-only commit. */
  #coverageHead = 0;

  #watermark = 0;

  /** S1 (RULED 2026-08-19): this loop's own committed derived seqs still
   * ABOVE the watermark — the drain-settle quiescence advance's
   * contiguity domain. The advance walks upward from its coverage base
   * strictly over seqs in this set (engine seqs are dense — MAX(seq)+1
   * inside the insert transaction — so an in-flight authored notice, a
   * late-authored record, or any foreign commit above the base is a
   * hole the walk stops at: fail-closed, never covering a seq the loop
   * has not accounted). Pruned as W advances; BOUNDED (combined review
   * 2026-08-19, F7) so a space whose W is persistently CLAMPED (a
   * wedged shadow floor — already surfaced as `watermarkClamped`
   * churn) cannot grow it without limit: past the cap the OLDEST entry
   * is evicted, which can only open a hole at the walk's base — the
   * advance then stops below the evicted seq (fail-closed, the pre-S1
   * posture for that tail), never claims an unaccounted one. On a
   * healthy space the prune-at-advance keeps the set near-empty and
   * the bound is never reached. */
  readonly #ownDerivedSeqs = new Set<number>();

  static readonly #MAX_OWN_DERIVED_SEQS = 4096;

  /** S1's once-per-quiescence-transition latch: armed when a wave with
   * CONTENT contributions or an effect completion lands — commits
   * whose seq can enter a client read basis; consumed when the
   * quiescence advance seals. A bookkeeping-only commit (the advance
   * itself, the input-driven advance-only wave) never arms it — the
   * #coverageHead comment's commit-storm class stays structurally
   * unreachable. */
  #settleAdvanceOwed = false;

  /** Distinguishes content arriving after a quiescence advance chose its tail. */
  #ownContentGeneration = 0;

  #active = false;
  #loopRunning = false;
  #parkRequested = false;
  readonly #parked = Promise.withResolvers<void>();
  #idleSince: number | undefined;
  #demandedRoots = new Set<string>();

  /** Demanded roots whose `ensurePieceRunning` has not yet SUCCEEDED —
   * it returned false (typically the creation race: the demand cycle
   * ran before the piece's `patternIdentity` meta applied to the
   * serving replica) or threw. Re-attempted once per demand cycle
   * until the load lands OR the root TERMINALIZES (below): cycles are
   * input-driven, and the missing meta arrives as an input (the
   * instantiation commit), which fires the cycle that retries —
   * bounded, no timers. Without this set a root attempted once before
   * its meta existed stayed in `#demandedRoots` forever and the piece
   * never started server-side (waves committed watermark-only while
   * `waitForSettled` claimed the derivation current). */
  readonly #pendingStructureLoads = new Set<string>();

  /** The TERMINAL not-loadable roots (stage P2-F, the OW19 demand-cycle
   * design — RULED direction 2026-08-07): a demanded root whose doc is
   * confirmed SYNCED from the durable store and still carries no
   * pattern meta stops retrying — no per-cycle churn — keyed by demand
   * key, valued with the load's observed doc ids. A commit touching an
   * observed doc RE-ARMS the root (back to `#pendingStructureLoads`),
   * which is what distinguishes not-yet (a creation race whose
   * instantiation commit arrives later) from never (a plain value doc
   * demanded as if it owned a piece). The ruled id-class exclusion
   * (computed:/cid:/watermark) already keeps the structurally-futile
   * classes out of piece demand entirely; this covers the remaining
   * `of:` ids, which id classes cannot split. */
  readonly #terminalStructureLoads = new Map<string, ReadonlySet<string>>();

  /** Consecutive deferral streak per demanded root (keyed by demand
   * key), feeding `stats.structureLoadStuck` and the
   * `structure-load-stuck` WARN once a streak crosses
   * `STRUCTURE_LOAD_STUCK_AFTER` (verification-coverage.md OW46): the
   * per-attempt aggregate `structureLoadDeferred` cannot distinguish a
   * forever-parked root — the home-profile shape, a piece whose
   * program docs never materialized — from routine one-cycle creation
   * races, and the per-attempt log line is debug-level. Cleared when
   * the root starts or terminalizes (a later re-stuck stretch counts
   * again); left untouched by the THROW arm, whose failures are
   * already loud (`structureLoadFailures` + warn per attempt). */
  readonly #structureLoadDeferralStreaks = new Map<string, number>();

  /** The single-flighted demand-structure load pass (stage P2-F): the
   * wave cycle races it against the flush deadline; a pass outliving
   * its wave keeps running and later cycles join it. */
  #structureLoadPass: Promise<void> | undefined;

  /** Cancellation boundary for structure work owned by this tenure. */
  readonly #structureLoadAbort = new AbortController();

  /** Documents changed by admissions over a whole demand pass — from the
   * pull that opens it through its last root's traversal, not one root's
   * attempt. The pull is what registers each root's watch, and a registered
   * watch is what lets a traversal read from the replica rather than fetch,
   * so a root's reading is taken over that whole span and an admission
   * anywhere in it is one the reading may not carry. Narrowing this back to
   * a per-root lifetime would let a commit landing after the pull terminalize
   * a root on a verdict that predates it. */
  #structureLoadChangedDocs: Set<string> | undefined;

  /**
   * Re-armed roots whose retry follows frame application. The settle loop
   * retries them before declaring their demanded derivations current.
   */
  readonly #rearmedAwaitingSettle = new Set<string>();

  /** A structure retry that must wake a cycle after an asynchronous load. */
  #pendingStructureRetryWake = false;

  /** Level-converted demand wake (stage B): a session's watch set
   * changed (or a session opened) and the grace elapsed; consumed by the
   * next #waitForInput. */
  #pendingDemandWake = false;

  /**
   * A monotonic demand-note generation, bumped on every `noteDemandChanged()`
   * (watch or push-growth). A pass snapshots it at its row read; if a note
   * lands _after_ that snapshot but while the pass is still in flight (a
   * straddling pass — the note's change is invisible to the rows this pass
   * already read), the pass's `.finally` re-latches `#pendingDemandWake` so the
   * _next_ wait runs a _fresh_ pass instead of sleeping out the idle window.
   * Bounded: only a note arriving mid-pass costs one extra pass; steady state
   * (no notes) never re-latches.
   */
  #demandNoteGeneration = 0;

  #passDemandNoteGen = 0;

  /** The demand wake's grace timer (see noteDemandChanged). */
  #demandWakeTimer: ReturnType<typeof setTimeout> | undefined;

  /** WARM DEMAND (the explicit warm request's demand half —
   * serving-loop.md §1's third activation trigger, RULED 2026-08-21):
   * the staged doc instances of warm-marked feed notices, captured at
   * `enqueueCommit` BEFORE the activation scan's feed filter (a warm
   * notice's seq is ≤ the scan head on a warm activation, so the feed
   * record itself is dropped — the capture must not be). The demand
   * pass unions these as identity-less ROOT keys — the anonymous-
   * session shape: a key with no demander pair — so a warmed,
   * SESSIONLESS tenure structure-loads the staged piece and derives it.
   * Tenure-scoped by construction: the map dies with this SpaceServer
   * at park (a fresh activation builds a fresh instance), and
   * recompute-on-demand is the ruled recovery posture for anything a
   * dying tenure drops (serving-loop.md §6 step 2). */
  readonly #warmDemandKeys = new Map<
    string,
    { id: string; scopeKey: string }
  >();

  /**
   * Count of push-growth demand wakes, bumped once per
   * `noteDemandChanged("push-growth")`, snapshotted into each settle record at
   * admission and differenced at coverage.
   *
   * It is part of the server-settle instrumentation (design §6 W4's metric;
   * §2.8 (c)). Per authored input: admission (the feed notice's arrival,
   * `enqueueCommit()`) → _coverage_ (the wave commit whose `derivedThrough` ≥
   * seq = the value-only settle) → and, when a push-growth demand wake fires
   * after coverage (the one-push-late structural-growth path, §2.3), the _next_
   * derived commit = the structural-growth landing. Attribution of a growth
   * wake to an input is by adjacency (the most recently covered input), stated
   * as such.
   */
  #growthWakeCounter = 0;

  /**
   * The last-folded demand-root enter counter value, so the space-lived
   * accumulators fold the _full_ delta since the last fold (capturing
   * between-pass hook transitions), not a pass-start snapshot. Reset to 0 when
   * the runtime is replaced (its counters zero on a fresh runtime).
   */
  #lastFoldedDemandEnters = 0;

  /** Like `#lastFoldedDemandEnters`, for the leave counter. */
  #lastFoldedDemandLeaves = 0;

  #cycleCounter = 0;
  #wavesCommitted = 0;
  readonly #pendingSettles = new Map<number, {
    seq: number;
    admittedAt: number;
    cyclesAtAdmit: number;
    wavesAtAdmit: number;
    growthAtAdmit: number;
    eventAppend: boolean;
  }>();

  /**
   * The most recently covered input. The internal growth bookkeeping
   * (`growthWakeAt`, `wavesAtCoverage`) lives on this _wrapper_, not on the
   * series entry, so it never leaks into the stats JSON; `entry` is the (clean)
   * series row that `#recordGrowthLanding()` promotes in place.
   */
  #lastCovered:
    | {
      entry: ServingLoopStats["settle"]["series"][number];
      growthWakeAt?: number;
      wavesAtCoverage: number;
    }
    | undefined;

  #growthAwaitingLanding = false;

  /** Wave-bound seals CHAINED but not yet applied (the F4 fix, as a
   * LEVEL): seal() returns after arming the seal chain, so a seal
   * landing in a cycle's last microtasks — after the closing wave
   * detached — is invisible to #hasWork()'s contribution count until
   * the chain runs, and the edge-triggered wake fired into no waiter;
   * the loop then armed and slept out the idle window over real work.
   * Counting chained-not-yet-applied seals makes #hasWork() see them:
   * a pre-detach seal drains before its own cycle's commit barrier
   * (`await #sealChain`), so it adds no spurious cycle, while a
   * post-detach seal keeps the loop running one more cycle — the
   * deterministic wake the removed host fan-out had provided
   * incidentally. */
  #pendingWaveSeals = 0;

  /** The activation scan's head: records at or below it are covered
   * by the basis re-mark and never drained (activation filters the
   * queued feed the same way). Late-arrival accounting keys off it. */
  #activationScanHead = 0;

  /** Exact-once guard for LATE records (seq ≤ inputHead at drain —
   * the two-producer notice race documented in #drainFeed): recently
   * drained seqs, insertion-ordered, pruned at a bound that far
   * exceeds any realistic in-process reorder window. */
  readonly #drainedLateWindow = new Set<number>();

  // (d′): `#demandSinks` (the per-key demand WALK effects,
  // `demand-walk:<space>/<root>`) is DELETED — demand is the tracked-ids
  // closure and its writers are standing demand roots (design §2.7).

  /** The DEMANDERS per demand key (server-execution v2 Phase 2, M1's
   * demand carriage — scopes.md §5: the demand supplies the run
   * identity; fan-out stage B: identity on SPACE-scoped demand rows too
   * — scopes.md §2's mechanism sentence, RULED 2026-08-16: a
   * principal's demand at a broad address is demand for THAT principal's
   * instance of every node that narrows beneath it). Keyed by demand key
   * (one per root INSTANCE the structure load addresses — the demand
   * walk that also keyed on this is DELETED), valued with EVERY
   * (principal, session) pair whose watch
   * names that key — a space root demanded by two users holds both
   * pairs; a user-scoped root demanded by two sessions of one user holds
   * both sessions (a node beneath it may narrow to session for that
   * user). The run SUPPLY reads this: the scheduler resolves an
   * action's demand roots through `#demandersFor` and derives the
   * instance set from the demanders and its own known-scope ratchet
   * (scheduler/fan-out.ts). Anonymous sessions (no principal) register
   * the key — structure and walk — but own no instance and are not
   * demanders. */
  readonly #demandersByKey = new Map<string, Map<string, ScopeKeyIdentity>>();

  /** Demand key → the piece root doc id its structure load RESOLVED to
   * (stage P2-F): a demanded root may be an argument/derived doc whose
   * owning piece `ensurePieceRunning` discovers by following the result
   * chain; the run supply must find the demand's identity from that
   * PIECE's actions too, not only when the demand names the piece root
   * itself. Entries retire with their demand key. */
  readonly #pieceRootByDemandKey = new Map<string, string>();

  /** The stage-G effect channel (serving-loop.md §4–§5). */
  #outbox: SpaceOutbox | undefined;

  /** A drain left undelivered rows behind (transport-class failure):
   * the next wave cycle re-drains even without fresh appends. */
  #outboxDrainOwed = false;

  /** Phase 3 (events-down): an event-append admission (or a wave's
   * requeue) owes the next wave a stream-sidecar scan — the drain
   * input (serving-loop.md §3's event-append classification; §6
   * step 4's reprocess scan is the same move at activation). */
  #eventScanOwed = false;

  /** OW45 arm-B server-ensure stage 1 (design PR #6209 §1, seat A2):
   * activation owes the tenure ONE space-root ensure — existence +
   * freshness, no start — run as the first serialized step of the wave
   * loop's first cycle (the #eventScanOwed / #outboxDrainOwed shape).
   * Single-flight per tenure, STRUCTURALLY: a SpaceServer is a
   * single-tenure object (#parkRequested never resets; the host builds
   * a REPLACEMENT SpaceServer per re-activation — host.ts
   * #activateInner / #reactivateAfterPark), so this flag's lifetime is
   * the tenure's and no re-arm bookkeeping exists to get wrong. It is
   * consumed before the ensure runs and never re-armed mid-tenure — a
   * failure or a fail-closed no-owner skip is counted and retried by
   * the NEXT tenure's activation, so a deterministic failure cannot
   * spin the loop. Idempotent across tenures and against clients: the
   * creation transaction's OCC re-read plus the cause-derived root
   * address converge every race on one root. */
  #rootEnsureOwed = false;

  /** The fail-closed skip's SAME-TENURE retry arm (stage-1 measurement
   * r01's boot-order finding): the host activates on SESSION-OPEN,
   * which precedes the client bootstrap's genesis ACL commit (the
   * space's commit #1 — INV-13), so a fresh space's first ensure finds
   * no owner and skips. Waiting for the next tenure would leave every
   * fresh space's ensure inert at the live topology. Set by the
   * no-owner skip; an admitted commit touching the ACL doc
   * (`of:<space>`) consumes it and re-arms the owed ensure — the
   * identity posture is unchanged (owner-resolved, fail-closed, never
   * the service DID), only the retry cadence moves from next-tenure to
   * owner-became-resolvable. Bounded: one re-arm per ACL-doc-touching
   * admission, and the ensure re-sets it only from another no-owner
   * skip. */
  #rootEnsureAwaitingOwner = false;

  /**
   * Lifecycle verbs awaiting the next wave cycle, in arrival order
   * ({@link runLifecycleVerb}). Drained by the cycle that runs them;
   * emptied, each rejected, by a park.
   */
  readonly #lifecycleVerbs: QueuedLifecycleVerb[] = [];

  /**
   * What the currently running verb's transactions seal, recorded by
   * `seal()` while `#runQueuedLifecycleVerbs` awaits the verb: the
   * space-scoped documents they write, and each accepted seal's
   * contribution, by wave and index. Seals are chained one at a time, so
   * the count right after a seal resolves names that seal's contribution
   * — another action's transaction sealing meanwhile gets its own entry
   * nowhere here, and cannot settle the verb.
   */
  #runningLifecycleVerb:
    | {
      writes: Map<string, { id: string; scopeKey: "space" }>;
      contributions: { wave: WaveAccumulator; index: number }[];
      directCommitSeqs: number[];
    }
    | undefined;

  /**
   * Transactions stamped `directCommit` (runtime.ts `ServerRunInfo`),
   * recorded at the stamp: the store seq at that moment, which the commit
   * holds every document it writes to, and the run's action id for the
   * log.
   */
  readonly #directCommits = new WeakMap<
    IExtendedStorageTransaction,
    { basisSeq: number; actionId: string }
  >();

  /**
   * The seq of the last wave this tenure committed with content, the seq
   * a verb's warm re-announcement names (`#settleLifecycleVerbs`) unless
   * one of the verb's own direct commits is later.
   */
  #lastCommittedWaveSeq: number | undefined;

  /**
   * The wave the current cycle's serving step closed and its commit
   * outcome, which settles the lifecycle verbs that sealed into it;
   * `undefined` until the step reaches its commit.
   */
  #servedWave:
    | { wave: WaveAccumulator; outcome: WaveCommitOutcome }
    | undefined;

  /** F6 (log hygiene): the no-owner WARN fires once per tenure — a
   * permanently-ownerless space whose ACL doc keeps getting written
   * would otherwise warn 1:1 with the re-arm; the counter carries the
   * per-event record either way. */
  #rootEnsureNoOwnerWarned = false;

  /** Phase 4 (protocol.md §5): an effects-doc-touching authored commit
   * (an ack) — or activation (a crash between ack and retirement must
   * still retire) — owes the next wave the acked-entry retirement scan.
   * Cleared only when the scan finds nothing retirable, so a dropped
   * retirement write (the bookkeeping conflict class's drop-whole arm,
   * serving-loop.md §3d) self-heals on the following cycle. */
  #effectsRetirementOwed = false;

  /** Consequence-notice seals in flight (the error/drop/skip arms):
   * awaited before the wave closes so their marks ride THIS wave. */
  readonly #eventNoticeWork = new Set<Promise<unknown>>();

  /** Consecutive DEFERRALS per eventId (cold-view piece loads). The
   * deferral arm exists for the creation race (OW19's conflation
   * caution: a not-yet-created piece and a never-startable one are
   * indistinguishable by id), so a bounded number of waves must pass
   * before a deferral hardens into events.md §5's DROP — the race
   * resolves within a few input-driven cycles, while a permanently
   * unstartable piece would otherwise re-drain forever (no notice, no
   * park). Cleared on activation (a fresh runtime re-tries from
   * scratch) and on any non-deferred outcome. */
  readonly #eventDeferrals = new Map<string, number>();

  /** Lease-local mirrors of durable OW54 processing checkpoints. A mirror is
   * installed only from stored state or after a wave confirms its write. */
  readonly #deliveryCheckpoints = new Map<string, DeliveryDeferral>();

  readonly #pendingDeliveryCheckpointWrites = new Map<string, {
    sidecarId: string;
    index: number;
    seq: number;
    checkpoint: DeliveryDeferral;
    wave?: WaveAccumulator;
  }>();
  readonly #pendingAttentionNotices = new Map<string, {
    sidecarId: string;
    seq: number;
    attention: DeliveryAttention;
    wave?: WaveAccumulator;
  }>();
  readonly #deliveryFailureWakeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #deliveryInputWakes = new Set<string>();
  readonly #deliveryCleanAttempts = new Set<string>();
  readonly #deliveryRecoveryAttempts = new Set<string>();
  readonly #deliveryCheckpointWriteBlocked = new Set<string>();
  readonly #attentionSealWriteBlocked = new Set<string>();

  /** Input frontier at which a processing-state write failed. Only a newer
   * admitted input may serve as the generic storage/input wake. */
  readonly #deliveryWriteBlockedAt = new Map<string, number>();

  /** Failed boundary associated with a checkpoint write that did not commit.
   * This is wake correlation only, never an age/checkpoint authority: a retry
   * re-observes the failure and starts from durable state. */
  readonly #uncommittedDeliveryFailureEpochs = new Map<string, string>();

  readonly #deliveryLoadRecoveries = new Map<string, string>();

  /** The deferral backstop timer (see EVENT_DEFERRAL_REARM_MS): armed
   * when a drain pass left deferred/transient work behind, so the scan
   * re-arms after a REAL wait even when no input ever arrives. Input
   * arriving first promotes the owed scan immediately (#drainFeed). */
  #deferredRescanTimer: ReturnType<typeof setTimeout> | undefined;

  /** Consecutive pre-queue barrier deferrals per blocking key (the
   * view-lagged entry's eventId; the failing sidecar's doc id; a
   * queue-time thrower's `queue\0`-prefixed eventId — its own namespace,
   * because the view check clears the bare eventId before the queue
   * attempt). Cleared when the key passes ITS arm's check; see
   * EVENT_PREQUEUE_STUCK_AFTER. */
  #preQueueDeferralStreaks = new Map<string, number>();

  /**
   * Earliest entry whose unavailable replica view stopped the last event scan.
   * It limits watermark coverage until a fresh scan can dispatch that entry.
   */
  #eventVisibilityFloor: number | undefined;

  /** Set when a LOAD-PARK deferral — or a handler-not-run withdrawal
   * (review-6459 F1, the same §2 obligation) — fires while a drain pass
   * is running (verification-coverage.md's OW45 residue member). The
   * scheduler's own arrival-order barrier holds every later-arrived
   * durable entry that is already QUEUED behind the deferred one, but
   * an entry this pass has not reached yet is out of its reach — and
   * the pass awaits TWICE per entry (a new sidecar's `sync()`, then the
   * stream doc's), so a deferral genuinely can land in either gap. The
   * drain reads this immediately before queueing each entry — past both
   * awaits — and stops the pass, the same barrier `break` the
   * sidecar-sync-failure arm makes. Cleared at the top of every pass. */
  #loadParkDeferredInPass = false;

  /** Post-commit effects of sealed transactions, deferred per wave
   * (serving-loop.md §3: effects hand to the outbox POST-commit, never
   * at seal). Admitted to the outbox after the wave's commit step;
   * discarded when the wave is abandoned (the park path — the runtime
   * dies with it, the crash-equivalent covered by memo re-miss). */
  readonly #pendingEffectsByWave = new Map<
    WaveAccumulator,
    SealedEffectBatch[]
  >();

  /** Which wave each sealed tx closed into — set at seal, consumed by
   * deferSealedEffects (which runs after the seal resolved, when the
   * wave may already have rotated). */
  readonly #waveByTx = new WeakMap<object, WaveAccumulator>();

  /** The APPENDING wave of each LT1 same-space in-process copy's run
   * (stage C build W3, (α); events.md §4's RULED one-entry-one-
   * completed-run sentence): tx of the copy's handler run → the wave
   * its EMITTER sealed into (`#waveByTx` of `ServedEventDispatch.lt1
   * .emitterTx`, resolved at the dispatch stamp — the emitter's commit
   * reaches `seal()` synchronously, before its copy can dispatch, so
   * the wave is known by then; `null` records an emitter whose seal was
   * NOT found — refused fail-closed). The copy must seal into exactly
   * that wave: its entry lands with the emitter's contribution and the
   * batch marks it there (`survivedEventIds`); a copy sealing into any
   * LATER wave (it was still running when the flush deadline closed
   * its wave — the purge reaches only the QUEUED leftovers) would commit
   * its consequences UNMARKED beside the drain's marked copy of the
   * same entry, the lunch gate's vote-toggle double. `seal()` refuses
   * it before it enters a wave (`events.lt1LateSealsRefused`). */
  readonly #lt1AppendingWave = new WeakMap<object, WaveAccumulator | null>();

  constructor(options: SpaceServerOptions) {
    this.#options = options;
    this.#holder = executionLeaseHolder(options.serviceIdentity);
  }

  get space(): MemorySpace {
    return this.#options.space;
  }

  get holder(): string {
    return this.#holder;
  }

  get active(): boolean {
    return this.#active;
  }

  get watermark(): number {
    return this.#watermark;
  }

  /** Resolves when this SpaceServer has fully parked: its runtime
   * disposed, and its lease released or the release's failure logged
   * (the row expires by TTL either way). The host chains its
   * re-evaluation of the space's ACTIVE criteria on it. */
  get whenParked(): Promise<void> {
    return this.#parked.promise;
  }

  /** Store head minus W — the per-space input to §7's watermarkLag. */
  get watermarkLag(): number {
    return Math.max(
      0,
      Engine.serverSeq(this.#options.engine) - this.#watermark,
    );
  }

  /**
   * Activate (serving-loop.md §3 "on activate"): acquire the lease (else
   * park), build the serving runtime, read W, re-mark the dirty frontier
   * from the basis index, and subscribe from the head the index scan ran
   * against — the host feeds records from its admission observer, and
   * records at or below the scan head are covered by the re-mark.
   */
  async activate(): Promise<boolean> {
    if (this.#active) return true;
    const { engine, space } = this.#options;
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: this.#holder,
      ...(this.#options.policy?.leaseTtlMs !== undefined
        ? { ttlMs: this.#options.policy.leaseTtlMs }
        : {}),
    });
    if (!lease.acquire()) {
      this.#options.onParked?.("lease-unavailable");
      return false;
    }
    this.#lease = lease;
    this.#lastRenewAt = Date.now();
    this.#options.stats.lease.held += 1;

    // Initialization includes asynchronous factory and recovery work. The
    // lease protects those reads before a serving loop can become active.
    this.#initializing = true;
    const renewMs = this.#options.policy?.renewIntervalMs ??
      EXECUTION_LEASE_RENEW_INTERVAL_MS;
    this.#renewTimer = setInterval(() => this.#renew(), renewMs);
    let activated = false;
    try {
      activated = await this.#initializeRuntime(lease);
      return activated;
    } finally {
      this.#initializing = false;
      if (!activated) {
        await this.#parkResources(
          lease.held ? "activation-failed" : "activation-lease-lost",
        );
      }
    }
  }

  async #initializeRuntime(lease: ExecutionLeaseCycle): Promise<boolean> {
    const { engine, space } = this.#options;
    // The tenure's store read-through, handed to the factory so a factory
    // that reads the home space before returning installs it first, and
    // installed again below for one that does not: the tenure's first
    // read is a miss, and a miss served from the engine is the whole
    // point.
    const storeReadThrough = this.#options.policy?.storeReadThrough === true
      ? this.#leaseHolderReadThrough(
        engine,
        engineReadThrough(engine, {
          onRead: () => {
            this.#options.stats.storeReads += 1;
          },
        }),
      )
      : undefined;
    const { runtime, dispose } = await this.#options.createRuntime(
      storeReadThrough === undefined ? {} : { storeReadThrough },
    );
    this.#runtime = runtime;
    this.#disposeRuntime = dispose;
    this.#renew();
    if (!lease.held) return false;
    if (runtime.experimental.serverExecution !== true) {
      throw new Error(
        "SpaceServer runtime must run with serverExecution enabled " +
          "(serving-loop.md §3: flag ON, server posture)",
      );
    }
    if (runtime.servingPosture !== true) {
      throw new Error(
        "SpaceServer runtime must be constructed with servingPosture " +
          "(serving-loop.md §3): without it the Phase-2 speculation " +
          "overlay is the runtime's default seal destination and its " +
          "factory-time structure loads would divert instead of " +
          "committing through the loopback plane",
      );
    }
    if (storeReadThrough !== undefined) {
      runtime.storageManager.installStoreReadThrough?.(space, storeReadThrough);
    }
    // MINOR-2: the fresh runtime's demand-root counters start at 0.
    this.#lastFoldedDemandEnters = 0;
    this.#lastFoldedDemandLeaves = 0;
    const sink = new EngineWaveCommitSink({
      engineFor: (s) => s === space ? engine : this.#foreignEngineFor(s),
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
      // The stage-G sqlite discharge: folded sqlite ops in wave batches
      // attach their cell-db file(s) through the memory server's own
      // machinery (same validations as the transact path), keyed by the
      // accumulator's per-run scope keys.
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        this.#options.server.attachWaveCommitSqliteDbs(
          s === space ? engine : this.#foreignEngineFor(s),
          s,
          operations,
          scopeKeyByOpIndex,
        ),
      // A lapse the renewal drivers have not reached yet shows first as the
      // memory server refusing a derived commit (serving-loop.md §2).
      onHomeRefused: () => {
        this.#confirmLease(engine);
      },
    });
    this.#sink = this.#options.decorateWaveCommitSink?.(sink, space) ?? sink;
    // The effect channel (stage G, serving-loop.md §4–§5). Phase 6
    // threads the per-space egress budgets (§5's outstanding-effect cap
    // + egress rate) from the policy.
    const outbox = new SpaceOutbox({
      stats: this.#options.stats,
      space: this.#options.space,
      server: this.#options.server,
      engine,
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
      ...(this.#options.onEffectRetired !== undefined
        ? { onEffectRetired: this.#options.onEffectRetired }
        : {}),
      ...(this.#options.policy?.maxOutstandingEffects !== undefined ||
          this.#options.policy?.egressRatePerSecond !== undefined
        ? {
          budget: {
            ...(this.#options.policy?.maxOutstandingEffects !== undefined
              ? {
                maxOutstandingEffects: this.#options.policy
                  .maxOutstandingEffects,
              }
              : {}),
            ...(this.#options.policy?.egressRatePerSecond !== undefined
              ? {
                egressRatePerSecond: this.#options.policy.egressRatePerSecond,
              }
              : {}),
          },
        }
        : {}),
    });
    this.#outbox = outbox;
    runtime.asyncWorkObserver = (work) => outbox.observeAsyncWork(work);
    runtime.effectMemoObserver = (event) => {
      if (event.kind === "superseded") {
        this.#options.stats.outbox.superseded += 1;
        return;
      }
      this.#options.stats.memo.hits += 1;
    };
    // Stage P2-F (the F1 fold-in, RULED 2026-08-13): a piece-start
    // setup/instantiation commit that fails on this serving runtime —
    // refused at the seal, withdrawn by the wave, rejected — is a
    // demanded-structure load that failed ASYNCHRONOUSLY (the start
    // path is fire-and-forget by design). Count it where the demand
    // cycle's synchronous failures already count, so the swallowed-
    // refusal class is a health-stats fact, never a log grep.
    runtime.pieceStartCommitFailureObserver = ({ actionId, error }) => {
      this.#options.stats.structureLoadFailures += 1;
      logger.warn("piece-start-commit-failed", () => [
        `piece-start commit ${actionId} failed on the serving runtime; ` +
        "counted structureLoadFailures (stage P2-F, F1)",
        error,
      ]);
    };
    // The shadow-flip WAKE (Phase 2's settle input barrier): a clamped
    // wave's floor lifts when the replica's parked promotion flips the
    // shadowed foreign value visible — a dirtiness with NO admitted
    // commit behind it (the commit was drained waves ago; only its
    // VISIBILITY changed), so nothing on the feed ends the loop's input
    // wait and a then-quiet space would sit out the idle window with W
    // still clamped. The replica's flip path resolves the wait
    // directly; the woken cycle derives over the foreign value and W
    // catches up. The wake also LATCHES (review thread r3739416418):
    // edge-triggered alone it was dropped whenever the flip fired while
    // no waiter was installed (mid-cycle), and the next #waitForInput
    // then slept the full idle window anyway; the latch converts the
    // edge to a level the next wait consumes.
    runtime.storageManager.open(space).replica.shadowFlipObserver = () => {
      this.#pendingShadowFlipWake = true;
      this.#feedArrived?.resolve();
    };
    runtime.storageManager.loadRecoveryObserver = (recovery) => {
      const relevantEventIds = [...this.#deliveryCheckpoints]
        .filter(([, checkpoint]) =>
          checkpoint.phase === "dispatch-load" &&
          checkpoint.state === "failed" &&
          checkpoint.recoveryEpoch === recovery.failedEpoch
        )
        .map(([eventId]) => eventId);
      for (
        const [eventId, failedEpoch] of this.#uncommittedDeliveryFailureEpochs
      ) {
        if (failedEpoch === recovery.failedEpoch) {
          relevantEventIds.push(eventId);
        }
      }
      if (relevantEventIds.length === 0) return;
      this.#deliveryLoadRecoveries.set(
        recovery.failedEpoch,
        recovery.recoveryEpoch,
      );
      for (const eventId of relevantEventIds) {
        this.#deliveryCheckpointWriteBlocked.delete(eventId);
        this.#attentionSealWriteBlocked.delete(eventId);
        this.#deliveryWriteBlockedAt.delete(eventId);
      }
      this.#eventScanOwed = true;
      this.#feedArrived?.resolve();
    };

    // Phase 4 (builtins.md §4, LT3): the served navigateTo's
    // connectivity check — the intent write requires the acting session
    // CONNECTED to this (computing) space.
    runtime.connectedSessionProbe = (principal, sessionId) =>
      this.#options.server.hasLiveSessionFor(space, principal, sessionId);
    // §7's servedIntentSealFailures (independent review NOTE-b): the
    // builtin logs the failure either way; the serving loop owns the
    // counter.
    runtime.notifyServedIntentSealFailure = () => {
      this.#options.stats.servedIntentSealFailures += 1;
    };
    // Phase 4 (protocol.md §5): arm the acked-effect retirement scan —
    // a crash between an ack and its retirement re-owes the scan here.
    this.#effectsRetirementOwed = true;
    // OW45 arm-B stage 1: the tenure owes the space one root ensure
    // (design #6209 §1 — "space open", server-side, IS activation; all
    // three triggers ensure, sessionless ones included: idempotence
    // makes the repeat cost one fast-path read, and a warm-provisioned
    // space gets its root before its first human open). Gated on the
    // RULED test switch (options.ensureSpaceRoots, default ON): with
    // it off nothing arms, so the skip/re-arm machinery and every
    // rootEnsure counter stay untouched for the tenure.
    this.#rootEnsureOwed = this.#options.ensureSpaceRoots !== false;

    // W = read watermark doc (0 if absent).
    this.#watermark = readWatermarkSeq(engine);

    // Recovery/warm start are the same move (serving-loop.md §6 step 2):
    // the activation scan computes the stale (action, instance) set
    // from the basis index and SURFACES it (counted, logged). Phase-1
    // truth, stated plainly: the scan does not yet seed scheduler
    // dirtiness — a fresh runtime holds no materialized graph to mark,
    // and recovery CORRECTNESS rides recompute-on-demand (a demanded
    // pull recomputes regardless, which is what makes the fresh-start
    // path sound). The index's skip-still-current warm-start VALUE
    // materializes when a later stage carries a materialized graph
    // across activation.
    const scanHead = Engine.serverSeq(engine);
    const { stale, foreignReadInstances } = selectStaleBasisInstances(
      engine,
      { branch: "", space },
    );
    // Phase 5's foreign re-mark (serving-loop.md §3b's cross-space
    // bullet; §6 step 2): recorded FOREIGN inputs are judged against
    // their own space's co-hosted engine — same surfacing posture as
    // the home scan (counted and logged; recovery correctness rides
    // recompute-on-demand over the fresh runtime either way, so a
    // failed foreign-head resolution degrades to conservative
    // surfacing, never a wedge).
    if (foreignReadInstances.length > 0) {
      try {
        stale.push(
          ...await selectForeignStaleInstances(
            engine,
            { branch: "", space },
            (foreignSpace) => this.#options.server.engineForSpace(foreignSpace),
            stale,
          ),
        );
      } catch (error) {
        logger.warn("basis-foreign-remark-failed", () => [
          `${foreignReadInstances.length} basis instance(s) carry ` +
          "cross-space reads and the foreign re-mark failed; " +
          "recompute-on-demand covers them (serving-loop.md §6 step 2)",
          error,
        ]);
      }
    }
    this.#renew();
    if (!lease.held) return false;
    logger.info?.("activate", () => [
      `space ${space} activated: W=${this.#watermark} scanHead=${scanHead} ` +
      `staleInstances=${stale.length}`,
    ]);
    // §6 step 4 (Phase 3): undelivered events — stream head past the
    // per-stream eventWatermark — reprocess. The scan is the same
    // discovery the per-wave drain runs; activation only ARMS it.
    this.#eventDeferrals.clear();
    for (const eventId of this.#deliveryCheckpoints.keys()) {
      this.#setActiveDeliveryCheckpoint(eventId, undefined);
    }
    this.#deliveryCheckpoints.clear();
    this.#deliveryCheckpointWriteBlocked.clear();
    this.#attentionSealWriteBlocked.clear();
    this.#deliveryWriteBlockedAt.clear();
    this.#uncommittedDeliveryFailureEpochs.clear();
    // The pre-queue streaks reset with it: a stale streak from a prior
    // tenure must not resume an obsolete count on a later re-block.
    this.#preQueueDeferralStreaks.clear();
    const pendingEventDocs = Engine.selectPendingStreamEventDocs(engine);
    for (const doc of pendingEventDocs) {
      for (const entry of doc.entries) {
        if (entry.deliveryDeferral === undefined) continue;
        this.#setActiveDeliveryCheckpoint(
          entry.eventId,
          entry.deliveryDeferral,
        );
      }
    }
    if (pendingEventDocs.length > 0) {
      this.#eventScanOwed = true;
      // Scan-covered appends never reach #drainFeed (the subscribe-from-
      // scan-head filter drops their notices), so §7's `appended` counts
      // them here.
      this.#options.stats.events.appended += pendingEventDocs.reduce(
        (total, doc) => total + doc.entries.length,
        0,
      );
      logger.info?.("activate-events", () => [
        `space ${space}: ${pendingEventDocs.length} stream(s) hold ` +
        "undelivered events; reprocess armed (serving-loop.md §6 step 4)",
      ]);
    }
    // Subscribe from the scan head: drop queued records the scan covers.
    this.#feed = this.#feed.filter((record) => record.seq > scanHead);
    this.#activationScanHead = Math.max(scanHead, this.#watermark);
    this.#inputHead = Math.max(this.#inputHead, scanHead, this.#watermark);
    this.#coverageHead = Math.max(this.#coverageHead, scanHead);

    // serving-loop.md §6 step 5: RE-SEND pending durable outbound-append
    // rows — a crash between a wave commit (which wrote the rows) and
    // their delivery re-sends here; duplicates dedupe at the target's
    // eventId horizon. Co-hosted delivery is an engine commit, not a
    // network await.
    try {
      const drained = await outbox.deliverPendingAppends();
      this.#outboxDrainOwed = drained.remaining > 0;
    } catch (error) {
      // Arm the owed re-drain (the stage-G review's M-B): rows a failed
      // activation re-send leaves behind must ride the NEXT wave's
      // drain, not wait for the next appends-carrying wave or another
      // re-activation.
      this.#outboxDrainOwed = true;
      logger.warn("activation-resend-failed", () => [
        "outbox re-send on activation failed; rows kept for the next " +
        "drain (serving-loop.md §6 step 5)",
        error,
      ]);
    }

    // The seal destination + the §3d run stamper (stage F names the
    // sanctioned internal stamp kinds when installing the destination:
    // "bookkeeping", used by the watermark write below) + the
    // per-(action × instance) run-supply resolver (stage P2-F): the
    // scheduler consults it at the reactive-action choke point and runs
    // a demanded action once per instance, stamped from the demand
    // registry through the seam above.
    this.#renew();
    if (!lease.held) return false;
    runtime.installSealDestination(this, {
      runStamper: (tx, info) => this.#stampRun(tx, info),
      runDemanderResolver: (pieceRootIds) => this.#demandersFor(pieceRootIds),
    });

    // The MID-WAVE renew (stage C tuning T3, serving-loop.md §2): the
    // renew timer above rides the macrotask queue a long settle used to
    // starve (the attribution's t2: renew gaps to 10 s against the 15-s
    // TTL, then `lease-lost` on every active space at once). The serving
    // scheduler now yields a macrotask between runs (cooperative-yield.ts)
    // — which already lets the timer fire — and reports every such yield
    // here, where a renew is issued directly once the wave has run TTL/3
    // without one: a belt that does not depend on the timer queue being
    // serviced, only on the scheduler reaching a run boundary.
    runtime.servingYieldObserver = () => this.#renewIfDue();

    this.#active = true;
    this.#options.stats.activeSpaces += 1;
    // The wakes for the checkpoints §6 step 4 replayed above: a wake is the
    // active tenure's to hold.
    for (const [eventId, checkpoint] of this.#deliveryCheckpoints) {
      this.#scheduleDeliveryFailureWake(eventId, checkpoint);
    }
    void this.#loop();
    return true;
  }

  /** Resolved co-hosted engines for FOREIGN spaces this loop's waves
   * provision into (protocol.md §2b — Phase 5). Populated by
   * #resolveForeignEngines ahead of each commit step; the sink's
   * engineFor lookup is synchronous, so a miss here is a sequencing
   * bug, not a recoverable state. Cleared on park (a re-activation
   * re-resolves — engines may have been closed meanwhile). */
  readonly #foreignEngines = new Map<MemorySpace, Engine.Engine>();

  #foreignEngineFor(space: MemorySpace): Engine.Engine {
    const engine = this.#foreignEngines.get(space);
    if (engine === undefined) {
      // The commit-step backstop (serving-loop.md §3d): reachable only
      // if a foreign batch bypassed #resolveForeignEngines — the
      // accumulation gate admits sanctioned crossings and the cycle
      // resolves their engines before commitWave, so this names a bug.
      throw new Error(
        `no resolved co-hosted engine for foreign space ${space}: the ` +
          "wave commit step runs after #resolveForeignEngines " +
          "(protocol.md §2b; serving-loop.md §3d's commit-step backstop)",
      );
    }
    return engine;
  }

  /** Resolve the co-hosted engines for a closing wave's foreign spaces
   * (Phase 5): same host, same process — store sequencing, not a
   * network await (protocol.md §2b). Failure is isolated PER SPACE
   * (the F1b fix): a space whose engine cannot resolve fails exactly
   * the contributions targeting it (wave.failForeignSpace — requeue
   * for events, drop for derivations; counted) and the wave commits
   * the rest. Before this isolation the un-caught await threw out of
   * the cycle — loop-failed → park + backoff for the HOME space, the
   * exact "space outage from one misdirected materialization" class
   * the RULED 2026-08-14 (c) accumulation refusal was built to
   * prevent, re-opened at the commit step. */
  async #resolveForeignEngines(wave: WaveAccumulator): Promise<void> {
    for (const space of wave.foreignSpaces) {
      if (this.#foreignEngines.has(space)) continue;
      try {
        this.#foreignEngines.set(
          space,
          await this.#options.server.engineForSpace(space),
        );
      } catch (error) {
        this.#options.stats.foreignEngineFailures += 1;
        logger.warn("foreign-engine-resolution-failed", () => [
          `co-hosted engine for foreign space ${space} failed to ` +
          "resolve; failing its contributions action-scoped and " +
          "committing the rest of the wave (protocol.md §2b; " +
          "serving-loop.md §3d's failure isolation)",
          error,
        ]);
        wave.failForeignSpace(
          space,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * THE SESSION REMOUNT's trigger, delivered by the host (storage/v2.ts
   * `consumeOwedSessionRemount` holds the mechanism and the argument): an
   * admitted commit touched `space`'s ACL doc, so a session this tenure's
   * runtime holds on that space — revoked when an EARLIER ACL landed — may
   * now re-open under a different verdict.
   *
   * `space` is usually NOT this server's own. The session that starves is
   * typically a CROSS-SPACE replica: a served dispatch whose argument set
   * links into the viewer's HOME space (ProfileCreateSurface's
   * `["defaultPattern","profiles"]` link is the store-proven case), where
   * the serving plane's pre-genesis session was de-authorized by that
   * space's genesis ACL. That is why this is a host fan-out rather than
   * this server's own `enqueueCommit`: the ACL commit and the starved
   * session are in different spaces.
   *
   * Sibling, not a duplicate, of `#rootEnsureAwaitingOwner`'s re-arm
   * below — the same boot order, the same trigger, one layer down (that
   * one re-arms an owed ensure for THIS space; this one re-arms an owed
   * session.open for ANY space this runtime reads).
   */
  noteSpaceAclChanged(space: MemorySpace): void {
    this.#runtime?.storageManager.noteSpaceAclChanged?.(space);
  }

  /** The host's in-process feed (plane (d)): every admitted commit for
   * this space, own derived commits included (skipped by class + holder
   * below — serving-loop.md §3's self-echo rule). */
  enqueueCommit(record: AdmittedCommitNotice): void {
    if (this.#structureLoadChangedDocs !== undefined) {
      for (const write of record.writes) {
        this.#structureLoadChangedDocs.add(write.id);
      }
    }
    // The no-owner skip's re-arm (see #rootEnsureAwaitingOwner): the
    // genesis ACL just landed — the owner is now resolvable, so the
    // tenure re-owes its ensure. Checked on the raw doc id: the ACL
    // document IS `of:<space>` (the memory server's aclDocId).
    if (
      this.#rootEnsureAwaitingOwner &&
      record.writes.some((write) => write.id === `of:${this.#options.space}`)
    ) {
      this.#rootEnsureAwaitingOwner = false;
      this.#rootEnsureOwed = true;
    }
    if (record.warm === true) {
      // The warm request's demand half (see #warmDemandKeys): captured
      // for every warm notice — pre-activation pendings, the
      // registration drain, and mid-tenure arrivals alike — and a
      // fresh capture notes a demand change so an idle-waiting loop
      // runs a fresh demand pass over it (the same grace-coalesced
      // latch a session's watch change uses).
      let captured = false;
      for (const write of record.writes) {
        // The canonical key encoding (the registry's own), so warm keys
        // can never drift from client demand keys.
        const key = toDirtyKey(write.id, write.scopeKey);
        if (!this.#warmDemandKeys.has(key)) {
          this.#warmDemandKeys.set(key, write);
          captured = true;
        }
      }
      if (captured) this.noteDemandChanged("warm");
    }
    this.#feed.push(record);
    if (
      record.class === "authored" && this.#active &&
      !this.#pendingSettles.has(record.seq)
    ) {
      this.#pendingSettles.set(record.seq, {
        seq: record.seq,
        admittedAt: performance.now(),
        cyclesAtAdmit: this.#cycleCounter,
        wavesAtAdmit: this.#wavesCommitted,
        growthAtAdmit: this.#growthWakeCounter,
        eventAppend: (record.eventAppends?.length ?? 0) > 0,
      });
      // A new input closes the previous input's growth-attribution window.
      this.#lastCovered = undefined;
      this.#growthAwaitingLanding = false;
      if (this.#pendingSettles.size > 4096) {
        const oldest = this.#pendingSettles.keys().next().value;
        if (oldest !== undefined) this.#pendingSettles.delete(oldest);
        this.#options.stats.settle.dropped += 1;
      }
    }
    this.#feedArrived?.resolve();
  }

  /** (d′): record coverage for every pending authored input
   * ≤ `coveredThrough` (W advanced past it in the wave that just
   * committed). */
  #recordSettleCoverage(coveredThrough: number): void {
    const now = performance.now();
    const series = this.#options.stats.settle.series;
    for (const [seq, rec] of this.#pendingSettles) {
      if (seq > coveredThrough) continue;
      this.#pendingSettles.delete(seq);
      const entry = {
        space: this.#options.space,
        seq,
        admittedAt: rec.admittedAt,
        coveredAt: now,
        ms: now - rec.admittedAt,
        waves: this.#wavesCommitted - rec.wavesAtAdmit,
        cycles: this.#cycleCounter - rec.cyclesAtAdmit,
        growthWakes: this.#growthWakeCounter - rec.growthAtAdmit,
        class: "value-only" as const,
        eventAppend: rec.eventAppend,
      };
      series.push(entry);
      this.#lastCovered = {
        entry,
        wavesAtCoverage: this.#wavesCommitted,
      };
    }
    if (series.length > 4000) {
      this.#options.stats.settle.dropped += series.length - 4000;
      series.splice(0, series.length - 4000);
    }
  }

  /** (d′): a push-growth wake fired — attribute it to the most
   * recently covered input (adjacency); its structural-growth landing is
   * the next derived commit. */
  #noteGrowthWakeForSettle(): void {
    const last = this.#lastCovered;
    if (last === undefined) return;
    if (last.growthWakeAt === undefined) last.growthWakeAt = performance.now();
    this.#growthAwaitingLanding = true;
  }

  /** (d′): a derived commit landed after a growth wake — the
   * structural-growth path's landing for the attributed input. */
  #recordGrowthLanding(): void {
    if (!this.#growthAwaitingLanding) return;
    const last = this.#lastCovered;
    this.#growthAwaitingLanding = false;
    if (last === undefined) return;
    const now = performance.now();
    const entry = last.entry;
    entry.class = "structural-growth";
    entry.growthLandedAt = now;
    entry.msGrowth = now - entry.admittedAt;
    entry.growthWaves = entry.waves +
      (this.#wavesCommitted - last.wavesAtCoverage);
    if (last.growthWakeAt !== undefined) {
      entry.graceMs = now - last.growthWakeAt;
    }
  }

  /** Reconsiders demanded roots after a session's demand changes.
   * Notifications share one pending grace callback, which latches a cycle.
   * Each notification also advances the demand generation, so a pass that
   * already captured its rows re-arms on completion. One callback can
   * therefore lead to multiple passes. Input-driven cycles reconcile demand
   * independently of the timer; the grace is a coalescing interval, not a
   * minimum wait for every new demand. */
  noteDemandChanged(reason: "watch" | "push-growth" | "warm" = "watch"): void {
    // MINOR-1: a fresh demand note — bump the generation so a pass that
    // already snapshotted its rows re-latches on completion.
    this.#demandNoteGeneration += 1;
    // (d′) — flag 1/2 instrumentation: count the wake sources
    // (the push-growth notify is the NEW site) and remember that a growth
    // wake fired, so the settle series can class the inputs it covers.
    // A WARM capture (the explicit warm request's staged instances
    // entering #warmDemandKeys) counts apart from client watch changes,
    // so `watchWakes` keeps meaning exactly the session-watch notifies.
    if (reason === "push-growth") {
      this.#options.stats.demand.pushGrowthWakes += 1;
      this.#growthWakeCounter += 1;
      this.#noteGrowthWakeForSettle();
    } else if (reason === "warm") {
      this.#options.stats.demand.warmWakes += 1;
    } else {
      this.#options.stats.demand.watchWakes += 1;
    }
    if (this.#demandWakeTimer !== undefined) return;
    this.#demandWakeTimer = setTimeout(() => {
      this.#demandWakeTimer = undefined;
      this.#pendingDemandWake = true;
      this.#feedArrived?.resolve();
    }, DEMAND_WAKE_GRACE_MS);
  }

  /**
   * Queue a lifecycle verb for the next wave cycle. Resolves with the
   * verb's receipt once the wave that carried its writes has committed
   * and its `confirm` step has passed; rejects with the verb's own
   * error, with `confirm`'s, or with {@link LIFECYCLE_VERB_SPACE_PARKED}
   * when the space parks before the verb ran — the one rejection the
   * host answers by queuing the verb on the successor tenure.
   */
  runLifecycleVerb<T>(verb: LifecycleVerb<T>): Promise<T> {
    if (!this.#active) {
      return Promise.reject(new Error(LIFECYCLE_VERB_SPACE_PARKED));
    }
    return new Promise<T>((resolve, reject) => {
      this.#lifecycleVerbs.push({
        verb: verb as LifecycleVerb<unknown>,
        resolve: resolve as (receipt: unknown) => void,
        reject,
      });
      // A verb is input: wake the loop out of its idle wait.
      this.#feedArrived?.resolve();
    });
  }

  //
  // TransactionSealDestination
  //

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    // A transaction stamped `directCommit` commits to the store on its own
    // (docs/features/server-pattern-lifecycle.md): serialized on the same
    // chain as wave seals, since it applies to the replica overlay through
    // sealNative once the store has taken it.
    const direct = this.#directCommits.get(tx);
    if (direct !== undefined) {
      const committed = this.#sealChain.then(() =>
        this.#commitDirect(tx, direct)
      );
      this.#sealChain = committed.then(() => undefined, () => undefined);
      return committed;
    }
    // Effect-COMPLETION routing (stage G, serving-loop.md §4): a marked
    // writeback of a served effect commits as its OWN derived-class
    // commit — it never enters a wave (§4's "never passes through §3d's
    // sealing"; the run is long over when the response arrives, so no
    // stamp exists to seal under). Serialized on the same chain as wave
    // seals: both mutate the replica overlay through sealNative.
    const completionKey = effectCompletionKeyOf(tx);
    if (completionKey !== undefined) {
      const committed = this.#sealChain.then(() =>
        this.#commitEffectCompletion(tx, completionKey)
      );
      this.#sealChain = committed.then(() => undefined, () => undefined);
      return committed;
    }
    // The LT1 late-seal REFUSAL (stage C build W3, (α1b); events.md §4:
    // "an entry whose in-process run does not complete within its
    // appending wave is dispatched by the drain alone"): an in-process
    // copy sealing into any wave but the one its emitter sealed into —
    // the deadline closed its wave while the copy was still running, or
    // the copy dispatched after the close — is refused BEFORE it enters
    // a wave (nothing of it reaches the replica overlay, so the drain's
    // copy running next reads clean state). Its consequences are
    // discarded; the durable entry, which landed with the emitter, is
    // the one the drain re-runs WITH a streamEntry — the one completed
    // run. Checked before #openWave(): a refused copy must not open an
    // empty wave of its own. The refusal also does NOT wake the loop
    // (`#feedArrived` is left alone): nothing of the copy needs a cycle,
    // and the drain's copy of the same entry — queued by the drain that
    // already found the entry unmarked — wakes it on its own seal. A
    // future caller that relied on "every seal wakes the loop" would
    // not get that from a refused seal.
    const appending = this.#lt1AppendingWave.get(tx);
    if (
      appending !== undefined &&
      (appending === null || appending !== this.#currentWave)
    ) {
      this.#options.stats.events.lt1LateSealsRefused += 1;
      const context = waveRunContextOf(tx);
      logger.debug?.("lt1-late-seal-refused", () => [
        `space ${this.#options.space}: LT1 in-process copy of ` +
        `${context?.eventId ?? "?"} sealed outside its appending wave; ` +
        "refused — the drain delivers the durable entry (events.md §4)",
      ]);
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: "LT1 in-process copy refused at the seal destination: it " +
            "completed outside the wave that carries its durable entry; " +
            "the drain delivers that entry exactly once (events.md §4, " +
            "one durable entry = one completed run)",
          reason: new Error(LT1_LATE_SEAL_REFUSED),
        },
      });
    }
    const wave = this.#openWave();
    this.#waveByTx.set(tx, wave);
    const runningVerb = this.#runningLifecycleVerb;
    this.#recordLifecycleVerbWrites(tx);
    const sealed = this.#sealChain.then(async () => {
      const before = wave.contributionCount;
      const result = await wave.seal(tx);
      // An accepted seal that added no contribution — a transaction with
      // nothing to write — settles nothing at the wave commit, so a verb
      // is not held to it.
      if (
        result.error === undefined && runningVerb !== undefined &&
        wave.contributionCount > before
      ) {
        runningVerb.contributions.push({
          wave,
          index: wave.contributionCount - 1,
        });
      }
      return result;
    }).then(
      (result) => {
        if (result.error !== undefined) {
          // An EVENT-STAMPED tx that failed its seal requeues its
          // event (owner review P1-2): the served navigateTo's intent
          // tx is a separate event-handler-stamped tx, and an isolated
          // seal failure must not leave the event consequenced-clean
          // with the intent lost. Noted INSIDE the seal chain, so the
          // flush's pre-commit `await #sealChain` barrier guarantees
          // the mark precedes commitWave. Non-event contexts note
          // nothing (noteSealFailure filters).
          wave.noteSealFailure(waveRunContextOf(tx));
        } else {
          // The drain's in-flight guard: an ACCEPTED event-handler seal
          // for a drained copy means its consequence mark now rides an
          // open wave — the copy stays in flight until the wave outcome
          // says the store committed or requeued it (never released at
          // seal; see #drainInFlight).
          const context = waveRunContextOf(tx);
          if (
            context?.kind === "event-handler" &&
            context.eventId !== undefined &&
            this.#drainInFlight.has(context.eventId)
          ) {
            this.#drainInFlight.set(context.eventId, "marked");
          }
        }
        return result;
      },
    );
    this.#sealChain = sealed.then(() => undefined, () => undefined);
    // The F4 window: a seal chained during the cycle's last microtasks
    // (after wave-detach) is not yet APPLIED when #hasWork() evaluates
    // — count it as pending work until the chain settles, so the loop
    // runs one more cycle instead of sleeping out the idle window over
    // a real contribution (correctness was never at stake — the
    // wait's timeout commits the pending wave — but the wake should
    // be deterministic, not eventually-timed). A pre-detach seal
    // drains before its own cycle's `await #sealChain`, adding no
    // extra cycle.
    this.#pendingWaveSeals += 1;
    const sealApplied = () => {
      this.#pendingWaveSeals -= 1;
    };
    sealed.then(sealApplied, sealApplied);
    // The scheduler runs autonomously off storage notifications: a seal
    // can arrive while the loop waits for input, and the wave it opened
    // must be committed — wake the loop.
    this.#feedArrived?.resolve();
    return sealed;
  }

  /**
   * Stage a cross-space event append onto the CURRENT wave for the run
   * owning `tx` (Phase 3; events.md §2's cross-space arm — the append
   * travels via the outbox as an authored commit, and the acting
   * identity travels WITH it). Dispatched from the send site
   * (cell.ts's serving branch) through the runtime's installed
   * destination.
   */
  stageOutboundAppend(
    tx: IExtendedStorageTransaction,
    row: OutboxAppendRow,
  ): void {
    const wave = this.#openWave();
    this.#waveByTx.set(tx, wave);
    wave.enqueueOutboundAppend(tx, row);
    this.#feedArrived?.resolve();
  }

  /**
   * TransactionSealDestination (stage G): take ownership of a sealed
   * transaction's post-commit effects — the loop hands external effects
   * to the outbox POST-wave-commit (serving-loop.md §3), never at seal,
   * where "ok" only means accepted into a wave. Effects of an abandoned
   * wave are discarded with it (park — the runtime dies, the
   * crash-equivalent path memo re-miss covers).
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    const wave = this.#waveByTx.get(tx);
    if (wave === undefined) return false;
    if (!this.#active || this.#outbox === undefined || wave.closed) {
      abandonRunnerAcceptanceEffects(effects, "Serving wave is closed");
      // The park-race straggler (the stage-G review's m-3): a tx that
      // sealed into a wave this server has since abandoned — or whose
      // commit resolves while the space is parking/parked — hands its
      // effects over AFTER the park cleared #pendingEffectsByWave,
      // possibly after a REACTIVATION rebuilt the outbox. OWN AND DROP
      // them (return true, store nothing): the abandoned wave's
      // effects are the intended crash-equivalent path §4/§6 already
      // cover (the effect re-misses from its memo key on demand), an
      // inline flush here would fire network work for a contribution
      // that never committed, and the pre-fix re-created map entry —
      // keyed by a wave no cycle will ever consume — leaked the wave
      // and its transactions for the server's lifetime.
      return true;
    }
    let pending = this.#pendingEffectsByWave.get(wave);
    if (pending === undefined) {
      pending = [];
      this.#pendingEffectsByWave.set(wave, pending);
    }
    pending.push({ tx, effects, context: waveRunContextOf(tx) });
    // Wake the loop: an effect-only batch (all-no-op tx — no
    // contribution) is otherwise invisible to it, and a handoff that
    // lands while the loop sits in #waitForInput would sleep out the
    // full idle window before the wave closes (round-2 thread 1).
    this.#feedArrived?.resolve();
    return true;
  }

  /** DIAGNOSTIC (tests): how many waves currently hold deferred effect
   * batches — the m-3 leak pin (a park-race straggler must not
   * re-create an entry nothing consumes). */
  get deferredEffectWaveCount(): number {
    return this.#pendingEffectsByWave.size;
  }

  /**
   * DIAGNOSTIC (tests): whether the loop is SUSPENDED on its input wait —
   * it ended a cycle with `#hasWork()` false and is now parked on
   * `#waitForInput`, having installed a waiter that nothing has resolved.
   *
   * This is the loop's settled state rather than a pause inside a cycle.
   * A loop whose cycles keep finding work of their own never reaches it:
   * `#hasWork()` holds at the end of each one, so the next begins without
   * the wait being entered at all. That is what makes it a test's
   * quiescence signal — the settling itself, observed, rather than an
   * interval during which nothing was seen to happen.
   */
  get suspendedOnInput(): boolean {
    return this.#feedArrived !== undefined;
  }

  /** DIAGNOSTIC (tests): the demanding identities recorded for a root
   * doc across its demand keys — M1's demand carriage (Phase 2), space
   * roots included (stage B). Two principals demanding one root yield
   * two entries; two sessions of one principal yield two. */
  demandedIdentitiesOf(id: string): ScopeKeyIdentity[] {
    const identities: ScopeKeyIdentity[] = [];
    for (const [key, demanders] of this.#demandersByKey) {
      if (key.endsWith(`\0${id}`)) identities.push(...demanders.values());
    }
    return identities;
  }

  #openWave(): WaveAccumulator {
    if (this.#currentWave === undefined) {
      const { engine, space } = this.#options;
      const runtime = this.#runtime!;
      this.#currentWave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        // The wave-level identity fallback: the serving session's own.
        // Per-run demanded identities arrive via #stampRun's run
        // contexts (M1), which take precedence per contribution.
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (s) => runtime.storageManager.open(s).replica,
        lease: this.#lease,
        // §3d refusals are COUNTED (§7): a non-zero count names an
        // undeclared commit path — the class that wedged the resumed
        // list builtins' recovery seeds until they stamped bookkeeping.
        onUnstampedSeal: () => {
          this.#options.stats.unstampedSealRefusals += 1;
        },
        // Fan-out stage B's counters (stats.ts): the early-emit guard's
        // fail-closed refusals, and design §B5's accept-and-count
        // undemanded narrowing runs.
        onEarlyEmitRefusal: () => {
          this.#options.stats.earlyEmitRefusals += 1;
        },
        onUndemandedNarrowing: () => {
          this.#options.stats.undemandedNarrowingRuns += 1;
        },
        // The Phase-5 serving posture (serving-loop.md §3d; protocol.md
        // §2b): foreign-space writes are ADMITTED at accumulation IFF
        // the sealing run carries the §2b delegated carriage (acting
        // identity + capabilityRef — the sanctioned `.inSpace`/
        // provisioning shape, which #stampRun supplies for served runs
        // acting as a principal) AND the acting identity holds a
        // structural write grant for the TARGET space (the probe
        // below — the F1 fix: carriage alone is minted for every
        // acting run and authorizes nothing). A carriage-less OR
        // ungranted foreign write — the lunch-wall class: a run
        // resolving against the SERVICE identity's ambient state, or
        // one reaching for a space its actor holds no authority
        // over — refuses action-scoped, loud, and counted into §7's
        // foreignWriteRefusals.
        foreignWrites: "accept",
        // The co-hosted memory server's structural grant supply
        // (protocol.md §2b): owner-by-identity (the actor's own home
        // space), fresh-store creation (§2b's sanctioned provisioning,
        // DID-shape-checked), or the target's own ACL granting the
        // actor WRITE — fail-closed otherwise. The refusal reason is
        // logged here; the wave's refusal message stays generic.
        foreignWriteGrant: async (foreignSpace, acting) => {
          const verdict = await this.#options.server
            .foreignWriteAuthorityFor(foreignSpace, acting.user);
          if (!verdict.granted) {
            logger.warn("foreign-write-ungranted", () => [
              `foreign write to ${foreignSpace} by acting identity ` +
              `${acting.user} holds no structural grant: ` +
              `${verdict.reason} (protocol.md §2b)`,
            ]);
          }
          // The FULL verdict, not just the boolean (OW31 B4): the wave
          // retains the `via` arm so the commit step forces a
          // `creation`-granted target's genesis ACL before the sink.
          return verdict;
        },
        onForeignWriteRefusal: () => {
          this.#options.stats.foreignWriteRefusals += 1;
        },
      });
    }
    return this.#currentWave;
  }

  /** serving-loop.md §3d's stamping duty: the scheduler hands every run
   * here. Per-run demanded identities (M1) PASS THROUGH this seam
   * (Phase 2): a run whose ServerRunInfo carries a demand-supplied
   * identity resolves its scoped reads, result cells, seal, basis rows,
   * and outbox carriage against THAT instance; a run without one keeps
   * the wave-level identity (the cardinality-1 fallback). The SUPPLY
   * side landed with stage P2-F: the scheduler consults
   * `#runInstancesFor` (installed beside this stamper) and runs a
   * demanded action once per instance, filling these fields per run.
   *
   * ATTRIBUTION (protocol.md §1; fan-out stage B, RULED 2026-08-16 —
   * design §F): a run's RESOLUTION identity and its ATTRIBUTION are two
   * things. The demand-supplied pair resolves the run's scoped
   * addresses (a full pair, so a narrower read it discovers still names
   * a real demanded instance). What the run ACTS AS is derived from the
   * scope it DISCOVERS by running — space → no actor; user → the user
   * (`firedAt.session = "server"` on its events); session → the pair —
   * settled at the seal from the transaction's read-scope ratchet
   * (wave.ts `settleScopeAttribution`) and, for a mid-run emission, at
   * the send site from the ratchet so far under the early-emit guard.
   * So a DERIVATION with a demanded identity is stamped
   * `attributionFromScope` and NO eager acting: a user-scoped instance
   * value belongs to all of the user's sessions and carries the user
   * only; a space node demanded by anyone carries none. HANDLER runs are
   * unchanged (the event's server-stamped `firedAt` is their explicit
   * actor — LD1; the in-process LT6 shape inherits the origin's pair).
   * Never DERIVED for `bookkeeping`: the loop's own writes are
   * service-identity writes that carry addressing and NO acting
   * principal (protocol.md §1's "The SpaceServer's own writes") — with
   * ONE explicit exception: a bookkeeping run carrying `info.delegated`
   * (OW31 seat S-A — the compile-cache / program materialization
   * writeback into a piece's own space) is stamped with the TRIGGERING
   * run's carriage verbatim, so the crossing rides §2b's delegated
   * admission instead of being refused carriage-less. */
  #stampRun(tx: IExtendedStorageTransaction, info: ServerRunInfo): void {
    if (info.directCommit === true) {
      // The basis every document the transaction writes is held to, taken
      // here, ahead of the run's first read, the way a wave takes its
      // basis when it opens; a document it reads is held to the seq the
      // read saw as well.
      if (info.kind !== "bookkeeping") {
        throw new Error(
          `run ${info.actionId} asked for a direct commit as a ` +
            `${info.kind} run; only a bookkeeping run commits outside the ` +
            "wave (serving-loop.md §3d)",
        );
      }
      this.#directCommits.set(tx, {
        basisSeq: Engine.serverSeq(this.#options.engine),
        actionId: info.actionId,
      });
      // Authoritative, as an effect completion's writes are: the no-op
      // elision diffs against the replica's optimistic view, which can
      // hold a sealed layer the wave later drops.
      tx.markAuthoritativeWrites?.();
    }
    const principal = info.scopeKeyIdentity?.principal;
    const attributionFromScope = info.kind === "derivation" &&
      info.acting === undefined && principal !== undefined;
    const sessionId = info.scopeKeyIdentity?.sessionId;
    const readCeiling = info.kind !== "bookkeeping" && sessionId !== undefined
      ? this.#options.server.sessionReadCeiling(this.#options.space, sessionId)
      : undefined;
    // The S-A carriage (OW31; protocol.md §2b): a bookkeeping run
    // sanctioned to cross — the compile-cache / program materialization
    // writeback into the piece's own space — carries the TRIGGERING
    // run's delegated carriage verbatim. Everything below that reads
    // `info.acting`/mints a capabilityRef is bypassed for it: the
    // carriage is the trigger's, never derived here.
    if (info.kind === "bookkeeping" && info.delegated !== undefined) {
      // The carriage's trust snapshot (OW34-family; serving-loop.md §3c):
      // the delegated writeback's CFC labels resolve against the
      // delegated acting principal, matching the memory-plane carriage.
      tx.setCfcTrustSnapshot(
        this.#runtime!.trustSnapshotForPrincipal(info.delegated.acting.user),
      );
      stampWaveRunContext(tx, {
        actionId: info.actionId,
        kind: info.kind,
        acting: info.delegated.acting,
        capabilityRef: info.delegated.capabilityRef,
      });
      return;
    }
    const acting = info.kind !== "bookkeeping" && !attributionFromScope &&
        principal !== undefined
      ? {
        user: principal,
        ...(info.scopeKeyIdentity?.sessionId !== undefined
          ? { session: String(info.scopeKeyIdentity.sessionId) }
          : {}),
      }
      : undefined;
    // The run's trust snapshot (OW34-family; serving-loop.md §3c): the
    // acting principal the run carries — a handler's server-stamped
    // `firedAt` actor (LT6-inherited pairs included), else a demanded
    // derivation's demand-supplied principal (eager at stamp: labels mint
    // at prepare, BEFORE the seal settles the memory-plane attribution
    // from the discovered scope, and derivations cannot mint
    // current-principal labels, so the divergence is consequence-free).
    // An actor-less run keeps the ambient service snapshot edit()
    // attached (protocol.md §1's "The SpaceServer's own writes"; RULED
    // 2026-08-21) — set at most once here, before the run's first read,
    // so prepare and the commit-time recheck see one value and the
    // `trust-snapshot-changed` invalidation stays a dead tripwire.
    const trustPrincipal = (info.acting ?? acting)?.user ??
      (info.kind === "derivation" ? principal : undefined);
    if (trustPrincipal !== undefined) {
      tx.setCfcTrustSnapshot(
        this.#runtime!.trustSnapshotForPrincipal(trustPrincipal),
      );
    }
    stampWaveRunContext(tx, {
      actionId: info.actionId,
      kind: info.kind,
      ...(info.eventId !== undefined ? { eventId: info.eventId } : {}),
      // C8d's fold key (review 2026-08-11 M2): a same-wave cascade
      // child carries its emitter's eventId; the wave's requeue
      // closure folds the child into the requeued parent's rollback.
      ...(info.parentEventId !== undefined
        ? { parentEventId: info.parentEventId }
        : {}),
      ...(info.scopeKeyIdentity !== undefined
        ? { scopeKeyIdentity: info.scopeKeyIdentity }
        : {}),
      // The read ceiling of the session this run acts as, read from the
      // memory server's session record — the seam a declared ceiling (the
      // client's signed `session.open` descriptor) and a server-assigned
      // one both reach the run through. Stamped with the identity, before
      // the run's first read, so the sqlite builtin's request hash and
      // its flush read one value. Never for bookkeeping: the loop's own
      // writes act as no session.
      ...(readCeiling !== undefined ? { readCeiling } : {}),
      ...(info.actionScopeKey !== undefined
        ? { actionScopeKey: info.actionScopeKey }
        : {}),
      // Precedence: an EXPLICIT acting carriage (Phase 3's dispatch
      // reads it off the event's server-stamped `firedAt`) is the
      // event's own durable actor and wins; a HANDLER inheriting a
      // demanded pair (the in-process LT6 shape) carries it; a
      // DERIVATION's acting is settled from its discovered scope.
      ...(info.acting !== undefined
        ? { acting: info.acting }
        : acting !== undefined
        ? { acting }
        : {}),
      ...(attributionFromScope ? { attributionFromScope: true } : {}),
      // Phase 5 (protocol.md §2b's sanctioned crossing): a served run
      // acting AS a principal carries the delegated GRANT alongside its
      // actor, so its provisioning writes (a handler's `.inSpace`
      // creation, a demanded wish's home-space bootstrap) are
      // admissible at the wave's accept gate and at the target's
      // delegated admission. Structural presence, following the FP1
      // outbox precedent (`stream-append:<sidecarId>`): grant
      // RESOLUTION against per-doc grants is the OW13 owed hardening —
      // no per-doc grant store exists yet. Never for bookkeeping (the
      // loop's own writes carry no acting principal, protocol.md §1),
      // and never without an actor (a carriage-less foreign write
      // refuses at accumulation, by design).
      // A derivation attributed from its scope mints its
      // `demanded-run:<user>` carriage at the seal alongside its acting
      // (settleScopeAttribution) — none while unnarrowed.
      ...(info.kind !== "bookkeeping" &&
          (info.acting !== undefined || acting !== undefined)
        ? {
          capabilityRef: info.kind === "event-handler"
            ? `event-consequence:${info.eventId ?? "unidentified"}`
            : `demanded-run:${(info.acting ?? acting)!.user}`,
        }
        : {}),
      ...(info.streamEntry !== undefined
        ? { streamEntry: info.streamEntry }
        : {}),
      // The LT1 in-process copy marker (stage C build W3, (α3)): the
      // wave's requeue closure refuses the copy as an orphan when no
      // surviving contribution appends its entry.
      ...(info.lt1 !== undefined ? { lt1: true as const } : {}),
    });
    if (info.lt1 !== undefined) {
      // The LT1 in-process copy's appending wave (stage C build W3,
      // (α)): resolved HERE, at dispatch, from the emitter's sealed tx —
      // see #lt1AppendingWave. Unknown (the emitter never sealed, or
      // sealed nothing) records `null`: the copy's own seal is then
      // refused, and the durable entry — if it ever lands — is the
      // drain's to deliver.
      this.#lt1AppendingWave.set(
        tx,
        this.#waveByTx.get(info.lt1.emitterTx) ?? null,
      );
    }
    if (info.streamEntry !== undefined) {
      // Phase 3 (events.md §4): the entry's `consequenced` mark rides
      // the handler's OWN transaction — sealed with its consequences,
      // rolled back with them (a thrown handler aborts the tx; a
      // requeued contribution withdraws whole), so the mark can never
      // outlive or precede the consequences it stands for. Written
      // BEFORE the handler runs; order within one tx is immaterial.
      // The per-stream `eventWatermark` is NOT written here: the
      // engine recomputes it from the contiguous consequenced frontier
      // inside the wave commit's own transaction (applyCommitTransaction
      // — a requeued entry holds it back, matching the model).
      try {
        this.#runtime!.getCellFromLink<boolean>({
          space: this.space,
          id: info.streamEntry.sidecarId as never,
          scope: "space",
          path: [
            "entries",
            String(info.streamEntry.index),
            "consequenced",
          ],
        }).withTx(tx).set(true);
        if (
          info.eventId !== undefined &&
          (this.#deliveryCheckpoints.has(info.eventId) ||
            this.#pendingDeliveryCheckpointWrites.has(info.eventId))
        ) {
          this.#runtime!.getCellFromLink<DeliveryDeferral | undefined>({
            space: this.space,
            id: info.streamEntry.sidecarId as never,
            scope: "space",
            path: [
              "entries",
              String(info.streamEntry.index),
              "deliveryDeferral",
            ],
          }).withTx(tx).set(undefined);
        }
      } catch (error) {
        // The mark IS the exactly-once record (events.md §4: no window
        // where an event is both consumed and replayable). Letting the
        // handler's consequences commit UNMARKED would re-run them on
        // the next drain — double consequences. Abort the tx instead:
        // the dispatch's error arm seals the error consequence (the
        // notice tx re-attempts the mark), and if that fails too the
        // entry simply stays pending — re-drained, never doubled.
        logger.warn("event-mark-failed", () => [
          `consequenced mark for ${info.eventId} failed at stamp time; ` +
          "aborting the handler tx (unmarked consequences would " +
          "re-run — events.md §4)",
          error,
        ]);
        tx.abort(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /** The per-(action × instance) run supply's resolver (stage P2-F,
   * reshaped by fan-out stage B), installed beside the stamper: the
   * DEMANDERS of an action's DEMAND ROOTS — its piece root plus the
   * ancestor piece roots that instantiated it (Phase 7;
   * `SchedulerObservationIdentity.demandRootIds`: a nested pattern node
   * or result-as-pattern child is demanded through the OUTER piece a
   * client watches, and pre-Phase-7 its scoped derivations fell to the
   * service identity's instances) — from the demand registry: entries
   * whose demand key names one of the roots directly plus entries whose
   * structure load RESOLVED to one (`#pieceRootByDemandKey`), every
   * (principal, session) pair deduped. Space-scoped demand rows carry
   * their demanders too (stage B): the scheduler derives the instance
   * set from these pairs and the node's own known-scope ratchet — a
   * space node runs once (as a demander, never as the service), a
   * narrowed one per demanding principal or session. Only when NO
   * principal demands the roots does the run keep the wave-level
   * fallback (design §B5). Additionally, the current event's actor is a
   * TRANSIENT demander of the piece its event targets (RULED
   * 2026-08-16, design §B5): preflight recomputes a dirty scoped input
   * for the actor's OWN instance even if the actor watches nothing. */
  #demandersFor(pieceRootIds: readonly string[]): ScopeKeyIdentity[] {
    const demanders = new Map<string, ScopeKeyIdentity>();
    // (d′) — flag 6: indexed by root id (and by resolved piece
    // root) instead of a full key scan; same answer as the scan.
    const visit = (keys: Set<string> | undefined) => {
      if (keys === undefined) return;
      for (const key of keys) {
        const pairs = this.#demandersByKey.get(key);
        if (pairs === undefined) continue;
        for (const [pairKey, identity] of pairs) {
          if (!demanders.has(pairKey)) demanders.set(pairKey, identity);
        }
      }
    };
    for (const rootId of pieceRootIds) {
      visit(this.#keysByRootId.get(rootId));
      visit(this.#keysByResolvedRoot.get(rootId));
    }
    // The event actor as a TRANSIENT demander (RULED 2026-08-16, design
    // §B5 / §I.5): while a served event is queued for dispatch, its
    // `firedAt` pair counts as a demander of the event's TARGET piece,
    // so the dispatch's preflight recompute of a dirty scoped input
    // materializes the ACTOR's own instance even if the actor watches
    // nothing (the actor is entitled to it — the append was admitted
    // under their authority; never another principal's — no
    // reverse-FP2). The scheduler owns the queue and reports the pairs.
    for (
      const identity of this.#runtime?.scheduler.transientEventDemandersFor(
        pieceRootIds,
      ) ?? []
    ) {
      if (identity.principal === undefined) continue;
      const pairKey = demanderPairKey(identity);
      if (!demanders.has(pairKey)) demanders.set(pairKey, identity);
    }
    return [...demanders.values()];
  }

  /** Records an own derived commit for the bounded quiescence advance. */
  #recordOwnDerivedCommit(seq: number, hasContent: boolean): void {
    this.#ownDerivedSeqs.add(seq);
    if (this.#ownDerivedSeqs.size > SpaceServer.#MAX_OWN_DERIVED_SEQS) {
      // Evicting the oldest entry opens a hole; the advance stops below it.
      const oldest = this.#ownDerivedSeqs.values().next();
      if (!oldest.done) this.#ownDerivedSeqs.delete(oldest.value);
    }
    if (hasContent) {
      this.#ownContentGeneration += 1;
      this.#settleAdvanceOwed = true;
    }
  }

  /**
   * The effect-COMPLETION commit (stage G, serving-loop.md §4's miss
   * rule): a served effect's writeback — result + `requestHash`, the
   * claim/pending markers, error-shaped results — commits as ONE
   * derived-class commit of its own. It never passes §3d's sealing (no
   * wave, no basis rows, no run stamp — the run is long over when the
   * response arrives); its identity annotations are sourced from the
   * OUTBOX CARRIAGE captured at the original run's seal (necessarily
   * stamped, so completion commits inherit stamped provenance
   * transitively — the 2026-08-05 clarification), falling back to the
   * wave-level identity where no entry is live (Phase 1's cardinality-1
   * posture, where the two are the same identity). The commit carries
   * `derivedThrough = W` (protocol.md §4: every derived commit carries
   * it; a completion advances nothing) and empty `consequenceOf`.
   * Result-cell dirtiness is injected IN-PROCESS by the sealNative
   * overlay promotion + the executor-commit report below; the
   * subscription's copy is an ordinary self-echo the loop skips.
   *
   * FP6's label carriage rides STRUCTURALLY: the writeback transaction
   * re-reads the request inputs (the hash guard), so the CFC ladder
   * derives the completion write's labels from the request basis
   * through the same per-transaction machinery as the OFF arm.
   *
   * A completion transaction that itself enqueues a post-commit effect
   * would flush INLINE at this seal (deferSealedEffects keys off the
   * wave a tx sealed into, and completions seal into none): no such
   * producer exists — the builtins' completions only write — and one
   * appearing should route through the outbox deliberately, not by
   * accident of this note going stale.
   */
  async #commitEffectCompletion(
    tx: IExtendedStorageTransaction,
    effectKey: string,
  ): Promise<Result<Unit, CommitError>> {
    const runtime = this.#runtime;
    const sink = this.#sink;
    const refuse = (message: string): Result<Unit, CommitError> => ({
      error: {
        name: "StorageTransactionAborted",
        message,
        reason: new Error("effect-completion-refused"),
      },
    });
    if (!this.#active || runtime === undefined || sink === undefined) {
      return refuse(
        "effect completion arrived while the space is parked; the " +
          "effect re-misses from its memo key on re-activation " +
          "(serving-loop.md §4, §6)",
      );
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return refuse("storage transaction does not support sealing");
    }
    const carriage = this.#outbox?.carriageFor(effectKey);
    const identity = carriage?.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
    const sealedSpaces: Array<{
      space: MemorySpace;
      sealed: SealedNativeCommit;
      resolveVerdict: (verdict: SealedCommitVerdict) => void;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support sealing`,
              reason: new Error("seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        // The completion's local pending layer and engine rows use the same
        // carriage identity. Guard reads happen before this seal, so a builtin
        // must also attach its captured identity to the writeback transaction
        // before reading. The shared fetch builtins and SQLite do that at their
        // completion sites;
        // verification-coverage.md OW28-instance-family records the remaining
        // callers whose guard reads still use the serving identity.
        const sealed = replica.sealNative(
          native,
          source,
          promise,
          carriage?.scopeKeyIdentity !== undefined
            ? { identity: carriage.scopeKeyIdentity }
            : undefined,
        );
        sealedSpaces.push({ space, sealed, resolveVerdict: resolve });
        return Promise.resolve({ ok: {} });
      },
    };
    const result = await inner.sealInto(collector);
    const withdrawAll = (message: string) => {
      for (const space of sealedSpaces) {
        space.resolveVerdict({ withdrawn: { message } });
      }
    };
    if (result.error) {
      withdrawAll(`effect completion seal failed: ${result.error.message}`);
      return result;
    }
    if (sealedSpaces.length === 0) {
      // Nothing to commit (all-no-op writeback) — done.
      return { ok: {} };
    }
    if (
      sealedSpaces.length > 1 ||
      sealedSpaces[0].space !== this.#options.space
    ) {
      withdrawAll(
        "effect completion may write only the serving space " +
          "(serving-loop.md §4; cross-space consequences leave only " +
          "as outbox appends — protocol.md §2b)",
      );
      return refuse(
        "effect completion wrote a foreign space; refused " +
          "(serving-loop.md §4)",
      );
    }
    const sealed = sealedSpaces[0];
    const operations = [...sealed.sealed.commit.operations];
    if (operations.some((operation) => operation.op === "sqlite")) {
      withdrawAll("effect completion carries folded sqlite ops; refused");
      return refuse(
        "effect completion transactions must not fold sqlite ops " +
          "(sqlite writes ride scheduler runs' wave batches)",
      );
    }
    const annotations: WaveWriteAnnotation[] = [];
    for (const [opIndex, operation] of operations.entries()) {
      // Unreachable after the refusal above; narrows the op type.
      if (operation.op === "sqlite") continue;
      const scoped = operation.scope !== undefined &&
        operation.scope !== "space";
      if (scoped || carriage?.acting !== undefined) {
        annotations.push({
          op: opIndex,
          ...(scoped
            ? { scopeKey: resolveScopeKey(operation.scope, identity) }
            : {}),
          ...(carriage?.acting !== undefined
            ? {
              actingUser: carriage.acting.user,
              ...(carriage.acting.session !== undefined
                ? { actingSession: carriage.acting.session }
                : {}),
            }
            : {}),
        });
      }
    }
    const outcome = await sink.commitWave({
      space: this.#options.space,
      home: true,
      // The completion's CAS basis is NOW: it writes only its own
      // result/claim docs, and a concurrent intrusion on them surfaces
      // as a conflict the writeback's retry loop re-decides against
      // fresh state (the hash guard re-reads inputs each attempt).
      basisSeq: Engine.serverSeq(this.#options.engine),
      rebasedHeads: [],
      operations,
      preconditions: [...sealed.sealed.commit.preconditions ?? []],
      annotations,
      consequenceOf: [],
      basisInstances: [],
      holder: this.#holder,
      derivedThrough: this.#watermark,
    });
    if (outcome.error) {
      withdrawAll(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
      return refuse(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
    }
    this.#recordOwnDerivedCommit(outcome.ok.seq, operations.length > 0);
    sealed.resolveVerdict({ committed: { seq: outcome.ok.seq } });
    // The B-1 read-consistency gate (serving-loop.md §4): hold the
    // effect's in-flight entry until THIS completion commit's writes
    // are READABLE by the serving runtime. The verdict above resolves
    // inline, but under parked accepts (CT-1927) the replica applies
    // the promotion only when a frame's catch-up marker covers it — a
    // window where a fresh transaction's reads can miss the
    // completion. Retiring the key inside that window let a stale
    // re-run's re-admit re-claim and egress a second time (the
    // captured double-fire); deferring retirement makes the re-admit
    // dedupe instead. Sequenced after `settled` — the park-or-confirm
    // decision runs inside the sealed commit's settlement.
    const replica = runtime.storageManager.open(this.#options.space).replica;
    if (replica.whenApplied !== undefined) {
      const localSeq = sealed.sealed.localSeq;
      this.#outbox?.deferRetirement(
        effectKey,
        // A locally-rejected settle (a route replacement racing the
        // verdict) still consults whenApplied on this replica —
        // benign: a replaced replica re-pulls durable state.
        sealed.sealed.settled
          .catch(() => undefined)
          .then(() => replica.whenApplied!(localSeq)),
      );
    }
    bumpDerivedCommits(this.#options.stats, String(this.#options.space));
    // In-process dirtiness + push (the §4 injection): report like a
    // wave commit — subscribers get the derived rows, the feed carries
    // the record, and the loop skips its own echo by class + holder.
    const records = Engine.selectCommitsSince(this.#options.engine, {
      fromSeq: outcome.ok.seq - 1,
      limit: 1,
    });
    const record = records.find((entry) => entry.seq === outcome.ok.seq);
    if (record !== undefined) {
      this.#options.server.noteExecutorCommit({
        space: this.#options.space,
        seq: record.seq,
        class: "derived",
        holder: this.#holder,
        sessionId: record.sessionId,
        writes: record.writes as AdmittedCommitNotice["writes"],
      });
    }
    return { ok: {} };
  }

  /**
   * Commit a transaction stamped `directCommit` to the store on its own
   * (docs/features/server-pattern-lifecycle.md): the serving loop's own
   * derived-class commit under the space's lease, made outside the wave,
   * so the transaction's `commit()` resolves with the store's verdict and
   * nothing the wave later decides can withdraw it.
   *
   * The store validates the transaction's own read set as it does a client
   * commit's — every read against this replica's records, a document that
   * moved at a read path since refusing the whole transaction — and holds
   * every document the transaction writes to the store seq the transaction
   * was stamped at. A commit the store took but this replica has not yet
   * applied is therefore a conflict, not a blind overwrite. A transaction
   * that read state sealed into the open wave is refused: the wave can
   * still withdraw that state, and a commit made durable over it could not
   * be withdrawn with it. A caller stages such state in an earlier cycle.
   * The replica takes the writes only once the store has accepted them, so
   * no run reads them as pending state that a refusal could roll back.
   */
  async #commitDirect(
    tx: IExtendedStorageTransaction,
    direct: { basisSeq: number; actionId: string },
  ): Promise<Result<Unit, CommitError>> {
    const runtime = this.#runtime;
    const sink = this.#sink;
    const refuse = (message: string): Result<Unit, CommitError> => ({
      error: {
        name: "StorageTransactionAborted",
        message,
        reason: new Error("direct-commit-refused"),
      },
    });
    if (!this.#active || runtime === undefined || sink === undefined) {
      return refuse(
        `direct commit of ${direct.actionId} arrived while the space is ` +
          "parked",
      );
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return refuse("storage transaction does not support sealing");
    }
    const replica = runtime.storageManager.open(this.#options.space).replica;
    if (
      replica.sealNative === undefined || replica.storeCommitOf === undefined
    ) {
      return refuse(
        `space replica for ${this.#options.space} does not support sealing`,
      );
    }
    this.#recordLifecycleVerbWrites(tx);
    const identity = runtime.scopeKeyIdentity;
    // Every space the transaction wrote is collected before anything
    // commits, so a refusal leaves nothing behind. The store's shape of the
    // serving space's commit is taken during the handoff, while the
    // transaction's read log is still the transaction's to give, under the
    // replica's own identity: a direct commit is a bookkeeping run's, which
    // carries no other.
    const handed: Array<{
      space: MemorySpace;
      native: NativeStorageCommit;
      source: IStorageTransaction;
      store:
        | ReturnType<NonNullable<ISpaceReplica["storeCommitOf"]>>
        | undefined;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        handed.push({
          space,
          native,
          source,
          store: space === this.#options.space
            ? replica.storeCommitOf!(native, source)
            : undefined,
        });
        return Promise.resolve({ ok: {} });
      },
    };
    const result = await inner.sealInto(collector);
    if (result.error !== undefined) return result;
    if (handed.length === 0) {
      // An all-no-op transaction handed over nothing.
      return result;
    }
    if (handed.length > 1 || handed[0].store === undefined) {
      return refuse(
        `direct commit of ${direct.actionId} wrote ${
          handed.map((entry) => entry.space).join(", ")
        }; a direct commit may write only the serving space`,
      );
    }
    const { space, native, source, store } = handed[0];
    if ((native.sqliteOps?.length ?? 0) > 0) {
      return refuse(
        `direct commit of ${direct.actionId} folds sqlite ops; those ride ` +
          "scheduler runs' wave batches",
      );
    }
    const { operations, preconditions, reads } = store;
    if (reads.pending.length > 0) {
      return refuse(
        `direct commit of ${direct.actionId} read state the wave has not ` +
          "committed; stage that state in an earlier cycle",
      );
    }
    const confirmedReads: ConfirmedRead[] = [...reads.confirmed];
    const annotations: WaveWriteAnnotation[] = [];
    const written: Array<{ id: string; scopeKey: ScopeKey }> = [];
    for (const [opIndex, operation] of operations.entries()) {
      if (operation.op === "sqlite") continue;
      const scopeKey = resolveScopeKey(operation.scope, identity);
      written.push({ id: operation.id, scopeKey });
      if (operation.scope !== undefined && operation.scope !== "space") {
        annotations.push({ op: opIndex, scopeKey });
      }
    }
    const outcome = await sink.commitWave({
      space,
      home: true,
      basisSeq: direct.basisSeq,
      rebasedHeads: [],
      operations,
      preconditions: [...preconditions],
      confirmedReads,
      annotations,
      consequenceOf: [],
      basisInstances: [],
      holder: this.#holder,
      derivedThrough: this.#watermark,
    });
    if (outcome.error) {
      return refuse(`direct commit rejected: ${outcome.error.message}`);
    }
    const committedSeq = outcome.ok.seq;
    // Applied here only now, with the store's verdict already in hand,
    // under the read set the store validated.
    const sealed = replica.sealNative(
      native,
      source,
      Promise.resolve({ committed: { seq: committedSeq } }),
      { reads },
    );
    const settled = await sealed.settled;
    if (settled.error !== undefined) {
      // The store holds the commit; the replica re-pulls what it rolled
      // back, through the dirtiness fan-out below. Runs reading the
      // rolled-back state meanwhile keep the ordinary conflict on the docs
      // this commit moved.
      logger.warn("direct-commit-local-rollback", () => [
        `space ${space}: direct commit of ${direct.actionId} landed at ` +
        `seq ${committedSeq} but its local apply was rejected`,
        settled.error,
      ]);
    } else {
      // A wave open now takes a contribution sealed from here on, whose
      // reads of these docs saw this commit, as having observed it
      // (wave.ts).
      this.#currentWave?.noteOwnCommit(committedSeq, written);
    }
    this.#runningLifecycleVerb?.directCommitSeqs.push(committedSeq);
    bumpDerivedCommits(this.#options.stats, String(this.#options.space));
    // The commit entered the store on the engine plane: report it so push
    // fires and the feed carries it, as the wave commit step does for its
    // own.
    const records = Engine.selectCommitsSince(this.#options.engine, {
      fromSeq: committedSeq - 1,
      limit: 1,
    });
    const record = records.find((entry) => entry.seq === committedSeq);
    if (record !== undefined) {
      this.#options.server.noteExecutorCommit({
        space: this.#options.space,
        seq: record.seq,
        class: "derived",
        holder: this.#holder,
        sessionId: record.sessionId,
        writes: record.writes as AdmittedCommitNotice["writes"],
      });
    }
    return result;
  }

  /**
   * Holds store read-through to protocol.md §3's lease-holder delivery rule.
   * Another principal's instance requires a live lease. An active loop can
   * renew and reacquire a lapsed tenure; initialization loss instead refuses
   * the read and invalidates activation. Space-scoped documents and the
   * service's own instances need no lease. A closed engine supplies nothing.
   */
  #leaseHolderReadThrough(
    engine: Engine.Engine,
    read: StoreReadThrough,
  ): StoreReadThrough {
    const own: ScopeKeyIdentity = {
      principal: this.#options.serviceIdentity,
    };
    return (address) => {
      if (!engine.database.open) return undefined;
      if (
        !scopeKeyApplicableTo(address.scopeKey, own) &&
        !this.#confirmLease(engine)
      ) return undefined;
      return read(address);
    };
  }

  /**
   * Whether the space's lease row names this holder live. A row that does
   * not runs the renew arm, which ends the tenure and then reacquires or
   * parks, and the row is read again after it. A closed engine confirms
   * nothing.
   */
  #confirmLease(engine: Engine.Engine): boolean {
    if (!engine.database.open) return false;
    const holds = () =>
      liveExecutionLeaseHolder(engine, this.#options.space) === this.#holder;
    if (holds()) return true;
    this.#renew();
    return holds();
  }

  /** The mid-wave renew (stage C tuning T3): called from the serving
   * scheduler's cooperative yield; renews once the tenure has gone TTL/3
   * without a renewal (the interval timer's own cadence), otherwise a
   * no-op — so a wave shorter than TTL/3 costs nothing here and a wave
   * longer than TTL/3 renews at the same cadence the timer would have. */
  #renewIfDue(): void {
    const lease = this.#lease;
    if (lease === undefined || !this.#active) return;
    const ttlMs = this.#options.policy?.leaseTtlMs ?? EXECUTION_LEASE_TTL_MS;
    if (Date.now() - this.#lastRenewAt < ttlMs / 3) return;
    this.#renew();
  }

  #renew(): void {
    const lease = this.#lease;
    if (
      lease === undefined || (!this.#active && !this.#initializing) ||
      (this.#initializing && !lease.held)
    ) return;
    // Stamped before the outcome is known: a FAILED renew ends the tenure
    // (park or reacquire below), and a reacquire is itself a fresh
    // tenure start.
    this.#lastRenewAt = Date.now();
    let renewed: boolean;
    try {
      renewed = lease.renew();
    } catch (error) {
      if (!this.#initializing || this.#active) throw error;
      // A failed lease-store operation leaves initialization without an
      // authority proof. Release ends the in-process tenure even if the
      // unavailable store also rejects removal of the row.
      try {
        lease.release();
      } catch (releaseError) {
        logger.warn("activation-lease-release-failed", () => [
          `space ${this.#options.space}: lease release failed during initialization`,
          releaseError,
        ]);
      }
      logger.warn("activation-lease-renew-failed", () => [
        `space ${this.#options.space}: lease renewal threw during initialization`,
        error,
      ]);
      renewed = false;
    }
    if (!renewed) {
      // Stop committing immediately (serving-loop.md §2's MUST): the
      // tenure ended inside renew(), so an in-flight wave aborts at its
      // commit step. Then re-acquire or park. The reacquire keeps this
      // loop serving ONLY when no wave sealed under the lapsed tenure:
      // a wave that does abort at commit had its sealed derivations
      // WITHDRAWN, and nothing re-arms their producers in place (no
      // revert consumer; inputs unchanged), so #waveCycle parks the
      // space on that abort rather than letting a continued loop mint a
      // watermark-only advance over work that never re-ran.
      this.#options.stats.lease.lost += 1;
      logger.warn("lease-lost", () => [
        `space ${this.#options.space}: lease renewal failed; ` +
        "in-flight wave aborts (serving-loop.md §2)",
      ]);
      if (this.#initializing && !this.#active) {
        // A factory or recovery read may belong to the expired tenure.
        // Finish its outstanding await, then dispose without launching it.
        clearInterval(this.#renewTimer);
        this.#renewTimer = undefined;
        this.#outbox?.close();
        return;
      }
      if (!lease.acquire()) {
        void this.park("lease-lost");
        return;
      }
      // Survived the blip in-process. Any push pass that ran inside it
      // judged this runtime's loopback session a FORMER holder and
      // withheld or retracted its foreign instances (protocol.md §2's
      // read row is live-lease admission); tell the co-hosted memory
      // server the lease is live again so the session's exemption
      // re-arms NOW — a full re-evaluation that re-delivers what the
      // blip withheld — rather than on the next unrelated write (fan-out
      // stage A's independent review, finding 1: the silent-stale half).
      this.#options.server.noteLeaseReacquired({
        space: this.#options.space,
        principal: this.#options.serviceIdentity,
      });
    }
  }

  //
  // the loop (serving-loop.md §3)
  //

  async #loop(): Promise<void> {
    if (this.#loopRunning) return;
    this.#loopRunning = true;
    try {
      while (this.#active && !this.#parkRequested) {
        // `wavesBudgetExhausted` says a cycle reached the flush deadline
        // and nothing more: every overrunning wave reports that same
        // deadline however far past it the wave ran, so the counter alone
        // cannot separate a loop barely over its budget from one an order
        // of magnitude over. This span carries the distribution the
        // counter censors, and pairs with it rather than replacing it —
        // the count says how often, the p95 says by how much.
        //
        // Recorded on the way out rather than from a `finally`, so a cycle
        // that THREW contributes nothing: that path parks the space, which
        // the counters and the loop-failed log already carry, and its
        // duration is the time to a failure rather than the time to serve
        // a wave. Averaging the two would be worse than missing one.
        const cycleStart = performance.now();
        try {
          await this.#waveCycle();
          timing.time(cycleStart, "executor", "wave", "cycle");
        } finally {
          // Reported on both paths: the edge says a cycle ENDED, which
          // is what a waiter needs, while the span above deliberately
          // skips a cycle that threw.
          this.#options.onWaveCycle?.();
        }
        if (!this.#active || this.#parkRequested) break;
        if (!this.#hasWork()) {
          const idleParkMs = this.#options.policy?.idleParkMs ??
            DEFAULT_IDLE_PARK_MS;
          this.#idleSince ??= Date.now();
          if (
            Date.now() - this.#idleSince >= idleParkMs &&
            !this.#options.server.hasLiveSessionsForSpace(
              this.#options.space,
              // The loop's own loopback session is not client demand.
              { excludePrincipal: this.#options.serviceIdentity },
            ) &&
            this.#runtime?.scheduler.hasArmedGateWake() !== true &&
            // Phase 3: undelivered events keep the space ACTIVE
            // (serving-loop.md §1's criterion) — the direct-engine
            // check is bounded by the sidecar head prefix.
            Engine.selectPendingStreamEventDocs(this.#options.engine)
                .length === 0
          ) {
            // Park per the activation policy (serving-loop.md §1): no
            // live client session, no undelivered events, idle past
            // IDLE_PARK_MS, and no armed gate wake (runtime-mapping N9:
            // a pending gate wake is "not idle").
            void this.park("idle");
            break;
          }
          await this.#waitForInput(idleParkMs);
        } else {
          this.#idleSince = undefined;
        }
      }
    } catch (error) {
      logger.error("loop-failed", "serving loop failed", error);
      // Zombie guard: an ACTIVE space whose loop died would renew its
      // lease forever while serving nothing — no successor can acquire,
      // and no cycle ever runs. Park instead: the lease releases, and
      // the host re-activates a space that still has demand with a
      // fresh runtime (serving-loop.md §1) — the same recovery arm as
      // every other abort (§6 step 2's recompute-on-demand).
      await this.park("loop-failed");
    } finally {
      this.#loopRunning = false;
    }
  }

  #hasWork(): boolean {
    return this.#feed.length > 0 ||
      this.#lifecycleVerbs.length > 0 ||
      (this.#currentWave?.contributionCount ?? 0) > 0 ||
      // Chained-not-yet-applied wave seals (the F4 fix): real work the
      // contribution count cannot see yet.
      this.#pendingWaveSeals > 0 ||
      this.#eventScanOwed ||
      this.#effectsRetirementOwed ||
      // The owed root ensure is work: set at activation (where cycle 1
      // always runs first) AND by the no-owner skip's ACL-arrival
      // re-arm mid-tenure — this line is what keeps an idle wait from
      // parking past the re-armed ensure.
      this.#rootEnsureOwed ||
      // Deferred effect batches of the OPEN wave are work (round-2
      // thread 1): an effect-only tx (an all-no-op claim re-issue —
      // the §6 step 3 recovery shape) seals no contribution, so
      // without this the loop would sleep on a quiet space while the
      // batch starves, and an idle park would drop it.
      this.#currentWavePendingEffectCount() > 0;
  }

  #currentWavePendingEffectCount(): number {
    const wave = this.#currentWave;
    if (wave === undefined) return 0;
    return this.#pendingEffectsByWave.get(wave)?.length ?? 0;
  }

  /**
   * Helper for the cycle boundaries, which drops the open wave when
   * nothing rides it, so that the next seal opens a fresh one at the
   * current serverSeq and lease tenure. A wave's basis is the serverSeq
   * it was opened at, and every seal opens one if none is open — a read
   * probe against the serving runtime, a no-op derivation, an all-no-op
   * claim re-issue — including a seal that lands while the loop's own
   * wave commit is still in flight, whose basis then predates that
   * commit. Carried into the next cycle, such a wave loses every write
   * it comes to hold on a document the intervening commits wrote, at the
   * per-doc CAS of its own commit: a derivation's write as superseded,
   * which nothing re-runs since no input changed, and the loop's own
   * watermark advance whole, since a patch of the same path cannot
   * rebase over the previous advance. Run at the start of a cycle and
   * again ahead of the cycle's bookkeeping write.
   *
   * Empty means nothing would be lost: no contribution, no seal chained
   * but not yet applied (a chained seal has captured the wave and must
   * not be orphaned), no deferred effect batch, and no append staged by
   * a transaction that has not sealed yet (its appends ride its
   * contribution at the seal).
   */
  #discardEmptyWave(): void {
    const wave = this.#currentWave;
    if (wave === undefined) return;
    if (
      wave.contributionCount > 0 || this.#pendingWaveSeals > 0 ||
      wave.hasUnsealedAppends ||
      (this.#pendingEffectsByWave.get(wave)?.length ?? 0) > 0
    ) {
      return;
    }
    this.#currentWave = undefined;
  }

  /** Re-arm the event scan for DEFERRED (transient) drain outcomes —
   * never synchronously (verdict blocker, 2026-08-12): an immediate
   * `#eventScanOwed = true` makes `#hasWork()` spin the next wave at
   * once, consuming the whole deferral budget back-to-back before the
   * creation input can arrive. Instead the scan re-arms on the FIRST
   * of: new input (#drainFeed promotes it), or the real-time backstop
   * tick here (so a permanently unrunnable event still hardens into
   * the events.md §5 DROP and clears the park criterion). */
  #armDeferredRescan(): void {
    // Only a serving tenure arms a backstop. A drain pass runs on through
    // the awaits a park makes — the seal chain, the runtime's disposal —
    // and its deferrals land after the park has cleared this timer, which
    // the park clears once. The entries such a pass leaves pending are
    // scanned by the next activation.
    if (!this.#active) return;
    if (this.#deferredRescanTimer !== undefined) return;
    this.#options.stats.events.deferredRescansArmed += 1;
    this.#deferredRescanTimer = setTimeout(() => {
      this.#deferredRescanTimer = undefined;
      this.#options.stats.events.deferredRescansFired += 1;
      this.#eventScanOwed = true;
      this.#feedArrived?.resolve();
    }, EVENT_DEFERRAL_REARM_MS);
  }

  #deliveryFailureNow(): number {
    return this.#options.policy?.deliveryFailureNow?.() ?? Date.now();
  }

  #deliveryFailureBudgetMs(): number {
    return this.#options.policy?.deliveryFailureBudgetMs ??
      MAX_EVENT_DELIVERY_FAILURE_BUDGET;
  }

  #deliveryStatKey(eventId: string): string {
    return `${this.#options.space}\0${eventId}`;
  }

  #setActiveDeliveryCheckpoint(
    eventId: string,
    checkpoint: DeliveryDeferral | undefined,
  ): void {
    if (checkpoint === undefined) this.#deliveryCheckpoints.delete(eventId);
    else this.#deliveryCheckpoints.set(eventId, checkpoint);
    updateDeliveryCheckpointStats(
      this.#options.stats,
      this.#deliveryStatKey(eventId),
      checkpoint === undefined ? undefined : {
        state: checkpoint.state,
        readSpentMs: () =>
          spentDeliveryFailureMs(
            checkpoint,
            this.#deliveryFailureNow(),
            this.#deliveryFailureBudgetMs(),
          ),
      },
    );
  }

  #cancelDeliveryFailureWake(eventId: string): void {
    const timer = this.#deliveryFailureWakeTimers.get(eventId);
    if (timer !== undefined) clearTimeout(timer);
    this.#deliveryFailureWakeTimers.delete(eventId);
  }

  #scheduleDeliveryFailureWake(
    eventId: string,
    checkpoint: DeliveryDeferral,
  ): void {
    // A wake belongs to the active tenure. #parkResources clears every one
    // of these timers in the same synchronous run that clears #active, and
    // the next activation arms afresh from the checkpoints it replays. A
    // drain pass or a delivery callback that resumes during the park's
    // awaits reaches this site with its own checks behind it.
    if (!this.#active) return;
    this.#cancelDeliveryFailureWake(eventId);
    if (checkpoint.state !== "failed") return;
    const remaining = Math.max(
      0,
      this.#deliveryFailureBudgetMs() - spentDeliveryFailureMs(
        checkpoint,
        this.#deliveryFailureNow(),
        this.#deliveryFailureBudgetMs(),
      ),
    );
    // This is the ratified timeout-policy exception: one wake at the
    // cumulative failed-state boundary. It neither cancels storage work nor
    // creates a retry cadence.
    this.#options.stats.events.deliveryFailureWakesArmed += 1;
    const timer = setTimeout(() => {
      this.#deliveryFailureWakeTimers.delete(eventId);
      this.#options.stats.events.deliveryFailureWakesFired += 1;
      this.#eventScanOwed = true;
      this.#feedArrived?.resolve();
    }, remaining);
    this.#deliveryFailureWakeTimers.set(eventId, timer);
  }

  #storedStreamEntry(
    sidecarId: string,
    eventId: string,
    seq: number,
  ): StreamEventEntry | undefined {
    const value = Engine.read(this.#options.engine, {
      id: sidecarId as never,
    })?.value as StreamEventsDocValue | undefined;
    return value?.entries?.find((candidate) =>
      candidate?.eventId === eventId && (candidate.seq ?? 0) === seq
    );
  }

  #stageDeliveryCheckpoint(
    runtime: Runtime,
    entry: StreamEventEntry,
    streamEntry: { sidecarId: string; index: number; seq: number },
    checkpoint: DeliveryDeferral,
    holdGuard = true,
  ): void {
    this.#pendingDeliveryCheckpointWrites.set(entry.eventId, {
      ...streamEntry,
      checkpoint,
    });
    if (holdGuard) this.#drainInFlight.set(entry.eventId, "marked");
    try {
      const tx = runtime.edit();
      runtime.stampServerRun(tx, {
        actionId: `server-execution/event-delivery-checkpoint:${entry.eventId}`,
        kind: "bookkeeping",
      });
      runtime.getCellFromLink<DeliveryDeferral | undefined>({
        space: this.#options.space,
        id: streamEntry.sidecarId as never,
        scope: "space",
        path: [
          "entries",
          String(streamEntry.index),
          "deliveryDeferral",
        ],
      }).withTx(tx).set(checkpoint);
      const commit = tx.commit();
      const pending = this.#pendingDeliveryCheckpointWrites.get(entry.eventId);
      if (pending?.checkpoint === checkpoint) {
        pending.wave = this.#waveByTx.get(tx);
      }
      const sealed = commit.then((result) => {
        if (result.error === undefined) return;
        this.#recordDeliveryCheckpointWriteFailure(
          entry,
          result.error,
          false,
          checkpoint,
        );
      }, (error) => {
        this.#recordDeliveryCheckpointWriteFailure(entry, error, false);
      });
      this.#eventNoticeWork.add(sealed);
      sealed.finally(() => this.#eventNoticeWork.delete(sealed));
    } catch (error) {
      this.#recordDeliveryCheckpointWriteFailure(entry, error, true);
    }
  }

  #recordDeliveryCheckpointWriteFailure(
    entry: StreamEventEntry,
    error: unknown,
    staging: boolean,
    expected?: DeliveryDeferral,
  ): void {
    const pending = this.#pendingDeliveryCheckpointWrites.get(entry.eventId);
    if (expected !== undefined && pending?.checkpoint !== expected) return;
    this.#pendingDeliveryCheckpointWrites.delete(entry.eventId);
    this.#blockDeliveryCheckpointWrite(entry.eventId);
    this.#drainInFlight.delete(entry.eventId);
    logger.warn("event-delivery-checkpoint-write-failed", () => [
      `delivery checkpoint for ${entry.eventId} ${
        staging ? "could not be staged" : "failed to seal"
      }; the durable entry and arrival barrier remain pending`,
      error,
    ]);
  }

  #blockDeliveryCheckpointWrite(eventId: string): void {
    this.#deliveryCheckpointWriteBlocked.add(eventId);
    this.#deliveryWriteBlockedAt.set(eventId, this.#inputHead);
    this.#options.stats.events.deliveryCheckpointWriteFailures += 1;
  }

  #recordDeliveryFailure(
    runtime: Runtime,
    entry: StreamEventEntry,
    streamEntry: { sidecarId: string; index: number; seq: number },
    failure: {
      failureClass: DeliveryDeferral["failureClass"];
      recoveryEpoch: string;
      permanentEvidence: boolean;
    },
    phase: DeliveryDeferral["phase"] = "dispatch-load",
  ): void {
    if (phase === "dispatch-load") {
      this.#uncommittedDeliveryFailureEpochs.set(
        entry.eventId,
        failure.recoveryEpoch,
      );
    }
    if (phase === "dispatch-load") {
      this.#options.stats.events.loadParkFailures += 1;
      // The failed generation is the baseline. A retry requires a signal
      // explicitly naming this boundary as the one it supersedes.
      this.#deliveryLoadRecoveries.delete(failure.recoveryEpoch);
    }
    const current = this.#pendingDeliveryCheckpointWrites.get(entry.eventId)
      ?.checkpoint ??
      this.#deliveryCheckpoints.get(entry.eventId) ??
      entry.deliveryDeferral;
    const decision = observeDeliveryFailure(current, {
      now: this.#deliveryFailureNow(),
      phase,
      failureClass: failure.failureClass,
      recoveryEpoch: failure.recoveryEpoch,
      permanentEvidence: failure.permanentEvidence,
      budgetMs: this.#deliveryFailureBudgetMs(),
    });
    if (decision.kind === "needs-attention") {
      // Persist the failed boundary before attempting its terminal cover. If
      // the later notice wave rejects, this checkpoint remains authoritative
      // across tenure handoff and can deterministically re-derive the cover.
      this.#stageDeliveryCheckpoint(
        runtime,
        entry,
        streamEntry,
        decision.checkpoint,
      );
      return;
    }
    if (current === undefined) {
      logger.warn("event-delivery-deferred", () => [
        `event ${entry.eventId} delivery deferred in ${phase}: ` +
        failure.failureClass,
      ]);
    } else if (current.failureClass !== decision.checkpoint.failureClass) {
      logger.warn("event-delivery-class-changed", () => [
        `event ${entry.eventId} delivery failure changed from ` +
        `${current.failureClass} to ${decision.checkpoint.failureClass}`,
      ]);
    }
    this.#stageDeliveryCheckpoint(
      runtime,
      entry,
      streamEntry,
      decision.checkpoint,
    );
  }

  #reconcileDeliveryWritesAfterWave(closing: WaveAccumulator): void {
    for (const [eventId, pending] of this.#pendingDeliveryCheckpointWrites) {
      if (pending.wave !== closing) continue;
      const stored = this.#storedStreamEntry(
        pending.sidecarId,
        eventId,
        pending.seq,
      );
      this.#pendingDeliveryCheckpointWrites.delete(eventId);
      if (stored?.consequenced === true) {
        this.#uncommittedDeliveryFailureEpochs.delete(eventId);
        this.#setActiveDeliveryCheckpoint(eventId, undefined);
        this.#cancelDeliveryFailureWake(eventId);
        continue;
      }
      if (sameDeliveryDeferral(stored?.deliveryDeferral, pending.checkpoint)) {
        this.#uncommittedDeliveryFailureEpochs.delete(eventId);
        this.#deliveryCheckpointWriteBlocked.delete(eventId);
        this.#deliveryWriteBlockedAt.delete(eventId);
        this.#setActiveDeliveryCheckpoint(eventId, pending.checkpoint);
        this.#scheduleDeliveryFailureWake(eventId, pending.checkpoint);
        const checkpoint = pending.checkpoint;
        if (
          checkpoint.state === "recovering" ||
          (checkpoint.state === "failed" && checkpoint.failureCount === 1 &&
            (checkpoint.failureClass === "timeout" ||
              checkpoint.failureClass === "unknown" ||
              checkpoint.phase === "commit-preparation"))
        ) {
          this.#eventScanOwed = true;
        }
        if (
          attentionForExpiredDeliveryFailure(
            checkpoint,
            this.#deliveryFailureNow(),
            this.#deliveryFailureBudgetMs(),
          ) !== undefined
        ) {
          this.#eventScanOwed = true;
        }
      } else {
        this.#blockDeliveryCheckpointWrite(eventId);
        logger.warn("event-delivery-checkpoint-write-failed", () => [
          `delivery checkpoint for ${eventId} did not survive the wave; ` +
          "the durable entry and arrival barrier remain pending",
          { stored: stored?.deliveryDeferral, expected: pending.checkpoint },
        ]);
      }
      this.#drainInFlight.delete(eventId);
    }
    for (const [eventId, pending] of this.#pendingAttentionNotices) {
      if (pending.wave !== closing) continue;
      const stored = this.#storedStreamEntry(
        pending.sidecarId,
        eventId,
        pending.seq,
      );
      this.#pendingAttentionNotices.delete(eventId);
      if (
        stored?.status === "needs-attention" &&
        sameDeliveryAttention(stored.attention, pending.attention)
      ) {
        this.#attentionSealWriteBlocked.delete(eventId);
        this.#deliveryWriteBlockedAt.delete(eventId);
        this.#uncommittedDeliveryFailureEpochs.delete(eventId);
        this.#setActiveDeliveryCheckpoint(eventId, undefined);
        this.#cancelDeliveryFailureWake(eventId);
        const stats = this.#options.stats.events.needsAttention;
        stats.total += 1;
        stats.byPhase[pending.attention.phase] += 1;
        logger.warn("event-needs-attention", () => [
          `event ${eventId} needs attention after ` +
          `${pending.attention.accumulatedFailureMs}ms of confirmed ` +
          `${pending.attention.failureClass} failure`,
        ]);
      } else {
        this.#blockAttentionNoticeWrite(eventId);
        logger.warn("event-needs-attention-seal-failed", () => [
          `attention notice for ${eventId} did not survive the wave; the ` +
          "entry and arrival barrier remain pending",
        ]);
      }
      this.#drainInFlight.delete(eventId);
    }
  }

  async #waitForInput(maxMs: number): Promise<void> {
    if (this.#feed.length > 0 || this.#lifecycleVerbs.length > 0) return;
    if (this.#pendingDemandWake) {
      // Consume the demand latch (stage B): a watch set changed since
      // the last demand pass began; run a cycle now so the pass sees the
      // arrival (or departure) instead of sleeping out the idle window.
      this.#pendingDemandWake = false;
      return;
    }
    if (this.#pendingStructureRetryWake) {
      // A load that completed after its cycle's deadline left a retry.
      // The next settle applies its input before attempting it again.
      this.#pendingStructureRetryWake = false;
      return;
    }
    if (this.#pendingShadowFlipWake) {
      // A flip fired while no waiter was installed (r3739416418):
      // consume the latch and run a cycle now — the floor has lifted
      // and the catch-up wave must not wait out the idle window.
      this.#pendingShadowFlipWake = false;
      return;
    }
    this.#feedArrived = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.#feedArrived?.resolve(), maxMs);
    try {
      await this.#feedArrived.promise;
    } finally {
      clearTimeout(timer);
      this.#feedArrived = undefined;
    }
  }

  /** Drain the pending feed records into this cycle's input batch:
   * self-echoes (own derived commits, by class + holder) advance the
   * input head without any marking — their consequences are themselves
   * (serving-loop.md §3). Authored records count toward §7's
   * authoredSeen. Dirtiness itself travels the scheduler's existing
   * path: the loopback session's subscriptions deliver the commits'
   * doc changes, and storage notifications mark the graph dirty — or,
   * under the store read-through posture, each record's writes are
   * re-read into the replica here (`#refreshHeldDocuments()`) and the
   * same notifications follow. */
  #drainFeed(runtime: Runtime): { batchHead: number } {
    for (let index = 0; index < this.#feed.length; index++) {
      const record = this.#feed[index]!;
      if (!this.#refreshHeldDocuments(record, runtime)) {
        // The record's writes have not reached the replica: hold it and
        // everything behind it for the next cycle, and stop the head this
        // cycle covers short of it. Clamped against the record's own seq,
        // not only the coverage head as it stands: a LATE record (below)
        // follows records above it in the feed, and their coverage must
        // not carry W over the one that failed.
        this.#feed = this.#feed.slice(index);
        return {
          batchHead: Math.min(this.#coverageHead, record.seq - 1),
        };
      }
      // LATE records (stage P2-F, the sx2 unskip's flake diagnosis):
      // the feed has two in-process producers — the admission hook's
      // notify (async, after the transact's engine apply) and the
      // loop's own post-commit noteExecutorCommit (sync after the
      // sink's engine apply) — so a wave echo at seq S+1 can enqueue
      // BEFORE an in-flight authored commit's notice at seq S. The
      // old `seq <= inputHead ⇒ skip` guard silently dropped such a
      // record from ACCOUNTING (authoredSeen undercounted; a terminal
      // root's re-arm missed), though never from SERVING — the
      // authored commit's dirtiness rides the session frames, which
      // the settle's input barrier orders by seq regardless of notice
      // order, so W stayed honest. Late records therefore still COUNT
      // and RE-ARM (deduped exactly — each seq is delivered once per
      // producer; the bounded set below absorbs any replay overlap),
      // while the head/coverage math stays in-order only.
      const late = record.seq <= this.#inputHead;
      if (late) {
        if (record.seq <= this.#activationScanHead) continue;
        if (this.#drainedLateWindow.has(record.seq)) continue;
      }
      this.#drainedLateWindow.add(record.seq);
      while (this.#drainedLateWindow.size > 1024) {
        const oldest = this.#drainedLateWindow.values().next().value;
        if (oldest === undefined) break;
        this.#drainedLateWindow.delete(oldest);
      }
      if (!late) this.#inputHead = record.seq;
      // Skipped BEFORE the re-arm check below, deliberately: a
      // SELF-holder derived commit touching a terminal root's observed
      // docs does not re-arm it. Reachable only for a piece created
      // server-side WITHOUT a local start — no such path exists
      // (`runner.run` always starts locally), and FOREIGN derived
      // commits (holder ≠ self) do re-arm. If a start-less server-side
      // creation path ever appears, move this skip below the re-arm.
      const selfEcho = record.class === "derived" &&
        record.holder === this.#holder;
      if (selfEcho) continue;
      if (
        this.#deliveryCheckpoints.size > 0 ||
        this.#deliveryCheckpointWriteBlocked.size > 0 ||
        this.#attentionSealWriteBlocked.size > 0
      ) {
        for (const [eventId, blockedAt] of this.#deliveryWriteBlockedAt) {
          if (record.seq <= blockedAt) continue;
          this.#deliveryCheckpointWriteBlocked.delete(eventId);
          this.#attentionSealWriteBlocked.delete(eventId);
          this.#deliveryWriteBlockedAt.delete(eventId);
        }
        for (const [eventId, checkpoint] of this.#deliveryCheckpoints) {
          if (
            checkpoint.failureClass === "timeout" ||
            checkpoint.failureClass === "unknown" ||
            checkpoint.phase === "commit-preparation"
          ) {
            this.#deliveryInputWakes.add(eventId);
          }
        }
        this.#eventScanOwed = true;
      }
      if (!late) this.#coverageHead = record.seq;
      if (record.class === "authored") {
        this.#options.stats.authoredSeen += 1;
        // Phase 4 (protocol.md §5; serving-loop.md §7): an authored
        // commit touching the effects doc is an effect-channel ACK —
        // counted so the amplification metric can exclude acks
        // (testing.md §4's `authoredSeen − effectAcks`), and the
        // next-wave retirement scan is armed.
        if (
          record.writes.some((write) =>
            write.id === SERVER_EXECUTION_EFFECTS_DOC_ID
          )
        ) {
          this.#options.stats.effectAcks += 1;
          this.#effectsRetirementOwed = true;
        }
      }
      // serving-loop.md §3: "if c.class == event-append: enqueue for
      // handler processing". The notice carries ids only; the drain
      // reads the STAMPED entries from the store (the scan below), so
      // the flag is the whole classification state.
      if (record.eventAppends !== undefined && record.eventAppends.length > 0) {
        this.#eventScanOwed = true;
        this.#options.stats.events.appended += record.eventAppends.length;
        this.#options.stats.events.explicitRetries +=
          record.eventAppends.filter(
            (append) => append.retryOf !== undefined,
          ).length;
      }
      // Deferred events re-try on NEW INPUT (the creation-race arm:
      // the piece's pattern-run commit is exactly such a record) —
      // this is the input signal the deferral budget counts, not a
      // synchronous self-scan.
      if (
        this.#eventDeferrals.size > 0 ||
        this.#deferredRescanTimer !== undefined
      ) {
        this.#eventScanOwed = true;
      }
      // The commit-triggered RE-ARM (stage P2-F, the OW19 design's
      // second half): a commit touching one of a terminal root's
      // observed docs re-arms that root for a retry after frame application.
      // This is what makes the terminal state
      // safe for the creation race: a not-yet-created piece's
      // instantiation commit writes the demanded doc, re-arms it here,
      // and the retry then finds the meta (not-yet vs never).
      if (this.#terminalStructureLoads.size > 0 && record.writes.length > 0) {
        for (const [key, observed] of this.#terminalStructureLoads) {
          if (!record.writes.some((write) => observed.has(write.id))) continue;
          this.#terminalStructureLoads.delete(key);
          // The settle loop applies the re-arming commit's frames before
          // retrying, so a covered watch's stale value cannot terminalize
          // the root again.
          this.#rearmedAwaitingSettle.add(key);
          this.#options.stats.structureLoadRearmed += 1;
          logger.info?.("structure-load-rearmed", () => [
            `terminal demanded root re-armed by commit seq ${record.seq}; ` +
            "retry follows this cycle's settle",
          ]);
        }
      }
    }
    this.#feed = [];
    return { batchHead: this.#coverageHead };
  }

  /**
   * Helper for `#drainFeed()`, which under the store read-through
   * posture re-reads the documents one admitted commit wrote, for those
   * the serving replica holds, so its scheduler sees the change a session
   * watch would otherwise have delivered. The loop's own derived commits
   * are skipped: the replica confirmed those at its seal, and re-reading
   * them would only cost the engine a read per written document. Returns
   * whether the record's writes reached the replica. A read or
   * integration that throws leaves the record to the next cycle, which
   * retries it: the drain must not consume a record whose writes never
   * reached the replica, since the watermark would then cover an input
   * nothing derived over. After `STORE_REFRESH_ATTEMPTS` consecutive
   * failures on one record the error propagates instead, the loop's own
   * catch parks the space `loop-failed`, and the re-activation's fresh
   * runtime reads the engine's head.
   */
  #refreshHeldDocuments(
    record: AdmittedCommitNotice,
    runtime: Runtime,
  ): boolean {
    if (this.#options.policy?.storeReadThrough !== true) return true;
    if (record.class === "derived" && record.holder === this.#holder) {
      return true;
    }
    try {
      this.#options.stats.storeRefreshes +=
        runtime.storageManager.integrateStoreWrites?.(
          this.#options.space,
          record.writes,
        ) ?? 0;
    } catch (error) {
      const attempts = this.#storeRefreshFailure?.seq === record.seq
        ? this.#storeRefreshFailure.attempts + 1
        : 1;
      this.#storeRefreshFailure = { seq: record.seq, attempts };
      if (attempts >= STORE_REFRESH_ATTEMPTS) throw error;
      logger.warn("store-refresh-failed", () => [
        `space ${this.#options.space}: refreshing held documents for ` +
        `commit ${record.seq} failed (attempt ${attempts} of ` +
        `${STORE_REFRESH_ATTEMPTS}); the record waits for the next cycle`,
        error,
      ]);
      return false;
    }
    this.#storeRefreshFailure = undefined;
    return true;
  }

  /**
   * Drain undelivered stream events into the scheduler (Phase 3,
   * events-down; serving-loop.md §3's event-append classification, §6
   * step 4's reprocess). The STORE is the drain input — the admission
   * notices only armed the scan — so client-fired, delegated-delivered,
   * and crash-recovered entries all enter through one path
   * (events.md §2's "one path, two producers"). Entries queue per
   * stream in seq order via `facade.queueEvent` (the wake-shaping
   * entry point events.md §2 mandates); the settle loop that follows
   * runs them to quiescence inside this wave.
   *
   * Per-entry arms:
   * - runnable → queued; the dispatch stamps the run with the entry's
   *   acting identity (LD1) and its durable location, and the stamper
   *   writes the `consequenced` mark into the handler's own tx
   *   (events.md §4's same-transaction atomicity);
   * - duplicate of an already-consequenced eventId (an
   *   at-or-below-horizon re-admission — events.md §4's dedupe-horizon
   *   allowance) → SKIPPED, counted `skippedIdempotent`, its entry
   *   marked consequenced so the stream's frontier passes it
   *   (non-wedging — the model's C2-dedupe pin);
   * - handler THREW → the error is the consequence (events.md §5): a
   *   notice tx marks the entry consequenced + `error`;
   * - unrunnable (no handler after piece start — events.md §5's drop
   *   predicate) → the dropped-event notice `{status, reason}` +
   *   consequenced.
   *
   * Returns the number of events queued (the re-arm belt keys on it), or
   * undefined when the serving tenure ends during any of the pass's own
   * waits: a sidecar load, the visibility barrier's publication and
   * response, or the stream document's load.
   */
  async #drainStreamEvents(runtime: Runtime): Promise<number | undefined> {
    if (!this.#eventScanOwed) return 0;
    this.#eventScanOwed = false;
    this.#eventVisibilityFloor = undefined;
    const { engine, space } = this.#options;
    const pendingDocs = Engine.selectPendingStreamEventDocs(engine);
    if (pendingDocs.length === 0) {
      // A scan was owed and this is it: the pass ended, having queued
      // nothing. Reported here as anywhere else, so that a waiter on
      // the pass boundary sees every pass rather than only the ones
      // with work in them.
      this.#options.onEventDrainPass?.(0);
      return 0;
    }
    let queued = 0;
    // The load-park barrier's mid-pass half (see #loadParkDeferredInPass).
    // Cleared here so each pass judges its own deferrals.
    this.#loadParkDeferredInPass = false;
    // Pending entries process ACROSS sidecars in append commit-seq
    // order — events.md §2: per stream, commit-seq order; across streams
    // in one space, arrival order. A deferral (a lagging sidecar view or
    // a failed sidecar sync) is a BARRIER, not a skip: every entry at or
    // behind the deferred entry's arrival position waits with it, so a
    // later arrival's consequence can never land ahead of an earlier
    // one. Seq-less legacy entries sort last; the sidecar-id tie-break
    // keeps one wave's co-committed entries in a stable order.
    const ordered = pendingDocs
      .flatMap((doc) => doc.entries.map((entry) => ({ doc, entry })))
      .sort((a, b) =>
        ((a.entry.seq ?? Number.MAX_SAFE_INTEGER) -
          (b.entry.seq ?? Number.MAX_SAFE_INTEGER)) ||
        a.doc.id.localeCompare(b.doc.id)
      );
    // Sidecars materialize into the SERVING replica on first touch, once
    // per pass: a cold view would materialize ghost entries (the
    // engine's admission guard refuses the resulting wave — the failure
    // mode the sync exists to prevent). The stream's own doc is synced
    // too so the no-handler auto-load's meta chain reads a warm view.
    // The stored log is captured beside the sync — mark indices address
    // positions in it.
    const sidecars = new Map<
      string,
      { stored: StreamEventsDocValue["entries"] } | "sync-failed"
    >();
    let visibilityFlushed = false;
    for (const { doc, entry } of ordered) {
      let sidecar = sidecars.get(doc.id);
      if (sidecar === undefined) {
        try {
          await runtime.getCellFromLink({
            space,
            id: doc.id as never,
            scope: "space",
            path: [],
          }).sync();
          if (!this.#active || this.#runtime !== runtime) return undefined;
          sidecar = {
            stored: ((Engine.read(engine, { id: doc.id })?.value ??
              {}) as StreamEventsDocValue).entries ?? [],
          };
          this.#preQueueDeferralStreaks.delete(doc.id);
        } catch (error) {
          if (!this.#active || this.#runtime !== runtime) return undefined;
          logger.warn("event-sidecar-sync-failed", () => [
            `sidecar sync for ${doc.id} failed; its events — and every ` +
            "later-arrived event behind them — defer to the next wave",
            error,
          ]);
          sidecar = "sync-failed";
        }
        sidecars.set(doc.id, sidecar);
      }
      if (sidecar === "sync-failed") {
        // Deferral is a BARRIER, not a skip: everything at or behind
        // this entry's arrival position waits with it, or a later
        // arrival's consequence lands ahead of an earlier one.
        this.#eventVisibilityFloor = entry.seq ?? 1;
        this.#notePreQueueDeferral(
          doc.id,
          () => `sidecar ${doc.id} (sync failing)`,
        );
        this.#armDeferredRescan();
        break;
      }
      let stored = sidecar.stored ?? [];
      {
        let index = stored.findIndex((candidate) =>
          candidate?.eventId === entry.eventId &&
          candidate?.seq === entry.seq
        );
        if (index < 0 || stored[index].consequenced === true) continue;
        // The mark every arm below writes (the handler tx's, the
        // skip/error/drop notices') is INDEX-ADDRESSED against the
        // REPLICA view: verify the view holds this entry at this index
        // before any of them (a lagging view defers — never a ghost
        // write). Checked ahead of the SKIP arm too (fan-out stage B):
        // the skip notice used to seal on the STORED index alone, and
        // when its wave's basis was fresh — no rebase re-CAS against
        // the head — a view still missing the entry materialized a
        // ghost `{consequenced: true}` at that index and left the real
        // entry unconsequenced (re-drained, re-skipped, ghost twice).
        {
          const readViewEntry = () =>
            runtime.getCellFromLink<
              { eventId?: string; seq?: number } | undefined
            >({
              space,
              id: doc.id as never,
              scope: "space",
              path: ["entries", String(index)],
            }).get();
          const matches = (value: ReturnType<typeof readViewEntry>) =>
            value?.eventId === entry.eventId && value?.seq === entry.seq;
          let viewEntry = readViewEntry();
          const provider = runtime.storageManager.open(space);
          if (
            !matches(viewEntry) && !visibilityFlushed &&
            provider.pullToServerHead !== undefined
          ) {
            visibilityFlushed = true;
            this.#options.stats.events.visibilityBarriers += 1;
            try {
              // Admission precedes loopback delivery. Publish this space's
              // queued frames, then use their ordered response boundary to
              // await application. Pending wave writes need not promote here.
              await this.#options.server.flushSessions([space]);
              if (!this.#active || this.#runtime !== runtime) return undefined;
              await provider.pullToServerHead();
            } catch (error) {
              if (!this.#active || this.#runtime !== runtime) return undefined;
              logger.warn("event-visibility-sync-failed", () => [
                `Could not synchronize event ${entry.eventId}'s replica view`,
                error,
              ]);
            }
            if (!this.#active || this.#runtime !== runtime) return undefined;
            // Compaction or another consequence can change the stored index
            // during the response. Re-find the same immutable entry identity.
            stored = ((Engine.read(engine, { id: doc.id })?.value ??
              {}) as StreamEventsDocValue).entries ?? [];
            sidecar.stored = stored;
            index = stored.findIndex((candidate) =>
              candidate?.eventId === entry.eventId &&
              candidate?.seq === entry.seq
            );
            if (index < 0 || stored[index].consequenced === true) continue;
            viewEntry = readViewEntry();
            if (matches(viewEntry)) {
              this.#options.stats.events.visibilityRecoveries += 1;
            }
          }
          if (!matches(viewEntry)) {
            this.#options.stats.events.visibilityDeferrals += 1;
            logger.warn("event-view-lag", () => [
              `drain deferring ${entry.eventId}: replica view holds ` +
              debugStr`$quote,long${viewEntry} at index ${index}; ` +
              "later-arrived events wait behind it",
            ]);
            // The same barrier as above: the deferred entry's
            // still-catching-up view must not let later arrivals run
            // ahead of it.
            this.#eventVisibilityFloor = entry.seq ?? 1;
            this.#notePreQueueDeferral(
              entry.eventId,
              () => `event ${entry.eventId} (replica view lagging)`,
            );
            this.#armDeferredRescan();
            break;
          }
          this.#preQueueDeferralStreaks.delete(entry.eventId);
        }
        const streamEntry = {
          sidecarId: doc.id,
          index,
          seq: entry.seq ?? 0,
        };
        // Only a NUMERIC-seq consequenced twin skips this entry
        // (round-2 thread T12): a seq-less consequenced entry (the
        // stage-G interim shape, legacy stores only — admission stamps
        // every new append's seq) holds no frontier position and its
        // dedupe RETIRES once consequenced (events.md §4), so a valid
        // re-admission after it is a NEW event whose handler must run
        // — skipping on the seq-less twin silently dropped it.
        const duplicateOfConsequenced = stored.some((candidate) =>
          candidate?.eventId === entry.eventId &&
          candidate.consequenced === true &&
          typeof candidate.seq === "number" &&
          candidate.seq !== entry.seq
        );
        if (duplicateOfConsequenced) {
          // events.md §4/§5: processing skips it; the entry is passed
          // by the frontier rather than wedging the stream.
          this.#options.stats.events.skippedIdempotent += 1;
          this.#sealEventConsequenceNotice(runtime, entry, streamEntry);
          continue;
        }
        const pendingCheckpoint = this.#pendingDeliveryCheckpointWrites.get(
          entry.eventId,
        );
        if (pendingCheckpoint !== undefined) {
          // A failure/recovery transition becomes retry authority only after
          // its bookkeeping wave confirms it. This also prevents repeated
          // recovery staging while that wave is still open.
          this.#loadParkDeferredInPass = true;
          break;
        }
        const durableCheckpoint = this.#deliveryCheckpoints.get(
          entry.eventId,
        ) ?? entry.deliveryDeferral;
        if (
          this.#deliveryCheckpointWriteBlocked.has(entry.eventId) ||
          this.#attentionSealWriteBlocked.has(entry.eventId)
        ) {
          // A failed processing-state write has no lease-local substitute.
          // Wait for a real storage/input wake before deriving it again,
          // including when the FIRST checkpoint never became durable.
          this.#loadParkDeferredInPass = true;
          break;
        }
        if (durableCheckpoint !== undefined) {
          let checkpoint = durableCheckpoint;
          if (
            this.#pendingAttentionNotices.has(entry.eventId) ||
            this.#drainInFlight.get(entry.eventId) === "marked"
          ) {
            this.#loadParkDeferredInPass = true;
            break;
          }
          let mayRetry = checkpoint.state === "recovering" &&
            !this.#deliveryRecoveryAttempts.has(entry.eventId);
          const recoveryEpoch = checkpoint.recoveryEpoch === undefined
            ? undefined
            : this.#deliveryLoadRecoveries.get(checkpoint.recoveryEpoch);
          if (
            checkpoint.state === "failed" &&
            checkpoint.phase === "dispatch-load" &&
            recoveryEpoch !== undefined
          ) {
            checkpoint = observeDeliveryRecovery(
              checkpoint,
              recoveryEpoch,
              this.#deliveryFailureNow(),
            );
            this.#deliveryLoadRecoveries.delete(
              durableCheckpoint.recoveryEpoch!,
            );
            this.#deliveryRecoveryAttempts.delete(entry.eventId);
            this.#deliveryCleanAttempts.delete(entry.eventId);
            this.#stageDeliveryCheckpoint(
              runtime,
              entry,
              streamEntry,
              checkpoint,
              false,
            );
            logger.warn("event-delivery-recovery-observed", () => [
              `event ${entry.eventId} observed recovery epoch ` +
              `${recoveryEpoch}; one delivery retry is awake`,
            ]);
            this.#loadParkDeferredInPass = true;
            break;
          }
          const attention = attentionForExpiredDeliveryFailure(
            checkpoint,
            this.#deliveryFailureNow(),
            this.#deliveryFailureBudgetMs(),
          );
          if (attention !== undefined) {
            if (this.#drainInFlight.has(entry.eventId)) {
              this.#options.stats.events.drainInFlightSkips += 1;
              this.#options.onDrainInFlightSkip?.(entry.eventId);
              this.#loadParkDeferredInPass = true;
              break;
            }
            this.#loadParkDeferredInPass = true;
            this.#drainInFlight.set(entry.eventId, "marked");
            this.#sealEventConsequenceNotice(
              runtime,
              entry,
              streamEntry,
              {
                kind: "needs-attention",
                message: "This event could not be delivered. Retry it after " +
                  "restoring access.",
                attention,
              },
            );
            break;
          }
          const cleanRetry = checkpoint.state === "failed" &&
            checkpoint.failureCount === 1 &&
            (checkpoint.failureClass === "timeout" ||
              checkpoint.failureClass === "unknown" ||
              checkpoint.phase === "commit-preparation") &&
            !this.#deliveryCleanAttempts.has(entry.eventId);
          const inputRetry = this.#deliveryInputWakes.delete(entry.eventId);
          mayRetry ||= cleanRetry || inputRetry;
          if (!mayRetry) {
            this.#scheduleDeliveryFailureWake(entry.eventId, checkpoint);
            this.#loadParkDeferredInPass = true;
            break;
          }
          if (checkpoint.state === "recovering") {
            this.#deliveryRecoveryAttempts.add(entry.eventId);
          } else if (cleanRetry) {
            this.#deliveryCleanAttempts.add(entry.eventId);
          }
        }
        // The in-flight guard (stage C tuning; #5969's (β), drain-own
        // copies only): an entry whose earlier drain copy is still
        // queued/held/running in the scheduler is not queued AGAIN — the
        // honest flush deadline (T3) ends cycles before a just-drained
        // event has run, and the post-commit re-arm re-drains the
        // still-pending entry every cut cycle. The copy completes (its
        // commit callback removes the id) or fails/defers (onFailure
        // removes it too), and a still-pending entry then re-drains as
        // before — the requeue and deferral retries are untouched.
        if (this.#drainInFlight.has(entry.eventId)) {
          this.#options.stats.events.drainInFlightSkips += 1;
          this.#options.onDrainInFlightSkip?.(entry.eventId);
          continue;
        }
        const link: NormalizedFullLink = {
          space,
          id: entry.stream.id as NormalizedFullLink["id"],
          path: [...entry.stream.path],
          scope: (entry.stream.scope ?? "space") as NormalizedFullLink["scope"],
        };
        try {
          await runtime.getCellFromLink({
            space,
            id: entry.stream.id as never,
            scope: (entry.stream.scope ?? "space") as never,
            path: [],
          }).sync();
        } catch {
          // A cold stream doc defers like a cold piece load below.
        }
        if (!this.#active || this.#runtime !== runtime) return undefined;
        // The load-park barrier's OTHER half, and it sits HERE — past
        // every await in the iteration, immediately before the queue —
        // on purpose. The scheduler-side barrier
        // (failHeadEventLoadPark) can only hold entries already IN the
        // event queue; an entry this pass has not queued YET is out of
        // its reach, and the gap is real because this loop awaits both
        // a new sidecar's `sync()` above and the stream doc's `sync()`
        // just now. A rejection landing in EITHER window sweeps only
        // what was queued at that instant, so a check placed before
        // one of them would let the entry queue anyway and commit
        // ahead of the deferred one (independent review P1). Stopping
        // the pass is the same `break` the sidecar-sync-failure arm
        // makes; the rescan re-drains from arrival position.
        if (this.#loadParkDeferredInPass) {
          this.#armDeferredRescan();
          break;
        }
        try {
          // The renderer-trust RE-MARK (fan-out stage B, OW34 — the
          // sister of the injected-keys re-mint below): an entry the
          // firing runtime attested renderer-trusted (`rendererTrusted:
          // true`, set only from the process-local mark; admission
          // refuses any other value) re-marks its payload in THIS
          // runtime, so the served handler run's UI-contract-gated
          // writes record the trusted-event policy input the CFC ladder
          // requires — under the same in-process trust the client-side
          // gate ran under (the entry was committed under the firing
          // client's own admission). Without it a per-user served
          // handler's write to an owner-protected cell is refused at
          // prepare ("missing trusted-event policy input").
          if (entry.rendererTrusted === true) {
            markRendererTrustedEvent(entry.payload);
          }
          this.#drainInFlight.set(entry.eventId, "queued");
          const eventId = entry.eventId;
          const tenure = runtime;
          runtime.scheduler.queueEvent(
            link,
            entry.payload,
            // No scheduler-side backoff: a transiently-failed seal leaves
            // the entry unconsequenced and durable, and the post-wave
            // re-arm rescans it — the wave IS the retry cadence.
            false,
            // The queued copy's FINAL callback (every terminal path of the
            // dispatch — commit result, drop, deferral, error): releases the
            // guard ONLY while the copy is still `queued`, i.e. nothing of
            // it reached a wave (an aborted run). A `marked` copy is
            // released by the wave outcome. Tenure-checked: a callback
            // from a parked runtime's last pass must not release the next
            // tenure's copy.
            () => {
              if (this.#runtime !== tenure) return;
              if (this.#drainInFlight.get(eventId) === "queued") {
                this.#drainInFlight.delete(eventId);
              }
            },
            false,
            {
              eventId: entry.eventId,
              // Sanitize BEFORE re-minting (verdict blocker,
              // 2026-08-12): a persisted malformed value (pre-guard or
              // corrupted rows) would throw in the mint's spread on
              // every scan — perpetual drain churn. Malformed degrades
              // to absent; the closed-world gate judges the payload
              // strictly, as with an unminted spoof.
              ...((() => {
                const carried = sanitizeRuntimeInjectedEventKeys(
                  entry.runtimeInjectedEventKeys,
                );
                if (
                  carried === undefined &&
                  entry.runtimeInjectedEventKeys !== undefined
                ) {
                  logger.warn("event-malformed-injected-keys", () => [
                    `entry ${entry.eventId} carries malformed ` +
                    "runtimeInjectedEventKeys; treated as absent",
                  ]);
                }
                return carried === undefined ? {} : {
                  // Re-mint the carried provenance in THIS runtime (the
                  // mint is a process-local trust mark): the entry's keys
                  // were committed under the firing client's own
                  // admission, the same in-process trust the client-side
                  // gate ran under.
                  runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(
                    carried,
                  ),
                };
              })()),
              served: {
                ...(entry.firedAt !== undefined
                  ? {
                    firedAt: {
                      ...(entry.firedAt.user !== undefined
                        ? { user: entry.firedAt.user }
                        : {}),
                      ...(entry.firedAt.session !== undefined
                        ? { session: entry.firedAt.session }
                        : {}),
                    },
                  }
                  : {}),
                streamEntry,
                onFailure: (outcome) => {
                  if (this.#runtime !== tenure) return;
                  if (
                    outcome.kind === "deferred" &&
                    "cause" in outcome &&
                    (outcome.cause === "load-park" ||
                      outcome.cause === "arrival-barrier" ||
                      outcome.cause === "delivery-failure")
                  ) {
                    // The failed head owns the durable checkpoint. A
                    // same-space follower is only arrival-barrier work and
                    // must never inherit the head's failure age or class.
                    this.#options.stats.events.loadParkDeferrals += 1;
                    this.#options.onEventDeferred?.();
                    this.#loadParkDeferredInPass = true;
                    if (
                      outcome.cause === "load-park" ||
                      outcome.cause === "delivery-failure"
                    ) {
                      this.#recordDeliveryFailure(
                        runtime,
                        entry,
                        streamEntry,
                        outcome.failure,
                        outcome.cause === "delivery-failure"
                          ? outcome.phase
                          : "dispatch-load",
                      );
                    } else {
                      this.#drainInFlight.delete(eventId);
                    }
                    return;
                  }
                  if (outcome.kind === "deferred") {
                    if (
                      "cause" in outcome && outcome.cause === "handler-not-run"
                    ) {
                      // Mark/effects atomicity (events.md §4, RULED
                      // 2026-08-27): the dispatched handler's body did
                      // not run and its tx — carrying the pre-stamped
                      // mark — was withdrawn. Loud counter; the entry
                      // takes the same plain-deferral pending path
                      // below (threshold backstop included).
                      this.#options.stats.events.handlerNotRunDeferrals += 1;
                      this.#options.onEventDeferred?.();
                    }
                    const deferrals =
                      (this.#eventDeferrals.get(entry.eventId) ?? 0) + 1;
                    this.#eventDeferrals.set(entry.eventId, deferrals);
                    if (deferrals < EVENT_DEFERRAL_DROP_THRESHOLD) {
                      if (
                        "cause" in outcome &&
                        outcome.cause === "handler-not-run"
                      ) {
                        // The withdrawal's arrival-order barrier,
                        // MID-PASS half (events.md §2; review-6459 F1
                        // completed): the scheduler-side sweep can only
                        // hold entries already IN the event queue. A
                        // withdrawal landing while a drain pass awaits
                        // a later sidecar's sync would let that pass
                        // queue the next arrival behind the barrier's
                        // back — the same gap the load-park causes
                        // close through this flag (see the
                        // #drainStreamEvents check past every await).
                        this.#loadParkDeferredInPass = true;
                      }
                      // No consequence: the entry stays pending; the
                      // re-drain waits for input or the backstop tick
                      // (the cold-view creation race — OW19's
                      // conflation caution), NEVER a synchronous spin.
                      // The copy left no mark: release the guard so the
                      // rescan can queue it again.
                      this.#drainInFlight.delete(eventId);
                      this.#armDeferredRescan();
                      return;
                    }
                    // The race window is long past — events.md §5's
                    // terminal drop. The notice un-renders the echo and
                    // un-wedges the stream (and the park criterion).
                    // Its mark is being STAGED for a wave: the copy is
                    // `marked` until the wave outcome (or the notice's
                    // own failure) releases it. A §5 DROP notice is the
                    // user-facing record of a permanently lost action,
                    // so its message names the CAUSE of the final
                    // deferral honestly (review-6459 F2): for
                    // handler-not-run the handler was runnable and
                    // DISPATCHED — the deferrals were withdrawn
                    // dispatches, not load attempts — while the classic
                    // cold-view shape keeps §5's no-runnable-handler
                    // drop predicate wording.
                    this.#eventDeferrals.delete(entry.eventId);
                    this.#drainInFlight.set(eventId, "marked");
                    this.#sealEventConsequenceNotice(
                      runtime,
                      entry,
                      streamEntry,
                      {
                        kind: "dropped",
                        message: ("cause" in outcome &&
                            outcome.cause === "handler-not-run"
                          ? "handler did not run after " +
                            `${deferrals} withdrawn dispatches: `
                          : "no runnable handler after " +
                            `${deferrals} deferred load attempts: `) +
                          outcome.message,
                      },
                    );
                    return;
                  }
                  // The error/drop notice is a mark on its way to a wave.
                  this.#eventDeferrals.delete(entry.eventId);
                  this.#drainInFlight.set(eventId, "marked");
                  this.#sealEventConsequenceNotice(
                    runtime,
                    entry,
                    streamEntry,
                    { kind: outcome.kind, message: outcome.message },
                  );
                },
              },
            },
          );
          queued += 1;
          this.#preQueueDeferralStreaks.delete(`queue\0${entry.eventId}`);
        } catch (drainError) {
          // Nothing was queued: release the guard (a throw between the
          // add and the queue must not strand the entry until park).
          this.#drainInFlight.delete(entry.eventId);
          logger.warn("drain-debug", () => ["per-entry threw", drainError]);
          // A queue-time throw is a deferral like the arms above, and
          // the same BARRIER applies: letting later arrivals queue in
          // this pass while an earlier arrival re-drains later is the
          // ordering inversion this drain exists to prevent. The streak
          // key carries its own namespace: the view check CLEARS the
          // bare eventId key when it passes — before the queue attempt —
          // so a shared key would oscillate 0→1 forever and the stuck
          // crossing could never fire for exactly this arm. Each arm's
          // streak clears when the key passes ITS OWN check: the queue
          // arm's clears on a successful queue.
          this.#notePreQueueDeferral(
            `queue\0${entry.eventId}`,
            () => `event ${entry.eventId} (queue-time throw)`,
          );
          this.#armDeferredRescan();
          break;
        }
      }
    }
    this.#options.stats.events.processed += queued;
    this.#options.onEventDrainPass?.(queued);
    if (queued > this.#options.stats.events.coalescedPerWaveMax) {
      this.#options.stats.events.coalescedPerWaveMax = queued;
    }
    return queued;
  }

  /**
   * Seal one event's consequence OUTSIDE a handler tx (the skip, error,
   * and drop arms — the handler tx either never ran or aborted): an
   * event-handler-class tx carrying the entry's `consequenced` mark
   * (written by the stamper) plus the arm's notice fields
   * (events.md §5: the error — or the `{status: "dropped", reason}`
   * notice — IS the consequence, and the frontier advances past it).
   * The seal rides the CURRENT wave; the wave close awaits it.
   */
  #sealEventConsequenceNotice(
    runtime: Runtime,
    entry: StreamEventEntry,
    streamEntry: { sidecarId: string; index: number; seq: number },
    outcome?:
      | { kind: "error" | "dropped"; message: string }
      | {
        kind: "needs-attention";
        message: string;
        attention: DeliveryAttention;
      },
  ): void {
    try {
      const tx = runtime.edit();
      runtime.stampServerRun(tx, {
        actionId: `server-execution/event-consequence:${entry.eventId}`,
        kind: "event-handler",
        eventId: entry.eventId,
        streamEntry,
      });
      if (outcome !== undefined) {
        const base = {
          space: this.#options.space,
          id: streamEntry.sidecarId as never,
          scope: "space" as const,
        };
        if (outcome.kind === "error") {
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "error"],
          }).withTx(tx).set(outcome.message);
        } else {
          // The recorded observability gap (verification-coverage.md's
          // OW45 residue record), closed with the load-park fix: a
          // terminally discharged served event used to leave NO trace
          // in serving stats — `appended == processed` reads clean
          // while the user's action is permanently gone. Counted at the
          // DECISION, so a notice whose commit is refused and re-drains
          // counts again; read it with the WARNs, never alone.
          if (outcome.kind === "dropped") {
            this.#options.stats.events.dropped += 1;
          }
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "status"],
          }).withTx(tx).set(outcome.kind);
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "reason"],
          }).withTx(tx).set(outcome.message);
          if (outcome.kind === "needs-attention") {
            runtime.getCellFromLink<DeliveryAttention>({
              ...base,
              path: ["entries", String(streamEntry.index), "attention"],
            }).withTx(tx).set(outcome.attention);
            runtime.getCellFromLink<DeliveryDeferral | undefined>({
              ...base,
              path: [
                "entries",
                String(streamEntry.index),
                "deliveryDeferral",
              ],
            }).withTx(tx).set(undefined);
            runtime.getCellFromLink({
              space: this.#options.space,
              id: SERVER_EXECUTION_ATTENTION_DOC_ID as never,
              scope: "space",
              path: [
                "entries",
                eventAttentionIndexKey(streamEntry.sidecarId),
                eventAttentionEntryKey(entry.eventId, streamEntry.seq),
              ],
            }).withTx(tx).set({
              eventId: entry.eventId,
              seq: streamEntry.seq,
              sidecarId: streamEntry.sidecarId,
              phase: outcome.attention.phase,
              failureClass: outcome.attention.failureClass,
              code: outcome.attention.code,
              firstFailureAt: outcome.attention.firstFailureAt,
            });
            this.#pendingAttentionNotices.set(entry.eventId, {
              sidecarId: streamEntry.sidecarId,
              seq: streamEntry.seq,
              attention: outcome.attention,
            });
          }
        }
      }
      const commit = tx.commit();
      if (outcome?.kind === "needs-attention") {
        const pending = this.#pendingAttentionNotices.get(entry.eventId);
        if (pending?.attention === outcome.attention) {
          pending.wave = this.#waveByTx.get(tx);
        }
      }
      const sealed = commit.then((result) => {
        if (result.error !== undefined) throw result.error;
      }).catch((error) => {
        this.#recordEventNoticeFailure(entry, outcome, error, false);
      });
      this.#eventNoticeWork.add(sealed as Promise<unknown>);
      (sealed as Promise<unknown>).finally(() => {
        this.#eventNoticeWork.delete(sealed as Promise<unknown>);
      });
    } catch (error) {
      this.#recordEventNoticeFailure(entry, outcome, error, true);
    }
  }

  #recordEventNoticeFailure(
    entry: StreamEventEntry,
    outcome:
      | { kind: "error" | "dropped"; message: string }
      | {
        kind: "needs-attention";
        message: string;
        attention: DeliveryAttention;
      }
      | undefined,
    error: unknown,
    staging: boolean,
  ): void {
    if (outcome?.kind === "needs-attention") {
      this.#pendingAttentionNotices.delete(entry.eventId);
      this.#blockAttentionNoticeWrite(entry.eventId);
    }
    // The mark never reached a wave: the drain's guard releases so the
    // re-drain can queue the entry again.
    this.#drainInFlight.delete(entry.eventId);
    logger.warn(
      staging ? "event-notice-failed" : "event-notice-seal-failed",
      () => [
        `consequence notice for ${entry.eventId} ${
          staging ? "could not be staged" : "failed to seal"
        }; the entry stays pending and the next wave re-drains it`,
        error,
      ],
    );
  }

  #blockAttentionNoticeWrite(eventId: string): void {
    this.#attentionSealWriteBlocked.add(eventId);
    this.#deliveryWriteBlockedAt.set(eventId, this.#inputHead);
    this.#options.stats.events.needsAttentionSealFailures += 1;
  }

  /**
   * Retire acked effect entries (server-execution v2 Phase 4;
   * protocol.md §5's "the next wave retires acked entries"). Per
   * retirable SESSION instance of the well-known effects doc — the
   * ENGINE is the scan authority (`selectRetirableEffectsInstances`
   * reads true per-instance values; the serving replica's local view
   * collapses instances by scope name, the OW17 residual, and is never
   * consulted) — one BOOKKEEPING-stamped transaction writes the pruned
   * value at that instance: the SpaceServer's OWN write under its
   * service identity, carrying ADDRESSING (the seal-time scope-key
   * annotation from the stamped identity) and NO acting principal
   * (protocol.md §1's service-identity writes; T2.Q4). Conflict class:
   * a whole-doc bookkeeping SET drops whole on any concurrent write
   * (serving-loop.md §3d) — the owed flag stays armed until a scan
   * finds nothing retirable, so a dropped retirement self-heals next
   * cycle. Un-acked intents persist by construction: the prune removes
   * only acked entries (a reload re-reads and may re-enact them — LT8).
   */
  #retireAckedEffects(runtime: Runtime): void {
    if (!this.#effectsRetirementOwed) return;
    let retirable: ReturnType<
      typeof Engine.selectRetirableEffectsInstances
    >;
    try {
      retirable = Engine.selectRetirableEffectsInstances(
        this.#options.engine,
      );
    } catch (error) {
      logger.warn("effects-scan-failed", () => [
        "acked-effect retirement scan failed; retrying next cycle",
        error,
      ]);
      return;
    }
    if (retirable.length === 0) {
      this.#effectsRetirementOwed = false;
      return;
    }
    for (const instance of retirable) {
      const identity = identityOfScopeKey(instance.scopeKey);
      if (
        identity?.principal === undefined || identity.sessionId === undefined
      ) {
        // Not a session instance (the scan already filters; defensive).
        continue;
      }
      try {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: EFFECTS_RETIREMENT_ACTION_ID,
          kind: "bookkeeping",
          // ADDRESSING only: the seal resolves the write's scope key
          // from this identity; bookkeeping carries no acting principal
          // (protocol.md §1).
          scopeKeyIdentity: identity,
        });
        tx.writeValueOrThrow(
          {
            space: this.#options.space,
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: [],
          } as never,
          {
            entries: instance.remainingEntries,
            acks: instance.remainingAcks,
          } as never,
        );
        tx.commit().then(({ error }) => {
          if (error) {
            logger.warn("effects-retirement-seal-failed", () => [
              `retirement for ${instance.scopeKey} failed to seal; ` +
              "the armed scan retries next cycle",
              error,
            ]);
          }
        }).catch((error) => {
          logger.warn("effects-retirement-seal-failed", () => [
            `retirement for ${instance.scopeKey} rejected; the armed ` +
            "scan retries next cycle",
            error,
          ]);
        });
      } catch (error) {
        logger.warn("effects-retirement-failed", () => [
          `retirement for ${instance.scopeKey} could not be staged`,
          error,
        ]);
      }
    }
    // Stay armed: the next cycle's scan verifies the retirements landed
    // (and clears), or re-writes what a conflict dropped.
  }

  /** Load graph structure for the demanded values (serving-loop.md §1):
   * the server-side watch registry names what clients demand; each
   * demanded root's owning piece is ensured running (the sanctioned
   * auto-load prior art) so the scheduler can pull the demanded value
   * and its upstream. An ensure that does not land is COUNTED and
   * RETRIED: a false return (structure not loadable yet — the creation
   * race, where demand precedes the instantiation commit's arrival on
   * the serving replica) counts toward §7's structureLoadDeferred, a
   * throw toward structureLoadFailures, and either leaves the root in
   * `#pendingStructureLoads` for the next input-driven cycle — the
   * missing meta arrives as a commit, and that commit fires the cycle
   * that retries. */

  /** Fold the demand-root enter/leave delta SINCE THE LAST FOLD into the
   * space-lived `stats.demand` accumulators (MINOR-2). Called at the end
   * of every demand pass AND before park disposes the runtime, so a
   * transition the registration/unregistration hook fired between passes
   * (or after the last pass) is never dropped. `#lastFoldedDemand*` reset
   * to 0 when the runtime is replaced (activate), matching the fresh
   * runtime's zeroed counters. */
  #foldDemandRootDelta(): void {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const d = this.#options.stats.demand;
    const { enters, leaves } = runtime.scheduler.demandRootCounters;
    d.demandRootEnters += enters - this.#lastFoldedDemandEnters;
    d.demandRootLeaves += leaves - this.#lastFoldedDemandLeaves;
    this.#lastFoldedDemandEnters = enters;
    this.#lastFoldedDemandLeaves = leaves;
  }

  async #loadDemandedStructure(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const stats = this.#options.stats;
    const passStart = performance.now();
    // Obligation (iii): the demand-root enter/leave counters live on the
    // CURRENT runtime's scheduler and reset to 0 on a fresh runtime (a
    // reactivation after park). We fold the delta SINCE THE LAST FOLD
    // (`#lastFoldedDemand*`, reset to 0 when the runtime is replaced —
    // `#foldDemandRootDelta` below, called here AND at park) into the
    // space-lived `stats.demand` accumulators, so the totals survive park
    // AND capture transitions the REGISTRATION/UNREGISTRATION hook fires
    // BETWEEN passes (a piece loaded by event dispatch registers its
    // writers before this pass runs; unregistration on stop). A pass-START
    // snapshot swallowed those — the next pass's snapshot already included
    // them, so they were lost from the space-lived total (W1 review
    // MINOR-2).
    // The DEMAND PASS over the tracked-ids CLOSURE (stage-C design
    // §2.1/§2.2; serving-loop.md §1 as RULED 2026-08-18): the memory
    // server exposes every INSTANCE a client session tracks (the roots
    // and every doc the selectors' schemas reach), one row per (instance
    // key, session). The registry (`#demandersByKey`) is keyed by the
    // instance key — `toDirtyKey(id, scopeKey)` = `${scopeKey}\0${id}`,
    // byte-identical to the former `keyOf` — over EVERY demanded row; the
    // structure load stays ROOT-scoped (flag 4); there is NO demand walk
    // (deleted; nothing reads here). The pass is O(rows) map
    // reconciliation on DELTAS: entered keys mark their writers demand
    // roots (the scheduler's standing `demandedWriters` kind, bracketed —
    // §2.4); entered (key, pair) rows get the currency check (a writer not
    // current for the pair re-arms, B7's clean bit — §2.2); departed keys
    // release the roots (R-D's coarse boundary). The exposure is O(closure)
    // per pass (an incremental-delta exposure is a named follow-on if the
    // union grows to tens of thousands — W0 flag 6); the pass itself does
    // NO per-row engine read (W0 obligation (i): a per-row read here lands
    // on the wave-latency critical path — `#loadDemandedStructure` is
    // awaited before `runtime.idle()`).
    // MINOR-1: snapshot the demand-note generation at the row read — a
    // note landing after this point is invisible to `rows` and must
    // re-latch a fresh pass (below, in the loadPass `.finally`).
    this.#passDemandNoteGen = this.#demandNoteGeneration;
    const rows = this.#options.server.demandedInstancesForSpace(
      this.#options.space,
      // The serving session's own watches are its graph's reads, not
      // client demand.
      { excludePrincipal: this.#options.serviceIdentity },
    );
    const keyOf = (row: { id: string; scopeKey: string }): string =>
      `${row.scopeKey}\0${row.id}`;
    // The demanders per key THIS pass sees, the first row per key (the
    // structure address), and the ROOT keys (the structure load's input).
    const demandersNow = new Map<string, Map<string, ScopeKeyIdentity>>();
    const rowByKey = new Map<string, (typeof rows)[number]>();
    const rootKeys = new Set<string>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!rowByKey.has(key)) rowByKey.set(key, row);
      if (row.root) rootKeys.add(key);
      // Anonymous sessions (no principal) contribute the key but own no
      // instance — not a demander (`fanOutInstances` drops principal-less
      // pairs; parity with `watchedRootsForSpace`'s identity-less rows).
      if (row.identity?.principal === undefined) continue;
      const identity: ScopeKeyIdentity = {
        principal: row.identity.principal,
        ...(row.identity.sessionId === undefined
          ? {}
          : { sessionId: row.identity.sessionId as never }),
      };
      let pairs = demandersNow.get(key);
      if (pairs === undefined) {
        pairs = new Map();
        demandersNow.set(key, pairs);
      }
      pairs.set(demanderPairKey(identity), identity);
    }
    // WARM DEMAND KEYS (the explicit warm request's demand half — see
    // #warmDemandKeys): the staged instances enter the key set
    // identity-less (the anonymous-session shape — a key with no
    // demander pair) and as structure-load ROOTS, so a warmed,
    // sessionless tenure loads the staged piece and its writers become
    // demand roots. Client rows subsume: a key a session already
    // tracks contributes nothing new here, and the union keeps warm
    // keys out of the DEPARTED retirement below for this tenure.
    for (const [key, write] of this.#warmDemandKeys) {
      if (!rowByKey.has(key)) {
        rowByKey.set(key, {
          id: write.id,
          scope: scopeOfScopeKey(write.scopeKey) as CellScope,
          scopeKey: write.scopeKey as (typeof rows)[number]["scopeKey"],
          root: true,
        });
      }
      rootKeys.add(key);
    }
    // NIT-4: `rowByKey` is already the current-key set (a Map with O(1)
    // `has`); no separate `currentKeys` Set is needed.
    const addressOf = (key: string, row?: { id: string; scope?: string }) => {
      const sep = key.indexOf("\0");
      const scopeKey = key.slice(0, sep);
      const id = row?.id ?? key.slice(sep + 1);
      return {
        space: this.#options.space,
        id,
        scope: (row?.scope ?? scopeOfScopeKey(scopeKey)) as CellScope,
      };
    };
    // DEPARTED keys (no live client session tracks the instance any
    // more — coarse, RULED R-D): retire the registry entry, the load
    // state, and RELEASE the writers' root status (1→0, bracketed).
    for (const key of [...this.#demandersByKey.keys()]) {
      if (rowByKey.has(key)) continue;
      this.#demandersByKey.delete(key);
      this.#demandedRoots.delete(key);
      this.#unindexDemandKey(key);
      this.#pieceRootByDemandKey.delete(key);
      this.#pendingStructureLoads.delete(key);
      this.#terminalStructureLoads.delete(key);
      this.#rearmedAwaitingSettle.delete(key);
      // The stuck-streak entry retires with the rest of the per-key
      // load state (review finding): a departed root's streak would
      // otherwise linger for the space's whole life, and a later
      // re-demand of the same key would resume an obsolete streak
      // instead of starting a fresh episode.
      this.#structureLoadDeferralStreaks.delete(key);
      runtime.scheduler.leaveDemandedEntity(addressOf(key));
    }
    // ENTERED keys and pairs. A NEW key ENTERS the demanded entity (0→1
    // marks its current writers demand roots); a NEW pair on any key
    // gets the per-key currency check (design §2.2 step 3: her instance
    // never ran at the writer's ratchet, or was dirtied since ⇒ re-arm
    // with the siblings kept). Departed pairs retire (the run supply
    // prunes their instances on the node's next run). The root-level
    // arrival re-arm (`invalidateActionsForDemandRoots`) is KEPT for
    // root keys — a superset of the per-key check for root arrivals.
    const arrivals = new Set<string>();
    let notCurrentRearms = 0;
    for (const [key, row] of rowByKey) {
      const pairs = demandersNow.get(key) ??
        new Map<string, ScopeKeyIdentity>();
      let known = this.#demandersByKey.get(key);
      const address = addressOf(key, row);
      if (known === undefined) {
        known = new Map();
        this.#demandersByKey.set(key, known);
        this.#indexDemandKey(key, row.id);
        runtime.scheduler.enterDemandedEntity(address);
      }
      for (const pairKey of [...known.keys()]) {
        if (!pairs.has(pairKey)) known.delete(pairKey);
      }
      for (const [pairKey, identity] of pairs) {
        if (known.has(pairKey)) continue;
        known.set(pairKey, identity);
        if (this.#demandedRoots.has(key)) arrivals.add(key);
        notCurrentRearms += runtime.scheduler.rearmNotCurrentForDemander(
          address,
          identity,
        );
      }
    }
    // ONE changed-doc collection for the whole pass, opened BEFORE the pull
    // below rather than per root inside it. The pull is what registers each
    // root's watch, and a registered watch is what lets the traversal read
    // from the replica instead of fetching, so between the two a root's
    // reading is only as current as frame delivery has made it. The terminal
    // arm's invalidation check has to test the span the reading was taken
    // over, and that span starts here.
    const changedDocs = new Set<string>();
    this.#structureLoadChangedDocs = changedDocs;
    try {
      // Ahead of the loop, and so ahead of the demand-root bookkeeping it
      // does, which is what lets it read `firstDemand` the way the loop will.
      await this.#loadStructureRootDocs(runtime, rootKeys, rowByKey);
      // The STRUCTURE LOAD, per watch ROOT — unchanged in scope (flag 4)
      // and in mechanism (stage P2-F, the OW19 terminal state, the
      // commit-triggered re-arm); only the demand-walk install is gone.
      for (const key of rootKeys) {
        const root = rowByKey.get(key)!;
        const firstDemand = !this.#demandedRoots.has(key);
        // A known root re-enters this loop ONLY while its structure load
        // is still owed (the retry arm).
        if (!firstDemand && !this.#pendingStructureLoads.has(key)) continue;
        if (firstDemand) this.#demandedRoots.add(key);
        // A root parked TERMINAL stays parked until a commit touching one
        // of its observed docs re-arms it (the #drainFeed re-arm) — no
        // per-cycle ensure churn (stage P2-F, the OW19 design).
        if (this.#terminalStructureLoads.has(key)) {
          continue;
        } // Id-class exclusion (RULED 2026-08-07): well-known never-a-piece
        // ids register NO piece demand — no `ensurePieceRunning` attempt,
        // no retry, no `structureLoadDeferred` increment (the counter
        // stays meaningful for genuinely not-yet-loadable pieces).
        // `computed:` docs are derivation results, `cid:` docs are
        // content-addressed bundles, and the watermark doc is the
        // settledness subscription every waitForSettled/overlay client
        // holds — none can ever carry `patternIdentity` meta. The remaining
        // `of:` ids — which id classes cannot split into not-yet-created
        // pieces vs never-a-piece value docs — are covered by the TERMINAL
        // state below (stage P2-F): confirmed-synced-no-meta parks the
        // root, and the commit-triggered re-arm keeps the creation race
        // sound.
        else if (neverAPieceRootId(root.id)) {
          this.#pendingStructureLoads.delete(key);
          this.#structureLoadDeferralStreaks.delete(key);
          continue;
        } else {
          try {
            // propagateErrors: the catch below is the loop's FAILURE arm
            // (§7 structureLoadFailures); with the helper's default
            // collapse-to-false it was unreachable and every real
            // load/start error masqueraded as a creation-race deferral,
            // silently retried each input-driven cycle (r3739139521).
            // A demand naming an argument or derived doc resolves to the
            // OWNING piece root; the per-(action × instance) run supply
            // finds the demand's identity from that piece's actions through
            // this mapping (stage P2-F). Recorded before the piece starts,
            // so a run the start releases finds it. The piece may already
            // be running, started by another key's load earlier in this
            // pass, with its nodes run before this key's demanders were
            // reachable: those nodes re-arm for them exactly as they do for
            // a demander who arrives after the mapping (the arrival re-arm
            // below).
            const onOwningRoot = (rootId: string) => {
              if (rootId === root.id) return;
              if (this.#pieceRootByDemandKey.get(key) === rootId) return;
              this.#pieceRootByDemandKey.set(key, rootId);
              this.#indexResolvedRoot(key, rootId);
              runtime.scheduler.invalidateActionsForDemandRoots([rootId]);
            };
            const attempt = await this.#attemptStructureLoad(
              runtime,
              root,
              onOwningRoot,
            );
            const verdict = attempt.verdict;
            if (!this.#active || this.#runtime !== runtime) return;
            if (verdict.started) {
              this.#pendingStructureLoads.delete(key);
              this.#structureLoadDeferralStreaks.delete(key);
            } else if (verdict.reason === "no-pattern-meta") {
              // Each traversal syncs the complete addresses it reads. Put the
              // question again before terminalizing, so metadata arriving
              // during the first traversal can start the piece — to the engine
              // where it can answer, and to the chain where it cannot.
              const confirmed = (await this.#confirmNoPatternMeta(
                runtime,
                root,
                attempt,
                onOwningRoot,
              )).verdict;
              if (!this.#active || this.#runtime !== runtime) return;
              if (confirmed.started) {
                this.#pendingStructureLoads.delete(key);
                this.#structureLoadDeferralStreaks.delete(key);
              } else if (confirmed.reason === "no-pattern-meta") {
                const changed = [
                  ...verdict.observedDocIds,
                  ...confirmed.observedDocIds,
                ]
                  .some((id) => changedDocs.has(id));
                const shadowed =
                  runtime.storageManager.open(this.#options.space)
                    .replica.unappliedForeignSeqFloor?.() !== undefined;
                if (changed || shadowed) {
                  this.#pendingStructureLoads.delete(key);
                  this.#rearmedAwaitingSettle.add(key);
                  this.#pendingStructureRetryWake = true;
                  stats.structureLoadDeferred += 1;
                  this.#noteStructureLoadDeferral(
                    key,
                    root.id,
                    "confirmation-invalidated",
                    stats,
                  );
                  continue;
                }
                this.#pendingStructureLoads.delete(key);
                this.#structureLoadDeferralStreaks.delete(key);
                this.#terminalStructureLoads.set(
                  key,
                  new Set(confirmed.observedDocIds),
                );
                stats.structureLoadTerminal += 1;
                logger.info?.("structure-load-terminal", () => [
                  `demanded root ${root.id} confirmed synced with no ` +
                  "pattern meta; parked terminal until a commit touches " +
                  "it (stage P2-F, OW19)",
                ]);
              } else {
                this.#pendingStructureLoads.add(key);
                stats.structureLoadDeferred += 1;
                this.#noteStructureLoadDeferral(
                  key,
                  root.id,
                  confirmed.reason,
                  stats,
                );
              }
            } else {
              // Not loadable YET for a non-terminal reason (a chain
              // cycle mid-write, an unloadable pattern awaiting its
              // source docs). Counted per attempt (§7
              // structureLoadDeferred) and left pending: the next
              // input-driven cycle retries.
              this.#pendingStructureLoads.add(key);
              stats.structureLoadDeferred += 1;
              this.#noteStructureLoadDeferral(
                key,
                root.id,
                verdict.reason,
                stats,
              );
              logger.debug?.("structure-load-deferred", () => [
                `demanded root ${root.id} not loadable yet ` +
                `(${verdict.reason ?? "unclassified"}); ` +
                "retrying next demand cycle",
              ]);
            }
          } catch (error) {
            if (!this.#active || this.#runtime !== runtime) return;
            this.#pendingStructureLoads.add(key);
            stats.structureLoadFailures += 1;
            logger.warn("structure-load-failed", () => [
              `demanded root ${root.id} did not load`,
              error,
            ]);
          }
        }
      }
    } finally {
      if (this.#structureLoadChangedDocs === changedDocs) {
        this.#structureLoadChangedDocs = undefined;
      }
    }
    if (arrivals.size > 0) {
      // The ARRIVAL RE-ARM (design §A; RULED 2026-08-16): the narrowed
      // nodes beneath each arrived key's roots re-run for the arriving
      // demander only (their per-instance record is kept — B7). The
      // resolved piece root of an argument-doc demand joins the root
      // set, so a piece demanded through its argument doc re-arms too.
      const rootIds = new Set<string>();
      for (const key of arrivals) {
        rootIds.add(key.slice(key.indexOf("\0") + 1));
        const resolved = this.#pieceRootByDemandKey.get(key);
        if (resolved !== undefined) rootIds.add(resolved);
      }
      const rearmed = runtime.scheduler.invalidateActionsForDemandRoots(
        [...rootIds],
      );
      stats.demandArrivals += 1;
      logger.debug?.("demand-arrival", () => [
        `demanders arrived for ${arrivals.size} root(s); re-armed ` +
        `${rearmed} narrowed node(s) for them (fan-out stage B)`,
      ]);
    }
    // The (d′) `demand` counter block (serving-loop.md §7). Current
    // snapshots (`demandedRows` / `demandedInstances` / `demandedPairs` /
    // `demandedWriters`) plus their maxima and the ACCUMULATED tallies.
    // No per-row engine read: `demandedRows` is the exposed row count,
    // `demandedInstances` the registry size, both O(1) reads of counts the
    // reconcile already produced (W0 obligation (i)). No `walkRuns` — the
    // walk is deleted; T9′ pins its absence. The flag-4 no-writer count
    // (a demanded piece doc with no server-registered writer) needs a
    // per-row engine read for the pattern-meta test, so it is NOT computed
    // here; W0 measured it once (chat 2 / note 19 / lunch 0) and the
    // register carries the id-class-filtered structure-load extension as a
    // future option (flag 4).
    let pairCount = 0;
    for (const pairs of this.#demandersByKey.values()) pairCount += pairs.size;
    const d = stats.demand;
    d.demandedRows = rows.length;
    d.demandedInstances = this.#demandersByKey.size;
    d.demandedInstancesMax = Math.max(
      d.demandedInstancesMax,
      d.demandedInstances,
    );
    d.demandedPairs = pairCount;
    d.demandedWriters = runtime.scheduler.demandedWriterCount;
    d.demandedWritersMax = Math.max(d.demandedWritersMax, d.demandedWriters);
    // Obligation (iii) + MINOR-2: fold the enter/leave delta SINCE THE
    // LAST FOLD into the space-lived accumulators (not a pass-start
    // snapshot, which would lose hook-driven transitions between passes;
    // not an absolute assign from the runtime, which zeroes on
    // reactivation).
    this.#foldDemandRootDelta();
    d.notCurrentRearms += notCurrentRearms;
    d.demandPasses += 1;
    d.demandPassMs += performance.now() - passStart;
  }

  /**
   * Bring every root document this pass's structure loads will read into the
   * serving replica, in one pull.
   *
   * The pass's structure loads are sequential — each root's traversal may
   * START a piece, and a start's writes belong to the wave that asked for it
   * — and each begins by syncing the root document it was handed, and, where
   * a scoped demand reads meta-less, the space instance it falls back to.
   * Awaiting them one at a time puts each of those syncs in a
   * `session.watch.add` of its own, so a pass over a board's roots costs a
   * round trip per root inside the wave's settle. Issued together, the
   * replica's refresh queue coalesces them into one add, and the traversals
   * that follow find their documents already held.
   *
   * What this changes is when the pass waits, not how it decides: the
   * addresses are the ones a load syncs, through the same session and under
   * the same identity, and a root whose sync fails is left to its own
   * traversal to report. One address is taken more often than a load takes
   * it. A load syncs a scoped root's space instance only when the scoped read
   * finds no pattern pointer and starts nothing, which the pull cannot know
   * in advance, so it takes that instance for every scoped root, and a scoped
   * root whose own instance resolves gains one watch its load would not have
   * added. That shape is uncommon — piece structure lives on the space
   * instance, so a scoped instance normally reads meta-less and falls back —
   * and not taking the fallback would leave it a sequential round trip for
   * every scoped root that does fall back.
   *
   * The skips restate the pass's own — a terminal park, an id class that
   * never owns a piece, and a known root whose load is no longer owed —
   * and only the coalescing rests on their agreeing. A root this pulls that
   * the pass then skips is one a client demands either way, and a root this
   * misses is one its traversal fetches as it always did.
   */
  async #loadStructureRootDocs(
    runtime: Runtime,
    rootKeys: ReadonlySet<string>,
    rowByKey: ReadonlyMap<string, { id: string; scope?: CellScope }>,
  ): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const key of rootKeys) {
      const root = rowByKey.get(key)!;
      const firstDemand = !this.#demandedRoots.has(key);
      if (!firstDemand && !this.#pendingStructureLoads.has(key)) continue;
      if (this.#terminalStructureLoads.has(key)) continue;
      if (neverAPieceRootId(root.id)) continue;
      const scope = root.scope ?? "space";
      // A scoped demand that reads meta-less falls back to the SPACE
      // instance, so both are addresses a load may sync and both belong in
      // the pull. They are one address when the demand is space-scoped.
      const scopes: CellScope[] = scope === "space" ? ["space"] : [
        scope,
        "space",
      ];
      for (const instance of scopes) {
        const cell = runtime.getCellFromLink({
          space: this.#options.space,
          id: root.id as URI,
          scope: instance,
          path: [],
        });
        // A sync that rejects is not this pass's to report: the root's own
        // traversal issues the same sync a moment later and its failure arm
        // counts and logs what went wrong.
        pending.push(cell.sync().catch(() => {}));
      }
    }
    if (pending.length === 0) return;
    this.#options.stats.demand.structureRootsPreloaded += pending.length;
    await Promise.all(pending);
  }

  /** (d′) — flag 6's index (root id → the registry keys whose
   * id segment is that root, and resolved-root → keys), so `#demandersFor`
   * is a lookup instead of a full key scan per action run (with the
   * closure as keys the scan would be O(closure) twice per pass). */
  readonly #keysByRootId = new Map<string, Set<string>>();

  readonly #keysByResolvedRoot = new Map<string, Set<string>>();

  #indexDemandKey(key: string, id: string): void {
    let keys = this.#keysByRootId.get(id);
    if (keys === undefined) {
      keys = new Set();
      this.#keysByRootId.set(id, keys);
    }
    keys.add(key);
  }

  #indexResolvedRoot(key: string, rootId: string): void {
    let keys = this.#keysByResolvedRoot.get(rootId);
    if (keys === undefined) {
      keys = new Set();
      this.#keysByResolvedRoot.set(rootId, keys);
    }
    keys.add(key);
  }

  #unindexDemandKey(key: string): void {
    const id = key.slice(key.indexOf("\0") + 1);
    const keys = this.#keysByRootId.get(id);
    if (keys !== undefined) {
      keys.delete(key);
      if (keys.size === 0) this.#keysByRootId.delete(id);
    }
    const resolved = this.#pieceRootByDemandKey.get(key);
    if (resolved !== undefined) {
      const rkeys = this.#keysByResolvedRoot.get(resolved);
      if (rkeys !== undefined) {
        rkeys.delete(key);
        if (rkeys.size === 0) this.#keysByResolvedRoot.delete(resolved);
      }
    }
  }

  /** Track one root's consecutive-deferral streak and surface the
   * STUCK crossing (OW46): count `stats.structureLoadStuck` once at
   * `STRUCTURE_LOAD_STUCK_AFTER`, and WARN there and at each doubling
   * of the streak (8, 16, 32, …) so a forever-parked root keeps
   * showing up without per-cycle log spam. The streak is cleared by
   * the resolution arms (started / terminal / never-a-piece) and by
   * demand departure, never here. */
  #noteStructureLoadDeferral(
    key: string,
    rootId: string,
    reason: string | undefined,
    stats: { structureLoadStuck: number },
  ): void {
    const streak = (this.#structureLoadDeferralStreaks.get(key) ?? 0) + 1;
    this.#structureLoadDeferralStreaks.set(key, streak);
    if (streak < STRUCTURE_LOAD_STUCK_AFTER) return;
    if (streak === STRUCTURE_LOAD_STUCK_AFTER) {
      stats.structureLoadStuck += 1;
    }
    // Log at the crossing and at each doubling (power-of-two streaks).
    if ((streak & (streak - 1)) === 0) {
      logger.warn("structure-load-stuck", () => [
        `demanded root ${rootId} in ${this.#options.space} has deferred ` +
        `its structure load ${streak} consecutive cycles ` +
        `(${reason ?? "unclassified"}): the piece cannot start and the ` +
        "space serves nothing for it — a forever-park unless the " +
        "missing docs arrive (verification-coverage.md OW46; the " +
        "home-profile program-write-loss shape)",
      ]);
    }
  }

  /** Track one blocking key's consecutive PRE-QUEUE drain deferrals
   * (the arrival-order barrier's arms) and surface the STUCK crossing:
   * count `stats.events.preQueueDeferralStuck` once at
   * `EVENT_PREQUEUE_STUCK_AFTER`, and WARN there and at each doubling of
   * the streak — the same discipline as `#noteStructureLoadDeferral`.
   * The streak clears when the key passes its arm's check. */
  #notePreQueueDeferral(key: string, describe: () => string): void {
    const streak = (this.#preQueueDeferralStreaks.get(key) ?? 0) + 1;
    this.#preQueueDeferralStreaks.set(key, streak);
    if (streak < EVENT_PREQUEUE_STUCK_AFTER) return;
    if (streak === EVENT_PREQUEUE_STUCK_AFTER) {
      this.#options.stats.events.preQueueDeferralStuck += 1;
    }
    if ((streak & (streak - 1)) === 0) {
      logger.warn("event-prequeue-stuck", () => [
        `${describe()} has deferred the drain's arrival-order barrier ` +
        `${streak} consecutive passes in ${this.#options.space}: every ` +
        "later-arrived event waits behind it (verification-coverage.md " +
        "OW45 arm B; the order-preserving hardening — a notice in " +
        "arrival position — is the row's owed follow-up)",
      ]);
    }
  }

  /** One structure-load attempt for a demanded root (stage P2-F): the
   * demanded INSTANCE is tried first (a scoped result doc may carry
   * its own per-instance pattern pointer), and a scoped no-meta miss
   * falls back to the SPACE instance — piece structure is shared (one
   * graph; instances are data slots, scopes.md §2), so a scoped demand
   * on a shared-structure piece must load through the broad slot
   * rather than churn forever on its meta-less instance doc. */
  async #attemptStructureLoad(
    runtime: Runtime,
    root: { id: string; scope?: string },
    onOwningRoot: (rootId: string) => void,
  ): Promise<StructureLoadAttempt> {
    const scope = root.scope ?? "space";
    const termini: OwningRootAddress[] = [];
    const verdict = await ensurePieceRunningVerdict(runtime, {
      space: this.#options.space,
      id: root.id as never,
      scope: scope as never,
      path: [],
    }, {
      propagateErrors: true,
      signal: this.#structureLoadAbort.signal,
      onOwningRoot,
    });
    if (verdict.root !== undefined) termini.push(verdict.root);
    if (
      verdict.started || scope === "space" ||
      verdict.reason !== "no-pattern-meta"
    ) {
      return { verdict, termini };
    }
    const spaceVerdict = await ensurePieceRunningVerdict(runtime, {
      space: this.#options.space,
      id: root.id as never,
      scope: "space",
      path: [],
    }, {
      propagateErrors: true,
      signal: this.#structureLoadAbort.signal,
      onOwningRoot,
    });
    if (spaceVerdict.root !== undefined) termini.push(spaceVerdict.root);
    // Merge observed docs: the re-arm must watch both instances' reads.
    for (const id of verdict.observedDocIds) {
      if (!spaceVerdict.observedDocIds.includes(id)) {
        spaceVerdict.observedDocIds.push(id);
      }
    }
    return { verdict: spaceVerdict, termini };
  }

  /**
   * Re-read the owning chain and scoped fallback before a terminal decision,
   * unless the engine answers for them first.
   *
   * The traversal syncs each address before reading its metadata, which is
   * what makes the re-ask worth avoiding. This tenure runs beside the engine
   * its replica syncs from, so a pattern pointer the engine holds at none of
   * `attempt`'s termini is one no traversal can read at them either: the
   * attempt's own verdict stands, and the terminal park that follows is
   * re-armed by a commit touching an observed doc exactly as it would have
   * been. A pointer the engine does hold means the replica read behind it,
   * and the re-ask is what picks it up.
   */
  #confirmNoPatternMeta(
    runtime: Runtime,
    root: { id: string; scope?: string },
    attempt: StructureLoadAttempt,
    onOwningRoot: (rootId: string) => void,
  ): Promise<StructureLoadAttempt> {
    if (this.#enginePatternIdentityAbsent(runtime, attempt.termini)) {
      this.#options.stats.structureLoadConfirmationsSkipped += 1;
      return Promise.resolve(attempt);
    }
    return this.#attemptStructureLoad(runtime, root, onOwningRoot);
  }

  /**
   * Whether the engine holds no pattern pointer at any of `termini`.
   *
   * The engine is read at the instance the serving replica itself resolves
   * `scope` to — the manager's own session identity, which is what an
   * unstamped structure-load read keys by — because a document read under
   * another instance answers a different question. Anything this tenure
   * cannot address that way reads as `false`: a terminus in a foreign space,
   * a scope the session cannot key, a database already closed. So does a
   * pointer the engine holds. The caller's other arm is the conservative one,
   * and everything it cannot settle belongs there.
   */
  #enginePatternIdentityAbsent(
    runtime: Runtime,
    termini: readonly OwningRootAddress[],
  ): boolean {
    const { engine, space } = this.#options;
    if (termini.length === 0 || !engine.database.open) return false;
    const identity = runtime.storageManager.scopeKeyIdentity();
    for (const terminus of termini) {
      if (terminus.space !== space) return false;
      if (!canResolveScopeKey(terminus.scope, identity)) return false;
      const document = Engine.read(engine, {
        id: terminus.id as never,
        scopeKey: resolveScopeKey(terminus.scope, identity),
      });
      if (
        document !== null &&
        asPatternIdentityRef(document.patternIdentity) !== undefined
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * The LT1 leftover PURGE (stage C build W3, (α1); events.md §4's RULED
   * sentence: "the serving loop purges unrun in-process leftovers at the
   * flush deadline"): synchronously at the deadline decision — before the
   * scheduler's next turn — every scheduler-QUEUED event that is an LT1
   * same-space in-process copy (`served !== undefined &&
   * served.streamEntry === undefined`; a plain in-process event on the
   * serving runtime carries no `served` and is never purged; the drain's
   * copies carry a `streamEntry`) and has not started running is removed.
   * No notice lands on its durable entry (the copy carries no failure
   * hook and no commit callback — it could never mark), the entry stays
   * pending in the store, and the next drain delivers it ONCE with a
   * `streamEntry`. A copy already RUNNING at the deadline is out of the
   * queue's reach; `seal()`'s late-seal refusal (α1b) catches it when it
   * completes outside this wave. Counted `events.lt1LeftoversPurged`.
   */
  #purgeLt1Leftovers(runtime: Runtime): void {
    const purged = runtime.scheduler.purgeQueuedEvents(
      (event) =>
        event.served !== undefined && event.served.streamEntry === undefined,
      "LT1 in-process leftover purged at the flush deadline: its durable " +
        "entry is the truth and the next drain delivers it with a " +
        "streamEntry (events.md §4)",
    );
    if (purged > 0) {
      this.#options.stats.events.lt1LeftoversPurged += purged;
      logger.debug?.("lt1-leftovers-purged", () => [
        `space ${this.#options.space}: purged ${purged} LT1 in-process ` +
        "leftover(s) at the flush deadline; the drain delivers them",
      ]);
    }
  }

  /**
   * The tenure's space-root ensure (OW45 arm-B server-ensure stage 1;
   * design PR #6209 §1/§4): make sure the space's default pattern
   * EXISTS and is FRESH — the client-era duties 1 and 2, no start (the
   * serving loop starts pieces on demand; the runnability-repair pair
   * stays client-side until stage 2 moves it — the recorded stage-2
   * gate).
   *
   * Identity, per the design's §4(b): the space's ACL OWNER, resolved
   * through the memory server's ruled service-identity ACL read
   * (`resolveSpaceOwner`) — self-owned = the space's own home. The
   * creation transaction stamps `bookkeeping` (the §3d sanctioned
   * internal kind) AND attaches the owner-resolved trust snapshot, so
   * durable labels a schema mints resolve against the OWNER — never
   * the ambient service snapshot (the OW59 Q3 caveat's named
   * follow-up). A space with NO resolvable owner is SKIPPED
   * fail-closed: counted, warned, retried next tenure — never the
   * service DID as fallback (OW53's shape;
   * `homeSpacePrincipalFor`'s posture).
   *
   * Failures are counted and cleared for the tenure (the next
   * activation retries): the ensure must never park or spin the loop —
   * a space whose root cannot materialize still serves what it has,
   * and the OFF-era client path still covers creation in stage 1.
   */
  async #ensureSpaceRoot(runtime: Runtime): Promise<void> {
    const { engine, space, server } = this.#options;
    const stats = this.#options.stats.rootEnsure;
    try {
      // Inside the try like everything else the ensure does: the loop
      // must never park over the ensure — a thrown ACL read is a
      // counted failure, not a tenure-ending one.
      const owner = server.resolveSpaceOwner(engine, space);
      if (owner === undefined) {
        stats.skippedNoOwner += 1;
        this.#options.onRootEnsure?.("skipped-no-owner");
        this.#rootEnsureAwaitingOwner = true;
        // Once per tenure (F6): the first skip is the expected
        // fresh-space boot order (activation precedes the genesis ACL;
        // the ACL's admission re-arms this ensure) — informative once,
        // spam at 1:1 with re-arms on a permanently-ownerless space.
        if (!this.#rootEnsureNoOwnerWarned) {
          this.#rootEnsureNoOwnerWarned = true;
          logger.warn("space-root-ensure-no-owner", () => [
            `space ${space}: no concrete ACL owner resolves; the root ` +
            "ensure is SKIPPED fail-closed (never the service DID — " +
            "OW53's shape) and re-arms when a commit touches the ACL " +
            "doc. Expected once on a fresh space's first activation " +
            "(the genesis ACL lands moments later); repeated re-skips " +
            "are counted in rootEnsure.skippedNoOwner without further " +
            "warns.",
          ]);
        }
        return;
      }
      const deadlineMs = this.#options.policy?.rootEnsureDeadlineMs ??
        DEFAULT_ROOT_ENSURE_DEADLINE_MS;
      const work = ensureSpaceRootPattern(runtime, space, {
        // The ACL-derived home predicate (self-owned = home): the
        // client's `space === runtime.userIdentityDID` is WRONG here —
        // a serving runtime's userIdentityDID is the SERVICE DID.
        isHomeSpace: owner === space,
        genesisRoot: readGenesisRoot(engine),
        stampCreationTx: (tx) => {
          runtime.stampServerRun(tx, {
            actionId: `space-root-ensure/${space}`,
            kind: "bookkeeping",
          });
          // AFTER the stamp (which leaves an actor-less bookkeeping
          // run's snapshot alone), the owner-resolved per-run snapshot
          // — before the transaction's first read.
          tx.setCfcTrustSnapshot(
            runtime.trustSnapshotForPrincipal(owner),
          );
        },
      });
      // The F2 bound: race the ensure against its deadline. On the
      // deadline the throw lands in the counted-failure arm below and
      // the tenure proceeds serving; the DETACHED work keeps running —
      // its eventual writes stay safe: the creation arm converges by
      // address (cause-derived id + the OCC re-check every rival
      // creator rides) — and
      // its eventual rejection is swallowed here so it can never
      // surface as an unhandled rejection.
      work.catch(() => {});
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let result: Awaited<typeof work>;
      try {
        result = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `space-root ensure exceeded its ${deadlineMs}ms ` +
                      "deadline (SpaceServerPolicy.rootEnsureDeadlineMs); " +
                      "the tenure proceeds serving; the detached " +
                      "ensure's writes stay safe (creation converges " +
                      "by address)",
                  ),
                ),
              deadlineMs,
            );
          }),
        ]);
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
      stats.runs += 1;
      if (result.outcome === "created") stats.created += 1;
      this.#options.onRootEnsure?.(
        result.outcome === "created" ? "created" : "resolved",
      );
      logger.info?.("space-root-ensure", () => [
        `space ${space}: root ensure ${result.outcome} ` +
        `(owner ${owner}${owner === space ? ", self-owned home" : ""})`,
      ]);
    } catch (error) {
      stats.failures += 1;
      this.#options.onRootEnsure?.("failed");
      logger.warn("space-root-ensure-failed", () => [
        `space ${space}: root ensure failed; the tenure serves without ` +
        "it and the next activation retries (the client-era creation " +
        "path still covers stage 1)",
        error,
      ]);
    }
  }

  async #waveCycle(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined || !this.#active) return;
    this.#cycleCounter += 1;
    this.#discardEmptyWave();
    // The tenure's owed space-root ensure (OW45 arm-B stage 1) runs
    // single-flight BEFORE the tenure's ordinary steps: the event drain
    // may dispatch into the root's addPiece stream, and the demand
    // passes below load what the ensure materializes. Fully awaited
    // like the drain — once per tenure, so a slow first compile costs
    // the first wave only; its seal joins THIS cycle's wave and commits
    // with it. (Its commit resolves at seal-accept — the wave commit
    // happens at this cycle's end — so awaiting it here cannot
    // deadlock against the wave.)
    if (this.#rootEnsureOwed) {
      this.#rootEnsureOwed = false;
      const ensureStart = performance.now();
      await this.#ensureSpaceRoot(runtime);
      timing.time(ensureStart, "executor", "wave", "root-ensure");
    }
    // The queued lifecycle verbs run next, fully awaited like the ensure,
    // and for the same reason: their seals join this cycle's wave, whose
    // commit at the cycle's end is what settles them (`#serveWave`'s
    // outcome is what `#settleLifecycleVerbs` reads through `confirm`).
    // A verb that ran is settled either way: with its receipt or its
    // error after the wave commits, or with the cycle's own error if the
    // wave never gets that far.
    const verbs = await this.#runQueuedLifecycleVerbs(runtime);
    this.#servedWave = undefined;
    try {
      await this.#serveWave(runtime);
    } catch (error) {
      // A cycle that throws parks the space without committing its wave,
      // so nothing the verbs sealed is durable; their `confirm` reads
      // would see the replica the wave never withdrew from.
      for (const entry of verbs) entry.reject(error);
      throw error;
    }
    await this.#settleLifecycleVerbs(runtime, verbs);
  }

  /**
   * Run the lifecycle verbs queued when this cycle began, one at a time
   * and each awaited before the next, so a verb's seals join this cycle's
   * wave (a seal resolves at acceptance, ahead of the wave commit, so
   * awaiting it here cannot deadlock against the wave) and its direct
   * commits land ahead of it. The batch is the
   * queue as it stood at the start: a verb arriving while one runs waits
   * for the next cycle, so a steady arrival of requests cannot keep the
   * cycle from reaching its serving step. A verb that throws is settled
   * as rejected once the cycle ends; the verbs behind it still run. A
   * park mid-batch rejects the verbs not yet run the way a park rejects
   * the queue.
   */
  async #runQueuedLifecycleVerbs(
    runtime: Runtime,
  ): Promise<RanLifecycleVerb[]> {
    const ran: RanLifecycleVerb[] = [];
    const stats = this.#options.stats.lifecycleVerbs;
    const batch = this.#lifecycleVerbs.splice(0);
    for (const [index, queued] of batch.entries()) {
      if (!this.#active) {
        for (const unrun of batch.slice(index)) {
          unrun.reject(new Error(LIFECYCLE_VERB_SPACE_PARKED));
        }
        break;
      }
      const start = performance.now();
      const staged = new Map<string, { id: string; scopeKey: "space" }>();
      const running = {
        writes: staged,
        contributions: [],
        directCommitSeqs: [],
      };
      this.#runningLifecycleVerb = running;
      try {
        const ok = await queued.verb.run(runtime);
        const demandRoots = queued.verb.demandRoots?.(ok) ?? [];
        for (const id of demandRoots) {
          staged.set(toDirtyKey(id, "space"), { id, scopeKey: "space" });
        }
        const stagedWrites = demandRoots.length > 0 ? [...staged.values()] : [];
        this.#warmLifecycleVerbRoots(stagedWrites);
        ran.push({
          ...queued,
          outcome: { failed: false, ok },
          contributions: running.contributions,
          demandRoots,
          stagedWrites,
          directCommitSeqs: running.directCommitSeqs,
        });
      } catch (error) {
        stats.failures += 1;
        logger.warn("lifecycle-verb-failed", () => [
          `space ${this.#options.space}: lifecycle verb ` +
          `${queued.verb.name} failed`,
          error,
        ]);
        ran.push({
          ...queued,
          outcome: { failed: true, error },
          contributions: [],
          demandRoots: [],
          stagedWrites: [],
          directCommitSeqs: [],
        });
      } finally {
        this.#runningLifecycleVerb = undefined;
      }
      stats.runs += 1;
      timing.time(start, "executor", "wave", "lifecycle-verb");
    }
    return ran;
  }

  /**
   * Why a verb's writes are not durable after its cycle's serving step,
   * read off the wave commit outcome: the wave aborted, a different wave
   * was served, or one of the verb's own contributions was withdrawn or
   * partly dropped at the commit. `undefined` when every contribution
   * committed, or when the verb sealed nothing.
   */
  #lifecycleVerbNotDurable(entry: RanLifecycleVerb): string | undefined {
    if (entry.contributions.length === 0) return undefined;
    const served = this.#servedWave;
    for (const { wave, index } of entry.contributions) {
      if (served === undefined || served.wave !== wave) {
        return "the wave carrying its writes was not committed";
      }
      if (served.outcome.aborted !== undefined) {
        return `the wave carrying its writes aborted (${served.outcome.aborted})`;
      }
      const disposition = served.outcome.dispositions[index];
      if (disposition === undefined || disposition.kind !== "committed") {
        return `a contribution of its was ${
          disposition?.kind ?? "unaccounted for"
        } at the wave commit`;
      }
    }
    return undefined;
  }

  /**
   * Register the documents a verb staged as warm demand (see
   * {@link LifecycleVerb.demandRoots}): the roots and every document the
   * verb's transactions wrote, since a piece's computed values live in
   * documents of their own and a writer becomes live only when the
   * document it writes is demanded.
   */
  #warmLifecycleVerbRoots(
    writes: ReadonlyArray<{ id: string; scopeKey: "space" }>,
  ): void {
    let captured = false;
    for (const write of writes) {
      const key = toDirtyKey(write.id, write.scopeKey);
      if (this.#warmDemandKeys.has(key)) continue;
      this.#warmDemandKeys.set(key, write);
      captured = true;
    }
    if (captured) this.noteDemandChanged("warm");
  }

  /**
   * Record a running verb's space-scoped writes off the transaction's
   * journal at its seal; no-op outside a verb's run.
   */
  #recordLifecycleVerbWrites(tx: IExtendedStorageTransaction): void {
    const staged = this.#runningLifecycleVerb?.writes;
    if (staged === undefined) return;
    for (const detail of tx.tx.getWriteDetails?.(this.#options.space) ?? []) {
      const { id, scope } = detail.address;
      if (scope !== undefined && scope !== "space") continue;
      staged.set(toDirtyKey(id, "space"), { id, scopeKey: "space" });
    }
  }

  /**
   * Settle the verbs a cycle ran, after the cycle's wave commit step: a
   * verb whose run threw rejects with that error; one whose contributions
   * the wave commit did not carry whole rejects, as does one whose
   * `confirm` throws; every other resolves with its receipt. The wave's
   * commit outcome is the positive witness — the verb's contributions
   * committed — and `confirm` the read behind it, against the serving
   * runtime's replica, which the outcome has already applied to. A verb's
   * direct commits were durable before its run returned, so they need no
   * witness here beyond `confirm`.
   *
   * A verb's staged documents go back to the loop as a warm-marked notice
   * — the explicit warm request's carrier (serving-loop.md §1), which
   * provisioning uses for the setup it stages in another space. The pass
   * of the verb's own cycle could not load them, since it syncs from a
   * store the wave committed to only at the cycle's end; the notice is
   * input to the next cycle, whose pass loads the piece from the committed
   * store and derives it.
   */
  async #settleLifecycleVerbs(
    runtime: Runtime,
    ran: RanLifecycleVerb[],
  ): Promise<void> {
    for (const entry of ran) {
      if (entry.outcome.failed) {
        entry.reject(entry.outcome.error);
        continue;
      }
      try {
        const notDurable = this.#lifecycleVerbNotDurable(entry);
        if (notDurable !== undefined) throw new Error(notDurable);
        await entry.verb.confirm?.(runtime, entry.outcome.ok);
        const seq = entry.directCommitSeqs.reduce<number | undefined>(
          (latest, direct) =>
            latest === undefined || direct > latest ? direct : latest,
          this.#lastCommittedWaveSeq,
        );
        if (this.#active && entry.demandRoots.length > 0 && seq !== undefined) {
          this.#options.server.noteExecutorCommit({
            space: this.#options.space,
            seq,
            class: "authored",
            sessionId: this.#holder,
            writes: [...entry.stagedWrites],
            warm: true,
          });
        }
      } catch (error) {
        this.#options.stats.lifecycleVerbs.failures += 1;
        logger.warn("lifecycle-verb-unconfirmed", () => [
          `space ${this.#options.space}: lifecycle verb ` +
          `${entry.verb.name} ran but its effect is not durable`,
          error,
        ]);
        entry.reject(error);
        continue;
      }
      entry.resolve(entry.outcome.ok);
    }
  }

  /**
   * One wave (serving-loop.md §3): drain the input batch, let the
   * scheduler run the affected graph to quiescence — or to the
   * consequence-flush deadline (the second exhaustion trigger, RULED
   * 2026-08-04) — then commit ONE derived transaction carrying the wave's
   * writes, the watermark doc write, and `derivedThrough`.
   */
  async #serveWave(runtime: Runtime): Promise<void> {
    const { batchHead } = this.#drainFeed(runtime);
    // The event drain stays a fully-awaited, single-flight step AHEAD
    // of the deadline race (Phase 3's shape): at most one drain runs
    // at a time, so a deadline-cut wave can never leave a detached
    // drain racing the next wave's drain into double-queuing an entry.
    // It no longer waits for the demanded-structure load (P2-F moved
    // that under the deadline race below): dispatch auto-loads a
    // handler's piece itself (ensurePieceRunning), and a genuinely
    // cold view defers on the input/backstop cadence — the
    // creation-race arm the deferral budget was sized for. Being ahead of
    // the race and fully awaited is also why the drain is timed: it is
    // wave duration that no deadline bounds and no counter reports.
    const drainStart = performance.now();
    const drainedEvents = await this.#drainStreamEvents(runtime);
    timing.time(drainStart, "executor", "wave", "drain");
    if (drainedEvents === undefined) return;
    this.#retireAckedEffects(runtime);

    // Settle to quiescence under the flush deadline: idle() is the wave
    // boundary; synced() lets the loopback session's frames land so the
    // scheduler saw every input ≤ batchHead before we call the wave
    // quiescent (snapshot discipline: records arriving after the drain
    // belong to the NEXT wave).
    const deadlineMs = this.#options.policy?.flushDeadlineMs ??
      DEFAULT_FLUSH_DEADLINE_MS;
    const deadline = Date.now() + deadlineMs;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve("deadline"),
        Math.max(0, deadline - Date.now()),
      );
    });
    // The demanded-structure load pass runs UNDER the wave's flush
    // deadline (stage P2-F, the OW19 design's throughput half): before
    // this it ran ahead of the settle race with no bound, so one slow
    // ensure (an unresponsive pattern load, a wedged doc pull)
    // throttled input consumption for every user of the space.
    // Single-flighted: a pass that outlives its wave's deadline keeps
    // running — the next cycle joins it instead of starting a rival
    // pass over the same roots — and its completion wakes the loop so
    // freshly loaded structure settles in a fresh cycle rather than
    // waiting out the idle window.
    const joinLoadPass = () => {
      if (this.#structureLoadPass !== undefined) return this.#structureLoadPass;
      const pass = this.#loadDemandedStructure()
        .catch((error) => {
          logger.warn("structure-load-pass-failed", () => [
            "demand-structure load pass failed",
            error,
          ]);
        })
        .finally(() => {
          if (this.#structureLoadPass !== pass) return;
          this.#structureLoadPass = undefined;
          if (!this.#active || this.#runtime !== runtime) return;
          // MINOR-1: a demand note that landed AFTER this pass snapshotted
          // its rows (a straddling pass) did not reach the rows it read;
          // re-latch so the next wait runs a FRESH pass rather than
          // sleeping out the idle window.
          if (this.#demandNoteGeneration !== this.#passDemandNoteGen) {
            this.#pendingDemandWake = true;
          }
          if (
            this.#rearmedAwaitingSettle.size > 0 &&
            runtime.storageManager.open(this.#options.space).replica
                .unappliedForeignSeqFloor?.() === undefined
          ) {
            this.#pendingStructureRetryWake = true;
          }
          this.#feedArrived?.resolve();
        });
      this.#structureLoadPass = pass;
      return pass;
    };
    let loadPass = joinLoadPass();
    let exhausted = false;
    // The segment the deadline actually cuts. Read against
    // `executor/wave/cycle`: a settle at the deadline inside a much longer
    // cycle means the wave's cost is the seal and the commit, not the
    // derivations, and the two are fixed in different places.
    const settleStart = performance.now();
    try {
      while (true) {
        // RACE the deadline (serving-loop.md §3's second exhaustion
        // trigger): "a wave still running at T_flush commits what is
        // sealed so far" — including a wave whose settle is stuck behind
        // work that will not quiesce (a hung load, an unquiescing
        // cascade). The deadline must be able to fire MID-await.
        const step = await Promise.race([
          (async () => {
            await loadPass;
            await runtime.idle();
            // Couple the settle to FRAME DELIVERY (W-soundness): the
            // feed learns of a commit synchronously at admission, but
            // the serving runtime's DIRTINESS arrives on the loopback
            // session's sync frames, which the server flushes on a
            // timer. Draining the co-hosted server's refresh queue here
            // guarantees every frame for commits ≤ batchHead has been
            // SENT before this pass can declare quiescence — without
            // it, a wave could advance W past an authored commit whose
            // demanded derivation never ran (the frame was still in
            // the flush queue).
            await this.#options.server.idle();
            // The INPUT barrier, not the durability barrier: sealed
            // commits settle at the wave commit BELOW, so the full
            // synced() would deadlock here (see
            // StorageManager.inputSynced).
            await runtime.storageManager.inputSynced?.();
            // One macrotask yield: loopback frames are delivered
            // synchronously on send, but their application schedules
            // work; the yield lets it register dirtiness so the
            // isIdle() probe below sees it. (An application parked
            // behind one of our own sealed commits is excluded from
            // the W advance below via unappliedForeignSeqFloor — the
            // settle input barrier, Phase 2 revisit (a).)
            await new Promise((resolve) => setTimeout(resolve, 0));
            return "settled" as const;
          })(),
          deadlinePromise,
        ]);
        if (step === "deadline") {
          exhausted = true;
          this.#purgeLt1Leftovers(runtime);
          break;
        }
        if (!this.#active || this.#runtime !== runtime) break;
        if (
          this.#rearmedAwaitingSettle.size > 0 &&
          runtime.storageManager.open(this.#options.space).replica
              .unappliedForeignSeqFloor?.() === undefined
        ) {
          if (Date.now() >= deadline) {
            exhausted = true;
            this.#purgeLt1Leftovers(runtime);
            break;
          }
          // Frame application makes the re-arming metadata readable. Its
          // structure load and derivations still belong to this settle.
          for (const key of this.#rearmedAwaitingSettle) {
            this.#pendingStructureLoads.add(key);
          }
          this.#rearmedAwaitingSettle.clear();
          this.#pendingStructureRetryWake = false;
          loadPass = joinLoadPass();
          continue;
        }
        if (runtime.scheduler.isIdle()) break;
        if (Date.now() >= deadline) {
          exhausted = true;
          this.#purgeLt1Leftovers(runtime);
          break;
        }
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    // After the timer is cleared and outside the `finally`, for the reason
    // the cycle span is: a settle that threw is a failed wave, not a slow
    // one, and folding its duration in would blunt the measurement.
    timing.time(settleStart, "executor", "wave", "settle");
    if (!this.#active || this.#runtime !== runtime) return;

    const wave = this.#currentWave;
    const haveContributions = (wave?.contributionCount ?? 0) > 0;
    // Effect-only work (round-2 thread 1): deferred batches whose
    // transactions sealed NOTHING (all-no-op claim re-issues — the §6
    // step 3 recovery shape: activation re-runs a fetch whose claim is
    // already durable, the claim writes elide, only the effect
    // remains). They ride no contribution, so a quiet space would
    // never close the wave holding them — the batch starves, and the
    // eventual idle park drops it. Closing the wave for them commits
    // nothing (a zero-contribution commitWave is vacuous) and hands
    // the batches to the outbox below.
    const havePendingEffects = wave !== undefined &&
      (this.#pendingEffectsByWave.get(wave)?.length ?? 0) > 0;
    // W jumps to the top of the input batch at TRUE quiescence
    // (serving-loop.md §3): everything at or below batchHead has its
    // consequences committed and its demanded derivations current —
    // that is what the settle above established. An exhausted flush
    // carries no watermark movement. The advance is input-driven (the
    // batch head only moves when commits arrive), so a quiet space
    // commits nothing.
    //
    // The settle input barrier (Phase 2 revisit (a)): the settle above
    // proves frames were SENT and pulls settled — not that every
    // frame's novelty is VISIBLE. A foreign frame integrating under one
    // of the loop's own parked commits (CT-1927) stays shadowed until
    // the marker promotes it, and its dirtiness registers only then
    // (the replica's shadow-flip notification). Excluding those seqs
    // from the advance — the plan's sanctioned alternative to awaiting
    // them, which would deadlock — keeps W honest: it never claims a
    // seq whose demanded derivations could not have run. The clamp
    // lifts by itself: promotion fires the notification AND the
    // shadow-flip wake (`shadowFlipObserver`, installed at activation —
    // without it a then-quiet space would wait out the idle window),
    // the woken wave derives over the foreign value, and W catches up.
    const shadowFloor = runtime.storageManager
      .open(this.#options.space).replica.unappliedForeignSeqFloor?.();
    const shadowVisibleHead = shadowFloor === undefined
      ? batchHead
      : Math.min(batchHead, shadowFloor - 1);
    // A settled scheduler has not processed an entry the drain could not
    // queue. Its later frame application alone cannot establish coverage.
    const inputVisibleHead = this.#eventVisibilityFloor === undefined
      ? shadowVisibleHead
      : Math.min(shadowVisibleHead, this.#eventVisibilityFloor - 1);
    const inputAdvanceTo = exhausted
      ? this.#watermark
      : Math.max(this.#watermark, inputVisibleHead);
    if (
      !exhausted && shadowVisibleHead < batchHead &&
      batchHead > this.#watermark
    ) {
      // Counted whenever the floor held W below an OTHERWISE-ADVANCING
      // batch head (serving-loop.md §7's "actually clamped below the
      // input batch head"): the partial clamp (advanceTo strictly
      // between W and batchHead) AND the full suppression — the
      // shadowed seq is the lowest input above W, or the shadowed
      // REMOVE's sentinel floor 1 holds W entirely — where advanceTo
      // == W and the pre-fix `advanceTo > W` guard missed the count. A
      // floor with batchHead ≤ W is still NOT a clamp: no advance was
      // owed. An exhausted flush is likewise excluded — exhaustion
      // suppresses the advance regardless of the floor, and §7's
      // wavesBudgetExhausted carries that case.
      this.#options.stats.watermarkClamped += 1;
      logger.info?.("watermark-clamped", () => [
        `space ${this.#options.space}: W advance clamped to ` +
        `${inputAdvanceTo} (batchHead ${batchHead}, shadow floor ` +
        `${shadowFloor}) — foreign novelty parked behind an own ` +
        "sealed commit (settle input barrier)",
      ]);
    }

    // S1 — THE DRAIN-SETTLE QUIESCENCE ADVANCE (RULED 2026-08-19;
    // protocol.md §4's amendment; the swatch-stall fix seat,
    // stage-c/swatch-stall-rootcause.md §4): at drain-settle — a TRUE
    // settle with no contributions, no pending events, the drain
    // empty — W additionally advances over the space's own committed
    // DERIVED TAIL: own waves and effect completions above the input
    // coverage point.
    // Without it, W froze below any client retirement floor that
    // includes a pushed derived commit's seq (a re-derivation that
    // read a served value — the stall's diverged tombstone) until the
    // next authored commit anywhere in the space; the sweep's "each
    // new input lifts the previous generation" now holds WITHOUT
    // requiring the next input. The advance asserts nothing new about
    // coverage — the tail derivations are already committed and
    // delivered; it closes the quiescence gap.
    //
    // Bounded by construction, three ways: (a) the LATCH — armed only
    // by content-carrying derived commits, consumed on seal — makes it
    // once per quiescence transition, never per wave, and its own
    // bookkeeping-only commit never re-arms it (the #coverageHead
    // commit-storm class); (b) the CONTIGUITY WALK covers only seqs in
    // #ownDerivedSeqs — an in-flight authored notice, a late-authored
    // record, or any foreign commit above the base is a hole the walk
    // stops at (fail-closed: W never claims a seq whose consequences
    // this loop has not accounted; such a seq's coverage arrives on
    // the ordinary input-driven path); (c) OFF is structurally
    // unreached — the OFF arm constructs no SpaceServer, so no serving
    // loop runs this cycle at all. A failed seal keeps the latch armed;
    // the idle-wait timeout wakes a retry cycle (bounded by
    // idleParkMs), matching the existing advance-seal-failure posture.
    let advanceTo = inputAdvanceTo;
    let settleAdvanceFrom: number | undefined;
    let settleAdvanceGeneration: number | undefined;
    if (
      !exhausted && this.#settleAdvanceOwed &&
      !haveContributions && !havePendingEffects &&
      this.#feed.length === 0 && this.#pendingWaveSeals === 0 &&
      !this.#eventScanOwed && this.#eventVisibilityFloor === undefined &&
      !this.#effectsRetirementOwed
    ) {
      const base = Math.max(this.#watermark, inputAdvanceTo);
      let tail = base;
      while (this.#ownDerivedSeqs.has(tail + 1)) tail += 1;
      if (tail > base) {
        advanceTo = Math.max(inputAdvanceTo, tail);
        settleAdvanceFrom = base;
        settleAdvanceGeneration = this.#ownContentGeneration;
      }
    }
    const shouldAdvance = !exhausted && advanceTo > this.#watermark;

    // The wave the bookkeeping write below seals into must be one opened
    // at this cycle's serverSeq, not one a seal opened earlier and left
    // empty (see #discardEmptyWave): the watermark doc's head has moved
    // with every own wave commit since, and a write sealed under an older
    // basis is dropped whole as a semantic conflict with the loop's own
    // previous write of the same path.
    this.#discardEmptyWave();

    if (!haveContributions && !shouldAdvance && !havePendingEffects) {
      // Nothing sealed and no watermark movement: no commit (the
      // zero-delta case — light cycles cost nothing). An EXHAUSTED
      // empty cycle is still counted: a wedged never-quiescing settle
      // is exactly what §7's wavesBudgetExhausted exists to surface.
      if (exhausted) {
        this.#options.stats.wavesBudgetExhausted += 1;
        logger.debug?.("wave-budget-exhausted", () => [
          `space ${this.#options.space} exhausted the flush deadline on ` +
          `a zero-delta cycle: batchHead ${batchHead}, ` +
          `total ${this.#options.stats.wavesBudgetExhausted}`,
        ]);
      }
      // The owed re-drain rides quiet cycles too (round-2 thread 9): a
      // transport-failed delivery must retry on the NEXT loop cycle,
      // not wait for a new input wave or a re-activation.
      await this.#viewPlanPublisher.publish(
        runtime,
        this.#options.server,
        this.#options.space,
      );
      await this.#drainOutboxAppends(false);
      return;
    }

    // The loop's own bookkeeping write (the sanctioned internal stamp
    // kind): the watermark doc advances INSIDE the same wave commit —
    // never its own commit (protocol.md §4). An exhausted wave carries
    // no watermark movement (`derivedThrough` stays at the current W;
    // serving-loop.md §3). Written as a key-path SET (a patch against an
    // existing doc) so the bookkeeping conflict class's REBASE arm is
    // live: a disjoint concurrent patch to the watermark doc commutes,
    // while a whole-doc authored intrusion (forgery) still conflicts
    // semantically and drops the DOC write whole. Stated truthfully:
    // that drop is decided inside commitWave, AFTER `advanceSealed`
    // below already fed `derivedThrough` and armed the in-memory
    // advance — which keys off the WAVE commit succeeding
    // (`outcome.seq`), not off the doc write surviving — so the commit
    // metadata and this loop's `#watermark` still advance while the doc
    // lags, and on a quiet space no re-advance follows (the advance is
    // input-driven; the next one comes with the next input batch).
    // Accepted, not a gap to fix here: watermark forgery is an authored
    // intrusion inside protocol.md §1's threat model, and the failure
    // is conservative for clients — waitForSettled reads the DOC, so a
    // dropped doc write leaves them unsettled (never settled early),
    // until the next input-driven advance re-lands it.
    let advanceSealed = false;
    if (shouldAdvance) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: WATERMARK_ACTION_ID,
        kind: "bookkeeping",
      });
      // BLIND key-path write (RULED 2026-08-07): the cell route's
      // read-before-write synced the watermark doc over the loopback
      // SESSION plane under the service principal — DENIED on
      // owner-only-ACL spaces (a harmless but noisy AuthorizationError
      // per run). The loop's own bookkeeping write needs no
      // session-plane read: it stays a key-path write inside the wave
      // transaction (protocol.md §4's same-transaction invariant and
      // §3d's bookkeeping REBASE arm both keyed off the path shape,
      // unchanged), consistent with watermark.ts's engine-direct READ
      // posture — clients keep reading the doc through their ordinary
      // subscription.
      tx.writeValueOrThrow(
        {
          ...watermarkDocLink(this.#options.space),
          path: ["seq"],
        },
        advanceTo,
      );
      const committed = await tx.commit();
      if (committed.error) {
        // The advance did not enter the wave: W must not move either —
        // the doc and the metadata advance together or not at all
        // (protocol.md §4's same-transaction invariant).
        logger.warn("watermark-seal-failed", () => [
          "watermark bookkeeping write failed to seal; W held",
          committed.error,
        ]);
      } else {
        advanceSealed = true;
      }
    }

    // The consequence-notice seals (error/drop/skip arms) must land in
    // THIS wave: their marks are the events' consequences
    // (events.md §5), and the first flush carries them
    // (serving-loop.md §3's sealing order).
    if (this.#eventNoticeWork.size > 0) {
      await Promise.allSettled([...this.#eventNoticeWork]);
      this.#eventNoticeWork.clear();
    }

    const closing = this.#currentWave;
    if (closing === undefined) return;
    this.#currentWave = undefined;
    await this.#sealChain;

    // Phase 5 (protocol.md §2b): resolve the co-hosted engines for the
    // wave's foreign provisioning targets BEFORE the commit step — the
    // sink's engineFor is synchronous. Same host, same process.
    await this.#resolveForeignEngines(closing);

    // OW31 B4 (RULED 2026-08-18; protocol.md §2's genesis clause): for
    // every foreign target this wave was granted via the `creation`
    // arm, force the fresh space's GENESIS ACL — signed by the space's
    // own keys, naming the acting user OWNER — BEFORE the sink applies
    // the data batch, so the space's commit #1 IS the ACL commit
    // (INV-13's precedence, mirrored onto the engine-direct plane; the
    // sink refuses a foreign batch into a seq-0/no-ACL engine as the
    // backstop). The forcing is the provider mount's own bootstrap
    // (`#createInitializedSession`): an in-process loopback round trip,
    // idempotent on replay (the ACL exists → the bootstrap skips, and
    // the accept gate re-granted via `acl` through the owner). Failure
    // is isolated per space, exactly like a failed engine resolution:
    // the sink's refusal then fails the contributions targeting the
    // space (requeue for events, drop for derivations) and the wave
    // commits the rest.
    for (const creationSpace of closing.creationGrantedForeignSpaces()) {
      try {
        await this.#runtime!.storageManager.ensureSpaceInitialized?.(
          creationSpace,
        );
      } catch (error) {
        logger.warn("foreign-genesis-forcing-failed", () => [
          `forcing the genesis ACL of creation-granted foreign space ` +
          `${creationSpace} failed; its contributions will be refused ` +
          `by the sink's INV-13 mirror and replay (OW31 B4; ` +
          "protocol.md §2b)",
          error,
        ]);
      }
    }

    const derivedThrough = !exhausted && advanceSealed
      ? advanceTo
      : this.#watermark;
    const outcome = await closing.commitWave(this.#sink!, { derivedThrough });
    this.#servedWave = { wave: closing, outcome };
    if (outcome.seq !== undefined) this.#lastCommittedWaveSeq = outcome.seq;
    // The EXPLICIT WARM REQUEST (serving-loop.md §1's third activation
    // trigger; RULED 2026-08-21): every foreign provisioning batch this
    // wave durably committed is reported to the co-hosted memory server
    // as a warm-marked authored admission — the serving-side
    // provisioning path telling the host it STAGED SETUP into another
    // space. The host activates a parked, SESSIONLESS target on it (the
    // carries-events arm's sibling), and the target's tenure takes the
    // staged instances as warm demand, so the setup derives — closing
    // the setup-after-park ordering race (the home-profile reload
    // residual: an authored admission alone activates nothing by
    // design, T11.Q7, and nothing else ever re-demanded the setup).
    // Reported on EVERY outcome shape: a wave that aborted AFTER some
    // foreign batches landed still staged that setup durably (§2b never
    // rolls a landed foreign commit back).
    for (const foreign of outcome.foreignCommits) {
      this.#options.stats.warmRequests += 1;
      this.#options.server.noteExecutorCommit({
        space: foreign.space,
        seq: foreign.seq,
        class: "authored",
        sessionId: this.#holder,
        writes: foreign.writes,
        warm: true,
      });
    }
    await closing.settled();
    this.#reconcileDeliveryWritesAfterWave(closing);
    // A normal handler consequence clears `deliveryDeferral` in the same
    // accepted contribution that marks the entry. Retire the lease-local
    // mirror only after the wave reports that event committed; a requeued
    // event must keep its checkpoint and failed-state age.
    for (const eventId of outcome.committedEventIds) {
      if (!this.#deliveryCheckpoints.has(eventId)) continue;
      this.#setActiveDeliveryCheckpoint(eventId, undefined);
      this.#cancelDeliveryFailureWake(eventId);
      this.#uncommittedDeliveryFailureEpochs.delete(eventId);
      this.#deliveryCleanAttempts.delete(eventId);
      this.#deliveryRecoveryAttempts.delete(eventId);
    }
    // The drain's in-flight guard: the store has now spoken for every
    // event this wave carried — committed (its mark landed) or requeued
    // (its contributions withdrawn: lease-lost, rejected, foreign-failed,
    // raced — every abort arm reports its event-handler contributions as
    // requeued). Either way a later drain may queue the entry again if it
    // is still pending.
    for (const eventId of outcome.committedEventIds) {
      this.#drainInFlight.delete(eventId);
    }
    for (const eventId of outcome.requeuedEventIds) {
      this.#drainInFlight.delete(eventId);
    }
    // A row-label refusal is raised by the store transaction itself, after
    // the handler transaction has sealed into this wave. The accumulator
    // carries the exact failed operation's owner back here because resolving
    // every sealed transaction as a generic withdrawal loses that producer
    // type. Only this positively evidenced no-commit outcome enters the
    // commit-finalization policy; an unattributed or ambiguous rejection keeps
    // the ordinary requeue behavior above.
    for (const failure of outcome.provenNoCommitDeliveryFailures) {
      const entry = this.#storedStreamEntry(
        failure.streamEntry.sidecarId,
        failure.eventId,
        failure.streamEntry.seq,
      );
      if (entry === undefined || entry.consequenced === true) continue;
      this.#recordDeliveryFailure(
        runtime,
        entry,
        failure.streamEntry,
        failure,
        "commit-finalization",
      );
    }
    // The effect handoff (stage G, serving-loop.md §3): external effects
    // go to the outbox POST-commit. Taken off the map here either way;
    // the lease-lost branch below parks, so its batches are simply
    // dropped — the runtime dies with the wave (crash-equivalent, memo
    // re-miss covers the effect on re-activation).
    const pendingEffects = this.#pendingEffectsByWave.get(closing);
    this.#pendingEffectsByWave.delete(closing);

    const stats = this.#options.stats;
    stats.waves += 1;
    if (exhausted) {
      stats.wavesBudgetExhausted += 1;
      logger.debug?.("wave-budget-exhausted", () => [
        `space ${this.#options.space} exhausted the flush deadline: ` +
        `batchHead ${batchHead}, wave seq ${outcome.seq}, ` +
        `total ${stats.wavesBudgetExhausted}`,
      ]);
    }
    stats.supersededWrites += outcome.supersededWrites;
    stats.events.orphanDeliveriesRefused += outcome.orphanDeliveriesRefused;
    // Phase 3: a REQUEUED event's consequence contribution was rolled
    // back whole — its entry stays unconsequenced and durable, so the
    // next wave's scan re-finds and re-runs it (serving-loop.md §3d's
    // requeue arm; C8b). The same re-arm covers any drained event whose
    // seal failed transiently: its entry, too, is still pending.
    if (
      (outcome.requeuedEventIds?.length ?? 0) > 0 ||
      ((drainedEvents > 0 || outcome.seq !== undefined) &&
        Engine.selectPendingStreamEventDocs(this.#options.engine).length > 0)
    ) {
      // Re-arm sources: a REQUEUED event (its entry stayed pending); a
      // drained event whose seal failed transiently; and a wave that
      // COMMITTED same-space emitted entries (LT1's budget-exhausted
      // fallback — the entry is durable input, the next wave processes
      // it).
      this.#eventScanOwed = true;
    }
    // Stage G, post-commit: hand the wave's sealed effects to the
    // outbox BEFORE anything below can throw (a failed commit-record
    // fetch must not leak effects with the runtime still alive) — but
    // ONLY when the wave did not ABORT (round-2 thread 3:
    // `outcome.aborted === undefined`, which is a committed wave OR a
    // vacuous zero-contribution one — the effect-only batches of
    // thread 1 ride the latter; their claim writes were no-ops against
    // already-durable state, so nothing was withdrawn). A REJECTED or
    // FOREIGN-FAILED wave discards its batches instead: its sealed
    // claim writes (pending/requestHash) were WITHDRAWN, so firing
    // would egress network work for claims that never became durable,
    // and the completion would write result cells whose pending state
    // rolled back — the input-driven retry (the re-run re-seals and
    // re-enqueues into a later wave) is the sanctioned path. The
    // lease-lost arm parks below and discards with the dying runtime
    // (crash-equivalent, memo re-miss covers). Within a COMMITTED
    // wave, per-contribution withdrawals keep the ruled at-least-once
    // posture: the withdrawn action re-runs and re-enqueues (deduped
    // in flight), and completion writes are hash-guarded against
    // current inputs (serving-loop.md §4).
    if (
      outcome.aborted === undefined &&
      pendingEffects !== undefined && pendingEffects.length > 0
    ) {
      this.#outbox?.admitSealedEffects(pendingEffects);
    } else if (pendingEffects !== undefined) {
      for (const batch of pendingEffects) {
        abandonRunnerAcceptanceEffects(batch.effects, outcome.aborted);
      }
    }
    if (outcome.aborted === "lease-lost") {
      // PARK, never continue (W-soundness): the abort WITHDREW the
      // wave's sealed derivations, nothing re-arms their producers in
      // place (no revert consumer; the inputs did not change), and
      // #coverageHead has already claimed the input batch — a continued
      // loop (the renew-blip reacquire path, where lease.acquire()
      // succeeded and this runtime kept running) would mint a
      // watermark-only advance next cycle over demanded derivations
      // that never re-ran, making waitForSettled lie until the next
      // input change. Re-activation's fresh-runtime recompute-on-demand
      // is the ONLY post-abort recovery arm (serving-loop.md §6 step 2:
      // a demanded pull recomputes regardless).
      logger.warn("wave-aborted", () => [
        "wave aborted: lease lost mid-wave; parking " +
        "(serving-loop.md §2)",
      ]);
      await this.park("lease-lost-abort");
      return;
    }
    if (outcome.seq !== undefined) {
      bumpDerivedCommits(stats, String(this.#options.space));
      this.#wavesCommitted += 1;
      this.#options.onWaveCommitted?.();
      // (d′): a derived commit after a growth wake is the
      // structural-growth landing for the attributed input (checked
      // BEFORE this wave's own coverage rewrites #lastCovered).
      this.#recordGrowthLanding();
      // Advance-only commits join the contiguous tail but never arm the latch.
      this.#recordOwnDerivedCommit(
        outcome.seq,
        closing.contentContributionCount > 0,
      );
      if (!exhausted && advanceSealed) {
        const advancedFrom = this.#watermark;
        this.#watermark = advanceTo;
        this.#recordSettleCoverage(advanceTo);
        for (const seq of this.#ownDerivedSeqs) {
          if (seq <= advanceTo) this.#ownDerivedSeqs.delete(seq);
        }
        if (
          settleAdvanceFrom !== undefined &&
          closing.contentContributionCount === 0
        ) {
          // Content folded into this wave keeps the latch armed and is not
          // counted as an advance-only commit. A standalone completion after
          // the target was chosen also keeps the latch armed, but this wave
          // still counts: its own commit carried only the watermark advance.
          if (settleAdvanceGeneration === this.#ownContentGeneration) {
            this.#settleAdvanceOwed = false;
          }
          stats.settleAdvances.count += 1;
          stats.settleAdvances.lastDelta = advanceTo - settleAdvanceFrom;
          stats.settleAdvances.series.push({
            space: String(this.#options.space),
            from: settleAdvanceFrom,
            to: advanceTo,
            at: performance.now(),
          });
          if (stats.settleAdvances.series.length > 4000) {
            stats.settleAdvances.dropped += stats.settleAdvances.series.length -
              4000;
            stats.settleAdvances.series.splice(
              0,
              stats.settleAdvances.series.length - 4000,
            );
          }
          logger.debug?.("settle-advance", () => [
            `space ${this.#options.space}: drain-settle quiescence ` +
            `advance W ${advancedFrom} → ${advanceTo} (S1, RULED ` +
            "2026-08-19) — tail derivations covered without an " +
            "authored input",
          ]);
        }
      }
      // The wave commit entered the store on the co-hosted engine plane,
      // not through any session: report it so push fires (M4 — derived
      // commits reach subscribers) and the feed carries it (the loop
      // skips its own echo by class + holder).
      const records = Engine.selectCommitsSince(this.#options.engine, {
        fromSeq: outcome.seq - 1,
        limit: 1,
      });
      const record = records.find((entry) => entry.seq === outcome.seq);
      if (record !== undefined) {
        this.#options.server.noteExecutorCommit({
          space: this.#options.space,
          seq: record.seq,
          class: "derived",
          holder: this.#holder,
          sessionId: record.sessionId,
          writes: record.writes as AdmittedCommitNotice["writes"],
        });
      }
    }

    if (outcome.aborted === undefined) {
      await this.#viewPlanPublisher.publish(
        runtime,
        this.#options.server,
        this.#options.space,
      );
    }

    // Drain the durable append rows (FP1): after a wave that landed
    // appends, and after any earlier drain left rows behind (a
    // transport-failed delivery on a long-lived active space must not
    // wait for the next appends-carrying wave or a re-activation —
    // quiet cycles re-drain too, see the early return above).
    // Co-hosted delivery is an engine commit, not a network await.
    await this.#drainOutboxAppends(
      closing.hasOutboundAppends && outcome.seq !== undefined,
    );
  }

  /** The FP1 drain step, shared by the post-commit path and the
   * quiet-cycle owed retry (round-2 thread 9): deliver pending durable
   * append rows when this wave landed new ones or an earlier drain
   * left rows behind; remember `remaining > 0` so the next cycle
   * retries without fresh input. */
  async #drainOutboxAppends(hasNewAppends: boolean): Promise<void> {
    if (!hasNewAppends && !this.#outboxDrainOwed) return;
    try {
      const drained = await this.#outbox?.deliverPendingAppends();
      this.#outboxDrainOwed = (drained?.remaining ?? 0) > 0;
    } catch (error) {
      this.#outboxDrainOwed = true;
      logger.warn("append-drain-failed", () => [
        "outbox drain failed; rows kept for re-send",
        error,
      ]);
    }
  }

  /** Dispose the serving runtime under a DEADLINE (park liveness — the
   * lunch-wall mechanism): a serving runtime killed mid-wave can hang
   * `runtime.dispose()` forever (its loopback loads died with the
   * crashed wave), and a park gated on that dispose never resolves
   * `#parked` — every recovery the host chains behind `whenParked`
   * (`#reactivateAfterPark`) then
   * waits for eternity and the space is never served again, while
   * events keep appending durably. By the time dispose runs, the park's
   * semantic obligations are already met: the loop is stopped, the wave
   * abandoned, the seal chain drained — crash-equivalent teardown is
   * the sanctioned model for abandoned waves. So an overrunning dispose
   * is ABANDONED: logged loudly with the park bracket diagnostics,
   * counted (§7 `parkDisposeTimeouts`), its eventual completion or
   * failure logged when it lands; the park completes regardless (lease
   * released, `#parked` resolved, recovery unblocked). */
  async #disposeRuntimeTimeboxed(reason: string): Promise<void> {
    this.#viewPlanPublisher.dispose();
    const dispose = this.#disposeRuntime;
    if (dispose === undefined) return;
    const timeoutMs = this.#options.policy?.parkDisposeTimeoutMs ??
      DEFAULT_PARK_DISPOSE_TIMEOUT_MS;
    const pending = dispose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      pending.then(
        () => "disposed" as const,
        () => "failed" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (winner === "failed") {
      // Re-await so the caller's catch logs the error (the existing
      // park-dispose-failed arm).
      return pending;
    }
    if (winner === "timeout") {
      this.#options.stats.parkDisposeTimeouts += 1;
      logger.error(
        "park-dispose-timeout",
        `space ${this.#options.space}: runtime dispose overran ` +
          `${timeoutMs}ms during park (${reason}); abandoning the ` +
          "factory handle and completing the park — loop stopped, " +
          "wave abandoned, seal chain drained; lease releases and " +
          "whenParked resolves now (park liveness)",
      );
      // The abandoned dispose keeps running; observe its eventual fate
      // so a late completion is visible and a late rejection never
      // becomes an unhandled rejection.
      pending.then(
        () => {
          logger.warn("park-dispose-late", () => [
            `space ${this.#options.space}: abandoned park dispose ` +
            "completed late",
          ]);
        },
        (error) => {
          logger.warn("park-dispose-late-failed", () => [
            `space ${this.#options.space}: abandoned park dispose ` +
            "failed late",
            error,
          ]);
        },
      );
    }
  }

  /** Park (serving-loop.md §1): release the lease, dispose the runtime.
   * Once the park completes, the host re-activates a space that still
   * meets the ACTIVE criteria, unless a rival's lease caused the park. */
  async park(reason: string): Promise<void> {
    // A park already in flight — the renew arm's lease-lost park runs
    // unawaited — is what a second caller waits for: the host's close
    // must not return while a tenure is still disposing, since the
    // tenure releases its lease through the engine the host then closes.
    // Before any park, a not-yet-active server has nothing to wait for.
    if (!this.#active) {
      return this.#parkRequested ? this.#parked.promise : undefined;
    }
    await this.#parkResources(reason);
  }

  async #parkResources(reason: string): Promise<void> {
    const wasActive = this.#active;
    this.#active = false;
    this.#parkRequested = true;
    this.#structureLoadAbort.abort();
    if (wasActive) {
      this.#options.stats.activeSpaces = Math.max(
        0,
        this.#options.stats.activeSpaces - 1,
      );
    }
    if (this.#renewTimer !== undefined) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
    if (this.#deferredRescanTimer !== undefined) {
      clearTimeout(this.#deferredRescanTimer);
      this.#deferredRescanTimer = undefined;
    }
    this.#feedArrived?.resolve();
    for (const queued of this.#lifecycleVerbs.splice(0)) {
      queued.reject(new Error(LIFECYCLE_VERB_SPACE_PARKED));
    }
    // The drain's in-flight copies die with the scheduler queue below.
    this.#drainInFlight.clear();
    this.#eventVisibilityFloor = undefined;
    for (const timer of this.#deliveryFailureWakeTimers.values()) {
      clearTimeout(timer);
    }
    this.#deliveryFailureWakeTimers.clear();
    for (const eventId of [...this.#deliveryCheckpoints.keys()]) {
      this.#setActiveDeliveryCheckpoint(eventId, undefined);
    }
    this.#pendingDeliveryCheckpointWrites.clear();
    this.#pendingAttentionNotices.clear();
    this.#deliveryInputWakes.clear();
    this.#deliveryCleanAttempts.clear();
    this.#deliveryRecoveryAttempts.clear();
    this.#deliveryCheckpointWriteBlocked.clear();
    this.#attentionSealWriteBlocked.clear();
    this.#deliveryWriteBlockedAt.clear();
    this.#uncommittedDeliveryFailureEpochs.clear();
    this.#demandedRoots.clear();
    this.#demandersByKey.clear();
    this.#pieceRootByDemandKey.clear();
    this.#keysByRootId.clear();
    this.#keysByResolvedRoot.clear();
    if (this.#demandWakeTimer !== undefined) {
      clearTimeout(this.#demandWakeTimer);
      this.#demandWakeTimer = undefined;
    }
    this.#pendingDemandWake = false;
    // MINOR-2: fold any demand-root delta since the last pass BEFORE the
    // runtime (and its counters) are disposed below, so a transition after
    // the final pass of this tenure is not lost.
    this.#foldDemandRootDelta();
    // MINOR-7: the settle-attribution state is per-tenure — an input
    // admitted in one tenure and covered in the next would otherwise
    // record a `ms` spanning the park, and a growth wake right after
    // reactivation would attribute to the pre-park input. Clear it so
    // settle timings never cross a park boundary (stats honesty).
    this.#pendingSettles.clear();
    this.#lastCovered = undefined;
    this.#growthAwaitingLanding = false;
    this.#pendingStructureLoads.clear();
    this.#structureLoadPass = undefined;
    this.#structureLoadChangedDocs = undefined;
    this.#terminalStructureLoads.clear();
    this.#rearmedAwaitingSettle.clear();
    this.#pendingStructureRetryWake = false;
    // Phase 5: foreign engine resolutions die with the tenure (a
    // re-activation re-resolves; the map must not outlive engines the
    // server may close meanwhile).
    this.#foreignEngines.clear();
    const wave = this.#currentWave;
    this.#currentWave = undefined;
    await this.#sealChain;
    wave?.abandon(`parked: ${reason}`);
    // Stage G: an abandoned wave's deferred effects are DISCARDED with
    // it — the runtime below is disposed, so this is the
    // crash-equivalent path §4/§6 already cover (the effect re-misses
    // from memo keys on re-activation). In-flight effect work is not
    // awaited (park never awaits the network); its writebacks fail
    // against the disposed runtime and are caught by the builtins.
    for (const batches of this.#pendingEffectsByWave.values()) {
      for (const batch of batches) {
        abandonRunnerAcceptanceEffects(batch.effects, reason);
      }
    }
    this.#pendingEffectsByWave.clear();
    // Phase 6: wake budget-held dispatches into the closed check so
    // they DROP (the crash-equivalent path) instead of firing network
    // work for a dead runtime after re-activation rebuilt the outbox.
    this.#outbox?.close();
    this.#outbox = undefined;
    try {
      if (this.#runtime !== undefined) {
        this.#runtime.asyncWorkObserver = undefined;
        this.#runtime.effectMemoObserver = undefined;
        this.#runtime.connectedSessionProbe = undefined;
        this.#runtime.notifyServedIntentSealFailure = undefined;
        this.#runtime.pieceStartCommitFailureObserver = undefined;
        this.#runtime.servingYieldObserver = undefined;
        this.#runtime.storageManager.loadRecoveryObserver = undefined;
        // The shadow-flip wake dies with the tenure (a late flip on a
        // disposing replica must not poke a parked loop's stale wait).
        this.#runtime.storageManager.open(this.#options.space).replica
          .shadowFlipObserver = undefined;
      }
      this.#runtime?.clearSealDestination();
    } catch (error) {
      logger.warn("park-runtime-cleanup-failed", () => [
        "runtime observer cleanup during park failed",
        error,
      ]);
    }
    try {
      await this.#disposeRuntimeTimeboxed(reason);
    } catch (error) {
      logger.warn("park-dispose-failed", () => [
        "runtime dispose during park failed",
        error,
      ]);
    }
    this.#runtime = undefined;
    this.#disposeRuntime = undefined;
    try {
      this.#lease?.release();
    } catch (error) {
      // The row expires by TTL either way; what the park owes the host
      // is its completion below, which a throw here must not skip.
      logger.warn("park-release-failed", () => [
        `space ${this.#options.space}: releasing the lease during park ` +
        `(${reason}) failed`,
        error,
      ]);
    }
    this.#lease = undefined;
    logger.info?.("parked", () => [
      `space ${this.#options.space} parked (${reason})`,
    ]);
    this.#options.onParked?.(reason);
    this.#parked.resolve();
  }
}
