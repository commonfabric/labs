import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MIME, URI } from "@commonfabric/memory/interface";
import {
  type ClientCommit,
  type SessionSync,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";
import { getLogger } from "@commonfabric/utils/logger";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { registerCommitRejectionListener } from "../src/storage/reactivity-log.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
  IStorageNotification,
  StorageNotification,
  StorageTransactionRejected,
} from "../src/storage/interface.ts";
import {
  type SessionFactory,
  setConflictAdmissionEnabled,
  type SpaceReplica,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-storage-subscription");
const space = signer.did();

class Subscription implements IStorageNotification {
  notifications: StorageNotification[] = [];
  onNotification?: (notification: StorageNotification) => void;

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    this.onNotification?.(notification);
    return { done: false };
  }

  get commits() {
    return this.notifications.filter((notification) =>
      notification.type === "commit"
    );
  }

  get reverts() {
    return this.notifications.filter((notification) =>
      notification.type === "revert"
    );
  }

  get pulls() {
    return this.notifications.filter((notification) =>
      notification.type === "pull"
    );
  }

  clear() {
    this.notifications = [];
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 250,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await clock.tick(5);
  }
};

const notificationCarries = (
  notification: StorageNotification,
  uri: URI,
  after: unknown,
): boolean =>
  "changes" in notification &&
  [...notification.changes].some((change) =>
    change.address.id === uri &&
    JSON.stringify(change.after) === JSON.stringify(after)
  );

const visibleIds = (
  provider: { get(uri: URI): { value?: unknown } | undefined },
  ids: readonly URI[],
) => ids.filter((id) => provider.get(id)?.value !== undefined).sort();

const staleReadSource = (uri: URI, seq: number) => ({
  getReadActivities(): Iterable<IReadActivity> {
    return [{
      space,
      id: uri,
      type: "application/json",
      path: [],
      meta: { seq },
    }];
  },
});

const syntheticConflict = (
  uri: URI,
  readyToRetry: () => Promise<void>,
): StorageTransactionRejected => ({
  name: "ConflictError",
  message: "synthetic conflict",
  transaction: {
    localSeq: 0,
    reads: { confirmed: [], pending: [] },
    operations: [],
  },
  conflict: {
    space,
    the: "application/json",
    of: uri,
  },
  readyToRetry,
});

