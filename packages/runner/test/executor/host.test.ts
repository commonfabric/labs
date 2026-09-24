import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { serverExecutionEnablerCount } from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { ExecutorHost } from "../../src/executor/host.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("executor host close service");
const alice = await Identity.fromPassphrase("executor host close alice");
const bob = await Identity.fromPassphrase("executor host close bob");

describe("ExecutorHost", () => {
  describe("instance members", () => {
    describe("close()", () => {
      it("settles only after every space has parked, and rejects with a park's failure", async () => {
        // One space's park rejects once the other's runtime has begun
        // disposing; that dispose is held until a later turn. A close that
        // settled on the first failure would settle before the held dispose
        // finishes, and the memory server a caller closes next would be torn
        // down under it.

        const enablersBefore = serverExecutionEnablerCount();
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const failing = alice.did() as MemorySpace;
        const held = bob.did() as MemorySpace;
        const heldDisposeStarted = Promise.withResolvers<void>();
        const releaseHeldDispose = Promise.withResolvers<void>();
        const activated = new Map<string, PromiseWithResolvers<void>>(
          [failing, held].map((space) => [space, Promise.withResolvers()]),
        );
        const factory = servingRuntimeFactory({
          server,
          identity: service,
          apiUrl: new URL(import.meta.url),
        });
        const host = new ExecutorHost({
          server,
          serviceIdentity: service.did(),
          ensureSpaceRoots: false,
          policy: { idleParkMs: 600_000 },
          createRuntime: async (space, context) => {
            const built = await factory(space, context);
            if (space !== held) return built;
            return {
              runtime: built.runtime,
              dispose: async () => {
                heldDisposeStarted.resolve();
                await releaseHeldDispose.promise;
                await built.dispose();
              },
            };
          },
          onActivationSettled: (space, outcome) => {
            if (outcome === "active") activated.get(space)?.resolve();
          },
        });
        const clients = [alice, bob].map((user) =>
          new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: EmulatedStorageManager.connectTo(server, {
              as: user,
            }),
            experimental: { serverExecution: true },
          })
        );
        try {
          for (const [index, client] of clients.entries()) {
            const space = [failing, held][index];
            await client.getCell(space, "open a session").sync();
          }
          await Promise.all([...activated.values()].map((a) => a.promise));
          const parkFailure = new Error("park failed");
          const failingServer = host.spaceServer(failing)!;
          const parkStub = stub(failingServer, "park", async () => {
            await heldDisposeStarted.promise;
            throw parkFailure;
          });

          const order: string[] = [];
          const closed = host.close().then(
            () => order.push("close resolved"),
            (error) => {
              order.push("close rejected");
              return error;
            },
          );
          await heldDisposeStarted.promise;
          // A zero-delay turn runs after every microtask already queued, so
          // a close settling on the first rejection has settled by now.
          await new Promise((resolve) => setTimeout(resolve, 0));
          order.push("held dispose released");
          releaseHeldDispose.resolve();
          const outcome = await closed;
          parkStub.restore();
          // The stub stood in for this space's park, so its runtime is still
          // up; the real park disposes it.
          await failingServer.park("test cleanup");

          expect(order).toEqual(["held dispose released", "close rejected"]);
          expect(outcome).toBe(parkFailure);
          // What remains claimed is the two clients' own enablers: the host's
          // claim was released despite the failed park.
          expect(serverExecutionEnablerCount()).toBe(
            enablersBefore + clients.length,
          );
        } finally {
          releaseHeldDispose.resolve();
          for (const client of clients) await client.dispose();
          await server.close();
        }
      });
    });
  });
});
