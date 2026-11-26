/**
 * What a server connection does with a request it refuses or cannot carry
 * out: a second `hello`, a request naming a session the connection does not
 * hold, a routed connection's requests that only the router may make, a
 * malformed `connection.auth`, a frame on a closed connection, and an answer
 * that cannot be delivered.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { defer } from "@commonfabric/async/defer";
import { describe, it } from "@commonfabric/test-support/test";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ServerMessage,
  type SessionOpenResult,
} from "../v2.ts";
import { PresenceRooms } from "../v2/presence.ts";
import { type EngineOpener, Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  send,
  type WirePeer,
} from "./support/wire-peer.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-memory-v2-connection-guards-space";
const OTHER_SPACE = "did:key:z6Mk-memory-v2-connection-guards-other";
const PRINCIPAL = "did:key:z6Mk-memory-v2-connection-guards-principal";
const AUDIENCE = "did:key:z6Mk-memory-v2-connection-guards-audience";
const ROOM = "room-0123456789abcdefghijklmnop";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const createServer = (name: string): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-connection-guards-${name}`),
    subscriptionRefreshDelayMs: "manual",
  });

/** A server clock a test moves by hand, in unix seconds. */
type Clock = { now: number };

/**
 * A server that admits routed connections: it enforces ACLs, fences
 * ownership through `owns`, and takes the principal of a `connection.auth`
 * and of a signed `session.open` from its invocation's `iss`, unverified.
 */
const createRoutedServer = (
  name: string,
  clock: Clock,
  owns: (space: string) => boolean = () => true,
): Server =>
  new Server({
    store: new URL(`memory://memory-v2-connection-guards-routed-${name}`),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: (message) =>
      typeof message.invocation?.iss === "string"
        ? message.invocation.iss
        : undefined,
    authorizeConnection: (message) =>
      typeof message.invocation?.iss === "string"
        ? message.invocation.iss
        : undefined,
    sessionOpenAuth: { audience: AUDIENCE, nowSeconds: () => clock.now },
    ownsSpace: owns,
    requireExplicitAcl: false,
    acl: { mode: "enforce" },
  });

/** A routed connection that has completed its `hello`, as a `WirePeer`. */
const connectRoutedPeer = async (
  server: Server,
  owns: (space: string) => boolean = () => true,
): Promise<WirePeer> => {
  const messages: ServerMessage[] = [];
  const connection = server.connectRouted(
    (message) => messages.push(message),
    owns,
  );
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = messages.shift();
  if (hello?.type !== "hello.ok" || hello.sessionOpen === undefined) {
    throw new Error("expected `hello.ok` carrying a challenge");
  }
  return {
    connection,
    messages,
    auth: hello.sessionOpen,
    flags: hello.flags,
  };
};

/** Opens a session on `space` as the routed principal `principal`. */
const openRouted = async (
  peer: WirePeer,
  space: string,
  principal: string,
): Promise<string> => {
  const opened = await request<SessionOpenResult>(peer, {
    type: "session.open",
    space,
    principal,
    session: {},
  });
  if (opened.ok === undefined) {
    throw new Error(`routed open failed: ${opened.error?.message}`);
  }
  return opened.ok.sessionId;
};

