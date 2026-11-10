/**
 * Covers the memory client as one that is only ever connected or connecting:
 * what it is asked while connecting fails at once as never sent, what waits on
 * a connection fails as that connection drops, a request a dropped connection
 * never answered fails as one that may have landed, and an answer that arrived
 * decides. Nothing is sent again on the next connection.
 *
 * The transport these cases run on is the real server's, with controls for
 * the host going down (the connection drops and every redial fails), the host
 * coming back, and the server's answers, or some of them, being lost while it
 * still handles what it is sent. Each case waits on the client's own
 * notifications, a reconnect or a session restore, so nothing polls and
 * nothing sleeps.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricPlainObject } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/js-values/types";
import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import {
  connect,
  connectionError,
  isNotSentError,
  isUnacknowledgedError,
  type SessionOpenAuthFactory,
  type SessionPrincipal,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** A transport to `server` whose host can go down and come back, whose
 * answers, or only its answers to `session.open`, can be lost while the
 * server still handles each frame, and whose send of a frame can fail with
 * its connection. */
function hostTransport(server: Server) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let down = false;
  let losingAnswers = false;
  let losingOpenAnswers = false;
  const lostAnswers = new Set<unknown>();
  let losingAnswerTo: string | undefined;
  let awaited:
    | { type: string; handled: PromiseWithResolvers<void> }
    | undefined;
  type Held = { release: PromiseWithResolvers<void>; fails: boolean };
  let holding: (Held & { type: string }) | undefined;
  let failing: string | undefined;
  const held = new Set<Held>();
  const sent: FabricPlainObject[] = [];
  const reset = () => {
    connection?.close();
    connection = undefined;
    losingAnswers = false;
    losingOpenAnswers = false;
  };
  const transport = {
    async send(payload: string) {
      if (connection === undefined) {
        if (down) throw connectionError("test host is down");
        const opened = server.connect((message) => {
          if (connection !== opened || losingAnswers) return;
          if (
            message.type === "response" && lostAnswers.has(message.requestId)
          ) {
            return;
          }
          receiver(encodeMemoryBoundary(message));
        });
        connection = opened;
      }
      const decoded = decodeMemoryBoundary(payload);
      if (!isPlainObject(decoded)) throw new Error("Expected a request record");
      sent.push(decoded);
      if (failing !== undefined && decoded.type === failing) {
        // As the runner's WebSocket transport does when a write fails: it
        // reports the connection closed, then rejects the send.
        failing = undefined;
        const error = connectionError("test write failed");
        reset();
        closeReceiver(error);
        throw error;
      }
      if (losingOpenAnswers && decoded.type === "session.open") {
        lostAnswers.add(decoded.requestId);
      }
      if (losingAnswerTo !== undefined && decoded.type === losingAnswerTo) {
        losingAnswerTo = undefined;
        lostAnswers.add(decoded.requestId);
      }
      await connection.receive(payload);
      if (awaited !== undefined && decoded.type === awaited.type) {
        awaited.handled.resolve();
      }
      if (holding !== undefined && decoded.type === holding.type) {
        const { release, fails } = holding;
        holding = undefined;
        held.add({ release, fails });
        await release.promise;
      }
    },
    reset,
    close() {
      reset();
      return Promise.resolve();
    },
    setReceiver(next: (payload: string) => void) {
      receiver = next;
    },
    setCloseReceiver(next: (error?: Error) => void) {
      closeReceiver = next;
    },
  } satisfies Transport;
  const drop = () => {
    reset();
    closeReceiver(new Error("test connection dropped"));
    for (const { release, fails } of held) {
      if (fails) release.reject(connectionError("test write failed"));
      else release.resolve();
    }
    held.clear();
  };
  return {
    transport,
    /** The frames of `type` sent so far. */
    sentOfType(type: string) {
      return sent.filter((message) => message.type === type).length;
    },
    /** The ids of the watches each `session.watch.set` sent so far named. */
    watchSetsSent() {
      return sent.filter((message) => message.type === "session.watch.set")
        .map((message) =>
          Array.isArray(message.watches)
            ? message.watches.map((watch) =>
              isPlainObject(watch) ? watch.id : undefined
            )
            : undefined
        );
    },
    /** The `transact` frames sent for the commit `localSeq`. */
    transactsOf(localSeq: number) {
      return sent.filter((message) =>
        message.type === "transact" &&
        (message.commit as { localSeq?: number } | undefined)?.localSeq ===
          localSeq
      ).length;
    },
    /** Resolves once the server has handled the next frame of `type`. */
    whenHandled(type: string) {
      awaited = { type, handled: Promise.withResolvers<void>() };
      return awaited.handled.promise;
    },
    /** The connection drops, and every redial fails until `hostUp()`. */
    hostDown() {
      down = true;
      drop();
    },
    hostUp() {
      down = false;
    },
    /** What the server sends is lost until the connection drops. */
    loseAnswers() {
      losingAnswers = true;
    },
    /** The send of the next frame of `type` stays unsettled after the
     * server has handled it and its answer has arrived, until the connection
     * drops: the window in which an accepted commit is still outstanding.
     * The drop then settles it, or with `fails` rejects it with the
     * connection. */
    holdNextSendOf(type: string, fails = false) {
      holding = { type, release: Promise.withResolvers<void>(), fails };
    },
    /** The server's answers to `session.open` are lost until the connection
     * drops, so a session sits restoring on a live connection. */
    loseOpenAnswers() {
      losingOpenAnswers = true;
    },
    /** The server's answer to the next frame of `type` is lost. */
    loseAnswerToNext(type: string) {
      losingAnswerTo = type;
    },
    /** The send of the next frame of `type` fails with its connection,
     * before the server sees it. */
    failNextSendOf(type: string) {
      failing = type;
    },
    drop,
  };
}

