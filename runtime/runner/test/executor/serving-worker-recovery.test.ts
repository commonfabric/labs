import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
import {
  executionLeaseHolder,
  ExecutionLeases,
} from "@commonfabric/memory/v2/execution-lease";
import type { Server } from "@commonfabric/memory/v2/server";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import { SpaceNotServedError } from "../../src/executor/host.ts";
import { ServingPortBridge } from "../../src/executor/serving-port-bridge.ts";
import { ServingWorker } from "../../src/executor/serving-worker-host.ts";
import {
  emptyServingLoopStats,
  getServingLoopStats,
} from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const identity = await Identity.fromPassphrase("serving-worker-recovery");
const space = "did:key:z6MkServingWorkerRecovery" as MemorySpace;

/** The stand-ins spawned since `fakeWorkers()` last installed them. */
let spawned: FakeWorker[] = [];

/** Called with each stand-in as it is spawned. */
let onSpawned: ((worker: FakeWorker) => void) | undefined;

/**
 * A `Worker` stand-in: it records the answers the bridge posts to it, and a
 * test fails it, or posts for the worker's host, by hand.
 */
class FakeWorker extends EventTarget {
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly #answers = new Map<number, (envelope: unknown) => void>();

  constructor() {
    super();
    spawned.push(this);
    onSpawned?.(this);
  }

  postMessage(envelope: { t: string; id?: number }): void {
    if (envelope.t === "ok" || envelope.t === "err") {
      this.#answers.get(envelope.id!)?.(envelope);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Fails the worker as an error it did not handle does. */
  fail(): void {
    this.onerror!(
      new ErrorEvent("error", { message: "worker failed", cancelable: true }),
    );
  }

  /** Posts `envelope` to the bridge, as the worker's side of the port. */
  post(envelope: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: envelope }));
  }

  /** Settles once the bridge has answered the request numbered `id`. */
  answered(id: number): Promise<unknown> {
    return new Promise((resolve) => this.#answers.set(id, resolve));
  }
}

/**
 * Installs `FakeWorker` as the global `Worker` until the result is disposed.
 * `next()` settles with the next stand-in spawned.
 */
function fakeWorkers(): Disposable & {
  workers: FakeWorker[];
  next(): Promise<FakeWorker>;
} {
  const original = globalThis.Worker;
  spawned = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return {
    workers: spawned,
    next: () =>
      new Promise((resolve) => {
        onSpawned = (worker) => {
          onSpawned = undefined;
          resolve(worker);
        };
      }),
    [Symbol.dispose]: () => {
      onSpawned = undefined;
      globalThis.Worker = original;
    },
  };
}

/** A memory server stand-in with what a bridge over a fake worker reaches. */
const server = {
  setServerExecutionObserver() {},
  engineForSpace: () => Promise.resolve({}),
  executionLeases: new ExecutionLeases(),
} as unknown as Server;

/** One note of any kind from the worker's side of the port. */
const anyMessage = {
  t: "note",
  method: "host.activationSettled",
  params: { space, outcome: "active" },
};

