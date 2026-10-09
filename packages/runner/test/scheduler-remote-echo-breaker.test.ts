import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/data-model";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  computeEchoSteps,
  echoBackoffDelayMs,
  type EchoBreakerEvent,
  type EchoDocument,
  type EchoStep,
  RemoteEchoBreaker,
} from "../src/scheduler/echo-breaker.ts";
import {
  ECHO_BACKOFF_BASE_MS,
  ECHO_BACKOFF_MAX_MS,
  ECHO_QUIET_RESET_MS,
  ECHO_TRIP_THRESHOLD,
  ECHO_WINDOW_MS,
  MAX_ECHO_PAIRS,
} from "../src/scheduler/constants.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  TransactionWriteDetail,
} from "../src/storage/interface.ts";
import type { Action, ReactivityLog } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const ACTION = "action-1";

/** The space the breaker's synthetic steps name. */
const STEP_SPACE = "did:key:steps" as IMemorySpaceAddress["space"];

/** The document a synthetic step for `docKey` names. */
function stepDocument(docKey: string): EchoDocument {
  return { space: STEP_SPACE, id: docKey, scopeKey: "space" };
}

/** An echo step (a run that changed the document) for `docKey`. */
function echo(docKey: string): EchoStep {
  return { docKey, document: stepDocument(docKey), changed: true };
}

/** A convergence step (a run that left the document as it was) for `docKey`. */
function converge(docKey: string): EchoStep {
  return { docKey, document: stepDocument(docKey), changed: false };
}

/**
 * Feeds `count` echo steps for one document starting at `start`, spaced
 * `stepMs` apart, one step per call so each counts as one cycle, and returns
 * what each call returned.
 */
function feedEchoes(
  breaker: RemoteEchoBreaker,
  docKey: string,
  count: number,
  start: number,
  stepMs: number,
): (number | undefined)[] {
  const verdicts: (number | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    verdicts.push(breaker.observe(ACTION, [echo(docKey)], start + i * stepMs));
  }
  return verdicts;
}

/** Trips the pair for `docKey` at instants 0 through threshold - 1. */
function trip(breaker: RemoteEchoBreaker, docKey: string): number {
  const verdicts = feedEchoes(breaker, docKey, ECHO_TRIP_THRESHOLD, 0, 1);
  return verdicts[verdicts.length - 1]!;
}

// The two-session suites share one signer, space, and document. The signer
// needs a top-level await, so these live at module scope.
const signer = await Identity.fromPassphrase("remote-echo two-session");
const space = signer.did();
const DOC = "echo-document";
// A schema that accepts any value, so a looping cell can hold a scalar.
// deno-lint-ignore no-explicit-any
const anySchema = {} as any;

