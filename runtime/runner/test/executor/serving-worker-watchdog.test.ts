import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";

import { ServingWorkerPool } from "../../src/executor/serving-worker-host.ts";
import { getServingLoopStats } from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("watchdog space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("watchdog service");

describe("serving-worker-watchdog", () => {
  /** Returns the receipt of `verb` run on a worker of its own. */
  const receiptOfVerb = async (verb: string): Promise<unknown> => {
    const directory = await Deno.makeTempDir({ prefix: "watchdog-" });
    const server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
    });
    const worker = new ServingWorkerPool({
      server,
      identity: serviceSigner,
      apiUrl: new URL(import.meta.url),
      workerModule: new URL(
        "../support/stalling-serving-worker.ts",
        import.meta.url,
      ),
      ensureSpaceRoots: false,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    try {
      const { receipt } = await worker.runLifecycleVerb(space, {
        name: verb,
        request: {},
      });
      return receipt;
    } finally {
      await worker.close();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  };

  it("gives a timer on a worker's thread a turn during a compile", async () => {
    // The heartbeat the watchdog listens for is a timer on that thread, so a
    // compile that gave it no turn would read as a stalled thread once it
    // outlasted the watchdog's limit.
    expect(await receiptOfVerb("compile")).toBeGreaterThan(0);
  });

  it("gives a timer a turn during a serving runtime's evaluation of a graph, and during no other's in Deno", async () => {
    const [serving, other] = await receiptOfVerb("evaluate") as number[];
    expect(serving).toBeGreaterThan(0);
    expect(other).toBe(0);
  });

  /**
   * Runs `body` on a pool of stalling workers whose watchdog kills a worker
   * silent for 1.2 s, less than the 3 s its heap snapshot holds the thread,
   * and returns the causes of the workers that closed.
   */
  const withQuickWatchdog = async (
    body: (worker: ServingWorkerPool, directory: string) => Promise<void>,
  ): Promise<string[]> => {
    const directory = await Deno.makeTempDir({ prefix: "watchdog-" });
    const server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
    });
    const closed: string[] = [];
    const workerModule = new URL(
      "../support/stalling-serving-worker.ts",
      import.meta.url,
    );
    workerModule.searchParams.set("stalled", `${directory}/stalled`);
    const worker = new ServingWorkerPool({
      server,
      identity: serviceSigner,
      apiUrl: new URL(import.meta.url),
      workerModule,
      ensureSpaceRoots: false,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      watchdogIntervalMs: 200,
      onWorkerClosed: (_spaces, cause) => closed.push(cause),
    });
    try {
      await body(worker, directory);
      return closed;
    } finally {
      await worker.close();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  };

  it("does not count the time a worker spends writing a heap snapshot", async () => {
    const closed = await withQuickWatchdog(async (worker, directory) => {
      expect(
        (await worker.runLifecycleVerb(space, { name: "serve", request: {} }))
          .receipt,
      ).toBe("served");
      const snapshots = await worker.heapSnapshots(directory);
      expect(snapshots.map((each) => each.spaces)).toEqual([[space]]);
      expect("path" in snapshots[0].outcome).toBe(true);
      expect(worker.stats().workers).toMatchObject({ serving: 1, failed: 0 });
    });
    expect(closed).toEqual([]);
  });

  it("kills a worker that stalled before it began a heap snapshot, and leaves it out", async () => {
    // The snapshot request is posted once the worker's thread has stopped, so
    // the worker never says it has begun, and its silence counts as any other.
    const closed = await withQuickWatchdog(async (worker, directory) => {
      expect(
        (await worker.runLifecycleVerb(space, { name: "serve", request: {} }))
          .receipt,
      ).toBe("served");
      const watcher = Deno.watchFs(directory, { recursive: false });
      const stalled = worker.runLifecycleVerb(space, {
        name: "stall",
        request: {},
      });
      for await (const event of watcher) {
        if (event.paths.some((path) => path.endsWith("/stalled"))) break;
      }
      watcher.close();
      const snapshots = await worker.heapSnapshots(directory);
      await expect(stalled).rejects.toThrow();
      expect(snapshots).toEqual([]);
      expect(worker.stats().workers).toMatchObject({ failed: 1 });
    });
    expect(closed).toEqual(["failed"]);
  });

  it("kills a worker whose thread stalled holding a lease, serves its space from a fresh one, and refuses its commits", async () => {
    // A real worker's thread, stopped: the part a stand-in cannot show is that
    // a thread that has stopped can be terminated at all, and that its
    // successor then serves the space. The short interval keeps the kill inside
    // the time a test has, and leaves six seconds of silence to reach it, which
    // nothing a worker does on its way up approaches.
    const directory = await Deno.makeTempDir({ prefix: "watchdog-" });
    const server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
    });
    const killed = defer<void>();
    const worker = new ServingWorkerPool({
      server,
      identity: serviceSigner,
      apiUrl: new URL(import.meta.url),
      workerModule: new URL(
        "../support/stalling-serving-worker.ts",
        import.meta.url,
      ),
      ensureSpaceRoots: false,
      policy: {
        flushDeadlineMs: 5_000,
        idleParkMs: 600_000,
        failureParkBackoffBaseMs: 0,
      },
      watchdogIntervalMs: 1_000,
      onWorkerClosed: (_spaces, cause) => {
        if (cause === "failed") killed.resolve();
      },
    });
    try {
      const engine = await server.engineForSpace(space);
      expect(
        (await worker.runLifecycleVerb(space, { name: "serve", request: {} }))
          .receipt,
      ).toBe("served");
      const stalled = engine.executionLeases.holderOf(space);
      expect(stalled).toBeDefined();

      await expect(
        worker.runLifecycleVerb(space, { name: "stall", request: {} }),
      ).rejects.toThrow();
      await killed.promise;
      // The space waits out its worker's teardown, and is then left unplaced,
      // since nothing but the verbs asks for it.
      await worker.accessForTestingOnly.waiting.get(space)?.resumed;

      expect(getServingLoopStats()?.lease.lost).toBe(1);
      expect(
        (await worker.runLifecycleVerb(space, { name: "serve", request: {} }))
          .receipt,
      ).toBe("served");
      const successor = engine.executionLeases.holderOf(space);
      expect(successor).toBeDefined();
      expect(successor).not.toBe(stalled);

      const head = Engine.serverSeq(engine);
      expect(() =>
        Engine.applyCommit(engine, {
          sessionId: stalled!,
          space,
          commit: {
            localSeq: 1_000_000,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:from-the-stalled-worker",
              value: { value: {} },
            }],
          },
          commitClass: "derived",
          holder: stalled!,
        })
      ).toThrow("execution lease");
      expect(Engine.serverSeq(engine)).toBe(head);
    } finally {
      await worker.close();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