describe("serving-worker-recovery", () => {
  for (const source of ["init", "error"] as const) {
    for (const closing of [false, true]) {
      it(`${closing ? "suppresses replacement after close" : "releases the worker's leases before replacement"} when ${source} fails`, async () => {
        using fakes = fakeWorkers();
        const { workers } = fakes;
        const init = Promise.withResolvers<{ lifetimeLock: undefined }>();
        const releasing = Promise.withResolvers<void>();
        let restart: (() => void) | undefined;
        using _timer = stub(
          globalThis,
          "setTimeout",
          ((callback: () => void) => {
            restart = callback;
            return 1;
          }) as typeof setTimeout,
        );
        using _init = stub(
          ServingPortBridge.prototype,
          "init",
          () =>
            workers.length === 1
              ? init.promise
              : Promise.resolve({ lifetimeLock: undefined }),
        );
        using _release = stub(
          ServingPortBridge.prototype,
          "releaseLeasesOf",
          () => {
            releasing.resolve();
            return 0;
          },
        );
        using _close = stub(
          ServingPortBridge.prototype,
          "closeHost",
          () => Promise.resolve(),
        );
        const host = new ServingWorker({
          server,
          identity,
          apiUrl: new URL(import.meta.url),
        });
        try {
          const ready = host.ready;
          if (source === "init") {
            init.reject(new Error("init failed"));
            await expect(ready).rejects.toThrow("init failed");
          } else {
            init.resolve({ lifetimeLock: undefined });
            await ready;
            workers[0].fail();
          }
          await releasing.promise;
          expect(workers[0].terminated).toBe(true);
          await expect(
            host.runLifecycleVerb(space, { name: "upload", request: {} }),
          ).rejects.toThrow(SpaceNotServedError);
          expect(restart).toBeDefined();
          expect(workers).toHaveLength(1);
          const closed = closing ? host.close() : undefined;
          const replacement = fakes.next();
          restart!();
          if (closing) {
            await closed;
            expect(workers).toHaveLength(1);
          } else {
            await replacement;
            await host.ready;
            expect(workers).toHaveLength(2);
          }
        } finally {
          await host.close();
        }
      });
    }
  }

  it("settles a close when the worker fails while its host closes", async () => {
    using fakes = fakeWorkers();
    const { workers } = fakes;
    const closingHost = Promise.withResolvers<void>();
    const closeHost = ServingPortBridge.prototype.closeHost;
    using _init = stub(
      ServingPortBridge.prototype,
      "init",
      () => Promise.resolve({ lifetimeLock: undefined }),
    );
    using _close = stub(
      ServingPortBridge.prototype,
      "closeHost",
      function (this: ServingPortBridge) {
        closingHost.resolve();
        return closeHost.call(this);
      },
    );
    const released: string[] = [];
    using _release = stub(
      ServingPortBridge.prototype,
      "releaseLeasesOf",
      (holder: string) => {
        released.push(holder);
        return 0;
      },
    );
    const host = new ServingWorker({
      server,
      identity,
      apiUrl: new URL(import.meta.url),
    });
    await host.ready;
    const closed = host.close();
    await closingHost.promise;
    workers[0].fail();
    await closed;
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(1);
    expect(released).toHaveLength(1);
  });

  it("settles a close while the worker has not reported serving", async () => {
    using fakes = fakeWorkers();
    const { workers } = fakes;
    using _init = stub(
      ServingPortBridge.prototype,
      "init",
      () => new Promise<never>(() => {}),
    );
    let hostCloses = 0;
    using _close = stub(
      ServingPortBridge.prototype,
      "closeHost",
      () => {
        hostCloses += 1;
        return Promise.resolve();
      },
    );
    const released: string[] = [];
    using _release = stub(
      ServingPortBridge.prototype,
      "releaseLeasesOf",
      (holder: string) => {
        released.push(holder);
        return 0;
      },
    );
    const host = new ServingWorker({
      server,
      identity,
      apiUrl: new URL(import.meta.url),
    });

    await host.close();

    expect(workers[0].terminated).toBe(true);
    expect(hostCloses).toBe(0);
    expect(released).toHaveLength(1);
  });

  it("cancels a pending replacement when closed", async () => {
    using fakes = fakeWorkers();
    const { workers } = fakes;
    const cleared: unknown[] = [];
    using _timer = stub(
      globalThis,
      "setTimeout",
      (() => 7) as unknown as typeof setTimeout,
    );
    using _clear = stub(
      globalThis,
      "clearTimeout",
      (id?: Parameters<typeof clearTimeout>[0]) => {
        cleared.push(id);
      },
    );
    using _init = stub(
      ServingPortBridge.prototype,
      "init",
      () => Promise.resolve({ lifetimeLock: undefined }),
    );
    using _release = stub(
      ServingPortBridge.prototype,
      "releaseLeasesOf",
      () => 0,
    );
    const host = new ServingWorker({
      server,
      identity,
      apiUrl: new URL(import.meta.url),
    });
    await host.ready;
    workers[0].fail();
    await host.close();
    expect(cleared).toEqual([7]);
    expect(workers).toHaveLength(1);
  });

  it("reports the failed worker's last counters while its replacement waits, and none once closed", async () => {
    using fakes = fakeWorkers();
    const { workers } = fakes;
    using _timer = stub(
      globalThis,
      "setTimeout",
      (() => 1) as unknown as typeof setTimeout,
    );
    using _init = stub(
      ServingPortBridge.prototype,
      "init",
      () => Promise.resolve({ lifetimeLock: undefined }),
    );
    using _release = stub(
      ServingPortBridge.prototype,
      "releaseLeasesOf",
      () => 0,
    );
    const host = new ServingWorker({
      server,
      identity,
      apiUrl: new URL(import.meta.url),
    });
    try {
      await host.ready;
      workers[0].post({
        t: "note",
        method: "host.stats",
        params: { stats: { ...emptyServingLoopStats(), activeSpaces: 1 } },
      });
      workers[0].fail();
      expect(host.stats()).toBeUndefined();
      expect(getServingLoopStats()?.activeSpaces).toBe(1);
    } finally {
      await host.close();
    }
    expect(getServingLoopStats()).toBeUndefined();
  });

  it("widens the replacement backoff across activations, and resets it once a worker commits a wave", async () => {
    using fakes = fakeWorkers();
    const { workers } = fakes;
    const delays: number[] = [];
    let restart: (() => void) | undefined;
    using _timer = stub(
      globalThis,
      "setTimeout",
      ((callback: () => void, delay: number) => {
        restart = callback;
        delays.push(delay);
        return 1;
      }) as typeof setTimeout,
    );
    using _init = stub(
      ServingPortBridge.prototype,
      "init",
      () => Promise.resolve({ lifetimeLock: undefined }),
    );
    using _release = stub(
      ServingPortBridge.prototype,
      "releaseLeasesOf",
      () => 0,
    );
    using _close = stub(
      ServingPortBridge.prototype,
      "closeHost",
      () => Promise.resolve(),
    );
    using _commit = stub(
      EngineWaveCommitSink.prototype,
      "commitWave",
      () => Promise.resolve({ ok: { seq: 1 } }),
    );
    const policy = { failureParkBackoffBaseMs: 10 };
    const host = new ServingWorker({
      server,
      identity,
      apiUrl: new URL(import.meta.url),
      policy,
    });
    /** Fails the current worker and waits for its replacement to serve. */
    const replace = async () => {
      await host.ready;
      const replacement = fakes.next();
      workers.at(-1)!.fail();
      restart!();
      await replacement;
      await host.ready;
    };
    try {
      await replace();
      workers[1].post({
        t: "note",
        method: "host.activationSettled",
        params: { space, outcome: "active" },
      });
      await replace();
      const answered = workers[2].answered(1);
      workers[2].post({
        t: "req",
        id: 1,
        method: "sink.commitWave",
        params: {
          sessionId: "holder",
          localSeq: 1,
          batch: encodeMemoryBoundary({ space } as unknown as FabricValue),
        },
      });
      await answered;
      await replace();
      expect(delays).toEqual([10, 20, 10]);
    } finally {
      await host.close();
    }
  });

  describe("the watchdog", () => {
    /** Lets `intervals` of the worker's watchdog intervals pass. */
    const pass = (intervals: number) => clock.tick(intervals * 10_000);

    /** A running worker whose memory server keeps `leases`. */
    const serving = async (
      leases: ExecutionLeases,
      over: Partial<Server> = {},
    ) => {
      const host = new ServingWorker({
        server: {
          ...server,
          executionLeases: leases,
          ...over,
        } as unknown as Server,
        identity,
        apiUrl: new URL(import.meta.url),
      });
      await host.ready;
      return host;
    };

    it("kills a worker after six intervals without a message, releases its leases, counts them lost, and starts a successor under a fresh holder", async () => {
      using fakes = fakeWorkers();
      const { workers } = fakes;
      let restart: (() => void) | undefined;
      using _timer = stub(
        globalThis,
        "setTimeout",
        ((callback: () => void) => {
          restart = callback;
          return 1;
        }) as typeof setTimeout,
      );
      using _init = stub(
        ServingPortBridge.prototype,
        "init",
        () => Promise.resolve({ lifetimeLock: undefined }),
      );
      using _close = stub(
        ServingPortBridge.prototype,
        "closeHost",
        () => Promise.resolve(),
      );
      const leases = new ExecutionLeases();
      const host = await serving(leases);
      try {
        const holder = executionLeaseHolder(identity.did());
        expect(leases.acquire(space, holder)).toBe(true);
        workers[0].post(anyMessage);

        // The first check reads the message; five silent ones are not enough.
        await pass(6);
        expect(workers[0].terminated).toBe(false);
        expect(leases.holderOf(space)).toBe(holder);

        await pass(1);
        expect(workers[0].terminated).toBe(true);
        expect(leases.holderOf(space)).toBeUndefined();
        expect(getServingLoopStats()?.lease.lost).toBe(1);

        const replacement = fakes.next();
        restart!();
        await replacement;
        await host.ready;
        const successor = executionLeaseHolder(identity.did());
        expect(successor).not.toBe(holder);
        expect(leases.acquire(space, successor)).toBe(true);

        // A successor's counters start over, and the loss still shows.
        workers[1].post({
          t: "note",
          method: "host.stats",
          params: { stats: emptyServingLoopStats() },
        });
        expect(host.stats()?.lease.lost).toBe(1);
        expect(getServingLoopStats()?.lease.lost).toBe(1);
      } finally {
        await host.close();
      }
    });

    it("restarts its count at a message of any kind", async () => {
      using fakes = fakeWorkers();
      const { workers } = fakes;
      using _timer = stub(
        globalThis,
        "setTimeout",
        (() => 1) as unknown as typeof setTimeout,
      );
      using _init = stub(
        ServingPortBridge.prototype,
        "init",
        () => Promise.resolve({ lifetimeLock: undefined }),
      );
      using _close = stub(
        ServingPortBridge.prototype,
        "closeHost",
        () => Promise.resolve(),
      );
      const host = await serving(new ExecutionLeases());
      try {
        workers[0].post(anyMessage);
        await pass(6);
        workers[0].post({
          t: "note",
          method: "worker.heartbeat",
          params: null,
        });
        await pass(6);
        workers[0].post({
          t: "req",
          id: 1,
          method: "server.idle",
          params: null,
        });
        await pass(6);
        expect(workers[0].terminated).toBe(false);
        await pass(1);
        expect(workers[0].terminated).toBe(true);
      } finally {
        await host.close();
      }
    });

    it("counts nothing before a worker's first message, since its modules may still be loading", async () => {
      using fakes = fakeWorkers();
      const { workers } = fakes;
      using _init = stub(
        ServingPortBridge.prototype,
        "init",
        () => new Promise<never>(() => {}),
      );
      using _release = stub(
        ServingPortBridge.prototype,
        "releaseLeasesOf",
        () => 0,
      );
      const host = new ServingWorker({
        server,
        identity,
        apiUrl: new URL(import.meta.url),
      });
      try {
        await pass(100);
        expect(workers[0].terminated).toBe(false);
      } finally {
        await host.close();
      }
    });

    it("fences a commit the killed worker left in flight", async () => {
      using fakes = fakeWorkers();
      const { workers } = fakes;
      using _timer = stub(
        globalThis,
        "setTimeout",
        (() => 1) as unknown as typeof setTimeout,
      );
      using _init = stub(
        ServingPortBridge.prototype,
        "init",
        () => Promise.resolve({ lifetimeLock: undefined }),
      );
      const leases = new ExecutionLeases();
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await Engine.open({
        url: toFileUrl(path),
        executionLeases: leases,
      });
      let opening = Promise.resolve();
      const host = await serving(leases, {
        engineForSpace: async () => {
          await opening;
          return engine;
        },
        noteExecutorCommit: () => {},
      });
      const commit = async (id: number, doc: string) => {
        const answered = workers[0].answered(id);
        workers[0].post({
          t: "req",
          id,
          method: "sink.commitWave",
          params: {
            sessionId: holder,
            localSeq: id,
            batch: encodeMemoryBoundary({
              space,
              home: true,
              basisSeq: Engine.serverSeq(engine),
              rebasedHeads: [],
              operations: [{ op: "set", id: doc, value: { value: { id } } }],
              preconditions: [],
              holder,
              annotations: [],
              consequenceOf: [],
              basisInstances: [],
            } as unknown as FabricValue),
          },
        });
        return await answered as {
          result: { ok?: unknown; error?: { message: string } };
        };
      };
      const holder = executionLeaseHolder(identity.did());
      // A process's own claim on the flag, which outlasts the killed worker's
      // bridge, so that the lease is what refuses the commit.
      const releaseServerExecution = acquireServerExecutionEnabler();
      try {
        expect(leases.acquire(space, holder)).toBe(true);
        expect((await commit(1, "of:before-the-kill")).result.ok).toBeDefined();
        const head = Engine.serverSeq(engine);

        // The commit waits on the engine past the kill, and the lease has gone
        // by the time it reaches admission.
        const held = defer<void>();
        opening = held.promise;
        const inFlight = commit(2, "of:after-the-kill");
        await pass(7);
        expect(workers[0].terminated).toBe(true);
        held.resolve();
        const { result } = await inFlight;
        expect(result.ok).toBeUndefined();
        expect(result.error?.message).toContain("execution lease");
        expect(Engine.serverSeq(engine)).toBe(head);
      } finally {
        await host.close();
        releaseServerExecution();
        Engine.close(engine);
        await Deno.remove(path);
      }
    });

    it("settles a close whose worker stalled before its host could answer", async () => {
      using fakes = fakeWorkers();
      const { workers } = fakes;
      using _init = stub(
        ServingPortBridge.prototype,
        "init",
        () => Promise.resolve({ lifetimeLock: undefined }),
      );
      const leases = new ExecutionLeases();
      const host = await serving(leases);
      const holder = executionLeaseHolder(identity.did());
      expect(leases.acquire(space, holder)).toBe(true);
      workers[0].post(anyMessage);

      const closed = host.close();
      await pass(7);
      await closed;

      expect(workers[0].terminated).toBe(true);
      expect(workers).toHaveLength(1);
      expect(leases.holderOf(space)).toBeUndefined();
    });
  });
});