describe("Memory v2 storage notifications", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;
  let remoteLocalSeq: number;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("Expected a memory/v2 emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    remoteLocalSeq = 1;
  });

  afterEach(async () => {
    const status = tx?.status();
    if (status?.status === "ready") {
      await tx.commit();
    }
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
    await clock.tick(1);
  });

  it("emits a commit notification with optimistic changes", async () => {
    const subscription = new Subscription();
    runtime.storageManager.subscribe(subscription);

    const uri = `of:memory-v2-commit-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: "hello" });

    await tx.commit();

    expect(subscription.commits.length).toBeGreaterThanOrEqual(1);
    expect(subscription.commits.at(-1)).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });
    expect(
      [...subscription.commits.at(-1)!.changes].map((change) => change.after),
    )
      .toContainEqual({ value: "hello" });
  });

  it("emits precise commit notification paths for nested v2 writes", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-precise-commit-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: { profile: { name: "Ada", title: "Dr" } } });
    await tx.commit();

    subscription.clear();

    tx = runtime.edit();
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: ["value", "profile", "name"],
    }, "Grace");
    await tx.commit();

    const commit = subscription.commits.at(-1);
    expect(commit).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });

    const changes = [...commit!.changes];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      address: {
        id: uri,
        type: "application/json",
        scope: "space",
        path: ["value", "profile", "name"],
      },
      before: { value: { profile: { name: "Ada", title: "Dr" } } },
      after: { value: { profile: { name: "Grace", title: "Dr" } } },
    });
  });

  it("emits array-path commit notification paths for v2 shape changes", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-precise-array-${Date.now()}` as URI;
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: [],
    }, { value: { tags: ["alpha", "beta", "gamma"] } });
    await tx.commit();

    subscription.clear();

    tx = runtime.edit();
    tx.write({
      space,
      id: uri,
      type: "application/json",
      path: ["value", "tags", "length"],
    }, 2);
    await tx.commit();

    const commit = subscription.commits.at(-1);
    expect(commit).toMatchObject({
      type: "commit",
      space,
      source: tx.tx,
    });

    const changes = [...commit!.changes];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      address: {
        id: uri,
        type: "application/json",
        scope: "space",
        path: ["value", "tags"],
      },
      before: { value: { tags: ["alpha", "beta", "gamma"] } },
      after: { value: { tags: ["alpha", "beta"] } },
    });
  });

  it("emits a revert notification when a v2 commit conflicts", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-conflict-${Date.now()}` as URI;
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });

    const { replica: openedReplica } = storageManager.open(space);
    const replica = openedReplica as typeof openedReplica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    await storageManager.open(space).sync(uri);

    const gotVersion3 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, uri, { value: { version: 3 } })) {
        gotVersion3.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });
    await gotVersion3.promise;

    const source = staleReadSource(uri, 1);

    const factAddress = { id: uri, type: "application/json" as MIME };
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: uri,
        type: "application/json",
        value: { value: { version: 2 } },
      }],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    expect(subscription.reverts).toHaveLength(1);
    expect(subscription.reverts[0]).toMatchObject({
      type: "revert",
      space,
      source,
    });
    expect(subscription.reverts[0].reason.name).toBe("ConflictError");
    expect([...subscription.reverts[0].changes]).toContainEqual({
      address: {
        id: uri,
        type: "application/json",
        scope: "space",
        path: ["value", "version"],
      },
      before: { value: { version: 2 } },
      after: { value: { version: 3 } },
    });
  });

  it("reverts a non-conflicting sibling write to current while the conflicting doc lands fresh", async () => {
    // tx writes A and B; only B conflicts. The whole tx is rejected, so A's
    // optimistic write must roll back (it is NOT in the catch-up sync), while B
    // must land on the CURRENT confirmed value (fresh), never on past data.
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const aUri = `of:memory-v2-revert-sibling-a-${Date.now()}` as URI;
    const bUri = `of:memory-v2-revert-sibling-b-${Date.now()}` as URI;
    const aAddress = { id: aUri, type: "application/json" as MIME };
    const bAddress = { id: bUri, type: "application/json" as MIME };

    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: { name?: string } }>;
    };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: aUri, value: { value: { a: 1 } } },
        { op: "set", id: bUri, value: { value: { b: 1 } } },
      ],
    });
    await provider.sync(aUri);
    await provider.sync(bUri);

    // Another writer advances ONLY B to b:3; A stays at a:1.
    const gotB3 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, bUri, { value: { b: 3 } })) {
        gotB3.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: bUri, value: { value: { b: 3 } } }],
    });
    await gotB3.promise;

    // Local tx writes both A and B optimistically; a stale read of B forces the
    // conflict. Whole tx is rejected.
    const result = await replica.commitNative({
      operations: [
        {
          op: "set",
          id: aUri,
          type: "application/json",
          value: { value: { a: 10 } },
        },
        {
          op: "set",
          id: bUri,
          type: "application/json",
          value: { value: { b: 20 } },
        },
      ],
    }, staleReadSource(bUri, 1));

    expect(result.ok).toBeFalsy();
    expect(result.error?.name).toBe("ConflictError");

    // A rolled back to its confirmed (current) value; B at the fresh current
    // value — not the optimistic 20 and not the past 1.
    expect(replica.get(aAddress)?.is).toEqual({ value: { a: 1 } });
    expect(replica.get(bAddress)?.is).toEqual({ value: { b: 3 } });

    // One revert notification carrying BOTH the sibling rollback and the fresh
    // value, each reverting to current.
    expect(subscription.reverts).toHaveLength(1);
    const changes = [...subscription.reverts[0].changes];
    expect(changes).toContainEqual({
      address: {
        id: aUri,
        type: "application/json",
        scope: "space",
        path: ["value", "a"],
      },
      before: { value: { a: 10 } },
      after: { value: { a: 1 } },
    });
    expect(changes).toContainEqual({
      address: {
        id: bUri,
        type: "application/json",
        scope: "space",
        path: ["value", "b"],
      },
      before: { value: { b: 20 } },
      after: { value: { b: 3 } },
    });
  });

  it("refreshes subscribed state before conflict readyToRetry resolves", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-retry-${Date.now()}` as URI;
    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    await provider.sync(uri);

    const gotVersion1 = defer<void>();
    subscription.onNotification = (notification) => {
      if (notificationCarries(notification, uri, { value: { version: 1 } })) {
        gotVersion1.resolve();
      }
    };
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 1 } },
      }],
    });
    await gotVersion1.promise;

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: { value: { version: 3 } },
      }],
    });

    const source = staleReadSource(uri, 1);

    const factAddress = { id: uri, type: "application/json" as MIME };
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: uri,
        type: "application/json",
        value: { value: { version: 2 } },
      }],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 2 } });

    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    // The inline read-repair (waitForConflictReadRepair) must have applied the
    // caught-up sync BEFORE the commit resolves — so confirmed state already
    // reflects version 3 here, without any explicit readyToRetry() call. This
    // guards the repair-before-revert ordering: removing the inline wait leaves
    // this at the stale/optimistic value.
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });
    expect(subscription.reverts.at(-1)).toMatchObject({
      type: "revert",
      space,
      source,
    });
    const reason = subscription.reverts.at(-1)?.reason;
    if (reason?.name !== "ConflictError") {
      throw new Error(`Expected ConflictError, got ${reason?.name}`);
    }
    expect(reason.retryAfterSeq).toBe(2);
    expect(typeof reason.readyToRetry).toBe("function");
    await reason.readyToRetry?.();
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    await storageManager.close();
    await assertRejects(
      () => reason.readyToRetry?.() ?? Promise.resolve(),
      Error,
    );
  });

  it("returns the original conflict when closing during retry read repair", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const provider = storageManager.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative: (
        transaction: unknown,
        source?: unknown,
      ) => Promise<{ ok?: unknown; error?: unknown }>;
    };
    const repairStarted = defer<void>();
    const firstUri = `of:memory-v2-close-retry-a-${Date.now()}` as URI;
    const secondUri = `of:memory-v2-close-retry-b-${Date.now()}` as URI;
    const factAddress = { id: firstUri, type: "application/json" as MIME };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: firstUri, value: { value: { version: 1 } } },
        { op: "set", id: secondUri, value: { value: { version: 1 } } },
      ],
    });
    await provider.sync(firstUri);
    await provider.sync(secondUri);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: firstUri, value: { value: { version: 2 } } },
      ],
    });
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: secondUri, value: { value: { version: 2 } } },
      ],
    });

    // The push path notifies the rejection's sources and then finalizes the
    // rejection, which reaches the read-repair wait with no await between,
    // so the listener fires as the repair starts.
    const source = staleReadSource(firstUri, 1);
    registerCommitRejectionListener(source, () => repairStarted.resolve());
    const commitPromise = replica.commitNative({
      operations: [{
        op: "set",
        id: firstUri,
        type: "application/json",
        value: { value: { version: 3 } },
      }],
    }, source);
    expect(replica.get(factAddress)?.is).toEqual({ value: { version: 3 } });

    // Close only after the server conflict has reached the read-repair path.
    // Previously this test relied on a request slipping through concurrently
    // with Client.close(), so it did not deterministically exercise its title.
    await repairStarted.promise;
    await storageManager.close();
    const result = await commitPromise;
    expect(result.ok).toBeFalsy();
    const reason = subscription.reverts.at(-1)?.reason;
    if (reason?.name !== "ConflictError") {
      throw new Error(`Expected ConflictError, got ${reason?.name}`);
    }
    expect(result.error).toBe(reason);
    await assertRejects(
      () => reason?.readyToRetry?.() ?? Promise.resolve(),
      Error,
    );
  });

  it("rejects pending caught-up waiters when storage closes", async () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as SpaceReplica;
    const harness = replica.accessForTestingOnly;

    const readyAtTwo = harness.waitForCaughtUpLocalSeq(2);
    const readyAtThree = harness.waitForCaughtUpLocalSeq(3);
    const rejectsAtThree = assertRejects(() => readyAtThree, Error);

    harness.noteCaughtUpLocalSeq(2);
    await readyAtTwo;
    replica.closeNow();
    await rejectsAtThree;

    await assertRejects(
      () => harness.waitForCaughtUpLocalSeq(1),
      Error,
      "memory replica closed",
    );
  });

  it("swallows a rejecting readyToRetry during read repair", async () => {
    const provider = storageManager.open(space);
    const harness = (provider.replica as SpaceReplica).accessForTestingOnly;
    const retryError = new Error("retry unavailable");
    let called = 0;

    // A rejecting readyToRetry must be invoked and then swallowed (logged), not
    // thrown, so the original conflict result is preserved for the caller. If
    // the repair short-circuited, `called` stays 0; if it rethrew, the await
    // would reject and fail the test.
    await harness.waitForConflictReadRepair(
      syntheticConflict(
        `of:memory-v2-retry-reject-${Date.now()}` as URI,
        () => {
          called += 1;
          return Promise.reject(retryError);
        },
      ),
    );

    expect(called).toBe(1);
  });

  it("closes a watch refresh view that resolves after replica close", async () => {
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      upserts: [],
      removes: [],
    };
    const view = MemoryV2Client.WatchView.fromSync(sync);
    const client = {
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const watchStarted = Promise.withResolvers<void>();
    const watchResponse = Promise.withResolvers<{
      view: MemoryV2Client.WatchView;
      sync: SessionSync;
    }>();
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => {
        watchStarted.resolve();
        return watchResponse.promise;
      },
    } as unknown as MemoryV2Client.SpaceSession;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const testStorageManager = new TestStorageManager();
    const provider = testStorageManager.open(space);
    const replica = provider.replica as SpaceReplica;

    const refresh = replica.accessForTestingOnly.refreshWatchSet([[
      { id: "of:late-refresh" as URI, type: "application/json" as MIME },
      { path: [], schema: false },
    ]]);
    await watchStarted.promise;
    replica.closeNow();
    watchResponse.resolve({ view, sync });
    const result = await refresh;

    expect(result.error?.message).toBe("memory replica closed");
    expect((await view.subscribeSync().next()).done).toBe(true);
    await testStorageManager.closeNow();
  });

  it("records a refresh's request span when the request itself fails", async () => {
    // The refresh's sub-spans record in `finally` blocks, like its `total`:
    // a failed refresh paid for its request, and a success-only span would
    // leave that cost in `total` alone, so the halves would not add up
    // across outcomes. Counts only — a duration is a property of the
    // machine.
    const timing = getLogger("storage.v2");
    const counts = () => ({
      watchAdd: timing.getTimeStats("watchRefresh", "watchAddSync")?.count ??
        0,
      apply: timing.getTimeStats("watchRefresh", "applySessionSync")?.count ??
        0,
      total: timing.getTimeStats("watchRefresh", "total")?.count ?? 0,
    });
    const client = {
      close: () => Promise.resolve(),
    } as unknown as MemoryV2Client.Client;
    const session = {
      subscribeAccessLoss: () => () => {},
      watchAddSync: () => Promise.reject(new Error("scripted watch failure")),
    } as unknown as MemoryV2Client.SpaceSession;
    const sessionFactory: SessionFactory = {
      create: () => Promise.resolve({ client, session }),
    };
    class TestStorageManager extends V2StorageManager {
      constructor() {
        super({ as: signer, memoryHost: new URL("memory://") }, sessionFactory);
      }
    }
    const testStorageManager = new TestStorageManager();
    const provider = testStorageManager.open(space);
    const replica = provider.replica as SpaceReplica;

    const before = counts();
    const result = await replica.accessForTestingOnly.refreshWatchSet([[
      { id: "of:failed-refresh" as URI, type: "application/json" as MIME },
      { path: [], schema: false },
    ]]);
    const after = counts();

    expect(result.error?.message).toBe("scripted watch failure");
    expect(after.watchAdd - before.watchAdd).toBe(1);
    expect(after.apply - before.apply).toBe(0);
    expect(after.total - before.total).toBe(1);
    await testStorageManager.closeNow();
  });

  it("admission control records, thresholds, and prunes a stale floor", () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as SpaceReplica;
    const admission = replica.accessForTestingOnly;
    const uri = `of:admission-floor-${Date.now()}` as URI;
    const reading: ClientCommit = {
      localSeq: 9,
      reads: {
        confirmed: [{ id: uri, path: toDocumentPath([]), seq: 0 }],
        pending: [],
      },
      operations: [{ op: "set", id: uri, value: { value: { v: 2 } } }],
    };

    // Nothing stale yet -> the read is admitted.
    expect(admission.preemptThreshold(reading)).toBeUndefined();

    // A conflict at localSeq 7 marks uri stale until caughtUpLocalSeq >= 7.
    admission.recordStaleFloor(reading, 7);
    expect(admission.preemptThreshold(reading)).toBe(7);

    // Catching up to the floor makes the id fresh again -> admitted.
    admission.noteCaughtUpLocalSeq(7);
    expect(admission.preemptThreshold(reading)).toBeUndefined();

    // A reset starts a new replica epoch; stale floors from the old epoch must
    // not hold or pre-empt post-reset commits that read the same id.
    admission.recordStaleFloor(reading, 8);
    expect(admission.preemptThreshold(reading)).toBe(8);
    replica.reset();
    expect(admission.preemptThreshold(reading)).toBeUndefined();
  });

  it("reset rejects caught-up waiters from the previous replica epoch", async () => {
    const provider = storageManager.open(space);
    const replica = provider.replica as SpaceReplica;

    const wait = replica.accessForTestingOnly.waitForCaughtUpLocalSeq(3);
    replica.reset();

    await expect(wait).rejects.toThrow("memory replica reset");
  });

  it("pre-empts a known-stale commit instead of round-tripping when enabled", async () => {
    setConflictAdmissionEnabled(true);
    try {
      const provider = storageManager.open(space);
      const replica = provider.replica as typeof provider.replica & {
        commitNative: (
          transaction: unknown,
          source?: unknown,
        ) => Promise<
          { ok?: unknown; error?: { name?: string; message?: string } }
        >;
        accessForTestingOnly: SpaceReplica["accessForTestingOnly"];
      };
      const uri = `of:admission-preempt-${Date.now()}` as URI;

      // Simulate a prior conflict that marked uri stale until caughtUpLocalSeq>=5.
      replica.accessForTestingOnly.recordStaleFloor({
        localSeq: 5,
        reads: {
          confirmed: [{ id: uri, path: toDocumentPath([]), seq: 0 }],
          pending: [],
        },
        operations: [{ op: "set", id: uri, value: { value: { version: 1 } } }],
      }, 5);

      const commitPromise = replica.commitNative({
        operations: [{
          op: "set",
          id: uri,
          type: "application/json",
          value: { value: { version: 2 } },
        }],
      }, staleReadSource(uri, 0));

      // The commit is pre-empted (never sent) and held until the catch-up seq
      // is observed, exactly like a real conflict's retry gate.
      let settled = false;
      void commitPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      replica.accessForTestingOnly.noteCaughtUpLocalSeq(5);
      const result = await commitPromise;
      expect(result.ok).toBeFalsy();
      expect(result.error?.name).toBe("ConflictError");
      expect(result.error?.message).toContain("preempted");
    } finally {
      setConflictAdmissionEnabled(undefined);
    }
  });

  it("does not emit duplicate pull notifications for unchanged v2 sync results", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);

    const uri = `of:memory-v2-pull-dedupe-${Date.now()}` as URI;
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: uri,
        value: {
          value: {
            items: [
              { count: 1, label: "one" },
              { count: 2, label: "two" },
            ],
          },
        },
      }],
    });

    const provider = storageManager.open(space);
    await provider.sync(uri, {
      path: ["items", "0", "count"],
      schema: false,
    });
    expect(subscription.pulls).toHaveLength(1);

    await provider.sync(uri, {
      path: ["items", "1", "count"],
      schema: false,
    });
    expect(subscription.pulls).toHaveLength(1);
  });

  it("times the replica's application of a pushed frame under its own key", async () => {
    // `watchRefresh/applySessionSync` covers the frames a refresh brought
    // back; frames the server PUSHES apply off the subscription iterator
    // under `watchPush/applySessionSync`. Both keys are named in
    // docs/development/debugging/profiling.md; this pins the push one.
    const subscription = new Subscription();
    storageManager.subscribe(subscription);
    const uri = `of:memory-v2-push-timing-${Date.now()}` as URI;
    const write = (n: number) =>
      remoteSession.transact({
        localSeq: remoteLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: uri, value: { value: { n } } }],
      });
    await write(1);
    const provider = storageManager.open(space);
    await provider.sync(uri, { path: [], schema: true });

    const timing = getLogger("storage.v2");
    const pushApplies = () =>
      timing.getTimeStats("watchPush", "applySessionSync")?.count ?? 0;
    const before = pushApplies();
    await write(2);
    await waitFor(
      () =>
        subscription.notifications.some((notification) =>
          notification.type === "integrate" &&
          "changes" in notification &&
          [...notification.changes].some((change) => change.address.id === uri)
        ),
      1_000,
    );
    expect(pushApplies() - before).toBeGreaterThanOrEqual(1);
  });

  it("expands subscribed graph state to previously existing hidden docs after a root retarget", async () => {
    const subscription = new Subscription();
    storageManager.subscribe(subscription);
    const fixture = createGraphFixture(space);
    const observer = storageManager.open(space) as unknown as {
      get(uri: URI): { value: unknown } | undefined;
      sync(
        uri: URI,
        selector: { path: string[]; schema: unknown },
      ): Promise<{ ok?: Record<PropertyKey, never> }>;
    };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: fixture.docs.map(({ id, value }) => ({
        op: "set" as const,
        id,
        value: { value },
      })),
    });

    expect(
      await observer.sync(fixture.rootId, {
        path: [],
        schema: fixture.schema,
      }),
    ).toEqual({ ok: {} });
    await storageManager.synced();
    await waitFor(
      () =>
        visibleIds(observer, fixture.expandedReachableIds).length ===
          fixture.initialReachableIds.length,
      1_000,
    );
    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.initialReachableIds,
    );

    subscription.clear();
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: fixture.rootId,
        value: { value: fixture.expandedRootValue },
      }],
    });
    await storageManager.synced();
    await waitFor(
      () =>
        visibleIds(observer, fixture.expandedReachableIds).length ===
          fixture.expandedReachableIds.length,
      1_000,
    );

    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.expandedReachableIds,
    );
    const integrateIds = subscription.notifications
      .filter((notification) => notification.type === "integrate")
      .flatMap((notification) =>
        "changes" in notification
          ? [...notification.changes].map((change) => change.address.id as URI)
          : []
      );
    expect(integrateIds).toContain(fixture.hiddenRootId);
    expect(integrateIds).toContain("of:test-node-63");
  });
});
