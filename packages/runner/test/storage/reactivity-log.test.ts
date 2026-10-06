import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { toDocumentPath } from "@commonfabric/memory/v2";

import { Runtime } from "../../src/runtime.ts";
import { txToReactivityLog } from "../../src/scheduler.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
  reactivityLogFromActivities,
} from "../../src/storage/reactivity-log.ts";
import { getDirectTransactionReactivityLog } from "../../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("ignored-attempted-writes");
const space = signer.did();

describe("reactivity-log", () => {
  it("retains ignored attempted writes independently of scheduling read depth", () => {
    const address = {
      space,
      scope: "space" as const,
      id: "of:test" as const,
      path: toDocumentPath(["value", "slot"]),
    };
    for (const nonRecursive of [false, true]) {
      const log = reactivityLogFromActivities([{
        read: {
          ...address,
          nonRecursive,
          meta: { ...ignoreReadForScheduling, ...markReadAsAttemptedWrite },
        },
      }]);
      expect(log).toEqual({
        reads: [],
        shallowReads: [],
        writes: [],
        attemptedWrites: [address],
      });
      expect(reactivityLogFromActivities([{
        read: { ...address, nonRecursive, meta: ignoreReadForScheduling },
      }])).toEqual({ reads: [], shallowReads: [], writes: [] });
    }
  });

  it("keeps no-op Cell writes in native transaction evidence without scheduling reads", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      let tx = runtime.edit();
      const cell = runtime.getCell<{ slot: number }>(
        space,
        "target",
        undefined,
        tx,
      );
      cell.set({ slot: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      tx = runtime.edit();
      tx.runWithAmbientReadMeta(
        ignoreReadForScheduling,
        () => cell.withTx(tx).key("slot").set(1),
      );
      const log = getDirectTransactionReactivityLog(tx)!;
      expect(log.attemptedWrites).toContainEqual({
        space,
        scope: "space",
        id: cell.getAsNormalizedFullLink().id,
        path: ["value", "slot"],
      });
      expect(log.reads).toEqual([]);
      expect(log.shallowReads).toEqual([]);
      expect(log.writes).toEqual([]);
      expect(txToReactivityLog(tx)).toEqual({
        reads: [],
        shallowReads: [],
        writes: [],
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    } finally {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    }
  });
  it("keeps ignored attempted reads in transaction conflict validation", async () => {
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const seed = runtime.edit();
      const source = runtime.getCell<number>(
        space,
        "conflict-source",
        undefined,
        seed,
      );
      source.set(1);
      expect((await seed.commit().settled).error).toBeUndefined();
      const stale = runtime.edit();
      expect(stale.readValueOrThrow(source.getAsNormalizedFullLink(), {
        meta: { ...ignoreReadForScheduling, ...markReadAsAttemptedWrite },
      })).toBe(1);
      runtime.getCell<number>(space, "conflict-output", undefined, stale).set(
        1,
      );
      const concurrent = runtime.edit();
      source.withTx(concurrent).set(2);
      expect((await concurrent.commit().settled).error).toBeUndefined();
      expect((await stale.commit().settled).error).toBeDefined();
    } finally {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    }
  });
});