/** A watch of the whole document `id`, under that id. */
const watch = (id: string) => ({
  id,
  kind: "graph" as const,
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

const set = (localSeq: number, value: string) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{ op: "set" as const, id: "of:doc", value: { value } }],
});

async function connected(name: string) {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
  });
  const host = hostTransport(server);
  const client = await connect({ transport: host.transport });
  const session = await client.mount(
    `did:key:z6Mk-${name}`,
    {},
    testSessionOpenAuthFactory,
  );
  const reconnected = () => {
    const back = Promise.withResolvers<void>();
    const stop = client.subscribeReconnected(() => back.resolve());
    return back.promise.finally(stop);
  };
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { server, host, client, session, reconnected, close };
}

describe("client", () => {
  describe("connected or connecting", () => {
    it("rejects a commit made while the host is down at once with a never-sent `ConnectionError`, and the server never stores it", async () => {
      const t = await connected("fail-while-down");
      try {
        const first = await t.session.transact(set(1, "A"));
        t.host.hostDown();
        const error = await t.session.transact(set(2, "B")).catch((e) => e);
        expect(error.name).toBe("ConnectionError");
        expect(isNotSentError(error)).toBe(true);
        expect(isUnacknowledgedError(error)).toBe(false);

        const back = t.reconnected();
        t.host.hostUp();
        await back;
        await t.session.whenRestored();
        const third = await t.session.transact(set(3, "C"));
        expect(third.seq).toBe(first.seq + 1);
        expect(t.host.transactsOf(2)).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("rejects a mount made while the host is down at once with a never-sent `ConnectionError`", async () => {
      const t = await connected("fail-mount-while-down");
      try {
        t.host.hostDown();
        const error = await t.client.mount(
          "did:key:z6Mk-fail-mount-while-down-other",
          {},
          testSessionOpenAuthFactory,
        ).catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("rejects a watch made while the host is down at once with a never-sent `ConnectionError`", async () => {
      const t = await connected("fail-watch-while-down");
      try {
        t.host.hostDown();
        const error = await t.session.watchSet([{
          id: "root",
          kind: "graph",
          query: {
            roots: [{ id: "of:doc", selector: { path: [], schema: false } }],
          },
        }]).catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("rejects a commit its dropped connection never answered with an unacknowledged `ConnectionError`, and sends it no more", async () => {
      const t = await connected("fail-unanswered");
      try {
        const first = await t.session.transact(set(1, "A"));
        t.host.loseAnswers();
        const handled = t.host.whenHandled("transact");
        const pending = t.session.transact(set(2, "B"));
        pending.catch(() => {});
        await handled;
        const back = t.reconnected();
        t.host.drop();
        const error = await pending.catch((e) => e);
        expect(error.name).toBe("ConnectionError");
        expect(isUnacknowledgedError(error)).toBe(true);
        expect(isNotSentError(error)).toBe(false);

        // The server had stored it: the write landed, unacknowledged.
        await back;
        await t.session.whenRestored();
        const third = await t.session.transact(set(3, "C"));
        expect(third.seq).toBe(first.seq + 2);
        expect(t.host.transactsOf(2)).toBe(1);
      } finally {
        await t.close();
      }
    });
    it("rejects a commit its connection dropped before handing it over with a never-sent `ConnectionError`", async () => {
      const t = await connected("fail-before-handoff");
      try {
        const result = t.session.transact(set(1, "A")).catch((e) => e);
        t.host.hostDown();
        const error = await result;
        expect(t.host.transactsOf(1)).toBe(0);
        expect(isNotSentError(error)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("rejects a watch change its dropped connection never answered as unacknowledged, and one made while the host is down as never sent", async () => {
      const t = await connected("fail-queued-watch");
      try {
        t.host.loseAnswers();
        const handled = t.host.whenHandled("session.watch.set");
        const first = t.session.watchSet([watch("of:doc")]).catch((e) => e);
        await handled;
        t.host.hostDown();
        const second = t.session.watchSet([watch("of:other")]).catch((e) => e);

        expect(isUnacknowledgedError(await first)).toBe(true);
        expect(isNotSentError(await second)).toBe(true);

        // Neither is sent on the next connection: its restore sends the
        // watch set the client holds, which is still empty.
        const back = t.reconnected();
        t.host.hostUp();
        await back;
        await t.session.whenRestored();
        expect(t.host.watchSetsSent()).toEqual([["of:doc"], []]);
      } finally {
        await t.close();
      }
    });

    it("rejects a read made while the host is down at once with a never-sent `ConnectionError`", async () => {
      const t = await connected("fail-read-while-down");
      try {
        t.host.hostDown();
        const error = await t.session.queryGraph({ roots: [] }).catch((e) => e);
        expect(isNotSentError(error)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("rejects a commit still queued for its session's restore when the connection drops with a never-sent `ConnectionError`", async () => {
      const t = await connected("fail-queued-commit");
      try {
        const opening = t.host.whenHandled("session.open");
        t.host.drop();
        t.host.loseOpenAnswers();
        await opening;
        const queued = t.session.transact(set(1, "A")).catch((e) => e);

        t.host.drop();
        expect(isNotSentError(await queued)).toBe(true);
        expect(t.host.transactsOf(1)).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("resolves a commit whose acceptance arrived before its connection dropped with that acceptance", async () => {
      const t = await connected("fail-accepted-commit");
      try {
        const first = await t.session.transact(set(1, "A"));
        t.host.holdNextSendOf("transact");
        const handled = t.host.whenHandled("transact");
        const accepted = t.session.transact(set(2, "B"));
        await handled;

        t.host.drop();
        await expect(accepted).resolves.toMatchObject({ seq: first.seq + 1 });
      } finally {
        await t.close();
      }
    });

    it("rejects a read waiting for its session to restore with a never-sent `ConnectionError` when that connection drops", async () => {
      const t = await connected("fail-restore-wait");
      try {
        // The next connection is up, and the session's reopen on it is never
        // answered.
        const opening = t.host.whenHandled("session.open");
        t.host.drop();
        t.host.loseOpenAnswers();
        await opening;
        expect(t.client.isConnected()).toBe(true);
        const read = t.session.queryGraph({ roots: [] }).catch((e) => e);

        const back = t.reconnected();
        t.host.drop();
        expect(isNotSentError(await read)).toBe(true);
        await back;
      } finally {
        await t.close();
      }
    });

    it("answers a read made as the next connection comes up once its session has reopened there", async () => {
      const t = await connected("fail-read-at-reconnect");
      try {
        // The read is made in the turn the client reports the next
        // connection live, before the reconnect reopens the session on it.
        t.host.drop();
        while (!t.client.isConnected()) await t.client.whenStateChanged();
        const read = t.session.queryGraph({ roots: [] });

        await expect(read).resolves.toBeDefined();
      } finally {
        await t.close();
      }
    });

    it("delivers a change to a document the client still watches after a watch change its dropped connection never answered, on a resumed session", async () => {
      const t = await connected("fail-watch-uncertain");
      const writerClient = await connect({
        transport: hostTransport(t.server).transport,
      });
      try {
        const view = await t.session.watchSet([
          watch("of:doc"),
          watch("of:sentinel"),
        ]);
        // A replacement watching the sentinel alone, which the server applies
        // and whose answer is lost.
        t.host.loseAnswers();
        const handled = t.host.whenHandled("session.watch.set");
        const replaced = t.session.watchSet([watch("of:sentinel")]).catch((
          e,
        ) => e);
        await handled;
        const back = t.reconnected();
        t.host.drop();
        expect(isUnacknowledgedError(await replaced)).toBe(true);
        await back;
        await t.session.whenRestored();

        // Another session writes both: the sentinel's change shows the
        // delivery arrived, and the client still watches the document.
        const writer = await writerClient.mount(
          "did:key:z6Mk-fail-watch-uncertain",
          {},
          testSessionOpenAuthFactory,
        );
        const updates = view.subscribeSync();
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: ["of:doc", "of:sentinel"].map((id) => ({
            op: "set" as const,
            id,
            value: { value: "B" },
          })),
        });
        const next = await updates.next();
        expect(
          next.done ? [] : next.value.upserts.map((upsert) => upsert.id).sort(),
        ).toEqual(["of:doc", "of:sentinel"]);
      } finally {
        await writerClient.close();
        await t.close();
      }
    });

    it("sends, on the next connection, the watch set an answered watch change queued behind an unanswered one leaves", async () => {
      const t = await connected("fail-watch-queued-answer");
      try {
        t.session.setConcurrentWatchRefresh(true);
        t.host.loseAnswerToNext("session.watch.set");
        const unanswered = t.session.watchSet([watch("of:doc")]).catch((e) =>
          e
        );
        const handled = t.host.whenHandled("session.watch.add");
        const added = t.session.watchAdd([watch("of:other")]);
        await handled;
        const back = t.reconnected();
        t.host.drop();
        expect(isUnacknowledgedError(await unanswered)).toBe(true);
        await added;
        await back;
        await t.session.whenRestored();

        expect(t.host.watchSetsSent().at(-1)).toEqual(["of:other"]);
      } finally {
        await t.close();
      }
    });

    it("rejects a mount whose connection drops while it is being signed with a never-sent `ConnectionError`, though the next connection is already up", async () => {
      const t = await connected("fail-mount-signing");
      try {
        const signing = Promise.withResolvers<void>();
        const signed = Promise.withResolvers<void>();
        const sign: SessionOpenAuthFactory = async (
          space,
          session,
          context,
        ) => {
          signing.resolve();
          await signed.promise;
          return await testSessionOpenAuthFactory(space, session, context);
        };
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-signing-other",
          {},
          sign,
        ).catch((e) => e);
        await signing.promise;
        const back = t.reconnected();
        t.host.drop();
        await back;
        signed.resolve();

        expect(isNotSentError(await mount)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("rejects a mount as its connection drops while its signer has not finished, before the next connection is back", async () => {
      const t = await connected("fail-mount-stalled");
      const signed = Promise.withResolvers<void>();
      try {
        const signing = Promise.withResolvers<void>();
        const sign: SessionOpenAuthFactory = async (
          space,
          session,
          context,
        ) => {
          signing.resolve();
          await signed.promise;
          return await testSessionOpenAuthFactory(space, session, context);
        };
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-stalled-other",
          {},
          sign,
        ).catch((e) => e);
        await signing.promise;
        const back = t.reconnected();
        t.host.drop();

        // The signer is still running; the mount has failed regardless.
        const first = await Promise.race([mount, back.then(() => "pending")]);
        expect(isNotSentError(first)).toBe(true);
      } finally {
        signed.resolve();
        await t.close();
      }
    });

    it("rejects a mount whose `session.open` its dropped connection never answered with an unacknowledged `ConnectionError`", async () => {
      const t = await connected("fail-mount-unanswered");
      try {
        t.host.loseOpenAnswers();
        const handled = t.host.whenHandled("session.open");
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-unanswered-other",
          {},
          testSessionOpenAuthFactory,
        ).catch((e) => e);
        await handled;
        t.host.drop();

        const error = await mount;
        expect(isUnacknowledgedError(error)).toBe(true);
        expect(isNotSentError(error)).toBe(false);
      } finally {
        await t.close();
      }
    });

    it("resolves a mount whose `session.open` was accepted before its connection dropped, though the send had not settled, with a session that works on the next connection", async () => {
      const t = await connected("fail-mount-answered");
      try {
        t.host.holdNextSendOf("session.open");
        const handled = t.host.whenHandled("session.open");
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-answered-other",
          {},
          testSessionOpenAuthFactory,
        ).catch((e) => e);
        await handled;
        const back = t.reconnected();
        t.host.drop();

        const session = await mount;
        expect(session.space).toBe("did:key:z6Mk-fail-mount-answered-other");
        await back;
        await session.whenRestored();
        const applied = await session.transact(set(1, "A"));
        expect(applied.seq).toBeGreaterThan(0);
      } finally {
        await t.close();
      }
    });

    it("resolves a mount whose `session.open` was accepted before its send failed with the connection", async () => {
      const t = await connected("fail-mount-answered-send-failed");
      try {
        t.host.holdNextSendOf("session.open", true);
        const handled = t.host.whenHandled("session.open");
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-answered-send-failed-other",
          {},
          testSessionOpenAuthFactory,
        ).catch((e) => e);
        await handled;
        t.host.drop();

        const session = await mount;
        expect(session.space).toBe(
          "did:key:z6Mk-fail-mount-answered-send-failed-other",
        );
      } finally {
        await t.close();
      }
    });

    it("rejects a mount whose `session.open` was refused before its connection dropped with that refusal, though the send had not settled", async () => {
      const t = await connected("fail-mount-refused");
      try {
        t.host.holdNextSendOf("session.open");
        const handled = t.host.whenHandled("session.open");
        const mount = t.client.mount(
          "did:key:z6Mk-fail-mount-refused-other",
          {},
          () => undefined,
        ).catch((e) => e);
        await handled;
        t.host.drop();

        const error = await mount;
        expect(error.name).toBe("AuthorizationError");
      } finally {
        await t.close();
      }
    });

    it("rejects a mount queued behind another's signing as never sent once their connection drops, though the next is up when its turn comes", async () => {
      const t = await connected("fail-mount-queued");
      try {
        const signing = Promise.withResolvers<void>();
        const signed = Promise.withResolvers<void>();
        const sign: SessionOpenAuthFactory = async (
          space,
          session,
          context,
        ) => {
          signing.resolve();
          await signed.promise;
          return await testSessionOpenAuthFactory(space, session, context);
        };
        const ahead = t.client.mount(
          "did:key:z6Mk-fail-mount-queued-ahead",
          {},
          sign,
        ).catch((e) => e);
        await signing.promise;
        // The second mount's proofs are asked for in the step that queues it
        // behind the first's signing.
        const queuing = Promise.withResolvers<void>();
        const behind: SessionPrincipal = {
          did: "did:key:z6Mk-fail-mount-queued-key",
          authorizeConnection: () => {
            throw new Error("this server verifies each session.open");
          },
          authorizeSessionOpen: testSessionOpenAuthFactory,
          proofs: () => {
            queuing.resolve();
            return undefined;
          },
        };
        const queued = t.client.mount(
          "did:key:z6Mk-fail-mount-queued-behind",
          {},
          behind,
        ).catch((e) => e);
        await queuing.promise;
        const back = t.reconnected();
        t.host.drop();
        await back;
        signed.resolve();

        expect(isNotSentError(await ahead)).toBe(true);
        expect(isNotSentError(await queued)).toBe(true);
      } finally {
        await t.close();
      }
    });

    it("fails a watch change queued behind an unanswered one when their connection drops, and the next restore completes", async () => {
      const t = await connected("watch-queued-single-flight");
      try {
        // Single-flight: the second change waits for the first, whose answer
        // is lost.
        t.host.loseAnswers();
        const handled = t.host.whenHandled("session.watch.set");
        const first = t.session.watchSet([watch("of:doc")]).catch((e) => e);
        const second = t.session.watchSet([watch("of:other")]).catch((e) => e);
        await handled;
        const back = t.reconnected();
        t.host.drop();

        expect(isUnacknowledgedError(await first)).toBe(true);
        expect(isNotSentError(await second)).toBe(true);
        await back;
        await t.session.whenRestored();
        expect(t.host.watchSetsSent()).toEqual([["of:doc"], []]);
      } finally {
        await t.close();
      }
    });

    it("rejects a commit waiting for its session's restore with the close error when the session closes, and sends it no more", async () => {
      const t = await connected("commit-waiting-close");
      try {
        // The next connection is up, and the session's reopen on it is never
        // answered.
        const opening = t.host.whenHandled("session.open");
        t.host.drop();
        t.host.loseOpenAnswers();
        await opening;
        const waiting = t.session.transact(set(1, "A")).catch((e) => e);

        await t.session.close();
        const error = await waiting;
        expect(error.message).toBe("memory session closed");
        expect(t.host.transactsOf(1)).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("rejects a read whose send fails with its connection with an unacknowledged `ConnectionError`", async () => {
      const t = await connected("fail-send-throws");
      try {
        t.host.failNextSendOf("graph.query");
        const error = await t.session.queryGraph({ roots: [] }).catch((e) => e);

        expect(error.name).toBe("ConnectionError");
        expect(isUnacknowledgedError(error)).toBe(true);
      } finally {
        await t.close();
      }
    });
  });
});
