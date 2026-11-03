import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";

import { ServingWorker } from "../../src/executor/serving-worker-host.ts";
import { getServingLoopStats } from "../../src/executor/stats.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("watchdog space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("watchdog service");

describe("serving-worker-watchdog", () => {
  it("replaces a worker whose thread stalled holding a lease, and refuses its commits", async () => {
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
    const respawned = defer<void>();
    let spawned = 0;
    const RealWorker = globalThis.Worker;
    globalThis.Worker = class extends RealWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (++spawned === 2) respawned.resolve();
      }
    };
    const worker = new ServingWorker({
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
    });
    try {
      await worker.ready;
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
      await respawned.promise;
      await worker.ready;

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
      globalThis.Worker = RealWorker;
      await worker.close();
      await server.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
