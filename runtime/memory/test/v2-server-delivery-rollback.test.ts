import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/api";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  resetServerExecutionConfig,
  type SessionEffectMessage,
  type SessionOpenResult,
  setServerExecutionConfig,
  toDirtyKey,
  toValuePath,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";

const SPACE = "did:key:z6Mk-delivery-rollback";
const FAR_SPACE = "did:key:z6Mk-delivery-rollback-far";
const SERVICE = "did:key:z6Mk-delivery-rollback-service";

const link = (space: string, id: string) => ({
  "/": { "link@1": { space, id, path: [] } },
});

/** Watches `id` and every document its `next` link reaches. */
const following = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: {
    roots: [{
      id,
      selector: {
        path: [],
        schema: {
          type: "object",
          properties: {
            next: { type: "object", properties: { n: { type: "number" } } },
          },
        },
      },
    }],
  },
});

/** Watches `id` alone. */
const plain = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

const idsOf = (entries: ReadonlyArray<{ id: string }> | undefined) =>
  (entries ?? []).map((entry) => entry.id);

describe("Server", () => {
  // Sessions open without an issuer are anonymous; one that names an issuer
  // opens as that principal.

  let server: Server;
  let peer: WirePeer;

  beforeEach(async () => {
    server = new Server({
      store: new URL(`memory://delivery-rollback-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: { audience: "did:key:z6Mk-delivery-rollback-audience" },
      acl: { mode: "off", delegatingDids: [SERVICE] },
    });
    peer = await connectPeer(server);
  });

  afterEach(async () => {
    await server.close();
  });

  /** Opens an anonymous session watching `watches`. */
  const watching = async (...watches: WatchSpec[]): Promise<string> => {
    const { sessionId } = await openSession(peer, SPACE);
    const watched = await request<WatchSetResult>(peer, {
      type: "session.watch.set",
      space: SPACE,
      sessionId,
      watches,
    });
    expect(watched.error).toBeUndefined();
    return sessionId;
  };

  /** Builds `sessionId`'s next frame for a batch that dirtied `ids`. */
  const sync = (sessionId: string, ...ids: string[]) =>
    server.syncSessionForConnection(
      SPACE,
      sessionId,
      new Set(ids.map((id) => toDirtyKey(id))),
    );

  const write = (id: string, value: FabricValue) =>
    server.writeDocument(SPACE, id, value);

  describe("rollbackUndeliveredSync()", () => {
    it("sends the removal again after rolling back a frame of its own that removed a document", async () => {
      await write("of:leaf", { n: 1 });
      await write("of:top", { next: link(SPACE, "of:leaf") });
      const sessionId = await watching(following("of:top"));
      await write("of:top", { next: null });
      const lost = await sync(sessionId, "of:top");
      expect(idsOf(lost?.effect.removes)).toEqual(["of:leaf"]);

      server.rollbackUndeliveredSync(SPACE, sessionId, lost!);

      const resent = await sync(sessionId);
      expect(idsOf(resent?.effect.removes)).toEqual(["of:leaf"]);
      expect(await sync(sessionId)).toBeNull();
    });

    describe("given a frame it did not build", () => {
      it("sends the frame's upserts again, skipping one in a scope the session cannot resolve", async () => {
        await write("of:doc", { n: 1 });
        const sessionId = await watching(plain("of:doc"));
        await write("of:doc", { n: 2 });
        const built = await sync(sessionId, "of:doc");
        const [upsert] = built!.effect.upserts;
        expect(upsert.id).toBe("of:doc");
        expect(await sync(sessionId, "of:doc")).toBeNull();

        server.rollbackUndeliveredSync(SPACE, sessionId, {
          ...built!,
          effect: {
            ...built!.effect,
            upserts: [{ ...upsert, id: "of:private", scope: "user" }, upsert],
          },
        });

        const resent = await sync(sessionId, "of:doc", "of:private");
        expect(idsOf(resent?.effect.upserts)).toEqual(["of:doc"]);
      });

      it("skips a removal in a scope the session cannot resolve, and sends one in the space scope again", async () => {
        await write("of:doc", { n: 1 });
        const sessionId = await watching(plain("of:doc"));
        const frame = (
          removes: SessionEffectMessage["effect"]["removes"],
        ): SessionEffectMessage => ({
          type: "session/effect",
          space: SPACE,
          sessionId,
          effect: { type: "sync", fromSeq: 0, toSeq: 1, upserts: [], removes },
        });

        server.rollbackUndeliveredSync(
          SPACE,
          sessionId,
          frame([{ branch: "", id: "of:private", scope: "user" }]),
        );
        expect(await sync(sessionId)).toBeNull();

        server.rollbackUndeliveredSync(
          SPACE,
          sessionId,
          frame([{ branch: "", id: "of:gone", scope: "space" }]),
        );
        expect(idsOf((await sync(sessionId))?.effect.removes)).toEqual([
          "of:gone",
        ]);
      });

      it("re-evaluates in full a session admitted foreign instances when the frame names a scoped instance", async () => {
        setServerExecutionConfig(true);
        try {
          await write("of:doc", { n: 1 });
          const opened = await request<SessionOpenResult>(peer, {
            type: "session.open",
            space: SPACE,
            session: {},
            invocation: {
              iss: SERVICE,
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
            },
          });
          const sessionId = opened.ok!.sessionId;
          peer.auth = opened.ok!.sessionOpen;
          // Naming an instance is what admits the session foreign ones.
          const watched = await request<WatchSetResult>(peer, {
            type: "session.watch.set",
            space: SPACE,
            sessionId,
            watches: [{
              id: "named",
              kind: "graph",
              query: {
                roots: [{
                  id: "of:doc",
                  entityScopeKey: "space",
                  selector: { path: [], schema: false },
                }],
              },
            }],
          });
          expect(watched.error).toBeUndefined();
          await write("of:doc", { n: 2 });
          const built = await sync(sessionId, "of:doc");
          const [upsert] = built!.effect.upserts;
          expect(upsert.id).toBe("of:doc");
          const lost = (scope: "space" | "user"): SessionEffectMessage => ({
            ...built!,
            effect: {
              ...built!.effect,
              upserts: [
                upsert,
                {
                  ...upsert,
                  id: "of:private",
                  scope,
                  scopeKey: scope === "space" ? "space" : `user:${SERVICE}`,
                },
              ],
            },
          });

          // A batch that dirtied nothing evaluates in full only when the
          // rollback forced it to.
          server.rollbackUndeliveredSync(SPACE, sessionId, lost("space"));
          expect(await sync(sessionId)).toBeNull();
          server.rollbackUndeliveredSync(SPACE, sessionId, lost("user"));
          expect(idsOf((await sync(sessionId))?.effect.upserts)).toEqual([
            "of:doc",
          ]);
        } finally {
          resetServerExecutionConfig();
        }
      });
    });
  });

  describe("syncSessionForConnection()", () => {
    it("returns `null` for an operation watcher whose detached session lapses while its frame is built", async () => {
      await write("of:text", { body: "a" });
      const sessionId = await watching({
        id: "text",
        kind: "operation",
        query: { id: "of:text", path: toValuePath(["body"]) },
      });
      await write("of:other", { n: 1 });
      expect(
        (await sync(sessionId, "of:other"))?.effect.operationFields?.map(
          (field) => field.watchId,
        ),
      ).toEqual(["text"]);
      await write("of:other", { n: 2 });
      peer.connection.close();

      // The engine open the frame awaits is when the detached session's
      // grace runs out.
      const now = Date.now();
      let lapse: Stub | undefined;
      server.accessForTestingOnly.engineOpener = (space, open) => {
        lapse ??= stub(Date, "now", () => now + 3_600_000);
        return open(space);
      };
      try {
        expect(await sync(sessionId, "of:other")).toBeNull();
        expect(lapse).toBeDefined();
      } finally {
        lapse?.restore();
      }
    });

    it("returns a full evaluation's frame carrying a crossing a watch's walk newly follows", async () => {
      await write("of:top", { next: null });
      const sessionId = await watching(following("of:top"));
      await write("of:top", { next: link(FAR_SPACE, "of:far") });

      const frame = await server.syncSessionForConnection(SPACE, sessionId);

      expect(idsOf(frame?.effect.upserts)).toEqual(["of:top"]);
      expect(frame?.effect.crossings).toMatchObject([
        { space: FAR_SPACE, id: "of:far", path: [] },
      ]);
      expect(await server.syncSessionForConnection(SPACE, sessionId))
        .toBeNull();
    });
  });

  describe("markSpaceDirty()", () => {
    it("delivers a writer its own write when the origin names no operation for the document, and elides it for a `set`", async () => {
      const sessionId = await watching(plain("of:doc"));
      const commit = async (localSeq: number) => {
        const written = await request<{ seq: number }>(peer, {
          type: "transact",
          space: SPACE,
          sessionId,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:doc",
              value: { value: localSeq },
            }],
          },
        });
        return written.ok!.seq;
      };
      const flushUpserts = async () => {
        peer.messages.length = 0;
        await server.flushSessions();
        return peer.messages.flatMap((message) =>
          message.type === "session/effect" ? idsOf(message.effect.upserts) : []
        );
      };

      const setSeq = await commit(1);
      server.markSpaceDirty(SPACE, [toDirtyKey("of:doc")], {
        sessionId,
        seq: setSeq,
        ops: new Map([[toDirtyKey("of:doc"), "set"]]),
      });
      expect(await flushUpserts()).toEqual([]);

      const unnamedSeq = await commit(2);
      server.markSpaceDirty(SPACE, [toDirtyKey("of:doc")], {
        sessionId,
        seq: unnamedSeq,
        ops: new Map(),
      });
      expect(await flushUpserts()).toEqual(["of:doc"]);
    });
  });
});
