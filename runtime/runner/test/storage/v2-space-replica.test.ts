import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  resolveScopeKey,
  setCommitPreconditionsConfig,
  setServerExecutionConfig,
  toDocumentPath,
  toValuePath,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { ResendingSession } from "@commonfabric/memory/v2/resending-session";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { namesInstancesByDefault } from "../../src/builder/instance-name.ts";
import type {
  ForeignScopedReadGrant,
  IStorageSubscription,
  MemorySpace,
  SealedCommitVerdict,
  StorageNotification,
  StoreReadThrough,
  URI,
} from "../../src/storage/interface.ts";
import { type SessionConnection, SpaceReplica } from "../../src/storage/v2.ts";
import { captureLogs } from "../support/log-capture.ts";

const AUDIENCE = "did:key:z6Mk-runner-v2-space-replica-audience";

const service = await Identity.fromPassphrase("v2-space-replica service");
const bob = await Identity.fromPassphrase("v2-space-replica bob");
const space: MemorySpace = (await Identity.fromPassphrase(
  "v2-space-replica space",
)).did();

const doc = "of:v2-space-replica-doc" as URI;

type SpaceReplicaWatch = (
  address: { id: URI },
) => Promise<
  { ok: Record<never, never>; error?: undefined } | { error: Error }
>;

/**
 * A subscription whose `hasSubscribers()` reports `subscribed`, as the
 * manager's reports whether anything listens to its notifications.
 */
const subscriptionThat = (
  subscribed: boolean,
  next: IStorageSubscription["next"] = () => {},
): IStorageSubscription => {
  const subscription = { next, hasSubscribers: () => subscribed };
  return subscription;
};

/** The read authority probe for this replica's space, asked of an actor. */
type ActorReadGrant = (
  principal: string,
) => ReturnType<ForeignScopedReadGrant>;

type OpenedSession = {
  client: SessionConnection;
  session: MemoryV2Client.SpaceSession;
};

