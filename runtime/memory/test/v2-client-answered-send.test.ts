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
});
