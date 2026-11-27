import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { resolveScopeKey, type SessionReport } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import type {
  ForeignScopedReadGrant,
  MemorySpace,
  SealedCommitVerdict,
  URI,
} from "../src/storage/interface.ts";
import { SpaceReplica } from "../src/storage/v2.ts";
import { mountOver } from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const AUDIENCE = "did:key:z6Mk-runner-storage-v2-replica-close-audience";

const service = await Identity.fromPassphrase("storage-v2-replica-close svc");
const bob = await Identity.fromPassphrase("storage-v2-replica-close bob");
const space: MemorySpace = (await Identity.fromPassphrase(
  "storage-v2-replica-close space",
)).did();

const doc = "of:storage-v2-replica-close-doc" as URI;
const bobDraft = "of:storage-v2-replica-close-bob-draft" as URI;

/**
 * Resolves after a grant ask queued before the call: the replica asks the
 * probe from a microtask, and microtasks run in the order they were queued.
 */
const askQueued = () => Promise.resolve();

describe("SpaceReplica", () => {
  let server: MemoryV2Server.Server;
  let cleanups: (() => Promise<void> | void)[];

  /** Mounts `space` on `server` as the service, over the loopback transport. */
  const mount = async () => {
    const opened = await mountOver(
      MemoryV2Client.loopback(server),
      space,
      service,
    );
    cleanups.push(() => opened.client.close());
    return opened;
  };

  /** Commits `value` to `doc` through a session of its own. */
  const write = async (value: FabricValue, localSeq: number) => {
    const { session } = await mount();
    await session.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: doc, value: { value } }],
    });
  };

  /**
   * A replica of `space` acting as the service, closed after the case. Each
   * session it opens is handed to `onSession` before the replica uses it.
   */
  const replicaOver = (
    options: {
      onSession?: (session: MemoryV2Client.SpaceSession) => void;
      foreignScopedReadGrant?: (
        principal: string,
      ) => ReturnType<ForeignScopedReadGrant>;
      isRead?: () => boolean;
      watchDocument?: (address: { id: URI }) => Promise<
        { ok: Record<never, never>; error?: undefined } | { error: Error }
      >;
    } = {},
  ): SpaceReplica => {
    const replica = new SpaceReplica({
      as: service,
      space,
      settings: {},
      subscription: { next: () => {} },
      localSessionDocuments: () => false,
      scopeKeyIdentity: () => ({
        principal: service.did(),
        sessionId: "storage-v2-replica-close-session",
      }),
      routeState: { generation: 0 },
      routeGeneration: 0,
      createSession: async () => {
        const opened = await mount();
        options.onSession?.(opened.session);
        return opened;
      },
      syncReplayDependencies: () => Promise.resolve(undefined),
      watchDocument: options.watchDocument ??
        (() => Promise.resolve({ ok: {} })),
      isRead: options.isRead,
      storeReadThrough: () => undefined,
      gateForeignScopedReads: options.foreignScopedReadGrant !== undefined,
      foreignScopedReadGrant: () => options.foreignScopedReadGrant,
    });
    cleanups.push(() => replica.closeNow());
    return replica;
  };

  beforeEach(() => {
    cleanups = [];
    server = new MemoryV2Server.Server({
      namesInstances: namesInstancesByDefault,
      store: new URL(
        `memory://storage-v2-replica-close-${crypto.randomUUID()}`,
      ),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      subscriptionRefreshDelayMs: "manual",
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  describe("instance members", () => {
    describe("sync()", () => {
      it("applies the answer to its watch", async () => {
        await write({ n: 1 }, 1);
        const replica = replicaOver();
        expect((await replica.sync(doc)).error).toBeUndefined();
        expect(replica.getDocument(doc)).toEqual({ value: { n: 1 } });
      });

      it("applies nothing of an answer to its watch that lands once the replica is closing", async () => {
        await write({ n: 1 }, 1);
        let closing: Promise<void> | undefined;
        const replica: SpaceReplica = replicaOver({
          onSession: (session) => {
            const watchAddSync = session.watchAddSync.bind(session);
            session.watchAddSync = (watches, consume) =>
              watchAddSync(watches, (result) => {
                closing = replica.close();
                consume?.(result);
              });
          },
        });
        const result = await replica.sync(doc);
        await closing;
        expect(result.error?.message).toContain("memory replica closed");
        expect(replica.getDocument(doc)).toBeUndefined();
      });
    });

    describe("releaseUnread()", () => {
      // A document is released on the second pass after its load, and one a
      // reader takes up while its removal is on its way is watched again
      // when the removal is answered.

      /**
       * Releases `doc` while a reader takes it up, calling `onAnswer` as the
       * removal's answer lands, and returns the documents watched again.
       */
      const releaseHeld = async (onAnswer: (replica: SpaceReplica) => void) => {
        let held = false;
        const watched: URI[] = [];
        const sessions: MemoryV2Client.SpaceSession[] = [];
        const replica: SpaceReplica = replicaOver({
          isRead: () => held,
          watchDocument: (address) => {
            watched.push(address.id);
            return Promise.resolve({ ok: {} });
          },
          onSession: (session) => sessions.push(session),
        });
        expect((await replica.sync(doc)).error).toBeUndefined();
        await replica.releaseUnread();
        const remove = sessions[0].watchRemoveSync.bind(sessions[0]);
        sessions[0].watchRemoveSync = (watchIds, consume) => {
          held = true;
          return remove(watchIds, (mutation) => {
            onAnswer(replica);
            consume?.(mutation);
          });
        };
        await replica.releaseUnread();
        return watched;
      };

      it("watches again a document held while its removal was on its way", async () => {
        expect(await releaseHeld(() => {})).toEqual([doc]);
      });

      it("watches nothing again when the removal is answered once the replica is closing", async () => {
        let closing: Promise<void> | undefined;
        const watched = await releaseHeld((replica) => {
          closing = replica.close();
        });
        await closing;
        expect(watched).toEqual([]);
      });
    });

    describe("setViewInterests()", () => {
      // The server holds back the frames of a commit made after the replica
      // loaded `doc`, so the answer to the replica's next watch set is what
      // brings the commit to it.

      /**
       * A replica holding `doc` at `{ n: 1 }` while the server holds
       * `{ n: 2 }`, which calls `onAnswer` as its view set is answered.
       */
      const staleReplica = async (
        onAnswer: (replica: SpaceReplica) => void,
      ) => {
        await write({ n: 1 }, 1);
        const replica: SpaceReplica = replicaOver({
          onSession: (session) => {
            const viewSetSync = session.viewSetSync.bind(session);
            session.viewSetSync = (views, consume) =>
              viewSetSync(views, (result) => {
                onAnswer(replica);
                consume?.(result);
              });
          },
        });
        expect((await replica.sync(doc)).error).toBeUndefined();
        await write({ n: 2 }, 2);
        expect(replica.getDocument(doc)).toEqual({ value: { n: 1 } });
        return replica;
      };

      it("applies the answer to the view set", async () => {
        const replica = await staleReplica(() => {});
        expect(await replica.setViewInterests([])).toBe(true);
        expect(replica.getDocument(doc)).toEqual({ value: { n: 2 } });
      });

      it("applies nothing of an answer that lands once the replica is closing", async () => {
        let closing: Promise<void> | undefined;
        const replica = await staleReplica((replica) => {
          closing = replica.close();
        });
        expect(await replica.setViewInterests([])).toBe(false);
        await closing;
        expect(replica.getDocument(doc)).toEqual({ value: { n: 1 } });
      });
    });

    describe("noteAclChanged()", () => {
      /**
       * A gating replica that has asked for `bob`'s grant once, and the
       * list of the actors it has asked about so far.
       */
      const askedReplica = async () => {
        const asked: string[] = [];
        const replica = replicaOver({
          foreignScopedReadGrant: (actor) => {
            asked.push(actor);
            return Promise.resolve({ granted: true });
          },
        });
        await replica.sync(
          bobDraft,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        expect(asked).toEqual([bob.did()]);
        return { replica, asked };
      };

      it("asks again for the grant of each actor it has asked about", async () => {
        const { replica, asked } = await askedReplica();
        replica.noteAclChanged();
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did()]);
      });

      it("asks for no grant once the replica has closed", async () => {
        const { replica, asked } = await askedReplica();
        await replica.close();
        replica.noteAclChanged();
        await askQueued();
        expect(asked).toEqual([bob.did()]);
      });
    });

    describe("access-list watch", () => {
      // A gating replica watches its space's access list once it has asked
      // for an actor's grant. The first version of the list to land asks
      // every grant again, and each later version is word of a change,
      // which asks them again too.

      /** Delivers `value` as the access list's confirmed state at `seq`. */
      const confirmList = (
        replica: SpaceReplica,
        value: FabricValue,
        seq: number,
      ) =>
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: seq - 1,
          toSeq: seq,
          removes: [],
          upserts: [{ id: aclDocId(space), branch: "", seq, doc: { value } }],
        }, "pull");

      it("asks no grant again for a local write that leaves the confirmed list as it was", async () => {
        const asked: string[] = [];
        const replica = replicaOver({
          foreignScopedReadGrant: (actor) => {
            asked.push(actor);
            return Promise.resolve({ granted: true });
          },
        });
        await replica.sync(
          bobDraft,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        expect(asked).toEqual([bob.did()]);
        confirmList(replica, { version: 1 }, 1);
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did()]);
        confirmList(replica, { version: 2 }, 2);
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did(), bob.did()]);

        const verdict = Promise.withResolvers<SealedCommitVerdict>();
        cleanups.push(() =>
          verdict.resolve({ withdrawn: { message: "test cleanup" } })
        );
        replica.sealNative(
          {
            operations: [{
              op: "set",
              id: aclDocId(space) as URI,
              type: "application/json",
              value: { value: { version: 3 } },
            }],
          },
          undefined,
          verdict.promise,
        );
        expect(replica.getDocument(aclDocId(space) as URI)).toEqual({
          value: { version: 3 },
        });
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did(), bob.did()]);
      });
    });

    describe("quarantined documents", () => {
      // A frame's document whose schema metadata is malformed is
      // quarantined, and the replica asks the server to deliver it again
      // with a watch set declaring its holdings.

      /** Delivers `id` at `seq` carrying malformed schema metadata. */
      const deliverMalformed = (replica: SpaceReplica, id: URI, seq: number) =>
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: seq - 1,
          toSeq: seq,
          removes: [],
          upserts: [{ id, branch: "", seq, doc: { value: seq, schema: 5 } }],
        }, "integrate");

      it("asks for a document quarantined while a re-delivery is on its way only once that re-delivery is answered", async () => {
        using logs = captureLogs("storage.v2");
        const sessions: MemoryV2Client.SpaceSession[] = [];
        const replica = replicaOver({
          onSession: (session) => sessions.push(session),
        });
        expect((await replica.sync(doc)).error).toBeUndefined();
        const watchSetSync = sessions[0].watchSetSync.bind(sessions[0]);
        const answer = Promise.withResolvers<void>();
        const asked = Promise.withResolvers<void>();
        let requests = 0;
        let unanswered = 0;
        let mostUnanswered = 0;
        sessions[0].watchSetSync = async (...args) => {
          requests++;
          mostUnanswered = Math.max(mostUnanswered, ++unanswered);
          asked.resolve();
          await answer.promise;
          try {
            return await watchSetSync(...args);
          } finally {
            unanswered--;
          }
        };

        deliverMalformed(
          replica,
          "of:storage-v2-replica-close-first" as URI,
          1,
        );
        await asked.promise;
        deliverMalformed(
          replica,
          "of:storage-v2-replica-close-second" as URI,
          2,
        );
        answer.resolve();
        await replica.inputSynced();
        expect(requests).toBe(2);
        expect(mostUnanswered).toBe(1);
        expect(logs.textsOf("schema-doc-quarantine")).toHaveLength(2);
      });
    });

    describe("noteRetryRequested()", () => {
      it("asks again for each grant while open, and for none once closed", async () => {
        const asked: string[] = [];
        const replica = replicaOver({
          foreignScopedReadGrant: (actor) => {
            asked.push(actor);
            return Promise.resolve({ granted: true });
          },
        });
        await replica.sync(
          bobDraft,
          undefined,
          "user",
          resolveScopeKey("user", { principal: bob.did() }),
        );
        replica.noteRetryRequested();
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did()]);
        await replica.close();
        replica.noteRetryRequested();
        await askQueued();
        expect(asked).toEqual([bob.did(), bob.did()]);
      });
    });

    describe("sendReport()", () => {
      const report: SessionReport = {
        kind: "echo-breaker",
        event: "trip",
        document: { id: doc, scopeKey: "space" },
        action: "storage-v2-replica-close-action",
      };

      it("sends the report on the session while open, and nothing once closed", async () => {
        const sent: SessionReport[] = [];
        const replica = replicaOver({
          onSession: (session) => {
            session.sendReport = (report) => {
              sent.push(report);
              return Promise.resolve();
            };
          },
        });
        await replica.sendReport(report);
        expect(sent).toEqual([report]);
        await replica.close();
        await replica.sendReport(report);
        expect(sent).toEqual([report]);
      });
    });
  });
});
