// Server-execution v2 Phase 6: the per-space egress budgets
// (serving-loop.md §5's "outstanding-effect caps, egress rate";
// README §3.8's multi-tenancy contract — a runaway pattern degrades
// only its own space). The SpaceOutbox's budget gate:
//
// - the OUTSTANDING CAP bounds dispatched-but-unsettled NETWORK
//   effects; admitted effects over the cap hold (FIFO wake), and the
//   in-flight dedupe entry exists from ADMISSION either way, so a
//   re-admit during the hold attaches instead of double-firing;
// - the EGRESS RATE paces dispatches through a token bucket (burst =
//   one second's tokens);
// - LOCAL kinds (sqlite-query) bypass the gate — no egress, nothing
//   to budget;
// - CLOSE (the park path) drops held dispatches — the crash-equivalent
//   posture: the effect re-misses from its memo key on re-activation,
//   and firing against a dying runtime would egress work for a dead
//   space.
//
// REAL CLOCK (listed in clock-preload.ts): the rate gate's pacing
// sleeps are wall-clock policy, and the auto-advance clock's virtual
// timers diverge from the bucket's time source — same class as the
// serving-loop suites.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import {
  POST_COMMIT_RELEASE_REJECTED,
  type PostCommitSideEffect,
} from "../src/cfc/types.ts";
import {
  abandonRunnerAcceptanceEffects,
  RUNNER_ACCEPTANCE_EFFECT_KIND,
} from "../src/executor/runner-acceptance.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "./support/serving-waits.ts";

const signer = await Identity.fromPassphrase("executor outbox budget test");
const space = signer.did() as MemorySpace;

