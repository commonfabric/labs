import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  echoBackoffDelayMs,
  type EchoStep,
  RemoteEchoBreaker,
} from "../src/scheduler/echo-breaker.ts";
import {
  ECHO_BACKOFF_BASE_MS,
  ECHO_BACKOFF_MAX_MS,
  ECHO_TRIP_THRESHOLD,
  ECHO_WINDOW_MS,
  MAX_ECHO_PAIRS,
} from "../src/scheduler/constants.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const ACTION = "action-1";

// Shared fixtures for the two-session loop (below). The signer needs a
// top-level await, so it lives at module scope as the sibling suites do.
const signer = await Identity.fromPassphrase("remote-echo two-session");
const space = signer.did();
const DOC = "echo-document";
// A schema that accepts any value, so the looping cell can hold a scalar.
// deno-lint-ignore no-explicit-any
const anySchema = {} as any;

/** An echo step (a differing re-write) for the given document key. */
function echo(docKey: string): EchoStep {
  return { docKey, docLabel: `space/${docKey}`, changed: true };
}

/** A convergence step (an equal re-write) for the given document key. */
function converge(docKey: string): EchoStep {
  return { docKey, docLabel: `space/${docKey}`, changed: false };
}

/**
 * Drives `count` echo steps for one document at `start`, spaced `stepMs` apart,
 * and returns the deadline each `observe` returned. One step per call so each
 * counts as one cycle.
 */
function driveEchoes(
  breaker: RemoteEchoBreaker,
  docKey: string,
  count: number,
  start: number,
  stepMs: number,
): (number | undefined)[] {
  const deadlines: (number | undefined)[] = [];
  for (let i = 0; i < count; i++) {
    deadlines.push(breaker.observe(ACTION, [echo(docKey)], start + i * stepMs));
  }
  return deadlines;
}

