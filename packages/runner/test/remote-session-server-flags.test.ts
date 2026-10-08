import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

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
});
