import { assertEquals, assertRejects } from "@std/assert";
import type { FabricValue } from "@commonfabric/api";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MAX_UNTRUSTED_MESSAGE_SLOTS,
  MEMORY_PROTOCOL,
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
