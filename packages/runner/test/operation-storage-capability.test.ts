import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import {
  type ApplyOpOperation,
  type ApplyOpResolution,
  type OperationFieldSnapshot,
  type ReleaseOpFieldOperation,
  type SessionSync,
  toValuePath,
  type WatchSpec,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { defer } from "@commonfabric/utils/defer";
import { hashStringOf } from "@commonfabric/data-model";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { hasOperationStorageCapability } from "../src/storage/interface.ts";
import {
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("operation storage capability");

describe("operation storage capability", () => {
  it("replays watches and pre-issue applies across a route replacement", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const firstApply = defer<never>();
    const applyStarted = defer<void>();
    const appliedSubmissionIds: string[] = [];
    let sessions = 0;
    let watchAdds = 0;
    const resolution = {
      operationIndex: 0,
      address: {
        branch: "",
        id: "of:route-operation",
        scopeKey: "space",
        path: toValuePath([]),
      },
      codec: "test@1",
      submissionId: "route:1",
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: [],
      duplicate: false,
    } satisfies ApplyOpResolution;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          {
            as: signer,
            memoryHost: new URL("https://default-toolshed.test"),
          },
          {
            create: () => {
              sessions++;
              const sessionNumber = sessions;
              const client = {
                serverFlags: {
                  applyOp: true,
                  operationCodecs: ["test@1"],
                },
                close: () => Promise.resolve(),
              } as unknown as MemoryV2Client.Client;
              const session = {
                subscribeAccessLoss: () => () => {},
                watchAddSync: () => {
                  watchAdds++;
                  return Promise.resolve({
                    view: MemoryV2Client.WatchView.fromSync(sync),
                    sync,
                    precedingSyncs: [],
                  });
                },
                watchRemoveSync: () =>
                  Promise.resolve({
                    view: MemoryV2Client.WatchView.fromSync(sync),
                    sync,
                    precedingSyncs: [],
                  }),
                transact: (commit: {
                  operations: (ApplyOpOperation | ReleaseOpFieldOperation)[];
                }) => {
                  const operation = commit.operations[0];
                  if (operation.op === "apply-op") {
                    appliedSubmissionIds.push(operation.submissionId);
                  }
                  if (sessionNumber === 1) {
                    applyStarted.resolve();
                    return firstApply.promise;
                  }
                  return Promise.resolve({
                    operationResolutions: [resolution],
                  });
                },
              } as unknown as MemoryV2Client.SpaceSession;
              return Promise.resolve({ client, session });
            },
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    expect(hasOperationStorageCapability(provider)).toBe(true);
    if (!hasOperationStorageCapability(provider)) return;
    expect(await provider.operationCodecs()).toEqual(["test@1"]);

    const cancel = await provider.subscribeOperationField({
      id: "of:route-operation",
      path: toValuePath([]),
    }, () => {});
    const applying = provider.applyOperation({
      op: "apply-op",
      id: "of:route-operation",
      path: toValuePath([]),
      codec: "test@1",
      submissionId: "route:1",
      base: null,
      baselineHash: "baseline",
      payload: {},
    });
    await applyStarted.promise;

    expect(
      storage.registerSpaceHost(
        signer.did(),
        "https://hinted-toolshed.test",
      ),
    ).toBe(true);
    firstApply.reject(new Error("memory replica route replaced"));
    await storage.crossSpaceSettled();

    await expect(applying).resolves.toEqual(resolution);
    expect(sessions).toBe(2);
    expect(watchAdds).toBe(2);
    expect(appliedSubmissionIds).toEqual(["route:1", "route:1"]);
    await provider.releaseOperationField({
      op: "release-op-field",
      id: "of:route-operation",
      path: toValuePath([]),
      codec: "test@1",
      cursor: { epoch: 1, version: 1 },
    });
    cancel();
    cancel();
    await storage.closeNow();
    await expect(provider.subscribeOperationField({
      id: "of:closed-provider",
      path: toValuePath([]),
    }, () => {})).rejects.toThrow("memory provider closed");
  });

  it("retries a provider watch whose route changes during installation", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const firstAddition = defer<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
      precedingSyncs: SessionSync[];
    }>();
    const firstAdditionStarted = defer<void>();
    let sessions = 0;
    let additions = 0;
    let removals = 0;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          {
            as: signer,
            memoryHost: new URL("https://default-toolshed.test"),
          },
          {
            create: () => {
              sessions++;
              const sessionNumber = sessions;
              const client = {
                serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
                close: () => Promise.resolve(),
              } as unknown as MemoryV2Client.Client;
              const session = {
                subscribeAccessLoss: () => () => {},
                watchAddSync: () => {
                  additions++;
                  if (sessionNumber === 1) {
                    firstAdditionStarted.resolve();
                    return firstAddition.promise;
                  }
                  return Promise.resolve({
                    view: MemoryV2Client.WatchView.fromSync(sync),
                    sync,
                    precedingSyncs: [],
                  });
                },
                watchRemoveSync: () => {
                  removals++;
                  return Promise.resolve({
                    view: MemoryV2Client.WatchView.fromSync(sync),
                    sync,
                    precedingSyncs: [],
                  });
                },
              } as unknown as MemoryV2Client.SpaceSession;
              return Promise.resolve({ client, session });
            },
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    if (!hasOperationStorageCapability(provider)) return;

    const subscribing = provider.subscribeOperationField({
      id: "of:route-watch-installation",
      path: toValuePath([]),
    }, () => {});
    await firstAdditionStarted.promise;
    expect(
      storage.registerSpaceHost(
        signer.did(),
        "https://hinted-toolshed.test",
      ),
    ).toBe(true);
    const settled = storage.crossSpaceSettled();
    firstAddition.resolve({
      view: MemoryV2Client.WatchView.fromSync(sync),
      sync,
      precedingSyncs: [],
    });

    const cancel = await subscribing;
    await settled;
    expect(sessions).toBe(2);
    expect(additions).toBe(2);
    expect(removals).toBe(0);
    cancel();
    cancel();
    await storage.closeNow();
  });

  it("retries a provider watch that settles after its replica changes", async () => {
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          {
            create: () => Promise.reject(new Error("session should not open")),
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    if (!hasOperationStorageCapability(provider)) return;
    const firstAddition = defer<() => void>();
    const firstAdditionStarted = defer<void>();
    let firstCancellations = 0;
    let secondCancellations = 0;
    const secondReplica = {
      subscribeOperationField: () =>
        Promise.resolve(() => secondCancellations++),
      closeNow: () => Promise.resolve(),
    };
    (provider as unknown as { replica: unknown }).replica = {
      subscribeOperationField: () => {
        firstAdditionStarted.resolve();
        return firstAddition.promise;
      },
    };

    const subscribing = provider.subscribeOperationField({
      id: "of:changed-replica-watch",
      path: toValuePath([]),
    }, () => {});
    await firstAdditionStarted.promise;
    (provider as unknown as { replica: unknown }).replica = secondReplica;
    firstAddition.resolve(() => firstCancellations++);

    const cancel = await subscribing;
    expect(firstCancellations).toBe(1);
    expect(secondCancellations).toBe(0);
    cancel();
    expect(secondCancellations).toBe(1);
    await storage.closeNow();
  });

  it("removes failed provider subscriptions", async () => {
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          {
            create: () =>
              Promise.resolve({
                client: {
                  serverFlags: { applyOp: true },
                  close: () => Promise.resolve(),
                } as unknown as MemoryV2Client.Client,
                session: {
                  subscribeAccessLoss: () => () => {},
                  watchAddSync: () => Promise.reject(new Error("watch failed")),
                } as unknown as MemoryV2Client.SpaceSession,
              }),
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    if (!hasOperationStorageCapability(provider)) return;

    await expect(provider.subscribeOperationField({
      id: "of:failed-provider-watch",
      path: toValuePath([]),
    }, () => {})).rejects.toThrow("watch failed");
    await storage.closeNow();
  });

  it("cancels provider subscriptions during both teardown paths", async () => {
    const createStorage = () =>
      new (class extends V2StorageManager {
        constructor() {
          super(
            { as: signer, memoryHost: new URL("memory://") },
            {
              create: () =>
                Promise.reject(new Error("session should not open")),
            },
          );
        }
      })();
    const query = {
      id: "of:provider-teardown",
      path: toValuePath([]),
    };

    const gracefulStorage = createStorage();
    const gracefulProvider = gracefulStorage.open(signer.did());
    if (!hasOperationStorageCapability(gracefulProvider)) return;
    let gracefulCancellations = 0;
    (gracefulProvider as unknown as { replica: unknown }).replica = {
      subscribeOperationField: () =>
        Promise.resolve(() => gracefulCancellations++),
      close: () => Promise.resolve(),
    };
    await gracefulProvider.subscribeOperationField(query, () => {});
    await gracefulStorage.close();
    expect(gracefulCancellations).toBe(1);

    const immediateStorage = createStorage();
    const immediateProvider = immediateStorage.open(signer.did());
    if (!hasOperationStorageCapability(immediateProvider)) return;
    const addition = defer<() => void>();
    const additionStarted = defer<void>();
    let immediateCancellations = 0;
    (immediateProvider as unknown as { replica: unknown }).replica = {
      subscribeOperationField: () => {
        additionStarted.resolve();
        return addition.promise;
      },
      closeNow: () => Promise.resolve(),
    };
    const subscribing = immediateProvider.subscribeOperationField(
      query,
      () => {},
    );
    await additionStarted.promise;
    await immediateStorage.closeNow();
    addition.resolve(() => immediateCancellations++);

    await expect(subscribing).rejects.toThrow("memory provider closed");
    expect(immediateCancellations).toBe(1);
  });

  it("fails closed when Memory lacks operation support or a resolution", async () => {
    const unsupportedClient = {
      serverFlags: { applyOp: false },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const unsupportedStorage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          {
            create: () =>
              Promise.resolve({
                client: unsupportedClient,
                session: {
                  subscribeAccessLoss: () => () => {},
                } as unknown as MemoryV2Client.SpaceSession,
              }),
          },
        );
      }
    })();
    const unsupported = unsupportedStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(unsupported)) return;
    expect(await unsupported.operationCodecs()).toEqual([]);
    await expect(unsupported.applyOperation({ op: "apply-op" } as never))
      .rejects.toThrow("does not support apply-op");
    await expect(unsupported.releaseOperationField({
      op: "release-op-field",
    } as never)).rejects.toThrow("does not support release-op-field");
    await unsupportedStorage.closeNow();

    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const session = {
      subscribeAccessLoss: () => () => {},
      transact: () => Promise.resolve({}),
    } as unknown as MemoryV2Client.SpaceSession;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    expect(await replica.operationCodecs()).toEqual(["test@1"]);
    await expect(replica.applyOperation({ op: "apply-op" } as never))
      .rejects.toThrow("no operation resolution");
    await replica.releaseOperationField({ op: "release-op-field" } as never);
    await storage.closeNow();
  });

  it("removes a failed subscription and isolates callback failures", async () => {
    const query = { id: "of:failed-watch", path: toValuePath([]) };
    const watchId = `operation:${hashStringOf(query)}`;
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
      operationFields: [{
        watchId,
        field: {
          branch: "",
          id: query.id,
          scopeKey: "space",
          path: query.path,
          active: false,
          codec: null,
          cursor: null,
          baselineHash: "baseline",
          materialized: "value",
          operations: [],
        },
      }],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    let attempts = 0;
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error("watch failed"));
        return Promise.resolve({ view, sync, precedingSyncs: [] });
      },
      watchRemoveSync: () =>
        Promise.resolve({ view, sync, precedingSyncs: [] }),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    await expect(replica.subscribeOperationField(query, () => {})).rejects
      .toThrow("watch failed");

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => errors.push(values);
    try {
      const cancel = await replica.subscribeOperationField(query, () => {
        throw new Error("subscriber failed");
      });
      expect(errors).toHaveLength(1);
      cancel();
    } finally {
      console.error = original;
      await storage.closeNow();
    }
  });

  it("exposes codec-neutral collaboration through a space replica", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const space = signer.did();

    try {
      const seed = storage.edit();
      expect(
        seed.write({
          space,
          id: "of:operation-storage",
          type: "application/json",
          path: [],
        }, { value: { body: "ac" } }).error,
      ).toBeUndefined();
      expect((await seed.commit()).error).toBeUndefined();

      const replica = storage.open(space).replica;
      expect(hasOperationStorageCapability(replica)).toBe(true);
      if (!hasOperationStorageCapability(replica)) return;

      expect(await replica.operationCodecs()).toContain(
        CODEMIRROR_CHANGESET_CODEC,
      );
      const initial = await replica.queryOperationField({
        id: "of:operation-storage",
        path: toValuePath(["body"]),
      });
      expect(initial).toMatchObject({ active: false, materialized: "ac" });

      const resolution = await replica.applyOperation({
        op: "apply-op",
        id: "of:operation-storage",
        path: toValuePath(["body"]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "runner:1",
        base: null,
        baselineHash: operationBaselineHash("ac"),
        payload: {
          updates: [{
            clientId: "runner",
            changes: [1, [0, "b"], 1],
          }],
        },
      });

      expect(resolution).toMatchObject({
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
      });
      expect(
        await replica.queryOperationField({
          id: "of:operation-storage",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        }),
      ).toMatchObject({
        active: true,
        cursor: { epoch: 1, version: 1 },
        materialized: "abc",
        operations: [{ opId: expect.stringMatching(/^op:/) }],
      });
    } finally {
      await storage.close();
    }
  });

  it("removes the Memory watch when the last operation subscriber cancels", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const removed = defer<readonly string[]>();
    const observerQuery = {
      id: "of:removal-observer",
      path: toValuePath([]),
    };
    const observerWatchId = `operation:${hashStringOf(observerQuery)}`;
    const observedDuringRemoval = defer<OperationFieldSnapshot>();
    const precedingRemovalSync: SessionSync = {
      ...sync,
      operationFields: [{
        watchId: observerWatchId,
        field: {
          branch: "",
          id: observerQuery.id,
          scopeKey: "space",
          path: observerQuery.path,
          active: false,
          codec: null,
          cursor: null,
          baselineHash: "observer-baseline",
          materialized: "observer-value",
          operations: [],
        },
      }],
    };
    let removalCount = 0;
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: (_watches: WatchSpec[]) =>
        Promise.resolve({ view, sync, precedingSyncs: [] }),
      watchRemoveSync: (watchIds: readonly string[]) => {
        removalCount++;
        if (removalCount === 1) removed.resolve(watchIds);
        return Promise.resolve({
          view,
          sync,
          precedingSyncs: removalCount === 1 ? [precedingRemovalSync] : [],
        });
      },
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: {
        applyOp: true,
        operationCodecs: [CODEMIRROR_CHANGESET_CODEC],
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const storage = new TestStorageManager();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) {
      throw new Error("operation capability unavailable");
    }

    const cancelObserver = await replica.subscribeOperationField(
      observerQuery,
      (snapshot) => observedDuringRemoval.resolve(snapshot),
    );

    const query = {
      id: "of:operation-watch",
      path: toValuePath(["body"]),
    };
    const cancelFirst = await replica.subscribeOperationField(
      query,
      (_snapshot: OperationFieldSnapshot) => {},
    );
    const cancelSecond = await replica.subscribeOperationField(
      query,
      (_snapshot: OperationFieldSnapshot) => {},
    );
    cancelFirst();
    expect(removalCount).toBe(0);
    cancelSecond();

    expect(await removed.promise).toHaveLength(1);
    expect(await observedDuringRemoval.promise).toMatchObject({
      id: observerQuery.id,
      materialized: "observer-value",
    });
    const cancelAfterRemoval = await replica.subscribeOperationField(
      query,
      () => {},
    );
    expect(removalCount).toBe(1);
    cancelAfterRemoval();
    const cancelAfterSecondRemoval = await replica.subscribeOperationField(
      query,
      () => {},
    );
    expect(removalCount).toBe(2);
    cancelAfterSecondRemoval();
    cancelObserver();
    await storage.closeNow();
  });

  it("consumes preceding syncs and a replacement watch view", async () => {
    const empty: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const firstView = MemoryV2Client.WatchView.fromSync(empty);
    const secondView = MemoryV2Client.WatchView.fromSync(empty);
    const secondQuery = {
      id: "of:second-watch",
      path: toValuePath(["body"]),
    };
    const secondWatchId = `operation:${hashStringOf(secondQuery)}`;
    const field = (version: number): OperationFieldSnapshot => ({
      branch: "",
      id: "of:second-watch",
      scopeKey: "space",
      path: toValuePath(["body"]),
      active: true,
      codec: CODEMIRROR_CHANGESET_CODEC,
      cursor: { epoch: 1, version },
      baselineHash: "baseline",
      materialized: `v${version}`,
      operations: [],
    });
    const delivery = (version: number): SessionSync => ({
      ...empty,
      toSeq: version,
      operationFields: [{
        watchId: secondWatchId,
        field: field(version),
      }],
    });
    let additions = 0;
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => {
        additions++;
        return Promise.resolve(
          additions === 1
            ? { view: firstView, sync: empty, precedingSyncs: [] }
            : {
              view: secondView,
              sync: empty,
              precedingSyncs: [delivery(1)],
            },
        );
      },
      watchRemoveSync: () =>
        Promise.resolve({
          view: secondView,
          sync: empty,
          precedingSyncs: [],
        }),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: {
        applyOp: true,
        operationCodecs: [CODEMIRROR_CHANGESET_CODEC],
      },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const storage = new TestStorageManager();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) {
      throw new Error("operation capability unavailable");
    }
    const delivered: number[] = [];
    const secondDelivery = defer<void>();

    const cancelFirst = await replica.subscribeOperationField({
      id: "of:first-watch",
      path: toValuePath(["body"]),
    }, () => {});
    const cancelSecond = await replica.subscribeOperationField({
      ...secondQuery,
    }, (snapshot) => {
      delivered.push(snapshot.cursor?.version ?? 0);
      if (snapshot.cursor?.version === 2) secondDelivery.resolve();
    });
    secondView.emit(delivery(2));
    await secondDelivery.promise;

    expect(delivered).toEqual([1, 2]);
    cancelFirst();
    cancelSecond();
    await storage.closeNow();
  });

  it("closes operation watches that resolve during replica teardown", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const createStorage = (session: MemoryV2Client.SpaceSession) =>
      new (class extends V2StorageManager {
        constructor() {
          super(
            { as: signer, memoryHost: new URL("memory://") },
            { create: () => Promise.resolve({ client, session }) },
          );
        }
      })();

    const addition = defer<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
      precedingSyncs: SessionSync[];
    }>();
    const additionStarted = defer<void>();
    const lateAdditionView = MemoryV2Client.WatchView.fromSync(sync);
    const addingStorage = createStorage({
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => {
        additionStarted.resolve();
        return addition.promise;
      },
    } as unknown as MemoryV2Client.SpaceSession);
    const addingReplica = addingStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(addingReplica)) return;
    const subscribing = addingReplica.subscribeOperationField({
      id: "of:late-addition",
      path: toValuePath([]),
    }, () => {});
    await additionStarted.promise;
    (addingReplica as unknown as { closeNow(): void }).closeNow();
    addition.resolve({
      view: lateAdditionView,
      sync,
      precedingSyncs: [],
    });
    await expect(subscribing).rejects.toThrow("memory replica closed");
    await addingStorage.closeNow();

    const removal = defer<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
      precedingSyncs: SessionSync[];
    }>();
    const activeView = MemoryV2Client.WatchView.fromSync(sync);
    const lateRemovalView = MemoryV2Client.WatchView.fromSync(sync);
    const removingStorage = createStorage({
      subscribeAccessLoss: () => () => {},
      watchAddSync: () =>
        Promise.resolve({ view: activeView, sync, precedingSyncs: [] }),
      watchRemoveSync: () => removal.promise,
    } as unknown as MemoryV2Client.SpaceSession);
    const removingReplica = removingStorage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(removingReplica)) return;
    const cancel = await removingReplica.subscribeOperationField({
      id: "of:late-removal",
      path: toValuePath([]),
    }, () => {});
    cancel();
    await Promise.resolve();
    (removingReplica as unknown as { closeNow(): void }).closeNow();
    removal.resolve({
      view: lateRemovalView,
      sync,
      precedingSyncs: [],
    });
    await Promise.resolve();
    await removingStorage.closeNow();
  });

  it("warns when removing an operation watch fails", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => Promise.resolve({ view, sync, precedingSyncs: [] }),
      watchRemoveSync: () => Promise.reject(new Error("remove failed")),
    } as unknown as MemoryV2Client.SpaceSession;
    const client = {
      serverFlags: { applyOp: true, operationCodecs: ["test@1"] },
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          { as: signer, memoryHost: new URL("memory://") },
          { create: () => Promise.resolve({ client, session }) },
        );
      }
    })();
    const replica = storage.open(signer.did()).replica;
    if (!hasOperationStorageCapability(replica)) return;
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);
    try {
      const cancel = await replica.subscribeOperationField({
        id: "of:failed-removal",
        path: toValuePath([]),
      }, () => {});
      cancel();
      await Promise.resolve();
      await Promise.resolve();
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
      await storage.closeNow();
    }
  });
});
