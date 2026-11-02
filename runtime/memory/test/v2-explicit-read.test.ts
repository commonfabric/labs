// The read-side admission row (protocol.md §2's READ row; the read half of
// §1's transaction identity model, ledger LD5, amended by owner routing R3).
// A read naming an explicit `entity_scope_key` is admitted for the space's
// own serving session on this server — an in-process session whose
// principal holds the space's live lease — and for any session
// authenticated as the deployment's service identity, the delegating class,
// under the named actor's READ grant on the space. Everyone else naming a
// key is refused; a read naming none resolves from the session as today.

import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  resolveScopeKey,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  setServerExecutionConfig,
  toValuePath,
  type WatchSetResult,
} from "../v2.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  releaseExecutionLease,
} from "../v2/execution-lease.ts";

const TEST_AUDIENCE = "did:key:z6Mk-explicit-read-audience";
const SPACE = "did:key:z6Mk-explicit-read-space";
const SERVICE = "did:key:z6Mk-explicit-read-service";
const ALICE = "did:key:z6Mk-explicit-read-alice";
const BOB = "did:key:z6Mk-explicit-read-bob";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

/** A connection to `server`: from another process unless `inProcess`. */
const connect = async (
  server: Server,
  options: { inProcess?: boolean } = {},
): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect(
    (message) => messages.push(message),
    undefined,
    options,
  );
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen! };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  harness: Harness,
  principal: string,
  session: { sessionId?: string; sessionToken?: string } = {},
): Promise<{ sessionId: string; sessionToken: string; sync?: unknown }> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space: SPACE,
    session,
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    {
      sessionId: string;
      sessionToken: string;
      sessionOpen: SessionOpenAuthMetadata;
      sync?: unknown;
    }
  >;
  assertExists(response.ok, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return {
    sessionId: response.ok.sessionId,
    sessionToken: response.ok.sessionToken,
    ...(response.ok.sync === undefined ? {} : { sync: response.ok.sync }),
  };
};

const newServer = (store: string): Server =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    // The service identity is the server's delegating class, as a toolshed
    // running server execution lists its own process identity.
    acl: { mode: "off", delegatingDids: [SERVICE] },
  });

