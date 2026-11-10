/**
 * A transport's send can settle after the server's response to it has
 * arrived. When that send then fails, the response still answers the request:
 * the server has acted on it, and a `session.open` it accepted opened a
 * session the caller must be given.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { decodeMemoryBoundary } from "../v2.ts";
import {
  connect,
  connectionError,
  loopback,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/**
 * A loopback transport to `server` whose send of the next `session.open`, once
 * the server's response to it has reached the client, rejects with `fail()`.
 */
function failingOpenSendTransport(server: Server, fail: () => Error) {
  const inner = loopback(server);
  let failing = false;
  let answered: PromiseWithResolvers<void> | undefined;
  let openRequestId: unknown;
  const transport: Transport = {
    ...inner,
    setReceiver(next) {
      inner.setReceiver((payload) => {
        next(payload);
        const message = decodeMemoryBoundary(payload);
        if (
          answered !== undefined &&
          (message as { requestId?: unknown }).requestId === openRequestId
        ) answered.resolve();
      });
    },
    async send(payload) {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        requestId?: unknown;
      };
      if (!failing || message.type !== "session.open") {
        return await inner.send(payload);
      }
      failing = false;
      answered = Promise.withResolvers<void>();
      openRequestId = message.requestId;
      await inner.send(payload);
      await answered.promise;
      throw fail();
    },
  };
  return {
    transport,
    failNextOpenSend() {
      failing = true;
    },
  };
}

describe("client", () => {
  for (
    const [kind, fail] of [
      ["with its connection", () => connectionError("test write failed")],
      ["outright", () => new Error("test write refused")],
    ] as const
  ) {
    it(`resolves a mount whose \`session.open\` was answered before its send failed ${kind}, with a session that works`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(
          `memory://client-answered-send-${kind.replaceAll(" ", "-")}`,
        ),
      });
      const host = failingOpenSendTransport(server, fail);
      const client = await connect({ transport: host.transport });
      try {
        host.failNextOpenSend();
        const session = await client.mount(
          "did:key:z6Mk-client-answered-send",
          {},
          testSessionOpenAuthFactory,
        );
        const applied = await session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id: "of:doc", value: { value: "A" } }],
        });
        expect(applied.seq).toBeGreaterThan(0);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
  it("restores a mount whose `session.open` was answered on a connection that dropped and was replaced before its send failed, with a session that works", async () => {
    // The answer arrives, the connection closes and the client reconnects,
    // restoring its sessions, and only then does the open's send fail: the
    // session the server opened is open only on the connection that is gone.
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-answered-send-replaced"),
    });
    let inner: Transport | undefined;
    let receiver = (_payload: string) => {};
    let closeReceiver = (_error?: Error) => {};
    let failOpen = true;
    let openRequestId: unknown;
    const answered = Promise.withResolvers<void>();
    const reconnected = Promise.withResolvers<void>();
    const transport: Transport = {
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver(next) {
        closeReceiver = next;
      },
      async close() {
        await inner?.close();
        inner = undefined;
      },
      reset() {
        void inner?.close();
        inner = undefined;
      },
      async send(payload) {
        if (inner === undefined) {
          inner = loopback(server);
          inner.setReceiver((frame) => {
            receiver(frame);
            const message = decodeMemoryBoundary(frame) as {
              requestId?: unknown;
            };
            if (
              openRequestId !== undefined &&
              message.requestId === openRequestId
            ) answered.resolve();
          });
        }
        const message = decodeMemoryBoundary(payload) as {
          type?: string;
          requestId?: unknown;
        };
        if (message.type !== "session.open" || !failOpen) {
          return await inner.send(payload);
        }
        failOpen = false;
        openRequestId = message.requestId;
        await inner.send(payload);
        await answered.promise;
        await inner.close();
        inner = undefined;
        const error = connectionError(
          "connection lost after the open's answer",
        );
        closeReceiver(error);
        await reconnected.promise;
        throw error;
      },
    };
    const client = await connect({ transport });
    client.subscribeReconnected(() => reconnected.resolve());
    try {
      const session = await client.mount(
        "did:key:z6Mk-client-answered-send-replaced",
        {},
        testSessionOpenAuthFactory,
      );
      expect(client.isConnected()).toBe(true);
      const applied = await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:doc", value: { value: "A" } }],
      });
      expect(applied.seq).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
  /**
   * A transport whose send of the first `session.open` waits for its answer,
   * then runs `after`, then rejects as a lost connection.
   */
  function answeredThenFailingOpen(
    server: Server,
    after: (closeReceiver: (error?: Error) => void) => Promise<void>,
  ): Transport {
    let inner: Transport | undefined;
    let receiver = (_payload: string) => {};
    let closeReceiver = (_error?: Error) => {};
    let failOpen = true;
    let openRequestId: unknown;
    const answered = Promise.withResolvers<void>();
    return {
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver(next) {
        closeReceiver = next;
      },
      async close() {
        await inner?.close();
        inner = undefined;
      },
      reset() {
        void inner?.close();
        inner = undefined;
      },
      async send(payload) {
        if (inner === undefined) {
          inner = loopback(server);
          inner.setReceiver((frame) => {
            receiver(frame);
            const message = decodeMemoryBoundary(frame) as {
              requestId?: unknown;
            };
            if (
              openRequestId !== undefined &&
              message.requestId === openRequestId
            ) answered.resolve();
          });
        }
        const message = decodeMemoryBoundary(payload) as {
          type?: string;
          requestId?: unknown;
        };
        if (message.type !== "session.open" || !failOpen) {
          return await inner.send(payload);
        }
        failOpen = false;
        openRequestId = message.requestId;
        await inner.send(payload);
        await answered.promise;
        await after((error) => {
          void inner?.close();
          inner = undefined;
          closeReceiver(error);
        });
        throw connectionError("connection lost after the open's answer");
      },
    };
  }

  it("rejects a mount whose `session.open` was answered when the client closed before the send failed", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-answered-send-closed"),
    });
    let closing: () => Promise<void> = () => Promise.resolve();
    const client = await connect({
      transport: answeredThenFailingOpen(server, () => closing()),
    });
    closing = () => client.close();
    try {
      await expect(
        client.mount(
          "did:key:z6Mk-client-answered-send-closed",
          {},
          testSessionOpenAuthFactory,
        ),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a mount whose `session.open` was answered on a replaced connection when restoring it there is denied for good", async () => {
    let opens = 0;
    const server = new Server({
      ...testSessionOpenServerOptions,
      authorizeSessionOpen: () =>
        ++opens === 1
          ? testSessionOpenServerOptions.authorizeSessionOpen()
          : undefined,
      store: new URL("memory://client-answered-send-denied"),
    });
    const reconnected = Promise.withResolvers<void>();
    const client = await connect({
      transport: answeredThenFailingOpen(server, async (drop) => {
        drop(connectionError("connection lost after the open's answer"));
        await reconnected.promise;
      }),
    });
    client.subscribeReconnected(() => reconnected.resolve());
    try {
      await expect(
        client.mount(
          "did:key:z6Mk-client-answered-send-denied",
          {},
          testSessionOpenAuthFactory,
        ),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
