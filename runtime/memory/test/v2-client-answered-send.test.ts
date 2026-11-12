/**
 * A transport's send can settle after the server's response to it has
 * arrived. The response then answers the request, whatever the send reports:
 * the server has acted on it, and a `session.open` it accepted opened a
 * session the caller must be given, restored first when the connection that
 * answered has since been replaced.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { decodeMemoryBoundary } from "../v2.ts";
import {
  type Client,
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

/** A server with a store of its own for the case named `name`. */
const serverFor = (
  name: string,
  options: Partial<ConstructorParameters<typeof Server>[0]> = {},
) =>
  new Server({
    ...testSessionOpenServerOptions,
    ...options,
    store: new URL(`memory://client-answered-send-${name}`),
  });

/** The space the case named `name` mounts. */
const spaceFor = (name: string) => `did:key:z6Mk-client-answered-send-${name}`;

/** A commit that sets `of:doc` to `"A"`. */
const commit = () => ({
  localSeq: 1,
  reads: { confirmed: [], pending: [] },
  operations: [{ op: "set" as const, id: "of:doc", value: { value: "A" } }],
});

/**
 * A transport to `server` over a loopback connection, opened anew after each
 * loss. Its send of the first `type` request waits until the server's answer
 * to it has reached the client, and then settles as `settle` does. `lose`,
 * which `settle` is also given, closes the connection, reports the loss to
 * the client, and returns the error a send lost with that connection rejects
 * with.
 */
function answeredBeforeSendSettles(
  server: Server,
  type: "session.open" | "transact",
  settle: (lose: () => Error) => Promise<void>,
): { transport: Transport; lose(): Error } {
  let inner: Transport | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let first = true;
  let awaited: unknown;
  const answered = Promise.withResolvers<void>();
  const lose = () => {
    const error = connectionError("test connection lost");
    void inner?.close();
    inner = undefined;
    closeReceiver(error);
    return error;
  };
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
          const { requestId } = decodeMemoryBoundary(frame) as {
            requestId?: unknown;
          };
          if (awaited !== undefined && requestId === awaited) {
            answered.resolve();
          }
        });
      }
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        requestId?: unknown;
      };
      if (message.type !== type || !first) return await inner.send(payload);
      first = false;
      awaited = message.requestId;
      await inner.send(payload);
      await answered.promise;
      await settle(lose);
    },
  };
  return { transport, lose };
}

/**
 * A client of `server` whose first `session.open` is answered on a connection
 * that is then lost and replaced, the client's sessions restored, before the
 * open's send settles: rejecting as lost with that connection, or, with
 * `resolves`, resolving. `lose` loses the client's connection again.
 */
async function clientReplacingConnectionUnderOpen(
  server: Server,
  options: { resolves?: boolean } = {},
): Promise<{ client: Client; lose(): Error }> {
  const reconnected = Promise.withResolvers<void>();
  const { transport, lose } = answeredBeforeSendSettles(
    server,
    "session.open",
    async (lose) => {
      const lost = lose();
      await reconnected.promise;
      if (options.resolves !== true) throw lost;
    },
  );
  const client = await connect({ transport });
  client.subscribeReconnected(() => reconnected.resolve());
  return { client, lose };
}

