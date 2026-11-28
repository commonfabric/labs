/**
 * Paths of the client that only an unusual server, or an unusual sequence of
 * calls, reaches: a refusal of a request no ordinary server refuses, a frame
 * the client did not negotiate or cannot use, a call made before anything it
 * acts on exists. Each case runs a real server behind a transport that can
 * rewrite a frame in either direction, answer a request itself, or hand the
 * client a frame of its own.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/api";
import {
  type FabricPlainObject,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { armTurn } from "@commonfabric/async/turn";
import { getLogger } from "@commonfabric/logger";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ServerMessage,
} from "../v2.ts";
import {
  type Client,
  connect,
  type PresenceEvent,
  type Transport,
} from "../v2/client.ts";
import type { PartLimits } from "../v2/message-parts.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

type Frame = FabricPlainObject;

/** `payload` decoded, as an object. */
const frameOf = (payload: string): Frame => {
  const frame = decodeMemoryBoundary(payload);
  if (!isFabricPlainObject(frame)) {
    throw new Error(`not a frame: ${payload}`);
  }
  return frame;
};

/**
 * A transport to `server` whose frames a case can rewrite or answer. A
 * rewrite returning `undefined` drops the frame.
 */
class ScriptedTransport implements Transport {
  /** Rewrites each frame the client sends before the server sees it. */
  outgoing: (frame: Frame) => Frame | undefined = (frame) => frame;

  /** Rewrites each frame the server sends before the client sees it. */
  incoming: (frame: Frame) => Frame | undefined = (frame) => frame;

  /** Every frame the client sent, as it sent them. */
  readonly sent: Frame[] = [];

  readonly messageLimits: PartLimits | undefined;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #waiters: { type: string; resolve: (frame: Frame) => void }[] = [];
  readonly #server: Server;

  constructor(server: Server, messageLimits?: PartLimits) {
    this.#server = server;
    this.messageLimits = messageLimits;
  }

  /** Resolves with the next frame of `type` the client sends. */
  nextSent(type: string): Promise<Frame> {
    return new Promise((resolve) => this.#waiters.push({ type, resolve }));
  }

  /** Hands the client `frame` as if the server had sent it. */
  deliver(frame: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(frame));
  }

  /** Answers the request `frame` with `error`, as a server refusing it. */
  refuse(frame: Frame, error: { name: string; message: string }): void {
    this.deliver({ type: "response", requestId: frame.requestId, error });
  }

  /** Drops the connection, as a socket closing does. */
  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  async send(payload: string): Promise<void> {
    const frame = frameOf(payload);
    this.sent.push(frame);
    const waiters = this.#waiters;
    this.#waiters = waiters.filter((waiter) => waiter.type !== frame.type);
    for (const waiter of waiters) {
      if (waiter.type === frame.type) waiter.resolve(frame);
    }
    const forwarded = this.outgoing(frame);
    if (forwarded === undefined) return;
    await this.#connect().receive(encodeMemoryBoundary(forwarded));
  }

  close(): Promise<void> {
    this.#connection?.close();
    this.#connection = null;
    return Promise.resolve();
  }

  reset(): void {
    this.#connection?.close();
    this.#connection = null;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  #connect(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      const connection = this.#server.connect((message: ServerMessage) => {
        if (this.#connection !== connection) return;
        const frame = this.incoming(frameOf(encodeMemoryBoundary(message)));
        if (frame !== undefined) this.deliver(frame);
      });
      this.#connection = connection;
    }
    return this.#connection;
  }
}

/** `frame` with its `hello.ok` flags changed by `flags`. */
const withHelloFlags = (frame: Frame, flags: Frame): Frame =>
  frame.type === "hello.ok"
    ? { ...frame, flags: { ...(frame.flags as Frame), ...flags } }
    : frame;

/** How many times the client has logged `connection-restart`. */
const connectionRestartsLogged = (): number =>
  getLogger("memory.v2.client").countsByKey["connection-restart"]?.warn ?? 0;

const ROOM = "room-0123456789abcdefghijklmnop";

