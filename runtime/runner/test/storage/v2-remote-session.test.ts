import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  type ClientMessage,
  decodeMemoryBoundary,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
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
  createSignedConnectionAuth,
  createStorageAddressResolver,
  MemoryDialLimiter,
  RemoteSessionFactory,
  WebSocketTransport,
} from "../../src/storage/v2-remote-session.ts";
import {
  type DrivableSockets,
  drivableSockets,
  type DrivableWebSocket,
} from "./drivable-web-socket.ts";

const owner = await Identity.fromPassphrase("v2-remote-session owner");
const guest = await Identity.fromPassphrase("v2-remote-session guest");
const SPACES = [
  "did:key:z6Mk-v2-remote-session-one",
  "did:key:z6Mk-v2-remote-session-two",
] as MemorySpace[];

/** A blob whose bytes are read only once the test releases them. */
class HeldBlob extends Blob {
  readonly reading = Promise.withResolvers<void>();
  readonly #contents = Promise.withResolvers<ArrayBuffer>();

  /** Hands the reader `contents`. */
  release(contents: Uint8Array<ArrayBuffer>): void {
    this.#contents.resolve(contents.buffer);
  }

  /** Fails the read with `error`. */
  fail(error: Error): void {
    this.#contents.reject(error);
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.reading.resolve();
    return this.#contents.promise;
  }
}

/** Encodes the router's acknowledgement of `bytes` uploaded bytes. */
const creditFrame = (bytes: number): Uint8Array<ArrayBuffer> => {
  const frame = new Uint8Array([0x6d, 0x72, 0x63, 0x01, 0, 0, 0, 0]);
  new DataView(frame.buffer).setUint32(4, bytes, false);
  return frame;
};

