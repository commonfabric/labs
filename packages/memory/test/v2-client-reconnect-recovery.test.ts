import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricPlainObject } from "@commonfabric/api";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  toDocumentPath,
} from "../v2.ts";
import {
  connect,
  connectionError,
  loopback,
  type Transport,
  writeFailedError,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** A reconnectable transport using the real server's handshake and sessions. */
function reconnectableTransport(
  server: Server,
  options: {
    holdFirstTransact?: boolean;
    loseFirstTransact?: boolean;
    /** Refuses the writes of the commit `localSeq`, or else of each
     * `session.watch.add` naming the watch `watchId`. */
    refuseWritesOf?: { localSeq?: number; watchId?: string; cause: unknown };
    /** Resolve a send once the frame is handed over, as a socket does,
     * rather than once the server has handled it. */
    sendResolvesOnWrite?: boolean;
    malformedReopenError?: { name?: number; message: string };
    holdProbe?: boolean;
  } = {},
) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let connections = 0;
  const duplicateHello = Promise.withResolvers<string>();
  const resetCalled = Promise.withResolvers<void>();
  const transactSent = Promise.withResolvers<void>();
  let heldOnce = false;
  let holding = false;
  let lostOnce = false;
  let loseOpenResponse = false;
  let refusedWrites = 0;
  const inFlight = new Set<Promise<unknown>>();
  let refusedReopen = false;
  let corruptEffect: FabricPlainObject | undefined;
  let deliverDiscardedEffect = () => {};
  const probeSent = Promise.withResolvers<void>();
  const sent: Array<{ connection: number; message: FabricPlainObject }> = [];
  const reset = () => {
    connection?.close();
    connection = undefined;
    holding = false;
  };
  const transport = {
    async send(payload: string) {
      if (!connection) {
        connections++;
        const opened = server.connect((message) => {
          if (connection !== opened || holding) return;
          if (
            message.type === "session/effect" && corruptEffect !== undefined
          ) {
            const malformed = {
              ...message,
              effect: { ...message.effect, ...corruptEffect },
            };
            corruptEffect = undefined;
            deliverDiscardedEffect = () => {
              if (connection !== opened) return;
              receiver(encodeMemoryBoundary({
                ...message,
                effect: {
                  ...message.effect,
                  toSeq: 999,
                  upserts: [{
                    branch: "",
                    id: "of:watched",
                    seq: 999,
                    doc: { value: "stale frame" },
                  }],
                },
              }));
            };
            receiver(encodeMemoryBoundary(malformed));
            deliverDiscardedEffect();
            return;
          }
          const encoded = encodeMemoryBoundary(message);
          receiver(encoded);
          const response = decodeMemoryBoundary(encoded) as {
            error?: { message: string };
          };
          if (response.error?.message === "hello may only be sent once") {
            duplicateHello.resolve(response.error.message);
          }
        });
        connection = opened;
      }
      const decoded = decodeMemoryBoundary(payload);
      if (!isPlainObject(decoded)) throw new Error("Expected a request record");
      sent.push({ connection: connections, message: decoded });
      if (options.holdProbe && decoded.type === "test.pending") {
        probeSent.resolve();
        return;
      }
      const message = decoded as {
        type: string;
        requestId?: string;
        commit?: { localSeq: number };
        watches?: { id: string }[];
      };
      if (
        options.malformedReopenError && !refusedReopen && connections > 1 &&
        message.type === "session.open"
      ) {
        refusedReopen = true;
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId,
          error: options.malformedReopenError,
        }));
        return;
      }
      const refusal = options.refuseWritesOf;
      if (
        refusal &&
        (message.type === "transact"
          ? message.commit?.localSeq === refusal.localSeq
          : message.type === "session.watch.add" &&
            (message.watches ?? []).some((watch) =>
              watch.id === refusal.watchId
            ))
      ) {
        // The socket refuses this frame's own write on an open connection,
        // and the transport tears the connection down, as a socket transport
        // does: the loss reported first, then the send rejected.
        refusedWrites++;
        const error = writeFailedError(
          refusal.cause instanceof Error
            ? refusal.cause.message
            : "Memory websocket write failed",
          refusal.cause,
        );
        reset();
        closeReceiver(error);
        throw error;
      }
      if (
        options.loseFirstTransact && !lostOnce && message.type === "transact"
      ) {
        // The connection drops while this frame waits to be written, as a
        // socket transport reports it: the close first, then the send.
        lostOnce = true;
        reset();
        closeReceiver(new Error("test connection dropped"));
        throw connectionError("Memory websocket changed before send");
      }
      if (loseOpenResponse && message.type === "session.open") {
        // The server handles this open, and the connection drops before its
        // response reaches the client.
        loseOpenResponse = false;
        holding = true;
        await connection.receive(payload);
        reset();
        closeReceiver(new Error("test connection dropped"));
        return;
      }
      const held = options.holdFirstTransact && !heldOnce &&
        message.type === "transact";
      if (held) {
        heldOnce = true;
        holding = true;
      }
      const received = connection.receive(payload);
      inFlight.add(received);
      void received.finally(() => inFlight.delete(received)).catch(() => {});
      if (held) transactSent.resolve();
      if (options.sendResolvesOnWrite) return;
      await received;
    },
    reset() {
      reset();
      resetCalled.resolve();
    },
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
  return {
    transport,
    duplicateHello: duplicateHello.promise,
    resetCalled: resetCalled.promise,
    transactSent: transactSent.promise,
    probeSent: probeSent.promise,
    sent,
    corruptNextEffect(fields: FabricPlainObject) {
      corruptEffect = fields;
    },
    deliverDiscardedEffect() {
      deliverDiscardedEffect();
    },
    receive(payload: string) {
      receiver(payload);
    },
    get connections() {
      return connections;
    },
    get refusedWrites() {
      return refusedWrites;
    },
    drop() {
      reset();
      closeReceiver(new Error("test connection dropped"));
    },
    /** Loses the response to the next `session.open` the client sends. */
    loseNextOpenResponse() {
      loseOpenResponse = true;
    },
    /** Gives up on the connection the way a client does on a socket that
     * stopped answering: the server is not told, and holds it open. */
    abandon() {
      connection = undefined;
      holding = false;
      closeReceiver(new Error("test connection abandoned"));
    },
    /** Resolves once the server has handled every frame sent so far. */
    async settled() {
      await Promise.allSettled([...inFlight]);
    },
  };
}