Deno.test("explicit entity_scope_key reads: the space's serving session and a service-identity session are admitted, an ordinary client and the off flag are refused (protocol.md §2's read row)", async () => {
  const server = newServer("memory://explicit-read");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);

    // Alice writes her own user-scoped instance — the doc under
    // `user:<alice>` that only the read row lets another party name.
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The SpaceServer's loopback session: in process, as the service
    // identity the lease holder was minted from, holding the live lease.
    const service = await connect(server, { inProcess: true });
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);
    const readAlice = (sessionId: string, label: string) =>
      server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId(label),
        space: SPACE,
        sessionId,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      });

    // The serving session names alice's instance and reads it.
    const held = await readAlice(serviceSession, "held");
    assertExists(held.ok, JSON.stringify(held.error));
    assertEquals(held.ok.entities.length, 1);
    assertEquals(held.ok.entities[0].document?.value, { name: "alice" });

    // Bob's ordinary client session naming a key is REJECTED — the wire
    // field exists now, so the refusal must too.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await readAlice(bobSession, "refused");
    assertEquals(refused.ok, undefined);
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("not the deployment's service identity"),
      true,
      JSON.stringify(refused.error),
    );

    // The watch path refuses identically.
    const refusedWatch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("refused-watch"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w1",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertEquals(refusedWatch.error?.name, "ProtocolError");

    // Bob's key-less read still resolves from his own session (empty —
    // his instance holds nothing), unchanged from today.
    const bobOwn = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("bob-own"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    }) as ResponseMessage<GraphQueryResult>;
    assertExists(bobOwn.ok);
    assertEquals(bobOwn.ok.entities[0]?.document ?? null, null);

    // The watch.ADD path refuses identically (the third admission
    // site).
    const refusedWatchAdd = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("refused-watch-add"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w2",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertEquals(refusedWatchAdd.error?.name, "ProtocolError");

    // The lease expires (liveness is judged by the server's own clock —
    // serving-loop.md §2). The session is no longer the space's serving
    // session on this server, so its named read is a foreign one: admitted
    // under alice's own READ grant on the space, which a space with no
    // list gives nobody. The lease itself no longer gates it.
    releaseExecutionLease(engine, { space: SPACE, holder });
    assertEquals(
      acquireExecutionLease(engine, {
        space: SPACE,
        holder,
        now: Date.now() - 60_000,
        ttlMs: 1,
      }),
      true,
    );
    const unlisted = await readAlice(serviceSession, "expired-unlisted");
    assertEquals(unlisted.error?.name, "ProtocolError");
    assertEquals(
      unlisted.error?.message.includes("grant-scoped read"),
      true,
      JSON.stringify(unlisted.error),
    );
    await server.writeDocument(SPACE, `of:${SPACE}`, { [ALICE]: "OWNER" });
    const granted = await readAlice(serviceSession, "expired-granted");
    assertExists(granted.ok, JSON.stringify(granted.error));
    assertEquals(granted.ok.entities[0].document?.value, { name: "alice" });

    // Off the flag the field is unclaimable, serving session or not.
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);
    resetServerExecutionConfig();
    const offFlag = await readAlice(serviceSession, "off-flag");
    assertEquals(offFlag.error?.name, "ProtocolError");
    assertEquals(
      offFlag.error?.message.includes("EXPERIMENTAL_SERVER_EXECUTION"),
      true,
    );
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("explicit entity_scope_key reads: an anonymous session naming a key is refused, since without a principal it serves nothing (protocol.md §2's read row)", async () => {
  const server = newServer("memory://explicit-read-anonymous");
  setServerExecutionConfig(true);
  try {
    const anonymous = await connect(server);
    await anonymous.connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: nextRequestId("open-anonymous"),
      space: SPACE,
      session: {},
      invocation: {
        aud: anonymous.sessionOpen.audience,
        challenge: anonymous.sessionOpen.challenge.value,
      },
    }));
    const opened = shiftMessage(anonymous.messages) as ResponseMessage<
      { sessionId: string }
    >;
    assertExists(opened.ok, JSON.stringify(opened.error));

    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("anonymous-named"),
      space: SPACE,
      sessionId: opened.ok.sessionId,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: resolveScopeKey("user", { principal: ALICE }),
          selector: { path: [], schema: false },
        }],
      },
    });

    assertEquals(refused.ok, undefined);
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("not the deployment's service identity"),
      true,
      JSON.stringify(refused.error),
    );
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// Delivery to a session admitted an explicit-instance read: the keying it was
// admitted with is the session's wire vocabulary for its life, and so is the
// delivery of the instances it named (protocol.md §3). Neither hangs from the
// lease once the read is admitted.

/** Doc-ids upserted by session/effect frames at or past `from`. */
const effectUpsertIds = (
  messages: ServerMessage[],
  from: number,
): string[] => {
  const ids: string[] = [];
  for (const message of messages.slice(from)) {
    if ((message as { type?: string }).type !== "session/effect") continue;
    const effect = (message as {
      effect?: { upserts?: Array<{ id: string }> };
    }).effect;
    for (const upsert of effect?.upserts ?? []) ids.push(upsert.id);
  }
  return ids;
};

/** Drive delivery deterministically: each idle() drains the pending
 * refresh pass (which may requeue once internally — hence the bounded
 * loop, macrotask-yielding so a deferred requeue can arm before the next
 * drain). Iteration-bounded, never wall-clock-bounded, so machine load
 * cannot flake it. */
const drainDelivery = async (
  server: Server,
  done: () => boolean,
): Promise<void> => {
  for (let pass = 0; pass < 50; pass++) {
    if (done()) return;
    await server.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const expireLease = (
  engine: Awaited<ReturnType<Server["engineForSpace"]>>,
  holder: string,
): void => {
  releaseExecutionLease(engine, { space: SPACE, holder });
  // Leave an EXPIRED row: liveness is judged by expiry, and an expired
  // row must match nobody (serving-loop.md §2).
  assertEquals(
    acquireExecutionLease(engine, {
      space: SPACE,
      holder,
      now: Date.now() - 60_000,
      ttlMs: 1,
    }),
    true,
  );
};

const watchAliceInstance = (
  sessionId: string,
  aliceKey: string,
  watchId = "w-foreign",
) => ({
  type: "session.watch.set" as const,
  requestId: nextRequestId("watch"),
  space: SPACE,
  sessionId,
  watches: [{
    id: watchId,
    kind: "graph" as const,
    query: {
      roots: [{
        id: "of:profile",
        scope: "user" as const,
        entityScopeKey: aliceKey as never,
        selector: { path: [], schema: false as const },
      }],
    },
  }],
});

const writeAliceProfile = async (
  server: Server,
  aliceSession: string,
  localSeq: number,
  value: Record<string, string>,
): Promise<void> => {
  const write = await server.transact({
    type: "transact",
    requestId: nextRequestId("write"),
    space: SPACE,
    sessionId: aliceSession,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:profile",
        scope: "user",
        value: { value },
      }],
    },
  });
  assertExists(write.ok, JSON.stringify(write.error));
};

