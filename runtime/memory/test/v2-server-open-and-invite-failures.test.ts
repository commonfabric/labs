/**
 * What the v2 `Server` answers when a connection's authentication names no
 * principal, when a session is opened on a space the server does not own,
 * and when the invitation service an open or a `space.invite` reaches fails
 * or refuses.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { SpaceInviteError } from "../space-invites.ts";
import type {
  ConnectionAuthResult,
  SessionOpenResult,
  SpaceInviteRequest,
} from "../v2.ts";
import type { InviteResult } from "../v2/invites.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { connectPeer, request, type WirePeer } from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-open-invite-failures-space";
const OTHER_SPACE = "did:key:z6Mk-open-invite-failures-other";
const ALICE = "did:key:z6Mk-open-invite-failures-alice";
const INVITE_HOST = "https://invites.example";
const INVITE = { inviteId: "invite-open-failures", code: "c".repeat(43) };

let serverCount = 0;

/** A store URL no other server in this file uses. */
const freshStore = () =>
  new URL(`memory://open-invite-failures-${++serverCount}`);

/** Opens a session on `space` as `principal`, carrying `session`. */
const openAs = (
  peer: WirePeer,
  space: string,
  principal: string,
  session: Record<string, unknown> = {},
) =>
  request<SessionOpenResult>(peer, {
    type: "session.open",
    space,
    session: session as never,
    invocation: {
      iss: principal,
      aud: peer.auth.audience,
      challenge: peer.auth.challenge.value,
    },
  });

/** A server that admits an open as the principal its invocation names. */
const createInvitingServer = (inviteHost?: string) =>
  new Server({
    store: freshStore(),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: testSessionOpenServerOptions.sessionOpenAuth,
    ...(inviteHost === undefined ? {} : { inviteHost }),
  });

