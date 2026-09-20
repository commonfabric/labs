// The serving loop's counters (server-execution v2 stage F,
// serving-loop.md §7): exposed via the existing `/api/health/stats`
// shape as the `servingLoop` block. Implemented WITH the loop, not
// after — every phase gate in the plan reads these counters, and tests
// MUST assert on counters, not logs. The §3 amplification metric is
// computable from counters alone:
// `derivedCommits / (authoredSeen − effectAcks)`.
//
// Stage boundaries, stated so zeros read as design rather than gaps:
// `events.*` counts nothing until Phase 3 lands events-down, and
// `effectAcks` nothing until Phase 4's effect-channel acks exist.
// `memo.*` and `outbox.*` are LIVE since stage G: memo.hits counts
// builtin evaluations that resolved from the stored request hash
// (serving-loop.md §4's hit rule; reported for the fetch*, generate*
// and sqliteQuery families — fetchProgram and llmDialog count misses
// via the outbox but report no hit events yet). Each hit is one
// stored-key RESOLUTION per §4's hit rule — the stored result (or
// error-shaped result) IS the node's value and no effect fires: one
// avoided external call at that evaluation. The granularity caveat
// for Phase 2's gate arithmetic: hits count per EVALUATION, not per
// distinct request — one settled node re-evaluated N times counts N
// hits — so hit/miss ratios compare resolutions to admissions, never
// "N distinct requests suppressed". (In-flight dedupe of a live key
// is neither: attachment, not a hit.) memo.misses counts
// effects admitted to the outbox (every deferred post-commit effect —
// the serving posture's only producers today are the effectful
// builtins' requests), memo.inflight the live entries;
// outbox.queued/completed track admissions and settled effect work,
// and outbox.failed counts INFRASTRUCTURE failures (a flush throw, a
// rejected work promise, an LT4 deterministic append rejection) —
// effect-level failures commit error-shaped RESULTS per §4 and are
// memo-visible, not outbox failures.

