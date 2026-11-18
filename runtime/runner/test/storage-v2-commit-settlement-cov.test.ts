/// <reference path="./clock.d.ts" />

/**
 * How a `SpaceReplica` settles its commits around the moments a verdict, a
 * reset, or a catch-up marker can interleave with: a pending layer that
 * cannot be replayed, an accept parked behind its marker, a sealed commit
 * whose wave dropped part of it, a pushed commit refused by the store, and a
 * promotion that lifts a shadowed foreign version.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type ClientCommit,
  commitPreconditionValueHash,
  encodeMemoryBoundary,
  type ScopeKeyIdentity,
  setServerExecutionConfig,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type {
  IStorageSubscription,
  IStorageTransaction,
  MemorySpace,
  SealedCommitVerdict,
  StorageNotification,
  StoreReadThrough,
  URI,
} from "../src/storage/interface.ts";
import {
  type SessionConnection,
  setConflictAdmissionMode,
  type SpaceReplica,
} from "../src/storage/v2.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  mountOver,
  newSharedServer,
  newSpaceReplica,
} from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const service = await Identity.fromPassphrase("v2-commit-settlement service");
const space: MemorySpace = (await Identity.fromPassphrase(
  "v2-commit-settlement space",
)).did();

const docA = "of:v2-commit-settlement-a" as URI;
const docB = "of:v2-commit-settlement-b" as URI;
const docC = "of:v2-commit-settlement-c" as URI;

type OpenedSession = {
  client: SessionConnection;
  session: MemoryV2Client.SpaceSession;
};

/**
 * A stand-in for the session's transact, given the commit the replica sent and
 * a `send` that hands it to the server.
 */
type Transact = (
  commit: ClientCommit,
  send: () => Promise<AppliedCommit>,
) => Promise<AppliedCommit>;

