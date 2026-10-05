import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";

const signer = await Identity.fromPassphrase("runtime settled");
const space = signer.did();

describe("Runtime", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  describe("instance members", () => {
    for (
      const [name, settle] of [
        ["settled()", () => runtime.settled()],
        [
          "settledFor()",
          () => runtime.settledFor(runtime.getCell(space, "owner", undefined)),
        ],
      ] as const
    ) {
      describe(name, () => {
        it("does not return before an action queued during its storage sync wait has run", async () => {
          // The barrier waits for the scheduler and then for storage sync. The
          // action arrives while the sync wait is held open, after the
          // scheduler wait has already returned.

          const syncEntered = Promise.withResolvers<void>();
          const releaseSync = Promise.withResolvers<void>();
          const synced = storageManager.synced.bind(storageManager);
          const syncStub = stub(storageManager, "synced", async () => {
            syncEntered.resolve();
            await releaseSync.promise;
            return synced();
          });
          const order: string[] = [];
          const action: Action = () => {
            order.push("ran");
          };
          try {
            const settling = settle().then(() => {
              order.push("settled");
            });
            await syncEntered.promise;
            runtime.scheduler.subscribe(action, {
              reads: [],
              shallowReads: [],
              writes: [],
            }, { isEffect: true });
            releaseSync.resolve();
            await settling;
            expect(order).toEqual(["ran", "settled"]);
          } finally {
            runtime.scheduler.unsubscribe(action);
            syncStub.restore();
          }
        });
      });
    }
  });
});
