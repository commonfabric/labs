import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloMessage,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  type ServerMessage,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-expression-result-compatibility";

describe("expression-result-compatibility", () => {
  it("requires an explicitly advertised identity contract", () => {
    const flags = getMemoryProtocolFlags();
    expect(flags.stableExpressionResultIds).toBe(true);
    expect(parseMemoryProtocolFlags(wireMemoryProtocolFlags(flags))).toEqual(
      flags,
    );
    expect(parseMemoryProtocolFlags({})?.stableExpressionResultIds).toBe(false);
    expect(
      parseMemoryProtocolFlags({ stableExpressionResultIds: false })
        ?.stableExpressionResultIds,
    ).toBe(false);
    expect(parseMemoryProtocolFlags({ stableExpressionResultIds: "true" }))
      .toBeNull();
  });

  for (const marker of [undefined, false]) {
    it(`refuses session admission when the marker is ${marker}`, async () => {
      const sessions = new SessionRegistry();
      let authorizationCalls = 0;
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://expression-result-compatibility-${marker}`),
        sessions,
        authorizeSessionOpen() {
          authorizationCalls++;
          return SPACE;
        },
      });
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      const { stableExpressionResultIds: _marker, ...flags } =
        getMemoryProtocolFlags();
      try {
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: {
            ...flags,
            ...(marker === undefined
              ? {}
              : { stableExpressionResultIds: marker }),
          },
        }));
        const hello = messages.shift();
        expect(hello?.type).toBe("hello.ok");
        if (hello?.type !== "hello.ok") throw new Error("Expected hello.ok");

        await connection.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "open",
          space: SPACE,
          session: { sessionId: "stale-session" },
          invocation: {
            aud: hello.sessionOpen?.audience,
            challenge: hello.sessionOpen?.challenge.value,
          },
          authorization: {},
        }));
        expect(messages.shift()).toMatchObject({
          type: "response",
          requestId: "open",
          error: { name: "SessionRevokedError", clientUpdateRequired: true },
        });
        expect(authorizationCalls).toBe(0);
        expect(sessions.sessionsForSpace(SPACE)).toEqual([]);
      } finally {
        connection.close();
        await server.close();
      }
    });
  }

  it("retains an initial update refusal across repeated and concurrent mounts", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://expression-result-initial-refusal"),
    });
    const transport = loopback(server);
    let opens = 0;
    const client = await connect({
      transport: {
        ...transport,
        send(payload) {
          const message = decodeMemoryBoundary(payload) as { type: string };
          if (message.type === "session.open") opens++;
          if (message.type === "hello") {
            const hello = decodeMemoryBoundary(payload) as HelloMessage;
            payload = encodeMemoryBoundary({
              ...hello,
              flags: { ...hello.flags, stableExpressionResultIds: false },
            });
          }
          return transport.send(payload);
        },
      },
    });
    try {
      const mount = () => client.mount(SPACE, {}, testSessionOpenAuthFactory);
      const results = await Promise.allSettled([mount(), mount(), mount()]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("Expected refusal");
        expect(result.reason).toMatchObject({
          name: "SessionRevokedError",
          clientUpdateRequired: true,
          message: expect.stringContaining("Reload the browser tab"),
        });
      }
      await expect(mount()).rejects.toMatchObject({
        clientUpdateRequired: true,
      });
      expect(opens).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads and writes through a matching client and server", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://expression-result-compatibility-matching"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
      const id = "of:fid1:expression-result";
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id, value: { value: "glazed" } }],
      });
      const result = await session.queryGraph({
        roots: [{ id, selector: { path: [], schema: false } }],
      });
      expect(result.entities).toEqual([{
        id,
        branch: "",
        seq: 1,
        document: { value: "glazed" },
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses a server that does not enforce the identity contract", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://expression-result-compatibility-missing-server"),
    });
    const transport = loopback(server);
    try {
      await expect(connect({
        transport: {
          ...transport,
          setReceiver(receiver) {
            transport.setReceiver((payload) => {
              const message = decodeMemoryBoundary(payload) as ServerMessage;
              if (message.type === "hello.ok") {
                const { stableExpressionResultIds: _marker, ...flags } =
                  message.flags;
                receiver(encodeMemoryBoundary({ ...message, flags }));
              } else {
                receiver(payload);
              }
            });
          },
        },
      })).rejects.toMatchObject({ name: "ProtocolError", permanent: true });
    } finally {
      await transport.close();
      await server.close();
    }
  });

  it("terminates a refused resume without replaying commits or watches", async () => {
    const before = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://expression-result-compatibility-before"),
    });
    const after = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://expression-result-compatibility-after"),
    });
    let receiver = (_payload: string) => {};
    let closeReceiver = (_error?: Error) => {};
    let connection = before.connect((message) =>
      receiver(encodeMemoryBoundary(message))
    );
    let replaced = false;
    let holdCommit = false;
    const held = Promise.withResolvers<void>();
    const afterMessages: string[] = [];
    const transport: Transport = {
      async send(payload) {
        const message = decodeMemoryBoundary(payload) as { type: string };
        if (replaced) {
          afterMessages.push(message.type);
          if (message.type === "hello") {
            const hello = decodeMemoryBoundary(payload) as HelloMessage;
            const { stableExpressionResultIds: _marker, ...flags } =
              hello.flags;
            payload = encodeMemoryBoundary({ ...hello, flags });
          }
        }
        if (holdCommit && message.type === "transact") {
          held.resolve();
          return;
        }
        await connection.receive(payload);
      },
      close() {
        connection.close();
        return Promise.resolve();
      },
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver(next) {
        closeReceiver = next;
      },
    };
    const client = await connect({ transport });
    try {
      const session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
      await session.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:fid1:expression-result",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      holdCommit = true;
      const pending = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:fid1:expression-result",
          value: { value: "stale result" },
        }],
      });
      const refusal = expect(pending).rejects.toMatchObject({
        name: "SessionRevokedError",
      });
      await held.promise;
      connection.close();
      connection = after.connect((message) =>
        receiver(encodeMemoryBoundary(message))
      );
      replaced = true;
      holdCommit = false;
      closeReceiver(new Error("backend replaced"));
      await client.restoreConnection();
      await refusal;
      await expect(session.watchAdd([])).rejects.toMatchObject({
        name: "SessionRevokedError",
      });
      expect(session.closeError).toMatchObject({
        clientUpdateRequired: true,
        message: expect.stringContaining("Reload the browser tab"),
      });
      await expect(client.mount(SPACE, {}, testSessionOpenAuthFactory))
        .rejects.toBe(session.closeError);
      expect(afterMessages).toEqual(["hello", "session.open"]);
    } finally {
      await client.close();
      await before.close();
      await after.close();
    }
  });
});