/** An error named as the memory server names its rejections. */
const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe("SpaceReplica commit settlement", () => {
  let server: MemoryV2Server.Server;
  let cleanups: (() => Promise<void> | void)[];

  /**
   * Mounts `space` on `server` as the service. With `holdFrames`, every
   * server-pushed `session/effect` frame is held back, so no catch-up marker
   * reaches the replica unless the case delivers one; request responses pass
   * either way.
   */
  const mount = async (
    options: { holdFrames?: boolean } = {},
  ): Promise<OpenedSession> => {
    let receiver: (payload: string) => void = () => {};
    const connection = server.connect((message, payload) => {
      if (options.holdFrames === true && message.type === "session/effect") {
        return;
      }
      receiver(payload ?? encodeMemoryBoundary(message));
    });
    const opened = await mountOver(
      {
        send: (payload) => connection.receive(payload),
        close: () => {
          connection.close();
          return Promise.resolve();
        },
        setReceiver: (next) => {
          receiver = next;
        },
        setCloseReceiver: () => {},
      },
      space,
      service,
    );
    cleanups.push(() => opened.client.close());
    return opened;
  };

  /** A replica of `space` acting as the service, closed after the case. */
  const replicaOver = (
    options: {
      holdFrames?: boolean;
      transact?: Transact;
      flags?: { pendingReadStacks?: false };
      subscription?: IStorageSubscription;
      localSessionDocuments?: boolean;
      scopeKeyIdentity?: () => ScopeKeyIdentity;
      storeReadThrough?: () => StoreReadThrough | undefined;
    } = {},
  ): SpaceReplica => {
    const replica = newSpaceReplica({
      as: service,
      space,
      subscription: options.subscription,
      localSessionDocuments: () => options.localSessionDocuments === true,
      scopeKeyIdentity: options.scopeKeyIdentity,
      createSession: async () => {
        const opened = await mount({ holdFrames: options.holdFrames });
        const transact = options.transact;
        if (transact !== undefined) {
          const original = opened.session.transact.bind(opened.session);
          opened.session.transact = (commit, beforeIssue) =>
            transact(commit, () => original(commit, beforeIssue));
        }
        const flags = options.flags;
        if (flags === undefined) return opened;
        const { client } = opened;
        return {
          session: opened.session,
          client: {
            get serverFlags() {
              const advertised = client.serverFlags;
              return advertised && { ...advertised, ...flags };
            },
            delivered: () => client.delivered(),
            close: () => client.close(),
          },
        };
      },
      storeReadThrough: options.storeReadThrough,
    });
    cleanups.push(() => replica.closeNow());
    return replica;
  };

  /** Delivers `value` as `id`'s confirmed state at `seq`, as a frame would. */
  const confirm = (
    replica: SpaceReplica,
    id: URI,
    value: FabricValue,
    seq: number,
    type: "pull" | "integrate" = "pull",
  ) =>
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: seq - 1,
      toSeq: seq,
      removes: [],
      upserts: [{ id, branch: "", seq, doc: { value } }],
    }, type);

  /**
   * Seals `operations` under a verdict the case decides. A `beforeSettlement`
   * reaction runs when the verdict resolves, ahead of the replica's own.
   */
  const seal = (
    replica: SpaceReplica,
    operations: Parameters<SpaceReplica["sealNative"]>[0]["operations"],
    beforeSettlement?: () => void,
  ) => {
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    if (beforeSettlement !== undefined) {
      verdict.promise.then(beforeSettlement);
    }
    const sealed = replica.sealNative(
      { operations },
      undefined,
      verdict.promise,
    );
    cleanups.push(() =>
      verdict.resolve({ withdrawn: { message: "test cleanup" } })
    );
    return { verdict, localSeq: sealed.localSeq, settled: sealed.settled };
  };

  /** A whole-document write of `value` to `id`. */
  const setOf = (
    id: URI,
    value: FabricValue,
    scope?: "session" | "user",
  ) => ({
    op: "set" as const,
    id,
    ...(scope === undefined ? {} : { scope }),
    type: "application/json" as const,
    value: { value },
  });

  beforeEach(() => {
    cleanups = [];
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /**
   * A transaction, over storage of its own, that has read the whole of each
   * of `ids`, as the transaction a commit is built from.
   */
  const sourceReading = (
    ids: readonly URI[],
    options: { derivedWrites?: true } = {},
  ): IStorageTransaction => {
    const storage = StorageManager.emulate({ as: service });
    cleanups.push(() => storage.close());
    const source = storage.edit();
    source.derivedWrites = options.derivedWrites;
    for (const id of ids) {
      expect(
        source.read({ space, id, type: "application/json", path: [] }).error,
      )
        .toBeUndefined();
    }
    return source;
  };

  describe("a pending patch layer", () => {
    it("throws the replay's own error for a layer whose pointer is malformed, rather than rendering it skipped", () => {
      using logs = captureLogs("storage.v2.pending-patch");
      const replica = replicaOver();
      confirm(replica, docA, { items: [] }, 1);
      expect(() =>
        seal(replica, [{
          op: "patch",
          id: docA,
          type: "application/json",
          patches: [{ op: "add", path: "value/items/-", value: "a" }],
          value: { value: { items: ["a"] } },
        }])
      ).toThrow("invalid JSON pointer: value/items/-");
      expect(logs.textsOf("pending-replay-skip")).toEqual([]);
    });
  });

  describe("a parked accept", () => {
    // The server stages a catch-up marker for each verdict and this replica
    // watches a document, so an accepted pushed commit parks until a marker
    // covers it. Every pushed frame is held back, and the cases deliver the
    // markers themselves.

    /** A replica that parks its accepts, watching `docA`. */
    const parkingReplica = async (
      options: { subscription?: IStorageSubscription } = {},
    ) => {
      const replica = replicaOver({ holdFrames: true, ...options });
      expect((await replica.sync(docA)).error).toBeUndefined();
      return replica;
    };

    /** Commits a write of `value` to `id`, resolving at the verdict. */
    const commitAtVerdict = (
      replica: SpaceReplica,
      id: URI,
      value: FabricValue,
    ) =>
      replica.commitNative({ operations: [setOf(id, value)] }, undefined, {
        resolveAt: "verdict",
      });

    it("resolves `whenApplied()` for a parked accept when the replica resets", async () => {
      const replica = await parkingReplica();
      expect(await commitAtVerdict(replica, docA, { n: 1 })).toEqual({
        ok: {},
      });
      expect(replica.getDiagnostics()).toMatchObject({
        parkedAcceptCount: 1,
        parkedAcceptLocalSeqs: [1],
      });
      let applied = false;
      const barrier = replica.whenApplied(1).then(() => {
        applied = true;
      });
      await clock.settle();
      expect(applied).toBe(false);

      replica.reset();
      await barrier;
      expect(applied).toBe(true);
      expect(replica.getDiagnostics()).toMatchObject({ parkedAcceptCount: 0 });
      expect(replica.accessForTestingOnly.hasDocumentRecord(docA)).toBe(false);
    });

    it("notifies the subscribers and tells the sinks of a shadow its promotion lifts under server execution", async () => {
      setServerExecutionConfig(true);
      cleanups.push(() => setServerExecutionConfig(undefined));
      const notifications: StorageNotification[] = [];
      const replica = await parkingReplica({
        subscription: {
          next: (notification) => {
            notifications.push(notification);
          },
        },
      });
      expect(await commitAtVerdict(replica, docA, { n: 1 })).toEqual({
        ok: {},
      });
      // Another writer's version of `docA` arrives while the own write still
      // masks it.
      confirm(replica, docA, { n: 9 }, 9, "integrate");
      expect(replica.getDocument(docA)?.value).toEqual({ n: 1 });
      const seenA: unknown[] = [];
      replica.sinkDocument(docA, (document) => seenA.push(document?.value));
      const seenB: unknown[] = [];
      replica.sinkDocument(docB, (document) => seenB.push(document?.value));
      notifications.length = 0;

      replica.accessForTestingOnly.noteCaughtUpLocalSeq(1);
      expect(replica.getDocument(docA)?.value).toEqual({ n: 9 });
      expect(seenA).toEqual([{ n: 9 }]);
      expect(seenB).toEqual([]);
      expect(
        notifications.flatMap((notification) =>
          notification.type === "integrate"
            ? [...notification.changes].map((change) => change.address.id)
            : []
        ),
      ).toEqual([docA]);
    });

    it("finishes a marker's promotions when a subscriber resets the replica from inside one", async () => {
      setServerExecutionConfig(true);
      cleanups.push(() => setServerExecutionConfig(undefined));
      let resetOnNotification = false;
      const notified: StorageNotification["type"][] = [];
      const replica: SpaceReplica = await parkingReplica({
        subscription: {
          next: (notification) => {
            notified.push(notification.type);
            if (resetOnNotification && notification.type === "integrate") {
              resetOnNotification = false;
              replica.reset();
            }
          },
        },
      });
      expect(await commitAtVerdict(replica, docA, { n: 1 })).toEqual({
        ok: {},
      });
      expect(await commitAtVerdict(replica, docB, { n: 2 })).toEqual({
        ok: {},
      });
      expect(replica.getDiagnostics()).toMatchObject({
        parkedAcceptLocalSeqs: [1, 2],
      });
      const secondApplied = replica.whenApplied(2);
      // Another writer's version of `docA` arrives while the own write still
      // masks it, so promoting that write is a shadow flip, which notifies.
      confirm(replica, docA, { n: 9 }, 9, "integrate");
      expect(replica.getDocument(docA)?.value).toEqual({ n: 1 });
      notified.length = 0;

      resetOnNotification = true;
      replica.accessForTestingOnly.noteCaughtUpLocalSeq(2);
      expect(notified).toEqual(["integrate", "reset"]);
      await secondApplied;
      expect(replica.getDiagnostics()).toMatchObject({ parkedAcceptCount: 0 });
      // The reset wiped what the second accept would have promoted.
      expect(replica.accessForTestingOnly.hasDocumentRecord(docB)).toBe(false);
    });
  });

  describe("a sealed commit the wave committed in part", () => {
    it("rolls back an operation the wave dropped whole", async () => {
      const replica = replicaOver();
      confirm(replica, docA, { n: 1 }, 1);
      const { verdict, settled } = seal(replica, [setOf(docA, { n: 2 })]);
      expect(replica.getDocument(docA)?.value).toEqual({ n: 2 });
      verdict.resolve({
        committed: { seq: 2, dropped: new Map([[0, "operation"]]) },
      });
      expect(await settled).toEqual({ ok: {} });
      expect(replica.getDocument(docA)?.value).toEqual({ n: 1 });
    });

    it("settles with nothing to roll back once a reset lands between the verdict and its settlement", async () => {
      const replica = replicaOver();
      confirm(replica, docA, { n: 1 }, 1);
      const { verdict, settled } = seal(
        replica,
        [setOf(docA, { n: 2 })],
        () => replica.reset(),
      );
      verdict.resolve({
        committed: { seq: 2, dropped: new Map([[0, "operation"]]) },
      });
      // The wave's verdict reached the race first, so the commit settles as
      // committed, and the reset left no record of the dropped write.
      expect(await settled).toEqual({ ok: {} });
      expect(replica.accessForTestingOnly.hasDocumentRecord(docA)).toBe(false);
    });

    it("drops the patches the wave dropped from a patch layer and keeps a whole-document layer named alongside", async () => {
      const replica = replicaOver();
      confirm(replica, docA, { n: 1 }, 1);
      confirm(replica, docB, { items: [] }, 2);
      const { verdict, settled } = seal(replica, [
        setOf(docA, { n: 2 }),
        {
          op: "patch",
          id: docB,
          type: "application/json",
          patches: [
            { op: "add", path: "/value/items/-", value: "a" },
            { op: "add", path: "/value/items/-", value: "b" },
          ],
          value: { value: { items: ["a", "b"] } },
        },
      ]);
      expect(replica.getDocument(docB)?.value).toEqual({ items: ["a", "b"] });
      verdict.resolve({
        committed: {
          seq: 3,
          dropped: new Map([[0, new Set([0])], [1, new Set([1])]]),
        },
      });
      expect(await settled).toEqual({ ok: {} });
      // A whole-document write has no patches to drop, so it stands.
      expect(replica.getDocument(docA)?.value).toEqual({ n: 2 });
      expect(replica.getDocument(docB)?.value).toEqual({ items: ["a"] });
    });
  });

  describe("a pushed commit with pending reads", () => {
    it("sends a stacked read and a single-layer read to an older server each as its top layer", async () => {
      const sent: ClientCommit[] = [];
      const replica = replicaOver({
        flags: { pendingReadStacks: false },
        transact: (commit) => {
          sent.push(commit);
          return Promise.resolve({ seq: 4, branch: "", revisions: [] });
        },
      });
      const lower = seal(replica, [setOf(docA, { n: 1 })]);
      const upper = seal(replica, [setOf(docA, { n: 2 })]);
      const single = seal(replica, [setOf(docB, { n: 3 })]);
      const committing = replica.commitNative(
        { operations: [setOf(docC, { n: 4 })] },
        sourceReading([docA, docB]),
        { resolveAt: "verdict" },
      );
      lower.verdict.resolve({ committed: { seq: 1 } });
      expect(await committing).toEqual({ ok: {} });
      expect(
        sent.map((commit) =>
          commit.reads.pending.map((read) => [read.id, read.localSeq])
        ),
      ).toEqual([[[docA, upper.localSeq], [docB, single.localSeq]]]);
    });

    /**
     * A replica that parks its accepts, with a commit to `docA` pinned to the
     * value of a local session document an unsettled sealed write holds, so
     * the commit carries a pending read and no transaction.
     */
    const pinnedCommit = async (resolveAt?: "verdict") => {
      const delivered = Promise.withResolvers<void>();
      const replica = replicaOver({
        holdFrames: true,
        localSessionDocuments: true,
        transact: async (_commit, send) => {
          const applied = await send();
          delivered.resolve();
          return applied;
        },
      });
      expect((await replica.sync(docA)).error).toBeUndefined();
      const sealed = seal(replica, [setOf(docB, { n: 1 }, "session")]);
      let settled = false;
      const committing = replica.commitNative(
        {
          operations: [setOf(docA, { n: 5 })],
          preconditions: [{
            kind: "entity-value-hash",
            id: docB,
            scope: "session",
            valueHash: commitPreconditionValueHash({ n: 1 }),
          }],
        },
        undefined,
        resolveAt === undefined ? undefined : { resolveAt },
      ).then((result) => {
        settled = true;
        return result;
      });
      sealed.verdict.resolve({ committed: { seq: 1 } });
      await delivered.promise;
      await clock.settle();
      return { replica, committing, settled: () => settled };
    };

    it("resolves at the parked application of its accept", async () => {
      const { replica, committing, settled } = await pinnedCommit();
      expect(replica.getDiagnostics()).toMatchObject({
        parkedAcceptLocalSeqs: [2],
      });
      expect(settled()).toBe(false);
      replica.accessForTestingOnly.noteCaughtUpLocalSeq(2);
      expect(await committing).toEqual({ ok: {} });
      expect(replica.getDocument(docA)?.value).toEqual({ n: 5 });
    });

    it("resolves at the verdict when asked to, while its accept stays parked", async () => {
      const { replica, committing } = await pinnedCommit("verdict");
      expect(await committing).toEqual({ ok: {} });
      expect(replica.getDiagnostics()).toMatchObject({
        parkedAcceptLocalSeqs: [2],
      });
    });
  });

  describe("a pushed commit the store refuses", () => {
    /** A commit as conflict admission reads it, reading the whole of `id`. */
    const readerOf = (id: URI): ClientCommit => ({
      localSeq: 99,
      reads: {
        confirmed: [],
        pending: [{
          id,
          path: toDocumentPath([]),
          localSeq: 98,
          basisSeq: 0,
        }],
      },
      operations: [],
    });

    const refusing = (name: string, message: string): Transact => () =>
      Promise.reject(namedError(name, message));

    /** A subscription reporting that nothing listens to its notifications. */
    const unsubscribed = (): IStorageSubscription => {
      const next: IStorageSubscription["next"] = () => undefined;
      const subscription = { next, hasSubscribers: () => false };
      return subscription;
    };

    it("floors the documents of a conflicting commit under conflict admission", async () => {
      setConflictAdmissionMode("preempt");
      cleanups.push(() => setConflictAdmissionMode(undefined));
      const replica = replicaOver({
        transact: refusing("ConflictError", "the document moved"),
      });
      const result = await replica.commitNative({
        operations: [setOf(docA, { n: 1 })],
      });
      expect(result.error?.name).toBe("ConflictError");
      expect(replica.accessForTestingOnly.preemptThreshold(readerOf(docA)))
        .toBe(1);
      expect(replica.accessForTestingOnly.preemptThreshold(readerOf(docB)))
        .toBeUndefined();
    });

    it("floors nothing for a conflicting commit with conflict admission off", async () => {
      setConflictAdmissionMode("off");
      cleanups.push(() => setConflictAdmissionMode(undefined));
      const replica = replicaOver({
        transact: refusing("ConflictError", "the document moved"),
      });
      const result = await replica.commitNative({
        operations: [setOf(docA, { n: 1 })],
      });
      expect(result.error?.name).toBe("ConflictError");
      expect(replica.accessForTestingOnly.preemptThreshold(readerOf(docA)))
        .toBeUndefined();
    });

    it("keeps a refused derived write as confirmed only where it sits directly on the confirmed version", async () => {
      const replica = replicaOver({
        transact: refusing("AuthorizationError", "not permitted"),
      });
      confirm(replica, docA, { n: 0 }, 1);
      confirm(replica, docB, { n: 0 }, 2);
      const below = seal(replica, [setOf(docA, { n: 1 })]);
      const result = await replica.commitNative(
        { operations: [setOf(docA, { n: 2 }), setOf(docB, { n: 2 })] },
        sourceReading([], { derivedWrites: true }),
      );
      expect(result.error?.name).toBe("AuthorizationError");
      // The refused write to `docB` is folded into its confirmed version,
      // leaving no pending layer.
      expect(replica.hasPendingWrite(docB)).toBe(false);
      expect(replica.getDocument(docB)?.value).toEqual({ n: 2 });
      // Beneath the refused write to `docA` stands a sealed one, so the
      // refused write is reverted rather than kept, and nothing is folded
      // into the confirmed version the sealed write still sits on.
      expect(replica.hasPendingWrite(docA)).toBe(true);
      expect(replica.getDocument(docA)?.value).toEqual({ n: 1 });
      below.verdict.resolve({ withdrawn: { message: "the wave withdrew it" } });
      expect((await below.settled).error?.message).toContain(
        "the wave withdrew it",
      );
      expect(replica.getDocument(docA)?.value).toEqual({ n: 0 });
    });

    it("reads the store's copy of each created document an instance key names, skipping one this replica cannot key", async () => {
      using logs = captureLogs("storage.v2");
      const asked: { id: URI; scopeKey: string }[] = [];
      const replica = replicaOver({
        subscription: unsubscribed(),
        scopeKeyIdentity: () => ({ principal: service.did() }),
        transact: refusing("ConflictError", "the document moved"),
        storeReadThrough: () => (address) => {
          asked.push(address);
          return undefined;
        },
      });
      const result = await replica.commitNative({
        operations: [setOf(docA, { n: 1 }), setOf(docB, { n: 1 }, "session")],
      });
      expect(result.error?.name).toBe("ConflictError");
      expect(asked).toEqual([{ id: docA, scopeKey: "space" }]);
      expect(replica.getDocument(docA)).toBeUndefined();
      expect(logs.textsOf("conflict-read-repair-load")).toEqual([]);
    });

    it("logs a store read-through that cannot be reached and still reverts the created document", async () => {
      using logs = captureLogs("storage.v2");
      let failNextReadThrough = false;
      const replica = replicaOver({
        subscription: unsubscribed(),
        transact: () => {
          failNextReadThrough = true;
          return Promise.reject(
            namedError("ConflictError", "the document moved"),
          );
        },
        storeReadThrough: () => {
          if (failNextReadThrough) {
            failNextReadThrough = false;
            throw new Error("the store is gone");
          }
          return undefined;
        },
      });
      const result = await replica.commitNative({
        operations: [setOf(docA, { n: 1 })],
      });
      expect(result.error?.name).toBe("ConflictError");
      expect(replica.getDocument(docA)).toBeUndefined();
      expect(logs.textsOf("conflict-read-repair-load")).toEqual([
        expect.stringContaining("the store is gone"),
      ]);
    });
  });
});