export type ServingLoopStats = {
  activeSpaces: number;

  /** Completed wave closures, including effect-only and aborted outcomes. */
  waves: number;

  /** Exhausted cycles, including zero-delta cycles that close no wave. */
  wavesBudgetExhausted: number;

  supersededWrites: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;

  /** `derivedCommits`, attributed per space (the space DID as the key).
   * The process-wide total cannot scope a delta to the space under test
   * on a shared host — another space's serving activity in the window
   * (a drain-settle quiescence advance from an earlier test's space, a
   * parked space reactivating) is indistinguishable from the watched
   * space's waves — which is what the sx2-events coalescing observation
   * and OW52-style loss accounting both need. Bounded like
   * `settle.series`: at most {@link DERIVED_COMMITS_BY_SPACE_MAX}
   * spaces tracked; a commit for a NEW space beyond the cap evicts the
   * oldest-tracked row, folding its count into
   * `derivedCommitsBySpaceDropped` so the total stays conserved
   * (tracked rows + the fold = `derivedCommits`). Bump through
   * {@link bumpDerivedCommits} only, which keeps total and row in
   * lockstep. */
  derivedCommitsBySpace: Record<string, number>;

  /** Counts folded out of `derivedCommitsBySpace` by the cap eviction
   * (never a lost commit — the process-wide total keeps them). */
  derivedCommitsBySpaceDropped: number;

  /** Demanded-structure loads that THREW (serving-loop.md §1: a value
   * the server cannot serve is counted AND surfaced here, not just
   * logged). Counted per attempt; the loop retries the root on each
   * subsequent input-driven demand cycle until the load lands. */
  structureLoadFailures: number;

  /** Demanded-structure ensure attempts that returned FALSE — the root
   * carried no loadable pattern identity yet, typically the creation
   * race (the demand cycle ran before the piece's instantiation
   * commit applied to the serving replica). Counted per attempt, like
   * structureLoadFailures, and retried the same way: the missing meta
   * arrives as an input, which fires the retrying cycle. A count that
   * grows without settling flags a demanded root that never becomes
   * loadable (e.g. a plain value doc demanded as if it owned a
   * piece). */
  structureLoadDeferred: number;

  /** Demanded roots whose consecutive-deferral streak crossed
   * `STRUCTURE_LOAD_STUCK_AFTER` (space-server.ts) — counted ONCE per
   * crossing, so a nonzero value names roots that are effectively
   * FOREVER-PARKED in the retry arm (verification-coverage.md OW46,
   * the home-profile shape: a piece whose program docs never
   * materialized defers every input-driven cycle, indistinguishable in
   * the aggregate `structureLoadDeferred` from routine one-cycle
   * creation races, and invisible on a quiet space where no cycle
   * runs at all). A root that resolves (starts or terminalizes)
   * clears its streak, so a later re-stuck stretch counts again —
   * like `structureLoadTerminal`, per episode, not per root
   * lifetime. The companion WARN log (`structure-load-stuck`) fires
   * at the crossing and at each doubling while the streak grows. */
  structureLoadStuck: number;

  /** Demanded roots that reached the TERMINAL not-loadable state
   * (server-execution v2 stage P2-F, the OW19 demand-cycle design): the
   * root's doc is confirmed synced from the durable store and carries
   * no pattern meta, so the demand cycle STOPS retrying it — no more
   * per-cycle churn — until a commit touching one of the load's
   * observed docs re-arms it (the not-yet vs never distinction).
   * Counted per terminalization, so a root that re-arms and
   * terminalizes again counts again. */
  structureLoadTerminal: number;

  /** No-pattern-meta verdicts the ENGINE settled, sparing the confirming
   * re-traversal (`SpaceServer.#confirmNoPatternMeta`): the co-hosted
   * engine held no pattern pointer at any chain terminus the attempt
   * resolved, so a second traversal could read none either and its
   * per-address syncs were not issued. Counted once per verdict at the
   * point the decision is taken — before the terminal park, which is
   * what `structureLoadTerminal` counts, and which the
   * confirmation-invalidated arm may pre-empt — so a root that re-arms
   * and comes back counts again. The re-traversal still runs whenever
   * the engine holds a pointer, cannot be addressed for a terminus, or
   * the attempt resolved none, and those verdicts move nothing here. */
  structureLoadConfirmationsSkipped: number;

  /** Terminal roots RE-ARMED by a commit touching one of their observed
   * docs (the OW19 re-arm half): the root returns to the pending set
   * and the next cycle retries its load — this is what keeps the
   * terminal state safe for the creation race (a not-yet-created
   * piece's instantiation commit re-arms and then loads). */
  structureLoadRearmed: number;

  /** Waves whose W advance was CLAMPED below the input batch head
   * because inbound foreign novelty was still shadowed by a parked own
   * write (the settle input barrier, Phase 2 revisit (a):
   * `ISpaceReplica.unappliedForeignSeqFloor`). The clamp is honesty,
   * not a failure — W catches up the wave after the shadow clears — but
   * a count that grows without settling flags a wedged marker channel. */
  watermarkClamped: number;

  /** Engine reads the store read-through performed for serving
   * replicas (`SpaceServerPolicy.storeReadThrough`): misses served on
   * first access, roots read for a `sync()`, and the re-reads
   * `storeRefreshes` counts. Zero while the posture is off. */
  storeReads: number;

  /** Held documents re-read from the engine because an admitted commit
   * on the feed wrote them (`IStorageManager.integrateStoreWrites`), the
   * read-through posture's replacement for a session watch's delivery.
   * Counted per document, not per commit. */
  storeRefreshes: number;

  /** Write-carrying transactions REFUSED at the wave's seal because no
   * run context was stamped (serving-loop.md §3d, RULED 2026-08-05).
   * Structurally zero when every server-side commit path declares its
   * run context; any non-zero count names an undeclared commit path —
   * the class that wedged the resumed list builtins' recovery seeds
   * (the out-of-band editWithRetry retried the refusal without ever
   * landing, so the demanded derivation never materialized). Counted
   * here so the storm is a health-stats fact, not a log-grep. */
  unstampedSealRefusals: number;

  /** Served navigate-intent transactions whose seal FAILED — resolved
   * `{ error }` or rejected (navigate-to.ts's intent-commit arms,
   * independent review NOTE-b). Every failure requeues the owning
   * event (owner review P1-2: the seal wrapper's noteSealFailure —
   * conflict AND isolated classes alike), so the count is a pure
   * health signal: a growing count means intent seals are failing and
   * the loop is burning re-drains on them, never that navigations are
   * being lost. */
  servedIntentSealFailures: number;

  /** Park-time runtime disposes that overran their deadline and were
   * abandoned (park LIVENESS, the lunch-wall containment): a hung
   * dispose must never wedge `whenParked` and every recovery chained
   * behind it. Nonzero says a serving runtime refused to tear down —
   * loud in logs, counted here. */
  parkDisposeTimeouts: number;

  /** Failure-park re-activations delayed by the host's streak backoff
   * (a permanently-failing space must reactivate at a bounded rate,
   * not as fast as admissions arrive). */
  reactivationBackoffs: number;

  /** Foreign-space writes refused at wave ACCUMULATION (serving-loop.md
   * §3d, RULED 2026-08-14 (c); Phase 5 keeps the counter for the
   * accept gate's refusals): action-scoped — the writing action fails,
   * the wave and the loop keep serving. Nonzero names either a
   * carriage-less foreign write (a pattern materializing ambient
   * service-identity state — the lunch-wall class) or an UNGRANTED one
   * (an acting identity reaching for a space it holds no structural
   * grant on — protocol.md §2b's authorization predicate). */
  foreignWriteRefusals: number;

  /** Foreign co-hosted ENGINE resolutions that FAILED at the wave's
   * commit step (Phase 5, the F1b isolation): the failing space's
   * contributions withdraw action-scoped (events requeue, derivations
   * drop) and the wave commits the rest — the home space never parks
   * for one unresolvable foreign target. Counted per failed space per
   * wave; a growing count names a foreign store that persistently
   * cannot open (disk trouble, or a provisioning target with an
   * unusable path). */
  foreignEngineFailures: number;

  /** EXPLICIT WARM REQUESTS issued (serving-loop.md §1's third
   * activation trigger; RULED 2026-08-21): one per foreign provisioning
   * batch a wave durably committed — the serving-side provisioning path
   * telling the host that staged setup landed in another space, so a
   * parked, SESSIONLESS target activates and derives it (the
   * setup-after-park ordering race's fix — the home-profile reload
   * residual). Counted at issue; an already-active target consumes the
   * request as a demand-union no-op. */
  warmRequests: number;

  /** Server-execution v2 fan-out stage B (design §B5, RULED 2026-08-16
   * accept-and-count): derivation runs under the wave-level FALLBACK
   * identity — an action NOBODY demands with an identity — that
   * discovered a scope narrower than `space`. Such a run wrote the
   * SERVICE identity's instance (`user:<serviceDID>`), an inert row no
   * client's applicable set includes: accepted, counted here, never
   * delivered as anyone's instance. A demanded piece never lands here
   * (the service identity runs NO demanded work); a growing count names
   * an eager/idle-scheduled narrowing node no principal watches. */
  undemandedNarrowingRuns: number;

  /** Fan-out stage B's early-emit guard (design §F risk 4, RULED
   * 2026-08-16 fail-closed): a demanded derivation run that EMITTED an
   * event before its scope ratchet had moved — the emission carried a
   * broader (lesser) actor than the run's final discovered scope
   * implies — is REFUSED at the seal and withdrawn; the node's ratchet
   * has learned the scope, so the retry emits correctly attributed.
   * Never silently sessionless. Counted per refusal. */
  earlyEmitRefusals: number;

  /** Fan-out stage B's ARRIVAL RE-ARMS (design §A): demand-registry
   * passes that found a new (principal, session) demander for a root
   * and re-armed the narrowed nodes beneath it for that demander. */
  demandArrivals: number;

  /** max over active spaces of (store head seq − W). */
  watermarkLag: number;

  /** The (d′) `demand` counter block (serving-loop.md §7; stage-C design
   * §6 W4). Demand is memory v2's tracked-ids closure and the demand walk
   * is deleted, so there is NO `walkRuns` counter — its absence is T9′'s
   * structural witness. `demandedRows` = rows the last pass saw (the
   * exposed closure size); `demandedInstances` = distinct registry keys
   * (current / max — the demanded instance count and its peak);
   * `demandedPairs` = total (key, demanding-pair) entries; the standing
   * demand-root set (`demandedWriters` current / max);
   * `demandRootEnters` / `demandRootLeaves` ACCUMULATED across the space's
   * whole life (park and reactivation included — folded from the current
   * runtime's counters SINCE THE LAST FOLD, so a hook-driven transition
   * between passes is not lost — W1 review MINOR-2 — and never read
   * absolutely, since those counters reset on a fresh runtime);
   * `notCurrentRearms` (per-key not-current-for-pair re-arms, accumulated);
   * `demandPasses` the pass count and `demandPassMs` the pass's total WALL
   * time (NOT pure reconcile cost: it INCLUDES the awaited structure-load
   * segments — `ensurePieceRunning` / `#confirmNoPatternMeta` — for
   * first-demand and pending ROOT keys, which dominate the early passes;
   * the reconcile itself is the O(rows) map work — W1 review MINOR-3);
   * `pushGrowthWakes` / `watchWakes` count NOTIFIES (the push-time
   * `demandChanged` and the `session.watch.set` / `.add` notifies) BEFORE
   * the 300 ms grace coalesces them into a pending callback. A callback
   * can lead to multiple passes, and input cycles can run a pass before
   * it fires; notification and pass counts have different boundaries.
   * The service (loopback) session's notifies are dropped (they
   * are the serving graph's own reads, MINOR-4). `demandArrivals` is the
   * pre-existing top-level `servingLoop.demandArrivals` counter (the
   * root-level arrival re-arm's count), not duplicated here. */
  demand: {
    demandedRows: number;
    demandedInstances: number;
    demandedInstancesMax: number;
    demandedPairs: number;
    demandedWriters: number;
    demandedWritersMax: number;
    demandRootEnters: number;
    demandRootLeaves: number;
    notCurrentRearms: number;
    demandPasses: number;
    demandPassMs: number;

    /** Root documents the pass pulled TOGETHER before its sequential
     * structure loads ran (`SpaceServer.#loadStructureRootDocs`). Each is a
     * document one of those loads syncs as its first step, so issuing them
     * in one pull is what lets the replica's refresh queue coalesce them
     * into a single `session.watch.add` instead of one per root inside the
     * wave's settle. Counted per document per pass, so a root whose load
     * stays owed across passes counts once for each. */
    structureRootsPreloaded: number;
    pushGrowthWakes: number;
    watchWakes: number;

    /** Demand-pass wakes from WARM captures (the explicit warm
     * request's staged instances entering the tenure's warm demand,
     * serving-loop.md §1; RULED 2026-08-21) — counted apart so
     * `watchWakes` keeps meaning exactly the session-watch notifies.
     * Like the other wake counters, counts notifies before the grace
     * coalescing. */
    warmWakes: number;
  };

  /** SERVER SETTLE per authored input (serving-loop.md §7; stage-C design
   * §6 W4's metric): from the authored commit's ADMISSION on the server
   * (its seq, `enqueueCommit`) to W COVERING it (the wave commit whose
   * `derivedThrough` ≥ seq). Bounded per-space series. `class` is
   * VALUE-ONLY at coverage and is promoted to STRUCTURAL-GROWTH by
   * ADJACENCY: a push-growth wake that fires AFTER this input was covered
   * — the most recently covered input — plus the next derived commit
   * (its landing) promotes this row. It is NOT a wake "between admission
   * and coverage" (a wake in that window does not change the class), and a
   * growth from an UNRELATED later input can land on this row; the split
   * is an attribution heuristic, not a causal proof (W1 review MINOR-4).
   * `waves` = committed waves between admission and coverage (the
   * T2′/T3′ cycle count). W4's quiet acceptance run reads p50/p95 from
   * this series. */
  settle: {
    series: Array<{
      space: string;
      seq: number;
      admittedAt: number;
      coveredAt: number;
      ms: number;
      waves: number;
      cycles: number;
      growthWakes: number;

      /** VALUE-ONLY at coverage; promoted to STRUCTURAL-GROWTH (by
       * ADJACENCY — the most recently covered input) when a push-growth
       * wake fires AFTER this input's coverage and a later derived commit
       * lands (NIT-1: these growth fields are optional, present only on a
       * promoted entry). */
      class: "value-only" | "structural-growth";

      eventAppend: boolean;

      /** ms from admission to the structural-growth LANDING (the derived
       * commit after the growth wake); present only when promoted. */
      msGrowth?: number;

      /** waves from admission through the growth landing; present only
       * when promoted. */
      growthWaves?: number;

      /** ms from the growth notification to its attributed landing.
       * Includes intervening scheduling and derivation; input-driven work
       * can bypass the grace timer. Present when a wake time was seen. */
      graceMs?: number;

      /** performance.now() of the growth landing; present only when
       * promoted. */
      growthLandedAt?: number;
    }>;
    dropped: number;
  };

  /** S1 — DRAIN-SETTLE QUIESCENCE ADVANCES (RULED 2026-08-19,
   * protocol.md §4's amendment; stage-c/swatch-stall-rootcause.md §4):
   * W covering the space's own committed derived tail at quiescence,
   * with no authored input. Split from the per-input `settle` series
   * so W4's settle metric and §4's amplification arithmetic can
   * subtract the advance-only waves these mint — one derived commit
   * per quiescence transition, latch-bounded, never chasing its own
   * bookkeeping commit. */
  settleAdvances: {
    count: number;

    /** The last advance's step: advancedTo − the coverage it advanced
     * from (how many tail-derivation seqs the quiescence covered). */
    lastDelta: number;

    /** Bounded series (same discipline as settle.series): one row per
     * quiescence advance, so W4 can split advance-only waves out of
     * the per-input settle timings. */
    series: Array<{ space: string; from: number; to: number; at: number }>;

    dropped: number;
  };

  events: {
    appended: number;
    processed: number;
    coalescedPerWaveMax: number;
    skippedIdempotent: number;

    /** Stage C tuning (T3's companion guard): drain passes that found a
     * pending entry whose EARLIER drain copy is still queued or in flight
     * in the serving scheduler (its dispatch has not reached its commit
     * callback yet) and did NOT queue it again. With an honest flush
     * deadline (T3) a cycle routinely ends before a just-drained event
     * has run, and the post-commit re-arm re-drains the still-pending
     * entry next cycle — pre-guard that queued a second copy per cut
     * cycle (4× dispatch of the lockdown toggle on the two-browsers gate;
     * #5969's re-scan variant, (β)). Counted per skipped re-queue; a count
     * that grows without `processed` settling names a drain copy that
     * never completes. */
    drainInFlightSkips: number;

    /** OW45 arm-B round: entries stuck at the drain's PRE-QUEUE
     * deferral barrier (a lagging sidecar view, a failing sidecar
     * sync, or a queue-time throw — the third under its own
     * `queue\0`-prefixed streak key, since the view check clears the
     * bare eventId before the queue attempt) for
     * `EVENT_PREQUEUE_STUCK_AFTER` consecutive passes —
     * counted once at the crossing, per blocking key, mirroring
     * `structureLoadStuck`. Neither barrier arm reaches the queued
     * class's `#eventDeferrals`, so without this the only detection is
     * grepping warn logs. The streak also WARNs at each doubling. A
     * §2-conforming hardening escape (a persistent streak becomes a
     * DROP/ERROR notice IN ARRIVAL POSITION, lifting the barrier
     * order-preserved — the §5 pattern the queued class has) is the
     * register's owed follow-up on the OW45 row. */
    preQueueDeferralStuck: number;

    /** Ordered publication/response barriers attempted for lagging event views. */
    visibilityBarriers: number;

    /** Event identities visible at the recomputed index after a barrier. */
    visibilityRecoveries: number;

    /** Drain passes stopped by an event view still missing its stored identity. */
    visibilityDeferrals: number;

    /** Deferral backstops scheduled across all transient drain outcomes. */
    deferredRescansArmed: number;

    /** Deferral backstops that fired, each owing the scan another pass. */
    deferredRescansFired: number;

    /** Stage C build W3, (α1) — events.md §4's RULED one-entry-one-
     * completed-run sentence: LT1 same-space in-process copies (`served
     * !== undefined && served.streamEntry === undefined`) the flush
     * deadline found still QUEUED and purged synchronously at the
     * deadline decision. No notice lands on the durable entry (the copy
     * carries no failure hook); the entry stays pending and the next
     * drain delivers it ONCE, with a `streamEntry`. Routine under short
     * waves; grows with `wavesBudgetExhausted`. */
    lt1LeftoversPurged: number;

    /** Stage C build W3, (α1b) — the in-flight residue the purge cannot
     * reach: LT1 in-process copies that were RUNNING at the deadline and
     * sealed OUTSIDE their appending wave (the wave their emitter sealed
     * into), refused at the seal destination before entering any wave.
     * Their consequences never commit; the drain's copy of the same
     * entry is the one completed run. A non-zero count is the sentence
     * working (the lunch gate's vote-toggle double was exactly this copy
     * committing unmarked beside the drain's). It grows ROUTINELY for two
     * benign classes, so a rising count is not by itself a signal: an
     * async handler whose copy spans a deadline (the pinned shape), and
     * an LT1 copy forwarding a renderer-trusted event object, which the
     * scheduler's wake shaper HOLDS (`shouldShapeDelivery`) rather than
     * queues — out of the purge's reach (it scans `eventQueue` only) and
     * released into a later wave, where this refusal catches it and the
     * drain delivers (independent review m3; exactly-once holds, at one
     * refused run + one cycle per such cascade). A count that grows while
     * `processed` never settles names a handler whose in-process copy
     * keeps missing its wave. */
    lt1LateSealsRefused: number;

    /** Stage C build W3, (α3) — the orphan REFUSAL (events.md §4's third
     * clause): event-handler runs of an LT1 cascade whose durable entry
     * rode an emitter write the wave WITHDREW (a derivation's superseded
     * per-doc drop, a dropped-whole or requeued emitter) — the entry
     * never lands and nothing re-emits it, so the run's consequences are
     * withdrawn rather than committed with zero durable entries behind
     * them — the copy's same-eventId siblings (the served navigateTo's
     * intent tx) fold into the refusal. Counted once per refused EVENT,
     * however many contributions folded. */
    orphanDeliveriesRefused: number;

    /** Mark/effects atomicity at the DISPATCH layer (events.md §4's
     * exactly-once, the a04 write-side member — RULED 2026-08-27): served
     * dispatches whose handler body DID NOT RUN (the runner's
     * argument-did-not-resolve skip) and whose transaction was therefore
     * WITHDRAWN instead of sealed. The dispatch stamper writes the
     * entry's `consequenced` mark into the handler tx BEFORE the body
     * runs, so letting the skip seal committed a 1-op mark-only
     * consequence — the entry permanently consumed with ZERO effects
     * and no error (a04's seqs 53/56). Counted per withdrawn DRAIN
     * dispatch — an LT1 in-process copy's withdrawal is uncounted (no
     * failure hook; its entry lands unmarked and the drain's own later
     * copy counts if still unresolvable). The entry stays pending and
     * re-drains (the deferral threshold hardens a permanently
     * unresolvable argument into the visible §5 DROP notice). The
     * withdrawal carries events.md §2's arrival-order barrier
     * (review-6459 F1): same-space followers it sweeps count into
     * `loadParkDeferrals` as arrival-barrier work, not here. A count
     * that grows without `processed` settling names a handler whose
     * argument never resolves. */
    handlerNotRunDeferrals: number;

    /** The pre-dispatch LOAD-PARK deferrals (verification-coverage.md's
     * OW45 residue member, fixed 2026-08-26): a served event's dispatch
     * preflight parked on an in-flight replica load its closure reads
     * and that load FAILED, so the event — and every later-arrived
     * event behind it in the same space — deferred to a later drain
     * instead of being sealed `{status: "dropped"}`. Counted per
     * DEFERRAL, head and barrier alike, so a persistently failing load
     * reads as a growing count rather than a single event. A barrier
     * follower may also have been swept behind a handler-not-run
     * withdrawal or a piece-start deferral (events.md §5: every
     * deferral arm carries §2's barrier), so read a nonzero count with
     * `handlerNotRunDeferrals` beside it. Nonzero is
     * not by itself a fault (a revoked-then-remounted session heals in
     * a cycle or two); a count that grows without `processed` moving
     * names a load that never heals. The head's debug record carries the
     * failing doc key and error; its durable checkpoint carries the state. */
    loadParkDeferrals: number;

    /** Typed failures observed for the arrival-order head itself. Barrier
     * followers remain work counted by `loadParkDeferrals` only. */
    loadParkFailures: number;

    /** Durable pending delivery checkpoints currently active, all states. */
    deliveryDeferralsActive: number;

    /** How many of those are failed, and so accruing failed-state time. */
    deliveryFailuresActive: number;

    /** The greatest failed-state time any one active checkpoint has accrued. */
    maxAccumulatedDeliveryFailureMs: number;

    /** Delivery-failure backstops scheduled at a failed checkpoint's budget
     * boundary. One wake stands per event at a time: re-deriving a
     * checkpoint cancels the wake it replaces and arms another, so this
     * counts arming passes and runs above the wakes standing. Its sibling
     * `deferredRescansArmed` counts distinct backstops, since a deferred
     * rescan with a timer standing arms nothing further. */
    deliveryFailureWakesArmed: number;

    /** Delivery-failure backstops that fired during an active serving
     * tenure. An armed wake can be unnecessary if recovery, input, or a
     * commit retires its checkpoint first. */
    deliveryFailureWakesFired: number;

    /** Durable terminal covers, counted only after the carrying wave commits. */
    needsAttention: {
      total: number;
      byPhase: {
        "dispatch-load": number;
        "commit-preparation": number;
        "commit-finalization": number;
      };
    };

    needsAttentionSealFailures: number;
    deliveryCheckpointWriteFailures: number;
    explicitRetries: number;

    /** Terminal drop/error notices SEALED onto a durable entry
     * (events.md §5: the notice IS the consequence and the frontier
     * advances past it). DROPS ONLY — a handler that THREW seals an
     * error consequence and is deliberately not counted here, matching
     * serving-loop.md §7's wording (independent review F8: this comment
     * used to say "drop/error", which the increment never did).
     * Recorded observability gap, closed with the
     * load-park fix: a terminally discharged served event used to be
     * invisible in serving stats — `appended == processed` reads clean
     * while a user's action is permanently gone — so only the WARN line
     * and the entry's own `status` field carried it. Routine causes
     * exist (a piece that can never start hardens here after its
     * bounded creation-race window), so read it against
     * `loadParkDeferrals` and the WARNs, not alone. */
    dropped: number;
  };
  memo: { hits: number; misses: number; inflight: number };
  outbox: {
    queued: number;
    completed: number;
    failed: number;

    /** Phase 6 (serving-loop.md §5's per-space budgets): dispatch
     * holds — an admitted network effect waiting on the outstanding
     * cap or an egress-rate token. Growth under load is the budget
     * WORKING (the runaway degrades its own space), not a failure. */
    budgetDeferrals: number;

    /** Completions that wrote nothing because their request was superseded. */
    superseded: number;
  };
  lease: { held: number; lost: number };

  /** OW45 arm-B server-ensure stage 1 (design PR #6209 §10): the
   * SpaceServer's space-root ensure — one lease-guarded owed step per
   * tenure (existence, no start). Counting caveat (review
   * F4, recorded): `created` counts at SEAL-ACCEPT — the
   * ensure's transactions resolve when the wave admits them, and the
   * engine write rides the wave commit — so a wave later dropped
   * whole (lease-lost abort, replay refusal) leaves a count with no
   * durable write behind it. The MIRROR direction exists too
   * (delta-review N2, confirmed live): a deadline-detached ensure that
   * later completes is a durable write with NO count — `failures`
   * carries the deadline while `runs`/`created` stay 0 and the root
   * lands. Stats-only in both directions: the next tenure's ensure
   * re-resolves and heals the accounting; triangulate against
   * `waves`/`lease.lost` when a count looks off. */
  rootEnsure: {
    /** Completed ensure runs, any outcome. */
    runs: number;

    /** Runs whose creation transaction materialized the root. */
    created: number;

    /** Fail-closed skips: the space's ACL resolved no concrete owner
     * (missing, invalid, retracted, ANYONE-only). The tenure serves
     * without a root ensure and NEVER substitutes the service DID
     * (OW53's ruled shape); the next tenure retries. */
    skippedNoOwner: number;

    /** Ensure attempts that threw (source resolve, compile, creation,
     * or resolution failure). Counted AND warned; cleared for the
     * tenure — the next tenure retries — so a deterministic failure
     * cannot spin the wave loop. */
    failures: number;
  };

  /**
   * Pattern-lifecycle verbs the serving loop ran on a requester's behalf
   * (docs/features/server-pattern-lifecycle.md): an `upload`,
   * `instantiate`, or `setsrc` request routed to the space's serving
   * runtime. `runs` counts verbs whose run step completed, any outcome;
   * `failures` those whose run threw, or whose durable confirmation after
   * the wave commit failed.
   */
  lifecycleVerbs: {
    runs: number;
    failures: number;
  };
};