describe("v2-client-reconnect-recovery", () => {
  for (const helloFirst of [false, true]) {
    it(`rejects a synchronous malformed handshake frame with hello already delivered=${helloFirst}`, async () => {
      let receiver = (_payload: string) => {};
      let sends = 0;
      let resets = 0;
      const transport: Transport = {
        send() {
          sends++;
          if (helloFirst) {
            receiver(encodeMemoryBoundary({
              type: "hello.ok",
              protocol: MEMORY_PROTOCOL,
              flags: getMemoryProtocolFlags(),
              sessionOpen: {
                audience: "did:key:handshake-test",
                challenge: { value: "handshake-test", expiresAt: 9999999999 },
              },
            }));
          }
          receiver("malformed boundary");
          return Promise.resolve();
        },
        setReceiver(next) {
          receiver = next;
        },
        reset() {
          resets++;
        },
        close() {
          return Promise.resolve();
        },
      };
      await expect(connect({ transport })).rejects.toMatchObject({
        name: "InvalidMessageError",
      });
      expect(sends).toBe(1);
      expect(resets).toBe(0);
    });
  }

  it("fails sessions and pending requests after a malformed effect on a transport without reset", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://malformed-effect-without-reset"),
    });
    const wire = reconnectableTransport(server, { holdProbe: true });
    const client = await connect({
      transport: { ...wire.transport, reset: undefined },
    });
    try {
      const session = await client.mount(
        "did:key:malformed-effect-without-reset",
        {},
        testSessionOpenAuthFactory,
      );
      const pending = client.request({
        type: "test.pending",
        requestId: "pending",
      });
      pending.catch(() => {});
      await wire.probeSent;
      wire.receive(encodeMemoryBoundary({
        type: "session/effect",
        effect: { type: "sync", labelTable: [null] },
      }));
      await expect(pending).rejects.toMatchObject({
        name: "InvalidMessageError",
      });
      await expect(session.whenRestored()).rejects.toMatchObject({
        name: "InvalidMessageError",
      });
      expect(client.connectionState).toBe("failed");
      wire.receive("malformed boundary");
      expect(wire.connections).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  for (const failure of ["label table", "nested schema reference"]) {
    it(`restores after a malformed pushed ${failure} and fences later frames from that connection`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://invalid-pushed-metadata"),
      });
      const wire = reconnectableTransport(server, { holdProbe: true });
      const client = await connect({ transport: wire.transport });
      const writerClient = await connect({ transport: loopback(server) });
      try {
        const space = "did:key:invalid-pushed-metadata";
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const write = (version: number) =>
          writer.transact({
            localSeq: version,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:watched",
              value: { value: { version } },
            }],
          });
        await write(1);
        const { view } = await session.watchAddSync([{
          id: "watched",
          kind: "graph",
          query: {
            roots: [{ id: "of:watched", selector: { path: [], schema: true } }],
          },
        }]);
        const updates = view.subscribeSync();
        const pending = client.request({
          type: "test.pending",
          requestId: "pending",
        });
        pending.catch(() => {});
        await wire.probeSent;
        wire.corruptNextEffect({
          labelTable: failure === "label table" ? [null] : [{
            integrity: [{
              source: linkRefFrom({
                id: "of:policy",
                path: [],
                schema: "schema-ref@2:missing",
              }),
            }],
          }],
        });
        await write(2);
        await expect(pending).rejects.toMatchObject({
          name: "ConnectionError",
        });
        await wire.resetCalled;
        expect(
          view.entities.find((entry) => entry.id === "of:watched")?.document,
        )
          .toEqual({ value: { version: 1 } });
        expect(
          wire.sent.filter(({ connection, message }) =>
            connection === 1 && message.type === "session.ack" &&
            typeof message.seenSeq === "number" && message.seenSeq >= 2
          ),
        ).toEqual([]);
        await client.restoreConnection();
        await session.whenRestored();
        expect(
          view.entities.find((entry) => entry.id === "of:watched")?.document,
        )
          .toEqual({ value: { version: 2 } });
        const restored = await updates.next();
        expect(restored.done).toBe(false);
        if (restored.done) throw new Error("Expected the restored sync");
        expect(restored.value.toSeq).toBe(2);
        expect(
          restored.value.upserts.find((entry) => entry.id === "of:watched")
            ?.doc,
        )
          .toEqual({ value: { version: 2 } });
        wire.deliverDiscardedEffect();
        expect(
          view.entities.find((entry) => entry.id === "of:watched")?.document,
        )
          .toEqual({ value: { version: 2 } });
        expect(wire.connections).toBe(2);
        expect(client.connectionState).toBe("connected");
      } finally {
        await client.close();
        await writerClient.close();
        await server.close();
      }
    });
  }

  for (const name of [undefined, 7]) {
    it(`resets after a remote reopen error with ${name === undefined ? "a missing" : "a numeric"} name and settles retained work on recovery`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://reconnect-malformed-error-${name}`),
      });
      const wire = reconnectableTransport(server, {
        holdFirstTransact: true,
        malformedReopenError: {
          ...(name === undefined ? {} : { name }),
          message: "synthetic reopen failure",
        },
      });
      const client = await connect({ transport: wire.transport });
      try {
        const session = await client.mount(
          "did:key:z6Mk-reconnect-malformed-error",
          {},
          testSessionOpenAuthFactory,
        );
        const pending = session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:retained", value: { value: 7 } }],
        });
        pending.catch(() => {});
        await wire.transactSent;
        wire.drop();
        const restored = client.restoreConnection();
        restored.catch(() => {});
        const watched = session.watchAddSync([{
          id: "retained",
          kind: "graph",
          query: {
            roots: [{
              id: "of:retained",
              selector: { path: [], schema: false },
            }],
          },
        }]);
        watched.catch(() => {});
        expect(
          await Promise.race([
            wire.resetCalled.then(() => "reset"),
            restored.then(() => "restored", () => "failed"),
          ]),
        ).toBe("reset");
        await restored;
        await expect(pending).resolves.toMatchObject({ seq: 1 });
        expect((await watched).view.entities).toEqual([
          expect.objectContaining({
            id: "of:retained",
            document: { value: 7 },
          }),
        ]);
        expect(wire.connections).toBe(3);
        expect(client.connectionState).toBe("connected");
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("rejects pending writes with the restoration error when the transport cannot reset", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-without-reset"),
    });
    const wire = reconnectableTransport(server);
    const client = await connect({
      transport: { ...wire.transport, reset: undefined },
    });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-without-reset",
      {},
      testSessionOpenAuthFactory,
    );
    const failure = new Error("session restoration failed");
    using _restore = stub(session, "restore", () => Promise.reject(failure));
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      wire.drop();
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:pending", value: { value: 1 } }],
      });
      pending.catch(() => {});
      expect(
        await Promise.race([
          client.restoreConnection().then(() => "restored", (error) => error),
          wire.duplicateHello,
        ]),
      ).toBe(failure);
      await expect(pending).rejects.toBe(failure);
      await expect(session.whenRestored()).rejects.toBe(failure);
      expect(client.connectionState).toBe("failed");
      expect(wire.connections).toBe(2);
      await expect(client.restoreConnection()).rejects.toBe(failure);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("gets a fresh challenge after the server rejects a stale signed reopen", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-challenge-recovery"),
    });
    const wire = reconnectableTransport(server);
    const client = await connect({ transport: wire.transport });
    let opens = 0;
    const challenges: string[] = [];
    const session = await client.mount(
      "did:key:z6Mk-reconnect-challenge-recovery",
      {},
      (_space, _session, context) => {
        challenges.push(context.challenge.value);
        return {
          invocation: {
            aud: context.audience,
            challenge: ++opens === 2
              ? "challenge:stale"
              : context.challenge.value,
          },
          authorization: {},
        };
      },
    );
    try {
      wire.drop();
      expect(
        await Promise.race([
          client.restoreConnection().then(() => "restored"),
          wire.duplicateHello,
        ]),
      ).toBe("restored");
      await session.whenRestored();
      expect(opens).toBe(3);
      expect(new Set(challenges).size).toBe(3);
      expect(wire.connections).toBe(3);
      expect(session.closeError).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores sessions and queued writes after restoration fails on a live connection", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-recovery"),
    });
    const wire = reconnectableTransport(server);
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-recovery",
      {},
      testSessionOpenAuthFactory,
    );
    const healthy = await client.mount(
      "did:key:z6Mk-reconnect-recovery-healthy",
      {},
      testSessionOpenAuthFactory,
    );
    const healthyRestored = Promise.withResolvers<void>();
    const restoreHealthy = healthy.restore.bind(healthy);
    let healthyAttempts = 0;
    using _healthy = stub(healthy, "restore", async () => {
      healthyAttempts++;
      await restoreHealthy();
      healthyRestored.resolve();
    });
    const restore = session.restore.bind(session);
    let attempts = 0;
    using _restore = stub(session, "restore", async () => {
      if (++attempts === 1) {
        await healthyRestored.promise;
        throw new Error("transient session restoration failure");
      }
      return restore();
    });
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      wire.drop();
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:recovered",
          value: { value: 7 },
        }],
      });
      pending.catch(() => {});
      const restored = client.restoreConnection().then(() => "restored");
      restored.catch(() => {});
      expect(
        await Promise.race([
          wire.resetCalled.then(() => "reset"),
          wire.duplicateHello,
        ]),
      ).toBe("reset");
      await healthy.whenRestored();
      expect(wire.connections).toBe(3);
      expect(
        await Promise.race([
          restored,
          wire.duplicateHello,
        ]),
      ).toBe("restored");
      await pending;
      await session.whenRestored();
      await healthy.whenRestored();
      expect(attempts).toBe(2);
      expect(healthyAttempts).toBe(2);
      expect(wire.connections).toBe(3);
      expect(client.connectionState).toBe("connected");
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("retains a commit in flight on a restored session when its sibling fails", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-inflight-commit"),
    });
    const wire = reconnectableTransport(server, { holdFirstTransact: true });
    const client = await connect({ transport: wire.transport });
    const flaky = await client.mount(
      "did:key:z6Mk-reconnect-inflight-flaky",
      {},
      testSessionOpenAuthFactory,
    );
    const healthy = await client.mount(
      "did:key:z6Mk-reconnect-inflight-healthy",
      {},
      testSessionOpenAuthFactory,
    );
    const healthyRestored = Promise.withResolvers<void>();
    const restoreHealthy = healthy.restore.bind(healthy);
    using _healthy = stub(healthy, "restore", async () => {
      await restoreHealthy();
      healthyRestored.resolve();
    });
    const restoreFlaky = flaky.restore.bind(flaky);
    let attempts = 0;
    let pending: ReturnType<typeof healthy.transact> | undefined;
    using _flaky = stub(flaky, "restore", async () => {
      if (++attempts === 1) {
        await healthyRestored.promise;
        pending = healthy.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:inflight", value: { value: 1 } }],
        });
        pending.catch(() => {});
        await wire.transactSent;
        throw new Error("transient session restoration failure");
      }
      return restoreFlaky();
    });
    try {
      wire.drop();
      await client.restoreConnection();
      expect(pending).toBeDefined();
      await expect(pending).resolves.toMatchObject({ seq: 1 });
      expect(wire.connections).toBe(3);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("retains replayed commits when the same session fails to restore its watches", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-replay-watch-failure"),
    });
    const wire = reconnectableTransport(server, { holdFirstTransact: true });
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-replay-watch-failure",
      {},
      testSessionOpenAuthFactory,
    );
    await session.watchAddSync([{
      id: "watched",
      kind: "graph",
      query: {
        roots: [{ id: "of:replayed", selector: { path: [], schema: false } }],
      },
    }]);
    // A reopened session whose watches were forgotten re-establishes them
    // after starting its retained commits' replay.
    const open = client.openSession.bind(client);
    using _open = stub(client, "openSession", async (...args) => ({
      ...await open(...args),
      resumed: false,
    }));
    const watchSet = session.watchSetSync.bind(session);
    let attempts = 0;
    using _watchSet = stub(session, "watchSetSync", async (...args) => {
      if (++attempts === 1) {
        await wire.transactSent;
        throw new Error("transient watch restoration failure");
      }
      return watchSet(...args);
    });
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      wire.drop();
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:replayed", value: { value: 1 } }],
      });
      pending.catch(() => {});
      await client.restoreConnection();
      await expect(pending).resolves.toMatchObject({ seq: 1 });
      expect(attempts).toBe(2);
      expect(wire.connections).toBe(3);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("resumes a session, and lands a commit issued while disconnected, when the response to its reopen is lost", async () => {
    // The server rotates the resume token as it handles the reopen, so the
    // client, which never saw the response, resumes with the token before.
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://lost-reopen-response"),
    });
    const lossy = reconnectableTransport(server);
    const client = await connect({ transport: lossy.transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-lost-reopen-response",
        {},
        testSessionOpenAuthFactory,
      );
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:x", value: { value: "A" } }],
      });

      lossy.loseNextOpenResponse();
      lossy.drop();
      const pending = session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:x", value: { value: "B" } }],
      });
      pending.catch(() => {});

      await expect(pending).resolves.toMatchObject({ seq: 2 });
      expect(session.closeError).toBeUndefined();
      expect(lossy.connections).toBe(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  for (const given of ["closed", "abandoned"] as const) {
    it(`keeps a restored session when a resume the client ${given} reaches the server after it`, async () => {
      // Found in review: the superseded resume carries the session's key
      // and the token the restoring one presented, so only its attempt
      // number tells it apart. "abandoned" is the case where the server
      // still holds the superseded connection open.
      let gate: PromiseWithResolvers<void> | undefined;
      const reached = Promise.withResolvers<void>();
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://superseded-resume-${given}`),
        async authorizeSessionOpen(message) {
          const paused = gate;
          if (paused !== undefined && message.session.sessionToken) {
            gate = undefined;
            reached.resolve();
            await paused.promise;
          }
          return testSessionOpenServerOptions.authorizeSessionOpen();
        },
      });
      const lossy = reconnectableTransport(server, {
        sendResolvesOnWrite: true,
      });
      const client = await connect({ transport: lossy.transport });
      try {
        const session = await client.mount(
          "did:key:z6Mk-superseded-resume",
          {},
          testSessionOpenAuthFactory,
        );
        const write = (localSeq: number, value: string) =>
          session.transact({
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:x", value: { value } }],
          });
        await write(1, "A");

        const release = Promise.withResolvers<void>();
        gate = release;
        lossy.drop();
        await reached.promise;
        if (given === "closed") lossy.drop();
        else lossy.abandon();
        await client.restoreConnection();
        expect(session.closeError).toBeUndefined();

        release.resolve();
        await lossy.settled();
        expect(session.closeError).toBeUndefined();
        await expect(write(2, "B")).resolves.toMatchObject({ seq: 2 });
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("retains a commit whose send rejects with a `ConnectionError` as its connection drops", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-lost-send"),
    });
    const wire = reconnectableTransport(server, { loseFirstTransact: true });
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-lost-send",
      {},
      testSessionOpenAuthFactory,
    );
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:lost-send", value: { value: 1 } }],
      });
      pending.catch(() => {});
      await expect(pending).resolves.toMatchObject({ seq: 1 });
      expect(wire.connections).toBe(2);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });
  it("returns the stored verdict for an exact replay without overwriting a later write, and refuses an altered one", async () => {
    // A retained commit can reach the server twice: its write can fail after
    // its bytes have left, or its response can be lost after the server
    // applied it. Replaying it is safe only because the server answers a
    // repeated commit from its record.

    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://replay-cannot-overwrite"),
    });
    const first = await connect({ transport: loopback(server) });
    const second = await connect({ transport: loopback(server) });
    const space = "did:key:z6Mk-replay-cannot-overwrite";
    const setX = (localSeq: number, value: string) => ({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set" as const, id: "of:x", value: { value } }],
    });
    try {
      const writer = await first.mount(space, {}, testSessionOpenAuthFactory);
      const other = await second.mount(space, {}, testSessionOpenAuthFactory);
      expect((await writer.transact(setX(1, "A"))).seq).toBe(1);

      // The same session and `localSeq` with different content is refused.
      await expect(writer.transact(setX(1, "ALTERED"))).rejects.toThrow(
        "commit replay mismatch",
      );

      // Another session overwrites the document with a commit of its own.
      expect((await other.transact(setX(1, "B"))).seq).toBe(2);

      // The exact original again gets its stored verdict and writes nothing.
      expect(await writer.transact(setX(1, "A"))).toMatchObject({
        seq: 1,
        replayed: true,
      });
      const view = await other.watchSet([{
        id: "x",
        kind: "graph",
        query: {
          roots: [{ id: "of:x", selector: { path: [], schema: false } }],
        },
      }]);
      expect(view.entities.find((entity) => entity.id === "of:x"))
        .toMatchObject({ seq: 2, document: { value: "B" } });
    } finally {
      await first.close();
      await second.close();
      await server.close();
    }
  });
  it("rejects a commit with the server's verdict when the verdict's message mentions a disconnect", async () => {
    // A server verdict carries client-chosen text, here the name of the
    // document whose read went stale. It is a verdict however it is worded, so
    // the commit is rejected with it rather than kept for a replay.

    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://verdict-mentions-disconnect"),
    });
    const first = await connect({ transport: loopback(server) });
    const second = await connect({ transport: loopback(server) });
    const space = "did:key:z6Mk-verdict-mentions-disconnect";
    const id = "of:disconnect-button";
    const setDocument = (
      localSeq: number,
      value: string,
      readSeq?: number,
    ) => ({
      localSeq,
      reads: {
        confirmed: readSeq === undefined
          ? []
          : [{ id, path: toDocumentPath([]), seq: readSeq }],
        pending: [],
      },
      operations: [{ op: "set" as const, id, value: { value } }],
    });
    try {
      const writer = await first.mount(space, {}, testSessionOpenAuthFactory);
      const other = await second.mount(space, {}, testSessionOpenAuthFactory);
      await writer.transact(setDocument(1, "A"));
      await other.transact(setDocument(1, "B"));

      await expect(writer.transact(setDocument(2, "C", 1))).rejects.toThrow(
        `stale confirmed read: ${id} at seq 1 conflicted with seq 2`,
      );
    } finally {
      await first.close();
      await second.close();
      await server.close();
    }
  });
  it("rejects a commit with its own write's error once that write has failed five times", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-refused-write"),
    });
    const writeFailure = new Error("frame refused by socket");
    const wire = reconnectableTransport(server, {
      refuseWritesOf: { localSeq: 1, cause: writeFailure },
    });
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-refused-write",
      {},
      testSessionOpenAuthFactory,
    );
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:refused", value: { value: 1 } }],
      });
      await expect(pending).rejects.toBe(writeFailure);
      expect(wire.refusedWrites).toBe(5);
      await client.restoreConnection();
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("rejects a watch request with its own write's error once that write has failed five times", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-refused-watch-write"),
    });
    const writeFailure = new Error("frame refused by socket");
    const wire = reconnectableTransport(server, {
      refuseWritesOf: { watchId: "refused", cause: writeFailure },
    });
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-refused-watch-write",
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
    let pending: ReturnType<typeof session.watchAddSync> | undefined;
    try {
      pending = session.watchAddSync([watch("refused")]);
      await expect(pending).rejects.toBe(writeFailure);
      expect(wire.refusedWrites).toBe(5);
      await client.restoreConnection();
      await session.watchAddSync([watch("accepted")]);
      expect(
        server.demandedInstancesForSpace(
          "did:key:z6Mk-reconnect-refused-watch-write",
        ).map((row) => row.id),
      ).toEqual(["of:accepted"]);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });

  it("rejects a commit whose own write fails five times with a value other than an `Error`, carrying that value as the cause", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://reconnect-refused-write-value"),
    });
    const wire = reconnectableTransport(server, {
      refuseWritesOf: { localSeq: 1, cause: "frame refused" },
    });
    const client = await connect({ transport: wire.transport });
    const session = await client.mount(
      "did:key:z6Mk-reconnect-refused-write-value",
      {},
      testSessionOpenAuthFactory,
    );
    let pending: ReturnType<typeof session.transact> | undefined;
    try {
      pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:refused", value: { value: 1 } }],
      });
      const failure = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe("Error");
      expect((failure as Error).message).toBe("Memory websocket write failed");
      expect((failure as Error).cause).toBe("frame refused");
      expect(wire.refusedWrites).toBe(5);
    } finally {
      await client.close();
      await pending?.catch(() => {});
      await server.close();
    }
  });
});
