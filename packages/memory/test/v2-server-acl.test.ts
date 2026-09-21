/**
 * The v2 `Server`'s space access control, exercised over the session
 * protocol: what each `acl` mode admits and refuses, how a session is
 * revoked when its grant goes away, the genesis and shape rules an ACL
 * document is held to, the delegated READ binding a delegating principal
 * opens with `actingAs: "space-owner"`, and `sameAcl()`.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { readGenesisRoot } from "../v2/genesis-root.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { sameAcl } from "../acl.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type Operation,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
} from "../v2.ts";

const HELLO_FLAGS = getMemoryProtocolFlags();
const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;

const ALICE = "did:key:z6Mk-acl-alice";
const BOB = "did:key:z6Mk-acl-bob";
const CAROL = "did:key:z6Mk-acl-carol";
const SERVICE = "did:key:z6Mk-acl-service";
const TEST_AUDIENCE = "did:key:z6Mk-acl-test-audience";

/**
 * Asserts that `value` is neither `undefined` nor `null`, and narrows it to
 * say so.
 */
function expectExists<T>(
  value: T,
  message?: string,
): asserts value is NonNullable<T> {
  expect(value, message).toBeDefined();
  expect(value, message).not.toBeNull();
}

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  expectExists(message, "expected a server message");
  return message;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  expect(message.type).toBe("response");
  return message as ResponseMessage<Result>;
};

// CT-1927: every transact verdict stages a catch-up marker that rides the
// next batched frame — a marker-only empty frame when nothing watched is
// dirty. Tests whose subject is not verdict ordering shift past those
// frames here; the ordering contract itself is pinned by
// v2-verdict-catchup.test.ts.
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      return assertResponse<Result>(message);
    }
    // Only MARKER-ONLY frames may be skipped implicitly: no upserts, no
    // removes, and carrying the caughtUpLocalSeq marker that is such a
    // frame's reason to exist. Anything else is content a test must consume
    // explicitly, or an erroneous self-echo or markerless empty frame would
    // be silently swallowed here.
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
};

/** Server whose session principal is taken (untested-crypto, test-only) from
 *  `invocation.iss`, mirroring the toolshed hook's result. */
const createAclServer = (
  store: string | URL,
  acl?: {
    mode: "off" | "observe" | "enforce";
    serviceDids?: readonly string[];
    delegatingDids?: readonly string[];
  },
) =>
  new Server({
    store: typeof store === "string" ? new URL(store) : store,
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
    acl,
  });

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  expect(hello.type).toBe("hello.ok");
  expectExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  { connection, messages, sessionOpen }: Harness,
  space: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session,
    invocation: {
      iss: principal,
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  return nextResponse<SessionOpenResult>(messages);
};

const transactOperation = async (
  { connection, messages }: Pick<Harness, "connection" | "messages">,
  space: string,
  sessionId: string,
  operation: Record<string, unknown>,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: nextRequestId("tx"),
    space,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      // Deliberately malformed: this suite feeds the server operations it
      // must reject, so the payload is not an `Operation`.
      operations: [operation as unknown as Operation],
    },
  }));
  return nextResponse<{ seq: number }>(messages);
};

const transactSet = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
  value: unknown,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  return await transactOperation(
    { connection, messages },
    space,
    sessionId,
    { op: "set", id, value: { value } },
    localSeq,
  );
};

const graphQuery = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
): Promise<ResponseMessage<GraphQueryResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "graph.query",
    requestId: nextRequestId("query"),
    space,
    sessionId,
    query: { roots: [{ id, selector: { path: [], schema: false } }] },
  }));
  return nextResponse<GraphQueryResult>(messages);
};

/** Initialize a fresh space through the space identity, then transfer OWNER
 *  to the normal user. This mirrors the named-space bootstrap path. */
const initializeSpaceAcl = async (
  server: Server,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const authority = await connect(server);
  const opened = await openSession(authority, space, space);
  expectExists(opened.ok, "space identity should open its own space");
  const initialized = await transactSet(
    authority,
    space,
    opened.ok.sessionId,
    `of:${space}`,
    acl,
    1,
  );
  expectExists(initialized.ok, "space identity should initialize the ACL");
};

