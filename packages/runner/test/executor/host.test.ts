import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { serverExecutionEnablerCount } from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { ExecutorHost } from "../../src/executor/host.ts";
import type { SpaceServer } from "../../src/executor/space-server.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("executor host close service");
const alice = await Identity.fromPassphrase("executor host close alice");
const bob = await Identity.fromPassphrase("executor host close bob");

/**
 * Serves alice's and bob's home spaces, each activated by a client session,
 * and hands `body` the host with both spaces served. Bob's serving runtime
 * resolves `heldDisposeStarted` when it starts disposing, and finishes only
 * once `releaseHeldDispose()` is called. Whatever `body` leaves behind — a
 * host still serving, a stubbed park — is undone before the server closes.
 */
async function withTwoServedSpaces(
  body: (served: {
    host: ExecutorHost;
    spaces: { alice: SpaceServer; bob: SpaceServer };
    heldDisposeStarted: Promise<void>;
    releaseHeldDispose: () => void;
    stubPark: (space: SpaceServer, park: () => Promise<void>) => void;
  }) => Promise<void>,
): Promise<void> {
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const held = bob.did() as MemorySpace;
  const heldDisposeStarted = Promise.withResolvers<void>();
  const releaseHeldDispose = Promise.withResolvers<void>();
  const activated = new Map<string, PromiseWithResolvers<void>>(
    [alice, bob].map((user) => [user.did(), Promise.withResolvers()]),
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
      storageManager: EmulatedStorageManager.connectTo(server, { as: user }),
      experimental: { serverExecution: true },
    })
  );
  const spaces: SpaceServer[] = [];
  const stubs: Array<{ restored: boolean; restore(): void }> = [];
  try {
    for (const [index, user] of [alice, bob].entries()) {
      await clients[index].getCell(user.did(), "open a session").sync();
    }
    await Promise.all([...activated.values()].map((a) => a.promise));
    for (const user of [alice, bob]) {
      spaces.push(host.spaceServer(user.did() as MemorySpace)!);
    }
    await body({
      host,
      spaces: { alice: spaces[0], bob: spaces[1] },
      heldDisposeStarted: heldDisposeStarted.promise,
      releaseHeldDispose: () => releaseHeldDispose.resolve(),
      stubPark: (space, park) => {
        stubs.push(stub(space, "park", park));
      },
    });
  } finally {
    // A stubbed park stood in for its space's real one, so that space's
    // runtime is still up; with the real park back, closing the host (again,
    // if the case already did) and parking each space dispose it.
    for (const parkStub of stubs) {
      if (!parkStub.restored) parkStub.restore();
    }
    releaseHeldDispose.resolve();
    await host.close().catch(() => {});
    for (const space of spaces) await space.park("test cleanup");
    for (const client of clients) await client.dispose();
    await server.close();
  }
}

describe("ExecutorHost", () => {
  describe("instance members", () => {
    describe("close()", () => {
      it("settles only after every space has parked, and rejects with a park's failure", async () => {
        // Alice's park rejects once bob's runtime has begun disposing, and
        // that dispose is held until a later turn. A close that settled on
        // the first failure would settle before the held dispose finishes,
        // and the memory server a caller closes next would be torn down
        // under it.

        const enablersBefore = serverExecutionEnablerCount();
        await withTwoServedSpaces(async (served) => {
          const parkFailure = new Error("park failed");
          served.stubPark(served.spaces.alice, async () => {
            await served.heldDisposeStarted;
            throw parkFailure;
          });

          const order: string[] = [];
          const closed = served.host.close().then(
            () => order.push("close resolved"),
            (error) => {
              order.push("close rejected");
              return error;
            },
          );
          await served.heldDisposeStarted;
          // A zero-delay turn runs after every microtask already queued, so
          // a close settling on the first rejection has settled by now.
          await new Promise((resolve) => setTimeout(resolve, 0));
          order.push("held dispose released");
          served.releaseHeldDispose();
          const outcome = await closed;

          expect(order).toEqual(["held dispose released", "close rejected"]);
          expect(outcome).toBe(parkFailure);
          // Still claimed: the two clients, and alice's serving runtime, which
          // the stubbed park left up. The host's own claim is released.
          expect(serverExecutionEnablerCount()).toBe(enablersBefore + 3);
        });
      });

      it("rejects with an `AggregateError` holding each failure when several spaces fail to park", async () => {
        await withTwoServedSpaces(async (served) => {
          const failures = [new Error("alice failed"), new Error("bob failed")];
          served.stubPark(
            served.spaces.alice,
            () => Promise.reject(failures[0]),
          );
          served.stubPark(served.spaces.bob, () => Promise.reject(failures[1]));

          const error = await served.host.close().then(
            () => undefined,
            (reason: unknown) => reason,
          );

          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual(failures);
        });
      });
    });
  });
});