describe("SpaceReplica", () => {
  let server: MemoryV2Server.Server;
  let cleanups: (() => Promise<void> | void)[];

  /** Mounts `space` on `server` as the service, over the loopback transport. */
  const mount = async (): Promise<
    { client: MemoryV2Client.Client; session: MemoryV2Client.SpaceSession }
  > => {
    const client = await MemoryV2Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport: MemoryV2Client.loopback(server),
    });
    cleanups.push(() => client.close());
    const session = await client.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: service.did() },
      }),
    );
    return { client, session };
  };

  /** A replica of `space` acting as the service, closed after the case. */
  const replicaOver = (
    options: {
      createSession?: () => Promise<OpenedSession>;
      gateForeignScopedReads?: boolean;
      foreignScopedReadGrant?: ActorReadGrant;
      subscription?: IStorageSubscription;
      localSessionDocuments?: boolean;
      routeState?: { generation: number };
      isRead?: () => boolean;
      watchDocument?: SpaceReplicaWatch;
      onDocumentsDropped?: (addresses: readonly { id: URI }[]) => void;
      storeReadThrough?: StoreReadThrough;
    } = {},
  ): SpaceReplica => {
    const replica = new SpaceReplica({
      as: service,
      space,
      settings: {},
      subscription: options.subscription ?? { next: () => {} },
      localSessionDocuments: () => options.localSessionDocuments === true,
      scopeKeyIdentity: () => ({
        principal: service.did(),
        sessionId: "v2-space-replica-session",
      }),
      routeState: options.routeState ?? { generation: 0 },
      routeGeneration: 0,
      // A replica asks through a session that resends, as the storage
      // manager hands it one.
      createSession: async () => {
        const { client, session } = await (options.createSession ?? mount)();
        return { client, session: new ResendingSession(session) };
      },
      syncReplayDependencies: () => Promise.resolve(undefined),
      watchDocument: options.watchDocument ??
        (() => Promise.resolve({ ok: {} })),
      isRead: options.isRead,
      onDocumentsDropped: options.onDocumentsDropped,
      storeReadThrough: () => options.storeReadThrough,
      gateForeignScopedReads: options.gateForeignScopedReads,
      foreignScopedReadGrant: () => options.foreignScopedReadGrant,
    });
    cleanups.push(() => replica.closeNow());
    return replica;
  };

  /** Delivers `value` as `doc`'s confirmed state at `seq`, as a frame would. */
  const confirm = (replica: SpaceReplica, value: FabricValue, seq: number) =>
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: seq - 1,
      toSeq: seq,
      removes: [],
      upserts: [{ id: doc, branch: "", seq, doc: { value } }],
    }, "pull");

  /** Seals a write of `value` to `doc` under a verdict the case decides. */
  const sealSet = (replica: SpaceReplica, value: FabricValue) => {
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative(
      {
        operations: [{
          op: "set",
          id: doc,
          type: "application/json",
          value: { value },
        }],
      },
      undefined,
      verdict.promise,
    );
    cleanups.push(() =>
      verdict.resolve({ withdrawn: { message: "test cleanup" } })
    );
    return { verdict, settled: sealed.settled };
  };

  beforeEach(() => {
    cleanups = [];
    server = new MemoryV2Server.Server({
      namesInstances: namesInstancesByDefault,
      store: new URL(`memory://v2-space-replica-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  describe("instance members", () => {
    describe("foreignScopedReadStanding()", () => {
      it("returns `admitted` for a replica that gates no reads", () => {
        const replica = replicaOver();
        expect(replica.foreignScopedReadStanding(bob.did())).toBe("admitted");
      });

      it("returns `refused` for a gating replica holding no probe", () => {
        const replica = replicaOver({ gateForeignScopedReads: true });
        expect(replica.foreignScopedReadStanding(bob.did())).toBe("refused");
      });
    });

    describe("sync()", () => {
      it("refuses an actor's scoped instance fail-closed when the read authority probe throws", async () => {
        using logs = captureLogs("storage.v2");
        const asked: string[] = [];
        const replica = replicaOver({
          gateForeignScopedReads: true,
          foreignScopedReadGrant: (actor) => {
            asked.push(actor);
            throw new Error("probe down");
          },
        });
        const result = await replica.sync(
          "of:bob-draft" as URI,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        expect(result.error?.name).toBe("ForeignScopedReadRefusedError");
        expect(result.error?.message).toContain(
          "the read authority probe failed: Error: probe down",
        );
        expect(asked).toEqual([bob.did()]);
        expect(logs.lines("foreign-scoped-read-grant-probe-failed")).toEqual([
          expect.stringContaining(
            `the read authority probe for ${space} (actor ${bob.did()}) ` +
              "failed; refusing the actor's instances fail-closed",
          ),
        ]);
        expect(replica.foreignScopedReadStanding(bob.did())).toBe("refused");
      });

      it("keeps the later of two read authority answers when the earlier one lands last", async () => {
        const answers: PromiseWithResolvers<
          Awaited<ReturnType<ForeignScopedReadGrant>>
        >[] = [];
        const asks = [
          Promise.withResolvers<void>(),
          Promise.withResolvers<void>(),
        ];
        const replica = replicaOver({
          gateForeignScopedReads: true,
          foreignScopedReadGrant: () => {
            const answer = Promise.withResolvers<
              Awaited<ReturnType<ForeignScopedReadGrant>>
            >();
            asks[answers.length]?.resolve();
            answers.push(answer);
            return answer.promise;
          },
        });
        const reading = replica.sync(
          "of:bob-draft" as URI,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        await asks[0].promise;
        expect(replica.foreignScopedReadStanding(bob.did())).toBe(
          "unresolved",
        );
        // Word of an access-list change asks again.
        replica.noteAclChanged();
        await asks[1].promise;
        answers[1].resolve({ granted: false, reason: "the list changed" });
        answers[0].resolve({ granted: true });
        await reading;
        expect(replica.foreignScopedReadStanding(bob.did())).toBe("refused");
      });

      it("admits an actor's scoped instance the read authority probe grants", async () => {
        const replica = replicaOver({
          gateForeignScopedReads: true,
          foreignScopedReadGrant: () => Promise.resolve({ granted: true }),
        });
        const result = await replica.sync(
          "of:bob-draft" as URI,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        // Past the gate the read reaches the server, which answers it under
        // its own rules.
        expect(result.error?.name).not.toBe("ForeignScopedReadRefusedError");
        expect(replica.foreignScopedReadStanding(bob.did())).toBe("admitted");
      });
    });

    describe("restoreSession()", () => {
      it("leaves the session standing on a host that records no session holdings", async () => {
        let restores = 0;
        let mounts = 0;
        const replica = replicaOver({
          createSession: async () => {
            mounts++;
            const { client, session } = await mount();
            session.restore = () => {
              restores++;
              return Promise.resolve();
            };
            return {
              session,
              client: {
                serverFlags: {
                  ...client.serverFlags!,
                  sessionHoldings: false,
                },
                delivered: () => client.delivered(),
                close: () => client.close(),
              },
            };
          },
        });
        await replica.restoreSession();
        expect(mounts).toBe(1);
        expect(restores).toBe(0);
      });

      it("restores the session on a host that records session holdings", async () => {
        let restores = 0;
        const replica = replicaOver({
          createSession: async () => {
            const opened = await mount();
            expect(opened.client.serverFlags?.sessionHoldings).toBe(true);
            const restore = opened.session.restore.bind(opened.session);
            opened.session.restore = () => {
              restores++;
              return restore();
            };
            return opened;
          },
        });
        await replica.restoreSession();
        expect(restores).toBe(1);
      });
    });

    describe("sendReport()", () => {
      it("resolves when no session can be reached", async () => {
        let mounts = 0;
        const replica = replicaOver({
          createSession: () => {
            mounts++;
            return Promise.reject(new Error("the host is down"));
          },
        });
        await replica.sendReport({
          kind: "echo-breaker",
          event: "trip",
          document: { id: "of:echo", scopeKey: "space" },
          action: "action:echo",
        });
        expect(mounts).toBe(1);
      });
    });

    describe("whenSessionRestored()", () => {
      it("rejects once the replica is closed, opening no session", async () => {
        let mounts = 0;
        const replica = replicaOver({
          createSession: () => {
            mounts++;
            return mount();
          },
        });
        replica.closeNow();
        await expect(replica.whenSessionRestored()).rejects.toThrow(
          "memory replica closed",
        );
        expect(mounts).toBe(0);
      });
    });

    describe("sealNative()", () => {
      it("rolls the sealed write back when the wave verdict rejects", async () => {
        const replica = replicaOver();
        confirm(replica, { n: 1 }, 1);
        const { verdict, settled } = sealSet(replica, { n: 2 });
        expect(replica.getDocument(doc)?.value).toEqual({ n: 2 });
        verdict.reject(new Error("the wave broke"));
        const result = await settled;
        expect(result.error?.message).toContain(
          "wave verdict rejected: the wave broke",
        );
        expect(replica.getDocument(doc)?.value).toEqual({ n: 1 });
      });

      it("logs a wave commit that lands after a reset rejected the seal", async () => {
        using logs = captureLogs("storage.v2");
        const replica = replicaOver();
        confirm(replica, { n: 1 }, 1);
        const { verdict, settled } = sealSet(replica, { n: 2 });
        replica.reset();
        expect((await settled).error?.message).toContain(
          "memory replica reset",
        );
        expect(logs.lines("seal-late-commit")).toEqual([]);
        verdict.resolve({ committed: { seq: 2 } });
        await verdict.promise;
        expect(logs.lines("seal-late-commit")).toEqual([
          expect.stringContaining(
            "wave committed a sealed commit after its local rejection",
          ),
        ]);
      });

      it("throws for a collaborative-field edit over a field that holds no text", () => {
        const replica = replicaOver();
        expect(() =>
          replica.sealNative(
            {
              operations: [{
                op: "patch",
                id: doc,
                type: "application/json",
                patches: [],
                value: { value: { title: 5 } },
              }],
              applyOps: [{
                op: "apply-op",
                id: doc,
                path: toValuePath(["title"]),
                codec: "test@1",
                submissionId: "edit:1",
                baselineHash: "baseline",
                payload: {},
              }],
            },
            undefined,
            new Promise<SealedCommitVerdict>(() => {}),
          )
        ).toThrow("an edited field holds no text at");
      });

      it("tells a document's sinks of the sealed write when nothing subscribes to notifications", async () => {
        const notifications: StorageNotification[] = [];
        const replica = replicaOver({
          subscription: subscriptionThat(false, (notification) => {
            notifications.push(notification);
          }),
        });
        confirm(replica, { n: 1 }, 1);
        const seen: unknown[] = [];
        replica.sinkDocument(doc, (document) => seen.push(document?.value));
        const { verdict, settled } = sealSet(replica, { n: 2 });
        expect(seen).toEqual([{ n: 2 }]);
        // The store's frame for the wave arrives ahead of its verdict.
        confirm(replica, { n: 2 }, 2);
        const seenBeforeVerdict = seen.length;
        verdict.resolve({ committed: { seq: 2 } });
        expect(await settled).toEqual({ ok: {} });
        expect(seen.length).toBeGreaterThan(seenBeforeVerdict);
        expect(seen.at(-1)).toEqual({ n: 2 });
        expect(notifications.filter((n) => n.type === "commit")).toEqual([]);
      });

      it("reports a sink that throws and still tells the other sinks", () => {
        using logs = captureLogs("storage.v2");
        const replica = replicaOver({
          subscription: subscriptionThat(false),
        });
        replica.sinkDocument(doc, () => {
          throw new Error("sink failed");
        });
        const seen: unknown[] = [];
        replica.sinkDocument(doc, (document) => seen.push(document?.value));
        sealSet(replica, { n: 2 });
        expect(seen).toEqual([{ n: 2 }]);
        expect(logs.lines("sink-error")).toEqual([
          expect.stringContaining("storage sink failed: Error: sink failed"),
        ]);
      });
    });

    describe("getDocument()", () => {
      it("renders a pending patch whose ops no longer apply to the confirmed base without it", () => {
        using logs = captureLogs("storage.v2.pending-patch");
        const replica = replicaOver();
        confirm(replica, { items: [] }, 1);
        const verdict = Promise.withResolvers<SealedCommitVerdict>();
        cleanups.push(() =>
          verdict.resolve({ withdrawn: { message: "test cleanup" } })
        );
        replica.sealNative(
          {
            operations: [{
              op: "patch",
              id: doc,
              type: "application/json",
              patches: [{ op: "add", path: "/value/items/-", value: "a" }],
              value: { value: { items: ["a"] } },
            }],
          },
          undefined,
          verdict.promise,
        );
        expect(replica.getDocument(doc)?.value).toEqual({ items: ["a"] });
        // Another writer replaced the list with a scalar the append cannot
        // land on.
        confirm(replica, { items: 5 }, 2);
        expect(replica.getDocument(doc)?.value).toEqual({ items: 5 });
        expect(logs.lines("pending-replay-skip")).toEqual([
          expect.stringContaining(
            "pending patch layer skipped: ops do not apply to the current base",
          ),
        ]);
      });
    });

    describe("storeCommitOf()", () => {
      it("throws for a transaction carrying collaborative-field edits", () => {
        const replica = replicaOver();
        expect(() =>
          replica.storeCommitOf({
            operations: [],
            applyOps: [{
              op: "apply-op",
              id: doc,
              path: toValuePath(["title"]),
              codec: "test@1",
              submissionId: "edit:1",
              baselineHash: "baseline",
              payload: {},
            }],
          }, undefined)
        ).toThrow(
          "a store commit built ahead of its seal cannot carry " +
            "collaborative-field edits",
        );
      });
    });

    describe("commitNative()", () => {
      it("returns `ok` for an empty transaction, opening no session", async () => {
        let mounts = 0;
        const replica = replicaOver({
          createSession: () => {
            mounts++;
            return mount();
          },
        });
        expect(await replica.commitNative({ operations: [] })).toEqual({
          ok: {},
        });
        expect(mounts).toBe(0);
      });

      it("refuses an absence precondition on a local session document that holds a write", async () => {
        setCommitPreconditionsConfig(true);
        cleanups.push(() => setCommitPreconditionsConfig(undefined));
        let mounts = 0;
        const replica = replicaOver({
          localSessionDocuments: true,
          createSession: () => {
            mounts++;
            return mount();
          },
        });
        const precondition = {
          kind: "entity-absent" as const,
          id: doc,
          scope: "session" as const,
        };
        // Nothing has written the document yet, so the precondition holds
        // and, with nothing to write, nothing is sent.
        expect(
          await replica.commitNative({
            operations: [],
            preconditions: [precondition],
          }),
        ).toEqual({ ok: {} });
        const verdict = Promise.withResolvers<SealedCommitVerdict>();
        cleanups.push(() =>
          verdict.resolve({ withdrawn: { message: "test cleanup" } })
        );
        replica.sealNative(
          {
            operations: [{
              op: "set",
              id: doc,
              scope: "session",
              type: "application/json",
              value: { value: { n: 1 } },
            }],
          },
          undefined,
          verdict.promise,
        );
        expect(
          await replica.commitNative({
            operations: [],
            preconditions: [precondition],
          }),
        ).toEqual({
          error: {
            name: "PreconditionFailedError",
            message: "Local session document already exists",
            precondition: "receipt-exists",
          },
        });
        expect(mounts).toBe(0);
      });
    });

    describe("send()", () => {
      it("returns `ok` for an empty batch, opening no session", async () => {
        let mounts = 0;
        const replica = replicaOver({
          createSession: () => {
            mounts++;
            return mount();
          },
        });
        expect(await replica.send([])).toEqual({ ok: {} });
        expect(mounts).toBe(0);
      });
    });
    describe("shadowFlipObserver", () => {
      // A frame carrying another writer's version of a document this replica
      // holds an own write over leaves that version shadowed until the own
      // write settles.

      it("tells the sinks and reports an observer that throws when a promotion lifts a shadow under server execution", async () => {
        setServerExecutionConfig(true);
        cleanups.push(() => setServerExecutionConfig(undefined));
        using logs = captureLogs("storage.v2");
        const replica = replicaOver({
          subscription: subscriptionThat(false),
        });
        confirm(replica, { n: 1 }, 1);
        const { verdict, settled } = sealSet(replica, { n: 2 });
        confirm(replica, { n: 5 }, 3);
        const seen: unknown[] = [];
        replica.sinkDocument(doc, (document) => seen.push(document?.value));
        expect(replica.unappliedForeignSeqFloor()).toBe(3);
        let flips = 0;
        replica.shadowFlipObserver = () => {
          flips++;
          throw new Error("observer failed");
        };
        verdict.resolve({ committed: { seq: 2 } });
        expect(await settled).toEqual({ ok: {} });
        expect(flips).toBe(1);
        expect(replica.unappliedForeignSeqFloor()).toBeUndefined();
        expect(replica.getDocument(doc)?.value).toEqual({ n: 5 });
        expect(seen.at(-1)).toEqual({ n: 5 });
        expect(logs.lines("shadow-flip-observer-error")).toEqual([
          expect.stringContaining(
            "shadowFlipObserver threw during promotion Error: observer failed",
          ),
        ]);
      });

      it("reports an observer that throws when a drop lifts a shadow under server execution", async () => {
        setServerExecutionConfig(true);
        cleanups.push(() => setServerExecutionConfig(undefined));
        using logs = captureLogs("storage.v2");
        const replica = replicaOver();
        confirm(replica, { n: 1 }, 1);
        const { verdict, settled } = sealSet(replica, { n: 2 });
        // A removal names no seq, so it holds the floor at its sentinel.
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: 1,
          toSeq: 3,
          removes: [{ id: doc, branch: "" }],
          upserts: [],
        }, "integrate");
        expect(replica.unappliedForeignSeqFloor()).toBe(1);
        let flips = 0;
        replica.shadowFlipObserver = () => {
          flips++;
          throw new Error("observer failed");
        };
        verdict.resolve({ withdrawn: { message: "the wave withdrew it" } });
        expect((await settled).error?.message).toContain(
          "the wave withdrew it",
        );
        expect(flips).toBe(1);
        expect(replica.unappliedForeignSeqFloor()).toBeUndefined();
        expect(logs.lines("shadow-flip-observer-error")).toEqual([
          expect.stringContaining(
            "shadowFlipObserver threw during a pending drop",
          ),
        ]);
      });
    });

    describe("speculationArrivalObserver", () => {
      it("reports an observer that throws and still applies the frame", () => {
        using logs = captureLogs("storage.v2");
        const replica = replicaOver();
        const arrivals: unknown[] = [];
        replica.speculationArrivalObserver = (arrived) => {
          arrivals.push(arrived);
          throw new Error("observer failed");
        };
        confirm(replica, { n: 1 }, 1);
        expect(arrivals).toEqual([[{ id: doc }]]);
        expect(replica.getDocument(doc)?.value).toEqual({ n: 1 });
        expect(logs.lines("speculation-arrival-observer-error")).toEqual([
          expect.stringContaining(
            "speculationArrivalObserver threw during frame integration",
          ),
        ]);
      });
    });

    describe("speculationAckObserver", () => {
      it("reports an observer that throws and still settles the accepted commit", async () => {
        using logs = captureLogs("storage.v2");
        const replica = replicaOver();
        let acks = 0;
        replica.speculationAckObserver = () => {
          acks++;
          throw new Error("observer failed");
        };
        expect(
          await replica.commitNative({
            operations: [{
              op: "set",
              id: doc,
              type: "application/json",
              value: { value: { n: 1 } },
            }],
          }),
        ).toEqual({ ok: {} });
        expect(acks).toBe(1);
        expect(replica.getDocument(doc)?.value).toEqual({ n: 1 });
        expect(logs.lines("speculation-ack-observer-error")).toEqual([
          expect.stringContaining(
            "speculationAckObserver threw during accept settlement",
          ),
        ]);
      });
    });

    describe("accessForTestingOnly", () => {
      describe("recordStaleFloor()", () => {
        it("floors every document a commit wrote or read, past its SQLite operations", () => {
          const replica = replicaOver();
          const testing = replica.accessForTestingOnly;
          const written = "of:written" as URI;
          const readPending = "of:read-pending" as URI;
          const untouched = "of:untouched" as URI;
          testing.recordStaleFloor({
            localSeq: 7,
            reads: {
              confirmed: [],
              pending: [{
                id: readPending,
                path: toDocumentPath([]),
                localSeq: 3,
                basisSeq: 0,
              }],
            },
            operations: [
              {
                op: "sqlite",
                db: { id: "of:db" },
                sql: "SELECT 1",
              },
              { op: "set", id: written, value: { value: 1 } },
            ],
          }, 7);
          const readerOf = (id: URI) => ({
            localSeq: 8,
            reads: {
              confirmed: [],
              pending: [{
                id,
                path: toDocumentPath([]),
                localSeq: 3,
                basisSeq: 0,
              }],
            },
            operations: [],
          });
          expect(testing.preemptThreshold(readerOf(written))).toBe(7);
          expect(testing.preemptThreshold(readerOf(readPending))).toBe(7);
          expect(testing.preemptThreshold(readerOf(untouched)))
            .toBeUndefined();
        });
      });

      describe("buildReads()", () => {
        it("throws for a transaction that reports no read activities", () => {
          const replica = replicaOver();
          expect(() =>
            replica.accessForTestingOnly.buildReads(
              {} as Parameters<SpaceReplica["commitNative"]>[1],
              1,
            )
          ).toThrow(
            "Memory v2 commit tracking requires source.getReadActivities()",
          );
        });
      });
    });
    describe("releaseUnread()", () => {
      // A document is released on the second pass after its load: the first
      // keeps it as loaded since that pass began.

      /** A replica of `space` whose session the case can reach. */
      const releasingReplica = (
        options: Parameters<typeof replicaOver>[0] = {},
      ) => {
        const sessions: MemoryV2Client.SpaceSession[] = [];
        const replica = replicaOver({
          ...options,
          createSession: async () => {
            const opened = await mount();
            sessions.push(opened.session);
            return opened;
          },
        });
        return { replica, sessions };
      };

      it("logs and keeps the watches when the session cannot be reached", async () => {
        using logs = captureLogs("storage.v2");
        const routeState = { generation: 0 };
        const { replica } = releasingReplica({ routeState });
        expect((await replica.sync(doc)).error).toBeUndefined();
        expect(await replica.releaseUnread()).toEqual({
          released: [],
          deferred: true,
        });
        // Another route took the space over.
        routeState.generation = 1;
        expect(await replica.releaseUnread()).toEqual({
          released: [],
          deferred: false,
        });
        expect(logs.lines("release-watches-deferred")).toEqual([
          expect.stringContaining(
            "keeping the watches of documents nothing reads for a later " +
              "pass: Error: memory replica closed",
          ),
        ]);
      });

      it("logs and keeps the watches for a later pass when their removal fails", async () => {
        using logs = captureLogs("storage.v2");
        const { replica, sessions } = releasingReplica();
        expect((await replica.sync(doc)).error).toBeUndefined();
        await replica.releaseUnread();
        const remove = sessions[0].watchRemoveSync;
        sessions[0].watchRemoveSync = () =>
          Promise.reject(new Error("removal refused"));
        expect(await replica.releaseUnread()).toEqual({
          released: [],
          deferred: false,
        });
        expect(logs.lines("release-watches-failed")).toEqual([
          expect.stringContaining(
            "failed to remove the watches of documents nothing reads: " +
              "Error: removal refused",
          ),
        ]);
        // The next pass offers them again.
        sessions[0].watchRemoveSync = remove;
        expect((await replica.releaseUnread()).released).toEqual([
          expect.objectContaining({ id: doc }),
        ]);
      });

      it("logs a document held during its release that the space refuses to watch again, and drops it", async () => {
        using logs = captureLogs("storage.v2");
        let held = false;
        const watched: URI[] = [];
        const refusal = Object.assign(new Error("watch refused"), {
          name: "AuthorizationError",
        });
        const dropped = Promise.withResolvers<readonly { id: URI }[]>();
        const { replica, sessions } = releasingReplica({
          isRead: () => held,
          watchDocument: (address) => {
            watched.push(address.id);
            return Promise.resolve({ error: refusal });
          },
          onDocumentsDropped: (addresses) => dropped.resolve(addresses),
        });
        expect((await replica.sync(doc)).error).toBeUndefined();
        await replica.releaseUnread();
        const remove = sessions[0].watchRemoveSync.bind(sessions[0]);
        sessions[0].watchRemoveSync = (watchIds, consume) => {
          // A reader takes the document up while its removal is on its way.
          held = true;
          return remove(watchIds, consume);
        };
        await replica.releaseUnread();
        expect(await dropped.promise).toEqual([
          expect.objectContaining({ id: doc }),
        ]);
        expect(watched).toEqual([doc]);
        expect(logs.lines("watch-again-failed")).toEqual([
          expect.stringContaining(
            "a document held during its release could not be watched again: " +
              `${doc}`,
          ),
        ]);
      });
    });
    describe("readStoreAbsenceAgain()", () => {
      it("asks the store again for an instance it reported absent, but not while a frame applies", async () => {
        const asked: string[] = [];
        const replica = replicaOver({
          storeReadThrough: ({ id, scopeKey }) => {
            asked.push(id);
            return {
              branch: "",
              id,
              scope: "space",
              scopeKey,
              seq: 0,
              deleted: true,
            };
          },
        });
        expect((await replica.sync(doc)).error).toBeUndefined();
        expect(asked).toEqual([doc]);
        expect(replica.storeReportedAbsent({ id: doc })).toBe(true);

        const duringFrame: (boolean | undefined)[] = [];
        replica.speculationArrivalObserver = () => {
          duringFrame.push(replica.readStoreAbsenceAgain({ id: doc }));
        };
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          removes: [],
          upserts: [{
            id: "of:another" as URI,
            branch: "",
            seq: 1,
            doc: { value: 1 },
          }],
        }, "integrate");
        expect(duringFrame).toEqual([undefined]);
        expect(asked).toEqual([doc]);

        expect(replica.readStoreAbsenceAgain({ id: doc })).toBe(false);
        expect(asked).toEqual([doc, doc]);
      });

      it("returns `undefined` for a scope the identity cannot resolve, asking nothing", () => {
        const asked: string[] = [];
        const replica = replicaOver({
          storeReadThrough: ({ id }) => {
            asked.push(id);
            return undefined;
          },
        });
        expect(replica.readStoreAbsenceAgain({ id: doc, scope: "user" }, {}))
          .toBeUndefined();
        expect(asked).toEqual([]);
      });
    });

    describe("accessForTestingOnly.refreshWatchSet()", () => {
      it("returns `ok` for no entries", async () => {
        const replica = replicaOver();
        expect(await replica.accessForTestingOnly.refreshWatchSet([]))
          .toEqual({ ok: {} });
      });

      it("returns an error for an unnamed scoped read on a gating replica", async () => {
        const replica = replicaOver({ gateForeignScopedReads: true });
        const result = await replica.accessForTestingOnly.refreshWatchSet([[
          { id: doc, type: "application/json", scope: "user" },
          { path: [], schema: false },
        ]]);
        expect(result.error?.message).toContain(
          "an unnamed scoped read reached the wire past the entry gate",
        );
        // A space-scope read beside it is no concern of the gate.
        expect(
          (await replica.accessForTestingOnly.refreshWatchSet([[
            { id: doc, type: "application/json", scope: "space" },
            { path: [], schema: false },
          ]])).error,
        ).toBeUndefined();
      });
    });
    describe("repullRefused()", () => {
      it("keeps a load the space refuses again for a later retry, and resolves", async () => {
        const refusal = () =>
          Object.assign(new Error("not on the access list"), {
            name: "AuthorizationError",
          });
        let refusing = true;
        let watches = 0;
        const replica = replicaOver({
          createSession: async () => {
            const opened = await mount();
            const watchAddSync = opened.session.watchAddSync.bind(
              opened.session,
            );
            opened.session.watchAddSync = (entries) => {
              watches++;
              return refusing
                ? Promise.reject(refusal())
                : watchAddSync(entries);
            };
            return opened;
          },
        });
        expect((await replica.sync(doc)).error?.name).toBe(
          "AuthorizationError",
        );
        await replica.repullRefused();
        expect(watches).toBe(2);

        refusing = false;
        await replica.repullRefused();
        expect(watches).toBe(3);
        // Nothing is owed once a replay lands.
        await replica.repullRefused();
        expect(watches).toBe(3);
      });
    });
    describe("a document's sinks", () => {
      // A replica builds a change notification only for subscribers; a sink
      // is told either way, from the notification's changes or from the
      // documents the change touched.

      for (const subscribed of [true, false]) {
        const subscribers = subscribed ? "with" : "without";

        /** A replica of `doc` at `{ n: 1 }`, and what `doc`'s sink saw. */
        const sinkedReplica = (options: Parameters<typeof replicaOver>[0]) => {
          const replica = replicaOver({
            ...options,
            subscription: subscriptionThat(subscribed),
          });
          confirm(replica, { n: 1 }, 1);
          const seen: unknown[] = [];
          replica.sinkDocument(doc, (document) => seen.push(document?.value));
          return { replica, seen };
        };

        it(`hear a pushed commit ${subscribers} notification subscribers`, async () => {
          const { replica, seen } = sinkedReplica({});
          const committing = replica.commitNative({
            operations: [{
              op: "set",
              id: doc,
              type: "application/json",
              value: { value: { n: 2 } },
            }],
          });
          expect(seen).toEqual([{ n: 2 }]);
          expect(await committing).toEqual({ ok: {} });
        });

        it(`hear a withdrawn seal roll back ${subscribers} notification subscribers`, async () => {
          const { replica, seen } = sinkedReplica({});
          const { verdict, settled } = sealSet(replica, { n: 2 });
          verdict.resolve({ withdrawn: { message: "the wave withdrew it" } });
          expect((await settled).error).toBeDefined();
          expect(seen).toEqual([{ n: 2 }, { n: 1 }]);
        });

        it(`hear a speculation retire ${subscribers} notification subscribers`, async () => {
          const { replica, seen } = sinkedReplica({});
          const verdict = Promise.withResolvers<SealedCommitVerdict>();
          const sealed = replica.sealNative(
            {
              operations: [{
                op: "set",
                id: doc,
                type: "application/json",
                value: { value: { n: 2 } },
              }],
            },
            undefined,
            verdict.promise,
            { speculative: true },
          );
          verdict.resolve({
            withdrawn: { message: "retired", superseded: true },
          });
          expect(await sealed.settled).toEqual({ ok: {} });
          expect(seen).toEqual([{ n: 2 }, { n: 1 }]);
        });

        it(`hear a promotion lift a shadow ${subscribers} notification subscribers`, async () => {
          setServerExecutionConfig(true);
          cleanups.push(() => setServerExecutionConfig(undefined));
          const { replica, seen } = sinkedReplica({});
          const { verdict, settled } = sealSet(replica, { n: 2 });
          confirm(replica, { n: 5 }, 3);
          expect(replica.getDocument(doc)?.value).toEqual({ n: 2 });
          verdict.resolve({ committed: { seq: 2 } });
          expect(await settled).toEqual({ ok: {} });
          expect(seen.at(-1)).toEqual({ n: 5 });
        });
      }
    });
    describe("commitNative() across a route replacement", () => {
      it("refuses a commit whose route another one replaced before it was issued", async () => {
        const routeState = { generation: 0 };
        let issued = 0;
        const replica = replicaOver({
          routeState,
          createSession: async () => {
            const opened = await mount();
            const transact = opened.session.transact.bind(opened.session);
            opened.session.transact = (commit, onIssue) => {
              // Another route takes the space over as the commit goes out.
              routeState.generation = 1;
              return transact(commit, () => {
                issued++;
                onIssue?.();
              });
            };
            return opened;
          },
        });
        confirm(replica, { n: 1 }, 1);
        const result = await replica.commitNative({
          operations: [{
            op: "set",
            id: doc,
            type: "application/json",
            value: { value: { n: 2 } },
          }],
        });
        expect(result.error?.message).toContain(
          "memory replica route replaced",
        );
        expect(issued).toBe(1);
        expect(replica.getDocument(doc)?.value).toEqual({ n: 1 });
      });
    });
    describe("accessForTestingOnly.hydrateArrivedCfcSchemaRefs()", () => {
      it("logs a failed pull of a schema document arrived metadata names, and pulls it again for the next frame", async () => {
        using logs = captureLogs("storage.v2");
        const hash = "v2-space-replica-unregistered-schema";
        let attempts = 0;
        const retried = Promise.withResolvers<void>();
        const replica = replicaOver({
          createSession: () => {
            if (++attempts === 2) retried.resolve();
            return Promise.reject(new Error("the host is down"));
          },
        });
        const frame = {
          type: "sync" as const,
          fromSeq: 0,
          toSeq: 1,
          removes: [],
          upserts: [{
            id: doc,
            branch: "",
            seq: 1,
            doc: { value: { n: 1 }, cfc: { schemaHash: hash } },
          }],
        };
        replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
        expect(await logs.line("cfc-schema-hydration-failed")).toContain(
          "arrived-metadata document pull failed; a later frame carrying " +
            "the reference re-kicks",
        );
        expect(attempts).toBe(1);
        replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
        await retried.promise;
        expect(attempts).toBe(2);
      });
    });
    describe("ensureSession()", () => {
      it("closes a session that opened after another route took the space over, and rejects", async () => {
        const routeState = { generation: 0 };
        const closed: string[] = [];
        const replica = replicaOver({
          routeState,
          createSession: async () => {
            const { client, session } = await mount();
            routeState.generation = 1;
            return {
              session,
              client: {
                serverFlags: client.serverFlags,
                delivered: () => client.delivered(),
                close: () => {
                  closed.push(session.sessionId);
                  return client.close();
                },
              },
            };
          },
        });
        await expect(replica.ensureSession()).rejects.toThrow(
          "memory replica closed",
        );
        expect(closed.length).toBe(1);
      });
    });
  });
});
