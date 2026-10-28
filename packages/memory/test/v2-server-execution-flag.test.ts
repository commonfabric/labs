import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { authorizeLoopbackSessionOpen } from "../v2/session-open-auth.ts";

describe("the `serverExecution` hello flag", () => {
  let server: Server;
  let serverCount = 0;

  beforeEach(() => {
    server = new Server({
      store: new URL(`memory://server-execution-flag-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-server-execution-flag" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  /** The flags a fresh connection's handshake reports, before any mount. */
  const helloFlags = async () => {
    const client = await connect({ transport: loopback(server) });
    try {
      return client.serverFlags;
    } finally {
      await client.close();
    }
  };

  it("is `false` from a server with no server execution attached", async () => {
    expect((await helloFlags())?.serverExecution).toBe(false);
  });

  it("is `true` while server execution is attached, and `false` once it is detached", async () => {
    server.setServerExecutionObserver({});
    expect((await helloFlags())?.serverExecution).toBe(true);
    server.setServerExecutionObserver(undefined);
    expect((await helloFlags())?.serverExecution).toBe(false);
  });
});
