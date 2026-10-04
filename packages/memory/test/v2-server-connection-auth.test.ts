import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Identity } from "@commonfabric/identity";

import type {
  ConnectionAuthResult,
  ConnectionChallengeResult,
  ResponseMessage,
  SessionOpenResult,
  WatchSetResult,
} from "../v2.ts";
import { verifyConnectionAuthorization } from "../v2/connection-auth.ts";
import {
  MAX_CONNECTION_AUTH_LEASE_SECONDS,
  MAX_CONNECTION_PRINCIPALS,
  Server,
} from "../v2/server.ts";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";
import { alice, bob, mallory, space } from "./principal.ts";
import {
  type ConnectionAuthFields,
  signConnectionAuth,
} from "./support/connection-auth.ts";
import {
  connectPeer,
  request,
  requestId,
  send,
  takeResponse,
  type WirePeer,
} from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const AUDIENCE = bob.did();
const SPACE = space.did();
const OTHER_SPACE = "did:key:z6Mk-connection-auth-other-space";

/** A server clock a test moves by hand, in unix seconds. */
type Clock = { now: number };

const createServer = (
  name: string,
  options: { clock?: Clock; acl?: "enforce" } = {},
): Server =>
  new Server({
    store: new URL(`memory://memory-v2-connection-auth-${name}`),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: verifySessionOpenAuthorization,
    // The verifier reads the clock the server reads.
    authorizeConnection: (message, context) =>
      verifyConnectionAuthorization(message, {
        ...context,
        ...(options.clock === undefined
          ? {}
          : { nowSeconds: options.clock.now }),
      }),
    sessionOpenAuth: {
      audience: AUDIENCE,
      ...(options.clock === undefined
        ? {}
        : { nowSeconds: () => options.clock!.now }),
    },
    ...(options.acl === undefined ? {} : { acl: { mode: options.acl } }),
  });

const nowSeconds = (clock?: Clock): number =>
  clock?.now ?? Math.floor(Date.now() / 1000);

/** Authenticates `signer` on the peer's connection over its challenge. */
const authenticate = async (
  peer: WirePeer,
  signer: Identity,
  fields: ConnectionAuthFields = {},
  clock?: Clock,
): Promise<ResponseMessage<ConnectionAuthResult>> =>
  request<ConnectionAuthResult>(peer, {
    type: "connection.auth",
    ...await signConnectionAuth(signer, {
      aud: peer.auth.audience,
      challenge: peer.auth.challenge.value,
      iat: nowSeconds(clock),
      exp: nowSeconds(clock) + 300,
      ...fields,
    }),
  });

/** Opens a session on `space` as `principal`, carrying no signature. */
const open = (peer: WirePeer, space: string, principal: string) =>
  request<SessionOpenResult>(peer, {
    type: "session.open",
    space,
    principal,
    session: {},
  });

const query = (peer: WirePeer, space: string, sessionId: string) =>
  request(peer, {
    type: "graph.query",
    space,
    sessionId,
    query: { roots: [] },
  });