describe("client", () => {
  it("resolves a mount whose `session.open` was answered before its send failed outright, with a session that works", async () => {
    const server = serverFor("outright");
    const { transport } = answeredBeforeSendSettles(
      server,
      "session.open",
      () => Promise.reject(new Error("test write refused")),
    );
    const client = await connect({ transport });
    try {
      const session = await client.mount(
        spaceFor("outright"),
        {},
        testSessionOpenAuthFactory,
      );

      expect((await session.transact(commit())).seq).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves a commit whose `transact` was answered before its send failed outright, with the server's acceptance of it", async () => {
    // An in-process transport rejects a send this way when the server's
    // handling of the request throws after it has answered. The server holds
    // the write by then, so a caller told the commit failed would be wrong.

    const server = serverFor("transact");
    const { transport } = answeredBeforeSendSettles(
      server,
      "transact",
      () => Promise.reject(new Error("test write refused")),
    );
    const client = await connect({ transport });
    try {
      const session = await client.mount(
        spaceFor("transact"),
        {},
        testSessionOpenAuthFactory,
      );

      expect((await session.transact(commit())).seq).toBe(1);
      expect((await server.readDocument(spaceFor("transact"), "of:doc"))?.value)
        .toBe("A");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("logs what a send that failed outright reported, once, when its request was answered first", async () => {
    // The request resolves with the server's answer, so this line is the
    // only record of the failure the send reported.

    const server = serverFor("logged");
    const { transport } = answeredBeforeSendSettles(
      server,
      "transact",
      () => Promise.reject(new Error("test write refused")),
    );
    const client = await connect({ transport });
    const lines: string[] = [];
    const warn = stub(console, "warn", (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const session = await client.mount(
        spaceFor("logged"),
        {},
        testSessionOpenAuthFactory,
      );
      await session.transact(commit());

      const logged = lines.filter((line) =>
        line.includes("send-failed-after-answer")
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(
        'was answered before its send failed: "Error": "test write refused"',
      );
    } finally {
      warn.restore();
      await client.close();
      await server.close();
    }
  });

  it("restores a mount whose `session.open` was answered on a connection that dropped and was replaced before its send failed, with a session that works", async () => {
    // The answer arrives, the connection closes and the client reconnects,
    // restoring its sessions, and only then does the open's send fail: the
    // session the server opened is open only on the connection that is gone.

    const server = serverFor("replaced");
    const { client } = await clientReplacingConnectionUnderOpen(server);
    try {
      const session = await client.mount(
        spaceFor("replaced"),
        {},
        testSessionOpenAuthFactory,
      );

      expect(client.isConnected()).toBe(true);
      expect((await session.transact(commit())).seq).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores a mount whose `session.open` was answered on a connection that dropped and was replaced before its send resolved, with a session that works", async () => {
    // A send that resolves reports nothing to the request, so nothing but
    // the connection the answer arrived on says the session needs restoring.

    const server = serverFor("replaced-resolved");
    const { client } = await clientReplacingConnectionUnderOpen(server, {
      resolves: true,
    });
    try {
      const session = await client.mount(
        spaceFor("replaced-resolved"),
        {},
        testSessionOpenAuthFactory,
      );

      expect(client.isConnected()).toBe(true);
      expect((await session.transact(commit())).seq).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores a mount answered on a connection that dropped only once when its send fails before the reconnect finishes", async () => {
    let opens = 0;
    const server = serverFor("once", {
      authorizeSessionOpen: () => {
        opens++;
        return testSessionOpenServerOptions.authorizeSessionOpen();
      },
    });
    const { transport } = answeredBeforeSendSettles(
      server,
      "session.open",
      (lose) => Promise.reject(lose()),
    );
    const client = await connect({ transport });
    try {
      const session = await client.mount(
        spaceFor("once"),
        {},
        testSessionOpenAuthFactory,
      );

      expect((await session.transact(commit())).seq).toBe(1);
      // The open the server answered, and one restore.
      expect(opens).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a mount whose `session.open` was answered before the client closed, as made on a closed client", async () => {
    // The transport's own rejection of the send says only that a connection
    // was lost. The answer stands, and the mount fails on what it finds when
    // it goes to restore the session: a client that is closed.

    const server = serverFor("closed");
    let closing: () => Promise<void> = () => Promise.resolve();
    const { transport } = answeredBeforeSendSettles(
      server,
      "session.open",
      async () => {
        await closing();
        throw connectionError("test connection closed");
      },
    );
    const client = await connect({ transport });
    closing = () => client.close();
    try {
      await expect(
        client.mount(spaceFor("closed"), {}, testSessionOpenAuthFactory),
      ).rejects.toThrow("memory client is closed");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a mount whose `session.open` was answered on a replaced connection with the denial that ended its restore there, and mounts the space again on the next connection", async () => {
    // The server admits the mount's open, refuses the restore's for good, and
    // admits every open after that. A refused open uses up its connection's
    // challenge, so the second mount is made on a new connection, which has
    // nothing of the refused session to restore, once the client has
    // connected again: a mount made while it is connecting fails at once.

    let opens = 0;
    const server = serverFor("denied", {
      authorizeSessionOpen: () =>
        ++opens === 2
          ? undefined
          : testSessionOpenServerOptions.authorizeSessionOpen(),
    });
    const { client, lose } = await clientReplacingConnectionUnderOpen(server);
    try {
      await expect(
        client.mount(spaceFor("denied"), {}, testSessionOpenAuthFactory),
      ).rejects.toMatchObject({ name: "AuthorizationError" });

      lose();
      await client.restoreConnection();
      const session = await client.mount(
        spaceFor("denied"),
        {},
        testSessionOpenAuthFactory,
      );

      expect((await session.transact(commit())).seq).toBe(1);
      // The first mount's open, its restore's, and the second mount's.
      expect(opens).toBe(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
