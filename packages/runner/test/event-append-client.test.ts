// Server-execution v2 Phase 3 (events-down), client half: the
// event-append queue (events.md §5; speculation.md §5; LT9) and the
// fire-time discrimination (protocol.md §1's scheduler tell).
//
// - the queue discharges in FIRED ORDER, one in flight, and classifies
//   outcomes: delivered; duplicate-above-the-horizon AS delivered
//   (events.md §5's duplicate-submission rule — the named
//   `EventAppendDuplicateError` survives the wire for exactly this);
//   deterministic refusals dropped loudly; transient failures retried
//   with backoff, order preserved.
// - LT9 (process-lifetime, re-ruled 2026-08-15): a queue built over the
//   same manager-shared store as a dead predecessor replica discharges
//   the predecessor's intents first, in their fired order (in-process
//   replacement survival — reload survival is a non-goal this round).
// - the fire fork commits ONLY for OUTSIDE-the-scheduler sends (the
//   root fire); a handler's cascade send during the echo commits
//   NOTHING (the server's authoritative run owns the durable cascade).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  ClientCommit,
  StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type EventIntentOutcome,
  SpeculationOverlayDestination,
} from "../src/speculation/overlay-destination.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EventAppendQueue,
  type EventAppendQueueStore,
  memoryEventAppendQueueStore,
  type QueuedEventAppend,
} from "../src/storage/event-append-queue.ts";
import { ArrivalLog } from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  newSharedServer,
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";
import {
  flushMicrotasks,
  scriptedIntentManager,
} from "./speculation-intent-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("event append space");
const space = spaceSigner.did() as MemorySpace;
const aliceSigner = await Identity.fromPassphrase("event append alice");

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const appendOf = (
  eventId: string,
): Omit<QueuedEventAppend, "clientSeq"> => ({
  sidecarId: `of:stream-events:${eventId}`,
  stream: { id: "of:stream", path: ["s"] },
  eventId,
  payload: { eventId },
});

