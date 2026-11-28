import { expect } from "@std/expect";

import type { FabricPlainObject } from "@commonfabric/api";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  type GraphQueryResult,
  resetServerExecutionConfig,
  resolveScopeKey,
  type SessionSync,
  setServerExecutionConfig,
  type WatchAddResult,
  type WatchSetResult,
} from "../v2.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";

const SPACE = "did:key:z6Mk-instance-partitions-space";
const SERVICE = "did:key:z6Mk-instance-partitions-service";
const ALICE = "did:key:z6Mk-instance-partitions-alice";
const ALICE_USER = resolveScopeKey("user", { principal: ALICE });
const SERVICE_USER = resolveScopeKey("user", { principal: SERVICE });

/** A link to the document `id` in `scope`. */
const link = (id: string, scope: "space" | "user" | "session") => ({
  "/": { "link@1": { id, path: [], space: SPACE, scope } },
});

/** Selector reaching what `of:root` links to. */
const rootSelector = {
  path: [],
  schema: {
    type: "object",
    properties: {
      child: { type: "object" },
      shared: { type: "object" },
      draft: { type: "object" },
    },
  },
};

/** Watch root naming Alice's instance of the user-scoped `of:root`. */
const aliceRoot = {
  id: "of:root",
  scope: "user",
  entityScopeKey: ALICE_USER,
  selector: rootSelector,
};

/** Watch root naming Alice's instance of the user-scoped `of:second`. */
const aliceSecond = { ...aliceRoot, id: "of:second" };

/** Watch root of the session's own, reaching `of:shared` from `of:hub`. */
const hubRoot = {
  id: "of:hub",
  selector: {
    path: [],
    schema: { type: "object", properties: { shared: { type: "object" } } },
  },
};

/** The instance and id of each document `entries` names, sorted. */
const keysOf = (
  entries: readonly { id: string; scopeKey?: string }[],
): string[] =>
  entries.map((entry) => `${entry.scopeKey}/${entry.id}`).toSorted();

