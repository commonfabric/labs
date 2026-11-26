/**
 * The `space.invite` request: administering a space's invitations on a
 * memory session as its principal, through real clients over loopback.
 * Redemption is not among the operations, since the one redeeming holds no
 * grant to open a session with.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import {
  createInviteCredentials,
  inviteCodeVerifier,
  type InviteMetadata,
  SPACE_INVITES_REVISION_DOC_ID,
} from "../space-invites.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
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
    /** The flags `server` answers a `hello` with. */
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

    it("advertises `spaceInvites` only on a server given an invitation host", async () => {
      expect((await flagsOf(serverWith())).spaceInvites).toBe(false);
      expect(
        (await flagsOf(serverWith({ inviteHost: INVITE_HOST }))).spaceInvites,
      ).toBe(true);
    });

    it("advertises `spaceInvitesRevision` on every server of this build", async () => {
      // The invitation service moves the revision document whatever host it
      // was given, so the flag is the build's, not the configuration's.

      expect((await flagsOf(serverWith())).spaceInvitesRevision).toBe(true);
      expect(
        (await flagsOf(serverWith({ inviteHost: INVITE_HOST })))
          .spaceInvitesRevision,
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
  describe("redemption on `session.open`", () => {
    it("opens a session for a principal the access list does not name, and returns the receipt", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, session } = await ownedSpace(server);
      const guest = (await Identity.generate()).did();
      const { invite, inviteId, code } = creation(space);
      await session.administerInvites(invite);
      const client = await connect({ transport: loopback(server) });
      clients.push(client);

      const refused = await failureOf(sessionAs(server, space, guest));
      const { redemption } = await client.mountRedeeming(
        space,
        { inviteId, code },
        authAs(guest),
      );
      const later = await sessionAs(server, space, guest);

      expect(refused?.name).toBe("AuthorizationError");
      expect(redemption).toEqual({
        outcome: "redeemed",
        redemption: { inviteId, did: guest },
        currentAccess: "READ",
      });
      expect(later.space).toBe(space);
    });

    it("refuses the open with the service's code for a wrong code, and grants nothing", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, session } = await ownedSpace(server);
      const guest = (await Identity.generate()).did();
      const { invite, inviteId } = creation(space);
      await session.administerInvites(invite);
      const client = await connect({ transport: loopback(server) });
      clients.push(client);

      const failure = await failureOf(
        client.mountRedeeming(
          space,
          { inviteId, code: createInviteCredentials().code },
          authAs(guest),
        ),
      );
      const afterwards = await failureOf(sessionAs(server, space, guest));

      expect(failure?.name).toBe("SpaceInviteRefusal");
      expect(failure?.code).toEqual(expect.any(String));
      expect(afterwards?.name).toBe("AuthorizationError");
    });

    it("refuses with `invalid-request` an anonymous open carrying an invitation, and grants nothing", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, owner, session } = await ownedSpace(server);
      const { invite, inviteId, code } = creation(space);
      await session.administerInvites(invite);
      const client = await connect({ transport: loopback(server) });
      clients.push(client);
      const anonymous: SessionOpenAuthFactory = (
        _space,
        _session,
        context,
      ) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {},
      });

      const failure = await failureOf(
        client.mountRedeeming(space, { inviteId, code }, anonymous),
      );
      const acl = await server.readDocument(space, `of:${space}`);

      expect(failure?.name).toBe("SpaceInviteRefusal");
      expect(failure?.code).toBe("invalid-request");
      expect(acl?.value).toEqual({ [owner]: "OWNER" });
    });

    it("throws `invite-service-unsupported` without sending, against a server given no invitation host", async () => {
      const server = serverWith();
      const { space } = await ownedSpace(server);
      const guest = (await Identity.generate()).did();
      const client = await connect({ transport: loopback(server) });
      clients.push(client);

      const failure = await failureOf(
        client.mountRedeeming(
          space,
          createInviteCredentials(),
          authAs(guest),
        ),
      );

      expect(failure?.name).toBe("SpaceInviteRefusal");
      expect(failure?.code).toBe("invite-service-unsupported");
    });
  });
  describe("the ledger's revision document", () => {
    it("refuses a direct write, and stays as the service left it", async () => {
      // A direct write is a system commit, which the store's guard lets
      // through, so the server's direct write path refuses the id itself.

      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, session } = await ownedSpace(server);
      await session.administerInvites(creation(space).invite);

      const failure = await failureOf(
        server.writeDocument(space, SPACE_INVITES_REVISION_DOC_ID, {
          revision: 9,
        }),
      );
      const held = await server.readDocument(
        space,
        SPACE_INVITES_REVISION_DOC_ID,
      );

      expect(failure?.message).toContain(
        "direct writes may not move the invitation service's revision document",
      );
      expect(held?.value).toEqual({ revision: 1 });
    });

    it("stays on a branch as it stood when the branch was forked, while the ledger and the default branch's document move on", async () => {
      // The service moves the document on the default branch, and the ledger
      // belongs to no branch, so a session on a fork sees the document as the
      // fork found it and learns nothing from watching it. A replica answers
      // `invitesRevisionWatchable()` `false` there.

      const server = serverWith({ inviteHost: INVITE_HOST });
      const { space, owner, session } = await ownedSpace(server);
      const revisionOn = async (on: SpaceSession) =>
        (await on.queryGraph({
          roots: [{
            id: SPACE_INVITES_REVISION_DOC_ID,
            selector: { path: [], schema: false },
          }],
        })).entities[0]?.document;
      await session.administerInvites(creation(space).invite);
      const client = await connect({ transport: loopback(server) });
      clients.push(client);
      const fork = await client.mount(
        space,
        { branch: "invites-fork", forkBranch: true },
        authAs(owner),
      );

      await session.administerInvites(creation(space).invite);
      const listed = await fork.administerInvites({
        operation: "list",
        body: {},
      });

      expect(await revisionOn(session)).toEqual({ value: { revision: 2 } });
      expect(await revisionOn(fork)).toEqual({ value: { revision: 1 } });
      expect(Array.isArray(listed) && listed.length).toBe(2);
    });

    it("moves for a reader's session the server opened on the default branch, which still names the fork it asked for", async () => {
      // A reader that asks to fork a branch gets a session of the default
      // branch, and `session.open` does not say so: the session reads the
      // document as it moves, while `requestedBranch` names the fork. A
      // replica's `invitesRevisionWatchable()` reads `requestedBranch`, so it
      // answers `false` for such a session, and its caller reads the ledger
      // itself rather than miss a move.

      const server = serverWith({ inviteHost: INVITE_HOST });
      const reader = (await Identity.generate()).did();
      const { space, session } = await ownedSpace(server, {
        [reader]: "READ",
      });
      const revisionOn = async (on: SpaceSession) =>
        (await on.queryGraph({
          roots: [{
            id: SPACE_INVITES_REVISION_DOC_ID,
            selector: { path: [], schema: false },
          }],
        })).entities[0]?.document;
      await session.administerInvites(creation(space).invite);
      const client = await connect({ transport: loopback(server) });
      clients.push(client);
      const readerSession = await client.mount(
        space,
        { branch: "reader-fork", forkBranch: true },
        authAs(reader),
      );

      await session.administerInvites(creation(space).invite);

      expect(await revisionOn(readerSession)).toEqual({
        value: { revision: 2 },
      });
      expect(readerSession.requestedBranch).toBe("reader-fork");
    });

    it("reaches an owner watching it when another owner makes an invitation and when a member already holding the access redeems one", async () => {
      // The two changes a daemon holding the space hears of no other way:
      // neither is its own, and the redemption leaves the access list as it
      // was.

      const server = serverWith({ inviteHost: INVITE_HOST });
      const other = (await Identity.generate()).did();
      const member = (await Identity.generate()).did();
      const { space, session } = await ownedSpace(server, {
        [other]: "OWNER",
        [member]: "WRITE",
      });
      const view = await session.watchSet([{
        id: "ledger",
        kind: "graph",
        query: {
          roots: [{
            id: SPACE_INVITES_REVISION_DOC_ID,
            selector: { path: [], schema: false },
          }],
        },
      }]);
      const updates = view.subscribe();
      const revisionIn = (next: IteratorResult<GraphQueryResult>) =>
        next.done
          ? undefined
          : next.value.entities.find(({ id }) =>
            id === SPACE_INVITES_REVISION_DOC_ID
          )?.document;
      const otherSession = await sessionAs(server, space, other);
      const { invite, inviteId, code } = creation(space);

      const made = updates.next();
      await otherSession.administerInvites(invite);
      const madeRevision = revisionIn(await made);
      const redeemed = updates.next();
      const receipt = await server.invite({
        operation: "redeem",
        body: { inviteId, code },
        host: INVITE_HOST,
        space,
        principal: member,
        now: Date.now(),
      });
      const redeemedRevision = revisionIn(await redeemed);

      expect(madeRevision).toEqual({ value: { revision: 1 } });
      expect(receipt).toMatchObject({
        outcome: "redeemed",
        currentAccess: "WRITE",
      });
      expect(redeemedRevision).toEqual({ value: { revision: 2 } });
    });

    it("reaches an owner watching it when a refused preview retires an invitation whose issuer no longer owns the space", async () => {
      const server = serverWith({ inviteHost: INVITE_HOST });
      const other = (await Identity.generate()).did();
      const stranger = (await Identity.generate()).did();
      const { space, owner, session } = await ownedSpace(server, {
        [other]: "OWNER",
      });
      const otherSession = await sessionAs(server, space, other);
      const { invite, inviteId, code } = creation(space);
      await otherSession.administerInvites(invite);
      await session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: { value: { [owner]: "OWNER", [other]: "WRITE" } },
        }],
      });
      const view = await session.watchSet([{
        id: "ledger",
        kind: "graph",
        query: {
          roots: [{
            id: SPACE_INVITES_REVISION_DOC_ID,
            selector: { path: [], schema: false },
          }],
        },
      }]);
      const updates = view.subscribe();

      const retired = updates.next();
      const refusal = await failureOf(server.invite({
        operation: "preview",
        body: { inviteId, code },
        host: INVITE_HOST,
        space,
        principal: stranger,
        now: Date.now(),
      }));
      const next = await retired;

      expect(refusal).toMatchObject({ code: "invite-unavailable" });
      expect(
        next.done
          ? undefined
          : next.value.entities.find(({ id }) =>
            id === SPACE_INVITES_REVISION_DOC_ID
          )?.document,
      ).toEqual({ value: { revision: 2 } });
      expect(await session.administerInvites({ operation: "list", body: {} }))
        .toEqual([]);
    });

    it("moves in commits that name no principal, so a reader's history names no one whose operation moved it", async () => {
      // A space's history names each commit's principal to every reader of
      // the space. The revision commit is the service's: neither a member
      // whose redemption left the access list alone nor a stranger whose
      // refused preview retired an invitation appears in it.

      const server = serverWith({ inviteHost: INVITE_HOST });
      const other = (await Identity.generate()).did();
      const member = (await Identity.generate()).did();
      const reader = (await Identity.generate()).did();
      const stranger = (await Identity.generate()).did();
      const { space, owner, session } = await ownedSpace(server, {
        [other]: "OWNER",
        [member]: "WRITE",
        [reader]: "READ",
      });
      const redeemed = creation(space);
      await session.administerInvites(redeemed.invite);
      const otherSession = await sessionAs(server, space, other);
      const retired = creation(space);
      await otherSession.administerInvites(retired.invite);
      await server.invite({
        operation: "redeem",
        body: { inviteId: redeemed.inviteId, code: redeemed.code },
        host: INVITE_HOST,
        space,
        principal: member,
        now: Date.now(),
      });
      await session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: {
            value: {
              [owner]: "OWNER",
              [other]: "WRITE",
              [member]: "WRITE",
              [reader]: "READ",
            },
          },
        }],
      });
      await failureOf(server.invite({
        operation: "preview",
        body: { inviteId: retired.inviteId, code: retired.code },
        host: INVITE_HOST,
        space,
        principal: stranger,
        now: Date.now(),
      }));

      const readerSession = await sessionAs(server, space, reader);
      const history = await readerSession.listHistory();
      const named = new Set(
        history.flatMap((commit) => [commit.principal, commit.actingPrincipal]),
      );

      expect(history.length).toBeGreaterThan(4);
      expect(named.has(member)).toBe(false);
      expect(named.has(stranger)).toBe(false);
    });
  });
});
