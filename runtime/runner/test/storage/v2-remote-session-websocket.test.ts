import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientMessage,
  decodeTrustedMemoryBoundary,
} from "@commonfabric/memory/v2";
import type { SpaceSession } from "@commonfabric/memory/v2/client";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import { namesInstancesByDefault } from "../../src/builder/instance-name.ts";
import {
  createNativeMemorySocket,
  type MemorySocket,
  type MemorySocketFactory,
} from "../../src/storage/memory-socket.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../../src/storage/v2-remote-session.ts";
import { drivableSockets } from "./drivable-web-socket.ts";

const owner = await Identity.fromPassphrase("v2-remote-session owner");
const guest = await Identity.fromPassphrase("v2-remote-session guest");
const SPACES = [
  "did:key:z6Mk-v2-remote-session-one",
  "did:key:z6Mk-v2-remote-session-two",
] as MemorySpace[];

describe("v2-remote-session", () => {
  describe("RemoteSessionFactory", () => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    });

    const startServer = (
      options: { connectionAuth?: boolean; acl?: { mode: "enforce" } } = {},
    ): StandaloneMemoryServer => {
      const server = StandaloneMemoryServer.start({
        namesInstances: namesInstancesByDefault,
        ...options,
      });
      cleanups.push(() => server.close());
      return server;
    };

    /**
     * A factory onto `server` as `signer`, every socket it has dialed, and
     * the uncompressed client messages it has sent.
     */
    const factoryOver = (
      server: StandaloneMemoryServer,
      shared: boolean,
      signer: Signer = owner,
      createSocket: MemorySocketFactory = createNativeMemorySocket,
    ) => {
      const sockets: MemorySocket[] = [];
      const sent: ClientMessage[] = [];
      const factory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        signer,
        (address) => {
          const connected = createSocket(address);
          sockets.push(connected.socket);
          return {
            socket: connected.socket,
            send: (frame) => {
              if (typeof frame === "string" && frame.startsWith("fvj1:")) {
                sent.push(decodeTrustedMemoryBoundary<ClientMessage>(frame));
              }
              return connected.send(frame);
            },
          };
        },
      );
      factory.setSharedConnections(shared);
      cleanups.push(() => factory.close());
      return { factory, sockets, sent };
    };

    describe("create()", () => {
      it("refuses a shared create whose signal has already aborted, without making a connection", async () => {
        const sockets = drivableSockets();
        const factory = new RemoteSessionFactory(
          createStorageAddressResolver(new URL("http://memory.test")),
          owner,
          sockets.createSocket,
        );
        cleanups.push(() => factory.close());
        factory.setSharedConnections(true);
        const reason = new Error("route replaced");
        const controller = new AbortController();
        controller.abort(reason);

        await expect(
          factory.create(SPACES[0], owner, {}, controller.signal),
        ).rejects.toBe(reason);
        expect(factory.getSizes().transports).toBe(0);
        expect(sockets.dials).toEqual([]);
      });

      it("replaces a shared connection that has failed for good with a new one", async () => {
        const server = startServer({ connectionAuth: true });
        // The second socket's server reads, to this client, as one that does
        // not enforce stable expression result identities, a failure no
        // reconnect can heal.
        const secondDial = Promise.withResolvers<void>();
        let dials = 0;
        const { factory, sockets } = factoryOver(
          server,
          true,
          owner,
          (address) => {
            const connected = createNativeMemorySocket(address);
            if (++dials !== 2) return connected;
            secondDial.resolve();
            const { socket } = connected;
            const outdated: MemorySocket = {
              get readyState() {
                return socket.readyState;
              },
              addEventListener(type, listener, options) {
                if (type !== "message") {
                  socket.addEventListener(type, listener, options);
                  return;
                }
                socket.addEventListener("message", (event) =>
                  listener({
                    type: event.type,
                    data: typeof event.data === "string"
                      ? event.data.replace(
                        '"stableExpressionResultIds":true',
                        '"stableExpressionResultIds":false',
                      )
                      : event.data,
                  }), options);
              },
              close: (code, reason) => socket.close(code, reason),
            };
            return { socket: outdated, send: connected.send };
          },
        );
        await factory.create(SPACES[0]);
        sockets[0].close();
        await withStuckNet(secondDial.promise, "the reconnect's dial");
        // Settles once the reconnect has given up.
        await expect(factory.serverFlags(SPACES[0])).rejects.toThrow(
          "does not enforce stable expression result identities",
        );

        const { session } = await factory.create(SPACES[1]);
        expect(sockets).toHaveLength(3);
        expect((await session.queryGraph({ roots: [] })).serverSeq).toBe(0);
      });
    });

    describe("serverFlags()", () => {
      it("refuses a shared connection's flags when its signal has already aborted", async () => {
        const server = startServer({ connectionAuth: true });
        const { factory } = factoryOver(server, true);
        await factory.create(SPACES[0]);
        expect(await factory.serverFlags(SPACES[0])).toMatchObject({
          connectionAuth: true,
        });

        const reason = new Error("route replaced");
        const controller = new AbortController();
        controller.abort(reason);
        await expect(factory.serverFlags(SPACES[0], controller.signal))
          .rejects.toBe(reason);
      });
    });

    describe("a session's share of a shared connection", () => {
      for (const connectionAuth of [false, true]) {
        it(`returns the flags the connection's server advertised, connectionAuth ${connectionAuth}`, async () => {
          const server = startServer({ connectionAuth });
          const { factory } = factoryOver(server, true);
          const { client } = await factory.create(SPACES[0]);
          expect(client.serverFlags?.connectionAuth).toBe(connectionAuth);
        });
      }

      it("resolves delivered() at once, since the websocket hands each frame over as it arrives", async () => {
        const server = startServer({ connectionAuth: true });
        const { factory } = factoryOver(server, true);
        const { client } = await factory.create(SPACES[0]);
        await expect(client.delivered()).resolves.toBeUndefined();
      });

      it("releases a principal the connection authenticated, and sends nothing for one it did not", async () => {
        const server = startServer({ connectionAuth: true });
        const { factory, sent } = factoryOver(server, true);
        await factory.setMessageCompressionEnabled(false);
        const { client } = await factory.create(SPACES[0]);
        const releases = () =>
          sent.filter((message) => message.type === "connection.release");

        await client.releasePrincipal!(guest.did());
        expect(releases()).toEqual([]);

        await client.releasePrincipal!(owner.did());
        expect(releases()).toMatchObject([{ principal: owner.did() }]);
      });
    });

    describe("subscribeAdmissible()", () => {
      it("calls its observers with a space that would now admit a principal it refused, and no observer that unsubscribed", async () => {
        const server = startServer({
          connectionAuth: true,
          acl: { mode: "enforce" },
        });
        const space = owner.did();
        const ownerFactory = factoryOver(server, false).factory;
        const opened = await ownerFactory.create(space);
        cleanups.push(() => opened.client.close());
        const ownerSession: SpaceSession = opened.session;
        const writeAcl = (localSeq: number, grants: Record<string, "READ">) =>
          ownerSession.transact({
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [owner.did()]: "OWNER", ...grants } },
            }],
          });
        await writeAcl(1, {});
        const { factory } = factoryOver(server, true, guest);
        const errors = stub(console, "error", () => {});
        cleanups.push(() => Promise.resolve(errors.restore()));
        const failure = new Error("observer failure");
        factory.subscribeAdmissible(() => {
          throw failure;
        });
        const kept: [string, string][] = [];
        const dropped: [string, string][] = [];
        factory.subscribeAdmissible((admitted, principal) =>
          kept.push([admitted, principal])
        );
        const cancel = factory.subscribeAdmissible((admitted, principal) =>
          dropped.push([admitted, principal])
        );
        cancel();
        await expect(factory.create(space)).rejects.toMatchObject({
          name: "AuthorizationError",
          message: `Principal ${guest.did()} lacks READ on space ${space}`,
        });

        await writeAcl(2, { [guest.did()]: "READ" });
        // A later round trip on the same socket, which the notice is ordered
        // before.
        await factory.create(guest.did());

        expect(kept).toEqual([[space, guest.did()]]);
        expect(dropped).toEqual([]);
        expect(errors.calls.map((call) => call.args)).toEqual([
          ["session-admissible subscriber threw:", failure],
        ]);
      });
    });

    describe("subscribeReconnected()", () => {
      it("calls every observer after one that throws, and none that unsubscribed", async () => {
        const server = startServer();
        const { factory, sockets } = factoryOver(server, false);
        const errors = stub(console, "error", () => {});
        cleanups.push(() => Promise.resolve(errors.restore()));
        const kept = Promise.withResolvers<void>();
        let dropped = 0;
        factory.subscribeReconnected(() => {
          throw new Error("observer failure");
        });
        factory.subscribeReconnected(() => kept.resolve());
        const cancel = factory.subscribeReconnected(() => dropped++);
        cancel();
        const { client } = await factory.create(SPACES[0]);
        cleanups.push(() => client.close());

        sockets[0].close();
        await withStuckNet(kept.promise, "the restored connection's report");

        expect(dropped).toBe(0);
        expect(
          errors.calls.filter((call) =>
            call.args[0] === "reconnected subscriber threw:"
          ).map((call) => call.args[1]),
        ).toMatchObject([{ message: "observer failure" }]);
      });
    });
  });
});