describe("event-append queue (events.md §5, LT9)", () => {
  it("settles a READ principal's authoritative append refusal without retrying it", async () => {
    const server = new MemoryV2Server.Server({
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
    });
    const engine = await server.engineForSpace(space);
    Engine.applyCommit(engine, {
      sessionId: "read-append-genesis",
      space,
      principal: space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [space]: "OWNER", [aliceSigner.did()]: "READ" } },
        }],
      },
    });
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    const session = await client.mount(
      space,
      {},
      testPrincipalSessionOpenAuthFactory(aliceSigner),
    );
    const retried = Promise.withResolvers<"retried">();
    let attempts = 0;
    let refusal: unknown;
    const queue = new EventAppendQueue({
      space,
      nextLocalSeq: () => ++attempts,
      transact: async (commit) => {
        if (attempts > 1) retried.resolve("retried");
        try {
          return await session.transact(commit);
        } catch (error) {
          refusal = error;
          throw error;
        }
      },
    });
    try {
      const result = await Promise.race([
        queue.enqueue(appendOf("reader-denied")),
        retried.promise,
      ]);
      expect(refusal).toMatchObject({
        name: "AuthorizationError",
        permanentEvidence: true,
        aclRevision: 1,
      });
      expect(result).toEqual({
        delivered: false,
        refused: expect.stringContaining("lacks WRITE"),
      });
      expect(attempts).toBe(1);
      expect(queue.pending).toHaveLength(0);
      expect(Engine.serverSeq(engine)).toBe(1);
    } finally {
      queue.close();
      await client.close();
      await server.close();
    }
  });

  it("discharges in fired order, one in flight", async () => {
    const sent = new ArrivalLog<string>();
    let release: (() => void) | undefined;
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.record((commit.eventAppends ?? [])[0]?.eventId ?? "?");
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    const first = queue.enqueue(appendOf("evt-1"));
    const second = queue.enqueue(appendOf("evt-2"));
    await sent.reached(1);
    // Strict serialization: evt-2 must NOT send while evt-1 is in flight
    // (fired-order discharge, events.md §5). A parallel discharge issues
    // both sends in the same synchronous run, so it is already visible
    // in the turn this arrival wakes.
    expect(sent.entries).toEqual(["evt-1"]);
    release!();
    await first;
    await sent.reached(2);
    expect(sent.entries).toEqual(["evt-1", "evt-2"]);
    release!();
    expect(await second).toEqual({ delivered: true });
    queue.close();
  });

  it("classifies outcomes: duplicate-as-delivered; deterministic refusal dropped; transient retried in place", async () => {
    const outcomes: Array<string> = [];
    let failures = 0;
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        const eventId = (commit.eventAppends ?? [])[0]?.eventId ?? "?";
        outcomes.push(`send:${eventId}`);
        if (eventId === "evt-dup") {
          return Promise.reject(
            namedError(
              "EventAppendDuplicateError",
              "duplicates a stream entry",
            ),
          );
        }
        if (eventId === "evt-bad") {
          return Promise.reject(
            namedError("ProtocolError", "undeclared event append"),
          );
        }
        if (eventId === "evt-flaky" && failures < 2) {
          failures += 1;
          return Promise.reject(
            namedError("ConnectionError", "memory client closed"),
          );
        }
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      onRefused: (append) => outcomes.push(`refused:${append.eventId}`),
    });
    // The duplicate resolves DELIVERED — re-raising would re-discharge
    // forever (events.md §5).
    expect(await queue.enqueue(appendOf("evt-dup"))).toEqual({
      delivered: true,
      deduped: true,
    });
    // The deterministic refusal drops the intent, loudly.
    const refused = await queue.enqueue(appendOf("evt-bad"));
    expect(refused.delivered).toBe(false);
    expect(outcomes).toContain("refused:evt-bad");
    // The transient failure retries the SAME head until it lands —
    // nothing behind it jumps the order.
    const flaky = queue.enqueue(appendOf("evt-flaky"));
    const after = queue.enqueue(appendOf("evt-after"));
    expect(await flaky).toEqual({ delivered: true });
    expect(await after).toEqual({ delivered: true });
    const sends = outcomes.filter((o) => o.startsWith("send:"));
    expect(sends.slice(-4)).toEqual([
      "send:evt-flaky",
      "send:evt-flaky",
      "send:evt-flaky",
      "send:evt-after",
    ]);
    queue.close();
  });

  it("retries authorization failures without a permanent current-ACL verdict", async () => {
    for (
      const details of [
        {},
        { permanentEvidence: true },
        { permanentEvidence: true, aclRevision: 1, retriable: true },
      ]
    ) {
      let attempts = 0;
      const queue = new EventAppendQueue({
        space,
        nextLocalSeq: () => ++attempts,
        transact: () =>
          attempts === 1
            ? Promise.reject(
              Object.assign(
                namedError("AuthorizationError", "session challenge"),
                details,
              ),
            )
            : Promise.resolve(),
      });
      try {
        expect(await queue.enqueue(appendOf("auth-recovery"))).toEqual({
          delivered: true,
        });
        expect(attempts).toBe(2);
      } finally {
        queue.close();
      }
    }
  });

  it("duplicate-eventId fires each settle their own outcome (the per-entry keying — a per-id map would wedge the pending-commit barrier)", async () => {
    let calls = 0;
    const queue = new EventAppendQueue({
      space,
      transact: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve() : Promise.reject(
          namedError("EventAppendDuplicateError", "duplicate"),
        );
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    const first = queue.enqueue(appendOf("evt-same"));
    const second = queue.enqueue(appendOf("evt-same"));
    expect(await first).toEqual({ delivered: true });
    expect(await second).toEqual({ delivered: true, deduped: true });
    queue.close();
  });

  it("the server catch-all 'TransactionError' is TRANSIENT — a fault clears on resend, never losing the intent", async () => {
    let failures = 0;
    const queue = new EventAppendQueue({
      space,
      transact: () => {
        if (failures < 1) {
          failures += 1;
          return Promise.reject(
            namedError("TransactionError", "sqlite I/O fault"),
          );
        }
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
    });
    expect(await queue.enqueue(appendOf("evt-fault"))).toEqual({
      delivered: true,
    });
    queue.close();
  });

  it("close() settles every outstanding outcome (a pending-commit barrier holding one must release at teardown)", async () => {
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
    });
    const pending = queue.enqueue(appendOf("evt-stuck"));
    // `enqueue` queues behind the backlog load and persists there, and
    // same-source `.then` callbacks run in registration order, so a
    // continuation registered on `loaded` here runs after the enqueue's
    // and sees the save it issued.
    await queue.loaded;
    await queue.persisted;
    expect(queue.pending.length).toBe(1);
    queue.close();
    const outcome = await pending;
    expect(outcome.delivered).toBe(false);
    // The intent itself stays persisted for a successor queue.
    expect(queue.pending.length).toBe(1);
  });

  it("an enqueue AFTER close settles its outcome and keeps the intent persisted for a successor (review 2026-08-11 n2)", async () => {
    // close() sweeps the outcome map; without the enqueue-side belt a
    // post-close enqueue's promise hung forever — wedging any
    // pending-commit barrier it joined. The INTENT still persists
    // (closed is not refused): the next queue instance discharges it.
    const store = memoryEventAppendQueueStore();
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
      store,
    });
    queue.close();
    const outcome = await queue.enqueue(appendOf("evt-late"));
    expect(outcome.delivered).toBe(false);
    expect(queue.pending.length).toBe(1);
    await queue.persisted;
    expect((await store.load(space)).map((entry) => entry.eventId)).toEqual([
      "evt-late",
    ]);
  });

  it("saves serialize behind the PREVIOUS save (review 2026-08-11 m6/LT9): an async adapter can never complete snapshots out of order", async () => {
    // Pre-fix, #persist chained each save on the LOAD only: two rapid
    // enqueues issued two store.save calls back to back, and an
    // adapter resolving them out of order left the OLDER snapshot
    // durable. The pin: a save never STARTS while the previous one is
    // in flight.
    let manual = true;
    const parked: Array<{ snapshot: string[]; resolve: () => void }> = [];
    const saves = new ArrivalLog<void>();
    const store: EventAppendQueueStore = {
      load: () => Promise.resolve([]),
      save: (_space, entries) => {
        saves.record();
        if (!manual) return Promise.resolve();
        return new Promise<void>((resolve) => {
          parked.push({
            snapshot: entries.map((entry) => entry.eventId),
            resolve,
          });
        });
      },
    };
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
    });
    void queue.enqueue(appendOf("evt-a"));
    void queue.enqueue(appendOf("evt-b"));
    // Two persists are owed. Only the FIRST save may start while it is
    // unresolved.
    await saves.reached(1);
    // A second save issued while the first is unresolved would go out in
    // the same synchronous run as the first, so it is already visible in
    // the turn this arrival wakes.
    expect(saves.entries.length).toBe(1);
    // Resolving the first releases the second — strictly after, with
    // the final queue state.
    parked[0].resolve();
    await saves.reached(2);
    expect(parked[1].snapshot).toEqual(["evt-a", "evt-b"]);
    manual = false;
    parked[1].resolve();
    await queue.persisted;
    queue.close();
  });

  it("LT9: intents persisted by a dead predecessor discharge FIRST, in fired order, from the shared store", async () => {
    const store: EventAppendQueueStore = memoryEventAppendQueueStore();
    // Predecessor: everything fails transient — the intents stay queued
    // (and persisted) at close.
    const dead = new EventAppendQueue({
      space,
      transact: () => Promise.reject(namedError("ConnectionError", "offline")),
      nextLocalSeq: () => 1,
      store,
    });
    void dead.enqueue(appendOf("evt-old-1"));
    void dead.enqueue(appendOf("evt-old-2"));
    await dead.loaded;
    await dead.persisted;
    expect(dead.pending.length).toBe(2);
    dead.close();

    // Successor over the SAME store: the reloaded intents discharge
    // ahead of the fresh fire, in their fired order, and clientSeq
    // continues past the persisted ones (one session's append order).
    const sent = new ArrivalLog<string>();
    const revived = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.record((commit.eventAppends ?? [])[0]?.eventId ?? "?");
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
    });
    await revived.loaded;
    expect(await revived.enqueue(appendOf("evt-new"))).toEqual({
      delivered: true,
    });
    expect(sent.entries).toEqual(["evt-old-1", "evt-old-2", "evt-new"]);
    // Everything delivered ⇒ the store drained (a queue that empties).
    // Durability is OBSERVED through `persisted` (its documented
    // purpose): the settle-side saves are chained, not synchronous.
    await revived.persisted;
    expect((await store.load(space)).length).toBe(0);
    revived.close();
  });

  it("a fire racing the backlog load never re-uses a persisted clientSeq (verdict blocker, 2026-08-12): allocation waits for the load", async () => {
    const store: EventAppendQueueStore = memoryEventAppendQueueStore();
    // Persist a backlog with clientSeqs 0 and 1.
    await store.save(space, [
      { ...appendOf("evt-persisted-0"), clientSeq: 0 },
      { ...appendOf("evt-persisted-1"), clientSeq: 1 },
    ]);
    // A store whose LOAD is slow: the fire arrives mid-load.
    let releaseLoad: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const slowStore: EventAppendQueueStore = {
      load: async (loadSpace) => {
        await gate;
        return store.load(loadSpace);
      },
      save: (saveSpace, entries) => store.save(saveSpace, entries),
    };
    const sent = new ArrivalLog<number>();
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        const entry = ((commit.operations[0] as {
          patches?: Array<
            { values?: Array<{ firedAt?: { clientSeq?: number } }> }
          >;
        }).patches ?? [])[0]?.values?.[0];
        sent.record(entry?.firedAt?.clientSeq ?? -1);
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store: slowStore,
    });
    // Fire BEFORE the load completes. Pre-fix this allocated clientSeq 0
    // synchronously — colliding with evt-persisted-0's.
    const outcome = queue.enqueue(appendOf("evt-racing"));
    releaseLoad();
    expect(await outcome).toEqual({ delivered: true });
    await sent.reached(3);
    // Persisted 0, 1 first (fired order), then the racer at an UNUSED
    // seq (2) — never a duplicate.
    expect(sent.entries).toEqual([0, 1, 2]);
    expect(new Set(sent.entries).size).toBe(3);
    queue.close();
  });
});