Deno.test("delivery of a named foreign instance outlives the lease: a serving session whose lease lapsed keeps receiving the instance it was admitted, keyed, and so does its resumed session (owner routing R3)", async () => {
  const server = newServer("memory://explicit-read-lapse");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server, { inProcess: true });
    const opened = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet(
      watchAliceInstance(opened.sessionId, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));
    assertEquals(
      watch.ok.sync.upserts.map((upsert) => upsert.id),
      ["of:profile"],
    );

    // The lease lapses. The admission stands: alice's next write reaches
    // the session, keyed.
    expireLease(engine, holder);
    const lapsedFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(
      server,
      () =>
        effectUpserts(service.messages, lapsedFrom).some((upsert) =>
          upsert.id === "of:profile"
        ),
    );
    const lapsed = effectUpserts(service.messages, lapsedFrom).filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(lapsed.length, 1, "delivered while the lease is lapsed");
    assertEquals(lapsed[0].scopeKey, aliceKey, "keyed");
    assertEquals(lapsed[0].doc?.value, { name: "alice-2" });

    // The connection dies and foreign state moves; the session resumed on
    // another connection takes the update in its catch-up, keyed, holding
    // no lease at all.
    service.connection.close();
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    await drainDelivery(server, () => false);
    const resumedHarness = await connect(server, { inProcess: true });
    const resumed = await openSession(resumedHarness, SERVICE, {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    });
    assertEquals(resumed.sessionId, opened.sessionId);
    const sync = resumed.sync as {
      upserts?: Array<
        { id: string; scopeKey?: string; doc?: { value?: unknown } }
      >;
    } | undefined;
    const caughtUp = (sync?.upserts ?? []).filter((upsert) =>
      upsert.id === "of:profile"
    );
    assertEquals(caughtUp.length, 1, "the resume catch-up carries the update");
    assertEquals(caughtUp[0].scopeKey, aliceKey);
    assertEquals(caughtUp[0].doc?.value, { name: "alice-3" });

    alice.connection.close();
    resumedHarness.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

const writeOwnProfile = async (
  server: Server,
  sessionId: string,
  localSeq: number,
  value: Record<string, string>,
): Promise<void> => {
  const write = await server.transact({
    type: "transact",
    requestId: nextRequestId("own-write"),
    space: SPACE,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:profile",
        scope: "user",
        value: { value },
      }],
    },
  });
  assertExists(write.ok, JSON.stringify(write.error));
};