describe("connection authentication", () => {
  describe("the `connectionAuth` flag", () => {
    it("is advertised by a server whose host verifies `connection.auth`", async () => {
      const server = createServer("flag-on");
      try {
        expect((await connectPeer(server)).flags.connectionAuth).toBe(true);
      } finally {
        await server.close();
      }
    });

    it("is not advertised by a server whose host verifies only `session.open`", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-connection-auth-flag-off"),
      });
      try {
        const peer = await connectPeer(server);
        expect(peer.flags.connectionAuth).toBe(false);
        const refused = await authenticate(peer, alice);
        expect(refused.error).toEqual({
          name: "AuthorizationError",
          message: "memory connection.auth is not verified by this server",
        });
      } finally {
        await server.close();
      }
    });
  });

  describe("connection.auth", () => {
    it("responds with the issuer of a signed challenge", async () => {
      const server = createServer("accepts");
      try {
        const peer = await connectPeer(server);
        expect((await authenticate(peer, alice)).ok?.principal).toBe(
          alice.did(),
        );
      } finally {
        await server.close();
      }
    });

    it("responds with a permanent `AuthorizationError` for another server's audience", async () => {
      const server = createServer("audience");
      try {
        const peer = await connectPeer(server);
        const refused = await authenticate(peer, alice, {
          aud: mallory.did(),
        });
        expect(refused.error).toEqual({
          name: "AuthorizationError",
          message: "memory connection.auth audience mismatch",
        });
      } finally {
        await server.close();
      }
    });

    it("responds with a retriable `AuthorizationError` for a challenge the connection was not issued", async () => {
      const server = createServer("foreign-challenge");
      try {
        const peer = await connectPeer(server);
        const other = await connectPeer(server);
        const refused = await authenticate(peer, alice, {
          challenge: other.auth.challenge.value,
        });
        expect(refused.error).toEqual({
          name: "AuthorizationError",
          message: "memory connection.auth challenge mismatch",
          retriable: true,
        });
      } finally {
        await server.close();
      }
    });

    it("responds with a retriable `AuthorizationError` for a challenge that has expired", async () => {
      const clock = { now: 1_000_000 };
      const server = createServer("expired-challenge", { clock });
      try {
        const peer = await connectPeer(server);
        clock.now = peer.auth.challenge.expiresAt;
        const refused = await authenticate(peer, alice, {}, clock);
        expect(refused.error).toEqual({
          name: "AuthorizationError",
          message: "memory connection.auth challenge expired",
          retriable: true,
        });
      } finally {
        await server.close();
      }
    });

    it("responds with a retriable `AuthorizationError` to a key signing a challenge a second time", async () => {
      const server = createServer("reuse");
      try {
        const peer = await connectPeer(server);
        expect((await authenticate(peer, alice)).ok).toBeDefined();
        const refused = await authenticate(peer, alice);
        expect(refused.error).toEqual({
          name: "AuthorizationError",
          message: "memory connection.auth challenge already used",
          retriable: true,
        });
      } finally {
        await server.close();
      }
    });

    it("accepts one challenge signed by two keys", async () => {
      const server = createServer("two-keys");
      try {
        const peer = await connectPeer(server);
        expect((await authenticate(peer, alice)).ok?.principal).toBe(
          alice.did(),
        );
        expect((await authenticate(peer, space)).ok?.principal).toBe(
          space.did(),
        );
      } finally {
        await server.close();
      }
    });

    it("leaves a refused key unauthenticated", async () => {
      const server = createServer("refused-stays-out");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice, { aud: mallory.did() });
        expect((await open(peer, SPACE, alice.did())).error?.name).toBe(
          "AuthorizationError",
        );
      } finally {
        await server.close();
      }
    });

    it(`refuses a key past the ${MAX_CONNECTION_PRINCIPALS} principals a connection holds`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://memory-v2-connection-auth-limit"),
        // Admits whatever principal the request names, so that the limit
        // can be reached without minting that many keys.
        authorizeConnection: (message) =>
          (message.authorization as { principal: string }).principal,
      });
      try {
        const peer = await connectPeer(server);
        const claim = (index: number) =>
          request<ConnectionAuthResult>(peer, {
            type: "connection.auth",
            invocation: {
              iss: `did:key:z6Mk-limit-${index}`,
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
            },
            authorization: { principal: `did:key:z6Mk-limit-${index}` },
          });
        for (let index = 0; index < MAX_CONNECTION_PRINCIPALS; index++) {
          expect((await claim(index)).ok).toBeDefined();
        }
        const refused = await claim(MAX_CONNECTION_PRINCIPALS);
        expect(refused.error?.name).toBe("AuthorizationError");
        expect(refused.error?.retriable).toBeUndefined();

        // Releasing one makes room for the key that was refused.
        await request(peer, {
          type: "connection.release",
          principal: "did:key:z6Mk-limit-0",
        });
        expect((await claim(MAX_CONNECTION_PRINCIPALS)).ok).toBeDefined();
      } finally {
        await server.close();
      }
    });
  });

  describe("the authentication lease", () => {
    // The clock is the server's; the lease is read against it.

    const watchDoc = (peer: WirePeer, space: string, sessionId: string) =>
      request<WatchSetResult>(peer, {
        type: "session.watch.set",
        space,
        sessionId,
        watches: [{
          id: "watch",
          kind: "graph",
          query: {
            roots: [{
              id: "of:lease-doc",
              selector: { path: [], schema: false },
            }],
          },
        }],
      });

    it("runs out at the statement's `exp`, capped at an hour", async () => {
      const clock = { now: 1_000_000 };
      const server = createServer("lease-cap", { clock });
      try {
        const peer = await connectPeer(server);
        const asked = await authenticate(peer, alice, {
          exp: clock.now + 7200,
        }, clock);
        expect(asked.ok?.expiresAt).toBe(
          clock.now + MAX_CONNECTION_AUTH_LEASE_SECONDS,
        );
        const other = await connectPeer(server);
        const shorter = await authenticate(other, alice, {
          exp: clock.now + 60,
        }, clock);
        expect(shorter.ok?.expiresAt).toBe(clock.now + 60);
      } finally {
        await server.close();
      }
    });

    it("refuses, as retriable, a `session.open` and the requests of open sessions once it has run out, and sends those sessions nothing", async () => {
      const clock = { now: 1_000_000 };
      const server = createServer("lease-out", { clock });
      try {
        const watcher = await connectPeer(server);
        const writer = await connectPeer(server);
        await authenticate(watcher, alice, { exp: clock.now + 60 }, clock);
        await authenticate(writer, space, {}, clock);
        const watching = await open(watcher, SPACE, alice.did());
        const writing = await open(writer, SPACE, space.did());
        await watchDoc(watcher, SPACE, watching.ok!.sessionId);

        clock.now += 61;
        const refusedOpen = await open(watcher, OTHER_SPACE, alice.did());
        expect(refusedOpen.error?.name).toBe("AuthorizationError");
        const refusedQuery = await query(
          watcher,
          SPACE,
          watching.ok!.sessionId,
        );
        expect(refusedQuery.error).toEqual({
          name: "AuthorizationError",
          message: `memory authentication lease of ${alice.did()} has run ` +
            "out; renew it with `connection.auth`",
          retriable: true,
        });
        await request(writer, {
          type: "transact",
          space: SPACE,
          sessionId: writing.ok!.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:lease-doc",
              value: { value: { n: 1 } },
            }],
          },
        });
        await server.accessForTestingOnly.flushScheduledSessions();
        expect(watcher.messages).toEqual([]);

        // Renewed, the session is served again, and what it missed
        // reaches it.
        const renewed = await authenticate(watcher, alice, {
          challenge: (await request<ConnectionChallengeResult>(watcher, {
            type: "connection.challenge",
          })).ok!.challenge.value,
          exp: clock.now + 60,
        }, clock);
        expect(renewed.ok?.expiresAt).toBe(clock.now + 60);
        expect((await query(watcher, SPACE, watching.ok!.sessionId)).ok)
          .toBeDefined();
        await server.accessForTestingOnly.flushScheduledSessions();
        expect(watcher.messages.map((message) => message.type)).toEqual([
          "session/effect",
        ]);
      } finally {
        await server.close();
      }
    });
  });

  describe("connection.challenge", () => {
    it("responds with a challenge the connection's next `connection.auth` may sign", async () => {
      const clock = { now: 1_000_000 };
      const server = createServer("fresh-challenge", { clock });
      try {
        const peer = await connectPeer(server);
        clock.now = peer.auth.challenge.expiresAt + 1;
        const fresh = await request<ConnectionChallengeResult>(peer, {
          type: "connection.challenge",
        });
        expect(fresh.ok!.challenge.value).not.toBe(peer.auth.challenge.value);
        expect(fresh.ok!.challenge.expiresAt).toBeGreaterThan(clock.now);
        const accepted = await authenticate(peer, alice, {
          challenge: fresh.ok!.challenge.value,
        }, clock);
        expect(accepted.ok?.principal).toBe(alice.did());
      } finally {
        await server.close();
      }
    });
  });

  describe("session.open naming a principal", () => {
    it("opens a session as an authenticated principal", async () => {
      const server = createServer("opens");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        const opened = await open(peer, SPACE, alice.did());
        expect(opened.ok?.sessionId).toBeDefined();
        expect(
          server.accessForTestingOnly.sessionsForSpace(SPACE).map((session) =>
            session.principal
          ),
        ).toEqual([alice.did()]);
        expect((await query(peer, SPACE, opened.ok!.sessionId)).ok)
          .toBeDefined();
      } finally {
        await server.close();
      }
    });

    it("responds with a permanent `AuthorizationError` for a principal the connection has not authenticated", async () => {
      const server = createServer("unauthenticated");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        const refused = await open(peer, SPACE, mallory.did());
        expect(refused.error?.name).toBe("AuthorizationError");
        expect(refused.error?.retriable).toBeUndefined();
        expect(server.accessForTestingOnly.sessionsForSpace(SPACE)).toEqual(
          [],
        );
      } finally {
        await server.close();
      }
    });

    it("responds with a permanent `AuthorizationError` for a principal another connection authenticated", async () => {
      const server = createServer("other-connection");
      try {
        const authenticated = await connectPeer(server);
        const other = await connectPeer(server);
        await authenticate(authenticated, alice);
        expect((await open(other, SPACE, alice.did())).error?.name).toBe(
          "AuthorizationError",
        );
      } finally {
        await server.close();
      }
    });

    it("opens sessions handed over together, each without a challenge of its own", async () => {
      const server = createServer("together");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        const ids = [SPACE, OTHER_SPACE].map((space) => ({
          space,
          id: requestId("open"),
        }));
        await Promise.all(ids.map(({ space, id }) =>
          send(peer, {
            type: "session.open",
            requestId: id,
            space,
            principal: alice.did(),
            session: {},
          })
        ));
        for (const { id } of ids) {
          expect(takeResponse<SessionOpenResult>(peer, id).ok?.sessionId)
            .toBeDefined();
        }
      } finally {
        await server.close();
      }
    });

    it("opens a session handed over behind the `connection.auth` it depends on", async () => {
      const server = createServer("behind-auth");
      try {
        const peer = await connectPeer(server);
        const auth = await signConnectionAuth(alice, {
          aud: peer.auth.audience,
          challenge: peer.auth.challenge.value,
          iat: nowSeconds(),
          exp: nowSeconds() + 300,
        });
        const openId = requestId("open");
        await Promise.all([
          send(peer, {
            type: "connection.auth",
            requestId: requestId("auth"),
            ...auth,
          }),
          send(peer, {
            type: "session.open",
            requestId: openId,
            space: SPACE,
            principal: alice.did(),
            session: {},
          }),
        ]);
        expect(takeResponse<SessionOpenResult>(peer, openId).ok?.sessionId)
          .toBeDefined();
      } finally {
        await server.close();
      }
    });

    it("holds each session to what the ACL grants its own principal", async () => {
      const server = createServer("acl", { acl: "enforce" });
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        await authenticate(peer, space);
        const asSpace = await open(peer, SPACE, space.did());
        const asAlice = await open(peer, SPACE, alice.did());
        const genesis = (sessionId: string) =>
          request(peer, {
            type: "transact",
            space: SPACE,
            sessionId,
            commit: {
              localSeq: 1,
              reads: {
                confirmed: [{ id: `of:${SPACE}`, path: [], seq: 0 }],
                pending: [],
              },
              operations: [{
                op: "set",
                id: `of:${SPACE}`,
                value: { value: { [alice.did()]: "OWNER" } },
              }],
            },
          });
        // A fresh space is initialized by its own identity and by nobody
        // else, so the same commit is refused from the one session and
        // accepted from the other.
        expect((await genesis(asAlice.ok!.sessionId)).error?.name).toBe(
          "AuthorizationError",
        );
        expect((await genesis(asSpace.ok!.sessionId)).ok).toBeDefined();
      } finally {
        await server.close();
      }
    });
  });

  describe("connection.release", () => {
    it("refuses a later `session.open` naming the released principal", async () => {
      const server = createServer("release");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        const released = await request(peer, {
          type: "connection.release",
          principal: alice.did(),
        });
        expect(released.ok).toEqual({});
        expect((await open(peer, SPACE, alice.did())).error?.name).toBe(
          "AuthorizationError",
        );
      } finally {
        await server.close();
      }
    });

    it("leaves a session the principal opened before its release open", async () => {
      const server = createServer("release-keeps-sessions");
      try {
        const peer = await connectPeer(server);
        await authenticate(peer, alice);
        const opened = await open(peer, SPACE, alice.did());
        await request(peer, {
          type: "connection.release",
          principal: alice.did(),
        });
        expect((await query(peer, SPACE, opened.ok!.sessionId)).ok)
          .toBeDefined();
      } finally {
        await server.close();
      }
    });

    it("responds with an empty result for a principal the connection does not hold", async () => {
      const server = createServer("release-unheld");
      try {
        const peer = await connectPeer(server);
        const released = await request(peer, {
          type: "connection.release",
          principal: alice.did(),
        });
        expect(released.ok).toEqual({});
      } finally {
        await server.close();
      }
    });
  });
});
