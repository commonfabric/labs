/**
 * A `ServingWorkerPool` over stand-in workers and a stand-in memory server, in
 * the cases `ServingWorkerPool.test.ts` and `serving-worker-recovery.test.ts`
 * leave out: the view changes it routes, a verb whose worker fails as it is
 * issued, a close that meets a worker's host closing on its own, and what
 * the pool does when an observer, a store read or a teardown fails.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import {
  getLoggerCountsByKey,
  loggerCountsBreakdownOf,
} from "@commonfabric/logger";
import type { ServerExecutionObserver } from "@commonfabric/memory/v2/server";
import { SpaceNotServedError } from "../../src/executor/host.ts";
import type { ServingLoopDiagnostics } from "../../src/executor/serving-port-protocol.ts";
import {
  ServingWorkerPool,
  type ServingWorkerPoolOptions,
} from "../../src/executor/serving-worker-host.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  FakeMemoryServer,
  type FakeServingWorker,
  fakeServingWorkers,
} from "../support/fake-serving-workers.ts";

const identity = await Identity.fromPassphrase("serving-worker-host");
const alpha = "did:key:z6MkServingWorkerHostAlpha" as MemorySpace;
const beta = "did:key:z6MkServingWorkerHostBeta" as MemorySpace;
const gamma = "did:key:z6MkServingWorkerHostGamma" as MemorySpace;

/** What the pool's realm has logged under `key`, at the warn level. */
const warnings = (key: string): number =>
  getLoggerCountsByKey()["serving-worker-host"]?.[key]?.warn ?? 0;

/** A stand-in memory server that also reports a session's view changes. */
class ViewReportingServer extends FakeMemoryServer {
  #observer: ServerExecutionObserver | undefined;

  /** @inheritDoc */
  override setServerExecutionObserver(
    observer: ServerExecutionObserver | undefined,
  ): void {
    this.#observer = observer;
    super.setServerExecutionObserver(observer);
  }

  /** Reports that `sessionId`'s watch set on `space` carried views. */
  changeViews(space: string, sessionId: string): void {
    this.#observer?.viewsChanged?.(space, sessionId);
  }
}

/** What a stand-in host that closed hands back from `host.retire`. */
const retired = (
  stats: ServingLoopStats,
): { stats: ServingLoopStats; diagnostics: ServingLoopDiagnostics } => ({
  stats,
  diagnostics: { loggerCounts: loggerCountsBreakdownOf({}), timingStats: {} },
});

describe("serving-worker-host", () => {
  let fakes: ReturnType<typeof fakeServingWorkers>;
  let server: ViewReportingServer;
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

  beforeEach(() => {
    fakes = fakeServingWorkers();
    server = new ViewReportingServer();
    pool = undefined;
  });

  afterEach(async () => {
    await pool?.close();
    fakes[Symbol.dispose]();
  });

  it("sends a space's view changes to the worker the space is placed on and to no other", async () => {
    start();
    server.openSession(alpha, "session-a");
    server.openSession(beta, "session-b");
    await clock.settle();
    const [onAlpha, onBeta] = workers();
    server.changeViews(alpha, "session-a");
    server.changeViews(gamma, "session-g");
    await clock.settle();
    expect(onAlpha.receivedOf("observer.viewsChanged")).toEqual([
      { space: alpha, sessionId: "session-a" },
    ]);
    expect(onBeta.receivedOf("observer.viewsChanged")).toEqual([]);
  });

  it("throws `SpaceNotServedError` for a verb whose space's worker fails as the verb is issued", async () => {
    const started = start();
    server.openSession(alpha, "session-1");
    await clock.settle();
    const verb = started.runLifecycleVerb(alpha, {
      name: "upload",
      request: {},
    });
    workers()[0].fail();
    await expect(verb).rejects.toThrow(SpaceNotServedError);
  });

  it("closes a worker whose host closed on its own while the pool closed without asking that host again", async () => {
    const closed: unknown[] = [];
    const started = start({
      onWorkerClosed: (spaces, cause) => closed.push([spaces, cause]),
    });
    server.openSession(alpha, "session-1");
    await clock.settle();
    server.closeSession(alpha, "session-1");
    const [worker] = workers();
    const answer = defer<ReturnType<typeof retired>>();
    worker.host.onRequest("host.retire", () => answer.promise);
    worker.report("vacant");
    await clock.settle();
    const failedCloses = warnings("worker-close-failed");

    const closing = started.close();
    answer.resolve(retired({ ...emptyServingLoopStats(), waves: 3 }));
    await closing;
    expect(worker.terminated).toBe(true);
    expect(worker.hostCloses).toBe(0);
    expect(warnings("worker-close-failed")).toBe(failedCloses);
    expect(closed).toEqual([[[alpha], "retired"]]);
    expect(started.stats().waves).toBe(3);
  });

  it("places a space again whose worker failed when its store cannot be read, with no session and no commit owed", async () => {
    const started = start();
    server.openSession(alpha, "session-1");
    await clock.settle();
    server.closeSession(alpha, "session-1");
    const failedChecks = warnings("undelivered-events-check-failed");
    using _unreadable = stub(
      server,
      "hasUndeliveredEvents",
      () => Promise.reject(new Error("the store cannot be read")),
    );
    workers()[0].fail();
    await clock.tick(10);
    await clock.settle();
    expect(warnings("undelivered-events-check-failed")).toBe(failedChecks + 1);
    expect(workers()).toHaveLength(2);
    expect(started.accessForTestingOnly.placements.get(alpha)?.worker.port)
      .toBe(workers()[1]);
  });

  it("closes a worker as it would have when the `onWorkerClosed` observer throws", async () => {
    const started = start({
      onWorkerClosed: () => {
        throw new Error("the observer failed");
      },
    });
    server.openSession(alpha, "session-1");
    await clock.settle();
    server.closeSession(alpha, "session-1");
    const observerFailures = warnings("worker-closed-observer-failed");
    workers()[0].report("vacant");
    await clock.settle();
    expect(warnings("worker-closed-observer-failed")).toBe(
      observerFailures + 1,
    );
    expect(workers()[0].terminated).toBe(true);
    expect(started.stats().workers).toMatchObject({ serving: 0, retired: 1 });

    server.openSession(alpha, "session-2");
    await clock.settle();
    expect(workers()).toHaveLength(2);
  });

  it("places a failed worker's space again when tearing the worker down fails", async () => {
    fakes[Symbol.dispose]();
    let spawned = 0;
    fakes = fakeServingWorkers((worker) => {
      spawned += 1;
      if (spawned === 1) {
        worker.terminate = () => {
          throw new Error("the worker could not be terminated");
        };
      }
      worker.serve();
    });
    const started = start();
    server.openSession(alpha, "session-1");
    await clock.settle();
    const failedTeardowns = warnings("worker-teardown-failed");
    workers()[0].fail();
    await clock.tick(10);
    await clock.settle();
    expect(warnings("worker-teardown-failed")).toBe(failedTeardowns + 1);
    expect(workers()).toHaveLength(2);
    expect(started.accessForTestingOnly.placements.get(alpha)?.worker.port)
      .toBe(workers()[1]);
  });
});
