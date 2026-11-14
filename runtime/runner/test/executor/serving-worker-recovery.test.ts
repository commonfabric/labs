/**
 * What a `ServingWorkerPool` does when one of its workers fails, cannot
 * start, or goes silent, over stand-in workers and a stand-in memory server:
 * which spaces are placed again, when, and what becomes of the leases the
 * worker held.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import { stub } from "@std/testing/mock";
import { defer } from "@commonfabric/async/defer";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  acquireServerExecutionEnabler,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import { SpaceNotServedError } from "../../src/executor/host.ts";
import {
  ServingWorkerPool,
  type ServingWorkerPoolOptions,
} from "../../src/executor/serving-worker-host.ts";
import {
  type ServingThreadOptions,
  startServingThread,
} from "../../src/executor/serving-thread.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  admittedNotice,
  FakeMemoryServer,
  type FakeServingWorker,
  fakeServingWorkers,
} from "../support/fake-serving-workers.ts";

const identity = await Identity.fromPassphrase("serving-worker-recovery");
const space = "did:key:z6MkServingWorkerRecovery" as MemorySpace;
const other = "did:key:z6MkServingWorkerRecoveryOther" as MemorySpace;
const third = "did:key:z6MkServingWorkerRecoveryThird" as MemorySpace;

describe("serving-worker-recovery", () => {
  let fakes: ReturnType<typeof fakeServingWorkers>;
  let server: FakeMemoryServer;
  let pool: ServingWorkerPool | undefined;

  /** The stand-in workers spawned so far. */
  const workers = (): FakeServingWorker[] => fakes.workers;

  /** Starts the pool under test, whose first failure backs off 10 ms. */
  const start = (
    over: Partial<ServingWorkerPoolOptions> = {},
  ): ServingWorkerPool => {
    pool = new ServingWorkerPool({
      server: server.asServer,
      identity,
      apiUrl: new URL(import.meta.url),
      policy: { failureParkBackoffBaseMs: 10 },
      ...over,
    });
    return pool;
  };

  /** The lease holder `worker`'s host acquires under. */
  const holderOf = (worker: FakeServingWorker): string =>
    executionLeaseHolder(identity.did(), worker.processInstanceId);

  beforeEach(() => {
    fakes = fakeServingWorkers();
    server = new FakeMemoryServer();
    pool = undefined;
  });

  afterEach(async () => {
    await pool?.close();
    fakes[Symbol.dispose]();
  });

  describe("a worker that fails", () => {
    it("is terminated, has its leases released, and has its space placed on a fresh worker after the backoff", async () => {
      const closed: unknown[] = [];
      const started = start({
        onWorkerClosed: (spaces, cause) => closed.push([spaces, cause]),
      });
      server.openSession(space, "session-1");
      await clock.settle();
      const [failing] = workers();
      const holder = holderOf(failing);
      expect(server.executionLeases.acquire(space, holder)).toBe(true);

      failing.fail();
      await clock.settle();
      expect(failing.terminated).toBe(true);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
      expect(closed).toEqual([[[space], "failed"]]);
      expect(workers()).toHaveLength(1);
      expect(started.stats().workers).toMatchObject({ serving: 0, failed: 1 });

      await clock.tick(9);
      expect(workers()).toHaveLength(1);
      await clock.tick(1);
      expect(workers()).toHaveLength(2);
      await clock.settle();
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space },
      ]);
      expect(holderOf(workers()[1])).not.toBe(holder);
    });

    it("leaves a space with nothing to serve unplaced once the backoff has passed", async () => {
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      server.closeSession(space, "session-1");
      workers()[0].fail();
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(1);
    });

    it("leaves the other spaces' workers serving", async () => {
      const started = start();
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      const [failing, healthy] = workers();
      failing.fail();
      await clock.settle();
      expect(healthy.terminated).toBe(false);
      expect(started.stats().workers.serving).toBe(1);

      const notice = admittedNotice(other, { seq: 3 });
      server.admit(notice);
      await clock.settle();
      expect(healthy.receivedOf("observer.commitAdmitted")).toEqual([
        { notice },
      ]);
    });

    it("has the warm commit it had taken, and one admitted during the backoff, handed to the space's next worker", async () => {
      // A warm request is a one-shot signal, so the commit the failed worker
      // took and committed no wave for is owed again.

      start();
      const taken = admittedNotice(space, { warm: true, seq: 1 });
      server.admit(taken);
      await clock.settle();
      workers()[0].fail();
      await clock.settle();
      const during = admittedNotice(space, { warm: true, seq: 2 });
      server.admit(during);
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.commitAdmitted")).toEqual([
        { notice: taken },
        { notice: during },
      ]);
    });

    it("leaves its space unplaced when a wave committed in the space after the warm commit it took", async () => {
      using _commit = stub(
        EngineWaveCommitSink.prototype,
        "commitWave",
        () => Promise.resolve({ ok: { seq: 2 } }),
      );
      server.openEngine = () => Promise.resolve({} as Engine.Engine);
      start();
      server.admit(admittedNotice(space, { warm: true, seq: 1 }));
      await clock.settle();
      const [worker] = workers();
      await worker.host.request("sink.commitWave", {
        sessionId: holderOf(worker),
        localSeq: 1,
        batch: encodeMemoryBoundary({ space } as unknown as FabricValue),
      });
      worker.fail();
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(1);
    });

    it("has its space placed again when the space's store holds undelivered events, with no session and no commit owed", async () => {
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      server.closeSession(space, "session-1");
      server.holdEvents(space);
      workers()[0].fail();
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
    });

    it("is what a worker counts as when its host's close throws, and its space is placed again at the next trigger", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        worker.host.onRequest("host.retire", () => {
          throw new Error("a park failed while the host closed");
        });
        worker.serve();
      });
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      server.closeSession(space, "session-1");
      const [closing] = workers();
      closing.report("vacant");
      await clock.settle();
      expect(closing.terminated).toBe(true);
      expect(started.stats().workers).toMatchObject({ failed: 1, retired: 0 });

      await clock.tick(10);
      await clock.settle();
      server.openSession(space, "session-2");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space },
      ]);
    });

    it("has a lifecycle verb for its space refused with `SpaceNotServedError` until the space is placed again", async () => {
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].fail();
      await clock.settle();
      await expect(
        started.runLifecycleVerb(space, { name: "upload", request: {} }),
      ).rejects.toThrow(SpaceNotServedError);
    });

    it("keeps the counters its host last posted in the pool's, with its levels at zero", async () => {
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].host.notify("host.stats", {
        stats: { ...emptyServingLoopStats(), waves: 3, activeSpaces: 1 },
      });
      await clock.settle();
      workers()[0].fail();
      expect(started.stats()).toMatchObject({ waves: 3, activeSpaces: 0 });
    });

    it("places nothing again once the pool has closed during the backoff", async () => {
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].fail();
      await started.close();
      await clock.tick(1_000);
      expect(workers()).toHaveLength(1);
      expect(workers()[0].terminated).toBe(true);
    });
  });

  describe("a worker whose host cannot start", () => {
    it("is terminated, and its space is placed on a fresh worker after the backoff", async () => {
      let starts = 0;
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        starts += 1;
        if (starts === 1) worker.refuse("init failed");
        else worker.serve();
      });
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(started.stats().workers.failed).toBe(1);

      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space },
      ]);
    });

    it("has a lifecycle verb that placed its space refused with `SpaceNotServedError`", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => worker.refuse("init failed"));
      const started = start();
      await expect(
        started.runLifecycleVerb(space, { name: "upload", request: {} }),
      ).rejects.toThrow(SpaceNotServedError);
    });

    it("rejects `ready` when it is a spare started with the pool", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => worker.refuse("init failed"));
      const started = start({ spareWorkers: 1 });
      await expect(started.ready).rejects.toThrow("init failed");
    });
  });

  describe("the backoff", () => {
    /** Fails the worker `space` is on, and returns the one it is placed on next. */
    const replaceAfter = async (ms: number): Promise<FakeServingWorker> => {
      const before = workers().length;
      workers().at(-1)!.fail();
      await clock.tick(ms - 1);
      expect(workers()).toHaveLength(before);
      await clock.tick(1);
      await clock.settle();
      expect(workers()).toHaveLength(before + 1);
      return workers().at(-1)!;
    };

    it("widens across a space's consecutive failures, and starts over once a worker commits a wave for the space", async () => {
      using _commit = stub(
        EngineWaveCommitSink.prototype,
        "commitWave",
        () => Promise.resolve({ ok: { seq: 1 } }),
      );
      server.openEngine = () => Promise.resolve({} as Engine.Engine);
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      await replaceAfter(10);
      const second = await replaceAfter(20);
      await second.host.request("sink.commitWave", {
        sessionId: holderOf(second),
        localSeq: 1,
        batch: encodeMemoryBoundary({ space } as unknown as FabricValue),
      });
      await replaceAfter(10);
    });

    it("keeps widening past a wave the store refused", async () => {
      using _commit = stub(
        EngineWaveCommitSink.prototype,
        "commitWave",
        () =>
          Promise.resolve({
            error: { name: "ConflictError", message: "refused" } as never,
          }),
      );
      server.openEngine = () => Promise.resolve({} as Engine.Engine);
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      const first = await replaceAfter(10);
      await first.host.request("sink.commitWave", {
        sessionId: holderOf(first),
        localSeq: 1,
        batch: encodeMemoryBoundary({ space } as unknown as FabricValue),
      });
      await replaceAfter(20);
    });

    it("of one space leaves another space's first failure at the base delay", async () => {
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      await replaceAfter(10);
      await replaceAfter(20);

      server.openSession(other, "session-2");
      await clock.settle();
      await replaceAfter(10);
    });

    it("paces a spare's replacement, and widens while spares keep failing", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => worker.refuse("init failed"));
      const started = start({ spareWorkers: 1 });
      await started.ready.catch(() => {});
      await clock.settle();
      expect(workers()).toHaveLength(1);
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      await clock.tick(19);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      await clock.tick(1);
      await clock.settle();
      expect(workers()).toHaveLength(3);
    });

    it("widens while spares fail in the turn their hosts answer `worker.init`", async () => {
      // Deno dispatches a worker's messages and its errors from promise
      // continuations, so an answer and an error that arrive together run
      // both handlers before the continuation the answer resolves. Each
      // stand-in plays that: once its answer has been read, its failure is
      // queued ahead of the pool's continuation for it.
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        worker.serve();
        worker.addEventListener("message", (event) => {
          if (event.data.t === "ok") queueMicrotask(() => worker.fail());
        });
      });
      start({ spareWorkers: 1 });
      await clock.settle();
      expect(workers()).toHaveLength(1);
      expect(workers()[0].terminated).toBe(true);
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      await clock.tick(19);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      await clock.tick(1);
      await clock.settle();
      expect(workers()).toHaveLength(3);
    });
  });

  describe("a worker whose heap reaches its limit", () => {
    const MB = 1024 * 1024;

    /**
     * Starts the pool with a 100 MB heap limit over the stand-in workers,
     * which a thread started with a heap limit would not be.
     */
    const startLimited = (
      over: Partial<ServingWorkerPoolOptions> = {},
    ): ServingWorkerPool =>
      start({
        heapLimitMb: 100,
        startThread: (module, { onFailed }) =>
          startServingThread(module, { onFailed }),
        ...over,
      });

    /** The spaces placed on `worker`, as the pool has them. */
    const spacesOn = (
      started: ServingWorkerPool,
      worker: FakeServingWorker,
    ): string[] =>
      [...started.accessForTestingOnly.placements].flatMap(([placed, on]) =>
        on.worker.port === worker ? [placed] : []
      );

    it("leaves a worker serving whose heap is larger than the limit and has not reached it", async () => {
      // The limit bounds the heap's old generation, and the heap a worker
      // reports is all of it, so the size alone ends no worker.
      startLimited();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].beat(120 * MB, { external: 100 * MB - 1 });
      await clock.settle();
      expect(workers()[0].terminated).toBe(false);
    });

    it("is what a worker counts as whose buffers outside the heap come to the limit", async () => {
      const started = startLimited();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].beat(MB, { external: 100 * MB });
      await clock.tick(60_000);
      expect(workers()).toHaveLength(1);
      expect(workers()[0].terminated).toBe(true);
      expect(started.stats().workers).toMatchObject({
        heapLimited: 1,
        heapStopped: 1,
      });
    });

    it("ends a worker that says it reached a limit the pool was given none of", async () => {
      // A thread started by a `startThread` of the caller's own.
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true, external: 4096 * MB });
      await clock.tick(60_000);
      expect(workers()).toHaveLength(1);
      expect(workers()[0].terminated).toBe(true);
      expect(started.stats().workers.heapStopped).toBe(1);
    });

    it("is ended, and leaves the one space it served unplaced whatever session or event the space has", async () => {
      const closed: unknown[] = [];
      const started = startLimited({
        onWorkerClosed: (spaces, cause) => closed.push([spaces, cause]),
      });
      server.openSession(space, "session-1");
      await clock.settle();
      server.holdEvents(space);
      const [grown] = workers();
      const holder = holderOf(grown);
      expect(server.executionLeases.acquire(space, holder)).toBe(true);

      grown.beat(MB, { heapLimitReached: true });
      await clock.settle();
      expect(grown.terminated).toBe(true);
      expect(closed).toEqual([[[space], "failed"]]);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
      expect(started.stats().workers).toMatchObject({
        serving: 0,
        failed: 1,
        heapLimited: 1,
        heapStopped: 1,
      });

      // Neither the session still live on the space, nor the events its
      // store holds, nor another session's open places it again.
      await clock.tick(60_000);
      server.openSession(space, "session-2");
      await clock.tick(60_000);
      expect(workers()).toHaveLength(1);
      expect(started.stats().workers.heapStopped).toBe(1);
    });

    it("has its space placed again by a commit admitted after it was ended, and by none it had taken", async () => {
      const started = startLimited();
      server.openSession(space, "session-1");
      server.admit(admittedNotice(space, { seq: 1, warm: true }));
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(60_000);
      expect(workers()).toHaveLength(1);

      const notice = admittedNotice(space, { seq: 2 });
      server.admit(notice);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.commitAdmitted")).toEqual([
        { notice },
      ]);
      expect(started.stats().workers.heapStopped).toBe(0);
    });

    it("has its space placed again by a lifecycle verb that names it", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        worker.host.onRequest(
          "host.runLifecycleVerb",
          ({ space }) => Promise.resolve({ receipt: space, timings: [] }),
        );
        worker.serve();
      });
      const started = startLimited();
      server.openSession(space, "session-1");
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(1);

      const run = await started.runLifecycleVerb(space, {
        name: "upload",
        request: {},
      });
      expect(run.receipt).toBe(space);
      expect(workers()).toHaveLength(2);
    });

    it("paces a commit admitted while it backs off, and widens across the space's kills whatever waves its workers commit", async () => {
      using _commit = stub(
        EngineWaveCommitSink.prototype,
        "commitWave",
        () => Promise.resolve({ ok: { seq: 1 } }),
      );
      server.openEngine = () => Promise.resolve({} as Engine.Engine);
      startLimited();
      server.openSession(space, "session-1");
      await clock.settle();

      /** Ends the space's worker at its limit, then admits a commit. */
      const placedAgainAfter = async (ms: number, seq: number) => {
        const before = workers().length;
        workers().at(-1)!.beat(MB, { heapLimitReached: true });
        await clock.settle();
        server.admit(admittedNotice(space, { seq }));
        await clock.tick(ms - 1);
        expect(workers()).toHaveLength(before);
        await clock.tick(1);
        await clock.settle();
        expect(workers()).toHaveLength(before + 1);
        return workers().at(-1)!;
      };
      const second = await placedAgainAfter(10, 2);
      await second.host.request("sink.commitWave", {
        sessionId: holderOf(second),
        localSeq: 1,
        batch: encodeMemoryBoundary({ space } as unknown as FabricValue),
      });
      await placedAgainAfter(20, 3);
      await placedAgainAfter(40, 4);
    });

    it("has each of the spaces that shared it placed on a worker of its own, which no other space joins", async () => {
      const started = startLimited({ maxWorkers: 1 });
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      const [shared] = workers();
      expect(spacesOn(started, shared).sort()).toEqual([other, space].sort());

      shared.beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(3);
      expect(spacesOn(started, workers()[1])).toHaveLength(1);
      expect(spacesOn(started, workers()[2])).toHaveLength(1);
      expect(started.stats().workers.heapStopped).toBe(0);

      // The pool is over its cap of one, and a space placed now gets a
      // worker that is not one of theirs.
      server.openSession(third, "session-3");
      await clock.settle();
      expect(workers()).toHaveLength(4);
      expect(spacesOn(started, workers()[3])).toEqual([third]);
    });

    it("stops the space whose own worker is then ended, and leaves the one it had shared with serving", async () => {
      const started = startLimited({ maxWorkers: 1 });
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      const growing = workers().slice(1).find((worker) =>
        spacesOn(started, worker)[0] === space
      )!;
      const steady = workers().slice(1).find((worker) =>
        spacesOn(started, worker)[0] === other
      )!;

      growing.beat(MB, { heapLimitReached: true });
      await clock.tick(60_000);
      expect(workers()).toHaveLength(3);
      expect(steady.terminated).toBe(false);
      expect(started.stats().workers).toMatchObject({
        serving: 1,
        heapLimited: 2,
        heapStopped: 1,
      });
    });

    it("counts no failure against the spaces that shared it", async () => {
      const started = startLimited({ maxWorkers: 1 });
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      const steady = workers().slice(1).find((worker) =>
        spacesOn(started, worker)[0] === other
      )!;

      // The space's first failure of its own backs off the base delay.
      steady.fail();
      await clock.tick(9);
      expect(workers()).toHaveLength(3);
      await clock.tick(1);
      await clock.settle();
      expect(workers()).toHaveLength(4);
    });

    it("lets a space share a worker again once a worker of its own has closed with nothing left to serve", async () => {
      const started = startLimited({ maxWorkers: 1 });
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      const own = workers().slice(1).find((worker) =>
        spacesOn(started, worker)[0] === other
      )!;
      const kept = workers().slice(1).find((worker) =>
        spacesOn(started, worker)[0] === space
      )!;
      server.closeSession(other, "session-2");
      own.report("vacant");
      await clock.settle();
      expect(own.terminated).toBe(true);

      // `maxWorkers: 1` would have it join a worker that takes a second
      // space; the one worker left is another space's own, so it gets a fresh
      // one, and the next space joins that.
      server.openSession(other, "session-4");
      await clock.settle();
      expect(workers()).toHaveLength(4);
      server.openSession(third, "session-3");
      await clock.settle();
      expect(workers()).toHaveLength(4);
      expect(spacesOn(started, workers()[3]).sort()).toEqual(
        [other, third].sort(),
      );
      expect(spacesOn(started, kept)).toEqual([space]);
    });

    it("leaves the space unplaced as well when the thread itself reports that it reached its limit", async () => {
      const reports: ServingThreadOptions["onFailed"][] = [];
      const started = startLimited({
        startThread: (module, { onFailed }) => {
          reports.push(onFailed);
          return startServingThread(module, { onFailed });
        },
      });
      server.openSession(space, "session-1");
      await clock.settle();

      reports[0]("JS heap out of memory", { atHeapLimit: true });
      await clock.tick(60_000);
      expect(workers()).toHaveLength(1);
      expect(workers()[0].terminated).toBe(true);
      expect(started.stats().workers).toMatchObject({
        heapLimited: 1,
        heapStopped: 1,
      });
    });

    it("throws for a limit no thread can be started with", () => {
      for (const heapLimitMb of [0, 4, 15, 100.5, Number.MAX_VALUE]) {
        expect(() => start({ heapLimitMb })).toThrow("heapLimitMb");
      }
      expect(workers()).toHaveLength(0);
    });

    it("counts a spare that reaches it as a spare that failed", async () => {
      const started = startLimited({ spareWorkers: 1 });
      await started.ready;
      workers()[0].beat(MB, { heapLimitReached: true });
      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(started.stats().workers).toMatchObject({
        spare: 1,
        heapLimited: 1,
        heapStopped: 0,
      });
    });
  });

  describe("the watchdog", () => {
    /** Lets `intervals` of the workers' watchdog intervals pass. */
    const pass = (intervals: number) => clock.tick(intervals * 10_000);

    it("kills a worker after six intervals without a message, releases its leases, counts them lost, and places its space under a fresh holder", async () => {
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      const [silent] = workers();
      const holder = holderOf(silent);
      expect(server.executionLeases.acquire(space, holder)).toBe(true);

      // The first check reads the messages; five silent ones are not enough.
      await pass(6);
      expect(silent.terminated).toBe(false);
      expect(server.executionLeases.holderOf(space)).toBe(holder);

      await pass(1);
      await clock.settle();
      expect(silent.terminated).toBe(true);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
      expect(started.stats().lease.lost).toBe(1);
      expect(started.stats().workers.failed).toBe(1);

      await clock.tick(10);
      await clock.settle();
      expect(workers()).toHaveLength(2);
      const successor = holderOf(workers()[1]);
      expect(successor).not.toBe(holder);
      expect(server.executionLeases.acquire(space, successor)).toBe(true);

      // A successor's counters start over, and the loss still shows.
      workers()[1].host.notify("host.stats", {
        stats: emptyServingLoopStats(),
      });
      await clock.settle();
      expect(started.stats().lease.lost).toBe(1);
    });

    it("restarts its count at a message of any kind", async () => {
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      const [worker] = workers();
      await pass(6);
      worker.beat(1);
      await pass(6);
      worker.host.notify("host.activationSettled", {
        space,
        outcome: "active",
      });
      await pass(6);
      expect(worker.terminated).toBe(false);
      await pass(1);
      expect(worker.terminated).toBe(true);
    });

    it("counts nothing before a worker's first message, since its modules may still be loading", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers(() => {});
      start();
      server.openSession(space, "session-1");
      await pass(100);
      expect(workers()[0].terminated).toBe(false);
    });

    it("leaves the other spaces' workers alone", async () => {
      start();
      server.openSession(space, "session-1");
      server.openSession(other, "session-2");
      await clock.settle();
      const [silent, talking] = workers();
      for (let interval = 0; interval < 7; interval += 1) {
        await pass(1);
        talking.beat(1);
        await clock.settle();
      }
      expect(silent.terminated).toBe(true);
      expect(talking.terminated).toBe(false);
    });

    it("fences a commit the killed worker left in flight", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await Engine.open({
        url: toFileUrl(path),
        executionLeases: server.executionLeases,
      });
      let opening = Promise.resolve();
      server.openEngine = async () => {
        await opening;
        return engine;
      };
      start();
      server.openSession(space, "session-1");
      await clock.settle();
      const [worker] = workers();
      const holder = holderOf(worker);
      const commit = (localSeq: number, doc: string) =>
        worker.host.request("sink.commitWave", {
          sessionId: holder,
          localSeq,
          batch: encodeMemoryBoundary({
            space,
            home: true,
            basisSeq: Engine.serverSeq(engine),
            rebasedHeads: [],
            operations: [{ op: "set", id: doc, value: { value: { doc } } }],
            preconditions: [],
            holder,
            annotations: [],
            consequenceOf: [],
            basisInstances: [],
          } as unknown as FabricValue),
        });
      // A process's own claim on the flag, which outlasts the pool, so that
      // the lease is what refuses the commit.
      const releaseServerExecution = acquireServerExecutionEnabler();
      try {
        expect(server.executionLeases.acquire(space, holder)).toBe(true);
        expect((await commit(1, "of:before-the-kill")).ok).toBeDefined();
        const head = Engine.serverSeq(engine);

        // The commit waits on the engine past the kill, and the lease has
        // gone by the time it reaches admission. Its answer has no worker to
        // go to; what shows the refusal is the store.
        const held = defer<void>();
        opening = held.promise;
        commit(2, "of:after-the-kill").catch(() => {});
        await clock.settle();
        await pass(7);
        expect(worker.terminated).toBe(true);
        held.resolve();
        await clock.settle();
        expect(Engine.serverSeq(engine)).toBe(head);
      } finally {
        await pool?.close();
        releaseServerExecution();
        Engine.close(engine);
        await Deno.remove(path);
      }
    });

    it("settles a close whose worker stalled before its host could answer", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        worker.host.onRequest("host.close", () => new Promise<never>(() => {}));
        worker.serve();
      });
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      const [worker] = workers();
      const holder = holderOf(worker);
      expect(server.executionLeases.acquire(space, holder)).toBe(true);

      const closing = started.close();
      await pass(7);
      await closing;

      expect(worker.terminated).toBe(true);
      expect(workers()).toHaveLength(1);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
    });
  });

  describe("a close", () => {
    it("settles when a worker fails while its host closes, and releases the worker's leases", async () => {
      const closingHost = defer<void>();
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers((worker) => {
        worker.host.onRequest("host.close", () => {
          closingHost.resolve();
          return new Promise<never>(() => {});
        });
        worker.serve();
      });
      const started = start();
      server.openSession(space, "session-1");
      await clock.settle();
      const [worker] = workers();
      expect(server.executionLeases.acquire(space, holderOf(worker))).toBe(
        true,
      );
      const closing = started.close();
      await closingHost.promise;
      worker.fail();
      await closing;
      expect(worker.terminated).toBe(true);
      expect(workers()).toHaveLength(1);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
    });
  });
});