export const emptyServingLoopStats = (): ServingLoopStats => ({
  activeSpaces: 0,
  waves: 0,
  wavesBudgetExhausted: 0,
  supersededWrites: 0,
  authoredSeen: 0,
  effectAcks: 0,
  derivedCommits: 0,
  derivedCommitsBySpace: {},
  derivedCommitsBySpaceDropped: 0,
  structureLoadFailures: 0,
  structureLoadDeferred: 0,
  structureLoadStuck: 0,
  structureLoadTerminal: 0,
  structureLoadConfirmationsSkipped: 0,
  structureLoadRearmed: 0,
  watermarkClamped: 0,
  storeReads: 0,
  storeRefreshes: 0,
  unstampedSealRefusals: 0,
  servedIntentSealFailures: 0,
  parkDisposeTimeouts: 0,
  reactivationBackoffs: 0,
  foreignWriteRefusals: 0,
  foreignEngineFailures: 0,
  warmRequests: 0,
  undemandedNarrowingRuns: 0,
  earlyEmitRefusals: 0,
  demandArrivals: 0,
  watermarkLag: 0,
  demand: {
    demandedRows: 0,
    demandedInstances: 0,
    demandedInstancesMax: 0,
    demandedPairs: 0,
    demandedWriters: 0,
    demandedWritersMax: 0,
    demandRootEnters: 0,
    demandRootLeaves: 0,
    notCurrentRearms: 0,
    demandPasses: 0,
    demandPassMs: 0,
    structureRootsPreloaded: 0,
    pushGrowthWakes: 0,
    watchWakes: 0,
    warmWakes: 0,
  },
  settle: { series: [], dropped: 0 },
  settleAdvances: { count: 0, lastDelta: 0, series: [], dropped: 0 },
  events: {
    appended: 0,
    processed: 0,
    coalescedPerWaveMax: 0,
    skippedIdempotent: 0,
    drainInFlightSkips: 0,
    preQueueDeferralStuck: 0,
    visibilityBarriers: 0,
    visibilityRecoveries: 0,
    visibilityDeferrals: 0,
    deferredRescansArmed: 0,
    deferredRescansFired: 0,
    lt1LeftoversPurged: 0,
    lt1LateSealsRefused: 0,
    orphanDeliveriesRefused: 0,
    handlerNotRunDeferrals: 0,
    loadParkDeferrals: 0,
    loadParkFailures: 0,
    deliveryDeferralsActive: 0,
    deliveryFailuresActive: 0,
    maxAccumulatedDeliveryFailureMs: 0,
    deliveryFailureWakesArmed: 0,
    deliveryFailureWakesFired: 0,
    needsAttention: {
      total: 0,
      byPhase: {
        "dispatch-load": 0,
        "commit-preparation": 0,
        "commit-finalization": 0,
      },
    },
    needsAttentionSealFailures: 0,
    deliveryCheckpointWriteFailures: 0,
    explicitRetries: 0,
    dropped: 0,
  },
  memo: { hits: 0, misses: 0, inflight: 0 },
  outbox: {
    queued: 0,
    completed: 0,
    failed: 0,
    budgetDeferrals: 0,
    superseded: 0,
  },
  lease: { held: 0, lost: 0 },
  rootEnsure: {
    runs: 0,
    created: 0,
    skippedNoOwner: 0,
    failures: 0,
  },
  lifecycleVerbs: { runs: 0, failures: 0 },
});

