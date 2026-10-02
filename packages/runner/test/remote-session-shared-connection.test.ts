import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ClientMessage,
  decodeTrustedMemoryBoundary,
} from "@commonfabric/memory/v2";
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

  /** Uncompressed client requests submitted through the transport. */
  sent: ClientMessage[];
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
    const sent: ClientMessage[] = [];
    const createSocket: MemorySocketFactory = (address) => {
      dialed.push(address);
      const connected = createNativeMemorySocket(address);
      return {
        socket: connected.socket,
        send: (frame) => {
          if (typeof frame === "string") {
            sent.push(decodeTrustedMemoryBoundary<ClientMessage>(frame));
          }
          return connected.send(frame);
        },
      };
    };
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(server.url, options.spaceHostMap),
      user,
      createSocket,
    );
    factory.setSharedConnections(options.shared);
    factories.push(factory);
    return { factory, dialed, sent };
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

  describe("authentication with sharing off", () => {
    for (const connectionAuth of [false, true]) {
      it(`uses the server's authentication capability when connectionAuth is ${connectionAuth}`, async () => {
        const server = startServer({ connectionAuth });
        const { factory, dialed, sent } = harnessFor(server, { shared: false });
        await factory.setMessageCompressionEnabled(false);
        const opened = await factory.create(SPACES[0]);
        try {
          expect(dialed).toHaveLength(1);
          expect(dialed[0].searchParams.get("space")).toBe(SPACES[0]);
          expect(principalsIn(server, SPACES[0])).toEqual([user.did()]);
          expect(sent.filter((message) => message.type === "connection.auth"))
            .toHaveLength(connectionAuth ? 1 : 0);
          const opens = sent.filter((message) =>
            message.type === "session.open"
          );
          expect(opens).toHaveLength(1);
          expect(opens[0].principal).toBe(
            connectionAuth ? user.did() : undefined,
          );
          expect(opens[0].invocation !== undefined).toBe(!connectionAuth);
          expect(opens[0].authorization !== undefined).toBe(!connectionAuth);
        } finally {
          await opened.client.close();
        }
      });
    }
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

    it("closes while a dial is still opening, and refuses a create whose signal aborts meanwhile", async () => {
      // A socket that never opens: the dial answers nobody until the
      // transport closes under it.
      const server = startServer({ connectionAuth: true });
      const dialed: URL[] = [];
      const factory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        user,
        (address) => {
          dialed.push(address);
          const socket = createNativeMemorySocket(address);
          const silent: typeof socket.socket = {
            get readyState() {
              return socket.socket.readyState;
            },
            addEventListener(type, listener, options) {
              if (type !== "open") {
                socket.socket.addEventListener(type, listener, options);
              }
            },
            close: (code, reason) => socket.socket.close(code, reason),
          };
          return { socket: silent, send: socket.send };
        },
      );
      factory.setSharedConnections(true);
      factories.push(factory);
      const controller = new AbortController();
      const waiting = factory.create(SPACES[0], user, {}, controller.signal);
      const opening = factory.create(SPACES[1]);
      controller.abort(new Error("route replaced"));
      await expect(waiting).rejects.toThrow("route replaced");
      await factory.close();
      // What the socket reports when closed under it is the transport's;
      // that the create settles at all is the claim.
      expect(await opening.then(() => "opened", () => "refused")).toBe(
        "refused",
      );
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