describe("v2-server-acl", () => {
  describe("`enforce` mode", () => {
    it("leaves a new space unclaimed by an ordinary opener and returns `AuthorizationError` for their write", async () => {
      const server = createAclServer("memory://acl-enforce-stranger", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-1";
      const alice = await connect(server);
      try {
        const opened = await openSession(alice, space, ALICE);
        expectExists(
          opened.ok,
          "an authenticated principal may inspect a new space",
        );
        expect(opened.ok.serverSeq, "an ordinary open must not claim it").toBe(
          0,
        );

        const acl = await graphQuery(
          alice,
          space,
          opened.ok.sessionId,
          `of:${space}`,
        );
        expectExists(acl.ok);
        expect(
          acl.ok.entities[0]?.document ?? null,
          "ordinary open must not seed an ACL",
        ).toBeNull();

        const write = await transactSet(
          alice,
          space,
          opened.ok.sessionId,
          "of:doc:1",
          { hello: "world" },
          1,
        );
        expect(write.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("seals a custom root reservation at genesis and refuses changing it afterward", async () => {
      const server = createAclServer("memory://custom-root-genesis", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-custom-root-space";
      const root = {
        source: "system:loom/main.tsx",
        cause: "publication-seed",
      };
      try {
        const authority = await connect(server);
        const opened = await openSession(authority, space, space, {
          genesisRoot: root,
        });
        expectExists(opened.ok);
        const commit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          genesisRoot: root,
          operations: [{
            op: "set" as const,
            id: `of:${space}`,
            value: { value: { [ALICE]: "OWNER" } },
          }],
        };
        await authority.connection.receive(
          encodeMemoryBoundary({
            type: "transact",
            requestId: nextRequestId("root"),
            space,
            sessionId: opened.ok.sessionId,
            commit,
          }),
        );
        expect(nextResponse(authority.messages).error).toBeUndefined();
        expect(readGenesisRoot(await server.engineForSpace(space))).toEqual(
          root,
        );
        const owner = await connect(server);
        const ownerSession = await openSession(owner, space, ALICE);
        expectExists(ownerSession.ok);
        await owner.connection.receive(
          encodeMemoryBoundary({
            type: "transact",
            requestId: nextRequestId("root-replace"),
            space,
            sessionId: ownerSession.ok.sessionId,
            commit: {
              ...commit,
              genesisRoot: { ...root, cause: "replacement" },
            },
          }),
        );
        expect(nextResponse(owner.messages).error?.name).toBe(
          "AuthorizationError",
        );
        expect(readGenesisRoot(await server.engineForSpace(space))).toEqual(
          root,
        );
      } finally {
        await server.close();
      }
    });

    it("refuses a genesis transaction that differs from its authenticated root intent", async () => {
      const root = { source: "system:loom/main.tsx", cause: "signed-intent" };
      for (const variant of ["undeclared", "changed", "omitted"] as const) {
        const server = createAclServer(`memory://root-intent-${variant}`, {
          mode: "enforce",
        });
        const space = `did:key:z6Mk-root-intent-${variant}`;
        try {
          const authority = await connect(server);
          const opened = await openSession(
            authority,
            space,
            space,
            variant === "undeclared" ? {} : { genesisRoot: root },
          );
          expectExists(opened.ok);
          await authority.connection.receive(encodeMemoryBoundary({
            type: "transact",
            requestId: nextRequestId("intent"),
            space,
            sessionId: opened.ok.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              ...(variant === "omitted" ? {} : {
                genesisRoot: variant === "changed"
                  ? { ...root, cause: "changed" }
                  : root,
              }),
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: { value: { [ALICE]: "OWNER" } },
              }],
            },
          }));
          expect(nextResponse(authority.messages).error?.name, variant).toBe(
            "AuthorizationError",
          );
          expect(readGenesisRoot(await server.engineForSpace(space)))
            .toBeUndefined();
          const acl = await graphQuery(
            authority,
            space,
            opened.ok.sessionId,
            `of:${space}`,
          );
          expectExists(acl.ok);
          expect(acl.ok.entities[0]?.document ?? null).toBeNull();
        } finally {
          await server.close();
        }
      }
    });

    it("refuses a custom root source outside the deployment's system sources", async () => {
      const server = createAclServer("memory://custom-root-invalid-source", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-invalid-custom-root-space";
      try {
        const authority = await connect(server);
        const opened = await openSession(authority, space, space);
        expectExists(opened.ok);
        await authority.connection.receive(encodeMemoryBoundary({
          type: "transact",
          requestId: nextRequestId("invalid-root"),
          space,
          sessionId: opened.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            genesisRoot: {
              source: "https://example.com/untrusted.tsx",
              cause: "seed",
            },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [ALICE]: "OWNER" } },
            }],
          },
        }));
        expect(nextResponse(authority.messages).error?.name).toBe(
          "ProtocolError",
        );
        expect(readGenesisRoot(await server.engineForSpace(space)))
          .toBeUndefined();
      } finally {
        await server.close();
      }
    });

    it("accepts the space identity's genesis ACL, then admits the granted owner and refuses everyone else", async () => {
      const server = createAclServer("memory://acl-enforce-space-genesis", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-genesis";
      const authority = await connect(server);
      const alice = await connect(server);
      try {
        const authoritySession = await openSession(authority, space, space);
        expectExists(
          authoritySession.ok,
          "space identity should open its space",
        );
        expect(authoritySession.ok.serverSeq).toBe(0);

        const genesis = await transactSet(
          authority,
          space,
          authoritySession.ok.sessionId,
          `of:${space}`,
          { [ALICE]: "OWNER" },
          1,
        );
        expectExists(genesis.ok, "space identity should write the genesis ACL");

        const opened = await openSession(alice, space, ALICE);
        expectExists(opened.ok, "the initialized owner should open the space");

        const acl = await graphQuery(
          alice,
          space,
          opened.ok.sessionId,
          `of:${space}`,
        );
        expectExists(acl.ok);
        const aclDoc = JSON.stringify(acl.ok);
        expect(aclDoc, "genesis should grant the user OWNER").toContain(ALICE);
        expect(aclDoc, "genesis should grant the user OWNER").toContain(
          "OWNER",
        );

        const write = await transactSet(
          alice,
          space,
          opened.ok.sessionId,
          "of:doc:1",
          { hello: "world" },
          1,
        );
        expectExists(write.ok, "initialized owner should be able to write");

        const bob = await connect(server);
        const denied = await openSession(bob, space, BOB);
        expect(denied.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("accepts a transact under a `WRITE` grant and returns `AuthorizationError` for its ACL-document write", async () => {
      const server = createAclServer("memory://acl-enforce-write-grant", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-2";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "WRITE",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);

        const bobSession = await openSession(bob, space, BOB);
        expectExists(bobSession.ok, "WRITE grant should allow session open");

        const write = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { from: "bob" },
          1,
        );
        expectExists(write.ok, "WRITE grant should allow transact");

        // ...but Bob cannot self-promote: ACL-doc writes need OWNER.
        const escalate = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          `of:${space}`,
          { [BOB]: "OWNER" },
          2,
        );
        expect(escalate.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("accepts a graph query under a `READ` grant and returns `AuthorizationError` for its write", async () => {
      const server = createAclServer("memory://acl-enforce-read-grant", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-3";
      const alice = await connect(server);
      const carol = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [CAROL]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);
        await transactSet(
          alice,
          space,
          aliceSession.ok.sessionId,
          "of:doc:shared",
          { shared: true },
          1,
        );

        const carolSession = await openSession(carol, space, CAROL);
        expectExists(carolSession.ok, "READ grant should allow session open");

        const query = await graphQuery(
          carol,
          space,
          carolSession.ok.sessionId,
          "of:doc:shared",
        );
        expectExists(query.ok, "READ grant should allow graph queries");

        const write = await transactSet(
          carol,
          space,
          carolSession.ok.sessionId,
          "of:doc:carol",
          { from: "carol" },
          1,
        );
        expect(write.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it('opens the space to any principal read-only under a `"*"` `READ` grant', async () => {
      const server = createAclServer("memory://acl-enforce-anyone", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-4";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          "*": "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);

        const bobSession = await openSession(bob, space, BOB);
        expectExists(
          bobSession.ok,
          "'*' READ should allow any principal to open",
        );
        const write = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { from: "bob" },
          1,
        );
        expect(write.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("gives a service DID implicit `OWNER` without claiming the space for it", async () => {
      const server = createAclServer("memory://acl-enforce-service", {
        mode: "enforce",
        serviceDids: [SERVICE],
      });
      const space = "did:key:z6Mk-acl-space-5";
      const service = await connect(server);
      const alice = await connect(server);
      try {
        const serviceSession = await openSession(service, space, SERVICE);
        expectExists(serviceSession.ok, "service DID should open any space");
        const ordinaryWrite = await transactSet(
          service,
          space,
          serviceSession.ok.sessionId,
          "of:doc:svc",
          { from: "service" },
          1,
        );
        expect(
          ordinaryWrite.error?.name,
          "even the service must initialize a new space with an ACL",
        ).toBe("AuthorizationError");

        const initialize = await transactSet(
          service,
          space,
          serviceSession.ok.sessionId,
          `of:${space}`,
          { [ALICE]: "OWNER" },
          2,
        );
        expectExists(
          initialize.ok,
          "service DID should initialize a valid ACL",
        );

        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);
        const write = await transactSet(
          alice,
          space,
          aliceSession.ok.sessionId,
          "of:doc:alice",
          { from: "alice" },
          1,
        );
        expectExists(write.ok);
      } finally {
        await server.close();
      }
    });

    it("accepts a private claim from the principal equal to the space DID", async () => {
      const server = createAclServer("memory://acl-enforce-space-key", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-6";
      const holder = await connect(server);
      try {
        const session = await openSession(holder, space, space);
        expectExists(
          session.ok,
          "space-key principal should open its own space",
        );
        const claim = await transactSet(
          holder,
          space,
          session.ok.sessionId,
          `of:${space}`,
          { [space]: "OWNER" },
          1,
        );
        expectExists(claim.ok, "space-key principal should initialize its ACL");
        const write = await transactSet(
          holder,
          space,
          session.ok.sessionId,
          "of:doc:self",
          { self: true },
          2,
        );
        expectExists(write.ok);
      } finally {
        await server.close();
      }
    });

    it("revokes the session of a principal whose grant is removed and refuses its later messages", async () => {
      const server = createAclServer("memory://acl-enforce-revoke", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-7";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "WRITE",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);

        const bobSession = await openSession(bob, space, BOB);
        expectExists(bobSession.ok);
        const first = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { n: 1 },
          1,
        );
        expectExists(first.ok, "grant should allow Bob's first write");

        // Owner revokes Bob. Bob's live session is torn down (gating alone
        // would still let his existing subscriptions receive pushes).
        const revoke = await transactSet(
          alice,
          space,
          aliceSession.ok.sessionId,
          `of:${space}`,
          { [ALICE]: "OWNER" },
          1,
        );
        expectExists(revoke.ok);

        const revoked = shiftMessage(bob.messages);
        expect(revoked).toEqual({
          type: "session/revoked",
          space,
          sessionId: bobSession.ok.sessionId,
          reason: "unauthorized",
        });

        const second = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { n: 2 },
          2,
        );
        expect(second.error?.name, "the revoked session must be gone").toBe(
          "SessionError",
        );

        // And Bob cannot just open a new one.
        const reopen = await openSession(bob, space, BOB);
        expect(reopen.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("fails a resumed open with `SessionRevokedError` when revocation lands during its catch-up", async () => {
      const server = createAclServer(
        "memory://acl-enforce-resume-revoke-race",
        {
          mode: "enforce",
        },
      );
      const space = "did:key:z6Mk-acl-space-resume-revoke-race";
      const alice = await connect(server);
      const bob = await connect(server);
      const catchupStarted = Promise.withResolvers<void>();
      const releaseCatchup = Promise.withResolvers<void>();
      const originalSync = server.syncSessionForConnection.bind(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        bob.connection.close();
        await server.idle();
        const resumed = await connect(server);

        const blockedSync: Server["syncSessionForConnection"] = async (
          ...args
        ) => {
          catchupStarted.resolve();
          await releaseCatchup.promise;
          return await originalSync(...args);
        };
        server.syncSessionForConnection = blockedSync;

        const reopening = server.openSession({
          type: "session.open",
          requestId: nextRequestId("resume-revoke-race"),
          space,
          session: {
            sessionId: bobSession.ok.sessionId,
            sessionToken: bobSession.ok.sessionToken,
          },
          invocation: {
            iss: BOB,
            aud: resumed.sessionOpen.audience,
            challenge: resumed.sessionOpen.challenge.value,
          },
        }, resumed.connection);
        await catchupStarted.promise;

        const revoke = await server.transact({
          type: "transact",
          requestId: nextRequestId("resume-revoke-race-revoke"),
          space,
          sessionId: aliceSession.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [ALICE]: "OWNER" } },
            }],
          },
        });
        expectExists(revoke.ok);
        releaseCatchup.resolve();

        const reopened = await reopening;
        expect(reopened.ok).toBeUndefined();
        expect(reopened.error?.name).toBe("SessionRevokedError");
        expect(server.isSessionAttached(
          space,
          bobSession.ok.sessionId,
          resumed.connection.id,
        )).toBe(false);
      } finally {
        releaseCatchup.resolve();
        server.syncSessionForConnection = originalSync;
        await server.close();
      }
    });

    it("rejects a taken-over session's in-flight transaction with `SessionError`", async () => {
      const server = createAclServer("memory://acl-enforce-transact-takeover", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-transact-takeover";
      const first = await connect(server);
      const second = await connect(server);
      const openEngineStarted = Promise.withResolvers<void>();
      const releaseOpenEngine = Promise.withResolvers<void>();
      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const opened = await openSession(first, space, ALICE);
        expectExists(opened.ok);

        let pauseNextOpen = true;
        server.accessForTestingOnly.engineOpener = async (
          requestedSpace,
          open,
        ) => {
          if (pauseNextOpen) {
            pauseNextOpen = false;
            openEngineStarted.resolve();
            await releaseOpenEngine.promise;
          }
          return await open(requestedSpace);
        };

        const staleWrite = server.transact({
          type: "transact",
          requestId: nextRequestId("transact-takeover-stale"),
          space,
          sessionId: opened.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:doc:stale-takeover",
              value: { value: { stale: true } },
            }],
          },
        });
        await openEngineStarted.promise;

        const replacement = await openSession(second, space, ALICE, {
          sessionId: opened.ok.sessionId,
          sessionToken: opened.ok.sessionToken,
        });
        expectExists(replacement.ok);
        expect(shiftMessage(first.messages)).toEqual({
          type: "session/revoked",
          space,
          sessionId: opened.ok.sessionId,
          reason: "taken-over",
        });

        releaseOpenEngine.resolve();
        const rejected = await staleWrite;
        expect(rejected.error?.name).toBe("SessionError");
        expect(await server.readDocument(space, "of:doc:stale-takeover"))
          .toBeNull();
      } finally {
        releaseOpenEngine.resolve();
        await server.close();
      }
    });

    it("rejects a write queued behind the revocation of its session", async () => {
      const server = createAclServer("memory://acl-enforce-revoke-race", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-revoke-race";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "OWNER",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        // Starting the revoke first deterministically queues both transactions
        // at the old ACL. Session validity and authorization are checked beside
        // apply: once Alice's ACL commit lands and revokes Bob, Bob's
        // already-started request is denied before it can commit.
        const [revoke, write] = await Promise.all([
          server.transact({
            type: "transact",
            requestId: nextRequestId("revoke-race"),
            space,
            sessionId: aliceSession.ok.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: { value: { [ALICE]: "OWNER" } },
              }],
            },
          }),
          server.transact({
            type: "transact",
            requestId: nextRequestId("write-race"),
            space,
            sessionId: bobSession.ok.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:doc:bob-race",
                value: { value: { shouldNotLand: true } },
              }],
            },
          }),
        ]);
        expectExists(revoke.ok);
        expect(write.error?.name).toBe("SessionError");
        expect(await server.readDocument(space, "of:doc:bob-race")).toBeNull();
      } finally {
        await server.close();
      }
    });

    it("evaluates a graph query queued ahead of a revocation against the old ACL", async () => {
      const server = createAclServer("memory://acl-enforce-query-race", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-query-race";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        // Starting the query first deterministically queues both operations at
        // the old ACL. Authorization and graph evaluation must share one engine
        // turn: Bob may receive the old ACL, but must never read the
        // post-revoke ACL.
        const [query, revoke] = await Promise.all([
          server.graphQuery({
            type: "graph.query",
            requestId: nextRequestId("query-race"),
            space,
            sessionId: bobSession.ok.sessionId,
            query: {
              roots: [{
                id: `of:${space}`,
                selector: { path: [], schema: false },
              }],
            },
          }),
          server.transact({
            type: "transact",
            requestId: nextRequestId("query-race-revoke"),
            space,
            sessionId: aliceSession.ok.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: { value: { [ALICE]: "OWNER" } },
              }],
            },
          }),
        ]);

        expectExists(revoke.ok);
        expect(query.ok?.entities[0]?.document?.value).toEqual({
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
      } finally {
        await server.close();
      }
    });

    it("settles an in-flight query with `SessionRevokedError` after the revocation", async () => {
      const server = createAclServer("memory://acl-enforce-query-send-race", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-query-send-race";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        const queryRequestId = nextRequestId("query-send-race");
        const query = bob.connection.receive(encodeMemoryBoundary({
          type: "graph.query",
          requestId: queryRequestId,
          space,
          sessionId: bobSession.ok.sessionId,
          query: {
            roots: [{
              id: `of:${space}`,
              selector: { path: [], schema: false },
            }],
          },
        }));
        // Let the connection enter graphQuery and block on its engine turn
        // before the competing ACL commit runs.
        await Promise.resolve();
        const revoke = server.transact({
          type: "transact",
          requestId: nextRequestId("query-send-race-revoke"),
          space,
          sessionId: aliceSession.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [ALICE]: "OWNER" } },
            }],
          },
        });
        expectExists((await revoke).ok);
        await query;

        expect(bob.messages).toEqual([
          {
            type: "session/revoked",
            space,
            sessionId: bobSession.ok.sessionId,
            reason: "unauthorized",
          },
          {
            type: "response",
            requestId: queryRequestId,
            error: {
              name: "SessionRevokedError",
              message: "Session was revoked while the request was in flight",
            },
          },
        ]);
      } finally {
        await server.close();
      }
    });

    it("evaluates a watch set queued ahead of a revocation against the old ACL", async () => {
      const server = createAclServer("memory://acl-enforce-watch-race", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-watch-race";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        const [watch, revoke] = await Promise.all([
          server.watchSet({
            type: "session.watch.set",
            requestId: nextRequestId("watch-race"),
            space,
            sessionId: bobSession.ok.sessionId,
            watches: [{
              id: "acl",
              kind: "graph",
              query: {
                roots: [{
                  id: `of:${space}`,
                  selector: { path: [], schema: false },
                }],
              },
            }],
          }),
          server.transact({
            type: "transact",
            requestId: nextRequestId("watch-race-revoke"),
            space,
            sessionId: aliceSession.ok.sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: { value: { [ALICE]: "OWNER" } },
              }],
            },
          }),
        ]);

        expectExists(revoke.ok);
        expect(watch.ok?.sync.upserts[0]?.doc?.value).toEqual({
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
      } finally {
        await server.close();
      }
    });

    it("emits nothing from an in-flight refresh once the session is revoked", async () => {
      const server = createAclServer("memory://acl-enforce-refresh-race", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-refresh-race";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);

        const watchedId = "of:doc:refresh-race";
        await bob.connection.receive(encodeMemoryBoundary({
          type: "session.watch.set",
          requestId: nextRequestId("watch-refresh-race"),
          space,
          sessionId: bobSession.ok.sessionId,
          watches: [{
            id: "acl",
            kind: "graph",
            query: {
              roots: [{
                id: watchedId,
                selector: { path: [], schema: false },
              }],
            },
          }],
        }));
        expectExists(assertResponse(shiftMessage(bob.messages)).ok);

        // Make the watched graph differ from Bob's cached snapshot.
        // writeDocument schedules its normal timer refresh, but the manual
        // refresh below starts in this turn before that timer can run.
        await server.writeDocument(space, watchedId, { changed: true });

        // refreshDirty yields while re-evaluating the watch. The revoke then
        // drops Bob's session before the refresh result is ready to send.
        const refresh = bob.connection.refreshDirty(space);
        const revoke = server.transact({
          type: "transact",
          requestId: nextRequestId("refresh-race-revoke"),
          space,
          sessionId: aliceSession.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [ALICE]: "OWNER" } },
            }],
          },
        });
        expectExists((await revoke).ok);
        await refresh;

        expect(bob.messages).toEqual([{
          type: "session/revoked",
          space,
          sessionId: bobSession.ok.sessionId,
          reason: "unauthorized",
        }]);
      } finally {
        await server.close();
      }
    });

    it("returns the commit response to an owner who removes their own access before revoking them", async () => {
      // The writing session must receive its transact response before any
      // revocation — otherwise the client treats session/revoked as terminal
      // and reports the successful self-removal as a failure. The access change
      // still takes effect on the owner's next message.
      const server = createAclServer("memory://acl-enforce-self-remove", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-space-self";
      const alice = await connect(server);
      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);

        // Alice rewrites the ACL to drop herself entirely (someone else owns
        // now).
        const selfRemove = await transactSet(
          alice,
          space,
          aliceSession.ok.sessionId,
          `of:${space}`,
          { [BOB]: "OWNER" },
          1,
        );
        expectExists(
          selfRemove.ok,
          "self-removal commit must succeed and report ok, not a revocation",
        );
        // The terminal session/revoked ARRIVES — but only AFTER the verdict
        // (transactSet consumed the response above, so it ordered first). The
        // detached session can never be delivered a catch-up marker, and the
        // revocation is what tells the client its sync channel is gone so a
        // parked accept applies immediately (CT-1927).
        expect(
          alice.messages.map((message) => (message as { type?: string }).type),
          "the writer is revoked only after its own response",
        ).toEqual(["session/revoked"]);
        alice.messages.length = 0;

        // The writer's session was still dropped from the registry (so it
        // receives no further pushes without READ): its next message fails
        // closed as an unknown session.
        const after = await transactSet(
          alice,
          space,
          aliceSession.ok.sessionId,
          "of:doc:after",
          { n: 1 },
          2,
        );
        expect(after.error?.name).toBe("SessionError");
      } finally {
        await server.close();
      }
    });

    it("grants authenticated `READ` and `WRITE` but never `OWNER` on a legacy space without an ACL", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "memory-acl-public-",
      });
      const store = toFileUrl(`${directory}/`);
      const space = "did:key:z6Mk-acl-legacy-public";
      try {
        const seedServer = createAclServer(store, { mode: "off" });
        try {
          const seed = await connect(seedServer);
          const opened = await openSession(seed, space, ALICE);
          expectExists(opened.ok);
          const write = await transactSet(
            seed,
            space,
            opened.ok.sessionId,
            "of:doc:legacy",
            { legacy: true },
            1,
          );
          expectExists(write.ok);
        } finally {
          await seedServer.close();
        }

        const server = createAclServer(store, { mode: "enforce" });
        try {
          const bob = await connect(server);
          const opened = await openSession(bob, space, BOB);
          expectExists(opened.ok, "legacy ACL-less space should be public");

          const read = await graphQuery(
            bob,
            space,
            opened.ok.sessionId,
            "of:doc:legacy",
          );
          expectExists(read.ok);
          expect(read.ok.entities[0]?.document?.value).toEqual({
            legacy: true,
          });

          const write = await transactSet(
            bob,
            space,
            opened.ok.sessionId,
            "of:doc:bob",
            { public: true },
            1,
          );
          expectExists(write.ok, "public compatibility includes WRITE");

          const claim = await transactSet(
            bob,
            space,
            opened.ok.sessionId,
            `of:${space}`,
            { [BOB]: "OWNER" },
            2,
          );
          expect(
            claim.error?.name,
            "public compatibility must never grant OWNER",
          ).toBe("AuthorizationError");
        } finally {
          await server.close();
        }
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("accepts the space identity's claim on a legacy home space and revokes its public readers", async () => {
      const directory = await Deno.makeTempDir({ prefix: "memory-acl-home-" });
      const store = toFileUrl(`${directory}/`);
      const space = ALICE;
      try {
        const seedServer = createAclServer(store, { mode: "off" });
        try {
          const bob = await connect(seedServer);
          const opened = await openSession(bob, space, BOB);
          expectExists(opened.ok);
          expectExists(
            (await transactSet(
              bob,
              space,
              opened.ok.sessionId,
              "of:doc:legacy-home",
              { legacy: true },
              1,
            )).ok,
          );
        } finally {
          await seedServer.close();
        }

        const server = createAclServer(store, { mode: "enforce" });
        try {
          const legacyReader = await connect(server);
          const legacySession = await openSession(legacyReader, space, BOB);
          expectExists(legacySession.ok, "legacy home starts public");

          const holder = await connect(server);
          const opened = await openSession(holder, space, space);
          expectExists(opened.ok);
          const claim = await transactSet(
            holder,
            space,
            opened.ok.sessionId,
            `of:${space}`,
            { [space]: "OWNER" },
            1,
          );
          expectExists(claim.ok);

          expect(shiftMessage(legacyReader.messages)).toEqual({
            type: "session/revoked",
            space,
            sessionId: legacySession.ok.sessionId,
            reason: "unauthorized",
          });

          const bob = await connect(server);
          const denied = await openSession(bob, space, BOB);
          expect(denied.error?.name).toBe("AuthorizationError");
        } finally {
          await server.close();
        }
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("returns `ProtocolError` for an ACL mutation that leaves no concrete owner", async () => {
      const server = createAclServer("memory://acl-validate-owner", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-validate-owner";
      const alice = await connect(server);
      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const opened = await openSession(alice, space, ALICE);
        expectExists(opened.ok);

        const invalidOperations: Record<string, unknown>[] = [
          { op: "set", id: `of:${space}`, value: { value: {} } },
          {
            op: "set",
            id: `of:${space}`,
            value: { value: { "*": "OWNER" } },
          },
          {
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "READ" } },
          },
          {
            op: "set",
            id: `of:${space}`,
            value: { value: { [ALICE]: "ADMIN" } },
          },
          { op: "delete", id: `of:${space}` },
          {
            op: "patch",
            id: `of:${space}`,
            patches: [{ op: "remove", path: `/${ALICE}` }],
          },
          {
            op: "set",
            id: `of:${space}`,
            scope: "user",
            value: { value: { [ALICE]: "OWNER" } },
          },
        ];

        let localSeq = 1;
        for (const operation of invalidOperations) {
          const response = await transactOperation(
            alice,
            space,
            opened.ok.sessionId,
            operation,
            localSeq++,
          );
          expect(response.error?.name).toBe("ProtocolError");
        }

        const acl = await graphQuery(
          alice,
          space,
          opened.ok.sessionId,
          `of:${space}`,
        );
        expect(acl.ok?.entities[0]?.document?.value).toEqual({
          [ALICE]: "OWNER",
        });
      } finally {
        await server.close();
      }
    });

    it("returns `ProtocolError` for a genesis ACL without a concrete `OWNER` and leaves the space uninitialized", async () => {
      // The runner's genesis-supplied ACL option hands the caller's document to
      // this same admission check (no client-side validation): a space identity
      // that tries to mint an unowned or malformed space is refused at genesis
      // with the existing shape error, and genesis stays owed. This pins
      // behavior the server already had — no server code changed — rather than
      // driving new behavior; it reddens when `hasConcreteOwner` is dropped
      // from `#validateAclCommit` (mutation witnessed).
      const server = createAclServer("memory://acl-genesis-unowned", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-genesis-unowned";
      const authority = await connect(server);
      try {
        const opened = await openSession(authority, space, space);
        expectExists(opened.ok, "space identity should open its own space");
        const unowned: Record<string, unknown>[] = [
          {},
          { "*": "OWNER" },
          { "*": "OWNER", [ALICE]: "WRITE" },
          { [ALICE]: "WRITE", [BOB]: "READ" },
          { [ALICE]: "ADMIN" },
        ];
        let localSeq = 1;
        for (const acl of unowned) {
          const response = await transactSet(
            authority,
            space,
            opened.ok.sessionId,
            `of:${space}`,
            acl,
            localSeq++,
          );
          expect(response.error?.name).toBe("ProtocolError");
          expect(response.error?.message).toBe(
            "ACL must be valid and retain at least one concrete OWNER",
          );
        }
        // Still fresh: an ordinary write is refused for want of genesis, and
        // there is no ACL document.
        const ordinary = await transactSet(
          authority,
          space,
          opened.ok.sessionId,
          "of:after-refused-genesis",
          { value: 1 },
          localSeq++,
        );
        expect(ordinary.error?.name).toBe("AuthorizationError");
        expect(ordinary.error?.message).toBe(
          `Space ${space} requires an ACL genesis commit before ordinary writes`,
        );
        expect(await server.readDocument(space, `of:${space}`)).toBeNull();

        // A concrete OWNER then initializes it — the check refused the
        // document, not the identity.
        const sealed = await transactSet(
          authority,
          space,
          opened.ok.sessionId,
          `of:${space}`,
          { [space]: "OWNER", [ALICE]: "WRITE" },
          localSeq++,
        );
        expectExists(sealed.ok);
        expect(sealed.ok.seq, "the genesis ACL is the first commit").toBe(1);
      } finally {
        await server.close();
      }
    });

    it("returns `ProtocolError` for an ACL mutation on a non-default branch or mixed with ordinary writes", async () => {
      const server = createAclServer("memory://acl-validate-commit-shape", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-validate-commit-shape";
      const alice = await connect(server);
      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const opened = await openSession(alice, space, ALICE);
        expectExists(opened.ok);

        const nonDefaultBranch = await server.transact({
          type: "transact",
          requestId: nextRequestId("acl-non-default-branch"),
          space,
          sessionId: opened.ok.sessionId,
          commit: {
            branch: "feature",
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
            }],
          },
        });
        expect(nonDefaultBranch.error?.name).toBe("ProtocolError");

        const mixed = await server.transact({
          type: "transact",
          requestId: nextRequestId("acl-mixed-commit"),
          space,
          sessionId: opened.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: `of:${space}`,
                value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
              },
              {
                op: "set",
                id: "of:ordinary",
                value: { value: { mixed: true } },
              },
            ],
          },
        });
        expect(mixed.error?.name).toBe("ProtocolError");
        expect(await server.readDocument(space, "of:ordinary")).toBeNull();
      } finally {
        await server.close();
      }
    });

    it("authorizes carried SQLite readers and refuses reader impersonation", async () => {
      const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
      const database = new Database(diskPath);
      database.exec("CREATE TABLE lookup (value TEXT)");
      database.exec("INSERT INTO lookup VALUES ('visible')");
      database.close();
      const server = createAclServer("memory://acl-sqlite-carried-reader", {
        mode: "enforce",
        delegatingDids: [SERVICE],
      });
      const space = "did:key:z6Mk-acl-sqlite-reader";
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
        });
        const ownerHarness = await connect(server);
        const owner = await openSession(ownerHarness, space, ALICE);
        const service = await openSession(
          await connect(server),
          space,
          SERVICE,
          {
            actingAs: "space-owner",
          },
        );
        expectExists(owner.ok);
        expectExists(service.ok);
        const registered = await server.sqliteRegisterDiskSource({
          type: "sqlite.register-disk-source",
          requestId: nextRequestId("register"),
          space,
          sessionId: owner.ok.sessionId,
          id: "of:carried-reader-db",
          path: diskPath,
        });
        expectExists(registered.ok);
        const query = (sessionId: string, principal: string) =>
          server.sqliteQuery({
            type: "sqlite.query",
            requestId: nextRequestId("query"),
            space,
            sessionId,
            db: { id: "of:carried-reader-db" },
            sql: "SELECT value FROM lookup",
            reader: { principal },
          });
        expect((await query(service.ok.sessionId, BOB)).ok?.rows).toEqual([{
          value: "visible",
        }]);
        expect((await query(service.ok.sessionId, CAROL)).error?.name).toBe(
          "AuthorizationError",
        );
        expect((await query(owner.ok.sessionId, BOB)).error?.name).toBe(
          "AuthorizationError",
        );
        const readStarted = Promise.withResolvers<void>();
        const resumeRead = Promise.withResolvers<void>();
        let opens = 0;
        server.accessForTestingOnly.engineOpener = async (
          requestedSpace,
          open,
        ) => {
          // The first open authorizes the request; the second opens the cell
          // database for I/O. Hold that read so revocation occurs after initial
          // admission and before the final authorization check.
          if (++opens === 2) {
            readStarted.resolve();
            await resumeRead.promise;
          }
          return await open(requestedSpace);
        };
        const reading = server.sqliteQuery({
          type: "sqlite.query",
          requestId: nextRequestId("in-flight"),
          space,
          sessionId: service.ok.sessionId,
          db: { id: "of:carried-reader-cell-db", tables: {} },
          sql: "SELECT 1",
          reader: { principal: BOB },
        });
        await readStarted.promise;
        let revoked;
        try {
          revoked = await transactSet(
            ownerHarness,
            space,
            owner.ok.sessionId,
            `of:${space}`,
            { [ALICE]: "OWNER" },
            1,
          );
        } finally {
          resumeRead.resolve();
          server.accessForTestingOnly.engineOpener = undefined;
        }
        expect((await reading).error?.name).toBe("AuthorizationError");
        expectExists(revoked.ok);
        expect((await query(service.ok.sessionId, BOB)).error?.name).toBe(
          "AuthorizationError",
        );
      } finally {
        await server.close();
        Deno.removeSync(diskPath);
      }
    });

    it("gates the auxiliary read and operator surfaces by capability", async () => {
      const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
      const database = new Database(diskPath);
      database.exec("CREATE TABLE lookup (value TEXT)");
      database.exec("INSERT INTO lookup (value) VALUES ('visible')");
      database.close();

      const server = createAclServer("memory://acl-auxiliary-surfaces", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-auxiliary-surfaces";
      const alice = await connect(server);
      const bob = await connect(server);
      const carol = await connect(server);
      const diskId = "of:acl-disk-source";
      try {
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [BOB]: "READ",
          [CAROL]: "WRITE",
        });
        const aliceSession = await openSession(alice, space, ALICE);
        const bobSession = await openSession(bob, space, BOB);
        const carolSession = await openSession(carol, space, CAROL);
        expectExists(aliceSession.ok);
        expectExists(bobSession.ok);
        expectExists(carolSession.ok);

        const deniedRegistration = await server.sqliteRegisterDiskSource({
          type: "sqlite.register-disk-source",
          requestId: nextRequestId("acl-disk-register-denied"),
          space,
          sessionId: carolSession.ok.sessionId,
          id: diskId,
          path: diskPath,
        });
        expect(deniedRegistration.error?.name).toBe("AuthorizationError");

        const registered = await server.sqliteRegisterDiskSource({
          type: "sqlite.register-disk-source",
          requestId: nextRequestId("acl-disk-register"),
          space,
          sessionId: aliceSession.ok.sessionId,
          id: diskId,
          path: diskPath,
        });
        expectExists(registered.ok);

        const sqliteRead = await server.sqliteQuery({
          type: "sqlite.query",
          requestId: nextRequestId("acl-sqlite-read"),
          space,
          sessionId: bobSession.ok.sessionId,
          db: { id: diskId },
          sql: "SELECT value FROM lookup",
        });
        expect(sqliteRead.ok?.rows).toEqual([{ value: "visible" }]);

        const entityIds = await server.listEntityIds({
          type: "entity-id.list",
          requestId: nextRequestId("acl-entity-identifiers"),
          space,
          sessionId: bobSession.ok.sessionId,
        });
        expect(entityIds.ok?.ids).toEqual([`of:${space}`]);

        const entityExists = await server.entityIdExists({
          type: "entity-id.exists",
          requestId: nextRequestId("acl-entity-exists"),
          space,
          sessionId: bobSession.ok.sessionId,
          id: `of:${space}`,
        });
        expect(entityExists.ok?.exists).toBe(true);

        const watch = await server.watchAdd({
          type: "session.watch.add",
          requestId: nextRequestId("acl-watch-add"),
          space,
          sessionId: bobSession.ok.sessionId,
          watches: [],
        });
        expectExists(watch.ok);
      } finally {
        await server.close();
        await Deno.remove(diskPath);
      }
    });

    it("returns `AuthorizationError` for entity identifier reads without `READ`", async () => {
      const sessions = new SessionRegistry();
      const server = new Server({
        sessions,
        store: new URL("memory://acl-entity-identifiers-denied"),
        subscriptionRefreshDelayMs: 0,
        authorizeSessionOpen: (message) => {
          const iss = message.invocation?.iss;
          return typeof iss === "string" ? iss : undefined;
        },
        sessionOpenAuth: { audience: TEST_AUDIENCE },
        acl: { mode: "enforce" },
      });
      const space = "did:key:z6Mk-acl-entity-identifiers-denied";

      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        sessions.open(
          space,
          { sessionId: "session:entity-identifiers-denied" },
          1,
          "entity-identifiers-denied",
          BOB,
        );

        const list = await server.listEntityIds({
          type: "entity-id.list",
          requestId: nextRequestId("acl-entity-identifiers-denied"),
          space,
          sessionId: "session:entity-identifiers-denied",
        });
        expect(list.error?.name).toBe("AuthorizationError");

        const lookup = await server.entityIdExists({
          type: "entity-id.exists",
          requestId: nextRequestId("acl-entity-exists-denied"),
          space,
          sessionId: "session:entity-identifiers-denied",
          id: `of:${space}`,
        });
        expect(lookup.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });

    it("rejects a direct write that would create or mutate ACL state", async () => {
      const server = createAclServer("memory://acl-direct-write", {
        mode: "enforce",
      });
      const space = "did:key:z6Mk-acl-direct-write";
      try {
        await expect(
          server.writeDocument(space, "of:doc:direct", { direct: true }),
        ).rejects.toThrow("ACL");

        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        await expect(
          server.writeDocument(space, `of:${space}`, { [BOB]: "OWNER" }),
        ).rejects.toThrow("ACL");

        // Blob authorization is explicitly postponed: the direct path may still
        // update an ordinary document once the space has real ACL state.
        await server.writeDocument(space, "of:doc:existing", { direct: true });
      } finally {
        await server.close();
      }
    });

    it("rejects a direct write when the stored ACL state is malformed", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "memory-acl-direct-",
      });
      const store = toFileUrl(`${directory}/`);
      const space = "did:key:z6Mk-acl-direct-invalid";
      try {
        const seedServer = createAclServer(store, { mode: "off" });
        try {
          await seedServer.writeDocument(space, `of:${space}`, {
            [ALICE]: "READ",
          });
        } finally {
          await seedServer.close();
        }

        const server = createAclServer(store, { mode: "enforce" });
        try {
          await expect(
            server.writeDocument(space, "of:ordinary", { blocked: true }),
          ).rejects.toThrow("invalid ACL state");
        } finally {
          await server.close();
        }
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("fails closed on a malformed or ownerless stored ACL, in `observe` mode as well", async () => {
      for (
        const [label, value] of [
          ["malformed", { [ALICE]: "ADMIN" }],
          ["ownerless", { [ALICE]: "WRITE" }],
        ] as const
      ) {
        const directory = await Deno.makeTempDir({
          prefix: `memory-acl-${label}-`,
        });
        const store = toFileUrl(`${directory}/`);
        const space = `did:key:z6Mk-acl-${label}`;
        try {
          const seedServer = createAclServer(store, { mode: "off" });
          try {
            await seedServer.writeDocument(space, `of:${space}`, value);
          } finally {
            await seedServer.close();
          }

          for (const mode of ["observe", "enforce"] as const) {
            const server = createAclServer(store, { mode });
            try {
              const alice = await connect(server);
              const denied = await openSession(alice, space, ALICE);
              expect(denied.error?.name).toBe("AuthorizationError");
            } finally {
              await server.close();
            }
          }
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    });

    it("fails closed on a retracted ACL instead of making the space public", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "memory-acl-deleted-",
      });
      const store = toFileUrl(`${directory}/`);
      const space = "did:key:z6Mk-acl-deleted";
      try {
        const seedServer = createAclServer(store, { mode: "off" });
        try {
          await seedServer.writeDocument(space, `of:${space}`, {
            [ALICE]: "OWNER",
          });
          const alice = await connect(seedServer);
          const opened = await openSession(alice, space, ALICE);
          expectExists(opened.ok);
          const deleted = await transactOperation(
            alice,
            space,
            opened.ok.sessionId,
            { op: "delete", id: `of:${space}` },
            1,
          );
          expectExists(deleted.ok);
        } finally {
          await seedServer.close();
        }

        const server = createAclServer(store, { mode: "enforce" });
        try {
          const alice = await connect(server);
          const denied = await openSession(alice, space, ALICE);
          expect(denied.error?.name).toBe("AuthorizationError");
        } finally {
          await server.close();
        }
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });

  describe("`observe` mode", () => {
    it("admits a stranger and counts the would-deny", async () => {
      const server = createAclServer("memory://acl-observe", {
        mode: "observe",
      });
      const space = "did:key:z6Mk-acl-space-8";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const aliceSession = await openSession(alice, space, ALICE);
        expectExists(aliceSession.ok);

        const bobSession = await openSession(bob, space, BOB);
        expectExists(bobSession.ok, "observe mode must not deny");
        const write = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { from: "bob" },
          1,
        );
        expectExists(write.ok, "observe mode must not deny writes");
        expect(server.aclStats.wouldDeny).toBeGreaterThan(0);
      } finally {
        await server.close();
      }
    });

    it("returns `AuthorizationError` for an ordinary write to a fresh space until its genesis ACL lands", async () => {
      const server = createAclServer("memory://acl-observe-seed", {
        mode: "observe",
      });
      const space = "did:key:z6Mk-acl-space-9";
      const alice = await connect(server);
      try {
        const opened = await openSession(alice, space, ALICE);
        expectExists(opened.ok);
        const denied = await transactSet(
          alice,
          space,
          opened.ok.sessionId,
          "of:doc:alice",
          { value: true },
          1,
        );
        expect(denied.error?.name).toBe("AuthorizationError");

        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const reopened = await openSession(await connect(server), space, ALICE);
        expectExists(reopened.ok);
      } finally {
        await server.close();
      }
    });
  });

  describe("`off` mode", () => {
    it("seeds no commit and gates nothing", async () => {
      const server = createAclServer("memory://acl-off", { mode: "off" });
      const space = "did:key:z6Mk-acl-space-10";
      const alice = await connect(server);
      const bob = await connect(server);
      try {
        const opened = await openSession(alice, space, ALICE);
        expectExists(opened.ok);
        expect(opened.ok.serverSeq, "off mode must not seed a commit").toBe(0);

        const bobSession = await openSession(bob, space, BOB);
        expectExists(bobSession.ok);
        const write = await transactSet(
          bob,
          space,
          bobSession.ok.sessionId,
          "of:doc:bob",
          { from: "bob" },
          1,
        );
        expectExists(write.ok);
      } finally {
        await server.close();
      }
    });
  });

  describe("no `acl` option", () => {
    it("opens a new space without seeding a commit, as `off` mode does", async () => {
      const server = createAclServer("memory://acl-default");
      const space = "did:key:z6Mk-acl-space-11";
      const bob = await connect(server);
      try {
        const opened = await openSession(bob, space, BOB);
        expectExists(opened.ok);
        expect(opened.ok.serverSeq).toBe(0);
      } finally {
        await server.close();
      }
    });
  });

  describe("the delegated READ binding (OW31)", () => {
    // OW31 (WRITE ruled 2026-08-18, READ ruled 2026-08-19): the delegated READ
    // binding. A session opened `actingAs: "space-owner"` by a DELEGATING-class
    // principal has its READ-class decisions resolved as the space's ACL OWNER
    // (the server dereferences the ACL — the ruled service-identity ACL read);
    // WRITE/OWNER requirements keep resolving against the ENVELOPE, so the
    // binding grants no write path; a delegating principal is NOT a service
    // principal and cannot initialize a genesis.

    describe("`enforce` mode", () => {
      it("admits a delegating principal acting as space-owner to read an owner-only space, and refuses its writes and ACL-document writes", async () => {
        const server = createAclServer("memory://acl-ow31-binding", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-1";
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const plainHarness = await connect(server);
        const service = await connect(server);
        try {
          // WITHOUT the binding: the blanket is gone — the serving identity
          // lacks READ on an owner-only space. (Fresh connection: a denied
          // open still consumes the connection's one challenge.)
          const plain = await openSession(plainHarness, space, SERVICE);
          expectExists(plain.error, "envelope-only open must be denied");
          expect(plain.error?.name).toBe("AuthorizationError");

          // WITH the binding: session.open runs under the acting user (the
          // owner) and is admitted; queries read as the owner.
          const bound = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(bound.ok, bound.error?.message);
          const read = await graphQuery(
            service,
            space,
            bound.ok.sessionId,
            "of:x",
          );
          expectExists(read.ok, read.error?.message);

          // WRITE-class requirements resolve against the ENVELOPE: the
          // serving identity cannot write into a user's space over the
          // session plane (the ruled write posture — served writes ride the
          // wave's delegated carriage instead).
          const write = await transactSet(
            service,
            space,
            bound.ok.sessionId,
            "of:ow31-session-write",
            { denied: true },
            1,
          );
          expectExists(write.error, "session-plane write must be refused");
          expect(write.error?.name).toBe("AuthorizationError");

          // ACL-doc writes need OWNER — envelope again: refused.
          const aclWrite = await transactSet(
            service,
            space,
            bound.ok.sessionId,
            `of:${space}`,
            { [SERVICE]: "OWNER" },
            2,
          );
          expectExists(aclWrite.error, "ACL mutation must be refused");
        } finally {
          await server.close();
        }
      });

      it("returns `AuthorizationError` naming the delegating class for an `actingAs` marker from a non-delegating principal", async () => {
        const server = createAclServer("memory://acl-ow31-nondelegating", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-2";
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          "*": "WRITE",
        });
        const bob = await connect(server);
        try {
          // Even on a space where BOB holds "*" WRITE on his own: the MARKER
          // is an admission-validity claim only a delegating principal may
          // make.
          const refused = await openSession(bob, space, BOB, {
            actingAs: "space-owner",
          });
          expectExists(
            refused.error,
            "non-delegating actingAs must be refused",
          );
          expect(refused.error.name).toBe("AuthorizationError");
          expect(refused.error.message).toContain("delegating");
        } finally {
          await server.close();
        }
      });

      it("refuses a fresh space's genesis ACL from a delegating principal that is not a service DID", async () => {
        const server = createAclServer("memory://acl-ow31-genesis", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-3";
        const service = await connect(server);
        try {
          // Fresh space, actingAs resolves NO binding (no ACL): the envelope's
          // own fresh-space READ floor admits the open.
          const opened = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(opened.ok, opened.error?.message);
          expect(opened.ok.serverSeq).toBe(0);
          // The genesis ACL write is refused: only the space identity or an
          // OWNER-class service DID may initialize (the delegating class is
          // deliberately NOT one — verification-coverage.md OW31's guard
          // against creep).
          const genesis = await transactSet(
            service,
            space,
            opened.ok.sessionId,
            `of:${space}`,
            { [SERVICE]: "OWNER" },
            1,
          );
          expectExists(genesis.error, "delegating genesis must be refused");
          expect(genesis.error.message).toContain("initialize");
        } finally {
          await server.close();
        }
      });

      it("revokes the delegating session when an ACL change removes the bound owner", async () => {
        const server = createAclServer("memory://acl-ow31-revoke", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-4";
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const service = await connect(server);
        const alice = await connect(server);
        try {
          const bound = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(bound.ok, bound.error?.message);

          // ALICE transfers ownership wholly to BOB: the session bound to
          // acting-as-ALICE loses READ and is revoked; the serving plane's
          // next mount re-resolves the new owner.
          const aliceSession = await openSession(alice, space, ALICE);
          expectExists(aliceSession.ok);
          const transferred = await transactSet(
            alice,
            space,
            aliceSession.ok.sessionId,
            `of:${space}`,
            { [BOB]: "OWNER" },
            1,
          );
          expectExists(transferred.ok, transferred.error?.message);

          // The bound session was revoked in place: the service connection
          // received the terminal session/revoked for it (the registry entry
          // is gone; the serving plane's next mount re-resolves the owner).
          const revoked = service.messages.find((message) =>
            message.type === "session/revoked"
          );
          expectExists(revoked, "the bound session must be revoked");
        } finally {
          await server.close();
        }
      });

      it("revokes the bound session on an ownership transfer even when the stale acting principal retains `READ`", async () => {
        const server = createAclServer("memory://acl-ow31-rebind", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        // A SELF-OWNED (home-shaped) space: the binding resolves the space
        // DID itself, whose implicit-OWNER short-circuit would keep READ
        // forever — the stale-binding hazard's worst case (Codex P1 review
        // finding on #6156).
        const space = "did:key:z6Mk-acl-ow31-space-7";
        await initializeSpaceAcl(server, space, { [space]: "OWNER" });
        const service = await connect(server);
        const authority = await connect(server);
        try {
          const bound = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(bound.ok, bound.error?.message);

          // The space identity transfers ownership wholly to BOB. The bound
          // session's stored acting principal (the space DID) still holds
          // implicit OWNER by identity — but it is no longer what the
          // binding WOULD resolve, so the session must be revoked and the
          // next mount re-binds the new owner.
          const spaceSession = await openSession(authority, space, space);
          expectExists(spaceSession.ok);
          const transferred = await transactSet(
            authority,
            space,
            spaceSession.ok.sessionId,
            `of:${space}`,
            { [BOB]: "OWNER" },
            1,
          );
          expectExists(transferred.ok, transferred.error?.message);

          const revoked = service.messages.find((message) =>
            message.type === "session/revoked"
          );
          expectExists(
            revoked,
            "an ownership transfer must revoke the stale binding",
          );
        } finally {
          await server.close();
        }
      });

      it("returns `ProtocolError` for an unknown `actingAs` value, and binds a multi-owner ACL to its lexicographically first concrete owner", async () => {
        const server = createAclServer("memory://acl-ow31-marker-shape", {
          mode: "enforce",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-8";
        // TWO concrete owners, no self-entry, no wildcard: the binding must
        // resolve deterministically (sorted-first — ALICE before CAROL) for
        // the session to read at all.
        await initializeSpaceAcl(server, space, {
          [ALICE]: "OWNER",
          [CAROL]: "OWNER",
        });
        const unknown = await connect(server);
        const bound = await connect(server);
        try {
          const refused = await openSession(unknown, space, SERVICE, {
            actingAs: "space-emperor" as never,
          });
          expectExists(refused.error, "unknown actingAs value must be refused");
          expect(refused.error?.name).toBe("ProtocolError");

          const opened = await openSession(bound, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(opened.ok, opened.error?.message);
          const read = await graphQuery(
            bound,
            space,
            opened.ok.sessionId,
            "of:x",
          );
          expectExists(read.ok, read.error?.message);

          // The DISCRIMINATING half (delta review D4 on #6156): remove ALICE
          // — the lexicographically FIRST owner — from the ACL. If the
          // binding had resolved CAROL, the new resolution (CAROL) would
          // still match and the session would survive; because it resolved
          // ALICE, the owner-resolution revocation branch fires.
          const carol = await connect(server);
          const carolSession = await openSession(carol, space, CAROL);
          expectExists(carolSession.ok);
          const rewritten = await transactSet(
            carol,
            space,
            carolSession.ok.sessionId,
            `of:${space}`,
            { [CAROL]: "OWNER" },
            1,
          );
          expectExists(rewritten.ok, rewritten.error?.message);
          const revoked = bound.messages.find((message) =>
            message.type === "session/revoked"
          );
          expectExists(
            revoked,
            "removing the first-sorted owner must revoke the binding — the " +
              "binding was ALICE, not CAROL",
          );
        } finally {
          await server.close();
        }
      });

      it("stores no binding for an `OWNER`-class service envelope, so an ownership transfer does not revoke it", async () => {
        // The F1 operator combination: the process identity in BOTH
        // MEMORY_SERVICE_DIDS (OWNER-class, verbatim) and the delegating
        // list. The marker is admitted, but no binding is stored — the
        // session's authority is the explicit operator grant, so the
        // owner-resolution revocation branch (and its writerSessionId
        // carve-out skip) never applies to it.
        const server = createAclServer("memory://acl-ow31-ownerclass", {
          mode: "enforce",
          serviceDids: [SERVICE],
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-9";
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const service = await connect(server);
        const alice = await connect(server);
        try {
          const opened = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(opened.ok, opened.error?.message);

          const aliceSession = await openSession(alice, space, ALICE);
          expectExists(aliceSession.ok);
          const transferred = await transactSet(
            alice,
            space,
            aliceSession.ok.sessionId,
            `of:${space}`,
            { [BOB]: "OWNER" },
            1,
          );
          expectExists(transferred.ok, transferred.error?.message);

          // No binding was stored, so the ownership transfer revokes nothing:
          // the OWNER-class grant still reads.
          const revoked = service.messages.find((message) =>
            message.type === "session/revoked"
          );
          expect(revoked, "OWNER-class session must survive").toBeUndefined();
          const read = await graphQuery(
            service,
            space,
            opened.ok.sessionId,
            "of:x",
          );
          expectExists(read.ok, read.error?.message);
        } finally {
          await server.close();
        }
      });
    });

    describe("`observe` mode", () => {
      it("admits a bound session's envelope write and counts it as a would-deny", async () => {
        const server = createAclServer("memory://acl-ow31-observe", {
          mode: "observe",
          delegatingDids: [SERVICE],
        });
        const space = "did:key:z6Mk-acl-ow31-space-5";
        await initializeSpaceAcl(server, space, { [ALICE]: "OWNER" });
        const service = await connect(server);
        try {
          const bound = await openSession(service, space, SERVICE, {
            actingAs: "space-owner",
          });
          expectExists(bound.ok, bound.error?.message);
          const before = server.aclStats.wouldDeny;
          const write = await transactSet(
            service,
            space,
            bound.ok.sessionId,
            "of:ow31-observe-write",
            { observed: true },
            1,
          );
          // Observe mode allows the write but counts it: a non-zero
          // process-identity write would-deny names a residual session-plane
          // write to re-route (verification-coverage.md OW31's canary).
          expectExists(write.ok, write.error?.message);
          expect(server.aclStats.wouldDeny).toBe(before + 1);
        } finally {
          await server.close();
        }
      });
    });

    describe("`off` mode", () => {
      it("admits an open carrying the `actingAs` marker, which has no effect", async () => {
        const server = createAclServer("memory://acl-ow31-off", {
          mode: "off",
        });
        const space = "did:key:z6Mk-acl-ow31-space-6";
        const bob = await connect(server);
        try {
          const opened = await openSession(bob, space, BOB, {
            actingAs: "space-owner",
          });
          expectExists(opened.ok, opened.error?.message);
        } finally {
          await server.close();
        }
      });
    });
  });

  describe("sameAcl()", () => {
    it("returns `true` only for the exact principals and capabilities in any key order, and `false` for an array or scalar", () => {
      const expected = { [ALICE]: "OWNER" as const, [BOB]: "WRITE" as const };
      expect(sameAcl({ [BOB]: "WRITE", [ALICE]: "OWNER" }, expected)).toBe(
        true,
      );
      expect(sameAcl({ [ALICE]: "OWNER" }, expected), "missing row").toBe(
        false,
      );
      expect(sameAcl({ ...expected, [CAROL]: "READ" }, expected), "extra row")
        .toBe(false);
      expect(sameAcl({ [ALICE]: "OWNER", [BOB]: "READ" }, expected)).toBe(
        false,
      );
      expect(sameAcl(null, expected)).toBe(false);
      expect(sameAcl("OWNER", expected)).toBe(false);
      // Red-first witnessed: an array is an object with zero keys, so []
      // matched an empty expected document.
      expect(sameAcl([], {})).toBe(false);
      expect(sameAcl(undefined, {})).toBe(false);
    });
  });
});
