/**
 * The `space.invite` request: administering a space's invitations on a
 * memory session as its principal, through real clients over loopback.
 * Redemption is not among the operations, since the one redeeming holds no
 * grant to open a session with.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  createInviteCredentials,
  inviteCodeVerifier,
  type InviteMetadata,
} from "../space-invites.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
} from "../v2.ts";
import {
  type Client,
  connect,
  type InviteAdministration,
  loopback,
  type SessionOpenAuthFactory,
  type SpaceSession,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";

const AUDIENCE = "did:key:z6Mk-space-invite-requests-audience";
const INVITE_HOST = "https://invites.example";

/** Opens a session as `principal`, which the test server trusts as given. */
const authAs = (principal: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: { aud: context.audience, challenge: context.challenge.value },
  authorization: { principal },
});

/** The error a call settles with, or `undefined` if it returned. */
const failureOf = (
  call: Promise<unknown>,
): Promise<(Error & { code?: string }) | undefined> =>
  call.then(() => undefined, (error: unknown) => error as Error);

describe("space.invite", () => {
  const servers: Server[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const server of servers.splice(0)) await server.close();
  });

  const serverWith = (options: { inviteHost?: string } = {}): Server => {
    const server = new Server({
      store: new URL(`memory://space-invite-requests-${crypto.randomUUID()}`),
      sessionOpenAuth: { audience: AUDIENCE },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
      ...options,
    });
    servers.push(server);
    return server;
  };

  /**
   * A space owned by a fresh DID on `server`, with `grants` beside the
   * owner's, and the owner's session on it.
   */
  const ownedSpace = async (
    server: Server,
    grants: Record<string, string> = {},
  ): Promise<{ space: string; owner: string; session: SpaceSession }> => {
    const owner = (await Identity.generate()).did();
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    const session = await client.mount(owner, {}, authAs(owner));
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: `of:${owner}`,
        value: { value: { [owner]: "OWNER", ...grants } },
      }],
    });
    return { space: owner, owner, session };
  };

  /** A session on `space` as `principal`, on a client of its own. */
  const sessionAs = async (
    server: Server,
    space: string,
    principal: string,
  ): Promise<SpaceSession> => {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    return await client.mount(space, {}, authAs(principal));
  };

  /** A `create` for a READ invitation whose code verifier names `host`. */
  const creation = (space: string, host = INVITE_HOST) => {
    const credentials = createInviteCredentials();
    const invite: InviteAdministration = {
      operation: "create",
      body: {
        inviteId: credentials.inviteId,
        codeVerifier: inviteCodeVerifier({ host, space, ...credentials }),
        access: "READ",
        ttlSeconds: 60,
      },
    };
    return { invite, ...credentials };
  };

  describe("hello", () => {
    it("advertises `spaceInvites` only on a server given an invitation host", async () => {
      const flagsOf = async (server: Server) => {
        const sent: ServerMessage[] = [];
        const connection = server.connect((message) => sent.push(message));
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
        }));
        connection.close();
        return (sent[0] as HelloOkMessage).flags;
      };

      expect((await flagsOf(serverWith())).spaceInvites).toBe(false);
      expect(
        (await flagsOf(serverWith({ inviteHost: INVITE_HOST }))).spaceInvites,
      ).toBe(true);
    });
  });

  describe("administration", () => {
    it("creates, lists, and revokes an invitation for the space's owner", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, owner, session } = await ownedSpace(server);
      const { invite } = creation(space);

      const created = await session.administerInvites(invite) as InviteMetadata;
      const listed = await session.administerInvites({
        operation: "list",
        body: {},
      });
      const revoked = await session.administerInvites({
        operation: "revoke",
        body: { inviteId: created.inviteId },
      });
      const afterRevoke = await session.administerInvites({
        operation: "list",
        body: {},
      });

      expect(created).toMatchObject({
        inviteId: invite.body.inviteId,
        issuedBy: owner,
        access: "READ",
        maxUses: 1,
        usedCount: 0,
      });
      expect(listed).toEqual([created]);
      expect(revoked).toEqual({ revoked: true });
      expect(afterRevoke).toEqual([]);
    });

    it("binds a created invitation to the configured host, so a code checked against that host redeems", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, session } = await ownedSpace(server);
      const guest = (await Identity.generate()).did();
      const { invite, inviteId, code } = creation(space);
      await session.administerInvites(invite);

      const elsewhere = await failureOf(server.invite({
        operation: "redeem",
        body: { inviteId, code },
        host: "https://elsewhere.example",
        space,
        principal: guest,
        now: Date.now(),
      }));
      const here = await server.invite({
        operation: "redeem",
        body: { inviteId, code },
        host: INVITE_HOST,
        space,
        principal: guest,
        now: Date.now(),
      });

      expect(elsewhere).toBeInstanceOf(Error);
      expect(here).toMatchObject({
        outcome: "redeemed",
        currentAccess: "READ",
      });
    });

    it("refuses with `not-owner` a principal holding only WRITE", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const writer = (await Identity.generate()).did();
      const { space } = await ownedSpace(server, { [writer]: "WRITE" });
      const session = await sessionAs(server, space, writer);

      const failure = await failureOf(
        session.administerInvites(creation(space).invite),
      );

      expect(failure?.name).toBe("SpaceInviteRefusal");
      expect(failure?.code).toBe("not-owner");
    });
  });

  describe("unsupported", () => {
    it("throws `invite-service-unsupported` without sending, against a server given no invitation host", async () => {
      const server = serverWith();
      const { space, session } = await ownedSpace(server);

      const failure = await failureOf(
        session.administerInvites(creation(space).invite),
      );

      expect(failure?.name).toBe("SpaceInviteRefusal");
      expect(failure?.code).toBe("invite-service-unsupported");
    });

    it("refuses a redemption as an unreadable message", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const sent: ServerMessage[] = [];
      const connection = server.connect((message) => sent.push(message));
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      const requestId = crypto.randomUUID();

      await connection.receive(encodeMemoryBoundary({
        type: "space.invite",
        requestId,
        space: "did:key:z6Mk-space-invite-requests-space",
        sessionId: "any",
        invite: {
          operation: "redeem",
          body: { inviteId: "x".repeat(22), code: "y".repeat(43) },
        },
      }));
      connection.close();

      const response = sent.find((message) =>
        message.type === "response" && message.requestId === requestId
      ) as ResponseMessage<unknown> | undefined;
      expect(response?.error?.name).toBe("InvalidMessageError");
    });
  });
});
