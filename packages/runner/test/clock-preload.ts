// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It installs the shared fake clock in
// "auto-advance" mode: the runtime's own positive-delay timers (armed from
// `src/` — throttle windows, backoff, conflict retries) advance logical time on
// their own so `runtime.idle()`, `cell.pull()`, and commit resolve without real
// sleeping, while a wall-clock sleep armed from a `test/` file freezes and its
// waiter deadlocks. The controls are a global `clock` (settle/tick/reset), typed
// in `test/clock.d.ts`. See the shared harness at
// `packages/test-support/test/clock-preload.ts` and
// `docs/development/waiting-in-tests.md`.

import { installFakeClock } from "@commonfabric/test-support/clock-preload";
import { installSilentBackstopGuard } from "./support/silent-backstop-guard.ts";

installFakeClock({
  mode: "auto-advance",
  // Test files kept on the real clock for now. These should be converted to use
  // a fake clock. // TODO: convert these tests to a fake clock
  // The event-visibility suite uses clock.settle() to hold positive-delay
  // timers while transport work drains, and ticks only the deferred-rescan
  // boundary. It intentionally stays on the fake clock: absence of a visibility
  // response fails a call-count assertion without waiting for a timer.
  realClockFiles: [
    // Holds the resume's per-element documents in the transport so the
    // coordinator reconciles while they are absent. A commit carrying a read of
    // a withheld document is rejected as stale, and the catch-up the rejection
    // waits on cannot arrive while the hold is on, so the retry cycle repeats;
    // real time paces it until the test releases the hold, but auto-advance
    // fires each cycle's timer as soon as it is armed and the loop allocates
    // until the process runs out of heap. Same shape as the retry loop recorded
    // for `list-resume-container-defer` in
    // `docs/development/waiting-in-tests-rationale.md`, and the reason that
    // suite's holds are bounded. This one's hold spans a reconcile, which is the state it
    // exists to observe, so it needs the real clock. The test itself waits on
    // transport edges, never on a delay.
    "list-resume-preserve",
    // The serving loop (server-execution v2 stage F) is wall-clock-paced
    // by design: the lease renew cadence, the consequence-flush deadline
    // (T_flush), and IDLE_PARK_MS are real-time policies, and
    // auto-advance fires the renew interval and park timers as fast as
    // they arm — a semantics change, not a speedup. The test waits on
    // watermark/subscription edges with bounded timeouts.
    "executor-serving-loop",
    "executor-llm-supersession",
    // The engine read-through suite drives the same live ExecutorHost
    // under the same wall-clock policies.
    "engine-read-through",
    "executor-llm-dialog",
    // The compiled-child suite runs the same live serving host. Its lease
    // renew interval must advance in real time while compiler work settles.
    "executor-compile-and-run",
    // Scoped effect requests use the same live serving host and lease cadence.
    "executor-fetch-instances",
    "executor-fetch-program-instances",
    "executor-sqlite-instances",
    "executor-home-sqlite",
    // Same wall-clock pacing, same machinery (the SpaceServer's renew
    // interval and flush deadline), one level down: the stage-G
    // recovery-seam tests drive a real SpaceServer directly.
    "executor-space-server",
    // View publication drives a live ExecutorHost with the same flush, renew,
    // and disposal deadlines. The fixture waits on view-plan events.
    "view-replication-client",
    // The activation lease suite controls Date and renewal intervals itself,
    // while scheduler and transport dispatch use ordinary zero-delay timers.
    "activation-lease",
    // The OW45 arm-B stage-1 space-root ensure suite drives a real
    // SpaceServer directly under the same wall-clock policies (renew
    // interval, flush deadline); auto-advance turns the renew cadence
    // into a runaway (the guard names SpaceServer.activate's timers).
    "executor-space-root-ensure",
    // Stage C tuning T3: the cooperative-yield suite drives a live
    // ExecutorHost with a real flush deadline and a (short) real lease
    // TTL — the yield's `setTimeout(0)` turns and the deadline/renew
    // timers are the wall-clock behavior under test; auto-advance would
    // fire them as fast as they arm.
    "executor-cooperative-yield",
    // The lifecycle-verb suite drives a live ExecutorHost through verbs
    // and reads what they left through a client under the same policies.
    "executor-lifecycle-verbs",
    // The Phase-2 speculation-overlay journeys run a live ExecutorHost
    // (the serving side of the client-loses-derivation-commit journey)
    // under the same wall-clock policies.
    "speculation-overlay",
    // The UI-cell-write conflict-retry suite (the group-chat :133 stall's
    // mechanism) drives a live shared memory server with manual fan-out
    // and waits on pull/flush edges with bounded timeouts — the same
    // live-transport class as the executor suites above; its retry path's
    // catch-up rides transport edges, not virtual time.
    "ui-cell-write-conflict-retry",
    // Stage C W3.1 (S1): the drain-settle quiescence-advance pins drive
    // a live ExecutorHost under the same wall-clock policies (flush
    // deadline, renew cadence), and pins 3/5 assert QUIET-window
    // behavior (nothing further commits) over real elapsed time.
    "executor-settle-advance",
    // The land-off all-no-op-wave pin drives the same serving loop and
    // S1 quiescence advance — the same wall-clock pacing contract.
    "executor-no-op-wave",
    // The sustained-input suite drives a live ExecutorHost whose flush
    // deadline must cut real settles while input keeps arriving, which is
    // the wall-clock behavior under test.
    "executor-sustained-input",
    // The Phase-3 client event-append suite drives a live memory server
    // plus the queue's real-time discharge pacing (retry backoff is a
    // wall-clock policy, and the tests wait on transport edges with
    // bounded timeouts — the same class as the serving-loop suites).
    "event-append-client",
    // The late-hint suite now drives the SAME queue discharge pacing
    // (the LT9 replacement-preservation and route-marker pins fire real
    // appends whose retry backoff is a wall-clock policy) — the same
    // class as event-append-client above.
    "space-host-late-hint",
    // The Phase-3 serving-side events-down suite drives a live
    // ExecutorHost under the same wall-clock policies.
    "executor-events-down",
    // The fan-out stage-A suite (OW17's instance-keyed replica) drives a
    // live ExecutorHost with two flag-ON clients under the same
    // wall-clock policies; it waits on store/replica edges with bounded
    // timeouts.
    "executor-instance-keyed-replica",
    // The fan-out stage-B suite (the per-demander run supply) drives the
    // same live ExecutorHost + N flag-ON clients under the same
    // wall-clock policies, waiting on store/replica edges.
    "executor-fan-out",
    // The (d′) demand-model suite (stage-C build W1) drives the same live
    // ExecutorHost + N flag-ON clients under the same wall-clock policies
    // — the demand-wake grace, the flush deadline, and the session TTL —
    // waiting on store/replica/demand edges; auto-advance turns those
    // real-time policies into a runaway.
    "executor-dprime-w0",
    // The speculation arrival-gate suite drives a live memory server and
    // waits on push/watermark edges with bounded timeouts, and its
    // "would-be loop" window is a real-time observation.
    "speculation-arrival-gate",
    // The OW50 wish commit-failure surfacing suite (seat S-J): its
    // two-writer journey drives a live shared memory server with two
    // runtimes (the served-wish topology) and waits on a bounded
    // settle window for the failure-surfacing bookkeeping transaction —
    // the same live-transport class as the executor suites above.
    "cfc-prepare-crash-surfacing",
    // The stage-C intent-listener suite (design (e)): its e2e pins drive
    // a live memory server and, for the served-mark pin, a live
    // ExecutorHost under the same wall-clock policies (renew cadence,
    // flush deadline); it waits on replica/store edges with bounded
    // timeouts.
    "speculation-intent-listener",
    // The Phase-4 client-effect-channel suite drives a live
    // ExecutorHost (the served navigateTo → intent → enact/ack →
    // retirement journeys) under the same wall-clock policies — the
    // renew interval and flush deadline; auto-advance turns the renew
    // cadence into a runaway.
    "executor-effect-channel",
    // The Phase-5 cross-space suite drives a live ExecutorHost (the
    // foreign-wake journey) under the same wall-clock policies — the
    // renew interval, flush deadline, and the failure-park backoff;
    // auto-advance expires the lease TTL instantly and turns the renew
    // cadence + reactivation backoff into a runaway.
    "executor-cross-space",
    // The Phase-6 outbox-budget suite: the egress-rate token bucket's
    // pacing sleeps are wall-clock policy, and the auto-advance clock's
    // virtual timers diverge from the bucket's time source (Date.now) —
    // the rate gate would regenerate its refill sleep unboundedly.
    "executor-outbox-budget",
    // The OW34-family trust-attribution suite drives a live
    // ExecutorHost (served handler runs minting CFC labels) under the
    // same wall-clock policies — the renew interval and flush deadline;
    // auto-advance turns the renew cadence into a runaway (the guard
    // names SpaceServer.activate's timers).
    "executor-trust-attribution",
    // The explicit warm-request suite drives a live ExecutorHost (the
    // staged-setup provisioning + warm activation journeys, park-race
    // pin included) under the same wall-clock policies — the renew
    // interval and flush deadline; auto-advance turns the renew cadence
    // into a runaway (the guard names SpaceServer.activate's timers).
    "executor-warm-request",
    // Holds the sidecar pattern fetch on an explicit test-side gate while
    // the duplicate launch registers, with a short test-armed pump inside
    // the held window (the gate, not the pump, carries correctness). A
    // test-armed wall-clock sleep deadlocks under auto-advance, so this
    // file stays on the real clock; it waits on the gate and on
    // runtime.idle(), never on a bare delay for its verdict.
    "wish-sidecar-duplicate-launch",
  ],
});

// Installed after the clock, so its check runs inside the clock's wrapper. A
// backstop listed here fires only when the event a wait is gated on never
// arrives, and under auto-advance that firing is a logical jump a test would
// otherwise ride in silence: the module logger sits above the warn, so the
// count is its only trace. See the guard's header and
// `docs/development/waiting-in-tests.md`.
installSilentBackstopGuard([
  {
    logger: "storage.v2",
    key: "conflict-read-repair-timeout",
    meaning: "the conflict read-repair wait in src/storage/v2.ts gave up on " +
      "the caught-up sync after CONFLICT_READ_REPAIR_TIMEOUT_MS and returned " +
      "the rejection with the replica not caught up. Under auto-advance that " +
      "is a 30 s logical jump the test rode instead of the frame: either the " +
      "fixture withholds the frame (a manual fan-out it never flushed) or the " +
      "caught-up path regressed.",
  },
]);
