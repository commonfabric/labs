import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { NormalizedLink } from "../src/link-types.ts";
import {
  type MemorySpace,
  ReplicaLoadFailureError,
  type URI,
} from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/v2.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

describe("storage pending-load generations", () => {
  let env: SchedulerTestRuntime;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  it("rejects event attention resolution when the replica lacks the capability", async () => {
    const storage = {
      open: () => ({ replica: {} }),
    };
    await expect(
      StorageManager.prototype.resolveEventAttention.call(
        storage,
        space,
        "of:event",
        1,
        "of:sidecar",
        "retry",
      ),
    ).rejects.toThrow("storage replica does not support event attention");
  });

  it("keeps the document pending until its CFC schema load settles", async () => {
    const { runtime, tx } = env;
    const cell = runtime.getCell(space, "pending-through-cfc", undefined);
    await tx.commit().settled;
    env.tx = runtime.edit();

    const storage = runtime.storageManager as StorageManager;
    const schemaStarted = Promise.withResolvers<void>();
    const releaseSchema = Promise.withResolvers<void>();
    storage.accessForTestingOnly.cfcSchemaDocumentSyncer = async () => {
      schemaStarted.resolve();
      await releaseSchema.promise;
      return undefined;
    };

    const sync = storage.syncCell(cell);
    await schemaStarted.promise;

    const address = cell.getAsNormalizedFullLink();
    const key = `${address.space}/${address.scope}/${address.id}`;
    expect(storage.pendingLoadGeneration(key)).toBeDefined();

    let settled = false;
    const pending = storage.loadsSettled([key]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSchema.resolve();
    await sync;
    await pending;
    expect(storage.pendingLoadGeneration(key)).toBeUndefined();
  });

  it("tracks linked-document pulls kicked from data values", async () => {
    const { runtime } = env;
    const storage = runtime.storageManager as StorageManager;
    const targetId = "of:pending-linked-target";
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async (id: string, ...args: unknown[]) => {
              if (id === targetId) {
                syncStarted.resolve();
                await releaseSync.promise;
                return { ok: {} };
              }
              return (target.sync as (
                ...values: unknown[]
              ) => Promise<unknown>)(
                id,
                ...args,
              );
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    const base: NormalizedLink = {
      space,
      id: "of:data-root" as URI,
      scope: "space",
      path: [],
    };
    const value = {
      "/": {
        "link@1": { id: targetId, path: [], space },
      },
    };
    const promises: Promise<unknown>[] = [];
    storage.accessForTestingOnly.collectLinkedCellSyncs(
      value,
      base,
      undefined,
      promises,
      new Set(),
    );
    await syncStarted.promise;

    const key = `${space}/space/${targetId}`;
    expect(storage.pendingLoadGeneration(key)).toBeDefined();
    releaseSync.resolve();
    await Promise.all(promises);
    expect(storage.pendingLoadGeneration(key)).toBeUndefined();
  });

  it("releases the pending generation when syncCell rejects", async () => {
    const { runtime } = env;
    const storage = runtime.storageManager as StorageManager;
    const id = "of:pending-sync-rejection";
    const cell = runtime.getCell(space, id);
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => Promise.reject(new Error("provider sync rejected"));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const address = cell.getAsNormalizedFullLink();
      const key = `${address.space}/${address.scope}/${address.id}`;
      const sync = storage.syncCell(cell);
      const settled = storage.loadsSettled([key]);
      await expect(sync).rejects.toThrow("provider sync rejected");
      await expect(settled).rejects.toThrow("provider sync rejected");
      expect(storage.pendingLoadGeneration(key)).toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("releases linked-document loads when provider sync throws synchronously", () => {
    const storage = env.runtime.storageManager as StorageManager;
    const targetId = "of:pending-linked-sync-throw";
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => {
              throw new Error("linked provider sync threw");
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const base: NormalizedLink = {
        space,
        id: "of:throwing-data-root" as URI,
        scope: "space",
        path: [],
      };
      const value = {
        "/": { "link@1": { id: targetId, path: [], space } },
      };
      expect(() =>
        storage.accessForTestingOnly.collectLinkedCellSyncs(
          value,
          base,
          undefined,
          [],
          new Set(),
        )
      ).toThrow("linked provider sync threw");
      expect(storage.pendingLoadGeneration(`${space}/space/${targetId}`))
        .toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("rejects linked-document loads when provider sync rejects", async () => {
    const storage = env.runtime.storageManager as StorageManager;
    const targetId = "of:pending-linked-sync-rejection";
    const originalOpen = storage.open.bind(storage);
    storage.open = (openSpace: MemorySpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return () => Promise.reject(new Error("linked provider rejected"));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const base: NormalizedLink = {
        space,
        id: "of:rejecting-data-root" as URI,
        scope: "space",
        path: [],
      };
      const value = {
        "/": { "link@1": { id: targetId, path: [], space } },
      };
      const promises: Promise<unknown>[] = [];
      storage.accessForTestingOnly.collectLinkedCellSyncs(
        value,
        base,
        undefined,
        promises,
        new Set(),
      );
      const key = `${space}/space/${targetId}`;
      const settled = storage.loadsSettled([key]);
      await expect(Promise.all(promises)).rejects.toThrow(
        "linked provider rejected",
      );
      await expect(settled).rejects.toThrow("linked provider rejected");
      expect(storage.pendingLoadGeneration(key)).toBeUndefined();
    } finally {
      storage.open = originalOpen;
    }
  });

  it("rejects failed generations and gives a later load a new identity", async () => {
    const storage = env.runtime.storageManager as StorageManager;
    const address = {
      space,
      scope: "space" as const,
      id: "of:generation" as URI,
    };
    const key = `${address.space}/${address.scope}/${address.id}`;
    const recoveries: Array<{
      failedEpoch: string;
      recoveryEpoch: string;
    }> = [];
    storage.loadRecoveryObserver = (recovery: typeof recoveries[number]) => {
      recoveries.push(recovery);
    };

    const releaseFirst = storage.accessForTestingOnly.registerPendingLoad(
      address,
    );
    const firstGeneration = storage.pendingLoadGeneration(key);
    expect(firstGeneration).toBeDefined();
    expect(recoveries).toEqual([]);
    const firstSettled = storage.loadsSettled([key]);
    releaseFirst(new Error("transport failed"));
    await expect(firstSettled).rejects.toThrow("transport failed");
    expect(recoveries).toEqual([]);

    const releaseSecond = storage.accessForTestingOnly.registerPendingLoad(
      address,
    );
    const secondGeneration = storage.pendingLoadGeneration(key);
    expect(secondGeneration).toBeGreaterThan(firstGeneration!);
    expect(recoveries).toEqual([]);
    releaseSecond();
    await storage.loadsSettled([key]);
    expect(recoveries).toEqual([{
      failedEpoch: `load-key:${key}`,
      recoveryEpoch: expect.stringContaining(`:${secondGeneration}`),
    }]);
  });

  it("matches a failed load after the storage manager is recreated", async () => {
    const first = env.runtime.storageManager as StorageManager;
    const address = {
      space,
      scope: "space" as const,
      id: "of:recreated-generation" as URI,
    };
    const key = `${address.space}/${address.scope}/${address.id}`;
    const releaseFirst = first.accessForTestingOnly.registerPendingLoad(
      address,
    );
    const firstSettled = first.loadsSettled([key]);
    releaseFirst(new Error("transport failed before recreation"));

    let failedEpoch: string | undefined;
    try {
      await firstSettled;
    } catch (error) {
      expect(error).toBeInstanceOf(ReplicaLoadFailureError);
      failedEpoch = (error as ReplicaLoadFailureError).failure.recoveryEpoch;
    }
    expect(failedEpoch).toBeDefined();

    const replacementEnv = createSchedulerTestRuntime(import.meta.url);
    try {
      const replacement = replacementEnv.runtime
        .storageManager as StorageManager;
      let recovery:
        | { failedEpoch: string; recoveryEpoch: string }
        | undefined;
      replacement.loadRecoveryObserver = (value: typeof recovery) => {
        recovery = value;
      };
      const releaseReplacement = replacement.accessForTestingOnly
        .registerPendingLoad(address);
      expect(recovery).toBeUndefined();
      releaseReplacement();
      expect(recovery?.failedEpoch).toBe(failedEpoch);
      expect(recovery?.recoveryEpoch).not.toBe(failedEpoch);
    } finally {
      await disposeSchedulerTestRuntime(replacementEnv);
    }
  });
});