describe("Phase 6 outbox budgets (serving-loop.md §5)", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let localSeqRef: { value: number };

  const holder = executionLeaseHolder(`service:${space}`);

  beforeEach(async () => {
    localSeqRef = { value: 0 };
    server = newSharedServer();
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await server.close();
  });

  /** An effect whose flush records its own start — the dispatch event
   * every wait in this file sleeps on — and then holds until released. */
  const heldEffect = (
    id: string,
    kind: string,
    started: ArrivalLog<string>,
  ): { effect: PostCommitSideEffect; release: () => void } => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      effect: {
        id,
        kind,
        flush: () => {
          started.record(id);
          return gate;
        },
      },
      release,
    };
  };

  const newBudgetOutbox = (
    budget: NonNullable<
      ConstructorParameters<typeof SpaceOutbox>[0]["budget"]
    >,
  ): {
    outbox: SpaceOutbox;
    stats: ReturnType<typeof emptyServingLoopStats>;
    retirements: ArrivalLog<void>;
  } => {
    const stats = emptyServingLoopStats();
    /** Each in-flight effect as it retires — the counts that drop with
     * it move inside the outbox's own continuations. */
    const retirements = new ArrivalLog<void>();
    return {
      outbox: new SpaceOutbox({
        stats,
        server,
        engine,
        space,
        sessionId: holder,
        localSeqRef,
        budget,
        onEffectRetired: retirements.record,
      }),
      stats,
      retirements,
    };
  };

  it("caps dispatched-but-unsettled network effects per space, draining held dispatches FIFO as slots free", async () => {
    const { outbox, stats } = newBudgetOutbox({ maxOutstandingEffects: 2 });
    const started = new ArrivalLog<string>();
    const held = ["a", "b", "c", "d", "e"].map((name) =>
      heldEffect(`llmTest:${name}`, "llmTest-start", started)
    );
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: held.map((entry) => entry.effect),
      context: undefined,
    }]);
    // All five are ADMITTED (in-flight dedupe live from admission)…
    expect(outbox.inflightCount).toBe(5);
    // …but only the cap's worth DISPATCH.
    await started.reached(2);
    expect(outbox.outstandingCount).toBe(2);
    expect(started.entries.slice(0, 2)).toEqual(["llmTest:a", "llmTest:b"]);
    // Settling one frees one slot — FIFO wake. The third start is the
    // event, and its IDENTITY is what says nothing jumped the cap: had
    // "c", "d" or "e" dispatched before the slot freed, it would hold
    // this position instead.
    held[0].release();
    await started.reached(3);
    expect(started.entries[2]).toBe("llmTest:c");
    expect(outbox.outstandingCount).toBe(2);
    expect(stats.outbox.budgetDeferrals).toBeGreaterThanOrEqual(1);
    // Drain the rest.
    for (const entry of held) entry.release();
    await outbox.settle();
    expect(started.entries.length).toBe(5);
    expect(outbox.outstandingCount).toBe(0);
    expect(stats.outbox.completed).toBe(5);
  });

  it("exempts local kinds (sqlite-query) from the budget gate — no egress, no throttle", async () => {
    const { outbox, stats } = newBudgetOutbox({
      maxOutstandingEffects: 1,
      egressRatePerSecond: 1,
    });
    const started = new ArrivalLog<string>();
    const held = ["x", "y", "z"].map((name) =>
      heldEffect(`sqlite:${name}`, "sqlite-query", started)
    );
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: held.map((entry) => entry.effect),
      context: undefined,
    }]);
    // Local kinds dispatch immediately (synchronously), uncounted and
    // unpaced.
    expect(started.entries.length).toBe(3);
    expect(outbox.outstandingCount).toBe(0);
    expect(stats.outbox.budgetDeferrals).toBe(0);
    for (const entry of held) entry.release();
    await outbox.settle();
  });

  it("retires an effect even when the retirement observer throws: settle() returns and the counts still move", async () => {
    // The observer is a test diagnostic, and the caller resolves the
    // entry's retirement promise only after the retirement returns, so a
    // throw that escaped would leave `settle()` waiting forever.
    const stats = emptyServingLoopStats();
    const outbox = new SpaceOutbox({
      stats,
      server,
      engine,
      space,
      sessionId: holder,
      localSeqRef,
      onEffectRetired: () => {
        throw new Error("retirement observer failure (test-injected)");
      },
    });
    const started = new ArrivalLog<string>();
    const entry = heldEffect("llmTest:throwing", "llmTest-start", started);
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: [entry.effect],
      context: undefined,
    }]);
    await started.reached(1);
    entry.release();
    await outbox.settle();
    expect(outbox.inflightCount).toBe(0);
    expect(stats.outbox.completed).toBe(1);
    expect(stats.memo.inflight).toBe(0);
  });

  it("publishes distinct local runner callbacks while network dispatch is blocked", async () => {
    const { outbox, stats } = newBudgetOutbox({ maxOutstandingEffects: 0 });
    const started = new ArrivalLog<string>();
    const held = ["first", "second"].map((name) =>
      heldEffect(name, RUNNER_ACCEPTANCE_EFFECT_KIND, started)
    );
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: held.map((entry) => entry.effect),
      context: undefined,
    }]);
    expect(started.entries).toEqual(["first", "second"]);
    expect(outbox.outstandingCount).toBe(0);
    expect(stats.outbox.budgetDeferrals).toBe(0);
    expect(stats.outbox.queued).toBe(0);
    expect(stats.memo.misses).toBe(0);
    expect(stats.memo.inflight).toBe(0);
    for (const entry of held) entry.release();
    await outbox.settle();
    expect(stats.outbox.completed).toBe(0);
    expect(stats.outbox.failed).toBe(0);
    expect(stats.memo.inflight).toBe(0);
  });

  it("abandons local runner callbacks without abandoning network effects", () => {
    const abandoned: string[] = [];
    abandonRunnerAcceptanceEffects([
      {
        id: "local",
        kind: RUNNER_ACCEPTANCE_EFFECT_KIND,
        flush: () => {},
        abandon: () => abandoned.push("local"),
      },
      {
        id: "network",
        kind: "fetchTest-start",
        flush: () => {},
        abandon: () => abandoned.push("network"),
      },
    ], "The serving wave was withdrawn");
    expect(abandoned).toEqual(["local"]);
  });

  it("carries the surviving attachment through dispatch and readable completion", async () => {
    const { outbox, stats, retirements } = newBudgetOutbox({
      maxOutstandingEffects: 1,
    });
    const blockerStarted = Promise.withResolvers<void>();
    const blocker = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const work = Promise.withResolvers<void>();
    const readable = Promise.withResolvers<void>();
    const key = "fetchTest:attached";
    const tx = {} as IExtendedStorageTransaction;
    const first = {
      actionId: "first",
      kind: "derivation" as const,
      acting: { user: "user:alice", session: "first-session" },
    };
    const survivor = {
      ...first,
      actionId: "survivor",
      acting: { user: "user:alice", session: "second-session" },
    };
    const calls: string[] = [];
    const carried: Array<ReturnType<SpaceOutbox["carriageFor"]>> = [];
    outbox.admitSealedEffects([{
      tx,
      context: undefined,
      effects: [{
        id: "fetchTest:blocker",
        kind: "fetchTest-start",
        flush: () => {
          blockerStarted.resolve();
          return blocker.promise;
        },
      }],
    }]);
    try {
      await blockerStarted.promise;
      outbox.admitSealedEffects([
        {
          tx,
          context: first,
          effects: [{
            id: key,
            kind: "fetchTest-start",
            flush: () => {
              calls.push("rejected");
              return POST_COMMIT_RELEASE_REJECTED;
            },
          }],
        },
        {
          tx,
          context: survivor,
          effects: [{
            id: key,
            kind: "fetchTest-start",
            flush: () => {
              calls.push("survivor");
              carried.push(outbox.carriageFor(key));
              outbox.observeAsyncWork(work.promise);
              started.resolve();
            },
          }],
        },
      ]);
      blocker.resolve();
      await started.promise;
      expect(calls).toEqual(["rejected", "survivor"]);
      expect(carried).toEqual([survivor]);
      expect(outbox.outstandingCount).toBe(1);
      expect(outbox.carriageFor(key)).toEqual(survivor);
      outbox.deferRetirement(key, readable.promise);
      work.resolve();
      // Both halves, because the blocker retires before the survivor's
      // work completes: an in-flight set of one alone can be that earlier
      // retirement rather than the state this test is about.
      await awaitEach(
        retirements,
        () => outbox.inflightCount === 1 && stats.outbox.completed === 2,
      );
      outbox.admitSealedEffects([{
        tx,
        context: first,
        effects: [{
          id: key,
          kind: "fetchTest-start",
          flush: () => {
            calls.push("duplicate");
          },
        }],
      }]);
      expect(calls).toEqual(["rejected", "survivor"]);
      expect(outbox.carriageFor(key)).toEqual(survivor);
      readable.resolve();
      await outbox.settle();
      expect(stats.outbox.queued).toBe(2);
      expect(stats.outbox.completed).toBe(2);
      expect(stats.outbox.failed).toBe(0);
      expect(stats.memo.inflight).toBe(0);
      expect(outbox.outstandingCount).toBe(0);
      expect(outbox.carriageFor(key)).toBeUndefined();
    } finally {
      outbox.close();
      blocker.resolve();
      work.resolve();
      readable.resolve();
      await outbox.settle();
    }
  });

  for (const failure of ["throw", "reject"]) {
    it(`keeps a dispatched ${failure} from promoting another attachment`, async () => {
      const { outbox, stats } = newBudgetOutbox({ maxOutstandingEffects: 1 });
      const blockerStarted = Promise.withResolvers<void>();
      const blocker = Promise.withResolvers<void>();
      const tx = {} as IExtendedStorageTransaction;
      const calls: string[] = [];
      outbox.admitSealedEffects([{
        tx,
        context: undefined,
        effects: [{
          id: "fetchTest:blocker",
          kind: "fetchTest-start",
          flush: () => {
            blockerStarted.resolve();
            return blocker.promise;
          },
        }],
      }]);
      try {
        await blockerStarted.promise;
        outbox.admitSealedEffects([{
          tx,
          context: undefined,
          effects: [
            {
              id: "fetchTest:failing",
              kind: "fetchTest-start",
              flush: () => {
                calls.push("first");
                const error = new Error("Dispatched request failed");
                if (failure === "throw") throw error;
                return Promise.reject(error);
              },
            },
            {
              id: "fetchTest:failing",
              kind: "fetchTest-start",
              flush: () => {
                calls.push("second");
              },
            },
          ],
        }]);
        blocker.resolve();
        await outbox.settle();
        expect(calls).toEqual(["first"]);
        expect(stats.outbox.failed).toBe(1);
        expect(stats.outbox.completed).toBe(1);
        expect(outbox.inflightCount).toBe(0);
        expect(outbox.outstandingCount).toBe(0);
      } finally {
        outbox.close();
        blocker.resolve();
        await outbox.settle();
      }
    });
  }

  it("admits a replacement immediately after every attachment fails release", async () => {
    const { outbox, stats, retirements } = newBudgetOutbox({});
    const work = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const readable = Promise.withResolvers<void>();
    const tx = {} as IExtendedStorageTransaction;
    const key = "fetchTest:replacement";
    const calls: string[] = [];
    const replacement = {
      actionId: "replacement",
      kind: "derivation" as const,
    };
    outbox.admitSealedEffects([{
      tx,
      context: undefined,
      effects: [{
        id: key,
        kind: "fetchTest-start",
        flush: () => {
          calls.push("rejected");
          return POST_COMMIT_RELEASE_REJECTED;
        },
      }],
    }]);
    outbox.admitSealedEffects([{
      tx,
      context: replacement,
      effects: [{
        id: key,
        kind: "fetchTest-start",
        flush: () => {
          calls.push("replacement");
          started.resolve();
          return work.promise;
        },
      }],
    }]);
    try {
      await started.promise;
      outbox.deferRetirement(key, readable.promise);
      work.resolve();
      // The retirement alone here: this test's completion count reaches
      // two after the last retirement, so a predicate wanting both at one
      // arrival would wait for an arrival that never comes.
      await awaitEach(retirements, () => outbox.inflightCount === 1);
      expect(stats.outbox.completed).toBe(2);
      expect(outbox.carriageFor(key)).toEqual(replacement);
      outbox.admitSealedEffects([{
        tx,
        context: undefined,
        effects: [{
          id: key,
          kind: "fetchTest-start",
          flush: () => {
            calls.push("duplicate");
          },
        }],
      }]);
      expect(calls).toEqual(["rejected", "replacement"]);
      readable.resolve();
      await outbox.settle();
      expect(calls).toEqual(["rejected", "replacement"]);
      expect(stats.outbox.queued).toBe(2);
      expect(stats.outbox.failed).toBe(0);
      expect(stats.memo.inflight).toBe(0);
      expect(outbox.inflightCount).toBe(0);
    } finally {
      outbox.close();
      work.resolve();
      readable.resolve();
      await outbox.settle();
    }
  });

  it("paces network dispatches by the egress token bucket", async () => {
    // 20/s → the 2-effect tail beyond the burst drains in ~100 ms of
    // real time; the assertions ride edges, never sleeps.
    const { outbox, stats } = newBudgetOutbox({ egressRatePerSecond: 20 });
    const started = new ArrivalLog<string>();
    const held = Array.from(
      { length: 22 },
      (_, index) =>
        heldEffect(`fetchTest:${index}`, "fetchTest-start", started),
    );
    // Release every gate up front: pacing (dispatch), not settlement,
    // is what the bucket bounds.
    for (const entry of held) entry.release();
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: held.map((entry) => entry.effect),
      context: undefined,
    }]);
    // The burst (one second's tokens = 20) dispatches promptly; the
    // remaining 2 hold for refill.
    await started.reached(20);
    expect(stats.outbox.budgetDeferrals).toBeGreaterThanOrEqual(1);
    // The refill drains the paced tail.
    await outbox.settle();
    expect(started.entries.length).toBe(22);
    expect(stats.outbox.completed).toBe(22);
  });

  it("drops budget-held dispatches on close — the park path never egresses for a dead runtime", async () => {
    const { outbox } = newBudgetOutbox({ maxOutstandingEffects: 1 });
    const started = new ArrivalLog<string>();
    const first = heldEffect("llmTest:first", "llmTest-start", started);
    const second = heldEffect("llmTest:second", "llmTest-start", started);
    outbox.admitSealedEffects([{
      tx: {} as IExtendedStorageTransaction,
      effects: [first.effect, second.effect],
      context: undefined,
    }]);
    await started.reached(1);
    // Park: the held dispatch must DROP (crash-equivalent; memo re-miss
    // covers it on re-activation), and retirement must not wedge.
    outbox.close();
    first.release();
    // `close` wakes every held dispatch into its closed check, and the
    // freed slot the release produces is the other thing that could
    // wake one. `settle` runs the in-flight set to empty, so it is
    // ordered after whichever of the two a late dispatch rode.
    await outbox.settle();
    expect(started.entries).toEqual(["llmTest:first"]);
    expect(outbox.inflightCount).toBe(0);
    expect(outbox.outstandingCount).toBe(0);
  });
});
