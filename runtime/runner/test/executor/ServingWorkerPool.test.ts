/**
 * Drives a `ServingWorkerPool` between a stand-in memory server and stand-in
 * workers, so each case decides what the server reports and what each
 * worker's host answers. The pool's failure handling is in
 * `serving-worker-recovery.test.ts`, and a pool over real workers in
 * `serving-worker.test.ts`.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { SpaceNotServedError } from "../../src/executor/host.ts";
import {
  ServingWorkerPool,
  type ServingWorkerPoolOptions,
} from "../../src/executor/serving-worker-host.ts";
import {
  emptyServingLoopStats,
  getServingLoopStats,
} from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  admittedNotice,
  FakeMemoryServer,
  type FakeServingWorker,
  fakeServingWorkers,
} from "../support/fake-serving-workers.ts";

const identity = await Identity.fromPassphrase("serving-worker-pool");
const alpha = "did:key:z6MkServingWorkerPoolAlpha" as MemorySpace;
const beta = "did:key:z6MkServingWorkerPoolBeta" as MemorySpace;
const gamma = "did:key:z6MkServingWorkerPoolGamma" as MemorySpace;

describe("ServingWorkerPool", () => {
  let fakes: ReturnType<typeof fakeServingWorkers>;
  let server: FakeMemoryServer;
  let pool: ServingWorkerPool | undefined;

  /** The stand-in workers spawned so far. */
  const workers = (): FakeServingWorker[] => fakes.workers;

  /** Starts the pool under test over `server`. */
  const start = (
    over: Partial<ServingWorkerPoolOptions> = {},
  ): ServingWorkerPool => {
    pool = new ServingWorkerPool({
      server: server.asServer,
      identity,
      apiUrl: new URL(import.meta.url),
      ...over,
    });
    return pool;
  };

  /** The methods of the notices `worker` has received, in order. */
  const methodsOf = (worker: FakeServingWorker): string[] =>
    worker.received.map((notice) => notice.method);

  beforeEach(() => {
    fakes = fakeServingWorkers();
    server = new FakeMemoryServer();
    pool = undefined;
  });

  afterEach(async () => {
    await pool?.close();
    fakes[Symbol.dispose]();
  });

  describe("constructor()", () => {
    it("throws for a `maxWorkers` below one", () => {
      expect(() => start({ maxWorkers: 0 })).toThrow("maxWorkers");
    });

    it("throws for a `spareWorkers` that is not a whole number", () => {
      expect(() => start({ spareWorkers: 0.5 })).toThrow("spareWorkers");
    });

    it("starts no worker while no space has anything to serve", async () => {
      start();
      await clock.settle();
      expect(workers()).toHaveLength(0);
    });

    it("places a space a client session was live on before it started", async () => {
      server.openSession(alpha, "session-1");
      start();
      await clock.settle();
      expect(workers()).toHaveLength(1);
      expect(methodsOf(workers()[0])).toEqual([
        "observer.sessionChanged",
        "observer.sessionOpened",
      ]);
    });

    it("starts `spareWorkers` workers with no space placed on them", async () => {
      const started = start({ spareWorkers: 2 });
      await started.ready;
      expect(workers()).toHaveLength(2);
      expect(started.stats().workers.spare).toBe(2);
      expect(started.stats().workers.serving).toBe(0);
    });
  });

  describe("placing a space", () => {
    it("starts no worker for an authored commit into a space with no session", async () => {
      start();
      server.admit(admittedNotice(alpha));
      await clock.settle();
      expect(workers()).toHaveLength(0);
    });

    it("starts no worker for the service identity's own session", async () => {
      start();
      server.openSession(alpha, "loopback", identity.did());
      await clock.settle();
      expect(workers()).toHaveLength(0);
    });

    it("places a space at its first client session, and tells its worker of the session and then of the open", async () => {
      start();
      server.openSession(alpha, "session-1");
      await clock.settle();
      expect(workers()).toHaveLength(1);
      expect(workers()[0].received).toEqual([
        {
          method: "observer.sessionChanged",
          params: {
            event: {
              kind: "opened",
              space: alpha,
              sessionId: "session-1",
              principal: "did:key:client",
            },
          },
        },
        { method: "observer.sessionOpened", params: { space: alpha } },
      ]);
    });

    it("places a space with no session at a commit that carries events", async () => {
      start();
      const notice = admittedNotice(alpha, {
        eventAppends: [{ id: "of:stream", scopeKey: "space", eventId: "e1" }],
      });
      server.admit(notice);
      await clock.settle();
      expect(workers()).toHaveLength(1);
      expect(workers()[0].receivedOf("observer.commitAdmitted")).toEqual([
        { notice },
      ]);
    });

    it("places a space with no session at a warm commit", async () => {
      start();
      server.admit(admittedNotice(alpha, { warm: true }));
      await clock.settle();
      expect(workers()).toHaveLength(1);
    });

    it("starts no worker for a derived commit that carries events", async () => {
      start();
      server.admit(admittedNotice(alpha, {
        class: "derived",
        eventAppends: [{ id: "of:stream", scopeKey: "space", eventId: "e1" }],
      }));
      await clock.settle();
      expect(workers()).toHaveLength(0);
    });

    it("starts no worker for a space whose lease another holder has", async () => {
      const started = start();
      expect(server.executionLeases.acquire(alpha, "did:key:rival#elsewhere"))
        .toBe(true);
      server.openSession(alpha, "session-1");
      server.admit(admittedNotice(alpha, { warm: true }));
      await clock.settle();
      expect(workers()).toHaveLength(0);
      await expect(
        started.runLifecycleVerb(alpha, { name: "upload", request: {} }),
      ).rejects.toThrow(SpaceNotServedError);
      expect(workers()).toHaveLength(0);

      server.executionLeases.release(alpha, "did:key:rival#elsewhere");
      server.openSession(alpha, "session-2");
      await clock.settle();
      expect(workers()).toHaveLength(1);
    });

    it("gives each space a worker of its own", async () => {
      const started = start();
      server.openSession(alpha, "session-a");
      server.openSession(beta, "session-b");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[0].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
      ]);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space: beta },
      ]);
      expect(started.stats().workers.serving).toBe(2);
    });

    it("holds a space's commits until its worker serves, then sends them in order after the space's sessions", async () => {
      fakes[Symbol.dispose]();
      fakes = fakeServingWorkers(() => {});
      start();
      server.openSession(alpha, "session-1");
      const first = admittedNotice(alpha, { seq: 1 });
      const second = admittedNotice(alpha, { seq: 2 });
      server.admit(first);
      server.admit(second);
      await clock.settle();
      expect(workers()[0].received).toEqual([]);

      workers()[0].serve();
      await clock.settle();
      expect(methodsOf(workers()[0])).toEqual([
        "observer.sessionChanged",
        "observer.commitAdmitted",
        "observer.commitAdmitted",
        "observer.sessionOpened",
      ]);
      expect(workers()[0].receivedOf("observer.commitAdmitted")).toEqual([
        { notice: first },
        { notice: second },
      ]);
    });

    it("takes a spare for a placement and starts another", async () => {
      const started = start({ spareWorkers: 1 });
      await started.ready;
      server.openSession(alpha, "session-1");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[0].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
      ]);
      expect(workers()[1].received).toEqual([]);
      expect(started.stats().workers).toMatchObject({ serving: 1, spare: 1 });
    });
  });

  describe("routing the server's events", () => {
    /** Places `alpha` and `beta`, each on a worker of its own. */
    const placeTwo = async (): Promise<FakeServingWorker[]> => {
      start();
      server.openSession(alpha, "session-a");
      server.openSession(beta, "session-b");
      await clock.settle();
      return workers();
    };

    it("sends a commit to the worker its space is placed on and to no other", async () => {
      const [onAlpha, onBeta] = await placeTwo();
      const notice = admittedNotice(beta, { class: "derived" });
      server.admit(notice);
      await clock.settle();
      expect(onBeta.receivedOf("observer.commitAdmitted")).toEqual([
        { notice },
      ]);
      expect(onAlpha.receivedOf("observer.commitAdmitted")).toEqual([]);
    });

    it("tells the other workers, and not the space's own, when a commit writes the space's access list", async () => {
      const [onAlpha, onBeta] = await placeTwo();
      server.admit(admittedNotice(alpha, {
        writes: [{ id: `of:${alpha}`, scopeKey: "space" }],
      }));
      await clock.settle();
      expect(onBeta.receivedOf("observer.spaceAclChanged")).toEqual([
        { space: alpha },
      ]);
      expect(onAlpha.receivedOf("observer.spaceAclChanged")).toEqual([]);
      expect(onAlpha.receivedOf("observer.commitAdmitted")).toHaveLength(1);
    });

    it("tells every worker when a commit writes the access list of a space placed nowhere", async () => {
      const [onAlpha, onBeta] = await placeTwo();
      server.admit(admittedNotice(gamma, {
        writes: [{ id: `of:${gamma}`, scopeKey: "space" }],
      }));
      await clock.settle();
      expect(onAlpha.receivedOf("observer.spaceAclChanged")).toEqual([
        { space: gamma },
      ]);
      expect(onBeta.receivedOf("observer.spaceAclChanged")).toEqual([
        { space: gamma },
      ]);
      expect(workers()).toHaveLength(2);
    });

    it("sends a placed space's later session changes to its worker alone", async () => {
      const [onAlpha, onBeta] = await placeTwo();
      server.closeSession(alpha, "session-a");
      await clock.settle();
      expect(onAlpha.receivedOf("observer.sessionChanged").at(-1)).toEqual({
        event: { kind: "removed", space: alpha, sessionId: "session-a" },
      });
      expect(onBeta.receivedOf("observer.sessionChanged")).toHaveLength(1);
    });
  });

  describe("closing a worker", () => {
    it("asks a worker whose host reports vacant to close, terminates it, and counts it retired", async () => {
      const closed: unknown[] = [];
      const started = start({
        onWorkerClosed: (spaces, cause) => closed.push([spaces, cause]),
      });
      server.openSession(alpha, "session-1");
      await clock.settle();
      server.closeSession(alpha, "session-1");
      workers()[0].report("vacant");
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(closed).toEqual([[[alpha], "retired"]]);
      expect(started.accessForTestingOnly.placements.size).toBe(0);
      expect(started.stats().workers).toMatchObject({ serving: 0, retired: 1 });
      expect(workers()).toHaveLength(1);
    });

    it("keeps a worker whose host holds something again by the time it is asked", async () => {
      const started = start();
      server.openSession(alpha, "session-1");
      await clock.settle();
      workers()[0].report("vacant");
      workers()[0].report("busy");
      await clock.settle();
      expect(workers()[0].terminated).toBe(false);
      expect(started.stats().workers).toMatchObject({ serving: 1, retired: 0 });

      const notice = admittedNotice(alpha, { seq: 7 });
      server.admit(notice);
      await clock.settle();
      expect(workers()[0].receivedOf("observer.commitAdmitted")).toEqual([
        { notice },
      ]);
    });

    it("asks a host again that reported vacant while an earlier request to close was in flight", async () => {
      const started = start();
      server.admit(admittedNotice(alpha, { warm: true }));
      await clock.settle();
      const [worker] = workers();
      let asked = 0;
      worker.host.onRequest("host.retire", () => {
        asked += 1;
        if (asked > 1) {
          return {
            stats: emptyServingLoopStats(),
            diagnostics: {
              loggerCounts: { total: 0 } as never,
              timingStats: {},
            },
          };
        }
        // The host holds something as it is asked, and nothing right after.
        worker.report("vacant");
        return null;
      });
      worker.report("vacant");
      await clock.settle();
      expect(asked).toBe(2);
      expect(worker.terminated).toBe(true);
      expect(started.stats().workers.retired).toBe(1);
    });

    it("leaves a space unplaced whose host closed with a client session live, until another session opens", async () => {
      // A host that holds nothing while a session is live has turned the
      // session's tenure down, so the session starts no worker after it.

      start();
      server.openSession(alpha, "session-1");
      await clock.settle();
      workers()[0].report("vacant");
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(workers()).toHaveLength(1);

      server.openSession(alpha, "session-2");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
      ]);
    });

    it("places a space again for a client session that opened while its worker was closing", async () => {
      start();
      server.admit(admittedNotice(alpha, { warm: true }));
      await clock.settle();
      workers()[0].report("vacant");
      // The report crosses, and the request to close is on its way, when the
      // session opens.
      await Promise.resolve();
      server.openSession(alpha, "session-1");
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
      ]);
    });

    it("hands a commit that would start a tenure, sent while the worker was closing, to the space's next worker", async () => {
      start();
      const first = admittedNotice(alpha, { warm: true, seq: 1 });
      server.admit(first);
      await clock.settle();
      workers()[0].report("vacant");
      // The report crosses, and the request to close is on its way, when the
      // next commit is admitted.
      await Promise.resolve();
      const second = admittedNotice(alpha, { warm: true, seq: 2 });
      server.admit(second);
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.commitAdmitted")).toEqual([
        { notice: second },
      ]);
    });

    it("keeps a spare whose host reports vacant", async () => {
      const started = start({ spareWorkers: 1 });
      await started.ready;
      workers()[0].report("vacant");
      await clock.settle();
      expect(workers()[0].terminated).toBe(false);
    });

    it("closes the longest-parked worker beyond `maxParkedRuntimes`, and counts it evicted", async () => {
      const closed: unknown[] = [];
      const started = start({
        policy: { maxParkedRuntimes: 1 },
        onWorkerClosed: (spaces, cause) => closed.push([spaces, cause]),
      });
      server.admit(admittedNotice(alpha, { warm: true }));
      server.admit(admittedNotice(beta, { warm: true }));
      await clock.settle();
      workers()[0].report("parked");
      await clock.settle();
      expect(workers()[0].terminated).toBe(false);
      expect(started.stats().workers.parked).toBe(1);

      workers()[1].report("parked");
      await clock.settle();
      expect(workers()[0].terminated).toBe(true);
      expect(workers()[1].terminated).toBe(false);
      expect(closed).toEqual([[[alpha], "evicted"]]);
      expect(started.stats().workers).toMatchObject({ parked: 1, evicted: 1 });
    });

    it("closes parked workers, the longest parked first, while the workers' heaps exceed the budget, and none that serves", async () => {
      const started = start({ heapBudgetBytes: 250 });
      for (const space of [alpha, beta, gamma]) {
        server.admit(admittedNotice(space, { warm: true }));
      }
      await clock.settle();
      const [onAlpha, onBeta, onGamma] = workers();
      onAlpha.report("busy");
      onBeta.report("parked");
      onGamma.report("parked");
      onAlpha.beat(100);
      onBeta.beat(100);
      await clock.settle();
      expect(workers().map((worker) => worker.terminated)).toEqual([
        false,
        false,
        false,
      ]);

      // 320 bytes against 250: closing the longer-parked worker's 100 fits.
      onGamma.beat(120);
      await clock.settle();
      expect(workers().map((worker) => worker.terminated)).toEqual([
        false,
        true,
        false,
      ]);

      // The serving worker alone exceeds the budget, and stays.
      onAlpha.beat(1_000);
      await clock.settle();
      expect(onAlpha.terminated).toBe(false);
      expect(onGamma.terminated).toBe(true);
      expect(started.stats().workers).toMatchObject({
        serving: 1,
        evicted: 2,
        heapUsed: 1_000,
      });
    });
  });

  describe("the cap on workers", () => {
    it("places a space on the worker with the fewest spaces once `maxWorkers` are placed on, and counts it shared", async () => {
      const started = start({ maxWorkers: 2 });
      server.openSession(alpha, "session-a");
      server.openSession(beta, "session-b");
      server.openSession(gamma, "session-c");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[0].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
        { space: gamma },
      ]);
      expect(started.stats().workers).toMatchObject({ serving: 2, shared: 1 });
    });

    it("places a space at the cap on a worker holding only parked runtimes ahead of one that serves", async () => {
      start({ maxWorkers: 2 });
      server.openSession(alpha, "session-a");
      server.admit(admittedNotice(beta, { warm: true }));
      await clock.settle();
      workers()[1].report("parked");
      await clock.settle();
      server.openSession(gamma, "session-c");
      await clock.settle();
      expect(workers()).toHaveLength(2);
      expect(workers()[1].receivedOf("observer.sessionOpened")).toEqual([
        { space: gamma },
      ]);
    });

    it("serves every space from one worker with `maxWorkers: 1`", async () => {
      start({ maxWorkers: 1 });
      server.openSession(alpha, "session-a");
      server.openSession(beta, "session-b");
      await clock.settle();
      expect(workers()).toHaveLength(1);
      expect(workers()[0].receivedOf("observer.sessionOpened")).toEqual([
        { space: alpha },
        { space: beta },
      ]);
    });
  });

  describe("instance members", () => {
    describe("runLifecycleVerb()", () => {
      /** Has `worker`'s host run every verb and return the space it named. */
      const answerVerbs = (worker: FakeServingWorker): void =>
        worker.host.onRequest(
          "host.runLifecycleVerb",
          ({ space }) => Promise.resolve({ receipt: space, timings: [] }),
        );

      it("places a space with nothing else to serve and runs the verb on its worker", async () => {
        fakes[Symbol.dispose]();
        fakes = fakeServingWorkers((worker) => {
          answerVerbs(worker);
          worker.serve();
        });
        const started = start();
        const run = await started.runLifecycleVerb(alpha, {
          name: "upload",
          request: {},
        });
        expect(run.receipt).toBe(alpha);
        expect(workers()).toHaveLength(1);
      });

      it("waits out a worker that is closing and runs the verb on the space's next one", async () => {
        fakes[Symbol.dispose]();
        fakes = fakeServingWorkers((worker) => {
          answerVerbs(worker);
          worker.serve();
        });
        const started = start();
        server.admit(admittedNotice(alpha, { warm: true }));
        await clock.settle();
        workers()[0].report("vacant");
        await Promise.resolve();
        const run = await started.runLifecycleVerb(alpha, {
          name: "upload",
          request: {},
        });
        expect(run.receipt).toBe(alpha);
        expect(workers()[0].terminated).toBe(true);
        expect(workers()).toHaveLength(2);
      });

      it("throws `SpaceNotServedError` once the pool is closed", async () => {
        const started = start();
        await started.close();
        await expect(
          started.runLifecycleVerb(alpha, { name: "upload", request: {} }),
        ).rejects.toThrow(SpaceNotServedError);
      });
    });

    describe("stats()", () => {
      it("adds the workers' counters to the last of each worker that closed, whose levels count for nothing", async () => {
        const started = start();
        server.admit(admittedNotice(alpha, { warm: true }));
        server.admit(admittedNotice(beta, { warm: true }));
        await clock.settle();
        const [onAlpha, onBeta] = workers();
        onAlpha.host.notify("host.stats", {
          stats: { ...emptyServingLoopStats(), waves: 2, activeSpaces: 1 },
        });
        onBeta.host.notify("host.stats", {
          stats: { ...emptyServingLoopStats(), waves: 5, activeSpaces: 1 },
        });
        await clock.settle();
        expect(started.stats()).toMatchObject({ waves: 7, activeSpaces: 2 });

        onAlpha.finalStats = {
          ...emptyServingLoopStats(),
          waves: 3,
          activeSpaces: 1,
        };
        onAlpha.report("vacant");
        await clock.settle();
        expect(started.stats()).toMatchObject({ waves: 8, activeSpaces: 1 });
      });

      it("is what the process's serving-loop counters read while the pool is open, and nothing is once it has closed", async () => {
        const started = start();
        expect(getServingLoopStats()?.workers.started).toBe(0);
        server.openSession(alpha, "session-1");
        await clock.settle();
        expect(getServingLoopStats()?.workers.started).toBe(1);
        await started.close();
        expect(getServingLoopStats()).toBeUndefined();
      });
    });

    describe("requestStats()", () => {
      it("returns the counters each serving worker holds now", async () => {
        const started = start();
        server.openSession(alpha, "session-1");
        await clock.settle();
        workers()[0].finalStats = { ...emptyServingLoopStats(), waves: 4 };
        expect(started.stats().waves).toBe(0);
        expect((await started.requestStats()).waves).toBe(4);
      });
    });

    describe("diagnostics()", () => {
      it("adds up what the serving workers' realms logged", async () => {
        const started = start();
        server.openSession(alpha, "session-a");
        server.openSession(beta, "session-b");
        await clock.settle();
        for (const worker of workers()) {
          worker.host.onRequest("host.diagnostics", () => ({
            loggerCounts: {
              total: 2,
              executor: { total: 2 },
            } as never,
            timingStats: {},
          }));
        }
        expect((await started.diagnostics()).loggerCounts).toEqual({
          total: 4,
          executor: { total: 4 },
        });
      });

      it("counts a worker once that closed while another's answer was awaited", async () => {
        const started = start();
        server.admit(admittedNotice(alpha, { warm: true }));
        server.admit(admittedNotice(beta, { warm: true }));
        await clock.settle();
        const [closing, slow] = workers();
        const logged = (total: number) => ({
          loggerCounts: { total } as never,
          timingStats: {},
        });
        closing.diagnostics = logged(2);
        const slowAnswer = Promise.withResolvers<
          ReturnType<typeof logged>
        >();
        slow.host.onRequest("host.diagnostics", () => slowAnswer.promise);

        const asked = started.diagnostics();
        await clock.settle();
        closing.report("vacant");
        await clock.settle();
        expect(closing.terminated).toBe(true);
        slowAnswer.resolve(logged(3));

        expect((await asked).loggerCounts).toEqual({ total: 5 });
      });
    });

    describe("close()", () => {
      it("closes each serving worker's host, terminates every worker, and removes the server's observer", async () => {
        const started = start({ spareWorkers: 1 });
        await started.ready;
        server.openSession(alpha, "session-1");
        await clock.settle();
        expect(server.observed).toBe(true);
        await started.close();
        expect(workers().map((worker) => worker.terminated)).toEqual([
          true,
          true,
        ]);
        expect(workers().map((worker) => worker.hostCloses)).toEqual([1, 1]);
        expect(server.observed).toBe(false);
      });

      it("terminates a worker whose host has not started to serve without asking it to close", async () => {
        fakes[Symbol.dispose]();
        fakes = fakeServingWorkers((worker) => worker.hang());
        const started = start();
        server.openSession(alpha, "session-1");
        await clock.settle();
        await started.close();
        expect(workers()[0].terminated).toBe(true);
        expect(workers()[0].hostCloses).toBe(0);
      });

      it("places nothing for what the server reports afterwards", async () => {
        const started = start();
        await started.close();
        server.openSession(alpha, "session-1");
        await clock.settle();
        expect(workers()).toHaveLength(0);
      });
    });
  });
});
