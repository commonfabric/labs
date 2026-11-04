/**
 * A commit the server accepted settles with its verdict, whatever ends its
 * session before the commit's send settles. Over a transport whose send
 * settles only after the frames the server sent while handling it, as a send
 * over a serving worker's port does, the verdict reaches the client while the
 * commit is still outstanding, and so does a revocation that follows it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import {
  connect,
  connectionError,
  queuedFrameTransport,
  type SessionOpenAuthFactory,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const OWNER = "did:key:z6Mk-client-accepted-commit-owner";

/** Opens each session authenticated as `principal`. */
const signedAs = (principal: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: {
    iss: principal,
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: {},
});

/**
 * A loopback to `server` whose send settles only once every frame the server
 * sent while handling it has reached the client. With `failTransacts`, a
 * transact's send then fails as one over a lost connection does, and
 * `transactFailed` resolves as the first one fails.
 */
const portOrderedLoopback = (
  server: Server,
  options: { failTransacts?: boolean } = {},
): { transport: Transport; transactFailed: Promise<void> } => {
  const built: { connection?: ReturnType<Server["connect"]> } = {};
  const transactFailed = Promise.withResolvers<void>();
  const transport = queuedFrameTransport({
    async receive(payload) {
      await built.connection!.receive(payload);
      await transport.delivered!();
      const { type } = decodeMemoryBoundary(payload) as { type?: string };
      if (options.failTransacts === true && type === "transact") {
        transactFailed.resolve();
        throw connectionError("port closed");
      }
    },
    close: () => built.connection?.close(),
  });
  built.connection = server.connect((message) =>
    transport.deliver(encodeMemoryBoundary(message))
  );
  return { transport, transactFailed: transactFailed.promise };
};

describe("a commit the server accepted", () => {
  it("settles with its verdict when its own ACL write revokes its session before its send settles", async () => {
    const server = new Server({
      store: new URL("memory://client-accepted-commit-revoked"),
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
      acl: { mode: "enforce" },
    });
    const space = "did:key:z6Mk-client-accepted-commit-revoked";
    const client = await connect({
      transport: portOrderedLoopback(server).transport,
    });
    try {
      // The space's own identity may write the genesis ACL, and an ACL that
      // does not name it revokes the session that wrote it.
      const session = await client.mount(space, {}, signedAs(space));
      const applied = await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [OWNER]: "OWNER" } },
        }],
      });
      expect(applied.seq).toBe(1);
      expect((await server.readDocument(space, `of:${space}`))?.value)
        .toEqual({ [OWNER]: "OWNER" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("settles with its verdict when its session closes after its send failed", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-accepted-commit-closed"),
    });
    const { transport, transactFailed } = portOrderedLoopback(server, {
      failTransacts: true,
    });
    const client = await connect({ transport });
    try {
      const session = await client.mount(
        "did:key:z6Mk-client-accepted-commit-closed",
        {},
        testSessionOpenAuthFactory,
      );
      const committed = session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:closed",
          value: { value: { n: 1 } },
        }],
      });
      // The failed send leaves the commit outstanding, for a replay on the
      // next connection that the close comes before.
      await transactFailed;
      await session.close();
      expect((await committed).seq).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