describe("Server", () => {
  // Alice holds a user-scoped `of:root` linking to her user-scoped
  // `of:child`, to the space-scoped `of:shared`, and to her session-scoped
  // `of:draft`, and a user-scoped `of:second` linking to her user-scoped
  // `of:late`. The space-scoped `of:hub` links to `of:shared` as well. The
  // service holds a user-scoped `of:child` of its own. The service's session
  // serves the space, so it may name Alice's instances.

  let server: Server;
  let alice: WirePeer;
  let aliceSession: string;
  let service: WirePeer;
  let serviceSession: string;

  /** Commits `operations` as `sessionId`, which is `peer`'s session. */
  const write = async (
    peer: WirePeer,
    sessionId: string,
    localSeq: number,
    operations: readonly FabricPlainObject[],
  ): Promise<void> => {
    const written = await request(peer, {
      type: "transact",
      space: SPACE,
      sessionId,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [...operations],
      },
    });
    expect(written.error).toBeUndefined();
  };

  /** Replaces the serving session's watches with one per root of `roots`. */
  const watch = async (
    roots: readonly FabricPlainObject[],
  ): Promise<SessionSync> => {
    const set = await request<WatchSetResult>(service, {
      type: "session.watch.set",
      space: SPACE,
      sessionId: serviceSession,
      watches: roots.map((root, index) => ({
        id: `w${index}`,
        kind: "graph",
        query: { roots: [root] },
      })),
    });
    expect(set.error).toBeUndefined();
    return set.ok!.sync;
  };

  beforeEach(async () => {
    setServerExecutionConfig(true);
    server = new Server({
      store: new URL(`memory://instance-partitions-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: {
        audience: "did:key:z6Mk-instance-partitions-audience",
      },
      acl: { mode: "off", delegatingDids: [SERVICE] },
    });
    alice = await connectPeer(server);
    ({ sessionId: aliceSession } = await openSession(alice, SPACE, {}, ALICE));
    service = await connectPeer(server, { inProcess: true });
    ({ sessionId: serviceSession } = await openSession(
      service,
      SPACE,
      {},
      SERVICE,
    ));
    const engine = await server.engineForSpace(SPACE);
    engine.executionLeases.acquire(SPACE, executionLeaseHolder(SERVICE));

    await write(alice, aliceSession, 1, [
      {
        op: "set",
        id: "of:root",
        scope: "user",
        value: {
          value: {
            child: link("of:child", "user"),
            shared: link("of:shared", "space"),
            draft: link("of:draft", "session"),
          },
        },
      },
      {
        op: "set",
        id: "of:child",
        scope: "user",
        value: { value: { owner: "alice" } },
      },
      {
        op: "set",
        id: "of:draft",
        scope: "session",
        value: { value: { owner: "alice" } },
      },
      {
        op: "set",
        id: "of:second",
        scope: "user",
        value: { value: { child: link("of:late", "user") } },
      },
      {
        op: "set",
        id: "of:late",
        scope: "user",
        value: { value: { owner: "alice" } },
      },
      { op: "set", id: "of:shared", value: { value: { name: "shared" } } },
      {
        op: "set",
        id: "of:hub",
        value: { value: { shared: link("of:shared", "space") } },
      },
    ]);
    await write(service, serviceSession, 1, [{
      op: "set",
      id: "of:child",
      scope: "user",
      value: { value: { owner: "service" } },
    }]);
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    await server.close();
  });

  describe("a watch whose root names another user's instance", () => {
    it("delivers that user's instance of a user-scoped document the root links to", async () => {
      const sync = await watch([aliceRoot]);

      expect(keysOf(sync.upserts)).toEqual([
        `space/of:shared`,
        `${ALICE_USER}/of:child`,
        `${ALICE_USER}/of:root`,
      ].toSorted());
      expect(
        sync.upserts.find((upsert) => upsert.id === "of:child")?.doc,
      ).toEqual({ value: { owner: "alice" } });
    });

    it("delivers the session's own instance for a root naming none", async () => {
      const sync = await watch([aliceRoot, {
        id: "of:child",
        scope: "user",
        selector: { path: [], schema: true },
      }]);

      expect(
        sync.upserts.filter((upsert) => upsert.id === "of:child").map((
          upsert,
        ) => [upsert.scopeKey, upsert.doc]).toSorted(),
      ).toEqual([
        [ALICE_USER, { value: { owner: "alice" } }],
        [SERVICE_USER, { value: { owner: "service" } }],
      ].toSorted());
    });

    it("delivers what the session's own instance of the same document reaches", async () => {
      // The service's own `of:root` links to `of:only`, which nothing else
      // reaches, and is watched under the selector Alice's instance is.

      await write(service, serviceSession, 2, [
        {
          op: "set",
          id: "of:root",
          scope: "user",
          value: { value: { child: link("of:only", "space") } },
        },
        { op: "set", id: "of:only", value: { value: { name: "only" } } },
      ]);

      const sync = await watch([aliceRoot, {
        id: "of:root",
        scope: "user",
        selector: rootSelector,
      }]);

      expect(keysOf(sync.upserts)).toEqual([
        `space/of:only`,
        `space/of:shared`,
        `${ALICE_USER}/of:child`,
        `${ALICE_USER}/of:root`,
        `${SERVICE_USER}/of:root`,
      ].toSorted());
    });

    it("delivers no session-scoped document the root links to", async () => {
      // A `user` instance names a principal and no session, so the walk
      // from it resolves no instance of `of:draft`.

      const sync = await watch([aliceRoot]);

      expect(sync.upserts.filter((upsert) => upsert.id === "of:draft"))
        .toEqual([]);
    });

    it("delivers a write to that user's instance of a linked document", async () => {
      await watch([aliceRoot]);
      service.messages.length = 0;

      await write(alice, aliceSession, 2, [{
        op: "set",
        id: "of:child",
        scope: "user",
        value: { value: { owner: "alice, later" } },
      }]);
      await server.flushSessions();

      const upserts = service.messages.flatMap((message) =>
        message.type === "session/effect"
          ? (message.effect as SessionSync).upserts
          : []
      );
      expect(upserts.map((upsert) => [upsert.id, upsert.scopeKey, upsert.doc]))
        .toEqual([
          ["of:child", ALICE_USER, { value: { owner: "alice, later" } }],
        ]);
    });

    it("delivers that user's instance of a linked document for a root added to an instance already watched", async () => {
      await watch([aliceRoot]);

      const added = await request<WatchAddResult>(service, {
        type: "session.watch.add",
        space: SPACE,
        sessionId: serviceSession,
        watches: [{
          id: "added",
          kind: "graph",
          query: { roots: [aliceSecond] },
        }],
      });

      expect(added.error).toBeUndefined();
      expect(keysOf(added.ok!.sync.upserts)).toEqual([
        `${ALICE_USER}/of:late`,
        `${ALICE_USER}/of:second`,
      ]);
    });

    it("retracts what one of that user's roots alone reaches when its watch is removed", async () => {
      await watch([aliceRoot, aliceSecond]);

      const removed = await request<WatchSetResult>(service, {
        type: "session.watch.remove",
        space: SPACE,
        sessionId: serviceSession,
        watchIds: ["w1"],
      });

      expect(removed.error).toBeUndefined();
      expect(keysOf(removed.ok!.sync.removes)).toEqual([
        `${ALICE_USER}/of:late`,
        `${ALICE_USER}/of:second`,
      ]);
    });

    it("keeps a document that user's root reaches when a watch of the session's own is removed", async () => {
      // `of:shared` is reached from `of:hub`, which the session watches as
      // itself, and from Alice's `of:root`.

      await watch([aliceRoot, hubRoot]);

      const removed = await request<WatchSetResult>(service, {
        type: "session.watch.remove",
        space: SPACE,
        sessionId: serviceSession,
        watchIds: ["w1"],
      });

      expect(removed.error).toBeUndefined();
      expect(keysOf(removed.ok!.sync.removes)).toEqual([`space/of:hub`]);
    });

    it("keeps a document another of the session's roots reaches when the watch is removed", async () => {
      // `of:shared` is reached from Alice's `of:root` and from `of:hub`,
      // which the session watches as itself.

      await watch([aliceRoot, hubRoot]);

      const removed = await request<WatchSetResult>(service, {
        type: "session.watch.remove",
        space: SPACE,
        sessionId: serviceSession,
        watchIds: ["w0"],
      });

      expect(removed.error).toBeUndefined();
      expect(keysOf(removed.ok!.sync.removes)).toEqual([
        `${ALICE_USER}/of:child`,
        `${ALICE_USER}/of:root`,
      ]);
    });
  });

  describe("a `graph.query` whose root names another user's instance", () => {
    it("returns that user's instance of a user-scoped document the root links to", async () => {
      const queried = await request<GraphQueryResult>(service, {
        type: "graph.query",
        space: SPACE,
        sessionId: serviceSession,
        query: { roots: [aliceRoot] },
      });

      expect(queried.error).toBeUndefined();
      expect(keysOf(queried.ok!.entities)).toEqual([
        `space/of:shared`,
        `${ALICE_USER}/of:child`,
        `${ALICE_USER}/of:root`,
      ].toSorted());
    });
  });
});
