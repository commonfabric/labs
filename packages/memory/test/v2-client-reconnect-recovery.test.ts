import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
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
    refuseWritesOf?: { localSeq: number; cause: unknown };
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
  let refusedWrites = 0;
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
      const message = decodeMemoryBoundary(payload) as {
        type: string;
        commit?: { localSeq: number };
      };
      const refusal = options.refuseWritesOf;
      if (
        refusal && message.type === "transact" &&
        message.commit?.localSeq === refusal.localSeq
      ) {
        // The socket refuses this commit's own write on an open connection,
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
      const held = options.holdFirstTransact && !heldOnce &&
        message.type === "transact";
      if (held) {
        heldOnce = true;
        holding = true;
      }
      const received = connection.receive(payload);
      if (held) transactSent.resolve();
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
  };
}

describe("v2-client-reconnect-recovery", () => {
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