describe("OW27 event-flood shaping — per-stream pacing, pace-never-drop (README §3.8; RULED (a) 2026-08-15)", () => {
  // A key-repeat flood: N sends on ONE stream in the same tick. The
  // bucket lets `burst` through immediately and paces the rest at
  // `ratePerSecond`; every send still commits, in fired order — no
  // coalescing, no drop. Real clock (the file is on the real-clock list).
  const floodOf = (n: number, stream = "flood") =>
    Array.from({ length: n }, (_, i) => ({
      ...appendOf(`evt-${stream}-${i}`),
      sidecarId: `of:stream-events:${stream}`,
    }));

  it("bounds the commit rate of a flood WITHOUT losing or reordering a single intent", async () => {
    const sentAt: Array<{ id: string; at: number }> = [];
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sentAt.push({
          id: (commit.eventAppends ?? [])[0]?.eventId ?? "?",
          at: Date.now(),
        });
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      pacing: { ratePerSecond: 100, burst: 10 },
    });
    const flood = floodOf(40);
    const started = Date.now();
    const outcomes = await Promise.all(
      flood.map((entry) => queue.enqueue(entry)),
    );
    const elapsed = Date.now() - started;
    // ZERO loss: every send delivered…
    expect(outcomes.every((o) => o.delivered)).toBe(true);
    // …in fired order…
    expect(sentAt.map((s) => s.id)).toEqual(flood.map((e) => e.eventId));
    // …at a BOUNDED rate: 10 pass on the burst, the remaining 30 drain at
    // ≤100/s, so the flood takes ≥ ~300 ms and no 100 ms window carries
    // more than burst + rate·window (+1 for boundary rounding).
    expect(elapsed).toBeGreaterThanOrEqual(250);
    let maxWindow = 0;
    for (let i = 0; i < sentAt.length; i++) {
      let count = 0;
      for (
        let j = i;
        j < sentAt.length && sentAt[j].at - sentAt[i].at <= 100;
        j++
      ) {
        count += 1;
      }
      maxWindow = Math.max(maxWindow, count);
    }
    expect(maxWindow).toBeLessThanOrEqual(21);
    expect(queue.pacedHoldCount).toBeGreaterThanOrEqual(20);
    queue.close();
  });

  it("MUTATION WITNESS: with pacing disabled the same flood is unbounded (every send in one tick)", async () => {
    // Documents what the guard protects: `pacing: false` is the ablation
    // the OW27 register row names — the OFF arm never constructs this
    // queue, so this is the flag-gated path with its bound removed.
    const sentAt: number[] = [];
    const queue = new EventAppendQueue({
      space,
      transact: () => {
        sentAt.push(Date.now());
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      pacing: false,
    });
    const started = Date.now();
    await Promise.all(floodOf(40).map((entry) => queue.enqueue(entry)));
    expect(sentAt.length).toBe(40);
    expect(Date.now() - started).toBeLessThan(200);
    expect(queue.pacedHoldCount).toBe(0);
    queue.close();
  });

  it("close() during a pacing hold settles the held outcomes (no dispose-time wedge) and keeps the intents queued for a successor", async () => {
    const store = memoryEventAppendQueueStore();
    const pacedHolds = new ArrivalLog<void>();
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.resolve(),
      nextLocalSeq: () => 1,
      store,
      // One send per second, burst 1: the second send is HELD.
      pacing: { ratePerSecond: 1, burst: 1 },
      onPacedHold: pacedHolds.record,
    });
    // Same STREAM (pacing is per stream — a second stream would get its
    // own fresh bucket).
    const [holdOne, holdTwo] = floodOf(2, "hold");
    const first = queue.enqueue(holdOne);
    const second = queue.enqueue(holdTwo);
    expect(await first).toEqual({ delivered: true });
    // Close INSIDE the hold: the queue reports the hold as it begins.
    await pacedHolds.reached(1);
    expect(queue.pacedHoldCount).toBeGreaterThanOrEqual(1);
    queue.close();
    expect(await second).toEqual({
      delivered: false,
      refused: "event queue closed",
    });
    await queue.persisted;
    // The held intent is not lost: it stays persisted for the successor
    // (closed is not refused — the same rule as the retry-backoff close).
    expect((await store.load(space)).map((e) => e.eventId)).toEqual([
      holdTwo.eventId,
    ]);
  });

  it("holds and then sends even when the paced-hold observer throws: the hold's own release still runs", async () => {
    // The observer is a test diagnostic, reported from inside the hold's
    // promise executor, so a throw that escaped would reject the drain
    // and strand the held send.
    const store = memoryEventAppendQueueStore();
    const queue = new EventAppendQueue({
      space,
      transact: () => Promise.resolve(),
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      store,
      // One send per second, burst 1: the second send is HELD.
      pacing: { ratePerSecond: 1, burst: 1 },
      onPacedHold: () => {
        throw new Error("paced-hold observer failure (test-injected)");
      },
    });
    const [holdOne, holdTwo] = floodOf(2, "throwing-hold");
    const first = queue.enqueue(holdOne);
    const second = queue.enqueue(holdTwo);
    expect(await first).toEqual({ delivered: true });
    expect(await second).toEqual({ delivered: true });
    expect(queue.pacedHoldCount).toBeGreaterThanOrEqual(1);
    queue.close();
    await queue.persisted;
  });

  it("streams are INDEPENDENT: a paced head on stream A does not hold stream B (no cross-stream head-of-line hold), and each stream's own fired order stays exact", async () => {
    // Adopted from the P7 independent review's cross-stream probe
    // (finding 5) with the ruled semantics: pacing is PER STREAM (the
    // buckets are keyed by sidecar), so a stream that has exhausted its
    // burst holds only ITS OWN later sends — an unrelated stream with a
    // token in its bucket sends now. Pre-fix the queue sent strictly the
    // fired-order head, so b1 waited behind a2's ~500 ms hold; a
    // "send the head only" mutation of #drain turns this red (b1 lands
    // at ≥400 ms), and a "per-stream order lost" mutation turns the
    // a1<a2 / b1<b2 assertions red.
    const sent: Array<{ id: string; at: number }> = [];
    const queue = new EventAppendQueue({
      space,
      transact: (commit: ClientCommit) => {
        sent.push({
          id: (commit.eventAppends ?? [])[0]?.eventId ?? "?",
          at: Date.now(),
        });
        return Promise.resolve();
      },
      nextLocalSeq: (() => {
        let seq = 1;
        return () => seq++;
      })(),
      // burst 1, 2/s: a stream's second send is held ~500 ms.
      pacing: { ratePerSecond: 2, burst: 1 },
    });
    const t0 = Date.now();
    const [a1, a2, a3] = floodOf(3, "A");
    const [b1, b2] = floodOf(2, "B");
    // Fired order: a1, a2, b1, b2, a3.
    const outcomes = await Promise.all([
      queue.enqueue(a1),
      queue.enqueue(a2),
      queue.enqueue(b1),
      queue.enqueue(b2),
      queue.enqueue(a3),
    ]);
    expect(outcomes.every((o) => o.delivered)).toBe(true);
    const at = (id: string) => sent.find((s) => s.id === id)!.at - t0;
    const order = sent.map((s) => s.id);
    // Within a stream fired order is exact.
    expect(order.indexOf(a1.eventId)).toBeLessThan(order.indexOf(a2.eventId));
    expect(order.indexOf(a2.eventId)).toBeLessThan(order.indexOf(a3.eventId));
    expect(order.indexOf(b1.eventId)).toBeLessThan(order.indexOf(b2.eventId));
    // b1 (B's burst) sends immediately, NOT behind a2's hold; b2 waits
    // only on B's own bucket (~500 ms), never on A's.
    expect(at(b1.eventId)).toBeLessThan(250);
    expect(at(a2.eventId)).toBeGreaterThanOrEqual(400);
    expect(at(b2.eventId)).toBeGreaterThanOrEqual(400);
    // a3 waits for A's SECOND refill (~1 s), independent of B.
    expect(at(a3.eventId)).toBeGreaterThanOrEqual(900);
    expect(at(a3.eventId)).toBeLessThan(1500);
    // Every intent still delivered — pace-never-drop holds across streams.
    expect(sent.length).toBe(5);
    queue.close();
  });
});

