/**
 * A request its connection lost fails carrying `readyToRetry()`, which says
 * when the request can be made again. These cases cover when that is, for a
 * session's requests and for a mount, and when it never is.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { FabricPlainObject } from "@commonfabric/api";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import {
  connect,
  connectionDeliveryOf,
  isNotSentError,
  isSessionReplacedError,
  isUnacknowledgedError,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { hostTransport } from "./support/host-transport.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** The `readyToRetry()` of `error`, a request's failure. */
const readinessOf = (error: unknown): () => Promise<void> =>
  (error as { readyToRetry: () => Promise<void> }).readyToRetry;

/** A commit that sets `of:doc`, under `localSeq`. */
const commit = (localSeq: number) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "set" as const,
    id: "of:doc",
    value: { value: localSeq },
  }],
});

/** A client of a real server whose host can go down, with one session. */
async function connected(name: string) {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://client-ready-to-retry-${name}`),
  });
  const host = hostTransport(server);
  const client = await connect({ transport: host.transport });
  const session = await client.mount(
    `did:key:z6Mk-client-ready-to-retry-${name}`,
    {},
    testSessionOpenAuthFactory,
  );
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { host, client, session, close };
}

/**
 * A scripted peer that opens a session as `session-A` the first time and as
 * `session-B` every time after, as a server that no longer holds the first
 * does. It answers every commit, except one it has been told to lose, at
 * which it drops the connection instead.
 */