describe("client", () => {
  const servers: Server[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  const serverFor = (name: string): Server => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://client-peer-faults-${name}`),
      subscriptionRefreshDelayMs: 0,
    });
    servers.push(server);
    return server;
  };

  const connected = async (transport: Transport): Promise<Client> => {
    const client = await connect({ transport });
    clients.push(client);
    return client;
  };

  const spaceFor = (name: string) => `did:key:z6Mk-client-peer-faults-${name}`;

  describe("frames it cannot use", () => {
    it("ignores a frame that is not an object, and stays connected", async () => {
      const transport = new ScriptedTransport(serverFor("not-an-object"));
      const client = await connected(transport);
      const restarts = connectionRestartsLogged();

      for (
        const frame of [null, 7, "session/revoked", [{ type: "response" }]]
      ) {
        transport.deliver(frame);
      }
      const session = await client.mount(
        spaceFor("not-an-object"),
        {},
        testSessionOpenAuthFactory,
      );

      expect(session.space).toBe(spaceFor("not-an-object"));
      expect(client.connectionState).toBe("connected");
      expect(connectionRestartsLogged()).toBe(restarts);
      expect(transport.sent.filter((frame) => frame.type === "hello"))
        .toHaveLength(1);
    });

    it("discards the connection on a sync part from a server that did not negotiate parts", async () => {
      const transport = new ScriptedTransport(serverFor("unnegotiated-part"));
      transport.incoming = (frame) =>
        withHelloFlags(frame, { syncPartsV1: false });
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("unnegotiated-part"),
        {},
        testSessionOpenAuthFactory,
      );
      const restarts = connectionRestartsLogged();
      const rehello = transport.nextSent("hello");

      transport.deliver({
        type: "session/effect",
        space: session.space,
        sessionId: session.sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
          more: true,
        },
      });
      await rehello;

      expect(connectionRestartsLogged()).toBe(restarts + 1);
    });
    it("discards the connection on a sync part that names no session", async () => {
      const transport = new ScriptedTransport(
        serverFor("part-without-session"),
      );
      const client = await connected(transport);
      await client.mount(
        spaceFor("part-without-session"),
        {},
        testSessionOpenAuthFactory,
      );
      const restarts = connectionRestartsLogged();
      const rehello = transport.nextSent("hello");

      transport.deliver({
        type: "session/effect",
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
          more: true,
        },
      });
      await rehello;

      expect(connectionRestartsLogged()).toBe(restarts + 1);
    });
  });

  describe("mountRedeeming()", () => {
    it("closes the session, and throws a `ProtocolError`, when the server opens it without redeeming the invitation", async () => {
      // The server is told nothing of the invitation, so it opens the session
      // as any other and returns no receipt.

      const transport = new ScriptedTransport(serverFor("no-receipt"));
      const opened: string[] = [];
      transport.incoming = (frame) => {
        const { ok } = frame;
        if (
          isFabricPlainObject(ok) && typeof ok.sessionToken === "string" &&
          typeof ok.sessionId === "string"
        ) {
          opened.push(ok.sessionId);
        }
        return withHelloFlags(frame, { spaceInvites: true });
      };
      transport.outgoing = (frame) => {
        if (frame.type !== "session.open") return frame;
        const { invite: _invite, ...session } = frame.session as Frame;
        return { ...frame, session };
      };
      const client = await connected(transport);
      const space = spaceFor("no-receipt");

      const failure = await client.mountRedeeming(
        space,
        { inviteId: "i".repeat(22), code: "c".repeat(43) },
        testSessionOpenAuthFactory,
      ).then(() => undefined, (error: Error) => error);

      expect(failure?.name).toBe("ProtocolError");
      expect(failure?.message).toBe(
        "memory server opened the session without redeeming its invitation",
      );
      const open = transport.sent.find((frame) =>
        frame.type === "session.open"
      );
      expect((open?.session as Frame | undefined)?.invite).toEqual({
        inviteId: "i".repeat(22),
        code: "c".repeat(43),
      });
      expect(opened).toHaveLength(1);
      expect(
        transport.sent.filter((frame) => frame.type === "session.close").map((
          frame,
        ) => [frame.space, frame.sessionId]),
      ).toEqual([[space, opened[0]]]);
    });
  });

  describe("mount()", () => {
    // A mount cancelled after its open was sent hands out no session, so the
    // client closes the one the server opens, if the server can close one.

    /** Mounts on a transport whose `hello.ok` says `sessionClose`, cancels
     * the mount as its open is sent, and returns the frames sent by the time
     * a later mount has completed. */
    const cancelledMount = async (sessionClose: boolean) => {
      const name = `cancelled-mount-${sessionClose}`;
      const transport = new ScriptedTransport(serverFor(name));
      transport.incoming = (frame) => withHelloFlags(frame, { sessionClose });
      const client = await connected(transport);
      const controller = new AbortController();
      const cancelled = new Error("mount cancelled for the test");
      transport.outgoing = (frame) => {
        if (frame.type === "session.open" && !controller.signal.aborted) {
          controller.abort(cancelled);
        }
        return frame;
      };

      const failure = await client.mount(
        spaceFor(name),
        {},
        testSessionOpenAuthFactory,
        controller.signal,
      ).then(() => undefined, (error: Error) => error);
      // The server answers in order, so the cancelled mount's open is
      // answered, and any close of its session sent, before this one ends.
      await client.mount(
        spaceFor(`${name}-after`),
        {},
        testSessionOpenAuthFactory,
      );

      expect(failure).toBe(cancelled);
      return transport.sent.map((frame) => frame.type);
    };

    it("sends `session.close` for the session a cancelled mount opened", async () => {
      expect(await cancelledMount(true)).toContain("session.close");
    });

    it("sends no `session.close` to a server that does not advertise `sessionClose`", async () => {
      const sent = await cancelledMount(false);
      expect(sent.filter((type) => type === "session.open")).toHaveLength(2);
      expect(sent).not.toContain("session.close");
    });

    /** Mounts on a transport whose `hello.ok` says `sessionClose`, and
     * cancels the mount with `reason` just as its open is answered: once the
     * wait for the answer has settled and stops listening for a
     * cancellation, before the mount reads the signal again. Returns what
     * the mount settled with and the frames sent by the time a later mount
     * has completed. */
    const mountCancelledAsAnswered = async (name: string, reason: unknown) => {
      const transport = new ScriptedTransport(serverFor(name));
      const controller = new AbortController();
      let answered = false;
      transport.incoming = (frame) => {
        if (isFabricPlainObject(frame.ok) && "sessionToken" in frame.ok) {
          answered = true;
        }
        return withHelloFlags(frame, { sessionClose: true });
      };
      const removeEventListener = controller.signal.removeEventListener.bind(
        controller.signal,
      );
      using _removed = stub(
        controller.signal,
        "removeEventListener",
        (type: string, listener: EventListenerOrEventListenerObject) => {
          removeEventListener(type, listener);
          if (answered && !controller.signal.aborted) {
            controller.abort(reason);
          }
        },
      );
      const client = await connected(transport);

      const outcome = await client.mount(
        spaceFor(name),
        {},
        testSessionOpenAuthFactory,
        controller.signal,
      ).then((session) => session, (error: unknown) => error);
      await client.mount(
        spaceFor(`${name}-after`),
        {},
        testSessionOpenAuthFactory,
      );

      expect(controller.signal.aborted).toBe(true);
      return { outcome, sent: transport.sent.map((frame) => frame.type) };
    };

    it("rejects a mount cancelled just as its open is answered with the caller's reason, and closes the session the open made", async () => {
      const reason = new Error("mount cancelled for the test");
      const { outcome, sent } = await mountCancelledAsAnswered(
        "cancelled-as-answered",
        reason,
      );

      expect(outcome).toBe(reason);
      expect(sent.filter((type) => type === "session.open")).toHaveLength(2);
      expect(sent.filter((type) => type === "session.close")).toHaveLength(1);
    });

    it("rejects a mount cancelled just as its open is answered with a reason that is not an error as cancelled", async () => {
      const { outcome } = await mountCancelledAsAnswered(
        "cancelled-as-answered-without-error",
        "the caller went away",
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({
        message: "memory session mount cancelled",
      });
    });
  });

  describe("a reconnect's restore", () => {
    it("replays a commit once, on the connection after one that drops just as the session reopens", async () => {
      const transport = new ScriptedTransport(serverFor("drop-as-reopened"));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("drop-as-reopened"),
        {},
        testSessionOpenAuthFactory,
      );
      const hellos = () =>
        transport.sent.filter((frame) => frame.type === "hello").length;
      // The commit's first send never reaches the server, so the commit is
      // still outstanding when the connection drops.
      transport.outgoing = (frame) =>
        frame.type === "transact" && hellos() === 1 ? undefined : frame;
      // The reopen on the second connection is answered, and that
      // connection drops in the same turn.
      transport.incoming = (frame) => {
        if (
          hellos() === 2 && isFabricPlainObject(frame.ok) &&
          "sessionToken" in frame.ok
        ) {
          transport.deliver(frame);
          transport.disconnect();
          return undefined;
        }
        return frame;
      };
      const committing = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:doc", value: { value: "A" } }],
      });
      await transport.nextSent("transact");
      transport.disconnect();

      expect((await committing).seq).toBe(1);
      // Closing the session waits for every send of a commit it has begun.
      await session.close();
      expect(hellos()).toBe(3);
      // The first send, and the replay on the third connection; the second
      // connection was gone before its replay could go out, and that replay
      // sends nothing on a later one.
      expect(transport.sent.filter((frame) => frame.type === "transact"))
        .toHaveLength(2);
    });
  });

  describe("close()", () => {
    it("hands the view no effect that arrived behind a watch response once the session has closed", async () => {
      const transport = new ScriptedTransport(serverFor("closed-behind"));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("closed-behind"),
        {},
        testSessionOpenAuthFactory,
      );
      const watch = (id: string) => ({
        id,
        kind: "graph" as const,
        query: {
          roots: [{ id: `of:${id}`, selector: { path: [], schema: false } }],
        },
      });
      const view = await session.watchSet([watch("first")]);
      const syncs = view.subscribeSync();
      const seen: string[] = [];
      const consumed = (async () => {
        for (;;) {
          const next = await syncs.next();
          if (next.done) return;
          for (const upsert of next.value.upserts) seen.push(upsert.id);
        }
      })();
      const effect = (id: string) => ({
        type: "session/effect",
        space: session.space,
        sessionId: session.sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [{ branch: "", id, seq: 0, doc: { value: id } }],
          removes: [],
        },
      });
      transport.deliver(effect("of:while-open"));

      // The close waits for the commit it has begun, whose answer is held
      // until the end, so the view is still open while the effect that
      // arrived behind the watch response is handled.
      let commit: unknown;
      const commitAnswer = Promise.withResolvers<Frame>();
      let watchAdd: unknown;
      transport.outgoing = (frame) => {
        if (frame.type === "transact") commit = frame.requestId;
        if (frame.type === "session.watch.add") watchAdd = frame.requestId;
        return frame;
      };
      let closing: Promise<void> | undefined;
      transport.incoming = (frame) => {
        if (frame.type !== "response") return frame;
        if (frame.requestId === commit) {
          commitAnswer.resolve(frame);
          return undefined;
        }
        if (frame.requestId === watchAdd) {
          transport.deliver(frame);
          transport.deliver(effect("of:behind-the-response"));
          closing = session.close();
          return undefined;
        }
        return frame;
      };
      const committing = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:doc", value: { value: "A" } }],
      }).catch(() => undefined);
      await transport.nextSent("transact");
      await session.watchAdd([watch("second")]).catch(() => undefined);
      expect(closing).toBeDefined();
      transport.deliver(await commitAnswer.promise);
      await closing;
      await committing;
      await consumed;

      expect(seen).toContain("of:while-open");
      expect(seen).not.toContain("of:behind-the-response");
    });
  });

  describe("a restore after a frame the client could not read", () => {
    it("ends a session whose view holds a scope instance, and restores one whose view holds none", async () => {
      const transport = new ScriptedTransport(serverFor("scoped-instance"));
      transport.incoming = (frame) =>
        withHelloFlags(frame, { syncPartsV1: false });
      const client = await connected(transport);
      const scoped = await client.mount(
        spaceFor("scoped-instance"),
        {},
        testSessionOpenAuthFactory,
      );
      const plain = await client.mount(
        spaceFor("scoped-instance-plain"),
        {},
        testSessionOpenAuthFactory,
      );
      // A holding names no scope instance, so what the scoped session's
      // view holds cannot be declared as the reconnect's delivery base.
      transport.deliver({
        type: "session/effect",
        space: scoped.space,
        sessionId: scoped.sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [{
            branch: "",
            id: "of:scoped-instance",
            scope: "user",
            scopeKey: "user:did%3Akey%3Aalice",
            seq: 0,
            doc: { value: { who: "alice" } },
          }],
          removes: [],
        },
      });
      const rehello = transport.nextSent("hello");
      // A sync part from a server that did not negotiate parts is a frame
      // the client cannot read.
      transport.deliver({
        type: "session/effect",
        space: plain.space,
        sessionId: plain.sessionId,
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
          more: true,
        },
      });
      await rehello;
      await client.restoreConnection();

      expect(scoped.closeError?.name).toBe("InvalidMessageError");
      expect(plain.closeError).toBeUndefined();
      await plain.whenRestored();
    });
  });

  describe("a session restored between connections", () => {
    // A commit outstanding across a drop is replayed on the next connection,
    // which drops as soon as the replay is answered. The restore completes
    // with the client between connections, and the handshake after that
    // waits for `greet()`.
    const restoredBetweenConnections = async (name: string) => {
      const transport = new ScriptedTransport(serverFor(name));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor(name),
        {},
        testSessionOpenAuthFactory,
      );
      const hellos = () =>
        transport.sent.filter((frame) => frame.type === "hello").length;
      let replay: unknown;
      const greeting = Promise.withResolvers<Frame>();
      transport.outgoing = (frame) => {
        if (frame.type !== "transact") return frame;
        if (hellos() === 1) return undefined;
        if (hellos() === 2) replay = frame.requestId;
        return frame;
      };
      transport.incoming = (frame) => {
        if (
          hellos() === 2 && frame.type === "response" &&
          frame.requestId === replay
        ) {
          transport.deliver(frame);
          transport.disconnect();
          return undefined;
        }
        if (hellos() === 3 && frame.type === "hello.ok") {
          greeting.resolve(frame);
          return undefined;
        }
        return frame;
      };
      const committed = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:doc", value: { value: "A" } }],
      });
      await transport.nextSent("transact");
      transport.disconnect();
      await session.whenRestored();

      expect((await committed).seq).toBe(1);
      expect(client.isConnected()).toBe(false);
      return {
        session,
        greet: async () => transport.deliver(await greeting.promise),
      };
    };

    it("sends a watch made then once the next connection has restored the session", async () => {
      const { session, greet } = await restoredBetweenConnections(
        "watch-between",
      );

      const watching = session.watchSet([{
        id: "doc",
        kind: "graph",
        query: {
          roots: [{ id: "of:doc", selector: { path: [], schema: false } }],
        },
      }]);
      // The greeting comes on a later turn of the event loop, which a watch
      // that went round and round instead of waiting would never let come.
      await new Promise<void>((resolve) => armTurn(resolve));
      await greet();

      expect((await watching).entities.map((entity) => entity.id))
        .toEqual(["of:doc"]);
    });

    it("rejects a query made then with the session's close when the session closes before the next connection", async () => {
      const { session, greet } = await restoredBetweenConnections(
        "query-between",
      );

      const querying = session.queryGraph({ roots: [] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await session.close();
      await greet();

      expect(session.closeError).toBeInstanceOf(Error);
      expect(await querying).toBe(session.closeError);
    });
  });

  describe("restartConnection()", () => {
    it("discards a connected client's connection and handshakes again, and leaves a closed client alone", async () => {
      const transport = new ScriptedTransport(serverFor("restart"));
      const client = await connected(transport);
      const restarts = connectionRestartsLogged();
      const rehello = transport.nextSent("hello");

      client.restartConnection(new Error("restarted for the test"));
      await rehello;
      expect(connectionRestartsLogged()).toBe(restarts + 1);

      await client.close();
      client.restartConnection(new Error("restarted after the close"));

      expect(connectionRestartsLogged()).toBe(restarts + 1);
      expect(client.connectionState).toBe("closed");
      expect(transport.sent.filter((frame) => frame.type === "hello"))
        .toHaveLength(2);
    });
  });

  describe("watchRemoveSync()", () => {
    it("returns an empty view for a session that has watched nothing", async () => {
      const transport = new ScriptedTransport(serverFor("remove-unwatched"));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("remove-unwatched"),
        {},
        testSessionOpenAuthFactory,
      );

      const result = await session.watchRemoveSync(["never-added"]);

      expect(result.view.entities).toEqual([]);
      expect(
        transport.sent.filter((frame) => frame.type === "session.watch.remove"),
      )
        .toHaveLength(1);
    });
  });

  describe("watchSet()", () => {
    it("rejects with the first refusal of a staged part, and applies none of the set", async () => {
      const server = serverFor("refused-part");
      const transport = new ScriptedTransport(server, {
        bytes: 2048,
        values: 400,
      });
      let refused: Frame | undefined;
      transport.outgoing = (frame) => {
        if (frame.type !== "session.watch.set" || frame.part !== 1) {
          return frame;
        }
        refused = frame;
        transport.refuse(frame, {
          name: "ProtocolError",
          message: "refused for the test",
        });
        return undefined;
      };
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("refused-part"),
        {},
        testSessionOpenAuthFactory,
      );

      const failure = await session.watchSet(
        Array.from({ length: 24 }, (_, index) => ({
          id: `watch-${index}`,
          kind: "graph" as const,
          query: {
            roots: [{
              id: `of:refused-part-${index}-${"x".repeat(100)}`,
              selector: { path: [], schema: false },
            }],
          },
        })),
      ).then(() => undefined, (error: Error) => error);

      expect(refused).toBeDefined();
      expect(failure?.message).toBe("refused for the test");
    });
  });

  describe("request()", () => {
    it("settles the request, and logs the error, when the caller's `onResponse` throws", async () => {
      const transport = new ScriptedTransport(serverFor("observer-throws"));
      transport.outgoing = (frame) => {
        if (frame.type !== "graph.query") return frame;
        transport.refuse(frame, {
          name: "QueryError",
          message: "refused for the test",
        });
        return undefined;
      };
      const client = await connected(transport);
      const observerError = new Error("observer failed");
      const logged = stub(console, "error");
      try {
        const request = client.request(
          { type: "graph.query", requestId: "observed" },
          {
            onResponse: () => {
              throw observerError;
            },
          },
        );

        await expect(request).rejects.toThrow("refused for the test");
        expect(logged.calls.map((call) => call.args)).toEqual([
          ["request response observer threw:", observerError],
        ]);
      } finally {
        logged.restore();
      }
      expect(client.connectionState).toBe("connected");
    });
  });

  describe("sendReport()", () => {
    it("resolves when the server refuses the report", async () => {
      const transport = new ScriptedTransport(serverFor("refused-report"));
      transport.outgoing = (frame) => {
        if (frame.type !== "session.report") return frame;
        transport.refuse(frame, {
          name: "InvalidMessageError",
          message: "refused for the test",
        });
        return undefined;
      };
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("refused-report"),
        {},
        testSessionOpenAuthFactory,
      );

      await session.sendReport({
        kind: "echo-breaker",
        event: "trip",
        document: { id: "of:fid1:shared", scopeKey: "space" },
        action: "cf:module/abc:__cfLift_1:xyz",
      });

      expect(transport.sent.filter((frame) => frame.type === "session.report"))
        .toHaveLength(1);
      expect(session.closeError).toBeUndefined();
    });
  });

  describe("joinPresenceRoom()", () => {
    it("reports an observer that throws, and still tells the room's other observers", async () => {
      const transport = new ScriptedTransport(serverFor("throwing-observer"));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("throwing-observer"),
        {},
        testSessionOpenAuthFactory,
      );
      const reported: unknown[][] = [];
      using _error = stub(console, "error", (...args: unknown[]) => {
        reported.push(args);
      });
      const thrown = new Error("observer failed");
      const events: PresenceEvent[] = [];

      await session.joinPresenceRoom(ROOM, () => {
        throw thrown;
      });
      await session.joinPresenceRoom(ROOM, (event) => events.push(event));

      expect(reported).toEqual([["presence observer threw:", thrown]]);
      expect(events.map((event) => event.kind)).toEqual(["snapshot"]);
    });

    it("tells the room's observers of a rejoin the server refuses after a reconnect", async () => {
      const transport = new ScriptedTransport(serverFor("refused-rejoin"));
      const client = await connected(transport);
      const session = await client.mount(
        spaceFor("refused-rejoin"),
        {},
        testSessionOpenAuthFactory,
      );
      const events: PresenceEvent[] = [];
      const failed = Promise.withResolvers<PresenceEvent>();
      await session.joinPresenceRoom(ROOM, (event) => {
        events.push(event);
        if (event.kind === "failure") failed.resolve(event);
      });
      transport.outgoing = (frame) => {
        if (frame.type !== "presence.join") return frame;
        transport.refuse(frame, {
          name: "PresenceError",
          message: "Presence room is full",
        });
        return undefined;
      };

      transport.disconnect();
      const failure = await failed.promise;

      expect(failure).toMatchObject({
        kind: "failure",
        error: { name: "PresenceError", message: "Presence room is full" },
      });
      expect(events.map((event) => event.kind)).toEqual([
        "snapshot",
        "failure",
      ]);
    });
  });
});
