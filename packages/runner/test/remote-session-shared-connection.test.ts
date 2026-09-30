import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  createNativeMemorySocket,
  type MemorySocketFactory,
} from "../src/storage/memory-socket.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";

const SPACES = [
  "did:key:z6Mk-shared-connection-one",
  "did:key:z6Mk-shared-connection-two",
  "did:key:z6Mk-shared-connection-three",
] as MemorySpace[];

/** A factory onto a server, and the address of every socket it has dialed. */
type Harness = {
  factory: RemoteSessionFactory;
  dialed: URL[];
};

describe("RemoteSessionFactory connection sharing", () => {
  let user: Identity;
  let spaceIdentity: Identity;
  let servers: StandaloneMemoryServer[];
  let factories: RemoteSessionFactory[];

  beforeEach(async () => {
    user = await Identity.fromPassphrase("shared connection user");
    spaceIdentity = await Identity.fromPassphrase("shared connection space");
    servers = [];
    factories = [];
  });

  afterEach(async () => {
    await Promise.all(factories.map((factory) => factory.close()));
    await Promise.all(servers.map((server) => server.close()));
  });

  const startServer = (
    options: { connectionAuth?: boolean } = {},
  ): StandaloneMemoryServer => {
    const server = StandaloneMemoryServer.start(options);
    servers.push(server);
    return server;
  };

  const harnessFor = (
    server: StandaloneMemoryServer,
    options: {
      shared: boolean;
      spaceHostMap?: Record<string, string>;
    },
  ): Harness => {
    const dialed: URL[] = [];
    const createSocket: MemorySocketFactory = (address) => {
      dialed.push(address);
      return createNativeMemorySocket(address);
    };
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url, options.spaceHostMap),
      user,
      createSocket,
    );
    factory.setSharedConnections(options.shared);
    factories.push(factory);
    return { factory, dialed };
  };

  /** The principal of every session of `space` a connection holds. */
  const principalsIn = (
    server: StandaloneMemoryServer,
    space: string,
  ): (string | undefined)[] =>
    server.server.accessForTestingOnly.sessionsForSpace(space)
      .filter((session) => session.ownerConnectionId !== null)
      .map((session) => session.principal);

  describe("with sharing off", () => {
    it("dials one socket per space, each naming its space", async () => {
      const server = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(server, { shared: false });
      const opened = await Promise.all(
        SPACES.map((space) => factory.create(space)),
      );
      try {
        expect(
          dialed.map((address) => address.searchParams.get("space")).toSorted(),
        ).toEqual(SPACES.toSorted());
        for (const space of SPACES) {
          expect(principalsIn(server, space)).toEqual([user.did()]);
        }
      } finally {
        await Promise.all(opened.map(({ client }) => client.close()));
      }
    });
  });

  describe("with sharing on", () => {
    it("dials one socket for spaces opened together on one host", async () => {
      const server = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(server, { shared: true });
      await Promise.all(SPACES.map((space) => factory.create(space)));
      expect(dialed).toHaveLength(1);
      expect(dialed[0].searchParams.has("space")).toBe(false);
      for (const space of SPACES) {
        expect(principalsIn(server, space)).toEqual([user.did()]);
      }
    });

    it("dials one socket for a host that does not advertise `connectionAuth`", async () => {
      const server = startServer({ connectionAuth: false });
      const { factory, dialed } = harnessFor(server, { shared: true });
      await Promise.all(SPACES.map((space) => factory.create(space)));
      expect(dialed).toHaveLength(1);
      for (const space of SPACES) {
        expect(principalsIn(server, space)).toEqual([user.did()]);
      }
    });

    it("opens sessions as two signers on the one socket", async () => {
      const server = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(server, { shared: true });
      await factory.create(SPACES[0]);
      await factory.create(SPACES[0], spaceIdentity, {
        sessionId: "session:as-space",
      });
      expect(dialed).toHaveLength(1);
      expect(principalsIn(server, SPACES[0]).toSorted()).toEqual(
        [user.did(), spaceIdentity.did()].toSorted(),
      );
    });

    it("dials one socket per host", async () => {
      const home = startServer({ connectionAuth: true });
      const other = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(home, {
        shared: true,
        spaceHostMap: { [SPACES[2]]: other.url.origin },
      });
      await Promise.all(SPACES.map((space) => factory.create(space)));
      expect(dialed.map((address) => address.host).toSorted()).toEqual(
        [home.url.host, other.url.host].toSorted(),
      );
      expect(principalsIn(other, SPACES[2])).toEqual([user.did()]);
    });

    it("ends one session when its connection is closed, and keeps the socket for the others", async () => {
      const server = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(server, { shared: true });
      const closing = await factory.create(SPACES[0]);
      const staying = await factory.create(SPACES[1]);
      await closing.client.close();
      // The close's frame reached the server before the query's, and the
      // server ends a session in the turn that frame is handled in, so the
      // query's response finds the session gone.
      expect((await staying.session.queryGraph({ roots: [] })).serverSeq).toBe(
        0,
      );
      expect(principalsIn(server, SPACES[0])).toEqual([]);
      expect(principalsIn(server, SPACES[1])).toEqual([user.did()]);

      await factory.create(SPACES[2]);
      expect(dialed).toHaveLength(1);
    });

    it("dials again after `close()`", async () => {
      const server = startServer({ connectionAuth: true });
      const { factory, dialed } = harnessFor(server, { shared: true });
      await factory.create(SPACES[0]);
      await factory.close();
      await factory.create(SPACES[1]);
      expect(dialed).toHaveLength(2);
    });
  });
});
