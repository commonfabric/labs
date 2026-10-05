import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isDeepFrozen } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  ExtendedStorageTransaction,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runtime-edit");

/**
 * Opens `count` transactions on a fresh runtime, and reports how many objects
 * `Object.freeze()` was asked to freeze while they opened.
 *
 * Every read that holds no transaction of its own opens one, so what an open
 * freezes is paid once per such read. A count that tracks `count` is an open
 * freezing something of its own.
 */
const freezesToOpen = async (count: number): Promise<number> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const freeze = Object.freeze;
    let freezes = 0;
    Object.freeze = (<T>(value: T): T => {
      freezes++;
      return freeze(value);
    }) as typeof Object.freeze;

    const opened = [];
    try {
      for (let index = 0; index < count; index++) {
        opened.push(runtime.edit());
      }
    } finally {
      Object.freeze = freeze;
    }
    for (const tx of opened) tx.abort("counted");
    return freezes;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("Runtime", () => {
  describe("instance members", () => {
    describe("edit()", () => {
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
        await storageManager.close();
      });

      it("freezes as many objects to open 200 transactions as to open 20", async () => {
        const short = await freezesToOpen(20);
        const long = await freezesToOpen(200);

        // Both bounds are needed: the equality alone would hold for two counts
        // that each grew with the number opened, and the bound alone would
        // hold for a count that grew slowly.
        expect(long).toBe(short);
        expect(long).toBeLessThan(20);
      });

      it("attaches one deep-frozen trust snapshot, naming the storage manager's principal, to every transaction it opens", () => {
        const first = runtime.edit();
        const second = runtime.edit();
        const snapshot = first.getCfcState().trustSnapshot;

        expect(snapshot).toEqual(
          runtime.trustSnapshotForPrincipal(signer.did()),
        );
        expect(isDeepFrozen(snapshot)).toBe(true);
        expect(second.getCfcState().trustSnapshot).toBe(snapshot);
        expect(runtime.trustSnapshotProvider()).toBe(snapshot);
        first.abort("inspected");
        second.abort("inspected");
      });

      it("attaches what a custom `trustSnapshotProvider` returns when it opens each transaction", async () => {
        let actor = "did:key:first-actor";
        const customStorage = StorageManager.emulate({ as: signer });
        const custom = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: customStorage,
          trustSnapshotProvider: () => ({
            id: `principal:${actor}`,
            actingPrincipal: actor,
          }),
        });
        try {
          const first = custom.edit();
          actor = "did:key:second-actor";
          const second = custom.edit();

          expect(first.getCfcState().trustSnapshot?.actingPrincipal).toBe(
            "did:key:first-actor",
          );
          expect(second.getCfcState().trustSnapshot?.actingPrincipal).toBe(
            "did:key:second-actor",
          );
          first.abort("inspected");
          second.abort("inspected");
        } finally {
          await custom.dispose();
          await customStorage.close();
        }
      });

      it("leaves every other transaction's trust snapshot as it was when one transaction's is replaced", () => {
        const first = runtime.edit();
        const second = runtime.edit();
        setCfcTrustSnapshot(
          first,
          runtime.trustSnapshotForPrincipal("did:key:acting-user"),
        );
        const third = runtime.edit();

        const ambient = runtime.trustSnapshotForPrincipal(signer.did());
        expect(first.getCfcState().trustSnapshot?.actingPrincipal).toBe(
          "did:key:acting-user",
        );
        expect(second.getCfcState().trustSnapshot).toEqual(ambient);
        expect(third.getCfcState().trustSnapshot).toEqual(ambient);
        first.abort("inspected");
        second.abort("inspected");
        third.abort("inspected");
      });

      it("hands every transaction it opens the same frozen instrumentation hooks", () => {
        const first = runtime.edit() as ExtendedStorageTransaction;
        const second = runtime.edit() as ExtendedStorageTransaction;
        const hooks = first.accessForTestingOnly.cfcInstrumentation;

        expect(typeof hooks.onRelevantTx).toBe("function");
        expect(Object.isFrozen(hooks)).toBe(true);
        expect(second.accessForTestingOnly.cfcInstrumentation).toBe(hooks);
        first.abort("inspected");
        second.abort("inspected");
      });

      it("counts a transaction's CFC work into the runtime's stats as they stand when the work is done", () => {
        // The hooks are built before any of these transactions opens, so a
        // count landing in the stats `resetCfcStats()` put in place shows a
        // hook reading the stats when it is called rather than when it was
        // built.

        const first = runtime.edit();
        const second = runtime.edit();
        first.markCfcRelevant();
        second.markCfcRelevant();
        expect(runtime.getCfcStats().cfcRelevantTx).toBe(2);

        runtime.resetCfcStats();
        const afterReset = runtime.edit();
        afterReset.markCfcRelevant();
        expect(runtime.getCfcStats().cfcRelevantTx).toBe(1);

        const openedBeforeReset = runtime.edit();
        runtime.resetCfcStats();
        openedBeforeReset.markCfcRelevant();
        expect(runtime.getCfcStats().cfcRelevantTx).toBe(1);
        for (const tx of [first, second, afterReset, openedBeforeReset]) {
          tx.abort("counted");
        }
      });
    });
  });
});