describe("intent outcome consumption (events.md §5's client signal)", () => {
  it("consequenced retires; dropped/errored retire AND signal; the intent listener releases with its last tracked id", async () => {
    // Destination-level pins over the SCRIPTED STORAGE-NOTIFICATION seam
    // (stage C design (e), RULED 2026-08-18): the notice arms, the
    // retirement calls, the subscriber signal, and the listener release —
    // the "client MUST be signaled" machinery (events.md §5) that the e2e
    // suites exercise only incidentally (the watermark backstop also
    // retires echoes there, so without these pins the mechanism was
    // feature-deletion-survivable). The seam is the one production
    // consumes — `storageManager.subscribe` + the raw replica read — not a
    // hand-stubbed `cell.sink` (retired with the sink); the full pin set
    // (visits, microtask, release, T25, no scheduler node, OFF) lives in
    // `speculation-intent-listener.test.ts`.

    const scripted = scriptedIntentManager();
    const runtimeStub = { storageManager: scripted.manager } as never;
    const destination = new SpeculationOverlayDestination(runtimeStub);
    const outcomes: string[] = [];
    const outcomeDetails: EventIntentOutcome[] = [];
    const unsubscribe = destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
      outcomeDetails.push(outcome);
    });
    const SPACE = "did:key:stub" as never;
    const SIDECAR = "of:stream-events:a";
    scripted.seed(SPACE, SIDECAR, { entries: [] });

    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    destination.trackIntent(SPACE, SIDECAR, "evt-3");
    expect(destination.intentListenerInstalled).toBe(true);
    expect(scripted.subscribers.size).toBe(1);

    const feed = (
      entries: NonNullable<StreamEventsDocValue["entries"]>,
      paths?: string[][],
    ) => {
      scripted.deliver(SPACE, SIDECAR, (value) => {
        value.entries = entries;
      }, paths);
      return flushMicrotasks();
    };
    const stream = { id: "of:stream", path: ["s"] };
    // consequenced: retires silently (no outcome signal).
    await feed([{ eventId: "evt-1", stream, consequenced: true }]);
    expect(destination.pendingIntentCount).toBe(2);
    // errored: retires AND signals.
    await feed([
      { eventId: "evt-1", stream, consequenced: true },
      { eventId: "evt-2", stream, consequenced: true, error: "boom" },
    ], [["value", "entries", "1", "consequenced"], [
      "value",
      "entries",
      "1",
      "error",
    ]]);
    // dropped: retires AND signals; the LAST tracked id releases the
    // listener.
    await feed([
      { eventId: "evt-1", stream, consequenced: true },
      { eventId: "evt-2", stream, consequenced: true, error: "boom" },
      { eventId: "evt-3", stream, status: "dropped", reason: "gone" },
    ], [["value", "entries", "2", "status"]]);
    expect(outcomes).toEqual(["errored:evt-2", "dropped:evt-3"]);
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentListenerInstalled).toBe(false);
    expect(scripted.subscribers.size).toBe(0);

    // The refusal path (a deterministic admission refusal at
    // discharge): retires + signals without any store state.
    destination.trackIntent(SPACE, "of:stream-events:b", "evt-r");
    destination.resolveIntent(SPACE, "of:stream-events:b", "evt-r", {
      kind: "refused",
      reason: "undeclared",
    });
    expect(outcomes).toEqual([
      "errored:evt-2",
      "dropped:evt-3",
      "refused:evt-r",
    ]);
    expect(destination.intentListenerInstalled).toBe(false);

    destination.trackIntent(SPACE, SIDECAR, "evt-user");
    destination.trackIntent(SPACE, SIDECAR, "evt-userless");
    const attention = {
      phase: "dispatch-load" as const,
      failureClass: "timeout" as const,
      code: "delivery-failure-budget-exhausted" as const,
      firstFailureAt: 1,
      lastFailureAt: 2,
      accumulatedFailureMs: 60_000,
      failureCount: 2,
      recovery: "explicit-retry" as const,
    };
    await feed([{
      eventId: "evt-user",
      stream,
      seq: 4,
      status: "needs-attention",
      reason: "user event",
      attention,
      firedAt: { user: aliceSigner.did(), session: "alice" },
    }, {
      eventId: "evt-userless",
      stream,
      seq: 5,
      status: "needs-attention",
      reason: "system event",
      attention,
      firedAt: { session: "server" },
    }], [["value", "entries"]]);
    expect(
      outcomeDetails.find((outcome) => outcome.eventId === "evt-user")
        ?.retryable,
    ).toBe(true);
    expect(
      outcomeDetails.find((outcome) => outcome.eventId === "evt-userless")
        ?.retryable,
    ).toBe(false);
    expect(destination.intentListenerInstalled).toBe(false);
    unsubscribe();
    destination.close();
  });
});

