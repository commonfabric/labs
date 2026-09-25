// The ExecutorHost (server-execution v2 stage F, serving-loop.md §1):
// one per process, owning the activation policy and one SpaceServer per
// ACTIVE space. Wiring, by plane:
//
// - plane (b): the memory server's admission observer notifies the host
//   on any AUTHORED admission (an admission-side hook, never a poll) and
//   on session open; the host activates the space when it meets the
//   ACTIVE criteria — ≥1 live client session, undelivered events (an
//   event-carrying admission), or an EXPLICIT WARM REQUEST
//   (serving-loop.md §1's third trigger, RULED 2026-08-21): a
//   warm-marked admission notice, set only by the serving-side
//   provisioning path when its wave staged setup into the space, which
//   activates a sessionless target where an ordinary authored write
//   deliberately does not (T11.Q7's write-alone parking);
// - plane (c): lease acquire/renew by direct table write (the
//   SpaceServer's cycle);
// - plane (d): admitted-commit records route to the space's SpaceServer
//   feed (self-echo skipped there by class + holder).
//
// A park racing an incoming commit self-heals: the hook re-fires on the
// next admission. Host boot discovery (stream head past eventWatermark ⇒
// undelivered events ⇒ activate) has nothing to discover until Phase 3;
// spaces activate on their first session, event, warm request, or
// session-implying authored admission.

import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";
import { acquireServerExecutionEnabler } from "@commonfabric/memory/v2";
import {
  type Engine,
  selectPendingStreamEventDocs,
  serverSeq,
} from "@commonfabric/memory/v2/engine";
import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import {
  type ParkedRuntimeHandle,
  ParkedServingRuntime,
} from "./parked-runtime.ts";
import {
  awaitDisposeTimeboxed,
  LIFECYCLE_VERB_SPACE_PARKED,
  type LifecycleVerb,
  type RuntimeFactoryContext,
  SpaceServer,
  type SpaceServerOptions,
  type SpaceServerPolicy,
} from "./space-server.ts";
import {
  emptyServingLoopStats,
  refreshDeliveryCheckpointStats,
  registerServingLoopStatsProvider,
  type ServingLoopStats,
} from "./stats.ts";

export type { LifecycleVerb } from "./space-server.ts";

/**
 * Thrown by {@link ExecutorHost.runLifecycleVerb} when this process cannot
 * serve the space the verb names: the host is closed, or another process
 * holds the space's execution lease.
 */
export class SpaceNotServedError extends Error {
  constructor(space: MemorySpace) {
    super(
      `space ${space} is not served by this process (host closed, or ` +
        "its execution lease is held elsewhere)",
    );
    this.name = "SpaceNotServedError";
  }
}

const logger = getLogger("executor-host", { enabled: true, level: "warn" });

// The failure-park re-activation backoff (the lunch-wall cascade flag):
// with park liveness in place, a PERMANENTLY failing loop turns from
// zombie into crash-loop — every park of a space with demand chains a
// re-activation, each rebuilds a full runtime, fails, and parks.
// Streak-based exponential delay, the same 25·2^n shape as the
// commit-backpressure precedent (scheduler/backpressure.ts), capped; an
// idle park or a successfully committed wave clears the streak.
const DEFAULT_FAILURE_PARK_BACKOFF_BASE_MS = 25;
const DEFAULT_FAILURE_PARK_BACKOFF_MAX_MS = 30_000;

// Parked-runtime retention (serving-loop.md §1, "Parking"): how long, and
// how many, idle-parked runtimes the host keeps for their spaces' next
// tenures. The spec's paragraph states the memory each costs and why these
// defaults.
const DEFAULT_PARKED_RUNTIME_RETENTION_MS = 10 * 60_000;
const DEFAULT_MAX_PARKED_RUNTIMES = 8;

const failureParkBackoffDelayMs = (
  streak: number,
  policy: SpaceServerPolicy | undefined,
): number => {
  const base = policy?.failureParkBackoffBaseMs ??
    DEFAULT_FAILURE_PARK_BACKOFF_BASE_MS;
  const max = policy?.failureParkBackoffMaxMs ??
    DEFAULT_FAILURE_PARK_BACKOFF_MAX_MS;
  return Math.min(max, base * 2 ** Math.min(streak - 1, 30));
};

