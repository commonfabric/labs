/**
 * The server's refusals of work whose authority has gone or never held: a
 * session the connection no longer holds, a routed session whose fence has
 * dropped, a deleted space, a proof chain that has expired, a closed
 * connection, an invitation to a space with no store, and a deletion commit
 * of the wrong shape.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { type Delegation, issueDelegation } from "@commonfabric/identity";

import { SpaceInviteError } from "../space-invites.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  resolveScopeKey,
  type ServerMessage,
  type SessionOpenResult,
  type SessionReport,
  setServerExecutionConfig,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { alice, space } from "./principal.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-memory-v2-authority-guards-space";
const PRINCIPAL = "did:key:z6Mk-memory-v2-authority-guards-principal";
const AUDIENCE = "did:key:z6Mk-memory-v2-authority-guards-audience";
const ROOM = "room-0123456789abcdefghijklmnop";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const REPORT: SessionReport = {
  kind: "echo-breaker",
  event: "trip",
  document: { id: "of:fid1:shared", scopeKey: "space" },
  action: "cf:module/abc:__cfLift_1:xyz",
};

const createServer = (
  name: string,
  options: Partial<ConstructorParameters<typeof Server>[0]> = {},
): Server =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://memory-v2-authority-guards-${name}`),
    subscriptionRefreshDelayMs: "manual",
    ...options,
  });

/** The `set` operation writing `value` to `id`. */
const set = (id: string, value: FabricValue): FabricPlainObject => ({
  op: "set",
  id,
  value: { value },
});