describe("server", () => {
  describe("Connection", () => {
    describe("receive()", () => {
      it("answers a second `hello` with a `ProtocolError` on the handshake", async () => {
        const server = createServer("second-hello");
        try {
          const peer = await connectPeer(server);
          await send(peer, HELLO);
          expect(peer.messages).toEqual([{
            type: "response",
            requestId: "handshake",
            error: {
              name: "ProtocolError",
              message: "hello may only be sent once",
            },
          }]);
        } finally {
          await server.close();
        }
      });

      for (
        const [type, body] of [
          ["sqlite.query", { db: { id: "of:db" }, sql: "SELECT 1" }],
          [
            "sqlite.register-disk-source",
            { id: "of:db", path: "/nonexistent.sqlite" },
          ],
          ["session.watch.remove", { watchIds: ["a0"] }],
          [
            "event.attention.resolve",
            {
              eventId: "evt",
              seq: 1,
              sidecarId: "of:sidecar",
              action: "retry",
            },
          ],
          ["space.invite", { invite: { operation: "list", body: {} } }],
        ] as const
      ) {
        it(`answers a \`${type}\` naming a session the connection does not hold with a \`SessionError\``, async () => {
          const server = createServer(`unheld-${type}`);
          try {
            const peer = await connectPeer(server);
            const response = await request(peer, {
              type,
              space: SPACE,
              sessionId: "session-never-opened",
              ...body,
            });
            expect(response.error).toEqual({
              name: "SessionError",
              message: "Session is not open on this connection",
            });
            expect(response.ok).toBeUndefined();
          } finally {
            await server.close();
          }
        });
      }

      it("sends nothing for a presence request on a closed connection", async () => {
        const server = createServer("closed-immediate");
        try {
          const peer = await connectPeer(server);
          const join = {
            type: "presence.join",
            space: SPACE,
            sessionId: "session-never-opened",
            room: ROOM,
          };
          // Open, the connection refuses the unheld session.
          expect((await request(peer, join)).error?.name).toBe("SessionError");
          peer.connection.close();
          await send(peer, { ...join, requestId: "after-close" });
          expect(peer.messages).toEqual([]);
        } finally {
          await server.close();
        }
      });

      it("rejects with the delivery failure when a presence request's answer cannot be sent", async () => {
        const server = createServer("undeliverable-immediate");
        try {
          const connection = server.connect(() => {
            throw new Error("socket gone");
          });
          // Before its `hello`, the connection answers a presence request
          // with a refusal, which the transport fails to take.
          await expect(connection.receive(encodeMemoryBoundary({
            type: "presence.join",
            requestId: "join",
            space: SPACE,
            sessionId: "session-never-opened",
            room: ROOM,
          }))).rejects.toThrow("socket gone");
        } finally {
          await server.close();
        }
      });

      it("answers a presence request with a `QueryError` when the relay fails unexpectedly", async () => {
        const server = createServer("presence-relay-fails");
        try {
          const peer = await connectPeer(server);
          const { sessionId } = await openSession(peer, SPACE);
          using _join = stub(PresenceRooms.prototype, "join", () => {
            throw new TypeError("relay state corrupted");
          });
          using logged = stub(console, "error");
          const response = await request(peer, {
            type: "presence.join",
            space: SPACE,
            sessionId,
            room: ROOM,
          });
          expect(response.error).toEqual({
            name: "QueryError",
            message: "relay state corrupted",
          });
          expect(logged.calls.map((call) => call.args[1])).toEqual([
            new TypeError("relay state corrupted"),
          ]);
        } finally {
          await server.close();
        }
      });

      for (
        const { type, run, body } of [
          {
            type: "pattern.lifecycle",
            run: "runPatternLifecycle",
            body: { verb: "upload", body: { program: { main: "/main.tsx" } } },
          },
          {
            type: "served",
            run: "runServedRequest",
            body: { kind: "append", body: { eventId: "e-1" } },
          },
        ] as const
      ) {
        it(`logs a \`${type}\` run that rejects, and sends no answer`, async () => {
          const server = createServer(`rejected-${type}`);
          try {
            const peer = await connectPeer(server);
            const { sessionId } = await openSession(peer, SPACE);
            const logged = defer<unknown[]>();
            using _run = stub(
              server,
              run,
              () => Promise.reject(new Error("run torn down")),
            );
            using _error = stub(console, "error", (...args: unknown[]) => {
              logged.resolve(args);
            });
            await send(peer, {
              type,
              requestId: `${type}-request`,
              space: SPACE,
              sessionId,
              ...body,
            });
            const [message, error] = await logged.promise;
            expect(message).toContain(`answering a \`${type}\``);
            expect(message).toContain("failed");
            expect((error as Error).message).toBe("run torn down");
            expect(peer.messages).toEqual([]);
          } finally {
            await server.close();
          }
        });
      }
    });

    describe("connection.auth", () => {
      const createAuthServer = (name: string): Server =>
        new Server({
          store: new URL(`memory://memory-v2-connection-guards-auth-${name}`),
          subscriptionRefreshDelayMs: "manual",
          authorizeSessionOpen: () => PRINCIPAL,
          authorizeConnection: () => PRINCIPAL,
          sessionOpenAuth: { audience: AUDIENCE },
        });

      for (
        const { label, invocation, message } of [
          {
            label: "no issuer",
            invocation: (peer: WirePeer) => ({
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
            }),
            message: "memory connection.auth requires authorization",
          },
          {
            label: "no audience",
            invocation: (peer: WirePeer) => ({
              iss: PRINCIPAL,
              challenge: peer.auth.challenge.value,
            }),
            message: "memory connection.auth requires audience",
          },
          {
            label: "no challenge",
            invocation: (peer: WirePeer) => ({
              iss: PRINCIPAL,
              aud: peer.auth.audience,
            }),
            message: "memory connection.auth requires challenge",
          },
        ]
      ) {
        it(`answers an invocation carrying ${label} with a permanent \`AuthorizationError\``, async () => {
          const server = createAuthServer(label.replaceAll(" ", "-"));
          try {
            const peer = await connectPeer(server);
            const response = await request(peer, {
              type: "connection.auth",
              invocation: invocation(peer),
              authorization: {},
            });
            expect(response.error).toEqual({
              name: "AuthorizationError",
              message,
            });
            expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(false);
          } finally {
            await server.close();
          }
        });
      }

      it("authenticates the issuer of a complete invocation", async () => {
        const server = createAuthServer("complete");
        try {
          const peer = await connectPeer(server);
          const response = await request(peer, {
            type: "connection.auth",
            invocation: {
              iss: PRINCIPAL,
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
            },
            authorization: {},
          });
          expect(response.error).toBeUndefined();
          expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(true);
        } finally {
          await server.close();
        }
      });
    });

    describe("waitForReceiveQueueToDrain()", () => {
      it("returns `false` past its deadline while a frame is still being handled, and `true` once none is", async () => {
        const server = createServer("drain-deadline");
        const gate = defer<void>();
        try {
          const peer = await connectPeer(server);
          const { sessionId } = await openSession(peer, SPACE);
          server.accessForTestingOnly.engineOpener = (opening, open) =>
            gate.promise.then(() => open(opening));
          const held = request(peer, {
            type: "graph.query",
            space: SPACE,
            sessionId,
            query: { roots: [] },
          });
          expect(await peer.connection.waitForReceiveQueueToDrain(0)).toBe(
            false,
          );
          gate.resolve();
          expect((await held).error).toBeUndefined();
          expect(
            await peer.connection.waitForReceiveQueueToDrain(Date.now()),
          ).toBe(true);
        } finally {
          gate.resolve();
          await server.close();
        }
      });
    });

    describe("admitRoutedPrincipal()", () => {
      it("throws on a connection that is not routed", async () => {
        const server = createServer("admit-unrouted");
        try {
          const peer = await connectPeer(server);
          expect(() =>
            peer.connection.admitRoutedPrincipal(
              PRINCIPAL,
              Math.floor(Date.now() / 1000) + 600,
            )
          ).toThrow("Routed memory proof is expired or unbound");
          expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(false);
        } finally {
          await server.close();
        }
      });

      it("throws for a proof that has already expired", async () => {
        const clock = { now: 1_000_000 };
        const server = createRoutedServer("admit-expired", clock);
        try {
          const peer = await connectRoutedPeer(server);
          expect(() =>
            peer.connection.admitRoutedPrincipal(PRINCIPAL, clock.now)
          ).toThrow("Routed memory proof is expired or unbound");
          expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(false);
        } finally {
          await server.close();
        }
      });

      it("revokes the principal's sessions when its proof expires, and no other principal's", async () => {
        const clock = { now: 1_000_000 };
        const server = createRoutedServer("admit-expiry", clock);
        try {
          const peer = await connectRoutedPeer(server);
          const revoked = defer<ServerMessage>();
          const push = peer.messages.push.bind(peer.messages);
          peer.messages.push = (...messages: ServerMessage[]) => {
            for (const message of messages) {
              if (message.type === "session/revoked") revoked.resolve(message);
            }
            return push(...messages);
          };
          peer.connection.admitRoutedPrincipal(PRINCIPAL, clock.now + 600);
          peer.connection.admitRoutedPrincipal(
            TEST_SESSION_OPEN_PRINCIPAL,
            clock.now + 600,
          );
          const expiring = await openRouted(peer, SPACE, PRINCIPAL);
          const lasting = await openRouted(
            peer,
            OTHER_SPACE,
            TEST_SESSION_OPEN_PRINCIPAL,
          );
          // A renewed proof that expires a moment from now replaces the
          // first one's timer; the clock then passes it.
          peer.connection.admitRoutedPrincipal(PRINCIPAL, clock.now + 0.001);
          clock.now += 1;
          expect(await revoked.promise).toEqual({
            type: "session/revoked",
            space: SPACE,
            sessionId: expiring,
            reason: "unauthorized",
          });
          expect(peer.connection.hasSession(SPACE, expiring)).toBe(false);
          expect(server.isSessionAttached(SPACE, expiring, peer.connection.id))
            .toBe(false);
          expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(false);
          expect(peer.connection.hasSession(OTHER_SPACE, lasting)).toBe(true);
        } finally {
          await server.close();
        }
      });
    });

    describe("routed requests", () => {
      it("answers a `connection.auth` with an `AuthorizationError`", async () => {
        const clock = { now: 1_000_000 };
        const server = createRoutedServer("routed-auth", clock);
        try {
          const peer = await connectRoutedPeer(server);
          const response = await request(peer, {
            type: "connection.auth",
            invocation: {
              iss: PRINCIPAL,
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
            },
            authorization: {},
          });
          expect(response.error).toEqual({
            name: "AuthorizationError",
            message: "Routed proofs require the router link",
          });
          expect(peer.connection.hasPrincipal(PRINCIPAL)).toBe(false);
        } finally {
          await server.close();
        }
      });

      for (
        const { label, open } of [
          {
            label: "naming no principal",
            open: () => ({ space: SPACE, session: {} }),
          },
          {
            label: "for a space the host does not own",
            open: () => ({
              space: OTHER_SPACE,
              principal: PRINCIPAL,
              session: {},
            }),
          },
          {
            label: "carrying its own signature",
            open: (peer: WirePeer) => ({
              space: SPACE,
              principal: PRINCIPAL,
              session: {},
              invocation: {
                iss: PRINCIPAL,
                aud: peer.auth.audience,
                challenge: peer.auth.challenge.value,
              },
            }),
          },
        ]
      ) {
        it(`answers a \`session.open\` ${label} with an \`AuthorizationError\``, async () => {
          const clock = { now: 1_000_000 };
          const owns = (space: string) => space === SPACE;
          const server = createRoutedServer(
            `routed-open-${label.replaceAll(" ", "-")}`,
            clock,
            owns,
          );
          try {
            const peer = await connectRoutedPeer(server, owns);
            peer.connection.admitRoutedPrincipal(PRINCIPAL, clock.now + 600);
            const response = await request<SessionOpenResult>(peer, {
              type: "session.open",
              ...open(peer),
            });
            expect(response.error).toEqual({
              name: "AuthorizationError",
              message: "Routed memory request denied",
            });
            // The same principal opens the owned space unsigned.
            expect(await openRouted(peer, SPACE, PRINCIPAL)).toEqual(
              expect.any(String),
            );
          } finally {
            await server.close();
          }
        });
      }
    });
  });

  describe("connectRouted()", () => {
    it("throws on a server that does not enforce ACLs", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-connection-guards-routed-observe"),
        subscriptionRefreshDelayMs: "manual",
        ownsSpace: () => true,
        acl: { mode: "observe" },
      });
      try {
        expect(() => server.connectRouted(() => {}, () => true)).toThrow(
          "Routed memory requires enforced ACLs and ownership fencing",
        );
      } finally {
        await server.close();
      }
    });

    it("throws on a server that fences no ownership", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-connection-guards-routed-unfenced"),
        subscriptionRefreshDelayMs: "manual",
        acl: { mode: "enforce" },
      });
      try {
        expect(() => server.connectRouted(() => {}, () => true)).toThrow(
          "Routed memory requires enforced ACLs and ownership fencing",
        );
      } finally {
        await server.close();
      }
    });
  });

  describe("accessForTestingOnly", () => {
    describe("engineOpener", () => {
      it("returns the opener a test installed, which then wraps every engine open", async () => {
        const server = createServer("engine-opener");
        try {
          const access = server.accessForTestingOnly;
          expect(access.engineOpener).toBeUndefined();
          const opened: string[] = [];
          const opener: EngineOpener = (space, open) => {
            opened.push(space);
            return open(space);
          };
          access.engineOpener = opener;
          expect(access.engineOpener).toBe(opener);
          await server.engineForSpace(SPACE);
          expect(opened).toEqual([SPACE]);
          access.engineOpener = undefined;
          expect(access.engineOpener).toBeUndefined();
        } finally {
          await server.close();
        }
      });
    });
  });
});
