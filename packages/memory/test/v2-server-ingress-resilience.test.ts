import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { FabricValue } from "@commonfabric/api";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MAX_UNTRUSTED_MESSAGE_SLOTS,
  MEMORY_PROTOCOL,
  ProtocolError,
  type ServerMessage,
} from "../v2.ts";
import {
  testSessionOpenAuth,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

Deno.test("memory v2 server rejects malformed input without poisoning the connection", async () => {
  const messages: ServerMessage[] = [];
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-server-ingress-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive("{");
    assertEquals(messages.shift(), {
      type: "response",
      requestId: "invalid",
      error: {
        name: "InvalidMessageError",
        message: "Unable to parse memory message",
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    assertEquals(messages.shift()?.type, "hello.ok");
    assertEquals(messages, []);
  } finally {
    connection.close();
    await server.close();
  }
});

/** Returns a sparse array one slot longer than a message may stand for. */
const oversizedArray = (): FabricValue[] => {
  const items: FabricValue[] = [];
  items[MAX_UNTRUSTED_MESSAGE_SLOTS] = 1;
  return items;
};

Deno.test("memory v2 server answers a message past the slot limit on its own request id", async () => {
  const messages: ServerMessage[] = [];
  const server = new Server({
    authorizeSessionOpen: () => "did:key:z6Mk-server-ingress-principal",
    sessionOpenAuth: testSessionOpenAuth,
  });
  const connection = server.connect((message) => messages.push(message));

  try {
    // The array stands for more slots than a message may while its encoding
    // is a few bytes long, which is the case the limit exists for.
    const oversized = encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-oversized",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { items: oversizedArray() } },
        }],
      },
    });
    assertEquals(oversized.length < 1_000, true);

    await connection.receive(oversized);
    assertEquals(messages.shift(), {
      type: "response",
      requestId: "tx-oversized",
      error: {
        name: "MessageTooLargeError",
        message: "Memory message stands for more than " +
          `${MAX_UNTRUSTED_MESSAGE_SLOTS} array slots and record members`,
      },
    });

    // Without a request id to name, the refusal is answered like any other
    // message that cannot be read.
    await connection.receive(
      encodeMemoryBoundary({ items: oversizedArray() }),
    );
    assertEquals(messages.shift(), {
      type: "response",
      requestId: "invalid",
      error: {
        name: "InvalidMessageError",
        message: "Unable to parse memory message",
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    assertEquals(messages.shift()?.type, "hello.ok");
    assertEquals(messages, []);
  } finally {
    connection.close();
    await server.close();
  }
});

Deno.test("memory v2 client commit past the slot limit fails, and the session still commits", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-oversized-client-commit"),
  });
  const client = await connect({ transport: loopback(server) });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-oversized-client-commit",
    {},
    testSessionOpenAuthFactory,
  );

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "entity:oversized",
            value: { value: { items: oversizedArray() } },
          }],
        }),
      Error,
      "array slots and record members",
    );
    assertEquals(error.name, "MessageTooLargeError");

    const applied = await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:small",
        value: { value: { items: [1, 2, 3] } },
      }],
    });
    assertEquals(applied.seq, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

/**
 * A transport onto `server` that behaves as the memory websocket host does:
 * it hands each frame to the connection without waiting for its handling, and
 * a frame whose handling rejects closes the connection.
 */
function hostLikeTransport(server: Server) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let connections = 0;
  const reset = () => {
    connection?.close();
    connection = undefined;
  };
  const transport = {
    send(payload: string) {
      if (!connection) {
        connections++;
        const opened = server.connect((message) => {
          if (connection === opened) receiver(encodeMemoryBoundary(message));
        });
        connection = opened;
      }
      const current = connection;
      current.receive(payload).catch(() => {
        if (connection !== current) return;
        reset();
        closeReceiver(new Error("Memory websocket message failure"));
      });
      return Promise.resolve();
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
  return {
    transport,
    get connections() {
      return connections;
    },
  };
}

Deno.test("memory v2 server answers a commit whose handling throws with a `TransactionError` on its own request id, and keeps the connection", async () => {
  // An unexpected failure handling a commit is the server's verdict on that
  // commit. Closing the connection instead would make the client replay the
  // commit into the same failure on every new connection.
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-transact-handler-throws"),
  });
  const wire = hostLikeTransport(server);
  const client = await connect({ transport: wire.transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-transact-handler-throws",
    {},
    testSessionOpenAuthFactory,
  );
  const transact = server.transact.bind(server);
  let calls = 0;
  using _transact = stub(server, "transact", (...args) => {
    if (++calls === 1) {
      throw new Error("unexpected failure handling the commit");
    }
    return transact(...args);
  });

  try {
    const failure = await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:failed", value: { value: 1 } }],
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("TransactionError");
    expect((failure as Error).message).toBe(
      "unexpected failure handling the commit",
    );

    const applied = await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:next", value: { value: 2 } }],
    });
    expect(applied.seq).toBe(1);
    expect(wire.connections).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 server answers a query whose handling throws with a `QueryError`, and keeps the connection", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-query-handler-throws"),
  });
  const wire = hostLikeTransport(server);
  const client = await connect({ transport: wire.transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-query-handler-throws",
    {},
    testSessionOpenAuthFactory,
  );
  using _graphQuery = stub(server, "graphQuery", () => {
    throw new Error("unexpected failure handling the query");
  });

  try {
    const failure = await session.queryGraph({
      roots: [{ id: "of:queried", selector: { path: [], schema: false } }],
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("QueryError");
    expect((failure as Error).message).toBe(
      "unexpected failure handling the query",
    );

    const applied = await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:after-query", value: { value: 1 } }],
    });
    expect(applied.seq).toBe(1);
    expect(wire.connections).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 server answers a request whose handling throws a `ProtocolError` with that error's own name", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-handler-throws-protocol-error"),
  });
  const wire = hostLikeTransport(server);
  const client = await connect({ transport: wire.transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-handler-throws-protocol-error",
    {},
    testSessionOpenAuthFactory,
  );
  using _graphQuery = stub(server, "graphQuery", () => {
    throw new ProtocolError("query refused by the engine");
  });

  try {
    const failure = await session.queryGraph({
      roots: [{ id: "of:queried", selector: { path: [], schema: false } }],
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ProtocolError");
    expect((failure as Error).message).toBe("query refused by the engine");
    expect(wire.connections).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
