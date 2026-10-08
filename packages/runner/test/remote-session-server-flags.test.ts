import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  createNativeMemorySocket,
  type MemorySocketConnection,
} from "../src/storage/memory-socket.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";

const SPACE = "did:key:z6Mk-remote-server-flags" as MemorySpace;

describe("RemoteSessionFactory.serverFlags()", () => {
  let server: StandaloneMemoryServer;
  let factory: RemoteSessionFactory;

  beforeEach(async () => {
    server = StandaloneMemoryServer.start({ connectionAuth: true });
    factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url),
      await Identity.fromPassphrase("remote server flags user"),
    );
  });

  afterEach(async () => {
    await factory.close();
    await server.close();
  });

  for (const shared of [false, true]) {
    describe(`with connection sharing ${shared ? "on" : "off"}`, () => {
      it("returns the server's flags without opening a session on the space", async () => {
        factory.setSharedConnections(shared);
        server.server.setServerExecutionObserver({});

        const flags = await factory.serverFlags(SPACE);
        expect(flags?.serverExecution).toBe(true);
        expect(server.server.accessForTestingOnly.sessionsForSpace(SPACE))
          .toEqual([]);
      });
    });
  }

  it("waits out a shared connection's reconnection and returns the new server's flags", async () => {
    // A connection that redials lands on whichever server `target` names, so
    // the server behind a shared connection can change while it reconnects.
    const next = StandaloneMemoryServer.start({ connectionAuth: true });
    let target = server;
    const sockets: MemorySocketConnection[] = [];
    const redialed = Promise.withResolvers<void>();
    const redirecting = new RemoteSessionFactory(
      createStorageAddressResolver(server.url),
      await Identity.fromPassphrase("remote server flags user"),
      (address) => {
        const routed = new URL(address);
        routed.host = target.url.host;
        const connection = createNativeMemorySocket(routed);
        sockets.push(connection);
        if (sockets.length === 2) redialed.resolve();
        return connection;
      },
    );
    try {
      redirecting.setSharedConnections(true);
      server.server.setServerExecutionObserver({});
      expect((await redirecting.serverFlags(SPACE))?.serverExecution)
        .toBe(true);

      // The connection drops and redials a server without server execution;
      // until that handshake is done, the connection holds the first
      // server's flags.
      target = next;
      sockets[0].socket.close();
      await redialed.promise;
      expect((await redirecting.serverFlags(SPACE))?.serverExecution)
        .toBe(false);
    } finally {
      await redirecting.close();
      await next.close();
    }
  });
});