type ActiveDeliveryCheckpointStat = {
  state: "failed" | "recovering";
  readSpentMs: () => number;
};

const activeDeliveryCheckpoints = new WeakMap<
  ServingLoopStats,
  Map<string, ActiveDeliveryCheckpointStat>
>();

/** Refreshes delivery gauges from the active durable checkpoints. Failed-state
 * time is read now rather than frozen at the checkpoint's last transition. */
export const refreshDeliveryCheckpointStats = (
  stats: ServingLoopStats,
): void => {
  const rows = activeDeliveryCheckpoints.get(stats);
  if (rows === undefined) return;
  stats.events.deliveryDeferralsActive = rows.size;
  stats.events.deliveryFailuresActive =
    [...rows.values()].filter((row) => row.state === "failed").length;
  stats.events.maxAccumulatedDeliveryFailureMs = [...rows.values()].reduce(
    (max, row) => Math.max(max, row.readSpentMs()),
    0,
  );
};

/** Maintain the process-wide delivery gauges from the per-space servers that
 * own the underlying durable checkpoints. The rows stay out of the serialized
 * health shape; only the recomputed gauges above are exposed. */
export const updateDeliveryCheckpointStats = (
  stats: ServingLoopStats,
  key: string,
  checkpoint?: ActiveDeliveryCheckpointStat,
): void => {
  let rows = activeDeliveryCheckpoints.get(stats);
  if (rows === undefined) {
    rows = new Map();
    activeDeliveryCheckpoints.set(stats, rows);
  }
  if (checkpoint === undefined) rows.delete(key);
  else rows.set(key, checkpoint);
  refreshDeliveryCheckpointStats(stats);
};