describe("scheduler-remote-echo-breaker", () => {
  describe("echoBackoffDelayMs()", () => {
    it("returns the base delay for the first trip", () => {
      expect(echoBackoffDelayMs(1)).toBe(ECHO_BACKOFF_BASE_MS);
    });

    it("doubles the delay on each further trip", () => {
      expect(echoBackoffDelayMs(2)).toBe(ECHO_BACKOFF_BASE_MS * 2);
      expect(echoBackoffDelayMs(3)).toBe(ECHO_BACKOFF_BASE_MS * 4);
    });

    it("caps the delay at the maximum", () => {
      expect(echoBackoffDelayMs(100)).toBe(ECHO_BACKOFF_MAX_MS);
    });

    it("treats a non-positive streak as the base delay", () => {
      expect(echoBackoffDelayMs(0)).toBe(ECHO_BACKOFF_BASE_MS);
    });
  });

  describe("RemoteEchoBreaker", () => {
    describe("instance members", () => {
      describe("observe()", () => {
        it("returns no deadline below the trip threshold", () => {
          const breaker = new RemoteEchoBreaker();
          const deadlines = driveEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD - 1,
            0,
            1,
          );
          expect(deadlines.every((d) => d === undefined)).toBe(true);
          expect(breaker.stats().trips).toBe(0);
        });

        it("trips at the threshold and returns a backoff deadline", () => {
          const breaker = new RemoteEchoBreaker();
          const deadlines = driveEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD,
            0,
            1,
          );
          const trip = deadlines[ECHO_TRIP_THRESHOLD - 1];
          const tripTime = ECHO_TRIP_THRESHOLD - 1;
          expect(trip).toBe(tripTime + ECHO_BACKOFF_BASE_MS);
          expect(breaker.stats().trips).toBe(1);
          expect(breaker.stats().active).toBe(1);
          expect(breaker.stats().cyclesObserved).toBe(ECHO_TRIP_THRESHOLD);
        });

        it("escalates the backoff on a second trip of the same pair", () => {
          const breaker = new RemoteEchoBreaker();
          driveEchoes(breaker, "d", ECHO_TRIP_THRESHOLD, 0, 1);
          // A fresh threshold of echoes after the trip escalates the streak,
          // so the second backoff is double the first.
          const second = driveEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD,
            1000,
            1,
          );
          const trip = second[ECHO_TRIP_THRESHOLD - 1];
          const tripTime = 1000 + (ECHO_TRIP_THRESHOLD - 1);
          expect(trip).toBe(tripTime + ECHO_BACKOFF_BASE_MS * 2);
          expect(breaker.stats().trips).toBe(2);
          // Still one pair, backing off harder rather than a second pair.
          expect(breaker.stats().active).toBe(1);
        });

        it("resets the count and clears the backoff on a convergence step", () => {
          const breaker = new RemoteEchoBreaker();
          driveEchoes(breaker, "d", ECHO_TRIP_THRESHOLD, 0, 1);
          expect(breaker.stats().active).toBe(1);

          // The loop ends: the action writes an equal value.
          const cleared = breaker.observe(ACTION, [converge("d")], 100);
          expect(cleared).toBe(0);
          expect(breaker.stats().active).toBe(0);
          expect(
            breaker.accessForTestingOnly.pairState(ACTION, "d"),
          ).toBeUndefined();
        });

        it("does not trip when echoes are spread beyond the window", () => {
          const breaker = new RemoteEchoBreaker();
          // Each echo lands more than a window after the last, so the window
          // resets every time and the count never reaches the threshold.
          const deadlines = driveEchoes(
            breaker,
            "d",
            ECHO_TRIP_THRESHOLD * 2,
            0,
            ECHO_WINDOW_MS + 1,
          );
          expect(deadlines.every((d) => d === undefined)).toBe(true);
          expect(breaker.stats().trips).toBe(0);
        });

        it("counts each document independently", () => {
          const breaker = new RemoteEchoBreaker();
          // `a` reaches the threshold; `b` stays one short, so only `a` trips.
          driveEchoes(breaker, "a", ECHO_TRIP_THRESHOLD, 0, 1);
          const bDeadlines = driveEchoes(
            breaker,
            "b",
            ECHO_TRIP_THRESHOLD - 1,
            0,
            1,
          );
          expect(bDeadlines.every((d) => d === undefined)).toBe(true);
          expect(breaker.stats().trips).toBe(1);
          expect(breaker.stats().active).toBe(1);
        });

        it("keeps the backoff when one of several tripped documents converges", () => {
          const breaker = new RemoteEchoBreaker();
          driveEchoes(breaker, "a", ECHO_TRIP_THRESHOLD, 0, 1);
          driveEchoes(breaker, "b", ECHO_TRIP_THRESHOLD, 0, 1);
          expect(breaker.stats().active).toBe(2);

          // `a` converges while `b` is still tripped, so the action stays
          // deferred: the verdict is "leave the gate", not "clear it".
          const verdict = breaker.observe(ACTION, [converge("a")], 100);
          expect(verdict).toBeUndefined();
          expect(breaker.stats().active).toBe(1);
        });
      });

      describe("forget()", () => {
        it("drops a tripped pair and releases its active count", () => {
          const breaker = new RemoteEchoBreaker();
          driveEchoes(breaker, "d", ECHO_TRIP_THRESHOLD, 0, 1);
          expect(breaker.stats().active).toBe(1);

          breaker.forget(ACTION);
          expect(breaker.stats().active).toBe(0);
          expect(breaker.accessForTestingOnly.pairCount).toBe(0);
        });

        it("leaves another action's pairs in place", () => {
          const breaker = new RemoteEchoBreaker();
          driveEchoes(breaker, "d", ECHO_TRIP_THRESHOLD, 0, 1);
          for (let i = 0; i < ECHO_TRIP_THRESHOLD; i++) {
            breaker.observe("action-2", [echo("d")], i);
          }
          expect(breaker.stats().active).toBe(2);

          breaker.forget(ACTION);
          expect(breaker.stats().active).toBe(1);
          expect(
            breaker.accessForTestingOnly.pairState("action-2", "d"),
          ).toBeDefined();
        });
      });

      describe("the bounded pair table", () => {
        it("evicts the oldest pair past the limit", () => {
          const breaker = new RemoteEchoBreaker();
          // One echo each for more distinct documents than the table holds.
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
    // rather than a timing race. `clock.settle()` drains each round's reactive
    // work without moving logical time, so a tripped action's echo backoff —
    // armed at a future instant — never elapses within the test: the loop
    // stops writing the moment the breaker trips rather than merely slowing.

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

    /**
     * Runs the shared document through `rounds` cross-session exchanges: each
     * round delivers the server's latest to both sessions and drains their
     * reactions without moving logical time. Returns the server's commit
     * sequence after each round.
     */
    async function drive(
      rounds: number,
    ): Promise<number[]> {
      const engine = await server.engineForSpace(space);
      const sequence: number[] = [];
      for (let round = 0; round < rounds; round++) {
        server.flushSessions([space]);
        await clock.settle();
        sequence.push(Engine.serverSeq(engine));
      }
      return sequence;
    }

    it("trips the breaker and stops the loop when two sessions disagree", async () => {
      // Session A writes "A" whenever it reads anything else; session B writes
      // "B" the same way. Each reads the shared document (so a remote change
      // re-triggers it) and overwrites the other's value — the self-referential
      // echo loop the storm was.
      const a = connect(true);
      const b = connect(true);
      try {
        const seed = a.runtime.edit();
        a.runtime.getCell<string>(space, DOC, anySchema, seed).set("seed");
        await seed.commit({ holdSyncedUntilCovered: false }).verdict;
        await a.storage.synced();
        const mirror = b.runtime.getCell<string>(space, DOC, anySchema);
        await mirror.sync();
        await mirror.pull();

        const disagree = (runtime: Runtime, tag: string): Action => (tx) => {
          const cell = runtime.getCell<string>(space, DOC, anySchema);
          if (cell.withTx(tx).get() !== tag) cell.withTx(tx).set(tag);
        };
        const actionA = disagree(a.runtime, "A");
        const actionB = disagree(b.runtime, "B");
        a.runtime.scheduler.subscribe(
          actionA,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        b.runtime.scheduler.subscribe(
          actionB,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        a.runtime.scheduler.queueExecution();
        b.runtime.scheduler.queueExecution();
        await clock.settle();

        // Enough rounds that each side passes the trip threshold with margin.
        const sequence = await drive(ECHO_TRIP_THRESHOLD * 3);

        // The breaker tripped on both sides.
        expect(a.runtime.scheduler.getEchoBreakerStats().trips)
          .toBeGreaterThanOrEqual(1);
        expect(b.runtime.scheduler.getEchoBreakerStats().trips)
          .toBeGreaterThanOrEqual(1);

        // The commit rate fell to zero: the last several rounds added no
        // commits, where the unflagged loop would have added one per round.
        const tail = sequence.slice(-ECHO_TRIP_THRESHOLD);
        expect(tail[tail.length - 1]).toBe(tail[0]);

        // The last committed value stands: neither side wrote again.
        const finalA = a.runtime.getCell<string>(space, DOC, anySchema);
        await finalA.pull();
        const finalValue = finalA.get();
        expect(finalValue === "A" || finalValue === "B").toBe(true);
      } finally {
        await a.runtime.dispose();
        await b.runtime.dispose();
        await a.storage.close();
        await b.storage.close();
      }
    });

    it("keeps looping without the flag, and never trips", async () => {
      // The same disagreement with the flag off: the loop runs unbounded, so a
      // bounded drive keeps adding commits and the breaker, which is inert,
      // counts nothing.
      const a = connect(false);
      const b = connect(false);
      try {
        const seed = a.runtime.edit();
        a.runtime.getCell<string>(space, DOC, anySchema, seed).set("seed");
        await seed.commit({ holdSyncedUntilCovered: false }).verdict;
        await a.storage.synced();
        const mirror = b.runtime.getCell<string>(space, DOC, anySchema);
        await mirror.sync();
        await mirror.pull();

        const disagree = (runtime: Runtime, tag: string): Action => (tx) => {
          const cell = runtime.getCell<string>(space, DOC, anySchema);
          if (cell.withTx(tx).get() !== tag) cell.withTx(tx).set(tag);
        };
        a.runtime.scheduler.subscribe(
          disagree(a.runtime, "A"),
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        b.runtime.scheduler.subscribe(
          disagree(b.runtime, "B"),
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
        a.runtime.scheduler.queueExecution();
        b.runtime.scheduler.queueExecution();
        await clock.settle();

        const sequence = await drive(ECHO_TRIP_THRESHOLD * 3);

        // Still climbing at the end — the loop never stops without the breaker.
        const tail = sequence.slice(-ECHO_TRIP_THRESHOLD);
        expect(tail[tail.length - 1]).toBeGreaterThan(tail[0]);
        expect(a.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
        expect(b.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
      } finally {
        await a.runtime.dispose();
        await b.runtime.dispose();
        await a.storage.close();
        await b.storage.close();
      }
    });

    it("does not trip a derivation re-run by a second session's edits", async () => {
      // A legitimate collaboration: one session edits a source document over
      // and over (a person typing), and the other session runs a derivation
      // that reads the source and writes a SEPARATE output. The derivation
      // re-runs on every edit, far past the trip threshold — but it is
      // triggered by the source, not by its own output, so no run is an echo
      // step and the breaker never trips. This is the discrimination that
      // separates the loop from a derivation whose input genuinely changes.
      const SOURCE = "collab-source";
      const OUTPUT = "collab-output";
      const editor = connect(true);
      const deriver = connect(true);
      try {
        const seed = editor.runtime.edit();
        editor.runtime.getCell<string>(space, SOURCE, anySchema, seed).set(
          "v0",
        );
        await seed.commit({ holdSyncedUntilCovered: false }).verdict;
        await editor.storage.synced();
        const mirror = deriver.runtime.getCell<string>(
          space,
          SOURCE,
          anySchema,
        );
        await mirror.sync();
        await mirror.pull();

        // The derivation reads the source and writes the output — a different
        // document — so its own writes are never its trigger.
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

        const rounds = ECHO_TRIP_THRESHOLD * 2;
        for (let round = 0; round < rounds; round++) {
          // The editor makes a fresh edit to the source.
          const edit = editor.runtime.edit();
          editor.runtime.getCell<string>(space, SOURCE, anySchema, edit)
            .set(`v${round + 1}`);
          await edit.commit({ holdSyncedUntilCovered: false }).verdict;
          // The deriver observes it and re-derives the output.
          server.flushSessions([space]);
          await clock.settle();
        }

        // The derivation ran well past the threshold, yet never tripped: its
        // output is not its trigger.
        expect(deriver.runtime.scheduler.getActionStats(derive)!.runCount)
          .toBeGreaterThan(ECHO_TRIP_THRESHOLD);
        expect(deriver.runtime.scheduler.getEchoBreakerStats().trips).toBe(0);
      } finally {
        await editor.runtime.dispose();
        await deriver.runtime.dispose();
        await editor.storage.close();
        await deriver.storage.close();
      }
    });
  });
});