Deno.test("an admitted session's keyed-delivered foreign instance is retracted BY KEY when its watch drops the instance: its own instance of the same doc is never named", async () => {
  // protocol.md §3's sticky wire vocabulary: an instance delivered keyed is
  // retracted keyed, since an unkeyed remove names the session's own
  // instance in its replica.

  const server = newServer("memory://explicit-read-keyed-retract");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server, { inProcess: true });
    const opened = await openSession(service, SERVICE);
    // The service writes ITS OWN instance of the same doc: the own instance
    // and a demander's instance of one (branch, id, scope) side by side.
    await writeOwnProfile(server, opened.sessionId, 1, {
      name: "service-own",
    });
    const serviceKey = resolveScopeKey("user", { principal: SERVICE });
    const engine = await server.engineForSpace(SPACE);
    assertEquals(
      acquireExecutionLease(engine, {
        space: SPACE,
        holder: executionLeaseHolder(SERVICE),
        ttlMs: 600_000,
      }),
      true,
    );

    const ownRoot = {
      id: "of:profile",
      scope: "user" as const,
      selector: { path: [], schema: false as const },
    };
    const both = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch-both"),
      space: SPACE,
      sessionId: opened.sessionId,
      watches: [{
        id: "w-both",
        kind: "graph",
        query: {
          roots: [ownRoot, { ...ownRoot, entityScopeKey: aliceKey as never }],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(both.ok, JSON.stringify(both.error));
    assertEquals(
      both.ok.sync.upserts.map((upsert) => upsert.scopeKey).toSorted(),
      [aliceKey, serviceKey].toSorted(),
      "both instances delivered, each keyed",
    );

    // The watch set drops alice's instance.
    const own = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch-own"),
      space: SPACE,
      sessionId: opened.sessionId,
      watches: [{
        id: "w-both",
        kind: "graph",
        query: { roots: [ownRoot] },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(own.ok, JSON.stringify(own.error));
    const removes = own.ok.sync.removes.filter((remove) =>
      remove.id === "of:profile"
    );
    assertEquals(removes.length, 1, "exactly alice's instance is retracted");
    assertEquals(removes[0].scopeKey, aliceKey, "retracted BY KEY");
    // The replacement's sync re-sends the evaluated set; the own instance is
    // among the upserts, keyed, and never among the removes.
    assertEquals(
      own.ok.sync.upserts
        .filter((upsert) => upsert.id === "of:profile")
        .map((upsert) => upsert.scopeKey),
      [serviceKey],
      "the own instance is delivered under its own key, not retracted",
    );

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

//
// Instance identity across the wire seam
//
// Threads r3731191411 and r3731191526: the wire strips scope KEYS (frames
// carry scope names), so the server must refuse what the wire cannot express
// — one watch set (or query) resolving TWO instances of one (branch, id,
// scope) — and must treat a changed `entityScopeKey` on an existing watch id
// as a changed spec, never silently the same watch.
//

Deno.test("stage A: a lease holder names two instances of one (branch, id, scope) and receives BOTH, keyed — watch.set, watch.add, graph.query, and the push frame; the collapse guard still refuses a non-holder (OW17's wire leg)", async () => {
  // OW17's wire leg (server-execution v2 stage A, 2026-08-16): a LIVE lease
  // holder may name two instances of one (branch, id, scope) — its frames and
  // query results carry the instance key (`scopeKey`) per entry, so the two
  // stay apart on its wire and in its replica (the serving replica holding BOTH
  // the service instance and a demander's instance of one doc). The wire
  // collapse guard stays for everyone else: a NON-holder's wire carries scope
  // names only, so its ambiguous read set is still refused loudly.

  const server = newServer("memory://explicit-read-two-instances");
  setServerExecutionConfig(true);
  try {
    // Alice's and Bob's own instances of one doc.
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const bobWrite = await server.transact({
      type: "transact",
      requestId: nextRequestId("bob-write"),
      space: SPACE,
      sessionId: bobSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:profile",
          scope: "user",
          value: { value: { name: "bob" } },
        }],
      },
    });
    assertExists(bobWrite.ok, JSON.stringify(bobWrite.error));

    const service = await connect(server, { inProcess: true });
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const aliceKey = resolveScopeKey("user", { principal: ALICE });
    const bobKey = resolveScopeKey("user", { principal: BOB });

    // watch.set naming BOTH instances of one (id, scope): admitted; the
    // full sync carries two upserts, each KEYED with its instance and
    // carrying that instance's document.
    const both = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("both"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-both",
        kind: "graph",
        query: {
          roots: [
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: aliceKey,
              selector: { path: [], schema: false },
            },
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: bobKey,
              selector: { path: [], schema: false },
            },
          ],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(both.ok, JSON.stringify(both.error));
    const byKey = new Map(
      both.ok.sync.upserts.map((upsert) => [upsert.scopeKey, upsert]),
    );
    assertEquals([...byKey.keys()].toSorted(), [aliceKey, bobKey].toSorted());
    assertEquals(byKey.get(aliceKey)?.doc?.value, { name: "alice" });
    assertEquals(byKey.get(bobKey)?.doc?.value, { name: "bob" });
    // Every keyed upsert still carries the scope NAME (the pre-existing
    // fields are untouched; the key is an addition).
    for (const upsert of both.ok.sync.upserts) {
      assertEquals(upsert.scope, "user");
      assertEquals(upsert.id, "of:profile");
    }

    // The same ambiguity split across an existing watch and a watch.add
    // is admitted for the holder too (the delivery unit is keyed).
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("add-second"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-alice-again",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertExists(added.ok, JSON.stringify(added.error));

    // graph.query naming both: two snapshots, each keyed.
    const query = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("query-both"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [
          {
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          },
          {
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          },
        ],
      },
    }) as ResponseMessage<GraphQueryResult>;
    assertExists(query.ok, JSON.stringify(query.error));
    assertEquals(
      query.ok.entities.map((entity) => entity.scopeKey).toSorted(),
      [aliceKey, bobKey].toSorted(),
    );

    // The PUSH frame after Bob's next write names his instance — the
    // holder's replica can tell whose doc moved.
    const before = service.messages.length;
    const bobAgain = await server.transact({
      type: "transact",
      requestId: nextRequestId("bob-write-2"),
      space: SPACE,
      sessionId: bobSession,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:profile",
          scope: "user",
          value: { value: { name: "bob-2" } },
        }],
      },
    });
    assertExists(bobAgain.ok, JSON.stringify(bobAgain.error));
    await drainDelivery(
      server,
      () => effectUpsertIds(service.messages, before).length > 0,
    );
    const pushed = service.messages.slice(before)
      .filter((message) =>
        (message as { type?: string }).type ===
          "session/effect"
      )
      .flatMap((message) =>
        (message as {
          effect?: { upserts?: Array<{ scopeKey?: string; doc?: unknown }> };
        }).effect?.upserts ?? []
      );
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0].scopeKey, bobKey);
    assertEquals(
      (pushed[0].doc as { value?: unknown } | undefined)?.value,
      { name: "bob-2" },
    );

    // The collapse guard is UNCHANGED for a non-holder: Bob's own session
    // naming two instances is refused with the collapse message (his wire
    // carries names only, and he could not name a foreign instance
    // anyway).
    const refused = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("non-holder-both"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w-bob-both",
        kind: "graph",
        query: {
          roots: [
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: aliceKey,
              selector: { path: [], schema: false },
            },
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: bobKey,
              selector: { path: [], schema: false },
            },
          ],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("resolves two instances"),
      true,
    );

    // And a non-holder's UNKEYED frames stay byte-identical: no
    // `scopeKey` field anywhere in Bob's own watch of his own instance.
    const bobOwn = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("bob-own"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w-bob-own",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(bobOwn.ok, JSON.stringify(bobOwn.error));
    assertEquals(bobOwn.ok.sync.upserts.length, 1);
    assertEquals("scopeKey" in bobOwn.ok.sync.upserts[0], false);
    assertEquals(bobOwn.ok.sync.upserts[0].doc?.value, { name: "bob-2" });

    service.connection.close();
    alice.connection.close();
    bob.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

/** Every session/effect frame's upserts at or past `from`, with keys. */
const effectUpserts = (
  messages: ServerMessage[],
  from: number,
): Array<{ id: string; scopeKey?: string; doc?: { value?: unknown } }> =>
  messages.slice(from)
    .filter((message) =>
      (message as { type?: string }).type === "session/effect"
    )
    .flatMap((message) =>
      (message as {
        effect?: {
          upserts?: Array<
            { id: string; scopeKey?: string; doc?: { value?: unknown } }
          >;
        };
      }).effect?.upserts ?? []
    );

Deno.test("watch.add with a changed entityScopeKey on an existing watch id is a changed spec, not silently the old instance", async () => {
  const server = newServer("memory://explicit-read-changed-key");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server, { inProcess: true });
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const aliceKey = resolveScopeKey("user", { principal: ALICE });
    const bobKey = resolveScopeKey("user", { principal: BOB });

    const first = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey, "w-keyed"),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(first.ok, JSON.stringify(first.error));

    // Same watch id, DIFFERENT explicit instance: the spec changed, and
    // pretending otherwise keeps tracking the old instance while the
    // caller believes it watches the new one.
    const changed = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("changed-key"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-keyed",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertExists(
      changed.error,
      "a changed entityScopeKey must not be silently accepted as the " +
        "same watch spec",
    );

    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

//
// Delivery-failure rollback
//
// For explicit foreign instances (thread r3731191415): the wire frame carries
// scope NAMES, so rollback cannot recover the instance from the frame alone —
// the server must retain the frame's true instance keys. A lost
// foreign-instance frame must be REDELIVERED once sends succeed again.
//

Deno.test("a failed delivery of an explicit foreign-instance frame is redelivered (rollback keys the exact instance)", async () => {
  const server = newServer("memory://explicit-read-rollback");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // A connection whose callback can be made to throw: the send
    // boundary is the delivery commit point, so a throwing callback is
    // exactly an undelivered frame.
    const serviceMessages: ServerMessage[] = [];
    let effectFailuresRemaining = 0;
    const serviceConnection = server.connect(
      (message) => {
        if (
          effectFailuresRemaining > 0 &&
          (message as { type?: string }).type === "session/effect"
        ) {
          effectFailuresRemaining -= 1;
          throw new Error("socket died (test-induced)");
        }
        serviceMessages.push(message);
      },
      undefined,
      { inProcess: true },
    );
    await serviceConnection.receive(encodeMemoryBoundary(HELLO));
    const hello = serviceMessages.shift() as HelloOkMessage;
    assertExists(hello.sessionOpen);
    const service: Harness = {
      messages: serviceMessages,
      connection: serviceConnection,
      sessionOpen: hello.sessionOpen!,
    };
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));

    // The foreign instance moves; the frame's FIRST send FAILS (one
    // induced failure — the retry pass sends normally).
    effectFailuresRemaining = 1;
    const redeliverFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });

    // The rolled-back delivery must recompute and REDELIVER the foreign
    // upsert (a rollback that mapped the frame to the session's own
    // instance leaves the foreign entry cached as current and never
    // resends it).
    await drainDelivery(
      server,
      () =>
        effectUpsertIds(service.messages, redeliverFrom).includes("of:profile"),
    );
    const redelivered = service.messages.slice(redeliverFrom).some(
      (message) => {
        if ((message as { type?: string }).type !== "session/effect") {
          return false;
        }
        const upserts = (message as {
          effect?: {
            upserts?: Array<{ id: string; doc?: { value?: unknown } }>;
          };
        }).effect?.upserts ?? [];
        return upserts.some((upsert) =>
          upsert.id === "of:profile" &&
          JSON.stringify(upsert.doc?.value) === JSON.stringify({
              name: "alice-2",
            })
        );
      },
    );
    assertEquals(
      redelivered,
      true,
      "the lost foreign-instance frame must be redelivered once sends " +
        "succeed (rollback must key the frame's true instance)",
    );

    alice.connection.close();
    serviceConnection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("a non-canonical entity_scope_key (raw '/') is refused at admission — descendant composite keys never see it (thread r3731191505; the shared-validator fix)", async () => {
  const server = newServer("memory://explicit-read-noncanonical");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server, { inProcess: true });
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    // Even the LIVE HOLDER cannot name a merely prefix-shaped key: the
    // tracker key vocabulary is `/`-delimited, so a raw '/' inside a
    // scope key would corrupt addressing downstream. Refused up front by
    // the canonical-grammar validator.
    for (
      const bad of ["user:a/b", "user:did:key:x", "session:a/b:c", "user:%2f"]
    ) {
      const refused = await server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId("noncanonical"),
        space: SPACE,
        sessionId: serviceSession,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bad as never,
            selector: { path: [], schema: false },
          }],
        },
      });
      assertEquals(
        refused.error?.name,
        "ProtocolError",
        `expected refusal for ${JSON.stringify(bad)}`,
      );
      assertEquals(
        refused.error?.message.includes("malformed entity_scope_key"),
        true,
        `expected the malformed-key refusal for ${JSON.stringify(bad)}`,
      );
    }
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// Owner routing R3 — the read row across processes (protocol.md §2;
// docs/plans/serving-loop-owner-routing.md):
//
// - A session is the space's SERVING session on this server when it is in
//   process and its principal holds the space's live lease: its named reads
//   are admitted outright, and its unnamed scoped reads resolve its own
//   instance (the OW17 residual).
// - Every other session authenticated as the service identity, the
//   delegating class — a routed session from another process, or an
//   in-process session reading a space it does not serve — names an actor's
//   instance under that actor's READ grant on the space, and its unnamed
//   scoped read is refused (the grant-scoped read, RULED 2026-10-27).
// - A lease held on this server admits no session from another process:
//   the principal matches, the connection does not.