describe("v2-remote-session", () => {
  describe("MemoryDialLimiter", () => {
    describe("constructor()", () => {
      for (const perHost of [0, -1, 1.5, Number.NaN]) {
        it(`throws a RangeError given ${perHost} dials per host`, () => {
          expect(() => new MemoryDialLimiter(perHost)).toThrow(
            RangeError,
          );
        });
      }

      it("admits one dial at a time given one dial per host", () => {
        const limiter = new MemoryDialLimiter(1);
        const first = Promise.withResolvers<void>();
        const started: string[] = [];
        const host = new URL("ws://memory.test/");
        limiter.enqueue(host, () => {
          started.push("first");
          return first.promise;
        });
        limiter.enqueue(host, () => {
          started.push("second");
          return Promise.resolve();
        });
        expect(started).toEqual(["first"]);
        first.resolve();
      });
    });
  });

  describe("WebSocketTransport", () => {
    /** A transport over drivable sockets, and the sockets it has dialed. */
    const drivenTransport = (): {
      transport: WebSocketTransport;
      sockets: DrivableSockets;
    } => {
      const sockets = drivableSockets();
      const transport = new WebSocketTransport(
        new URL("ws://memory.test/api/storage/memory"),
        true,
        () => {},
        sockets.createSocket,
      );
      return { transport, sockets };
    };

    /** Sends a hello on `transport` and opens the socket it dials. */
    const openSocket = async (
      transport: WebSocketTransport,
      sockets: DrivableSockets,
    ): Promise<DrivableWebSocket> => {
      const hello = transport.send('fvj1:{"type":"hello"}');
      const socket = sockets.dials.at(-1)!;
      socket.openConnection();
      await hello;
      return socket;
    };

    /** Opens a socket and selects router streaming with `window` credit. */
    const selectCredits = async (
      transport: WebSocketTransport,
      sockets: DrivableSockets,
      window: number,
    ): Promise<DrivableWebSocket> => {
      const socket = await openSocket(transport, sockets);
      transport.setRoutedMessagesEnabled(true, 1, window);
      await socket.whenSent(2);
      return socket;
    };

    describe("setRoutedMessagesEnabled()", () => {
      it("sends no transport selection on a socket reset before the selection's turn", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const first = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true, 1);
          transport.reset();
          const second = await openSocket(transport, sockets);
          expect(first.sent).toEqual(['fvj1:{"type":"hello"}']);
          expect(second.sent).toEqual(['fvj1:{"type":"hello"}']);

          // The same selection made on an open socket is sent there.
          transport.setRoutedMessagesEnabled(true, 1);
          await second.whenSent(2);
          expect(second.sent[1]).toBe(
            'fvj1:{"type":"router.transport","version":1}',
          );
        } finally {
          await transport.close();
        }
      });
    });

    describe("receiving", () => {
      it("does not count credit read from a reset socket toward the upload blocked on its replacement", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const old = await selectCredits(transport, sockets, 32_773);
          const stale = new HeldBlob();
          old.receive(stale);
          await stale.reading.promise;
          transport.reset();
          const active = await selectCredits(transport, sockets, 32_773);
          const upload = transport.send(
            `fvj1:${
              JSON.stringify({ type: "transact", value: "x".repeat(40_000) })
            }`,
          );
          const rejected = expect(upload).rejects.toMatchObject({
            name: "ConnectionError",
          });
          // The header record fits the window; the first body record waits.
          await active.whenSent(3);
          const header = active.sent[2];
          if (typeof header === "string") throw new Error("Expected a record");

          stale.release(creditFrame(header.length));
          await clock.settle();
          expect(active.sent).toHaveLength(3);

          // The same credit from the replacement releases the upload.
          active.receive(creditFrame(header.length).buffer);
          await active.whenSent(4);
          expect(active.readyState).toBe(1);
          await transport.close();
          await rejected;
        } finally {
          await transport.close();
        }
      });

      it("reports and closes a socket whose frame failed to decode even when describing the failure throws", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const socket = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true);
          const closed = Promise.withResolvers<Error | undefined>();
          transport.setCloseReceiver(closed.resolve);
          const frame = new HeldBlob();
          socket.receive(frame);
          await frame.reading.promise;
          // An error whose name cannot be read, which the decode-failure
          // record reads.
          const cause = new (class extends Error {
            override get name(): string {
              throw new Error("unreadable name");
            }
          })("unreadable blob");
          frame.fail(cause);

          const error = await closed.promise;
          expect(error?.message).toBe(
            "Unable to decode compressed memory websocket message",
          );
          expect(error?.cause).toBe(cause);
          expect(socket.readyState).toBe(3);
        } finally {
          await transport.close();
        }
      });
    });

    describe("requestMessageCompression()", () => {
      it("sends its control as a memory boundary over routed messages without credit, and returns the answer", async () => {
        const { transport, sockets } = drivenTransport();
        try {
          const socket = await openSocket(transport, sockets);
          transport.setRoutedMessagesEnabled(true);
          transport.setMessageCompressionEnabled(true);
          const changing = transport.requestMessageCompression(false);
          await socket.whenSent(2);
          const control = socket.sent[1];
          if (typeof control !== "string") throw new Error("Expected text");
          const decoded = decodeMemoryBoundary<{
            type: string;
            requestId: string;
            enabled: boolean;
          }>(control);
          expect(decoded).toMatchObject({
            type: "memory.compression",
            enabled: false,
          });

          socket.receive(encodeMemoryBoundary({
            type: "memory.compression",
            requestId: decoded.requestId,
            enabled: false,
          }));
          expect(await changing).toBe(false);
        } finally {
          await transport.close();
        }
      });
    });
  });

  describe("createSignedConnectionAuth()", () => {
    it("throws the error its signer reports", async () => {
      const failure = new Error("signer refused");
      const signer: Signer = {
        did: () => owner.did(),
        sign: () => Promise.resolve({ error: failure }),
        verifier: owner.verifier,
      };
      await expect(
        createSignedConnectionAuth(signer, {
          audience: owner.did(),
          challenge: { value: "11".repeat(32), expiresAt: 0 },
        }),
      ).rejects.toBe(failure);
    });
  });

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
        });

        await writeAcl(2, { [guest.did()]: "READ" });
        // A later round trip on the same socket, which the notice is ordered
        // before.
        await factory.create(guest.did());

        expect(kept).toEqual([[space, guest.did()]]);
        expect(dropped).toEqual([]);
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