describe("Server", () => {
  describe("instance members", () => {
    describe("authenticateConnection()", () => {
      it("admits the principal the authorizer names, and returns `AuthorizationError` when it names none", async () => {
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: freshStore(),
          subscriptionRefreshDelayMs: "manual",
          authorizeConnection: (message) =>
            (message.authorization as { principal?: string }).principal,
        });
        try {
          const peer = await connectPeer(server);
          const authenticate = (authorization: Record<string, string>) =>
            request<ConnectionAuthResult>(peer, {
              type: "connection.auth",
              invocation: {
                iss: ALICE,
                aud: peer.auth.audience,
                challenge: peer.auth.challenge.value,
              },
              authorization,
            });

          const refused = await authenticate({});
          expect(refused.ok).toBeUndefined();
          expect(refused.error).toEqual({
            name: "AuthorizationError",
            message: "memory connection.auth names no principal",
          });

          const admitted = await authenticate({ principal: ALICE });
          expect(admitted.error).toBeUndefined();
          expect(admitted.ok?.principal).toBe(ALICE);
        } finally {
          await server.close();
        }
      });
    });

    describe("openSession()", () => {
      it("opens a session on a space the server owns, and returns `AuthorizationError` for one it does not, opening no store for it", async () => {
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: freshStore(),
          subscriptionRefreshDelayMs: "manual",
          ownsSpace: (space) => space === SPACE,
        });
        try {
          const peer = await connectPeer(server);
          const owned = await openAs(peer, SPACE, ALICE);
          expect(owned.error).toBeUndefined();
          expect(owned.ok?.sessionId).toBeDefined();
          peer.auth = owned.ok!.sessionOpen;

          const unowned = await openAs(peer, OTHER_SPACE, ALICE);
          expect(unowned.ok).toBeUndefined();
          expect(unowned.error).toEqual({
            name: "AuthorizationError",
            message: "Routed memory request denied",
          });
          expect(server.accessForTestingOnly.sessionsForSpace(OTHER_SPACE))
            .toEqual([]);
          expect(Object.keys(server.documentCachesDiagnostics().spaces))
            .toEqual([SPACE]);
        } finally {
          await server.close();
        }
      });

      describe("an open carrying an invitation", () => {
        /**
         * Opens a session on `SPACE` as `ALICE` carrying `INVITE`, with the
         * invitation service answering as `invite` does, and returns the
         * open's response and what the service was asked.
         */
        const openInvited = async (
          invite: () => Promise<InviteResult["result"]>,
        ) => {
          const server = createInvitingServer(INVITE_HOST);
          const service = stub(server, "invite", invite);
          try {
            const peer = await connectPeer(server);
            const response = await openAs(peer, SPACE, ALICE, {
              invite: INVITE,
            });
            return {
              response,
              calls: service.calls.map(({ args: [call] }) => ({
                operation: call.operation,
                body: call.body,
                principal: call.principal,
              })),
              sessions: server.accessForTestingOnly.sessionsForSpace(SPACE),
            };
          } finally {
            service.restore();
            await server.close();
          }
        };

        it("returns `SpaceInviteRefusal` carrying the service's code when the service refuses the redemption", async () => {
          const { response, calls, sessions } = await openInvited(() =>
            Promise.reject(new SpaceInviteError("invite-unavailable"))
          );
          expect(calls).toEqual([{
            operation: "redeem",
            body: INVITE,
            principal: ALICE,
          }]);
          expect(response.error).toEqual({
            name: "SpaceInviteRefusal",
            message:
              "The invitation service refused the request: invite-unavailable",
            code: "invite-unavailable",
          });
          expect(sessions).toEqual([]);
        });

        it("returns `ProtocolError` when the service answers the redemption with something other than a receipt", async () => {
          const { response, sessions } = await openInvited(() =>
            Promise.resolve({ invites: [] } as never)
          );
          expect(response.ok).toBeUndefined();
          expect(response.error).toEqual({
            name: "ProtocolError",
            message: "The invitation service returned no redemption",
          });
          expect(sessions).toEqual([]);
        });

        it("returns `ProtocolError` carrying the failure when the service fails", async () => {
          const { response, sessions } = await openInvited(() =>
            Promise.reject(new Error("the invitation store is unreachable"))
          );
          expect(response.ok).toBeUndefined();
          expect(response.error).toEqual({
            name: "ProtocolError",
            message: "the invitation store is unreachable",
          });
          expect(sessions).toEqual([]);
        });
      });
    });

    describe("administerInvites()", () => {
      const LIST: SpaceInviteRequest["invite"] = {
        operation: "list",
        body: {},
      };

      /** A server given `inviteHost` whose registry the case opens in. */
      const createAdministeringServer = (inviteHost?: string) => {
        const sessions = new SessionRegistry();
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: freshStore(),
          subscriptionRefreshDelayMs: "manual",
          sessions,
          ...(inviteHost === undefined ? {} : { inviteHost }),
        });
        return { server, sessions };
      };

      const administer = (server: Server, sessionId: string) =>
        server.administerInvites({
          type: "space.invite",
          requestId: "invite",
          space: SPACE,
          sessionId,
          invite: LIST,
        });

      it("returns `SpaceInviteRefusal` with `invite-service-unsupported` on a server given no invitation host", async () => {
        const { server, sessions } = createAdministeringServer();
        try {
          const opened = sessions.open(SPACE, {}, 0, "test", ALICE);
          expect((await administer(server, opened.sessionId)).error).toEqual({
            name: "SpaceInviteRefusal",
            message:
              "The invitation service refused the request: invite-service-unsupported",
            code: "invite-service-unsupported",
          });
        } finally {
          await server.close();
        }
      });

      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createAdministeringServer(INVITE_HOST);
        try {
          expect((await administer(server, "no-such-session")).error).toEqual({
            name: "SessionError",
            message: "Unknown or replaced session for space",
          });
        } finally {
          await server.close();
        }
      });

      it("returns `SpaceInviteRefusal` with `not-owner` for an anonymous session, asking the service nothing", async () => {
        const { server, sessions } = createAdministeringServer(INVITE_HOST);
        const service = stub(
          server,
          "invite",
          () => Promise.resolve({ invites: [] } as never),
        );
        try {
          const opened = sessions.open(SPACE, {}, 0, "test");
          expect((await administer(server, opened.sessionId)).error?.code)
            .toBe("not-owner");
          expect(service.calls).toEqual([]);
        } finally {
          service.restore();
          await server.close();
        }
      });

      it("returns the service's result for the session's principal, its refusal as `SpaceInviteRefusal`, and rejects with any other failure", async () => {
        const { server, sessions } = createAdministeringServer(INVITE_HOST);
        const answers: Array<() => Promise<InviteResult["result"]>> = [
          () => Promise.resolve({ invites: [] } as never),
          () => Promise.reject(new SpaceInviteError("not-owner")),
          () =>
            Promise.reject(new Error("the invitation store is unreachable")),
        ];
        const service = stub(server, "invite", () => answers.shift()!());
        try {
          const opened = sessions.open(SPACE, {}, 0, "test", ALICE);

          const listed = await administer(server, opened.sessionId);
          expect(listed.ok).toEqual({ invites: [] });
          expect(service.calls[0].args[0]).toMatchObject({
            ...LIST,
            host: INVITE_HOST,
            space: SPACE,
            principal: ALICE,
          });

          const refused = await administer(server, opened.sessionId);
          expect(refused.error?.code).toBe("not-owner");

          await expect(administer(server, opened.sessionId)).rejects.toThrow(
            "the invitation store is unreachable",
          );
        } finally {
          service.restore();
          await server.close();
        }
      });
    });
  });
});
