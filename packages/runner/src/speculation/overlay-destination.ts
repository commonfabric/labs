// The client speculation overlay (server-execution v2 Phase 2;
// speculation.md is normative). Under EXPERIMENTAL_SERVER_EXECUTION a
// NON-serving runtime — every client, and any server-side utility
// runtime that is not the space's SpaceServer — loses its
// derivation-commit path BY CONSTRUCTION: the runtime's default seal
// destination is this overlay, so a stamped derivation-kind run's
// writes are REDIRECTED into the replica's optimistic pending layer
// (`sealNative` with a speculation verdict) instead of a storage
// commit. There is no client code path from a derivation run to the
// wire, and none that could construct a `derived`-class commit
// (protocol.md §1's FORBIDDEN clause holds structurally).
//
// What stays on today's commit path, exactly (the plan's Phase 3
// interim postures row — F10's handler interim ENDED with events-down,
// events.md §7):
// - bookkeeping runs (the client-side pattern swap's pointer write is
//   an ordinary authored input);
// - UNSTAMPED transactions — UI-binding writes, imperative edits, and
//   the event-append commit itself (the fire's one authored act,
//   events.md §1) are state authorship under existing ACL + CAS
//   (README §3.6), and they never pass through the scheduler's
//   stamping choke points.
//
// Event-HANDLER runs divert here exactly like derivation runs since
// Phase 3 (D-v2-1): the handler's writes are the speculative ECHO
// (speculation.md §2), tagged with the fired event's id so the echo
// retires when the authoritative consequences (or the dropped-event
// notice) arrive (speculation.md §4 step 2; the watermark sweep is the
// backstop). The client handler-write COMMIT path is deleted — there
// is no code path from a handler run to the wire (events.md §7).
//
// The overlay is process-memory only (speculation.md §1): entries are
// never serialized, never synced, never committed, and they stay OUT
// of the client's `synced()` durability barrier. Reads see them
// through the replica's ordinary pending materialization, so rendering
// and downstream speculation read one code path. Reconciliation
// (speculation.md §4) is watermark-driven: when the space's replicated
// watermark doc covers an entry's read basis — and no unpromoted
// authored origin still underlies it (the "acked AND W ≥ seq" rule,
// evaluated on replica state) — the entry retires via a
// SUCCESS-shaped withdrawal (`superseded`), the authoritative value
// replaces the echo in the same render path, and nothing cascades.
//
// Retirement TRIGGERS (speculation.md §4; stage C tuning T2): the sweep
// runs from the watermark-doc sink, the origin-ack observer, chained
// settlements, the post-seal microtask — and, since stage C, from the
// replica's ARRIVAL observer: a frame that moves the confirmed seq of a
// doc some entry WROTE re-sweeps at once. Before that wake, "a served node
// retires the moment its derived value arrives" held only because the
// derived doc and the covering watermark advance rode ONE frame; an
// EXHAUSTED wave carries no watermark movement (its derivedThrough is
// frozen — serving-loop.md §3), so its derived values arrive DECOUPLED
// from W and an entry whose floor W already covered stood until the next
// watermark event. With the honest flush deadline (T3) that is the
// ROUTINE shape of a busy wave, which is what the wake closes. The gate
// itself is unchanged — the arrival is a second, earlier TRIGGER, never a
// relaxation of the coverage or arrival predicates. Its soundness
// argument: the sweep's predicates are evaluated afresh on replica state
// at every trigger, so an extra trigger can only retire an entry the gate
// would have retired at the next watermark event anyway; the arrival of
// the authoritative value IS the landing the gate waits for. (The
// attribution's 48-s lockdown-chip stall itself is a DIFFERENT entry —
// a late event echo whose floor sits ABOVE every reachable W; see the
// late-echo rule at `#sealSpeculative`. Its mechanism is inferred from
// the red runs' evidence — no prompt echo, a worker busy for 8.7–12 s —
// not witnessed by a client trace.)
//
// Post-commit effects of a speculative run follow the egress rule
// (README §1): "speculate on anything you can throw away; never on
// anything you can't take back." Reversible, client-enacted effects —
// exactly the `navigateTo` kind today (optimistic enactment,
// speculation.md §2) — still flush; every other kind (external-sink
// egress, sqlite issue) is OWNED AND DROPPED, so an effectful builtin
// reached by speculation renders its pending state and reads through
// to the last committed result while only the server performs egress
// (README §3.5).