const HOME_SPACE = "did:key:z6Mk-explicit-read-home";

const openSessionIn = async (
  harness: Harness,
  space: string,
  principal: string,
  session: { actingAs?: "space-owner" } = {},
): Promise<{ sessionId: string }> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session,
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    { sessionId: string; sessionOpen: SessionOpenAuthMetadata }
  >;
  assertExists(response.ok, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return { sessionId: response.ok.sessionId };
};

/**
 * Writes `space`'s genesis access list as the space identity, the one write
 * that identity may make without a grant: a foreign scoped read is admitted
 * on the named actor's READ grant in this list.
 */
const initializeSpaceAcl = async (
  server: Server,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const authority = await connect(server);
  const { sessionId } = await openSessionIn(authority, space, space);
  const written = await server.transact({
    type: "transact",
    requestId: nextRequestId("acl"),
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: `of:${space}`, value: { value: acl } }],
    },
  });
  assertExists(written.ok, JSON.stringify(written.error));
  authority.connection.close();
};

Deno.test("a service-identity session from another process names a foreign space's instance under the actor's READ grant on the space, holding no lease anywhere; an ordinary client stays refused (owner routing R3)", async () => {
  const server = newServer("memory://explicit-read-routed");
  setServerExecutionConfig(true);
  try {
    // Alice's instance lives in SPACE, which she owns. The grant-scoped
    // read admits the named instance on alice's own READ grant in SPACE's
    // list, to a session of the service identity routed here from the
    // process serving another space.
    await initializeSpaceAcl(server, SPACE, { [ALICE]: "OWNER" });
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const admitted = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("routed"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(
      admitted.ok,
      `the service identity is admitted under the grant: ${
        JSON.stringify(admitted.error)
      }`,
    );
    assertEquals(admitted.ok.entities.length, 1);
    assertEquals(admitted.ok.entities[0].document?.value, { name: "alice" });

    // A plain client with NO lease anywhere stays refused — the class
    // admits the service identity, never everyone.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("routed-client"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(refused.error?.name, "ProtocolError");

    alice.connection.close();
    service.connection.close();
    bob.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("a lease held on this server admits only the in-process session that holds it: a service-identity session from another process naming an ungranted instance is refused where the space's serving session is admitted (owner routing R3)", async () => {
  const server = newServer("memory://explicit-read-per-process");
  setServerExecutionConfig(true);
  try {
    await initializeSpaceAcl(server, SPACE, { [ALICE]: "OWNER" });
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const bobKey = resolveScopeKey("user", { principal: BOB });

    // This process serves SPACE: its holder is on the lease row.
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const readBob = (sessionId: string, label: string) =>
      server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId(label),
        space: SPACE,
        sessionId,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          }],
        },
      });

    // A routed session from a sibling process: the holder's own principal,
    // over a connection that is not in process. Bob's instance is read
    // under bob's grant, which alice's list does not give.
    const routed = await connect(server);
    const { sessionId: routedSession } = await openSessionIn(
      routed,
      SPACE,
      SERVICE,
    );
    const refused = await readBob(routedSession, "routed-ungranted");
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "a session from another process must not pass on this process's " +
        `lease row: ${JSON.stringify(refused.ok)}`,
    );
    assertEquals(
      refused.error?.message.includes(
        `grants ${BOB} nothing (READ required)`,
      ),
      true,
      JSON.stringify(refused.error),
    );

    // The space's own serving session names any instance: it derives them
    // all.
    const serving = await connect(server, { inProcess: true });
    const { sessionId: servingSession } = await openSessionIn(
      serving,
      SPACE,
      SERVICE,
    );
    const admitted = await readBob(servingSession, "serving-any");
    assertExists(admitted.ok, JSON.stringify(admitted.error));
    assertEquals(admitted.ok.entities[0]?.document ?? null, null);

    alice.connection.close();
    routed.connection.close();
    serving.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("a service session naming a FOREIGN instance of an actor the space grants no READ is refused (the grant-scoped read), as is one in a space with no list", async () => {
  const server = newServer("memory://explicit-read-ungranted");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const bobKey = resolveScopeKey("user", { principal: BOB });
    const query = (label: string) =>
      server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId(label),
        space: SPACE,
        sessionId: serviceSession,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          }],
        },
      });

    // SPACE has history and no list: the client path's compat arm would
    // admit any authenticated principal; the serving plane's grant does
    // not exist, so the named read refuses.
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const unlisted = await query("ungranted-no-list");
    assertEquals(unlisted.error?.name, "ProtocolError");
    assertEquals(
      unlisted.error?.message.includes("grant-scoped read"),
      true,
      JSON.stringify(unlisted),
    );

    // Alice's list grants bob nothing: bob's instance is refused to the
    // holder, while alice's own stays admitted on her OWNER entry.
    await server.writeDocument(SPACE, `of:${SPACE}`, { [ALICE]: "OWNER" });
    const ungranted = await query("ungranted-listed");
    assertEquals(ungranted.error?.name, "ProtocolError");
    assertEquals(
      ungranted.error?.message.includes(
        `grants ${BOB} nothing (READ required)`,
      ),
      true,
      JSON.stringify(ungranted),
    );
    const granted = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("granted-owner"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: resolveScopeKey("user", { principal: ALICE }),
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(granted.ok, JSON.stringify(granted.error));
    assertEquals(granted.ok.entities[0].document?.value, { name: "alice" });

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("a serving session's UNNAMED scoped read of a space it does not serve on this server is refused fail-closed, from another process or in process; an ordinary client's read, a space-scope read and the space's own serving session's read are untouched (the grant-scoped read)", async () => {
  const server = newServer("memory://explicit-read-fail-closed");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });

    // A serving runtime's session from another process, routed here as
    // SPACE's owner: the service identity under the serving binding.
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
      { actingAs: "space-owner" },
    );
    const unnamedScoped = (sessionId: string, label: string) =>
      server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId(label),
        space: SPACE,
        sessionId,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            selector: { path: [], schema: false },
          }],
        },
      });

    // An UNNAMED scoped root would resolve user:<serviceDID> — a silently
    // EMPTY instance. It refuses loudly instead.
    const refused = await unnamedScoped(serviceSession, "fail-closed");
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "an unnamed scoped read by a serving session in a space it does not " +
        `serve here must refuse fail-closed, never silently resolve the ` +
        `service instance: ${JSON.stringify(refused.ok)}`,
    );
    assertEquals(
      refused.error?.message.includes("grant-scoped read"),
      true,
      JSON.stringify(refused.error),
    );

    const refusedOperation = await server.operationFieldQuery({
      type: "op.query",
      requestId: nextRequestId("fail-closed-operation"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        id: "of:profile",
        scope: "user",
        path: toValuePath([]),
      },
    });
    assertEquals(refusedOperation.error?.name, "ProtocolError");

    const refusedOperationWatch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("fail-closed-operation-watch"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "operation:profile",
        kind: "operation",
        query: {
          id: "of:profile",
          scope: "user",
          path: toValuePath([]),
        },
      }],
    });
    assertEquals(refusedOperationWatch.error?.name, "ProtocolError");

    // The same read from an in-process serving session whose lease is on
    // another space refuses too: this server serves HOME_SPACE for it, not
    // SPACE.
    const homeEngine = await server.engineForSpace(HOME_SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(homeEngine, {
        space: HOME_SPACE,
        holder,
        ttlMs: 600_000,
      }),
      true,
    );
    const coHosted = await connect(server, { inProcess: true });
    const { sessionId: coHostedSession } = await openSessionIn(
      coHosted,
      SPACE,
      SERVICE,
      { actingAs: "space-owner" },
    );
    const refusedInProcess = await unnamedScoped(
      coHostedSession,
      "fail-closed-in-process",
    );
    assertEquals(
      refusedInProcess.error?.name,
      "ProtocolError",
      JSON.stringify(refusedInProcess.ok),
    );

    // The same session's unnamed SPACE-scope read stays free (§2b's
    // free-read row): only scoped roots are the trap.
    const spaceRead = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("space-scope"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(spaceRead.ok, JSON.stringify(spaceRead.error));

    // An ordinary client's unnamed scoped read is untouched (resolves
    // its own instance as today).
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const bobOwn = await unnamedScoped(
      bobSession,
      "bob-own",
    ) as ResponseMessage<
      GraphQueryResult
    >;
    assertExists(bobOwn.ok, JSON.stringify(bobOwn.error));

    // The space's own serving session — in process, holding its lease —
    // keeps today's tolerated behavior for an unnamed scoped read of it:
    // the home collapsed-view path (the OW17 residual), not the
    // cross-space trap.
    const { sessionId: homeSession } = await openSessionIn(
      coHosted,
      HOME_SPACE,
      SERVICE,
      { actingAs: "space-owner" },
    );
    const homeRead = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("home-scoped"),
      space: HOME_SPACE,
      sessionId: homeSession,
      query: {
        roots: [{
          id: "of:home-doc",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(homeRead.ok, JSON.stringify(homeRead.error));

    alice.connection.close();
    service.connection.close();
    coHosted.connection.close();
    bob.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});
