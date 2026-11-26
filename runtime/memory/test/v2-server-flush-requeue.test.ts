import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { spy, stub } from "@std/testing/mock";

import type { FabricPlainObject } from "@commonfabric/api";
import { describe, it } from "@commonfabric/test-support/test";

import type {
  SessionEffectMessage,
  SessionOpenResult,
  WatchSetResult,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-flush-requeue";

/** Watches `id` from `sessionId`, expecting the watch to be admitted. */
const watch = async (peer: WirePeer, sessionId: string, id: string) => {
  const watched = await request<WatchSetResult>(peer, {
    type: "session.watch.set",
    space: SPACE,
    sessionId,
    watches: [{
      id,
      kind: "graph",
      query: { roots: [{ id, selector: { path: [], schema: false } }] },
    }],
  });
  expect(watched.error).toBeUndefined();
};

/** The ids each sync frame upserts, in the order `peers` were sent them. */
const takeUpserts = (peers: WirePeer[]): string[][] =>
  peers.map((peer) =>
    peer.messages.splice(0).flatMap((message) =>
      message.type === "session/effect"
        ? (message as SessionEffectMessage).effect.upserts.map((upsert) =>
          upsert.id
        )
        : []
    )
  );

/** Rejects the first fan-out through `peer`'s connection. */
const failFirstFanOut = (peer: WirePeer) => {
  const original = peer.connection.refreshDirty.bind(peer.connection);
  let calls = 0;
  return stub(peer.connection, "refreshDirty", (...args) => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("synthetic fan-out failure"))
      : original(...args);
  });
};

describe("Server", () => {
  describe("idle()", () => {
    it("runs no flush once a completed flush left nothing pending, and runs one for a dirty space", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://flush-requeue-${crypto.randomUUID()}`),
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        const peer = await connectPeer(server);
        await openSession(peer, SPACE);
        await server.writeDocument(SPACE, "of:flush-idle", { n: 1 });
        await server.flushSessions();
        const flushes = spy(server, "flushSessions");
        try {
          await server.idle();
          expect(flushes.calls.length).toBe(0);

          await server.writeDocument(SPACE, "of:flush-idle", { n: 2 });
          await server.idle();
          expect(flushes.calls.length).toBe(1);
        } finally {
          flushes.restore();
        }
      } finally {
        await server.close();
      }
    });
  });

  describe("flushSessions()", () => {
    it("requeues a failed batch's derived classification, so the next flush still splits prioritized sessions from followers", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://flush-requeue-${crypto.randomUUID()}`),
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        // The bulk session registers first, so a single-pass fan-out would
        // send its frame first.
        const bulk = await connectPeer(server);
        const derived = await connectPeer(server);
        await watch(
          bulk,
          (await openSession(bulk, SPACE)).sessionId,
          "of:bulk",
        );
        await watch(
          derived,
          (await openSession(derived, SPACE)).sessionId,
          "of:derived",
        );
        await server.writeDocument(SPACE, "of:bulk", { round: 1 });
        await server.writeDocument(SPACE, "of:derived", { round: 1 });
        await server.flushSessions();
        takeUpserts([bulk, derived]);

        await server.writeDocument(SPACE, "of:bulk", { round: 2 });
        await server.writeDocument(SPACE, "of:derived", { round: 2 });
        server.noteExecutorCommit({
          space: SPACE,
          seq: 999,
          class: "derived",
          sessionId: "loopback:test",
          writes: [{ id: "of:derived", scopeKey: "space" }],
        });
        const failing = failFirstFanOut(derived);
        try {
          await expect(server.flushSessions()).rejects.toThrow(
            "synthetic fan-out failure",
          );
          expect(takeUpserts([bulk, derived])).toEqual([[], []]);
          const before = server.pushPriorityStats().mixedFlushes;

          await server.flushSessions();

          expect(server.pushPriorityStats().mixedFlushes).toBe(before + 1);
          expect(takeUpserts([bulk, derived])).toEqual([
            ["of:bulk"],
            ["of:derived"],
          ]);
        } finally {
          failing.restore();
        }
      } finally {
        await server.close();
      }
    });

    it("requeues a failed batch's ACL change made elsewhere, so the next flush revokes the session it deauthorized", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "memory-flush-requeue-acl-",
      });
      const store = toFileUrl(`${directory}/`);
      const alice = "did:key:z6Mk-flush-requeue-alice";
      const bob = "did:key:z6Mk-flush-requeue-bob";
      const server = new Server({
        store,
        subscriptionRefreshDelayMs: "manual",
        authorizeSessionOpen: (message) =>
          typeof message.invocation?.iss === "string"
            ? message.invocation.iss
            : undefined,
        sessionOpenAuth: { audience: "did:key:z6Mk-flush-requeue-audience" },
        acl: { mode: "enforce" },
      });

      /** Opens a session on the space as `principal`. */
      const openAs = async (peer: WirePeer, principal: string) => {
        const opened = await request<SessionOpenResult>(peer, {
          type: "session.open",
          space: SPACE,
          session: {},
          invocation: {
            iss: principal,
            aud: peer.auth.audience,
            challenge: peer.auth.challenge.value,
          },
        });
        expect(opened.error).toBeUndefined();
        peer.auth = opened.ok!.sessionOpen;
        return opened.ok!.sessionId;
      };
      /** Commits `value` to `id` through `sessionId`. */
      const set = (
        peer: WirePeer,
        sessionId: string,
        localSeq: number,
        id: string,
        value: FabricPlainObject,
      ) =>
        request(peer, {
          type: "transact",
          space: SPACE,
          sessionId,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: { value } }],
          },
        });

      try {
        const owner = await connectPeer(server);
        const genesis = await set(
          owner,
          await openAs(owner, SPACE),
          1,
          `of:${SPACE}`,
          { [alice]: "OWNER", [bob]: "WRITE" },
        );
        expect(genesis.error).toBeUndefined();
        const bobPeer = await connectPeer(server);
        const bobSession = await openAs(bobPeer, bob);
        expect((await set(bobPeer, bobSession, 1, "of:bob", { n: 1 })).error)
          .toBeUndefined();

        // Another connection to the store revokes Bob, and his next write
        // is how this server finds out.
        const other = await Engine.open({
          url: resolveSpaceStoreUrl(store, SPACE),
        });
        try {
          Engine.applyCommit(other, {
            sessionId: "elsewhere",
            space: SPACE,
            commitClass: "system",
            commit: {
              localSeq: Engine.serverSeq(other) + 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${SPACE}`,
                value: { value: { [alice]: "OWNER" } },
              }],
            },
          });
        } finally {
          Engine.close(other);
        }
        expect(
          (await set(bobPeer, bobSession, 2, "of:bob", { n: 2 })).error?.name,
        ).toBe("AuthorizationError");
        bobPeer.messages.length = 0;

        // The flush's first engine open is the one that applies the ACL
        // change; failing it fails the batch before Bob is revoked.
        server.accessForTestingOnly.engineOpener = () => {
          server.accessForTestingOnly.engineOpener = undefined;
          return Promise.reject(new Error("synthetic engine failure"));
        };
        await expect(server.flushSessions()).rejects.toThrow(
          "synthetic engine failure",
        );
        expect(bobPeer.messages).toEqual([]);

        await server.flushSessions();

        expect(bobPeer.messages).toEqual([{
          type: "session/revoked",
          space: SPACE,
          sessionId: bobSession,
          reason: "unauthorized",
        }]);
      } finally {
        await server.close();
        await Deno.remove(directory, { recursive: true });
      }
    });
  });
});