export type ExecutorHostOptions = {
  server: MemoryServer;

  /** The service identity (DID) DR1 holders are minted from — also the
   * loopback sessions' principal (the read-row admission matches it,
   * protocol.md §2). */
  serviceIdentity: string;

  /** Build a serving runtime for one space over the loopback plane. The
   * factory owns auth and runtime options; it MUST pass
   * `experimental: { serverExecution: true }`. `context` is what the
   * SpaceServer hands its factory (see SpaceServerOptions.createRuntime):
   * a factory that reads the home space before returning installs
   * `context.storeReadThrough` on its storage manager first. */
  createRuntime: (
    space: MemorySpace,
    context: RuntimeFactoryContext,
  ) => Promise<{
    runtime: Runtime;
    dispose: () => Promise<void>;
  }>;

  policy?: SpaceServerPolicy;

  /** The RULED test switch for the tenure's space-root ensure (OW45
   * arm-B stage 1, RULED 2026-08-24 — see SpaceServerOptions.
   * ensureSpaceRoots): default ON (production posture); `false`
   * disables it for every SpaceServer this host builds. A
   * whole-instance switch — per-space discrimination is deferred by
   * the same ruling. */
  ensureSpaceRoots?: boolean;

  /** Forwarded internal deterministic-verification seam. */
  decorateWaveCommitSink?: SpaceServerOptions["decorateWaveCommitSink"];

  /** DIAGNOSTIC (tests): forwarded to every SpaceServer this host
   * builds, with the space it serves — see `SpaceServerOptions`. */
  onWaveCycle?: (space: MemorySpace) => void;

  /** DIAGNOSTIC (tests): forwarded the same way — the end of a drain
   * pass, with the space it ran in and the number of events it
   * queued. */
  onEventDrainPass?: (space: MemorySpace, queued: number) => void;

  /** DIAGNOSTIC (tests): forwarded the same way — a served dispatch
   * that deferred, with the space it deferred in. */
  onEventDeferred?: (space: MemorySpace) => void;

  /** DIAGNOSTIC (tests): forwarded the same way — the event whose
   * re-drain the in-flight guard turned away, with the space that
   * turned it away. */
  onDrainInFlightSkip?: (space: MemorySpace, eventId: string) => void;

  /** DIAGNOSTIC (tests): each tenure's park, with the space and the
   * reason. The host's own `onParked` handling is unaffected. */
  onSpaceParked?: (space: MemorySpace, reason: string) => void;

  /** DIAGNOSTIC (tests): forwarded to every SpaceServer this host
   * builds — see `SpaceServerOptions`. */
  onEffectRetired?: () => void;

  /** DIAGNOSTIC (tests): called as each activation attempt ends, with
   * how it ended — `active` once the space's SpaceServer is serving,
   * `refused` when the tenure declined (no lease, nothing to serve),
   * `failed` when it threw. Activation is driven from the admission feed
   * and from session opens and finishes on neither of their edges. See
   * `docs/development/waiting-in-tests.md`. */
  onActivationSettled?: (
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ) => void;
};

