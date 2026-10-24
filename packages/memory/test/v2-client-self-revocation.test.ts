/**
 * A commit the server accepted settles with its verdict even when the commit's
 * own ACL write revokes the session that sent it. The server sends the verdict
 * and then the revocation, and over a transport whose send settles only after
 * the frames the server sent while handling it, as a send over a serving
 * worker's port does, both reach the client before the commit's send settles.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { encodeMemoryBoundary } from "../v2.ts";
import {
  connect,
  queuedFrameTransport,
  type SessionOpenAuthFactory,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { TEST_SESSION_OPEN_AUDIENCE } from "./v2-auth-test-helpers.ts";

const OWNER = "did:key:z6Mk-client-self-revocation-owner";

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
 * sent while handling it has reached the client.
 */
const portOrderedLoopback = (server: Server): Transport => {
  const built: { connection?: ReturnType<Server["connect"]> } = {};
  const transport = queuedFrameTransport({
    async receive(payload) {
      await built.connection!.receive(payload);
      await transport.delivered!();
    },
    close: () => built.connection?.close(),
  });
  built.connection = server.connect((message) =>
    transport.deliver(encodeMemoryBoundary(message))
  );
  return transport;
};

describe("client self-revocation", () => {
  it("settles a genesis ACL commit that revokes its own session with the server's verdict", async () => {
    const server = new Server({
      store: new URL("memory://client-self-revocation"),
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
      acl: { mode: "enforce" },
    });
    const space = "did:key:z6Mk-client-self-revocation-space";
    const client = await connect({ transport: portOrderedLoopback(server) });
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
});