describe("server", () => {
  describe("sessionTracksAny()", () => {
    it("returns `false` for a session the server does not hold", async () => {
      const server = createServer("tracks-unknown");
      try {
        expect(
          server.sessionTracksAny(
            SPACE,
            "session-never-opened",
            new Set(["a"]),
          ),
        ).toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  describe("receiveSessionReport()", () => {
    it("answers for a session another connection holds with a `SessionRevokedError`, recording nothing", async () => {
      const server = createServer("report-unattached");
      try {
        const holder = await connectPeer(server);
        const { sessionId } = await openSession(holder, SPACE);
        const other = await connectPeer(server);
        const message = {
          type: "session.report",
          requestId: "report",
          space: SPACE,
          sessionId,
          report: REPORT,
        } as const;
        expect(server.receiveSessionReport(message, other.connection))
          .toEqual({
            type: "response",
            requestId: "report",
            error: {
              name: "SessionRevokedError",
              message: "Session is not attached",
            },
          });
        expect(server.sessionReports().echoBreaker.trips).toBe(0);
        expect(server.receiveSessionReport(message, holder.connection))
          .toEqual({ type: "response", requestId: "report", ok: {} });
        expect(server.sessionReports().echoBreaker.trips).toBe(1);
      } finally {
        await server.close();
      }
    });
  });

  describe("receivePresence()", () => {
    it("answers for a session another connection holds with a `SessionRevokedError`, joining nothing", async () => {
      const server = createServer("presence-unattached");
      try {
        const holder = await connectPeer(server);
        const { sessionId } = await openSession(holder, SPACE);
        const other = await connectPeer(server);
        const join = {
          type: "presence.join",
          requestId: "join",
          space: SPACE,
          sessionId,
          room: ROOM,
        } as const;
        expect(server.receivePresence(join, other.connection)).toEqual({
          type: "response",
          requestId: "join",
          error: {
            name: "SessionRevokedError",
            message: "Session is not attached",
          },
        });
        expect(server.presenceMemberCount(SPACE, ROOM)).toBe(0);
        expect(server.receivePresence(join, holder.connection).error)
          .toBeUndefined();
        expect(server.presenceMemberCount(SPACE, ROOM)).toBe(1);
      } finally {
        await server.close();
      }
    });
  });

  describe("runPatternLifecycle()", () => {
    /** The `pattern.lifecycle` request for `sessionId`. */
    const upload = (sessionId: string) => ({
      type: "pattern.lifecycle" as const,
      requestId: "upload",
      space: SPACE,
      sessionId,
      verb: "upload" as const,
      body: {},
    });

    it("refuses a verb on a space the server no longer owns as forbidden", async () => {
      let owns = true;
      const server = createServer("lifecycle-unowned", {
        ownsSpace: () => owns,
      });
      const calls: unknown[] = [];
      server.setPatternLifecycleHandler((call) => {
        calls.push(call);
        return Promise.resolve({ ok: {} });
      });
      try {
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        expect((await server.runPatternLifecycle(upload(sessionId))).error)
          .toBeUndefined();
        owns = false;
        expect((await server.runPatternLifecycle(upload(sessionId))).error)
          .toEqual({
            name: "PatternLifecycleRefusal",
            code: "forbidden",
            message: "Routed memory request denied",
          });
        expect(calls).toHaveLength(1);
      } finally {
        await server.close();
      }
    });

    it("refuses a verb on a deleted space as forbidden", async () => {
      const server = createServer("lifecycle-deleted");
      const calls: unknown[] = [];
      server.setPatternLifecycleHandler((call) => {
        calls.push(call);
        return Promise.resolve({ ok: {} });
      });
      try {
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        // The deletion tombstone, written as the commit admitting a deletion
        // would write it.
        const engine = await server.engineForSpace(SPACE);
        Engine.applyCommit(engine, {
          sessionId: "deletion-stand-in",
          space: SPACE,
          commitClass: "system",
          commit: {
            localSeq: Engine.serverSeq(engine) + 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${SPACE}`,
              value: { value: { deleted: { by: PRINCIPAL } } },
            }],
          },
        });
        expect((await server.runPatternLifecycle(upload(sessionId))).error)
          .toEqual({
            name: "PatternLifecycleRefusal",
            code: "forbidden",
            message: `Space ${SPACE} is deleted`,
          });
        expect(calls).toEqual([]);
      } finally {
        await server.close();
      }
    });
  });

  describe("graphQuery()", () => {
    /**
     * A server admitting routed connections, whose ownership of every space
     * is `fence.owns` and whose delegating principal is `PRINCIPAL`, with a
     * routed session that `PRINCIPAL` opened on `SPACE`.
     */
    const routedSession = async (
      name: string,
      fence: { owns: boolean },
    ): Promise<{ server: Server; sessionId: string }> => {
      const server = new Server({
        store: new URL(`memory://memory-v2-authority-guards-routed-${name}`),
        subscriptionRefreshDelayMs: "manual",
        authorizeSessionOpen: () => undefined,
        authorizeConnection: () => undefined,
        sessionOpenAuth: { audience: AUDIENCE },
        ownsSpace: () => fence.owns,
        requireExplicitAcl: false,
        acl: {
          mode: "enforce",
          delegatingDids: [PRINCIPAL],
          serviceDids: [PRINCIPAL],
        },
      });
      const messages: ServerMessage[] = [];
      const connection = server.connectRouted(
        (message) => messages.push(message),
        () => fence.owns,
      );
      await connection.receive(encodeMemoryBoundary(HELLO));
      connection.admitRoutedPrincipal(
        PRINCIPAL,
        Math.floor(Date.now() / 1000) + 600,
      );
      const opened = await request<SessionOpenResult>({
        connection,
        messages,
        auth: { audience: AUDIENCE, challenge: { value: "", expiresAt: 0 } },
        flags: {},
      }, {
        type: "session.open",
        space: SPACE,
        principal: PRINCIPAL,
        session: {},
      });
      if (opened.ok === undefined) {
        throw new Error(`routed open failed: ${opened.error?.message}`);
      }
      return { server, sessionId: opened.ok.sessionId };
    };

    it("answers a routed session whose host no longer owns the space with a `SessionRevokedError`", async () => {
      const fence = { owns: true };
      const { server, sessionId } = await routedSession("query", fence);
      try {
        const query = {
          type: "graph.query" as const,
          requestId: "query",
          space: SPACE,
          sessionId,
          query: { roots: [] },
        };
        expect((await server.graphQuery(query)).error).toBeUndefined();
        fence.owns = false;
        expect((await server.graphQuery(query)).error).toEqual({
          name: "SessionRevokedError",
          message: "Routed memory authority ended",
        });
      } finally {
        await server.close();
      }
    });

    it("answers with a `QueryError` when routed authority ends while an explicit instance read is admitted", async () => {
      // A read naming an instance is admitted after its authorization, over
      // a second engine open; the host's ownership drops during that open.

      const fence = { owns: true };
      const { server, sessionId } = await routedSession("explicit", fence);
      setServerExecutionConfig(true);
      try {
        // A session that does not serve the space names an actor's instances
        // under that actor's grant in the space's access list.
        const listed = await server.transact({
          type: "transact",
          requestId: "explicit-acl",
          space: SPACE,
          sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${SPACE}`,
              value: { value: { [PRINCIPAL]: "OWNER" } },
            }],
          },
        });
        expect(listed.error).toBeUndefined();
        const query = {
          type: "graph.query" as const,
          requestId: "explicit",
          space: SPACE,
          sessionId,
          query: {
            roots: [{
              id: "of:doc",
              selector: { path: [], schema: false },
              entityScopeKeys: {
                user: resolveScopeKey("user", { principal: PRINCIPAL }),
              },
            }],
          },
        };
        expect((await server.graphQuery(query)).error).toBeUndefined();
        let opens = 0;
        server.accessForTestingOnly.engineOpener = async (opening, open) => {
          const engine = await open(opening);
          if (++opens === 2) fence.owns = false;
          return engine;
        };
        expect((await server.graphQuery(query)).error).toEqual({
          name: "QueryError",
          message: "Routed memory authority ended",
        });
        expect(opens).toBe(2);
      } finally {
        resetServerExecutionConfig();
        await server.close();
      }
    });
  });

  describe("transact()", () => {
    it("refuses a deletion commit that writes anything else, leaving the space undeleted", async () => {
      const server = createServer("deletion-shape");
      try {
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        const response = await request(peer, {
          type: "transact",
          space: SPACE,
          sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              set(`of:${SPACE}`, { deleted: { by: PRINCIPAL } }),
              set("of:bystander", { hello: "world" }),
            ],
          },
        });
        expect(response.error).toEqual({
          name: "ProtocolError",
          message: "ACL mutations must be an ACL-only commit",
        });
        expect(await server.readDocument(SPACE, `of:${SPACE}`)).toBeNull();
        expect(await server.readDocument(SPACE, "of:bystander")).toBeNull();
      } finally {
        await server.close();
      }
    });
  });

  describe("invite()", () => {
    for (
      const [operation, body, code] of [
        ["redeem", { inviteId: "invite", code: "code" }, "invite-unavailable"],
        ["preview", { inviteId: "invite", code: "code" }, "invite-unavailable"],
        ["list", {}, "not-owner"],
      ] as const
    ) {
      it(`throws \`${code}\` for a \`${operation}\` on a space with no store`, async () => {
        const server = createServer(`invite-no-store-${operation}`);
        try {
          const refused = await server.invite(
            {
              operation,
              body,
              host: "https://example.com",
              space: SPACE,
              principal: PRINCIPAL,
              now: 1_000_000,
            } as Parameters<Server["invite"]>[0],
          ).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refused).toBeInstanceOf(SpaceInviteError);
          expect((refused as SpaceInviteError).code).toBe(code);
        } finally {
          await server.close();
        }
      });
    }
  });

  describe("Connection", () => {
    describe("refreshDirty()", () => {
      it("evaluates no session once the connection has closed", async () => {
        const server = createServer("refresh-closed");
        try {
          const peer = await connectPeer(server);
          await openSession(peer, SPACE);
          expect(await peer.connection.refreshDirty(SPACE)).toBe(1);
          peer.connection.close();
          expect(await peer.connection.refreshDirty(SPACE)).toBe(0);
        } finally {
          await server.close();
        }
      });

      it("evaluates no session whose proof chain has expired", async () => {
        const clock = { now: 1_000_000 };
        const server = new Server({
          store: new URL("memory://memory-v2-authority-guards-refresh-chain"),
          subscriptionRefreshDelayMs: "manual",
          // Untested-crypto and test-only: the principal is the invocation's
          // `iss`.
          authorizeSessionOpen: (message) =>
            typeof message.invocation?.iss === "string"
              ? message.invocation.iss
              : undefined,
          sessionOpenAuth: { audience: AUDIENCE, nowSeconds: () => clock.now },
          acl: { mode: "enforce", delegations: true },
        });
        /** Opens the space as `principal`, presenting `chain`. */
        const open = async (
          peer: WirePeer,
          principal: string,
          chain: Delegation[] = [],
        ): Promise<string> => {
          const opened = await request<SessionOpenResult>(peer, {
            type: "session.open",
            space: space.did(),
            session: {},
            invocation: {
              iss: principal,
              aud: peer.auth.audience,
              challenge: peer.auth.challenge.value,
              ...(chain.length === 0 ? {} : { prf: chain.map((d) => d.cid) }),
            },
            ...(chain.length === 0 ? {} : {
              authorization: {
                proofs: chain.map((d) => new FabricBytes(d.bytes)),
              },
            }),
          });
          if (opened.ok === undefined) {
            throw new Error(`open failed: ${opened.error?.message}`);
          }
          peer.auth = opened.ok.sessionOpen;
          return opened.ok.sessionId;
        };
        try {
          // The space makes itself its own owner, and nobody else anything.
          const authority = await connectPeer(server);
          const ownerSession = await open(authority, space.did());
          const initialized = await request(authority, {
            type: "transact",
            space: space.did(),
            sessionId: ownerSession,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [
                set(`of:${space.did()}`, { [space.did()]: "OWNER" }),
              ],
            },
          });
          expect(initialized.error).toBeUndefined();

          const member = await connectPeer(server);
          const expiring = await issueDelegation(space, {
            aud: alice.did(),
            sub: space.did(),
            cmd: "/memory",
            pol: [],
            exp: clock.now + 100,
          });
          await open(member, alice.did(), [expiring]);
          expect(await member.connection.refreshDirty(space.did())).toBe(1);
          clock.now += 101;
          expect(await member.connection.refreshDirty(space.did())).toBe(0);
        } finally {
          await server.close();
        }
      });
    });
  });
});