import { getLogger } from "@commonfabric/utils/logger";
import {
  type CellScope,
  type DeliveryAttention,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type StreamEventEntry,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import type { PostCommitSideEffect } from "../cfc/types.ts";
import { CoalescedDocListener } from "./doc-notification-listener.ts";

const logger = getLogger("speculation-overlay", {
  enabled: true,
  level: "warn",
});

/**
 * The client-side run stamp (the speculation twin of the wave run
 * context). Kept in its OWN WeakMap so `waveRunContextOf` remains a
 * server-only signal: builtins and tests that ask "am I a served run?"
 * must not start seeing client speculation runs as served.
 */
const speculationRunContexts = new WeakMap<object, ServerRunInfo>();

export const stampSpeculationRunContext = (
  tx: IExtendedStorageTransaction,
  info: ServerRunInfo,
): void => {
  speculationRunContexts.set(tx, info);
};

export const speculationRunContextOf = (
  tx: IExtendedStorageTransaction,
): ServerRunInfo | undefined => {
  // Wrappers preserve the run's context; a stamp on a nearer wrapper takes
  // precedence, as it does for the serving side's waveRunContextOf.
  let current: IExtendedStorageTransaction | undefined = tx;
  while (current !== undefined) {
    const context = speculationRunContexts.get(current);
    if (context !== undefined) return context;
    current = (current as {
      wrappedTransaction?: IExtendedStorageTransaction;
    }).wrappedTransaction;
  }
  return undefined;
};

/** The one effect kind a speculative run may still enact: reversible,
 * client-enacted navigation (speculation.md §2's optimistic navigate;
 * protocol.md §5 owns the eventual nonce channel). Every other kind is
 * dropped under speculation — a NEW reversible kind must be added here
 * deliberately, with its spec edit (protocol.md §5's FORBIDDEN list),
 * never by default. */
const SPECULATION_ENACTABLE_EFFECT_KINDS = new Set(["navigateTo"]);

/** A terminal event-intent outcome the client is SIGNALED about
 * (events.md §5): dropped (the conflicting-discharge notice), errored
 * (the handler threw server-side — the error is the consequence), or
 * refused (deterministic admission refusal at discharge). */
export type EventIntentOutcome = {
  space: MemorySpace;
  eventId: string;
  seq?: number;
  sidecarId?: string;
  kind: "dropped" | "errored" | "refused" | "needs-attention";
  retryable?: boolean;
  reason: string;
  attention?: DeliveryAttention;
};

/** A fired intent's terminal consequence, as awaited by the send
 * path's durable-ack coupling (verdict blocker, 2026-08-12):
 * `consequenced` is the SUCCESS arm (the authoritative server handling
 * committed — signaled by the consequence mark, or by watermark-sweep
 * coverage, the same two signals that retire the echo); the other
 * three mirror EventIntentOutcome. `unsettled` reports a teardown
 * before any signal (runtime dispose). */
export type IntentConsequence = {
  kind:
    | "consequenced"
    | "errored"
    | "dropped"
    | "refused"
    | "needs-attention"
    | "unsettled";
  reason?: string;
  attention?: DeliveryAttention;
};

type OverlayEntry = {
  space: MemorySpace;
  localSeq: number;
  resolveVerdict: (verdict: SealedCommitVerdict) => void;

  /** The highest confirmed store seq this run's reads sat on — the
   * watermark threshold at which the authoritative derivation covers
   * everything this speculation consumed. */
  confirmedFloor: number;

  /** Docs this run read through PENDING (unpromoted) layers: unacked
   * authored origins (the user mid-typing), parked promotions, or
   * earlier speculation entries. The entry stays alive while any
   * UNACKED pending layer BELOW it remains on one of these docs
   * (speculation.md §4 step 3's keep-the-live-echo rule — an ACKED
   * layer whose promotion is merely parked no longer blocks: the wave
   * consumed the origin, so the authoritative coverage is real). */
  pendingReadDocs: Array<{ id: URI; scope?: CellScope }>;

  /** The localSeqs of the pending layers this run read through — its
   * ORIGINS. Retirement needs each origin ACKED with `W >= ackSeq`
   * (speculation.md §4 step 3); an origin that never acks (a retired
   * lower speculation, a rejected input) contributes no floor — the
   * store won upstream and the confirmed basis governs. */
  originLocalSeqs: number[];

  /** The doc instances this run WROTE (speculation.md §4's arrival-gated
   * retirement, RULED 2026-08-16): the entry retires only once every one
   * of them holds a CONFIRMED value at seq ≥ the entry's floor — the
   * authoritative derivation for the instance this client reads has
   * ARRIVED — not on watermark coverage of the basis alone. Coverage
   * without arrival is exactly the retire-to-nothing loop (OW32): the
   * echo dropped to nothing, the writer (subscribed to its own output
   * through the scope-narrowing write path) re-derived, re-speculated,
   * retired, forever, whenever the server never served THIS instance
   * (a per-user node the demand walk did not reach; a served node's
   * first wave not yet landed at boot). Empty for a run that sealed no
   * document ops — such an entry retires on coverage as before. */
  writtenDocs: Array<{
    id: URI;
    scope?: CellScope;

    /** Whether the run's op on the doc is a whole-doc set/delete (the
     * supersede-by-newer rider may drop an OLDER entry's layer under it
     * invisibly) or a patch (path-relative — never dropped under). */
    wholeDoc: boolean;
  }>;

  /** The scheduler action whose run sealed this entry (the writer), for
   * the supersede-by-newer rider: a NEWER entry of the same writer whose
   * whole-doc ops cover every doc of an older entry retires the older one
   * (the drop of a lower layer under an upper whole-doc layer is
   * invisible — no flip), bounding entry growth for a never-served
   * instance that keeps changing. */
  sourceAction?: object;

  /** Resolves when the entry's verdict has been APPLIED (pending
   * dropped). Retirement chains a re-sweep on it: a chained entry
   * blocked on this one unblocks only after the drop, which is async
   * relative to the verdict — and on a quiet space no further
   * watermark event would re-sweep. */
  settled: Promise<unknown>;

  /** origin `intent(eventId)` (speculation.md §1): set on event-handler
   * echoes — the fired event's durable id. `retireIntent` withdraws by
   * it when the authoritative consequences (or the dropped-event
   * notice) arrive (speculation.md §4 step 2); the watermark sweep
   * stays the backstop. */
  eventId?: string;

  /** The emitting run's event id for a CLIENT CASCADE child's echo (the
   * speculation run context's `parentEventId`, threaded by cell.ts's
   * plain `queueEvent` for a send from within a speculation-stamped
   * handler run — stage C W2.1). Such an entry's own `eventId` is a
   * client-minted cascade id (`mintEventId(link, originTx)`) that no
   * durable stream entry ever carries — the server's own run of the
   * parent mints its OWN id for the same cascade — so no consequence
   * mark, no watermark, and no arrival can ever name it: `retireIntent`
   * of an ancestor is the one signal that retires it. Undefined on a
   * root fire's echo (a tracked intent) and on derivation echoes. */
  parentEventId?: string;
};

/**
 * The overlay destination: one per non-serving Runtime under the flag,
 * created lazily by `Runtime.edit()` and consulted for every
 * transaction the runtime mints while no wave destination is installed.
 */
export class SpeculationOverlayDestination
  implements TransactionSealDestination {
  readonly #runtime: Runtime;

  /** space -> localSeq -> entry. */
  readonly #entries = new Map<MemorySpace, Map<number, OverlayEntry>>();

  /** space -> cancel fn for the watermark-doc sink driving retirement. */
  readonly #watermarkSinks = new Map<MemorySpace, () => void>();

  /** space -> release fn for the origin-accept wake installed on the
   * replica (speculation.md §4; leg-C 2026-08-13): a sweep that ran
   * while an origin's verdict was in flight skipped its entries as
   * blocked, and the covering watermark event has already passed — the
   * ack wake re-sweeps so a then-quiet space cannot strand them. */
  readonly #ackObserverReleases = new Map<MemorySpace, () => void>();

  /** space -> release fn for the ARRIVAL wake installed on the replica
   * (ISpaceReplica.speculationArrivalObserver; stage C tuning T2): a
   * frame that moves the confirmed seq of a doc some entry wrote
   * re-sweeps the space. */
  readonly #arrivalObserverReleases = new Map<MemorySpace, () => void>();

  /** Intents whose TERMINAL consequence this overlay has observed
   * (consequenced / errored / dropped / refused), keyed by eventId (a
   * per-fire mint — event-identity.ts — unique across spaces), bounded and
   * insertion-ordered (oldest pruned). Stage C tuning T2's
   * LATE-ECHO rule reads it at seal: an event-handler echo whose intent is
   * already terminal has no job — the authoritative consequences exist
   * (speculation.md §4 step 2) — and is not registered. */
  readonly #terminalIntents = new Set<string>();

  static readonly #MAX_TERMINAL_INTENTS = 4096;

  /** The client cascade THREAD (stage C W2.1): cascade child eventId →
   * its emitter's eventId, recorded at the seal of every event-handler
   * echo that carries a `parentEventId` — with or without writes, so a
   * "router" child that only forwards (no entry of its own) still links
   * its grandchildren to the root intent. Process-local, bounded and
   * insertion-ordered like `#terminalIntents` (oldest pruned); never
   * persisted, never sent, never a dependency on history: it is read
   * only at `retireIntent` to walk a live entry's ancestry to the intent
   * whose terminal consequence just arrived. A link is needed only for
   * the round trip between a cascade's seal and its root's consequence. */
  readonly #cascadeParents = new Map<string, string>();

  /** Walk cap for the ancestry walk — ids are fresh per attempt, so no
   * cycle exists; the cap only bounds a pathological depth. */
  static readonly #MAX_CASCADE_DEPTH = 64;

  /** Transactions dropped as late echoes: `deferSealedEffects` owns and
   * DROPS their enactable effects too (the closed-overlay arm's shape) —
   * an optimistic navigation for a run whose writes were discarded must
   * not enact. */
  readonly #droppedLateEchoTxs = new WeakSet<object>();

  /** DIAGNOSTIC counter (tests): sweeps the ARRIVAL wake ran. */
  #arrivalSweeps = 0;

  /** DIAGNOSTIC counter (tests): late echoes dropped at seal. */
  #lateEchoDrops = 0;

  /** Stage C W2.1: cascade-child echoes retired because an ANCESTOR
   * intent's terminal consequence arrived (`retireIntent` walked the
   * cascade thread to them). */
  #cascadeEchoRetirements = 0;

  /** The subset of those retired while NO doc they wrote had yet moved
   * past their read basis in the replica — the flicker witness; see
   * `cascadeEchoRetirementUnarrivedCount` for the heuristic it uses. */
  #cascadeEchoRetirementsUnarrived = 0;

  /** F6 telemetry (combined review 2026-08-19): one of the two
   * silent-strand distinguishers, counting `#cascadeParents` evictions
   * at the 4096 bound. Either distinguisher makes a live descendant read
   * as "no ancestor" — the walk gives up and the entry strands exactly
   * like the pre-W2.1 posture, with nothing else to see. Zero in every
   * expected workload; nonzero is the signal to look. */
  #cascadeThreadEvictions = 0;

  /** The other silent-strand distinguisher: an ancestry walk stopped at
   * the 64-hop depth cap with chain remaining. */
  #cascadeWalkDepthCaps = 0;

  /** space -> last observed watermark (for registration-time sweeps). */
  readonly #watermarks = new Map<MemorySpace, number>();

  /** Fired-intent notice watch (events.md §5, speculation.md §4 step 2,
   * §5): space -> sidecarId -> eventIds awaiting their consequence
   * signal — the OUTSTANDING set, which is the spec's own bound (§5:
   * "overlay memory is bounded by pending-intent count"). Never
   * persisted, never sent, drains to zero: not a processed-events table
   * (events.md §4). */
  readonly #trackedIntents = new Map<
    MemorySpace,
    Map<string, Set<string>>
  >();

  /** The intent LISTENER (server-execution v2 stage C design (e), RULED
   * 2026-08-18): ONE non-reactive storage-notification subscription per
   * overlay, installed by `trackIntent` while any intent is outstanding
   * and released when the set empties (or on close). It replaces the
   * schema-less whole-sidecar `cell.sink` — a scheduler effect that
   * re-read every entry (following payload links) and paid the CFC
   * probe over that read set on EVERY sidecar change, O(entries²) per
   * change (the attribution's dominant client term). Per notification:
   * O(changes) map lookups; per check: O(outstanding + hinted indices),
   * one raw replica read, ZERO transactions, ZERO probes, ZERO scheduler
   * runs, no demand edge. */
  #intentListener: CoalescedDocListener | undefined;

  /** space\0sidecarId -> per-sidecar check state: entry-index HINTS the
   * differential's leaf paths named since the last check (a mark on
   * entry i arrives as `["value","entries","<i>","consequenced"]`),
   * VERIFIED against the entry's eventId at check time — an index can
   * move (a re-append lands behind concurrent entries; compaction, when
   * built, shifts the tail down), so a hint is never trusted unread. */
  readonly #intentSidecarStates = new Map<string, { hints: Set<number> }>();

  /** DIAGNOSTIC counter (tests): intent checks run. The `commonfabric.*`
   * surface reads no counter here; it reads the logger keys —
   * `speculation-overlay/intent-*`. */
  #intentCheckCount = 0;

  /** DIAGNOSTIC counter (tests): sidecar entries visited across all
   * checks. */
  #intentCheckVisits = 0;

  /** DIAGNOSTIC counter (tests): the largest single check's visit
   * count. */
  #intentCheckMaxVisits = 0;

  /** DIAGNOSTIC counter (tests): times the intent listener was
   * installed. */
  #intentListenerInstalls = 0;

  /** Subscribers to terminal intent outcomes — the events.md §5 "the
   * client MUST be signaled so the UI can react" hook. */
  readonly #intentOutcomeSubscribers = new Set<
    (outcome: EventIntentOutcome) => void
  >();

  /** Per-intent consequence waiters (verdict blocker, 2026-08-12): the
   * send path's durable-ack coupling awaits an intent's TERMINAL
   * consequence — consequenced (server handling committed), errored,
   * dropped, or refused — so a caller's commit callback can no longer
   * report the speculative local run as durable success. Memoized
   * until consumed: the consequence may land before the waiter
   * registers. */
  readonly #intentConsequenceWaiters = new Map<
    string,
    Array<(outcome: IntentConsequence) => void>
  >();

  readonly #intentConsequenceMemo = new Map<string, IntentConsequence>();

  /** Resolvers parked by `waitForIntentQuiescence`, flushed by the same
   * untrack step that empties the outstanding-intent set (and by close). */
  #intentQuiescenceWaiters: Array<() => void> = [];

  #closed = false;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** DIAGNOSTIC (tests): live overlay entries for a space. */
  entryCount(space: MemorySpace): number {
    return this.#entries.get(space)?.size ?? 0;
  }

  /** DIAGNOSTIC (tests): await every live overlay entry in `space`
   * settling, including entries registered while the wait is in flight.
   * Event-driven: each pass sleeps on the entries' own settlement
   * promises and rechecks after they resolve, rather than polling
   * `entryCount`. Resolves immediately when the space is already empty
   * and when the overlay closes. */
  async waitForSpaceQuiescence(space: MemorySpace): Promise<void> {
    while (!this.#closed) {
      const entries = this.#entries.get(space);
      if (entries === undefined || entries.size === 0) return;
      await Promise.all([...entries.values()].map((entry) => entry.settled));
    }
  }

  /** DIAGNOSTIC (tests): cumulative EVENT-HANDLER-kind seals this
   * overlay diverted — never decremented by retirement, so it
   * witnesses transient echoes deterministically. The Phase-4
   * receipt-race pin (independent review MINOR-3) counts on it: a
   * navigate-bearing fire's client half diverts exactly TWO
   * event-handler seals (the handler echo + the navigate-deferred
   * start), and a neutralized divert drops the second — the
   * authored-commit assert alone cannot see that, because the
   * neutralized start's authored commit usually LOSES its create-only
   * race to the serving side and vanishes whole. */
  #eventEchoSeals = 0;

  get eventEchoSealCount(): number {
    return this.#eventEchoSeals;
  }

  /** DIAGNOSTIC (tests): sweeps the ARRIVAL wake ran (stage C tuning T2). */
  get arrivalSweepCount(): number {
    return this.#arrivalSweeps;
  }

  /** DIAGNOSTIC (tests): event-handler echoes dropped at seal because
   * their intent was already terminal (stage C tuning T2's late-echo
   * rule). */
  get lateEchoDropCount(): number {
    return this.#lateEchoDrops;
  }

  /** DIAGNOSTIC (tests): client cascade-child echoes retired by an
   * ANCESTOR intent's terminal consequence (stage C W2.1 — the cascade
   * arm of `retireIntent`). */
  get cascadeEchoRetirementCount(): number {
    return this.#cascadeEchoRetirements;
  }

  /** DIAGNOSTIC (tests): the subset of `cascadeEchoRetirementCount`
   * retired on a CONSEQUENCED parent's mark while NO doc the echo wrote
   * held a confirmed value at or after the mark frame's seq — the
   * FLICKER witness: the server's cascade child had not landed at this
   * client when its echo went (the purged-LT1-leftover shape, W3's α1:
   * the child is drained a wave after its parent's consequence; or, pre-
   * α, the leftover run in-process a wave late). A heuristic, stated:
   * an unchanged authoritative value (equality cutoff — no seq move)
   * reads as unarrived; a foreign write to a written doc landing in the
   * mark's own frame at or after the mark reads as arrived. Not counted
   * (unknown) when the parent dropped / erred / was refused — no cascade
   * child is coming, the removal is final — or when the replica view is
   * unavailable. */
  get cascadeEchoRetirementUnarrivedCount(): number {
    return this.#cascadeEchoRetirementsUnarrived;
  }

  /** DIAGNOSTIC (tests): cascade thread links evicted at the 4096
   * bound (combined review 2026-08-19, F6) — nonzero means ancestry
   * walks may have been silently truncated (descendants of a terminal
   * root can strand with no other telemetry). */
  get cascadeThreadEvictionCount(): number {
    return this.#cascadeThreadEvictions;
  }

  /** DIAGNOSTIC (tests): ancestry walks stopped at the 64-hop depth
   * cap with chain remaining (combined review 2026-08-19, F6) — the
   * depth-cap sibling of `cascadeThreadEvictionCount`. */
  get cascadeWalkDepthCapCount(): number {
    return this.#cascadeWalkDepthCaps;
  }

  /** DIAGNOSTIC (tests): intents outstanding across every space — the
   * `pendingIntents` gauge (design (e) §3.3 point 7). */
  get pendingIntentCount(): number {
    let count = 0;
    for (const bySidecar of this.#trackedIntents.values()) {
      for (const ids of bySidecar.values()) count += ids.size;
    }
    return count;
  }

  /** DIAGNOSTIC (tests): whether the intent listener is subscribed. */
  get intentListenerInstalled(): boolean {
    return this.#intentListener?.installed === true;
  }

  /** DIAGNOSTIC (tests): times the intent listener was installed. */
  get intentListenerInstallCount(): number {
    return this.#intentListenerInstalls;
  }

  /** DIAGNOSTIC (tests): intent checks run (immediate + notified). */
  get intentCheckCount(): number {
    return this.#intentCheckCount;
  }

  /** DIAGNOSTIC (tests): sidecar entries VISITED across all checks — the
   * `sidecarEntriesRead` witness (design pin 5): O(outstanding + hints)
   * per notified check, never O(history). (The immediate check at
   * `trackIntent` may walk the raw array once when it finds no entry
   * for a fresh id — a plain JS array walk, no transaction, microseconds;
   * `intentCheckMaxVisits` reports it.) */
  get intentCheckVisits(): number {
    return this.#intentCheckVisits;
  }

  /** DIAGNOSTIC (tests): the largest single check's visit count. */
  get intentCheckMaxVisits(): number {
    return this.#intentCheckMaxVisits;
  }

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    const kind = speculationRunContextOf(tx)?.kind;
    if (kind !== "derivation" && kind !== "event-handler") {
      // Bookkeeping runs and unstamped transactions commit exactly as
      // today. Scheduler-stamped runs — derivations since Phase 2,
      // event handlers since Phase 3 (events.md §7: the F10 interim's
      // handler-write commit path is DELETED) — divert below.
      return tx.tx.commit();
    }
    return this.#sealSpeculative(tx);
  }

  async #sealSpeculative(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    if (speculationRunContextOf(tx)?.kind === "event-handler") {
      this.#eventEchoSeals += 1;
    }
    if (this.#closed) {
      // A late derivation on a disposing runtime: nothing to render
      // into; drop the writes (the run's results are re-derivable by
      // construction).
      return { ok: {} };
    }
    const context = speculationRunContextOf(tx);
    // An event-handler-kind seal WITHOUT an eventId is refused LOUDLY
    // (review 2026-08-11 m5): such an entry has no intent to retire
    // against — no consequence signal will ever arrive for it — so the
    // divert would report ok while the write lands nowhere and no
    // server run reproduces it (silent loss). The one producer today
    // is llm-dialog's updateArgument (OW16's handler-class stamp with
    // no event); its full event-routing is owed — see
    // verification-coverage.md's owed register.
    if (context?.kind === "event-handler" && context.eventId === undefined) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "speculative event-handler seal refused: the run " +
            "carries no eventId, so the overlay entry could never " +
            "intent-retire and the write would be silently lost — an " +
            "event-handler-class client commit needs event routing " +
            "(events.md §5; speculation.md §5)",
          reason: new Error("speculation-event-handler-without-event"),
        },
      };
    }
    // The cascade THREAD (stage C W2.1): link a cascade child's id to its
    // emitter's BEFORE any arm below decides its fate — a child that
    // writes nothing (no entry) or is dropped late still threads its own
    // children to the root intent, so `retireIntent` of that root walks
    // through it.
    if (
      context?.kind === "event-handler" && context.eventId !== undefined &&
      context.parentEventId !== undefined
    ) {
      this.#noteCascadeParent(context.eventId, context.parentEventId);
    }
    // The LATE-ECHO rule (stage C tuning T2; speculation.md §4 step 2
    // read as the state it names): an event-handler echo whose intent's
    // TERMINAL consequence has ALREADY arrived — the client's local
    // dispatch ran after the served round trip (a load-parked head event,
    // a busy worker) — has no job: the authoritative consequences (or the
    // dropped/refused notice) exist, which is exactly the condition under
    // which `retireIntent` withdraws such an echo the moment the mark
    // arrives. Ordering alone made the difference: the mark was consumed
    // before this echo existed, so nothing would ever retire it, and a
    // NON-IDEMPOTENT handler run over the already-served state is
    // divergent by construction (the lockdown toggle read the served
    // `everyoneIsAdmin=false` and toggled it BACK; #5969's castVote echo,
    // the same). Such an entry's floor also sits at the served commit's
    // seq — above every W reachable until the next authored input — so it
    // stood indefinitely, hiding the served value (the attribution's E2:
    // 48 s until an unrelated draft lifted W). Disposition: the run's
    // writes are DROPPED before any layer is sealed (the closed-overlay
    // arm's shape — the results are re-derivable, and here already
    // derived authoritatively); the seal reports ok so the scheduler's
    // run completes normally. Same-tick soundness: an intent is terminal
    // only through a store signal or an admission refusal, both of which
    // this overlay recorded before this seal ran.
    // The rule reaches the late echo's CASCADE too (self-review finding
    // 2): a send from inside the late run queues a client cascade child
    // under a MINTED id (never an intent, never terminal) whose echo
    // would seal over served state, register, and stand with the same
    // floor-above-W shape — the parent's `parentEventId` names the
    // jobless intent, and the dropped run's own id joins the set so
    // grandchildren fold in. The server's authoritative run of the intent
    // produced (or produces, in later waves) the durable cascade; the
    // client's late copies have no job at any depth. "At any depth" is
    // literal (combined review 2026-08-19, F1): the check walks the
    // WHOLE `parentEventId` chain through `#cascadeParents`, not just
    // the direct parent — a SILENT (write-less) forwarder child has no
    // entry, is never retired, and never joins the jobless set, so a
    // one-level check let its LATE grandchild register after the root's
    // mark and strand forever (no mark of its own ever comes; its
    // client-derived entity doc is never written by the server, so the
    // sweep's arrival gate never passes).
    if (
      context?.kind === "event-handler" && context.eventId !== undefined &&
      this.#joblessByAncestry(context.eventId, context.parentEventId)
    ) {
      this.#noteJoblessIntent(context.eventId);
      this.#droppedLateEchoTxs.add(tx);
      this.#lateEchoDrops += 1;
      logger.debug("late-echo-dropped", () => [
        `late event echo ${context.eventId} dropped at seal: its intent ` +
        "(or its cascade parent's) already reached a terminal " +
        "consequence (speculation.md §4 step 2)",
      ]);
      return { ok: {} };
    }
    const inner = tx.tx;
    if (
      inner.sealInto === undefined ||
      inner.markWholeDocumentWrites === undefined
    ) {
      // Fail CLOSED: a transport without seal support must not fall
      // back to committing a derivation — that would re-open the
      // client derivation-commit path this destination exists to
      // remove (speculation.md §6's FORBIDDEN list). One without the
      // whole-document mark is refused on the same footing: a seal whose
      // ops were patches would compose with the layer beneath them, and
      // swallowing an unsupported mark makes that silent.
      const missing = inner.sealInto === undefined
        ? "sealing"
        : "whole-document writes (speculation.md §1)";
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "speculative derivation refused: the storage " +
            `transaction does not support ${missing}, and committing a ` +
            "derivation client-side is forbidden under " +
            "EXPERIMENTAL_SERVER_EXECUTION (speculation.md §6)",
          reason: new Error("speculation-seal-unsupported"),
        },
      };
    }
    const sealedSpaces: Array<{
      space: MemorySpace;
      entry: OverlayEntry;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = this.#runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support sealing; ` +
                "speculative derivations cannot commit (speculation.md §6)",
              reason: new Error("speculation-seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise, {
          speculative: true,
        });
        let confirmedFloor = 0;
        for (const read of sealed.commit.reads.confirmed) {
          const seq = (read as { seq?: number }).seq ?? 0;
          if (seq > confirmedFloor) confirmedFloor = seq;
        }
        const pendingDocs = new Map<string, { id: URI; scope?: CellScope }>();
        const originLocalSeqs = new Set<number>();
        for (const read of sealed.commit.reads.pending) {
          const basis = (read as { basisSeq?: number }).basisSeq ?? 0;
          if (basis > confirmedFloor) confirmedFloor = basis;
          const key = `${read.scope ?? ""}\0${read.id}`;
          if (!pendingDocs.has(key)) {
            pendingDocs.set(key, { id: read.id as URI, scope: read.scope });
          }
          const layers = (read as { localSeq?: number | number[] }).localSeq;
          if (typeof layers === "number") originLocalSeqs.add(layers);
          else if (Array.isArray(layers)) {
            for (const layer of layers) originLocalSeqs.add(layer);
          }
        }
        // The written doc instances (arrival-gated retirement): every
        // document op of the sealed commit, whole-doc or patch.
        const writtenDocs = new Map<
          string,
          { id: URI; scope?: CellScope; wholeDoc: boolean }
        >();
        for (
          const op of sealed.commit.operations as Array<
            { id?: string; scope?: CellScope; op?: string }
          >
        ) {
          if (typeof op.id !== "string") continue;
          const key = `${op.scope ?? ""}\0${op.id}`;
          const wholeDoc = op.op === "set" || op.op === "delete";
          const existing = writtenDocs.get(key);
          if (existing === undefined) {
            writtenDocs.set(key, {
              id: op.id as URI,
              scope: op.scope,
              wholeDoc,
            });
          } else if (!wholeDoc) {
            existing.wholeDoc = false;
          }
        }
        const entry: OverlayEntry = {
          space,
          localSeq: sealed.localSeq,
          resolveVerdict: resolve,
          confirmedFloor,
          pendingReadDocs: [...pendingDocs.values()],
          originLocalSeqs: [...originLocalSeqs],
          writtenDocs: [...writtenDocs.values()],
          ...(source?.sourceAction !== undefined
            ? { sourceAction: source.sourceAction }
            : {}),
          settled: sealed.settled.catch(() => undefined),
          ...(context?.kind === "event-handler" &&
              context.eventId !== undefined
            ? {
              eventId: context.eventId,
              ...(context.parentEventId !== undefined
                ? { parentEventId: context.parentEventId }
                : {}),
            }
            : {}),
        };
        sealedSpaces.push({ space, entry });
        return Promise.resolve({ ok: {} });
      },
      // Read-only-space dependencies (review thread r3739139506; stage
      // D's documented third bound): an implementation that gated
      // retirement on EACH read-only space's watermark was built and
      // REVERTED 2026-08-13 — the cross-space watermark subscriptions
      // and conservative blocking it added regressed the two-browsers
      // Phase-2 gate (bisect-verified: the gate stalls with the
      // machinery in, passes with it out). The bound therefore STANDS
      // as documented: a cross-space speculation can retire on its
      // written space's coverage while a read-only input is still
      // uncovered. `sealSpaceReads` is deliberately not implemented
      // here until a design that does not gate on foreign-space
      // watermark subscriptions exists (flagged in
      // verification-coverage.md's 2026-08-13 delta).
    };
    let result: Result<Unit, CommitError>;
    try {
      // An entry's ops say what the run computed, not how it differed from
      // the layer it ran over, because that layer moves under them
      // (speculation.md §1; IStorageTransaction.markWholeDocumentWrites).
      // Inside the same try as the seal it precedes, which refuses a
      // read-only transaction the same way.
      inner.markWholeDocumentWrites();
      result = await inner.sealInto(collector);
    } catch (cause) {
      // A REJECTED sealInto (review thread r3739139536): without the
      // catch, entries already collected kept unresolved verdicts and
      // live pending writes forever. Withdraw them and surface a
      // CommitError like any other seal failure.
      const message = cause instanceof Error ? cause.message : String(cause);
      result = {
        error: {
          name: "StorageTransactionAborted",
          message: `speculative seal rejected: ${message}`,
          reason: cause,
        },
      };
    }
    if (result.error) {
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: `speculative seal failed: ${result.error.message}`,
          },
        });
      }
      return result;
    }
    if (this.#closed) {
      // The dispose race (review thread r3739139501): close() ran while
      // sealInto was in flight, so registering now would RESURRECT
      // entries close() can no longer withdraw (and their effects could
      // still enact). Same disposition as the early-closed arm: the
      // writes roll back (best-effort — the replica may be closing) and
      // the seal reports success (the run's results are re-derivable).
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      }
      return { ok: {} };
    }
    if (
      context?.kind === "event-handler" && context.eventId !== undefined &&
      this.#joblessByAncestry(context.eventId, context.parentEventId)
    ) {
      // The late-echo rule's post-await re-check (self-review finding 5,
      // the closed arm's shape): the terminal signal landed while
      // `sealInto` was in flight — `retireIntent` ran before this entry
      // existed, so registering now would strand exactly the echo the
      // rule closes. Withdraw the collected entries; the seal reports ok.
      // Walks the whole thread like the pre-seal check (combined review
      // 2026-08-19, F1): a mark landing mid-seal for a grandchild of a
      // SILENT child is caught only through the chain.
      this.#noteJoblessIntent(context.eventId);
      this.#droppedLateEchoTxs.add(tx);
      this.#lateEchoDrops += 1;
      for (const { entry } of sealedSpaces) {
        entry.resolveVerdict({
          withdrawn: {
            message: "late event echo withdrawn at seal: its intent " +
              "reached a terminal consequence while sealing " +
              "(speculation.md §4 step 2)",
            superseded: true,
          },
        });
      }
      return { ok: {} };
    }
    for (const { space, entry } of sealedSpaces) {
      let entries = this.#entries.get(space);
      if (entries === undefined) {
        entries = new Map();
        this.#entries.set(space, entries);
      }
      this.#supersedeOlderEntries(entries, entry);
      entries.set(entry.localSeq, entry);
      this.#ensureWatermarkSink(space);
    }
    if (sealedSpaces.length > 0) {
      // A fresh entry may already be covered (a re-speculation after
      // retirement against state the watermark has passed): sweep once
      // off the current W, deferred a tick so the seal fully resolves
      // first.
      queueMicrotask(() => {
        for (const { space } of sealedSpaces) {
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        }
      });
    }
    return { ok: {} };
  }

  /**
   * Take ownership of a SPECULATIVE run's post-commit effects: enact
   * the reversible allowlisted kinds (navigateTo — optimistic
   * enactment), DROP everything else (the egress rule; the server's
   * authoritative run performs the real effect and its completion
   * arrives as a pushed derived commit). Non-derivation runs keep
   * today's inline flush.
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    const kind = speculationRunContextOf(tx)?.kind;
    if (kind !== "derivation" && kind !== "event-handler") {
      return false;
    }
    if (this.#closed) {
      // The dispose race's effect half (review thread r3739139501): the
      // run's writes were (or will be) dropped by the closed seal path,
      // so even the reversible allowlisted kinds must not enact — an
      // optimistic navigation for a commit that was never accepted.
      // Still OWNED (true): a derivation's effects never take the
      // ordinary inline flush.
      return true;
    }
    if (this.#droppedLateEchoTxs.has(tx)) {
      // A late echo's effects (stage C tuning T2): its writes were
      // dropped at seal, so its reversible kinds must not enact either
      // — the authoritative intent already rode (or rides) the effects
      // channel. Owned, not enacted: the closed arm's shape.
      return true;
    }
    const enactable = effects.filter((effect) =>
      SPECULATION_ENACTABLE_EFFECT_KINDS.has(effect.kind)
    );
    if (enactable.length > 0) {
      void (async () => {
        for (const effect of enactable) {
          const channel = this.#runtime.effectsChannel;
          const flush = () => Promise.resolve(effect.flush(tx));
          if (effect.nonce !== undefined && channel !== undefined) {
            // Phase 4 (protocol.md §5, T2.Q7): the channel arbitrates
            // the run's deterministic nonce in either order. It records
            // the nonce before it calls this flush — the flush awaits
            // an arbitrary (possibly slow, async) navigateCallback, and
            // the authoritative intent can arrive on the channel
            // MID-flush, where the in-flight record makes it converge
            // instead of double-navigating within one life (LT8 accepts
            // re-enactment only across a RELOAD). An intent that arrived and enacted BEFORE
            // this run sealed leaves the nonce already recorded, and
            // the flush does not run: the journey's one navigation
            // happened, and enacting here would navigate a second time
            // — to the client's own speculative target, the piece whose
            // writes this overlay dropped. The flush's OUTCOME rides
            // with the record (owner review P1-1): a FAILED flush
            // retracts it, so the durable intent re-enacts on a later
            // delivery instead of being acked-and-retired unenacted; a
            // flush that no-ops on a superseded attempt is deliberate
            // non-enactment and resolves as success — acking it is
            // correct (a newer attempt owns the navigation). The
            // channel logs a failed enactment (enact-failed).
            await channel.enactOnce(effect.nonce, flush);
            continue;
          }
          try {
            await flush();
          } catch (error) {
            logger.error(
              "speculative-enact-failed",
              "speculative post-commit enactment failed:",
              { kind: effect.kind, error },
            );
          }
        }
      })();
    }
    return true;
  }

  /**
   * Watch a fired intent's stream sidecar until its consequence signal
   * arrives (events.md §5; speculation.md §4 step 2, §5): the TRACKED
   * entry marked `consequenced` retires the echo; `status: "dropped"`
   * (the conflicting-discharge notice) or an `error` consequence retires
   * it AND signals subscribers — the UI hook the ruling requires. The
   * watch reads the VALUE plane: the tracked entry's own `consequenced`
   * / `status` / `error` fields are the SANCTIONED client-side carrier
   * of the pushed commit's `consequenceOf` (speculation.md §4 step 2,
   * RULED 2026-08-18 — T7 semantics: written as the event's consequence,
   * retiring with the entry at compaction; never a dependency on
   * HISTORY; the entry is read only for the tracked event, and for a
   * dropped event's reason). The watermark sweep stays the backstop
   * (`W ≥ seq(e)`) for signals this misses.
   *
   * Mechanism (stage C design (e), RULED 2026-08-18): (i) the sidecar is
   * kept WATCHED — the client keeps a stream subscribed while it has
   * intents outstanding on it (speculation.md §4) — through the same
   * schema-less selector `syncCell` uses; (ii) ONE storage-notification
   * listener per overlay learns THAT the sidecar changed and WHERE (the
   * differential's leaf paths); (iii) a coalesced MICROTASK check
   * re-reads the raw replica doc and locates each outstanding id by
   * verified hint, else by a backward scan from the tail. No scheduler
   * effect, no transaction, no CFC probe, no demand edge.
   */
  trackIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
  ): void {
    if (this.#closed) return;
    let bySidecar = this.#trackedIntents.get(space);
    if (bySidecar === undefined) {
      bySidecar = new Map();
      this.#trackedIntents.set(space, bySidecar);
    }
    let ids = bySidecar.get(sidecarId);
    if (ids === undefined) {
      ids = new Set();
      bySidecar.set(sidecarId, ids);
    }
    ids.add(eventId);
    const key = `${space}\0${sidecarId}`;
    if (!this.#intentSidecarStates.has(key)) {
      this.#intentSidecarStates.set(key, { hints: new Set() });
    }
    // Keep the sidecar WATCHED (contract point 2(ii)) — kicked on EVERY
    // fire, not only the first on this sidecar: a covered watch is a
    // replica no-op (the selector tracker's exact-match fast path, no
    // wire), and a watch whose first pull FAILED transiently dropped its
    // tracker entry, so the next fire re-issues it instead of leaving
    // the stream unwatched — NO frame would arrive — until the set
    // drains (independent review of W2, MIN-4; the old sink's single
    // `if (!synced) sync()` kick had the same hole).
    this.#watchIntentSidecar(space, sidecarId);
    // The IMMEDIATE raw check (design contract point 2(iii)): a
    // duplicate fire whose consequence already landed (a re-delivered
    // caller-supplied event id — round-2 thread T25) resolves HERE, and
    // the listener is installed only while ids remain tracked, so such a
    // fire leaks no subscription.
    this.#checkIntents(space, sidecarId, []);
    if (this.#trackedIntents.size > 0) this.#ensureIntentListener();
  }

  /** Install the ONE intent listener (contract point 2(i)) — idempotent,
   * best-effort like today's `intent-sink-failed` arm: on failure the
   * echo's retirement rides the watermark backstop only, loudly. */
  #ensureIntentListener(): void {
    if (this.#intentListener !== undefined) return;
    try {
      this.#installIntentListener();
    } catch (error) {
      logger.warn("intent-listener-failed", () => [
        "intent listener could not subscribe to storage notifications; " +
        "echo retirement for outstanding intents rides the watermark " +
        "backstop only",
        error,
      ]);
    }
  }

  /** Keep the sidecar doc watched (contract point 2(ii)) — the
   * schema-less selector `syncCell` uses for a schema-less cell (the
   * doc itself, no link following); an already-covered watch is a
   * no-op at the replica. Best-effort: on failure the echo's retirement
   * rides the watermark backstop only, loudly. */
  #watchIntentSidecar(space: MemorySpace, sidecarId: string): void {
    try {
      const pulled = this.#runtime.storageManager.open(space).sync(
        sidecarId as URI,
        { path: [], schema: false },
        "space",
      );
      Promise.resolve(pulled).then((result) => {
        if (result?.error !== undefined) {
          logger.warn("intent-watch-failed", () => [
            `intent sidecar watch for ${space} failed; echo retirement ` +
            "for its events rides the watermark backstop only",
            result.error,
          ]);
        }
      }, (error) => {
        logger.warn("intent-watch-failed", () => [
          `intent sidecar watch for ${space} failed; echo retirement ` +
          "for its events rides the watermark backstop only",
          error,
        ]);
      });
    } catch (error) {
      logger.warn("intent-watch-failed", () => [
        `intent sidecar watch for ${space} failed; echo retirement for ` +
        "its events rides the watermark backstop only",
        error,
      ]);
    }
  }

  /** `wants` is a map lookup on the outstanding set; `onNotify` runs in
   * a microtask (contract point 3) with the change paths since the last
   * dispatch, from which the entry-index hints are taken. */
  #installIntentListener(): void {
    const listener = new CoalescedDocListener(this.#runtime.storageManager, {
      // Sidecars are SPACE docs; a scoped instance of a same-named id
      // (none exists) would not be this watch's subject.
      wants: (space, id, scope) =>
        (scope === undefined || scope === "space") &&
        this.#trackedIntents.get(space)?.has(id) === true,
      onNotify: (space, id, paths) => {
        if (this.#closed) return;
        if (id === undefined) {
          // A storage reset: everything tracked in the space is dirty.
          const bySidecar = this.#trackedIntents.get(space);
          if (bySidecar === undefined) return;
          for (const sidecarId of [...bySidecar.keys()]) {
            this.#checkIntents(space, sidecarId, []);
          }
          return;
        }
        const hints: number[] = [];
        for (const path of paths) {
          if (path[0] !== "value" || path[1] !== "entries") continue;
          const index = Number(path[2]);
          if (Number.isInteger(index) && index >= 0) hints.push(index);
        }
        this.#checkIntents(space, id, hints);
      },
    });
    listener.ensure();
    this.#intentListener = listener;
    this.#intentListenerInstalls += 1;
    logger.debug("intent-listener-installed", () => [
      "intent listener subscribed to storage notifications",
    ]);
  }

  /** Release the listener (contract point 5): when the outstanding set
   * empties, and on close(). No check runs after release. */
  #releaseIntentListener(): void {
    const listener = this.#intentListener;
    if (listener === undefined) return;
    this.#intentListener = undefined;
    listener.release();
    logger.debug("intent-listener-released", () => [
      "intent listener released: no intents outstanding",
    ]);
  }

  /**
   * The check (contract point 4): re-read the RAW replica doc — no
   * transaction, no query proxy — and, for each outstanding id on the
   * sidecar, locate its entry by verified hint (`entries[i].eventId ===
   * id`), else by a backward scan from the tail that stops when every
   * outstanding id is located; an id whose entry is not present stays
   * tracked (its append has not landed; the watermark backstop stands).
   * Then today's arms, in today's order (`#applyIntentEntry`).
   */
  #checkIntents(
    space: MemorySpace,
    sidecarId: string,
    hints: readonly number[],
  ): void {
    if (this.#closed) return;
    const ids = this.#trackedIntents.get(space)?.get(sidecarId);
    if (ids === undefined || ids.size === 0) return;
    const state = this.#intentSidecarStates.get(`${space}\0${sidecarId}`);
    for (const hint of hints) state?.hints.add(hint);
    let entries: unknown;
    try {
      const document = this.#runtime.storageManager.open(space).replica
        .getDocument(sidecarId as URI, "space");
      entries = (document?.value as StreamEventsDocValue | undefined)
        ?.entries;
    } catch (error) {
      logger.warn("intent-check-read-failed", () => [
        `intent check could not read the sidecar ${sidecarId} in ${space}`,
        error,
      ]);
      return;
    }
    this.#intentCheckCount += 1;
    logger.debug("intent-check", () => [
      `intent check on ${sidecarId} (${ids.size} outstanding)`,
    ]);
    if (!Array.isArray(entries)) return;
    // `pending` is this check's worklist — the ids still to LOCATE. It
    // is a snapshot, so it is NOT the authority on whether an entry is
    // still tracked: `#applyIntentEntry` calls arbitrary outcome
    // subscribers, and a subscriber that re-fires on this sidecar (the
    // retry-on-drop UI hook events.md §5 mandates) runs a nested
    // `trackIntent` → an INNER check that may retire ids this worklist
    // still holds. The old sink's scan gated on the LIVE set per entry
    // and could not double-apply; so does this — re-fetched from the
    // map, because the inner check can delete and recreate the Set
    // (independent review of W2, MAJ-1).
    const pending = new Set(ids);
    let visits = 0;
    const consider = (candidate: unknown): void => {
      visits += 1;
      if (!isObjectOrArray(candidate)) return;
      const entry = candidate as StreamEventEntry;
      if (typeof entry.eventId !== "string" || !pending.has(entry.eventId)) {
        return;
      }
      pending.delete(entry.eventId);
      const live = this.#trackedIntents.get(space)?.get(sidecarId);
      if (live === undefined || !live.has(entry.eventId)) return;
      try {
        this.#applyIntentEntry(space, sidecarId, entry);
      } catch (error) {
        // Nothing in the arms throws today (subscribers are caught in
        // `#notifyIntentOutcome`; the waiters are promise resolvers),
        // and the old sink ran inside a scheduler effect whose catch
        // logged `schedule-error`. Kept so a future regression in one
        // entry's arm cannot strand the OTHER ids of this check in a
        // microtask's uncaught throw (independent review of W2, N-2).
        logger.warn("intent-apply-failed", () => [
          `intent ${entry.eventId} on ${sidecarId}: applying its entry threw`,
          error,
        ]);
      }
    };
    if (state !== undefined && state.hints.size > 0) {
      const hinted = [...state.hints];
      state.hints.clear();
      for (const index of hinted) {
        if (pending.size === 0) break;
        if (index < entries.length) consider(entries[index]);
      }
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (pending.size === 0) break;
      consider(entries[index]);
    }
    this.#intentCheckVisits += visits;
    if (visits > this.#intentCheckMaxVisits) {
      this.#intentCheckMaxVisits = visits;
    }
  }

  /** Resolve a tracked intent WITHOUT a store signal (a refused
   * delivery): retire its echo and signal subscribers. */
  resolveIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
    outcome: { kind: "refused"; reason: string },
  ): void {
    if (this.#closed) return;
    logger.debug("intent-refused", () => [
      `intent ${eventId} refused at discharge: ${outcome.reason}`,
    ]);
    this.#untrackIntent(space, sidecarId, eventId);
    this.retireIntent(space, eventId);
    this.#settleIntentConsequence(space, eventId, {
      kind: "refused",
      reason: outcome.reason,
    });
    this.#notifyIntentOutcome({
      space,
      eventId,
      kind: outcome.kind,
      reason: outcome.reason,
    });
  }

  /** Subscribe to terminal intent outcomes (dropped server-side, errored
   * server-side, refused at admission). Returns an unsubscribe fn. */
  subscribeIntentOutcomes(
    subscriber: (outcome: EventIntentOutcome) => void,
  ): () => void {
    this.#intentOutcomeSubscribers.add(subscriber);
    return () => this.#intentOutcomeSubscribers.delete(subscriber);
  }

  /** Await a fired intent's terminal consequence (see
   * IntentConsequence). Resolves immediately when the consequence
   * already landed; on overlay close, pending waiters settle
   * `unsettled`. */
  waitForIntentConsequence(
    space: MemorySpace,
    eventId: string,
  ): Promise<IntentConsequence> {
    const key = `${space}\0${eventId}`;
    const memo = this.#intentConsequenceMemo.get(key);
    if (memo !== undefined) {
      this.#intentConsequenceMemo.delete(key);
      return Promise.resolve(memo);
    }
    if (this.#closed) return Promise.resolve({ kind: "unsettled" });
    return new Promise((resolve) => {
      const waiters = this.#intentConsequenceWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.#intentConsequenceWaiters.set(key, waiters);
    });
  }

  /** Await the outstanding-intent set EMPTYING (speculation.md §4 step 2
   * quiescence, the set `pendingIntentCount` counts): every event this
   * runtime fired has reached a terminal consequence — consequenced,
   * errored, dropped, or refused — AND that signal has arrived back
   * here. Event-driven: resolves from the same untrack step that
   * retires the last outstanding intent, immediately when nothing is
   * outstanding, and on overlay close (nothing can retire afterwards).
   * Carries no deadline of its own — a caller that needs a bound races
   * it (the multi-runtime harness's budgeted settle does). Note this is
   * a FIRST-ORDER signal, like the count it mirrors: a server-side
   * cascade child (an event a served handler itself emits) is no
   * client's intent and commits in a later wave, outside this wait. */
  waitForIntentQuiescence(): Promise<void> {
    if (this.#closed || this.pendingIntentCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#intentQuiescenceWaiters.push(resolve);
    });
  }

  #flushIntentQuiescenceWaiters(): void {
    if (this.#intentQuiescenceWaiters.length === 0) return;
    const waiters = this.#intentQuiescenceWaiters;
    this.#intentQuiescenceWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #settleIntentConsequence(
    space: MemorySpace,
    eventId: string,
    outcome: IntentConsequence,
  ): void {
    const key = `${space}\0${eventId}`;
    // The late-echo rule's memory (stage C tuning T2): every terminal
    // signal — consequenced, errored, dropped, refused — makes a later
    // echo of this intent jobless.
    this.#noteJoblessIntent(eventId);
    const waiters = this.#intentConsequenceWaiters.get(key);
    if (waiters !== undefined && waiters.length > 0) {
      this.#intentConsequenceWaiters.delete(key);
      for (const resolve of waiters) resolve(outcome);
      return;
    }
    // Nobody waiting yet: memoize the FIRST terminal signal (bounded by
    // in-flight fires; consumed by the next waiter).
    if (!this.#intentConsequenceMemo.has(key)) {
      this.#intentConsequenceMemo.set(key, outcome);
    }
  }

  /** Record an intent whose echo has no job (a terminal consequence
   * arrived, or its late echo was dropped — its cascade is jobless too).
   * Bounded like the replica's ack record (oldest pruned). */
  #noteJoblessIntent(eventId: string): void {
    this.#terminalIntents.add(eventId);
    if (
      this.#terminalIntents.size >
        SpeculationOverlayDestination.#MAX_TERMINAL_INTENTS
    ) {
      const oldest = this.#terminalIntents.values().next();
      if (!oldest.done) this.#terminalIntents.delete(oldest.value);
    }
  }

  /** Record a cascade child → emitter link (stage C W2.1; see
   * `#cascadeParents`). Bounded like the jobless set (oldest pruned).
   * An eviction is COUNTED (combined review 2026-08-19, F6): a pruned
   * link is indistinguishable from "no ancestor" at walk time, so a
   * live chain through it silently strands its descendants (the
   * pre-W2.1 posture) — hitting the bound within one intent round trip
   * takes ~4096 cascade seals (implausible; the bound is the report's
   * stated design), but if it ever happens in the wild this counter is
   * the only telemetry. */
  #noteCascadeParent(eventId: string, parentEventId: string): void {
    if (this.#cascadeParents.has(eventId)) return;
    this.#cascadeParents.set(eventId, parentEventId);
    if (
      this.#cascadeParents.size >
        SpeculationOverlayDestination.#MAX_TERMINAL_INTENTS
    ) {
      const oldest = this.#cascadeParents.keys().next();
      if (!oldest.done) {
        this.#cascadeParents.delete(oldest.value);
        this.#cascadeThreadEvictions += 1;
        logger.debug("cascade-thread-evicted", () => [
          `cascade thread link ${oldest.value} evicted at the ` +
          `${SpeculationOverlayDestination.#MAX_TERMINAL_INTENTS} bound — ` +
          "a live chain through it now reads as having no ancestor " +
          "(walks stop there; descendants of a terminal root beyond it " +
          "can strand silently)",
        ]);
      }
    }
  }

  /** A cascade ancestry walk stopped at the depth cap with chain
   * remaining (combined review 2026-08-19, F6): deeper ancestry is
   * invisible to both the retirement walk and the seal-time jobless
   * check, so descendants of a terminal root beyond the cap strand
   * silently (the pre-W2.1 posture). Counted so the cap's being hit is
   * observable at all. */
  #noteCascadeWalkDepthCapped(): void {
    this.#cascadeWalkDepthCaps += 1;
    logger.debug("cascade-walk-depth-capped", () => [
      "a cascade ancestry walk stopped at the " +
      `${SpeculationOverlayDestination.#MAX_CASCADE_DEPTH}-hop cap with ` +
      "chain remaining — deeper ancestry is invisible (descendants of " +
      "a terminal root beyond the cap can strand silently)",
    ]);
  }

  /** Whether a live entry is a client cascade DESCENDANT of `ancestor`:
   * its own `parentEventId` is the ancestor, or the thread recorded at
   * seal leads there through intermediate cascade ids (a child that
   * wrote nothing has no entry to hang the walk on — the thread does
   * not need one). */
  #cascadeReaches(entry: OverlayEntry, ancestor: string): boolean {
    let id = entry.parentEventId;
    let hops = 0;
    while (id !== undefined) {
      if (hops >= SpeculationOverlayDestination.#MAX_CASCADE_DEPTH) {
        this.#noteCascadeWalkDepthCapped();
        return false;
      }
      if (id === ancestor) return true;
      id = this.#cascadeParents.get(id);
      hops += 1;
    }
    return false;
  }

  /** Whether an event-handler seal is JOBLESS BY ANCESTRY (stage C
   * W2.1; combined review 2026-08-19, F1): its own intent — or ANY
   * cascade ancestor, walking `parentEventId` through the thread — has
   * already reached a terminal consequence. The one-level form of this
   * check (eventId or direct parent only) missed a LATE grandchild of
   * a SILENT (write-less) cascade child: the silent child has no
   * entry, is never retired, and never joins the jobless set, so the
   * grandchild sealing after the root's mark registered and stranded
   * forever. Same bounded walk as `#cascadeReaches`, on ids instead of
   * entries — the root is in `#terminalIntents` via
   * `#settleIntentConsequence`, so the chain walk finds it. */
  #joblessByAncestry(
    eventId: string,
    parentEventId: string | undefined,
  ): boolean {
    if (this.#terminalIntents.has(eventId)) return true;
    let id = parentEventId;
    let hops = 0;
    while (id !== undefined) {
      if (hops >= SpeculationOverlayDestination.#MAX_CASCADE_DEPTH) {
        this.#noteCascadeWalkDepthCapped();
        return false;
      }
      if (this.#terminalIntents.has(id)) return true;
      id = this.#cascadeParents.get(id);
      hops += 1;
    }
    return false;
  }

  #notifyIntentOutcome(outcome: EventIntentOutcome): void {
    for (const subscriber of [...this.#intentOutcomeSubscribers]) {
      try {
        subscriber(outcome);
      } catch (error) {
        logger.warn("intent-outcome-subscriber-failed", () => [
          "event intent outcome subscriber threw",
          error,
        ]);
      }
    }
  }

  /** Today's arms, in today's order, on ONE tracked entry (design
   * contract point 4): `status === "dropped"` → untrack, retire, settle
   * `dropped`, notify; else `consequenced === true` → untrack, retire,
   * settle `errored` (if `error`) or `consequenced`, notify `errored`
   * if `error`. Anything else (the entry present but not yet processed)
   * leaves the intent tracked. */
  #applyIntentEntry(
    space: MemorySpace,
    sidecarId: string,
    entry: StreamEventEntry,
  ): void {
    if (entry.status === "needs-attention" && entry.attention !== undefined) {
      const reason = entry.reason ?? "needs attention";
      this.#untrackIntent(space, sidecarId, entry.eventId);
      this.retireIntent(space, entry.eventId);
      this.#settleIntentConsequence(space, entry.eventId, {
        kind: "needs-attention",
        reason,
        attention: entry.attention,
      });
      this.#notifyIntentOutcome({
        space,
        eventId: entry.eventId,
        seq: entry.seq,
        sidecarId,
        kind: "needs-attention",
        retryable: entry.firedAt?.user !== undefined,
        reason,
        attention: entry.attention,
      });
    } else if (entry.status === "dropped") {
      // The conflicting-discharge notice (events.md §5, LT4/T7): the
      // echo un-renders instead of lingering as false state, and the
      // UI is signaled.
      logger.debug("intent-drop-notice", () => [
        `dropped-event notice for ${entry.eventId}`,
      ]);
      logger.debug("intent-retired-by-consequence-of", () => [
        `intent ${entry.eventId} resolved by its tracked entry (dropped)`,
      ]);
      this.#untrackIntent(space, sidecarId, entry.eventId);
      this.retireIntent(space, entry.eventId);
      this.#settleIntentConsequence(space, entry.eventId, {
        kind: "dropped",
        reason: entry.reason ?? "dropped",
      });
      this.#notifyIntentOutcome({
        space,
        eventId: entry.eventId,
        kind: "dropped",
        reason: entry.reason ?? "dropped",
      });
    } else if (entry.consequenced === true) {
      if (entry.error !== undefined) {
        logger.debug("intent-error-notice", () => [
          `error consequence for ${entry.eventId}`,
        ]);
      }
      logger.debug("intent-retired-by-consequence-of", () => [
        `intent ${entry.eventId} resolved by its tracked entry ` +
        `(${entry.error !== undefined ? "errored" : "consequenced"})`,
      ]);
      this.#untrackIntent(space, sidecarId, entry.eventId);
      // The flicker witness is armed ONLY for a consequenced (non-error)
      // parent: only then is a server cascade child on its way whose
      // landing the retired echo could have waited for; a dropped,
      // refused, or errored parent produced no cascade — the echo's
      // removal is final and correct, not a flicker.
      this.retireIntent(
        space,
        entry.eventId,
        entry.error === undefined ? { markSidecarId: sidecarId } : undefined,
      );
      this.#settleIntentConsequence(
        space,
        entry.eventId,
        entry.error !== undefined
          ? { kind: "errored", reason: entry.error }
          : { kind: "consequenced" },
      );
      if (entry.error !== undefined) {
        // The handler threw server-side: the error IS the consequence
        // (events.md §5) — the echo still retires, and subscribers
        // hear the error outcome.
        this.#notifyIntentOutcome({
          space,
          eventId: entry.eventId,
          kind: "errored",
          reason: entry.error,
        });
      }
    }
  }

  #untrackIntent(
    space: MemorySpace,
    sidecarId: string,
    eventId: string,
  ): void {
    const bySidecar = this.#trackedIntents.get(space);
    const ids = bySidecar?.get(sidecarId);
    if (ids === undefined) return;
    ids.delete(eventId);
    if (ids.size === 0) {
      bySidecar!.delete(sidecarId);
      this.#intentSidecarStates.delete(`${space}\0${sidecarId}`);
      if (bySidecar!.size === 0) this.#trackedIntents.delete(space);
      // The listener lives exactly as long as something is outstanding
      // (contract point 5). The sidecar WATCH stays: a session's watch
      // set is coarse by ruling (R-D), and the next fire on this stream
      // is likely imminent.
      if (this.#trackedIntents.size === 0) {
        this.#releaseIntentListener();
        this.#flushIntentQuiescenceWaiters();
      }
    }
  }

  /**
   * Retire every overlay entry whose origin is `intent(eventId)`
   * (speculation.md §4 step 2): the authoritative consequences — or the
   * dropped-event notice — now exist, so the echo's job is done. Runs
   * ahead of watermark coverage (serving-loop.md §3's sealing-order
   * guarantee: consequences ride the FIRST flush even when W lags to
   * quiescence); the watermark sweep remains the backstop for entries
   * this never reaches.
   *
   * AND every entry that is a client CASCADE DESCENDANT of that intent
   * (stage C W2.1 — the late-echo rule's jobless-cascade consequence,
   * applied on arrival): the intent's speculative run sent events whose
   * echoes sealed under client-minted cascade ids (`parentEventId` names
   * the thread). The server's authoritative run of the intent produced
   * the durable cascade under its OWN ids, so nothing will ever name the
   * client's: no mark (no tracked entry), no arrival (a cascade handler
   * that cellifies a new object writes an entity doc whose id derives
   * from the handler frame's cause — `$event: tx.dispatchedEventId`,
   * runner.ts — so the client's entity id is not the server's and the
   * sweep's arrival gate never passes). The intent's terminal consequence
   * — consequenced, errored, dropped, refused: every arm reaches here —
   * is the one signal that makes the whole cascade jobless, exactly as
   * the late-echo rule treats a cascade sealed AFTER it (W0 l3's
   * "duplicate join": spec-Alice standing beside the confirmed Alice
   * forever). Scope, precisely: ONLY entries whose thread reaches the
   * intent — client-minted cascade children of its speculative run,
   * never a durable entry of its own (a root fire's echo carries no
   * `parentEventId`; an unrelated intent's cascade does not reach it).
   * The retired child's id joins the jobless set so a LATE grandchild
   * (sealing after this) drops at seal like a late child does.
   *
   * The known cost (W2.1, flagged — the reason the owner-level
   * alternative exists): when the server's LT1 child was PURGED at the
   * flush deadline (W3's α1) and the drain delivers it a wave later, the
   * cascade echo goes at the parent's consequence while the child's own
   * consequence is still a wave away — the echo's value disappears until
   * that wave lands, a visible flicker. Counted: `cascade-echo-retired`
   * per retired cascade echo, and — when the caller arms the witness
   * with the MARK's sidecar (the consequenced, non-error arm: the one
   * case where a server cascade child is on its way) —
   * `cascade-echo-retired-unarrived` when NO doc the echo wrote holds a
   * confirmed value at or after the mark frame's seq (read as the
   * sidecar's confirmed seq at the check: the mark and a same-wave
   * child's writes commit together, so a child that rode the parent's
   * wave has moved every doc it wrote to that very seq, and a purged
   * child has moved none). A HEURISTIC, two misreadings stated on the
   * getter. Keyed on the mark's seq rather than the echo's read basis
   * on purpose: a concurrent writer (the other voter's vote, landing
   * between the echo's seal and the mark) moves the doc past the basis
   * without the child having landed — the lunch gate's own shape.
   * Keeping the echo until the child's own delivery is covered by W is
   * NOT done: the durable child entry carries no parent reference and
   * this client does not watch the child's stream, so there is nothing
   * to match the echo against (the owner-level shape is deterministic
   * cascade ids on both sides).
   */
  retireIntent(
    space: MemorySpace,
    eventId: string,
    witness?: { markSidecarId: string },
  ): void {
    const entries = this.#entries.get(space);
    if (entries === undefined) return;
    let view:
      | ((
        id: URI,
        scope?: CellScope,
      ) => { confirmedSeq: number; pendingLocalSeqs: number[] })
      | null
      | undefined;

    /** The mark frame's seq (the sidecar's confirmed seq at this check);
     * 0 = unknown → the witness does not count. */
    let markSeq: number | undefined;

    for (const entry of [...entries.values()]) {
      const own = entry.eventId === eventId;
      if (!own && !this.#cascadeReaches(entry, eventId)) continue;
      entries.delete(entry.localSeq);
      if (!own) {
        // A cascade descendant: jobless by its ancestor's consequence.
        this.#cascadeEchoRetirements += 1;
        if (entry.eventId !== undefined) this.#noteJoblessIntent(entry.eventId);
        logger.debug("cascade-echo-retired", () => [
          `cascade echo ${entry.eventId} retired: its ancestor intent ` +
          `${eventId} reached a terminal consequence (speculation.md §4 ` +
          "step 2, the jobless-cascade consequence)",
        ]);
        if (witness !== undefined) {
          if (view === undefined) {
            try {
              const replica = this.#runtime.storageManager.open(space).replica;
              view = replica.speculationRetirementView?.bind(replica) ?? null;
            } catch {
              view = null;
            }
          }
          if (markSeq === undefined) {
            markSeq = 0;
            if (view !== null) {
              try {
                markSeq = view(witness.markSidecarId as URI, "space")
                  .confirmedSeq;
              } catch {
                // a replica mid-teardown: no witness, not a failure
              }
            }
          }
          // The flicker witness: did ANY doc this echo wrote land at or
          // after the mark's frame (the server's cascade child rode the
          // parent's wave)? Unknown (no view, no seq) → not counted.
          if (view !== null && markSeq > 0 && entry.writtenDocs.length > 0) {
            let arrived = false;
            for (const doc of entry.writtenDocs) {
              try {
                if (view(doc.id, doc.scope).confirmedSeq >= markSeq) {
                  arrived = true;
                  break;
                }
              } catch {
                // a replica mid-teardown: no witness, not a failure
              }
            }
            if (!arrived) {
              this.#cascadeEchoRetirementsUnarrived += 1;
              logger.debug("cascade-echo-retired-unarrived", () => [
                `cascade echo ${entry.eventId} retired before any doc it ` +
                "wrote landed at the mark's frame — the server's cascade " +
                "child has not landed here yet (the W2.1 flicker)",
              ]);
            }
          }
        }
      }
      entry.resolveVerdict({
        withdrawn: {
          message: own
            ? "event echo retired: the authoritative consequences " +
              "(or the dropped-event notice) arrived (speculation.md §4)"
            : "cascade echo retired: its ancestor intent's authoritative " +
              "consequences (or notice) arrived (speculation.md §4 step 2)",
          superseded: true,
        },
      });
      void entry.settled.then(() => {
        if (this.#closed) return;
        this.#sweep(space, this.#watermarks.get(space) ?? 0);
      });
    }
    if (entries.size === 0) this.#entries.delete(space);
  }

  /**
   * The supersede-by-newer rider (speculation.md §4, RULED 2026-08-16):
   * a NEWER entry of the same writer whose WHOLE-DOC ops cover every doc
   * an older entry wrote retires the older one at seal — dropping a
   * lower layer under an upper whole-doc layer is invisible (the view
   * reads the upper `set`/`delete` either way; no flip, no
   * re-derivation), and it bounds entry growth for a never-served
   * instance that keeps changing (the arrival gate above keeps such
   * entries alive on purpose). An older entry any of whose docs the
   * newer one PATCHES is kept: a patch is path-relative to the layer
   * beneath it, so dropping that layer would change what the patch
   * applies over.
   */
  #supersedeOlderEntries(
    entries: Map<number, OverlayEntry>,
    entry: OverlayEntry,
  ): void {
    if (entry.sourceAction === undefined || entry.writtenDocs.length === 0) {
      return;
    }
    const covered = new Set(
      entry.writtenDocs
        .filter((doc) => doc.wholeDoc)
        .map((doc) => `${doc.scope ?? ""}\0${doc.id}`),
    );
    if (covered.size === 0) return;
    for (const older of [...entries.values()]) {
      if (
        older === entry || older.localSeq >= entry.localSeq ||
        older.sourceAction !== entry.sourceAction ||
        older.eventId !== undefined || older.writtenDocs.length === 0
      ) {
        continue;
      }
      const allCovered = older.writtenDocs.every((doc) =>
        covered.has(`${doc.scope ?? ""}\0${doc.id}`)
      );
      if (!allCovered) continue;
      entries.delete(older.localSeq);
      older.resolveVerdict({
        withdrawn: {
          message: "speculation superseded by a newer speculation of the " +
            "same writer over the same instances (speculation.md §4's " +
            "supersede-by-newer rider)",
          superseded: true,
        },
      });
    }
  }

  #ensureWatermarkSink(space: MemorySpace): void {
    this.#ensureAckObserver(space);
    this.#ensureArrivalObserver(space);
    if (this.#watermarkSinks.has(space)) return;
    try {
      // Constructed INLINE from the wire-module constant rather than
      // through `executor/watermark.ts`: that module value-imports the
      // sqlite ENGINE (its server-side activation read), and this
      // module rides in every CLIENT bundle — the browser worker
      // included, where an engine import is fatal to the whole bundle.
      // The link shape is protocol.md §4's: the well-known doc, the
      // SPACE instance, the whole-document path.
      const cell = this.#runtime.getCellFromLink<{ seq?: number }>({
        space,
        id: SERVER_EXECUTION_WATERMARK_DOC_ID as never,
        scope: "space",
        path: [],
      });
      const cancel = cell.sink((value) => {
        const seq = (value as { seq?: number } | undefined)?.seq ?? 0;
        const known = this.#watermarks.get(space) ?? 0;
        if (seq > known) {
          this.#watermarks.set(space, seq);
        }
        this.#sweep(space, Math.max(seq, known));
      });
      this.#watermarkSinks.set(space, cancel);
    } catch (error) {
      logger.warn("watermark-sink-failed", () => [
        `watermark sink for ${space} failed; overlay retirement for the ` +
        "space will rely on entry re-runs",
        error,
      ]);
    }
  }

  /** Install the ARRIVAL wake (ISpaceReplica.speculationArrivalObserver;
   * stage C tuning T2, speculation.md §4's owed arrival re-sweep): a
   * frame that moves the confirmed seq of a doc some live entry WROTE
   * re-sweeps the space off the freshest observed W. Filtered to written
   * docs — the ack observer and the watermark sink already cover the
   * read-side triggers — so an unrelated frame costs one Set of the
   * arrived keys plus O(live entries × their written docs) lookups, no
   * sweep. Sweeps synchronously: the replica fires it AFTER the frame's
   * own notifications, on a consistent replica (the ack observer's
   * precedent). */
  #ensureArrivalObserver(space: MemorySpace): void {
    if (this.#arrivalObserverReleases.has(space)) return;
    try {
      const replica = this.#runtime.storageManager.open(space).replica;
      // Capability probe by METHOD, not by `in` on the observer field: the
      // browser worker bundle drops uninitialized class fields, so an `in`
      // probe on the field read false there and the install silently
      // returned (the ack observer below had exactly that latent gap).
      // A replica that implements the retirement view is the one that
      // fires these wakes.
      if (typeof replica.speculationRetirementView !== "function") return;
      const observable = replica as {
        speculationArrivalObserver:
          | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
          | undefined;
      };
      observable.speculationArrivalObserver = (arrived) => {
        if (this.#closed) return;
        const entries = this.#entries.get(space);
        if (entries === undefined || entries.size === 0) return;
        const arrivedKeys = new Set(
          arrived.map((doc) => `${doc.scope ?? ""}\0${doc.id}`),
        );
        let relevant = false;
        for (const entry of entries.values()) {
          if (
            entry.writtenDocs.some((doc) =>
              arrivedKeys.has(`${doc.scope ?? ""}\0${doc.id}`)
            )
          ) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        this.#arrivalSweeps += 1;
        logger.debug("arrival-sweep", () => [
          `authoritative value arrived for a speculated doc in ${space}; ` +
          "re-sweeping the overlay (stage C tuning T2)",
        ]);
        this.#sweep(space, this.#watermarks.get(space) ?? 0);
      };
      const installed = observable.speculationArrivalObserver;
      this.#arrivalObserverReleases.set(space, () => {
        // Release only our own wake: two overlays on one replica (two
        // runtimes over one manager — a test shape) must not clobber
        // each other's install.
        if (observable.speculationArrivalObserver === installed) {
          observable.speculationArrivalObserver = undefined;
        }
      });
    } catch (error) {
      logger.warn("arrival-observer-failed", () => [
        `arrival observer for ${space} failed; retirement of entries whose ` +
        "served value arrives decoupled from W will rely on later " +
        "watermark events",
        error,
      ]);
    }
  }

  /** Install the origin-accept wake (ISpaceReplica.speculationAckObserver)
   * on the space's replica: an entry whose sweep ran while its origin's
   * verdict was still in flight is BLOCKED at that sweep (unacked layer
   * below), and the covering watermark event has passed — on a
   * then-quiet space nothing else re-sweeps. Rejected origins reach the
   * overlay through the dependency cascade; accepts need this wake
   * (speculation.md §4; leg-C 2026-08-13). */
  #ensureAckObserver(space: MemorySpace): void {
    if (this.#ackObserverReleases.has(space)) return;
    try {
      const replica = this.#runtime.storageManager.open(space).replica;
      // Capability probe by method (see #ensureArrivalObserver): the `in`
      // probe on the observer FIELD read false in the browser worker
      // bundle (uninitialized class fields are dropped there), so this
      // wake had never installed in a browser client.
      if (typeof replica.speculationRetirementView !== "function") return;
      const observable = replica as {
        speculationAckObserver: (() => void) | undefined;
      };
      observable.speculationAckObserver = () => {
        if (this.#closed) return;
        this.#sweep(space, this.#watermarks.get(space) ?? 0);
      };
      const installed = observable.speculationAckObserver;
      this.#ackObserverReleases.set(space, () => {
        if (observable.speculationAckObserver === installed) {
          observable.speculationAckObserver = undefined;
        }
      });
    } catch (error) {
      logger.warn("ack-observer-failed", () => [
        `origin-accept observer for ${space} failed; retirement of ` +
        "verdict-raced entries will rely on later watermark events",
        error,
      ]);
    }
  }

  /**
   * Retire every entry the watermark covers (speculation.md §4).
   * Iterates to a fixpoint within the event: retiring one entry can
   * unblock a chained one (a speculation that read another's overlay
   * value).
   */
  #sweep(space: MemorySpace, watermark: number): void {
    if (watermark <= 0) return;
    const entries = this.#entries.get(space);
    if (entries === undefined || entries.size === 0) return;
    const replica = this.#runtime.storageManager.open(space).replica;
    const view = replica.speculationRetirementView?.bind(replica);
    const ackedSeqOf = replica.ackedSeqOf?.bind(replica);
    if (view === undefined || ackedSeqOf === undefined) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of [...entries.values()]) {
        // The retirement floor (speculation.md §4 step 3): the highest
        // of the CONFIRMED read basis and every ORIGIN's ack seq — the
        // wave with `derivedThrough >= floor` has authoritatively
        // derived over everything this speculation consumed. The
        // CURRENT confirmed seq of a doc is deliberately NOT the floor:
        // the server's own derived write bumps it above the INPUT
        // coverage W holds mid-stream, which would strand the entry
        // for the wave's whole busy stretch. The SEAL-TIME read basis
        // has a milder cousin of the same shape: a re-speculation
        // whose run READ a pushed derived value carries that derived
        // commit's seq in its confirmed basis, so its floor exceeds
        // the input-driven W until either the next authored input OR —
        // since S1 (RULED 2026-08-19, protocol.md §4) — the server's
        // DRAIN-SETTLE QUIESCENCE ADVANCE, which covers the space's
        // committed derived tail once the space goes quiet. Before S1
        // this text accepted the lingering under the premise "values
        // converge, rendering stays correct" — FALSE under a
        // regressed-base re-derivation (the swatch stall's diverged
        // tombstone, verification-coverage.md OW43): a diverged layer
        // masked a delivered healed value until the next authored
        // commit anywhere in the space. With S1 every floor is
        // reachable on a quiet space; each new input still lifts the
        // previous generation mid-stream. (The combined review's F2
        // found — and its fix pass closed — the one self-inflicted
        // exception: content folding into the advance wave's still-open
        // commit window consumed the latch and left the folded seq
        // uncovered until the next authored input; the consume is now
        // gated on the wave having stayed bookkeeping-only, so the next
        // quiescence covers the folded tail. The register's S1 residual
        // list carries the entry.)
        let floor = entry.confirmedFloor;
        let blocked = false;
        for (const origin of entry.originLocalSeqs) {
          const acked = ackedSeqOf(origin);
          if (acked !== undefined && acked > floor) floor = acked;
        }
        for (const doc of entry.pendingReadDocs) {
          const state = view(doc.id, doc.scope);
          // An UNACKED pending layer BELOW this entry blocks: an
          // in-flight authored origin (the user mid-typing) or a live
          // lower speculation entry. An ACKED layer whose promotion is
          // merely parked does not — the wave consumed it, and its
          // ack seq is already in the floor above.
          if (
            state.pendingLocalSeqs.some((seq) =>
              seq < entry.localSeq && ackedSeqOf(seq) === undefined
            )
          ) {
            blocked = true;
            break;
          }
        }
        if (blocked || watermark < floor) continue;
        // The ARRIVAL gate (speculation.md §4, RULED 2026-08-16): coverage
        // of the basis is necessary, not sufficient — every doc instance
        // this run wrote must hold a CONFIRMED value at seq ≥ floor, i.e.
        // the store has actually spoken for the instance this client
        // reads. Otherwise dropping the layer flips the doc to nothing
        // (or to a stale value) and the writer — a reader of its own
        // output through the scope-narrowing write path — re-derives
        // forever (the OW32 client loop). The echo stays until the
        // authoritative value lands; a served node still retires the
        // moment its derived value arrives (the watermark write rides the
        // same wave commit, so the watermark sink re-sweeps at arrival).
        // Backstop for the demand walk's coverage gaps (fan-out design
        // §E residual 4) and the first-demand transient (§E residual 1).
        //
        // The ARRIVAL-WITNESS predicate (speculation.md §4, RULED
        // 2026-08-22 — candidate (B) of the OW33 fork memo): a cover AT
        // exactly the floor witnesses arrival only when its covering
        // commit is DERIVED-class — the legitimate at-floor arrival is a
        // re-derivation whose run read the already-arrived value at that
        // very seq. An authored-class cover at the floor is the entry's
        // own basis commit — the setup write that created the computed
        // docs' structure (the client's own for a new instance, a prior
        // session's for a resumed one) — and never witnesses the
        // derivation's arrival: retiring on it is the OW33 hole (the
        // entry dropped 40-260 ms before the served value landed, and
        // the bare read saw undefined). A cover whose class the replica
        // does not know (an OFF-arm or pre-predicate frame) fails CLOSED
        // at the floor — toward the standing echo (value-identical
        // in the observed arms; an unknown-class foreign write at the
        // floor may differ, and the next cover settles it), never the
        // undefined read. STRICTLY ABOVE the floor any
        // confirmed cover witnesses, whatever its class: the store has
        // moved past everything this speculation consumed.
        let arrived = true;
        for (const doc of entry.writtenDocs) {
          const state = view(doc.id, doc.scope);
          // A content-addressed doc the store holds witnesses at ANY
          // cover seq (#6304). Its stored envelope is immutable —
          // admission refuses every operation but `set` against a `cid:`
          // id outright, and a `cid:` set unless the WHOLE stored
          // envelope, metadata
          // included, is value-equal (memory/v2 engine.ts's
          // content-addressed immutability pass; this witness rests on
          // that boundary, so a metadata-write carve-out for cid docs
          // would have to revisit it) — and identical rewrites are
          // elided, so its cover never advances and the floor
          // comparison below can never pass for it. Nothing
          // newer can be pending at the id, and retirement renders
          // the stored value whatever this layer holds: the store
          // wins, the disposition every divergence gets — a divergent
          // speculative cid layer is inadmissible content that can
          // never arrive, so holding the entry for it would strand
          // the entry, and its sibling layers, forever. A cid doc
          // with NO confirmed cover still holds the entry: nothing
          // has served the schema document yet, and dropping the
          // layer would flip local schema resolution to nothing.
          if (doc.id.startsWith("cid:") && state.confirmedSeq > 0) {
            continue;
          }
          if (state.confirmedSeq === 0 || state.confirmedSeq < floor) {
            arrived = false;
            break;
          }
          if (state.confirmedSeq === floor && state.coverClass !== "derived") {
            arrived = false;
            break;
          }
        }
        if (!arrived) continue;
        entries.delete(entry.localSeq);
        if (entry.eventId !== undefined) {
          // An intent-origin echo retired by W coverage — the BACKSTOP
          // (speculation.md §4; design (e) item 9): the consequence
          // signal on its tracked entry was missed or is still in
          // flight; one sweep serves both origins.
          logger.debug("intent-echo-retired-by-backstop", () => [
            `intent echo ${entry.eventId} retired by watermark coverage`,
          ]);
        }
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation superseded by the authoritative " +
              "derivation (speculation.md §4: the store wins)",
            superseded: true,
          },
        });
        // A chained entry blocked on this one unblocks only once the
        // drop is APPLIED (async relative to the verdict): re-sweep
        // after settlement, off the freshest observed W — on a quiet
        // space no further watermark event would do it.
        void entry.settled.then(() => {
          if (this.#closed) return;
          this.#sweep(space, this.#watermarks.get(space) ?? 0);
        });
        progressed = true;
      }
    }
    if (entries.size === 0) {
      this.#entries.delete(space);
      // Keep the watermark sink: the next speculation for the space is
      // likely imminent, and the sink doubles as the client's settled
      // signal. It is released on close().
    }
  }

  /** Dispose: withdraw every live entry (the replica may already be
   * closing — rollback is best-effort) and release the watermark
   * sinks. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entries of this.#entries.values()) {
      for (const entry of entries.values()) {
        entry.resolveVerdict({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      }
      entries.clear();
    }
    this.#entries.clear();
    for (const cancel of this.#watermarkSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#watermarkSinks.clear();
    this.#releaseIntentListener();
    this.#intentSidecarStates.clear();
    this.#trackedIntents.clear();
    this.#intentOutcomeSubscribers.clear();
    for (const waiters of this.#intentConsequenceWaiters.values()) {
      for (const resolve of waiters) resolve({ kind: "unsettled" });
    }
    this.#intentConsequenceWaiters.clear();
    this.#intentConsequenceMemo.clear();
    // Nothing can retire an intent after close (`#trackedIntents` was
    // just cleared), so quiescence waiters settle now rather than hang.
    this.#flushIntentQuiescenceWaiters();
    for (const release of this.#ackObserverReleases.values()) {
      try {
        release();
      } catch {
        // observer release is best-effort during teardown
      }
    }
    this.#ackObserverReleases.clear();
    for (const release of this.#arrivalObserverReleases.values()) {
      try {
        release();
      } catch {
        // observer release is best-effort during teardown
      }
    }
    this.#arrivalObserverReleases.clear();
    this.#terminalIntents.clear();
    this.#cascadeParents.clear();
  }
}