/** The `derivedCommitsBySpace` cap (the settle.series bounding
 * discipline, applied to a keyed map: oldest-inserted row evicted). A
 * long-lived host serves many short-lived spaces; the map must not grow
 * with them. */
export const DERIVED_COMMITS_BY_SPACE_MAX = 256;

/** The ONE way to count a derived commit: bumps the process-wide total
 * and the space's row together (a site that bumped one but not the
 * other would silently break the conservation the per-space block
 * promises — tracked rows + dropped fold = total). Evicts the
 * oldest-tracked space's row into `derivedCommitsBySpaceDropped` when a
 * NEW space arrives past {@link DERIVED_COMMITS_BY_SPACE_MAX}. */
export const bumpDerivedCommits = (
  stats: ServingLoopStats,
  space: string,
): void => {
  stats.derivedCommits += 1;
  const bySpace = stats.derivedCommitsBySpace;
  if (bySpace[space] === undefined) {
    const keys = Object.keys(bySpace);
    if (keys.length >= DERIVED_COMMITS_BY_SPACE_MAX) {
      // Insertion order is the eviction order (string keys preserve it).
      const oldest = keys[0];
      stats.derivedCommitsBySpaceDropped += bySpace[oldest];
      delete bySpace[oldest];
    }
    bySpace[space] = 0;
  }
  bySpace[space] += 1;
};

// One provider per process (the ExecutorHost registers itself); the
// health route reads through this seam so toolshed needs no reference to
// the host instance.
let servingLoopStatsProvider: (() => ServingLoopStats) | undefined;

export const registerServingLoopStatsProvider = (
  provider: (() => ServingLoopStats) | undefined,
): void => {
  servingLoopStatsProvider = provider;
};

/** The current counters, or undefined when no ExecutorHost runs in this
 * process (the OFF arm; the health route omits the block then). */
export const getServingLoopStats = (): ServingLoopStats | undefined =>
  servingLoopStatsProvider?.();