describe("the fire fork (protocol.md §1's scheduler tell)", () => {
  let server: MemoryV2Server.Server;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a root fire commits ONE append; a handler's cascade send during the echo commits NOTHING (the server owns the durable cascade)", async () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    // Two chained handlers: firing `first` cascades into `second`.
    const CASCADE_PATTERN = [
      "import { handler, pattern, Stream, Writable } from 'commonfabric';",
      "const secondHandler = handler<unknown, { value: Writable<number> }>(",
      "  (_ev, { value }) => { value.set((value.get() ?? 0) + 10); },",
      ");",
      "const firstHandler = handler<",
      "  unknown,",
      "  { value: Writable<number>; second: Stream<unknown> }",
      ">((_ev, { value, second }) => {",
      "  value.set((value.get() ?? 0) + 1);",
      "  second.send({});",
      "});",
      "export default pattern<",
      "  { value: Writable<number> },",
      "  { value: number; first: Stream<unknown>; second: Stream<unknown> }",
      ">(({ value }) => {",
      "  const second = secondHandler({ value });",
      "  return { value, first: firstHandler({ value, second }), second };",
      "});",
    ].join("\n");
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: CASCADE_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ value: number }>(
      space,
      "cascade-arg",
      undefined,
    );
    const result = clientRuntime.getCell<
      { value: number; first: unknown; second: unknown }
    >(
      space,
      "cascade-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    const before = Engine.serverSeq(engine);
    result.key("first").send({});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The echo ran the WHOLE cascade locally (1 + 10)...
    await waitForCellValue<number>(
      clientRuntime,
      argument.key("value"),
      (value) => value === 11,
      { stuckLabel: "the cascade to render 11" },
    );
    // ...but the store received exactly ONE authored commit — the ROOT
    // fire's append. The cascade send happened inside a
    // scheduler-stamped run, and scheduler work commits nothing
    // client-side (protocol.md §1's tell; events.md §2).
    const records = Engine.selectCommitsSince(engine, { fromSeq: before });
    expect(records.length).toBe(1);
    const sidecars = Engine.selectPendingStreamEventDocs(engine);
    expect(sidecars.length).toBe(1);
    expect(sidecars[0].entries.length).toBe(1);
    cancelDemand();
  });
});