describe("scheduler-remote-echo-breaker", () => {
  describe("echoBackoffDelayMs()", () => {
    it("returns the base delay for the first step", () => {
      expect(echoBackoffDelayMs(1)).toBe(ECHO_BACKOFF_BASE_MS);
    });

    it("doubles the delay on each further step", () => {
      expect(echoBackoffDelayMs(2)).toBe(ECHO_BACKOFF_BASE_MS * 2);
      expect(echoBackoffDelayMs(3)).toBe(ECHO_BACKOFF_BASE_MS * 4);
    });

    it("caps the delay at the maximum", () => {
      expect(echoBackoffDelayMs(100)).toBe(ECHO_BACKOFF_MAX_MS);
    });

    it("treats a non-positive step as the first", () => {
      expect(echoBackoffDelayMs(0)).toBe(ECHO_BACKOFF_BASE_MS);
    });
  });

  describe("computeEchoSteps()", () => {
    const alpha = "did:key:alpha" as IMemorySpaceAddress["space"];
    const beta = "did:key:beta" as IMemorySpaceAddress["space"];
    const session1: ScopeKeyIdentity = {
      principal: "did:key:p",
      sessionId: "s1",
    };
    const session2: ScopeKeyIdentity = {
      principal: "did:key:p",
      sessionId: "s2",
    };

    function address(
      inSpace: IMemorySpaceAddress["space"],
      id: string,
      scope: "space" | "session" = "space",
    ): IMemorySpaceAddress {
      return {
        space: inSpace,
        id: id as IMemorySpaceAddress["id"],
        scope,
        path: [],
      };
    }

    /** A write detail as storage records one: a scope name, no instance. */
    function written(
      at: IMemorySpaceAddress,
      previousValue: FabricValue,
      value: FabricValue,
    ): TransactionWriteDetail {
      return {
        address: {
          space: at.space,
          id: at.id,
          scope: at.scope,
          path: toDocumentPath(["value"]),
        },
        previousValue,
        value,
      };
    }

    /** The one transaction surface the classifier reads. */
    function tx(
      details: readonly TransactionWriteDetail[],
    ): Pick<IExtendedStorageTransaction, "getWriteDetails"> {
      return {
        getWriteDetails: (inSpace) =>
          details.filter((detail) => detail.address.space === inSpace),
      };
    }

    function log(
      reads: readonly IMemorySpaceAddress[],
      writes: readonly IMemorySpaceAddress[],
    ): ReactivityLog {
      return { reads: [...reads], shallowReads: [], writes: [...writes] };
    }

    it("returns an echo step for a document the run read, was triggered by, and changed", () => {
      const doc = address(alpha, "of:d");
      const steps = computeEchoSteps(
        tx([written(doc, "B", "A")]),
        log([doc], [doc]),
        [doc],
        session1,
      );
      expect(steps).toEqual([{
        docKey: `${alpha}/space/of:d`,
        document: { space: alpha, id: "of:d", scopeKey: "space" },
        changed: true,
      }]);
    });

    it("returns a convergence step when the run wrote nothing to the document", () => {
      // Storage drops a write of an equal value before it reaches the write
      // details, so an agreeing run leaves no write behind at all.
      const doc = address(alpha, "of:d");
      const steps = computeEchoSteps(tx([]), log([doc], []), [doc], session1);
      expect(steps).toEqual([{
        docKey: `${alpha}/space/of:d`,
        document: { space: alpha, id: "of:d", scopeKey: "space" },
        changed: false,
      }]);
    });

    it("returns no echo step for a written document that did not trigger the run", () => {
      // The input is read and is the trigger, so it is a candidate, and an
      // unchanged one; the output is neither, so it is no candidate at all.

      const input = address(alpha, "of:input");
      const output = address(alpha, "of:output");
      const steps = computeEchoSteps(
        tx([written(output, "x!", "y!")]),
        log([input], [output]),
        [input],
        session1,
      );
      expect(steps).toEqual([{
        docKey: `${alpha}/space/of:input`,
        document: { space: alpha, id: "of:input", scopeKey: "space" },
        changed: false,
      }]);
    });

    it("does not match a trigger in another space that has the same id", () => {
      const inAlpha = address(alpha, "of:d");
      const inBeta = address(beta, "of:d");
      const steps = computeEchoSteps(
        tx([written(inBeta, "B", "A")]),
        log([inBeta], [inBeta]),
        [inAlpha],
        session1,
      );
      expect(steps).toEqual([]);
    });

    it("keys and names two session instances of one document apart", () => {
      // A serving runtime reports every demander's runs on its own session,
      // so the step's document names the instance itself.

      const doc = address(alpha, "of:d", "session");
      const [first] = computeEchoSteps(
        tx([written(doc, "B", "A")]),
        log([doc], [doc]),
        [doc],
        session1,
      );
      const [second] = computeEchoSteps(
        tx([written(doc, "B", "A")]),
        log([doc], [doc]),
        [doc],
        session2,
      );
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(true);
      expect(first.docKey).not.toBe(second.docKey);
      expect(first.document.scopeKey).toBe(
        resolveScopeKey("session", session1),
      );
      expect(second.document.scopeKey).toBe(
        resolveScopeKey("session", session2),
      );
    });
  });

  describe("the constants", () => {
    it("keeps the quiet reset longer than the backoff cap and the window", () => {
      // A loop still running at the cap must never look quiet, and a lapsed
      // window must never cancel a tripped pair's backoff.
      expect(ECHO_QUIET_RESET_MS).toBeGreaterThan(ECHO_BACKOFF_MAX_MS);
      expect(ECHO_QUIET_RESET_MS).toBeGreaterThan(ECHO_WINDOW_MS);
    });
  });

  describe("RemoteEchoBreaker", () => {
    describe("instance members", () => {
      describe("observe()", () => {
        it("returns no deadline below the trip threshold", () => {
          const breaker = new RemoteEchoBreaker();
          const verdicts = feedEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD - 1,
            0,
            1,
          );
          expect(verdicts.every((verdict) => verdict === undefined)).toBe(true);
          expect(breaker.stats(0).trips).toBe(0);
        });

        it("trips at the threshold and returns a backoff deadline", () => {
          const breaker = new RemoteEchoBreaker();
          const tripTime = ECHO_TRIP_THRESHOLD - 1;
          expect(trip(breaker, "d")).toBe(tripTime + ECHO_BACKOFF_BASE_MS);
          expect(breaker.stats(tripTime)).toEqual({
            active: 1,
            trips: 1,
            cyclesObserved: ECHO_TRIP_THRESHOLD,
          });
        });

        it("renews the backoff one step longer on every echo after a trip", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          // Each further echo backs off again at once, without a fresh
          // threshold of echoes, so the loop never runs a burst.
          expect(breaker.observe(ACTION, [echo("d")], 1000)).toBe(
            1000 + ECHO_BACKOFF_BASE_MS * 2,
          );
          expect(breaker.observe(ACTION, [echo("d")], 2000)).toBe(
            2000 + ECHO_BACKOFF_BASE_MS * 4,
          );
          expect(breaker.stats(2000).trips).toBe(1);
        });

        it("holds the renewal at the cap", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          let verdict: number | undefined;
          for (let i = 1; i <= 20; i++) {
            verdict = breaker.observe(ACTION, [echo("d")], i * 1000);
          }
          expect(verdict).toBe(20_000 + ECHO_BACKOFF_MAX_MS);
        });

        it("does not trip when echoes are spread beyond the window", () => {
          const breaker = new RemoteEchoBreaker();
          const verdicts = feedEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD * 2,
            0,
            ECHO_WINDOW_MS + 1,
          );
          expect(verdicts.every((verdict) => verdict === undefined)).toBe(true);
          expect(breaker.stats(0).trips).toBe(0);
        });

        it("keeps a tripped pair tripped across a lapsed window", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          // Longer than the window but, by the whole backoff cap, shorter
          // than the quiet reset: the echo renews the backoff rather than
          // starting the count again.
          const later = ECHO_WINDOW_MS + ECHO_BACKOFF_MAX_MS;
          expect(breaker.observe(ACTION, [echo("d")], later)).toBe(
            later + ECHO_BACKOFF_BASE_MS * 2,
          );
        });

        it("starts a tripped pair afresh after a quiet stretch", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          const later = ECHO_TRIP_THRESHOLD + ECHO_QUIET_RESET_MS + 1;
          expect(breaker.observe(ACTION, [echo("d")], later)).toBeUndefined();
          expect(breaker.accessForTestingOnly.pairState(ACTION, "d"))
            .toMatchObject({ backoffStreak: 0, cycles: 1 });
        });

        it("lifts the backoff on a convergence step", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          expect(breaker.observe(ACTION, [converge("d")], 100)).toBe(0);
          expect(breaker.stats(100).active).toBe(0);
          expect(breaker.accessForTestingOnly.pairState(ACTION, "d"))
            .toBeUndefined();
        });

        it("keeps the backoff when another document of the action is still backing off", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "a");
          trip(breaker, "b");
          expect(breaker.observe(ACTION, [converge("a")], 100))
            .toBeUndefined();
          expect(breaker.stats(100).active).toBe(1);
        });

        it("ignores a convergence step for a document it is not tracking", () => {
          const breaker = new RemoteEchoBreaker();
          expect(breaker.observe(ACTION, [converge("d")], 0)).toBeUndefined();
          expect(breaker.accessForTestingOnly.pairCount).toBe(0);
        });

        it("counts each document independently", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "a");
          const verdicts = feedEchoes(
            breaker,
            "b",
            ECHO_TRIP_THRESHOLD - 1,
            0,
            1,
          );
          expect(verdicts.every((verdict) => verdict === undefined)).toBe(true);
          expect(breaker.stats(0).trips).toBe(1);
        });
      });

      describe("the events it reports", () => {
        /** A breaker that records every event it reports. */
        function recording(): {
          breaker: RemoteEchoBreaker;
          events: EchoBreakerEvent[];
        } {
          const events: EchoBreakerEvent[] = [];
          const breaker = new RemoteEchoBreaker({
            onEvent: (event) => events.push(event),
          });
          return { breaker, events };
        }

        it("reports one trip when a pair reaches the threshold, and none for its renewals", () => {
          const { breaker, events } = recording();
          trip(breaker, "d");
          breaker.observe(ACTION, [echo("d")], 1000);
          breaker.observe(ACTION, [echo("d")], 2000);
          expect(events).toEqual([{
            event: "trip",
            actionId: ACTION,
            document: stepDocument("d"),
          }]);
        });

        it("reports a convergence clear with the renewals and the time since the trip", () => {
          const { breaker, events } = recording();
          trip(breaker, "d");
          const tripTime = ECHO_TRIP_THRESHOLD - 1;
          breaker.observe(ACTION, [echo("d")], 1000);
          breaker.observe(ACTION, [echo("d")], 2000);
          breaker.observe(ACTION, [converge("d")], 5000);
          expect(events.at(-1)).toEqual({
            event: "clear",
            actionId: ACTION,
            document: stepDocument("d"),
            reason: "convergence",
            renewals: 2,
            trippedMs: 5000 - tripTime,
          });
        });

        it("reports a quiet clear when a tripped pair echoes after the quiet reset", () => {
          const { breaker, events } = recording();
          trip(breaker, "d");
          const tripTime = ECHO_TRIP_THRESHOLD - 1;
          const later = tripTime + ECHO_QUIET_RESET_MS + 1;
          breaker.observe(ACTION, [echo("d")], later);
          expect(events.at(-1)).toEqual({
            event: "clear",
            actionId: ACTION,
            document: stepDocument("d"),
            reason: "quiet",
            renewals: 0,
            trippedMs: later - tripTime,
          });
        });

        it("reports a retired clear for each tripped pair of a forgotten action", () => {
          const { breaker, events } = recording();
          trip(breaker, "a");
          trip(breaker, "b");
          feedEchoes(breaker, "c", 3, 0, 1);
          breaker.forget(ACTION, 500);
          const clears = events.filter((event) => event.event === "clear");
          expect(clears.map((event) => event.document.id).sort()).toEqual([
            "a",
            "b",
          ]);
          expect(clears.every((event) => event.reason === "retired")).toBe(
            true,
          );
        });

        it("reports an evicted clear for a tripped pair the bounded table drops", () => {
          const { breaker, events } = recording();
          trip(breaker, "d");
          const tripTime = ECHO_TRIP_THRESHOLD - 1;
          const start = 1000;
          for (let i = 0; i < MAX_ECHO_PAIRS; i++) {
            breaker.observe(ACTION, [echo(`d-${i}`)], start + i);
          }
          expect(breaker.accessForTestingOnly.pairState(ACTION, "d"))
            .toBeUndefined();
          expect(events.at(-1)).toEqual({
            event: "clear",
            actionId: ACTION,
            document: stepDocument("d"),
            reason: "evicted",
            renewals: 0,
            trippedMs: start + MAX_ECHO_PAIRS - 1 - tripTime,
          });
        });

        it("reports nothing for an untripped pair the bounded table drops", () => {
          const { breaker, events } = recording();
          for (let i = 0; i < MAX_ECHO_PAIRS + 50; i++) {
            breaker.observe(ACTION, [echo(`d-${i}`)], i);
          }
          expect(events).toEqual([]);
        });

        it("reports nothing for a pair that converges before it trips", () => {
          const { breaker, events } = recording();
          feedEchoes(breaker, "d", 3, 0, 1);
          breaker.observe(ACTION, [converge("d")], 10);
          expect(events).toEqual([]);
        });
      });

      describe("stats()", () => {
        it("stops counting a pair as active once its deadline has passed", () => {
          const breaker = new RemoteEchoBreaker();
          const deadline = trip(breaker, "d");
          expect(breaker.stats(deadline - 1).active).toBe(1);
          expect(breaker.stats(deadline).active).toBe(0);
          expect(breaker.stats(deadline).trips).toBe(1);
        });
      });

      describe("forget()", () => {
        it("drops every pair of the action", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "a");
          trip(breaker, "b");
          breaker.forget(ACTION, 100);
          expect(breaker.accessForTestingOnly.pairCount).toBe(0);
        });

        it("leaves another action's pairs in place", () => {
          const breaker = new RemoteEchoBreaker();
          trip(breaker, "d");
          for (let i = 0; i < ECHO_TRIP_THRESHOLD; i++) {
            breaker.observe("action-2", [echo("d")], i);
          }
          breaker.forget(ACTION, 100);
          expect(breaker.accessForTestingOnly.pairState("action-2", "d"))
            .toBeDefined();
          expect(breaker.stats(ECHO_TRIP_THRESHOLD).active).toBe(1);
        });
      });

      describe("the bounded pair table", () => {
        it("evicts the oldest pair past the limit", () => {
          const breaker = new RemoteEchoBreaker();
          for (let i = 0; i < MAX_ECHO_PAIRS + 50; i++) {
            breaker.observe(ACTION, [echo(`d-${i}`)], i);
          }
          expect(breaker.accessForTestingOnly.pairCount).toBe(MAX_ECHO_PAIRS);
        });
      });
    });
  });

  describe("the two-session loop over a shared emulated server", () => {
    // Two runtimes share one emulated server and one space, with manual
    // fan-out so each round's cross-session delivery is an explicit flush
    // rather than a timing race. `clock.settle()` drains a round's reactive
    // work without moving logical time, so an echo backoff armed at a future
    // instant holds for as long as the test does not advance the clock;
    // `clock.tick()` advances it through the backoff deliberately.

    let server: MemoryV2Server.Server;

    beforeEach(() => {
      server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    });

    afterEach(async () => {
      await server?.close();
    });

    /** A runtime on the shared server, with the breaker flag set as given. */
    function connect(
      breaker: boolean,
    ): { storage: EmulatedStorageManager; runtime: Runtime } {
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { remoteEchoBreaker: breaker },
      });
      return { storage, runtime };
    }

    /** Commits `value` to `document` from `writer` and loads it on `reader`. */
    async function seed(
      writer: { storage: EmulatedStorageManager; runtime: Runtime },
      reader: Runtime,
      document: string,
      value: unknown,
    ): Promise<void> {
      const tx = writer.runtime.edit();
      writer.runtime.getCell(space, document, anySchema, tx).set(value);
      await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      await writer.storage.synced();
      const mirror = reader.getCell(space, document, anySchema);
      await mirror.sync();
      await mirror.pull();
    }

    /**
     * Subscribes an effect that reads the shared document and writes
     * `tag.value` to it on every run — a derivation whose output is the
     * document it reads. Two sessions with different tags never agree. With
     * `read: "implicit"` the effect only writes, and the reads the write path
     * makes of its destination, the diff base among them, are its only
     * dependency on the document, which is the shape the storm's derivations
     * had.
     */
    function subscribeTagWriter(
      runtime: Runtime,
      tag: { value: string },
      read: "explicit" | "implicit",
    ): Action {
      const action: Action = (tx) => {
        const cell = runtime.getCell<string>(space, DOC, anySchema);
        if (read === "explicit") cell.withTx(tx).get();
        cell.withTx(tx).set(tag.value);
      };
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      runtime.scheduler.queueExecution();
      return action;
    }

    /**
     * Runs `rounds` cross-session exchanges without moving logical time: each
     * round delivers the server's latest to both sessions and drains their
     * reactions. Returns the server's commit sequence after each round.
     */
    async function drive(rounds: number): Promise<number[]> {
      const engine = await server.engineForSpace(space);
      const sequence: number[] = [];
      for (let round = 0; round < rounds; round++) {
        server.flushSessions([space]);
        await clock.settle();
        sequence.push(Engine.serverSeq(engine));
      }
      return sequence;
    }

    async function commitSequence(): Promise<number> {
      return Engine.serverSeq(await server.engineForSpace(space));
    }

    function runCount(runtime: Runtime, action: Action): number {
      return runtime.scheduler.getActionStats(action)?.runCount ?? 0;
    }

    function pairCount(runtime: Runtime): number {
      return runtime.scheduler.accessForTestingOnly.echoBreaker
        .accessForTestingOnly.pairCount;
    }

    async function dispose(
      ...sessions: { storage: EmulatedStorageManager; runtime: Runtime }[]
    ): Promise<void> {
      for (const session of sessions) await session.runtime.dispose();
      for (const session of sessions) await session.storage.close();
    }

    it("trips the breaker and stops the loop when two sessions disagree", async () => {
      const a = connect(true);
      const b = connect(true);
      try {
        await seed(a, b.runtime, DOC, "seed");
        subscribeTagWriter(a.runtime, { value: "A" }, "explicit");
        subscribeTagWriter(b.runtime, { value: "B" }, "explicit");
        await clock.settle();

        const sequence = await drive(ECHO_TRIP_THRESHOLD * 3);

        expect(a.runtime.scheduler.getEchoBreakerStats().trips).toBe(1);
        expect(b.runtime.scheduler.getEchoBreakerStats().trips).toBe(1);
        // With logical time held, the last rounds added no commits, where the
        // unflagged loop adds one per round.
        const tail = sequence.slice(-ECHO_TRIP_THRESHOLD);
        expect(tail[tail.length - 1]).toBe(tail[0]);
        // The last committed value stands.
        const shared = a.runtime.getCell<string>(space, DOC, anySchema);
        await shared.pull();
        expect(["A", "B"]).toContain(shared.get());
      } finally {
        await dispose(a, b);
      }
    });

    it("trips when the looping effects only write the document", async () => {
      // Neither effect reads the document itself; each only writes it. The
      // write path reads the current value as its diff base, and that read is
      // a scheduling dependency, so the other session's commit re-triggers
      // the effect all the same. This is the loop as the storm ran it.

      const a = connect(true);
      const b = connect(true);
      try {
        await seed(a, b.runtime, DOC, "seed");
        subscribeTagWriter(a.runtime, { value: "A" }, "implicit");
        subscribeTagWriter(b.runtime, { value: "B" }, "implicit");
        await clock.settle();

        const sequence = await drive(ECHO_TRIP_THRESHOLD * 3);

        expect(a.runtime.scheduler.getEchoBreakerStats().trips).toBe(1);
        expect(b.runtime.scheduler.getEchoBreakerStats().trips).toBe(1);
        const tail = sequence.slice(-ECHO_TRIP_THRESHOLD);
        expect(tail[tail.length - 1]).toBe(tail[0]);
      } finally {
        await dispose(a, b);
      }
    });

    it("holds each session to one re-run per backoff while the loop continues", async () => {
      const a = connect(true);
      const b = connect(true);
      try {
        await seed(a, b.runtime, DOC, "seed");
        const actionA = subscribeTagWriter(
          a.runtime,
          { value: "A" },
          "explicit",
        );
        const actionB = subscribeTagWriter(
          b.runtime,
          { value: "B" },
          "explicit",
        );
        await clock.settle();
        await drive(ECHO_TRIP_THRESHOLD * 3);

        const runsA = runCount(a.runtime, actionA);
        const runsB = runCount(b.runtime, actionB);
        const commits = await commitSequence();

        // Each cycle lets every backoff in force expire, then offers the loop
        // a threshold's worth of exchanges. A breaker that waited for a fresh
        // threshold after each wake would run a whole burst here.
        const cycles = 4;
        for (let cycle = 0; cycle < cycles; cycle++) {
          await clock.tick(ECHO_BACKOFF_MAX_MS);
          await clock.settle();
          await drive(ECHO_TRIP_THRESHOLD);
        }

        const moreA = runCount(a.runtime, actionA) - runsA;
        const moreB = runCount(b.runtime, actionB) - runsB;
        expect(moreA).toBeLessThanOrEqual(cycles);
        expect(moreB).toBeLessThanOrEqual(cycles);
        // The loop is spaced, not stopped: the disagreement is still live.
        expect(moreA + moreB).toBeGreaterThan(0);
        expect(await commitSequence() - commits).toBeLessThanOrEqual(
          2 * cycles,
        );
      } finally {
        await dispose(a, b);
      }
    });

    it("clears the breaker once the two sessions agree", async () => {
      const a = connect(true);
      const b = connect(true);
      try {
        await seed(a, b.runtime, DOC, "seed");
        const tagA = { value: "A" };
        const tagB = { value: "B" };
        subscribeTagWriter(a.runtime, tagA, "explicit");
        subscribeTagWriter(b.runtime, tagB, "explicit");
        await clock.settle();
        await drive(ECHO_TRIP_THRESHOLD * 3);
        expect(pairCount(a.runtime) + pairCount(b.runtime)).toBe(2);

        // Both sessions now compute the same value. The session that reads it
        // writes it again, which storage drops as unchanged, and that run is
        // the convergence step that clears its pair.
        tagB.value = "A";
        for (let cycle = 0; cycle < 3; cycle++) {
          await clock.tick(ECHO_BACKOFF_MAX_MS);
          await clock.settle();
          await drive(ECHO_TRIP_THRESHOLD);
        }

        const commits = await commitSequence();
        await clock.tick(ECHO_BACKOFF_MAX_MS);
        await clock.settle();
        await drive(ECHO_TRIP_THRESHOLD);
        expect(await commitSequence()).toBe(commits);
        expect(pairCount(a.runtime) + pairCount(b.runtime)).toBeLessThan(2);
        expect(a.runtime.scheduler.getEchoBreakerStats().active).toBe(0);
        expect(b.runtime.scheduler.getEchoBreakerStats().active).toBe(0);
      } finally {
        await dispose(a, b);
      }
    });

    it("reports each session's trip, and the convergence that clears one, to the memory server", async () => {
      // The reports ride each session's own connection, so the server that
      // holds the space ends up with a trip from each session against the
      // one shared document, and a convergence clear from the session that
      // observed the agreed value.

      const a = connect(true);
      const b = connect(true);
      try {
        await seed(a, b.runtime, DOC, "seed");
        const tagA = { value: "A" };
        const tagB = { value: "B" };
        subscribeTagWriter(a.runtime, tagA, "explicit");
        subscribeTagWriter(b.runtime, tagB, "explicit");
        await clock.settle();
        await drive(ECHO_TRIP_THRESHOLD * 3);

        const tripped = server.sessionReports();
        expect(tripped.echoBreaker.trips).toBe(2);
        const trips = tripped.recent.filter((report) =>
          report.event === "trip"
        );
        expect(trips.length).toBe(2);
        expect(new Set(trips.map((report) => report.session)).size).toBe(2);
        expect(new Set(trips.map((report) => report.document.id)).size).toBe(
          1,
        );
        expect(trips.every((report) => report.space === space)).toBe(true);
        expect(trips.every((report) => report.document.scopeKey === "space"))
          .toBe(true);

        tagB.value = "A";
        for (let cycle = 0; cycle < 3; cycle++) {
          await clock.tick(ECHO_BACKOFF_MAX_MS);
          await clock.settle();
          await drive(ECHO_TRIP_THRESHOLD);
        }

        const settled = server.sessionReports();
        expect(settled.echoBreaker.clears.convergence).toBeGreaterThanOrEqual(
          1,
        );
        const clear = settled.recent.find((report) =>
          report.event === "clear" && report.reason === "convergence"
        );
        expect(clear?.document.id).toBe(trips[0].document.id);
      } finally {
        await dispose(a, b);
      }
    });

    it("keeps looping without the flag, and never trips", async () => {
      const a = connect(false);
      const b = connect(false);
      try {
        await seed(a, b.runtime, DOC, "seed");
        subscribeTagWriter(a.runtime, { value: "A" }, "explicit");
        subscribeTagWriter(b.runtime, { value: "B" }, "explicit");
        await clock.settle();

        const sequence = await drive(ECHO_TRIP_THRESHOLD * 3);

        const tail = sequence.slice(-ECHO_TRIP_THRESHOLD);
        expect(tail[tail.length - 1]).toBeGreaterThan(tail[0]);
        expect(a.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
        expect(b.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
      } finally {
        await dispose(a, b);
      }
    });

    it("does not trip a derivation re-run by a second session's edits", async () => {
      // One session edits a source document over and over, and the other runs
      // a derivation that reads the source and writes a SEPARATE output. The
      // derivation re-runs far past the threshold, but its trigger is the
      // source rather than its own output, so no run is an echo step.
      const SOURCE = "collab-source";
      const OUTPUT = "collab-output";
      const editor = connect(true);
      const deriver = connect(true);
      try {
        await seed(editor, deriver.runtime, SOURCE, "v0");
        const derive: Action = (tx) => {
          const src = deriver.runtime.getCell<string>(space, SOURCE, anySchema);
          const out = deriver.runtime.getCell<string>(space, OUTPUT, anySchema);
          out.withTx(tx).set(`${src.withTx(tx).get() ?? ""}!`);
        };
        deriver.runtime.scheduler.subscribe(
          derive,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        deriver.runtime.scheduler.queueExecution();
        await clock.settle();

        for (let round = 0; round < ECHO_TRIP_THRESHOLD * 2; round++) {
          const edit = editor.runtime.edit();
          editor.runtime.getCell<string>(space, SOURCE, anySchema, edit)
            .set(`v${round + 1}`);
          await edit.commit({ holdSyncedUntilCovered: false }).verdict;
          server.flushSessions([space]);
          await clock.settle();
        }

        expect(runCount(deriver.runtime, derive))
          .toBeGreaterThan(ECHO_TRIP_THRESHOLD);
        expect(deriver.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
      } finally {
        await dispose(editor, deriver);
      }
    });

    it("does not carry a retired registration's backoff into a new one", async () => {
      const session = connect(true);
      try {
        const action: Action = () => {};
        const options = { isEffect: true };
        const log = { reads: [], shallowReads: [], writes: [] };
        session.runtime.scheduler.subscribe(action, log, options);
        session.runtime.scheduler.queueExecution();
        await clock.settle();
        expect(runCount(session.runtime, action)).toBe(1);

        session.runtime.scheduler.accessForTestingOnly.gates.setEchoBackoff(
          action,
          performance.now() + ECHO_BACKOFF_MAX_MS,
        );
        session.runtime.scheduler.unsubscribe(action);
        session.runtime.scheduler.subscribe(action, log, options);
        session.runtime.scheduler.queueExecution();
        await clock.settle();

        expect(runCount(session.runtime, action)).toBe(2);
      } finally {
        await dispose(session);
      }
    });
  });
});
