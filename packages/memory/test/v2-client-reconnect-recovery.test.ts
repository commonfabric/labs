import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** A reconnectable transport using the real server's handshake and sessions. */
function reconnectableTransport(server: Server) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let connections = 0;
  const duplicateHello = Promise.withResolvers<string>();
  const reset = () => {
    connection?.close();
    connection = undefined;
  };
  const transport = {
    async send(payload: string) {
      if (!connection) {
        connections++;
        connection = server.connect((message) => {
          const encoded = encodeMemoryBoundary(message);
          receiver(encoded);
          const response = decodeMemoryBoundary(encoded) as {
            error?: { message: string };
          };
          if (response.error?.message === "hello may only be sent once") {
            duplicateHello.resolve(response.error.message);
          }
        });
      }
      await connection.receive(payload);
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
    duplicateHello: duplicateHello.promise,
    get connections() {
      return connections;
    },
    drop() {
      transport.reset();
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
      expect(
        await Promise.race([
          client.restoreConnection().then(() => "restored"),
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
});