function replacingPeer() {
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let opens = 0;
  let holding:
    | { seen: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  let losing = false;
  const transacts: { sessionId: string; localSeq: number }[] = [];
  const respond = (requestId: string, ok: FabricPlainObject) =>
    receiver(encodeMemoryBoundary({ type: "response", requestId, ok }));
  const drop = () => closeReceiver(new Error("test connection dropped"));
  const transport: Transport = {
    async send(payload) {
      const message = decodeMemoryBoundary(payload) as {
        type: string;
        requestId: string;
        sessionId: string;
        commit: { localSeq: number };
      };
      switch (message.type) {
        case "hello":
          receiver(encodeMemoryBoundary({
            type: "hello.ok",
            protocol: MEMORY_PROTOCOL,
            flags: getMemoryProtocolFlags(),
            sessionOpen: {
              audience: TEST_SESSION_OPEN_AUDIENCE,
              challenge: { value: "challenge:hello", expiresAt: 1_000_000 },
            },
          }));
          return;
        case "session.open": {
          const held = holding;
          holding = undefined;
          held?.seen.resolve();
          await held?.release.promise;
          respond(message.requestId, {
            sessionId: ++opens === 1 ? "session-A" : "session-B",
            serverSeq: 0,
            sessionOpen: {
              audience: TEST_SESSION_OPEN_AUDIENCE,
              challenge: {
                value: `challenge:${message.requestId}`,
                expiresAt: 1_000_000,
              },
            },
          });
          return;
        }
        case "transact":
          transacts.push({
            sessionId: message.sessionId,
            localSeq: message.commit.localSeq,
          });
          if (losing) {
            losing = false;
            drop();
            return;
          }
          respond(message.requestId, { seq: transacts.length });
          return;
        case "session.ack":
          respond(message.requestId, { serverSeq: 0 });
          return;
        default:
          throw new Error(`The test peer handles no ${message.type}`);
      }
    },
    close: () => Promise.resolve(),
    reset() {},
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
  return {
    transport,
    /** The session and `localSeq` of each commit sent so far, in order. */
    transacts,
    drop,
    /** Holds the answer to the next `session.open` until released. */
    holdNextOpen() {
      holding = {
        seen: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      return holding;
    },
    /** The connection drops at the next commit, which gets no answer. */
    loseNextCommit() {
      losing = true;
    },
  };
}

describe("client", () => {
  describe("readyToRetry", () => {
    it("resolves for a read made while the host is down once the session is open on the next connection, where the read is answered", async () => {
      const t = await connected("read-down");
      try {
        t.host.hostDown();
        const error = await t.session.queryGraph({ roots: [] }).catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
        t.host.hostUp();
        await readinessOf(error)();

        expect((await t.session.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("resolves for a read its connection dropped before answering once the session is open on the next connection", async () => {
      const t = await connected("read-lost");
      try {
        t.host.failNextSendOf("graph.query");
        const error = await t.session.queryGraph({ roots: [] }).catch((e) => e);
        expect(isUnacknowledgedError(error)).toBe(true);
        await readinessOf(error)();

        expect(t.client.isConnected()).toBe(true);
        expect((await t.session.queryGraph({ roots: [] })).serverSeq).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("resolves for a mount made while the host is down once the client has connected again, where the mount is made", async () => {
      const t = await connected("mount-down");
      try {
        const space = "did:key:z6Mk-client-ready-to-retry-mount-down-second";
        t.host.hostDown();
        const error = await t.client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        )
          .catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
        t.host.hostUp();
        await readinessOf(error)();

        expect(t.client.isConnected()).toBe(true);
        const session = await t.client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        expect((await session.transact(commit(1))).seq).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("rejects for a mount with the reason its caller cancelled it with while the host was still down", async () => {
      const t = await connected("mount-cancelled");
      try {
        const cancel = new AbortController();
        t.host.hostDown();
        const error = await t.client.mount(
          "did:key:z6Mk-client-ready-to-retry-mount-cancelled-second",
          {},
          testSessionOpenAuthFactory,
          cancel.signal,
        ).catch((e) => e);
        const ready = readinessOf(error)();
        cancel.abort(new Error("test cancels the mount"));

        await expect(ready).rejects.toThrow("test cancels the mount");
      } finally {
        await t.close();
      }
    });

    it("rejects for a mount once the client has closed while the host was still down", async () => {
      const t = await connected("mount-closed");
      try {
        t.host.hostDown();
        const error = await t.client.mount(
          "did:key:z6Mk-client-ready-to-retry-mount-closed-second",
          {},
          testSessionOpenAuthFactory,
        ).catch((e) => e);
        const ready = readinessOf(error)();
        await t.client.close();

        await expect(ready).rejects.toThrow("memory client is closed");
      } finally {
        await t.close();
      }
    });

    it("resolves for a commit that was never sent once the server has opened a new session in place of the one it was made on", async () => {
      // Nothing of the commit reached the session that is gone, so the new
      // one judges it as the new commit it is.

      const peer = replacingPeer();
      const client = await connect({ transport: peer.transport });
      try {
        const session = await client.mount("did:key:z6Mk-never-sent-replaced");
        peer.drop();
        const error = await session.transact(commit(1)).catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
        await readinessOf(error)();

        expect(session.sessionId).toBe("session-B");
        expect((await session.transact(commit(1))).seq).toBe(1);
        expect(peer.transacts).toEqual([
          { sessionId: "session-B", localSeq: 1 },
        ]);
      } finally {
        await client.close();
      }
    });

    it("resolves for a commit sent, and not answered, on the session a restore it waited for opened, once that session is open on the next connection", async () => {
      // The commit is made on `session-A` and waits for a restore, which
      // opens `session-B`. It is sent there, so `session-B` is the session
      // whose record answers it when it is sent again.

      const peer = replacingPeer();
      const client = await connect({ transport: peer.transport });
      try {
        const session = await client.mount("did:key:z6Mk-sent-on-replacement");
        const reopening = peer.holdNextOpen();
        peer.drop();
        await reopening.seen.promise;
        const committing = session.transact(commit(1)).catch((e) => e);
        peer.loseNextCommit();
        reopening.release.resolve();
        const error = await committing;
        expect(isUnacknowledgedError(error)).toBe(true);
        await readinessOf(error)();

        expect((await session.transact(commit(1))).seq).toBe(2);
        expect(peer.transacts).toEqual([
          { sessionId: "session-B", localSeq: 1 },
          { sessionId: "session-B", localSeq: 1 },
        ]);
      } finally {
        await client.close();
      }
    });

    it("rejects for a commit sent and not answered once the server has opened a new session in place of the one it was sent on", async () => {
      const peer = replacingPeer();
      const client = await connect({ transport: peer.transport });
      try {
        const session = await client.mount("did:key:z6Mk-sent-then-replaced");
        peer.loseNextCommit();
        const error = await session.transact(commit(1)).catch((e) => e);
        expect(connectionDeliveryOf(error)).toBe("unacknowledged");

        const replaced = await readinessOf(error)().catch((e) => e);
        expect(isSessionReplacedError(replaced)).toBe(true);
        expect(peer.transacts).toEqual([
          { sessionId: "session-A", localSeq: 1 },
        ]);
      } finally {
        await client.close();
      }
    });
  });
});