export class ExecutorHost {
  readonly #options: ExecutorHostOptions;
  readonly #spaces = new Map<string, SpaceServer>();
  readonly #activating = new Map<string, {
    promise: Promise<void>;
    warmNotices: AdmittedCommitNotice[];
  }>();

  /** Records admitted while a space's activation is still in flight
   * (before its SpaceServer registers): buffered here, drained into the
   * feed at registration — an admission racing activation must never be
   * dropped (its seq may pass the activation's scan head). */
  readonly #pendingNotices = new Map<string, AdmittedCommitNotice[]>();

  /** The ONE process-lifetime localSeq counter for every sink this host
   * builds (the replay keying — engine-wave-sink.ts): survives
   * park/re-activate, shared across ALL spaces. It must be
   * process-global, not per-space, because every sink commits under the
   * SAME process-stable session id (the DR1 holder) and a HOME space's
   * sink writes FOREIGN provisioning batches into OTHER spaces' engines
   * (protocol.md §2b): with per-space counters, a target space's own
   * sink later re-mints (session, localSeq) pairs the home sink's
   * foreign batches already consumed in that engine, and the engine's
   * replay detection kills the target's waves as "commit replay
   * mismatch" — dropping their derivations with nothing to re-arm them
   * (exposed by the warm request's activation of freshly provisioned
   * spaces; the executor-warm-request pin). One shared monotonic
   * counter makes every (session, localSeq) pair globally unique across
   * writers and engines; per-session localSeq gaps are already normal
   * in every store (the engine keys replay by equality, never
   * contiguity). */
  readonly #sinkLocalSeq = { value: 0 };

  /** Consecutive failure parks per space: every park except an idle one
   * and one on a rival's lease. This backoff streak is cleared by an idle
   * park or a successfully committed wave — real served progress, not
   * merely a runtime that got built (every crash-loop tenure builds one). */
  readonly #failureParkStreaks = new Map<string, number>();

  /** Wakers for in-flight backoff sleeps — close() flushes them so a
   * delayed re-activation never stalls shutdown. */
  readonly #backoffWakers = new Set<() => void>();

  /**
   * Runtimes kept from idle parks, by space, each with the timer that ends
   * its retention. Insertion order is park order, so the first entry is the
   * one kept longest.
   */
  readonly #parkedRuntimes = new Map<string, {
    parked: ParkedServingRuntime;
    expiry: ReturnType<typeof setTimeout>;
  }>();

  /** Disposals of parked runtimes still running; close() waits them out. */
  readonly #parkedDisposals = new Set<Promise<void>>();

  readonly #stats: ServingLoopStats = emptyServingLoopStats();
  #releaseServerExecution: () => void = () => {};
  #closed = false;

  constructor(options: ExecutorHostOptions) {
    this.#options = options;
    // The host is a PROCESS-level flag ENABLER: while it lives, the
    // ambient flag stays on (the memory server's per-class admission
    // reads it), whatever individual runtimes construct or dispose. The
    // claim is reference-counted with the Runtime enablers' own (the
    // count lives beside the flag), so neither owner's teardown can
    // un-claim `derived` while the other still serves.
    this.#releaseServerExecution = acquireServerExecutionEnabler();
    options.server.setServerExecutionObserver({
      commitAdmitted: (notice) => this.#onCommitAdmitted(notice),
      sessionOpened: (space) => this.#onSessionOpened(space),
      // Fan-out stage B: a watch-set change on an ACTIVE space wakes its
      // demand pass (the arrival re-arm's trigger); an inactive space
      // waits for the session-open / admission activation triggers.
      // The serving runtime's OWN loopback session (the service
      // principal) is dropped: its tracked-set growth is the serving
      // graph's own reads (a wave's derivations re-traversed on push),
      // not client demand — counting it in `pushGrowthWakes` and waking
      // the loop spins an extra cycle and demand pass that finds no
      // client delta (W1 review MINOR-4).
      demandChanged: (space, reason, principal) => {
        if (this.#closed) return;
        if (principal === this.#options.serviceIdentity) return;
        const existing = this.#spaces.get(space);
        if (existing?.active) existing.noteDemandChanged(reason);
      },
    });
    registerServingLoopStatsProvider(() => this.stats());
  }

  /** The §7 counters, live: static counts merged with per-space state
   * (activeSpaces and watermarkLag read the current SpaceServers). */
  stats(): ServingLoopStats {
    refreshDeliveryCheckpointStats(this.#stats);
    let watermarkLag = 0;
    let activeSpaces = 0;
    for (const server of this.#spaces.values()) {
      if (!server.active) continue;
      activeSpaces += 1;
      watermarkLag = Math.max(watermarkLag, server.watermarkLag);
    }
    return {
      ...this.#stats,
      // Own copy: the live Record mutates under bumpDerivedCommits and
      // the top-level spread shares its reference (the same reason as
      // NIT-1's settle-series copy below).
      derivedCommitsBySpace: { ...this.#stats.derivedCommitsBySpace },
      events: {
        ...this.#stats.events,
        needsAttention: {
          ...this.#stats.events.needsAttention,
          byPhase: { ...this.#stats.events.needsAttention.byPhase },
        },
      },
      demand: { ...this.#stats.demand },
      settle: {
        // NIT-1: deep-copy the entries — a series row stays live after it
        // is pushed (`#recordGrowthLanding` promotes a value-only row to
        // structural-growth in place), so a shallow array copy would let a
        // snapshot's entries mutate after the snapshot was taken.
        series: this.#stats.settle.series.map((entry) => ({ ...entry })),
        dropped: this.#stats.settle.dropped,
      },
      settleAdvances: {
        ...this.#stats.settleAdvances,
        series: this.#stats.settleAdvances.series.map((entry) => ({
          ...entry,
        })),
      },
      memo: { ...this.#stats.memo },
      outbox: { ...this.#stats.outbox },
      lease: { ...this.#stats.lease },
      lifecycleVerbs: { ...this.#stats.lifecycleVerbs },
      parkedRuntimes: {
        ...this.#stats.parkedRuntimes,
        held: this.#parkedRuntimes.size,
      },
      activeSpaces,
      watermarkLag,
    };
  }

  spaceServer(space: MemorySpace): SpaceServer | undefined {
    return this.#spaces.get(space);
  }

  /**
   * Run a pattern-lifecycle verb on `space`'s serving runtime and
   * resolve with its receipt once the verb's writes are durable
   * (docs/features/server-pattern-lifecycle.md). A verb request is an
   * activation trigger of its own: the requester holds no session on
   * the space, so the ACTIVE criteria the session and admission hooks
   * consult do not apply. A verb the space parked under before running
   * is queued once more on the successor tenure.
   *
   * Throws {@link SpaceNotServedError} when this process cannot serve the
   * space — the host is closed, or another process holds the space's lease.
   */
  async runLifecycleVerb<T>(
    space: MemorySpace,
    verb: LifecycleVerb<T>,
  ): Promise<T> {
    for (let attempt = 0;; attempt += 1) {
      const standing = this.#spaces.get(space);
      if (
        standing !== undefined && !standing.active &&
        !this.#activating.has(space)
      ) {
        // A park in progress: its lease releases only once it completes,
        // and an activation before that would fail to acquire.
        await standing.whenParked;
      }
      await this.#activate(space, []);
      const server = this.#spaces.get(space);
      if (server === undefined || !server.active) {
        throw new SpaceNotServedError(space);
      }
      try {
        return await server.runLifecycleVerb(verb);
      } catch (error) {
        if (
          attempt === 0 && error instanceof Error &&
          error.message === LIFECYCLE_VERB_SPACE_PARKED
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  #onCommitAdmitted(notice: AdmittedCommitNotice): void {
    if (this.#closed) return;
    // THE SESSION REMOUNT's trigger (storage/v2.ts
    // `consumeOwedSessionRemount`): this commit touched the ACL document
    // (`of:<space>` — the memory server's aclDocId), which is the ONLY
    // input the authorization verdict that revokes a session has. Every
    // serving runtime is told, not just this space's: the session that
    // starves is typically a CROSS-SPACE replica — a served dispatch's
    // argument link into the viewer's home space, whose pre-genesis
    // session that space's genesis ACL de-authorized. Latch-only and
    // no-op unless a runtime actually holds a terminated session for the
    // space, so the fan-out costs one map walk per ACL-doc admission.
    if (
      this.#spaces.size > 0 &&
      notice.writes.some((write) => write.id === `of:${notice.space}`)
    ) {
      for (const server of this.#spaces.values()) {
        server.noteSpaceAclChanged(notice.space as MemorySpace);
      }
    }
    // Phase 5's server-internal foreign wake needs NO host machinery
    // (survival-tested: a fan-out built here was mutation-probed
    // redundant and removed): a foreign commit's frames arrive on the
    // home serving runtime's foreign loopback session, the scheduler
    // runs autonomously off storage notifications, and the re-run's
    // SEAL wakes the loop (SpaceServer.seal's feed wake). The
    // executor-cross-space E2E pins the end-to-end behavior.
    const existing = this.#spaces.get(notice.space);
    if (existing !== undefined) {
      // Active OR still activating: the record must reach the feed
      // either way — an admission racing a mid-flight activation is the
      // window a dropped record would open (the activation's scan covers
      // only commits before its head). A PARKING server (registered,
      // no longer active, no activation in flight) is the third case:
      // chain a fresh activation behind the park so a space with live
      // demand is never left unserved by the race. A WARM notice racing
      // the park BUFFERS for the successor activation (drained at its
      // registration, exactly like the mid-activation window below):
      // the dying tenure's feed — and the warm capture that just went
      // into it — die with the tenure, and SEVERAL warm notices in one
      // park window chain ONE shared reactivation, so a notice passed
      // by argument would be dropped for every notice but the first
      // (#activate joins the in-flight activation without merging its
      // pending list — the #6191 review's P1).
      existing.enqueueCommit(notice);
      const activation = this.#activating.get(notice.space);
      if (
        !existing.active && activation !== undefined && notice.warm === true
      ) {
        // A warm request is a one-shot activation obligation. Retain it
        // with the initialization that owns the feed, so failed setup
        // carries the request into its successor.
        activation.warmNotices.push(notice);
      }
      if (!existing.active && activation === undefined) {
        if (notice.warm === true) {
          // Only in the true parking window (no successor in flight):
          // once a successor is activating, the enqueue above already
          // reached a feed that survives — its registration drain has
          // either run against this buffer or the notice landed on the
          // registered server directly.
          let buffered = this.#pendingNotices.get(notice.space);
          if (buffered === undefined) {
            buffered = [];
            this.#pendingNotices.set(notice.space, buffered);
          }
          buffered.push(notice);
        }
        this.#reactivateAfterPark(existing, notice.space as MemorySpace);
      }
      return;
    }
    const activating = this.#activating.get(notice.space);
    if (activating !== undefined) {
      // Activation started but its SpaceServer has not registered yet
      // (engine open in flight): buffer, drained at registration.
      let buffered = this.#pendingNotices.get(notice.space);
      if (buffered === undefined) {
        buffered = [];
        this.#pendingNotices.set(notice.space, buffered);
      }
      buffered.push(notice);
      return;
    }
    // The admission-side activation hook (serving-loop.md §1 plane (b)):
    // an AUTHORED admission into a space with no live SpaceServer. The
    // ACTIVE criteria then gate activation: ≥1 live session (an authored
    // transact implies its committing session) or undelivered events —
    // an event-append admission is BOTH the event's arrival and the
    // criterion, so it activates even with no live session (Phase 3: a
    // delegated cross-space delivery lands under the DELIVERING
    // server's service session, and the target may have no client).
    // System/direct writes alone activate nothing — a provisioning
    // write into a lease-less space stays parked until its first
    // session or event (trace finding T11.Q7). The one further
    // activation trigger is the EXPLICIT WARM REQUEST (serving-loop.md
    // §1's third trigger; RULED 2026-08-21): a warm-marked notice — set
    // only by the serving-side provisioning path when its wave staged
    // setup into this space — activates like the carries-events arm,
    // sessionless target included. T11.Q7 stays as designed: the
    // admission ALONE still activates nothing; the warm mark is the
    // provisioning run's own deliberate signal, never a property of
    // ordinary writes.
    if (notice.class !== "authored") return;
    const carriesEvents = notice.eventAppends !== undefined &&
      notice.eventAppends.length > 0;
    if (
      !carriesEvents && notice.warm !== true &&
      !this.#options.server.hasLiveSessionsForSpace(notice.space, {
        excludePrincipal: this.#options.serviceIdentity,
      })
    ) {
      return;
    }
    void this.#activate(notice.space as MemorySpace, [notice]);
  }

  #onSessionOpened(space: string): void {
    if (this.#closed) return;
    const existing = this.#spaces.get(space);
    if (existing?.active) {
      existing.noteDemandChanged();
      return;
    }
    if (existing !== undefined && !this.#activating.has(space)) {
      // A park in progress: re-activate once it completes (M5 — a
      // session opening against a mid-park space must not be stranded
      // until the next trigger).
      this.#reactivateAfterPark(existing, space as MemorySpace);
      return;
    }
    // Activation on session open (serving-loop.md §1), gated on the
    // ACTIVE criteria like the admission and reactivation paths: the
    // service's OWN sessions (loopback planes) are not client demand,
    // and activating on one would hold a runtime and the lease with no
    // client demanding anything.
    if (
      !this.#options.server.hasLiveSessionsForSpace(space, {
        excludePrincipal: this.#options.serviceIdentity,
      })
    ) {
      return;
    }
    void this.#activate(space as MemorySpace, []);
  }

  /** Chain a fresh activation behind a park in progress. Gated on the
   * ACTIVE criteria again at fire time — the park may have been the
   * last session leaving. BOTH §1 criteria are consulted (verdict
   * blocker, 2026-08-12): live sessions OR undelivered events. An
   * event-only admission racing the park (a delegated cross-space
   * delivery with no client anywhere) chains through here, and a
   * sessions-only gate declined it — the delivered event sat unserved
   * until an unrelated trigger. A WARM notice buffered in
   * `#pendingNotices` satisfies the gate the same way — the staged
   * setup is durable and undemanded, exactly the state the warm request
   * exists for. The buffer, drained at the successor's registration,
   * is what carries it: several warm notices in one park window share
   * ONE reactivation, and only a buffer merges them all (the #6191
   * review's P1). A park during initialization completes before its
   * activation unwinds, so the gate waits for any activation in flight
   * rather than joining it. */
  #reactivateAfterPark(parking: SpaceServer, space: MemorySpace): void {
    void parking.whenParked.then(async () => {
      await this.#activating.get(space)?.promise;
      if (this.#closed || this.#spaces.get(space)?.active) return;
      const warm = this.#pendingNotices.get(space)?.some((notice) =>
        notice.warm === true
      );
      if (
        !warm &&
        !this.#options.server.hasLiveSessionsForSpace(space, {
          excludePrincipal: this.#options.serviceIdentity,
        })
      ) {
        try {
          const engine = await this.#options.server.engineForSpace(space);
          if (selectPendingStreamEventDocs(engine).length === 0) return;
        } catch (error) {
          logger.warn("reactivate-events-check-failed", () => [
            `space ${space}: undelivered-events check failed after park; ` +
            "not reactivating on it",
            error,
          ]);
          return;
        }
        // The engine read awaited: re-check the activation preconditions.
        if (this.#closed || this.#spaces.get(space)?.active) return;
      }
      void this.#activate(space, []);
    });
  }

  #activate(
    space: MemorySpace,
    pending: AdmittedCommitNotice[],
  ): Promise<void> {
    // One activation in flight per space: session-open and
    // commit-admitted hooks race, and a second concurrent activation
    // would double-build runtimes against one lease.
    const inFlight = this.#activating.get(space);
    if (inFlight !== undefined) return inFlight.promise;
    const warmNotices = pending.filter((notice) => notice.warm === true);
    const activation = {
      warmNotices,
      promise: this.#activateInner(space, pending, warmNotices).finally(() => {
        if (this.#activating.get(space) === activation) {
          this.#activating.delete(space);
        }
      }),
    };
    this.#activating.set(space, activation);
    return activation.promise;
  }

  async #activateInner(
    space: MemorySpace,
    pending: AdmittedCommitNotice[],
    consumedWarm: AdmittedCommitNotice[],
  ): Promise<void> {
    if (this.#closed || this.#spaces.get(space)?.active) return;
    const streak = this.#failureParkStreaks.get(space) ?? 0;
    if (streak > 0) {
      // Failure-park backoff: the space's last tenure(s) ended in
      // failure parks. Delay this rebuild; admissions meanwhile buffer
      // into #pendingNotices behind this #activating entry (never
      // dropped, never additional activations).
      const delayMs = failureParkBackoffDelayMs(streak, this.#options.policy);
      this.#stats.reactivationBackoffs += 1;
      logger.warn("reactivation-backoff", () => [
        `space ${space}: ${streak} consecutive failure park(s); ` +
        `delaying re-activation ${delayMs}ms`,
      ]);
      await this.#backoffSleep(delayMs);
      if (this.#closed || this.#spaces.get(space)?.active) return;
    }
    // The warm notices this activation CONSUMES (the argument now; the
    // drained buffer appends at drain time): re-buffered by the failure
    // arms below — see #rebufferConsumedWarm. Collected from the start
    // so an early throw (the engine open) loses nothing either.
    try {
      const engine = await this.#options.server.engineForSpace(space);
      // The sink's session key IS the DR1 holder, whose process-instance
      // component makes a new process a NEW engine session — so the
      // process-global counter starting at 0 never collides with a prior
      // process's commits, and sharing ONE counter across every space's
      // sink keeps same-process writers from colliding with each OTHER
      // (see #sinkLocalSeq: a home sink's foreign provisioning batches
      // land in other spaces' engines under this same session).
      const localSeqRef = this.#sinkLocalSeq;
      const server = new SpaceServer({
        space,
        server: this.#options.server,
        engine,
        serviceIdentity: this.#options.serviceIdentity,
        // A runtime kept from the space's last idle park serves this tenure
        // when the store has not moved since; otherwise the factory builds
        // one. Called once the tenure holds the lease.
        createRuntime: (context) => {
          const parked = this.#takeParkedRuntime(space, engine);
          return parked !== undefined
            ? Promise.resolve(parked)
            : this.#options.createRuntime(space, context);
        },
        retainParkedRuntime: (handle) => this.#retainParkedRuntime(handle),
        localSeqRef,
        stats: this.#stats,
        policy: this.#options.policy,
        ...(this.#options.ensureSpaceRoots !== undefined
          ? { ensureSpaceRoots: this.#options.ensureSpaceRoots }
          : {}),
        ...(this.#options.decorateWaveCommitSink !== undefined
          ? {
            decorateWaveCommitSink: this.#options.decorateWaveCommitSink,
          }
          : {}),
        onParked: (reason) => {
          try {
            this.#options.onSpaceParked?.(space, reason);
          } catch (error) {
            // The rest of this handler unregisters the parked server, and
            // `whenParked` resolves after it.
            logger.warn("space-parked-observer-failed", () => [
              `space ${space}: park observer threw`,
              error,
            ]);
          }
          // A park on a rival's lease leaves the space to the rival.
          // Any other park may leave a space that still meets the ACTIVE
          // criteria unserved, so the host re-evaluates them once the
          // park completes (serving-loop.md §1). An idle park clears the
          // backoff streak and every other park extends it, so a space
          // that keeps failing re-activates at a widening interval; a
          // committed wave (below) clears it on the serving path.
          const rivalHoldsLease = reason === "lease-unavailable" ||
            reason === "lease-lost";
          if (reason === "idle") {
            this.#failureParkStreaks.delete(space);
          } else if (!rivalHoldsLease) {
            this.#failureParkStreaks.set(
              space,
              (this.#failureParkStreaks.get(space) ?? 0) + 1,
            );
          }
          // Delete by IDENTITY: a successor activation may already have
          // registered over this entry (the M5 park race), and the
          // dying server must not evict it.
          if (this.#spaces.get(space) === server) {
            this.#spaces.delete(space);
          }
          if (!rivalHoldsLease) this.#reactivateAfterPark(server, space);
          // No flag re-assert needed: the host's OWN enabler (claimed
          // at construction, shared refcount with Runtime enablers)
          // keeps the ambient flag on until close — a parked runtime's
          // dispose releases only its own claim.
        },
        ...(this.#options.onWaveCycle !== undefined
          ? { onWaveCycle: () => this.#options.onWaveCycle!(space) }
          : {}),
        ...(this.#options.onEventDrainPass !== undefined
          ? {
            onEventDrainPass: (queued: number) =>
              this.#options.onEventDrainPass!(space, queued),
          }
          : {}),
        ...(this.#options.onEventDeferred !== undefined
          ? {
            onEventDeferred: () => this.#options.onEventDeferred!(space),
          }
          : {}),
        ...(this.#options.onDrainInFlightSkip !== undefined
          ? {
            onDrainInFlightSkip: (eventId: string) =>
              this.#options.onDrainInFlightSkip!(space, eventId),
          }
          : {}),
        ...(this.#options.onEffectRetired !== undefined
          ? { onEffectRetired: this.#options.onEffectRetired }
          : {}),
        onWaveCommitted: () => {
          // Real served progress clears the failure streak — the
          // signal a crash-looping tenure never produces (its first
          // wave commit is exactly what fails).
          this.#failureParkStreaks.delete(space);
        },
      });
      // Register BEFORE the async activation so admissions racing it
      // enqueue into the feed rather than being dropped; the SpaceServer
      // itself filters records its activation scan already covers.
      this.#spaces.set(space, server);
      for (const notice of pending) server.enqueueCommit(notice);
      const buffered = this.#pendingNotices.get(space);
      if (buffered !== undefined) {
        this.#pendingNotices.delete(space);
        for (const notice of buffered) server.enqueueCommit(notice);
        for (const notice of buffered) {
          if (notice.warm === true) consumedWarm.push(notice);
        }
      }
      const activated = await server.activate();
      if (!activated) {
        this.#spaces.delete(space);
        this.#rebufferConsumedWarm(space, consumedWarm);
        this.#options.onActivationSettled?.(space, "refused");
        return;
      }
      this.#options.onActivationSettled?.(space, "active");
      if (this.#closed) {
        // close() ran while this activation was in flight (it awaits us,
        // but park() on a not-yet-active server is a no-op — so the
        // just-activated server must park itself, or it serves and
        // renews a lease after the host closed).
        await server.park("host-closed");
      }
    } catch (error) {
      this.#spaces.delete(space);
      this.#rebufferConsumedWarm(space, consumedWarm);
      logger.error("activate-failed", `activation of ${space} failed`, error);
      this.#options.onActivationSettled?.(space, "failed");
    }
  }

  /** Re-buffer the warm notices a FAILED activation consumed — its
   * `pending` argument plus what it drained from `#pendingNotices` —
   * so the next trigger's activation drains them into a live
   * successor. A warm notice is a ONE-SHOT signal from a provisioning
   * wave that has already committed: nothing re-issues it, and in the
   * home-profile shape there is no client backstop — an activation
   * dying AFTER the drain (`activate()` refusing on a rival process's
   * unexpired lease, or throwing) would otherwise strand the staged
   * setup underived with no crash anywhere (the OW46-family
   * no-crash-required loss; pinned in executor-warm-request.test.ts).
   * Prepended: the consumed notices are older than anything buffered
   * while the failed activation was in flight. */
  #rebufferConsumedWarm(
    space: MemorySpace,
    consumedWarm: readonly AdmittedCommitNotice[],
  ): void {
    if (consumedWarm.length === 0) return;
    const standing = this.#pendingNotices.get(space);
    this.#pendingNotices.set(
      space,
      standing === undefined
        ? [...consumedWarm]
        : [...consumedWarm, ...standing],
    );
  }

  /** A cancellable backoff sleep: close() flushes the wakers so a
   * delayed re-activation (which close() awaits through #activating)
   * never stalls shutdown by its full delay. */
  #backoffSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#backoffWakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.#backoffWakers.add(wake);
    });
  }

  /**
   * Keeps the runtime of a tenure that parked idle for the space's next
   * tenure (serving-loop.md §1, "Parking"), fenced, for up to
   * `parkedRuntimeRetentionMs` and within `maxParkedRuntimes`. Returns the
   * fenced instance, or `undefined` — retention off, or the host closed —
   * to have the tenure dispose the runtime.
   */
  #retainParkedRuntime(
    handle: ParkedRuntimeHandle,
  ): ParkedServingRuntime | undefined {
    const retentionMs = this.#options.policy?.parkedRuntimeRetentionMs ??
      DEFAULT_PARKED_RUNTIME_RETENTION_MS;
    const maxRuntimes = this.#options.policy?.maxParkedRuntimes ??
      DEFAULT_MAX_PARKED_RUNTIMES;
    if (this.#closed || retentionMs <= 0 || maxRuntimes <= 0) return;
    const { space } = handle;
    // A tenure takes its space's parked runtime when it activates, so a
    // runtime still kept here is one that tenure turned down or never
    // reached; the newer park supersedes it.
    this.#discardParkedRuntime(space);
    const parked = new ParkedServingRuntime(handle);
    // Deferred: the taint arrives inside a storage notification or a
    // seal, and the dispose must not run inside either.
    parked.onTainted = () =>
      queueMicrotask(() => this.#discardParkedRuntime(space, parked));
    this.#parkedRuntimes.set(space, {
      parked,
      expiry: setTimeout(
        () => this.#discardParkedRuntime(space, parked),
        retentionMs,
      ),
    });
    this.#stats.parkedRuntimes.retained += 1;
    while (this.#parkedRuntimes.size > maxRuntimes) {
      const [oldest] = this.#parkedRuntimes.keys();
      this.#discardParkedRuntime(oldest);
    }
    return parked;
  }

  /**
   * The runtime kept from `space`'s last idle park, unfenced for the
   * tenure now activating, when the space's store head is still the one
   * that park recorded and nothing tainted it; `undefined` otherwise, in
   * which case a runtime that was kept is disposed.
   */
  #takeParkedRuntime(
    space: MemorySpace,
    engine: Engine,
  ): { runtime: Runtime; dispose: () => Promise<void> } | undefined {
    const entry = this.#parkedRuntimes.get(space);
    if (entry === undefined) return undefined;
    this.#parkedRuntimes.delete(space);
    clearTimeout(entry.expiry);
    const taken = entry.parked.take(serverSeq(engine));
    if (taken === undefined) {
      this.#disposeParkedRuntime(entry.parked);
      return undefined;
    }
    this.#stats.parkedRuntimes.reused += 1;
    return taken;
  }

  /**
   * Stops keeping `space`'s parked runtime and disposes it — only when it
   * is `parked`, if that is given, so that a late expiry or taint cannot
   * end a newer park's runtime.
   */
  #discardParkedRuntime(space: string, parked?: ParkedServingRuntime): void {
    const entry = this.#parkedRuntimes.get(space);
    if (entry === undefined) return;
    if (parked !== undefined && entry.parked !== parked) return;
    this.#parkedRuntimes.delete(space);
    clearTimeout(entry.expiry);
    this.#disposeParkedRuntime(entry.parked);
  }

  /**
   * Helper for the retention methods above, which disposes a parked
   * runtime that will not be reused, counted, with `close()` able to wait
   * for it. The dispose runs under the park's dispose deadline
   * (`SpaceServerPolicy.parkDisposeTimeoutMs`), so that one that hangs
   * cannot hold `close()` open.
   */
  #disposeParkedRuntime(parked: ParkedServingRuntime): void {
    this.#stats.parkedRuntimes.discarded += 1;
    const space = parked.space;
    const disposal = awaitDisposeTimeboxed(parked.dispose(), {
      policy: this.#options.policy,
      stats: this.#stats,
      space,
      overrun: (timeoutMs) =>
        `space ${space}: disposing a parked runtime overran ` +
        `${timeoutMs}ms; abandoning it`,
    }).catch((error) => {
      logger.warn("parked-runtime-dispose-failed", () => [
        `space ${space}: disposing a parked runtime failed`,
        error,
      ]);
    }).finally(() => this.#parkedDisposals.delete(disposal));
    this.#parkedDisposals.add(disposal);
  }

  /**
   * Park every space and detach from the memory server. Settles once every
   * park has finished; a park that failed is rethrown then, several as an
   * `AggregateError`.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.server.setServerExecutionObserver(undefined);
    registerServingLoopStatsProvider(undefined);
    // Wake sleeping backoffs first: their activations re-check #closed
    // and bail, so the #activating drain below is prompt.
    for (const wake of [...this.#backoffWakers]) wake();
    // Await in-flight activations FIRST: an activation past its #closed
    // check would otherwise register and start serving after close
    // returned (a leaked runtime renewing a lease nobody can take), and
    // park() on a not-yet-active server is a no-op — so the park sweep
    // below cannot stop it. #activateInner's own post-activate check
    // parks the freshly-activated server once #closed is set; awaiting
    // here makes close() cover it. The loop re-checks because a chained
    // re-activation may have been in flight when the snapshot was taken.
    while (this.#activating.size > 0) {
      await Promise.allSettled(
        [...this.#activating.values()].map(({ promise }) => promise),
      );
    }
    // A server already parking on its own — a lost lease, a failed loop
    // — has park() return at once, so its completion is awaited through
    // whenParked: close() must not return while a tenure's runtime is
    // still being disposed against a memory server the caller closes
    // next. The park's own dispose deadline bounds this wait; a dispose
    // it abandons is the crash-equivalent path the park logs and counts.
    // Every park is waited out even when one fails, for the same reason:
    // the others are still disposing against that memory server.
    const parks = await Promise.allSettled(
      [...this.#spaces.values()].map(async (server) => {
        await server.park("host-closed");
        await server.whenParked;
      }),
    );
    this.#spaces.clear();
    this.#pendingNotices.clear();
    // The parked runtimes go too, and like the parks above they are waited
    // out: each disposes against the memory server the caller closes next.
    for (const space of [...this.#parkedRuntimes.keys()]) {
      this.#discardParkedRuntime(space);
    }
    await Promise.allSettled([...this.#parkedDisposals]);
    // The host's enabler releases; the ambient flag resets only when no
    // other enabler (an explicitly-enabled Runtime) is still live.
    this.#releaseServerExecution();
    const failures = parks.flatMap((park) =>
      park.status === "rejected" ? [park.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${failures.length} spaces failed to park while the host closed`,
      );
    }
  }
}
