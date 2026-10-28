// Server-execution v2 stage F: the read-side admission row (protocol.md
// §2's READ row; the read half of §1's transaction identity model, ledger
// LD5). A read naming an explicit `entity_scope_key` is admissible only
// for a live lease holder on the co-hosted memory server — the operand
// mapping is the session's authenticated principal equaling the
// SERVICE-IDENTITY component of the space's live DR1 holder. A non-holder
// naming a key is REJECTED (before stage F the wire could not even
// express one); a read naming none resolves from the session as today.

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

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
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
  });

Deno.test("explicit entity_scope_key reads: lease holder admitted, non-holder and off-flag refused (protocol.md §2's read row)", async () => {
  const server = newServer("memory://explicit-read");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);

    // Alice writes her own user-scoped instance — the doc under
    // `user:<alice>` that only the read row lets another party name.
    const write = await server.transact({
      type: "transact",
      requestId: nextRequestId("write"),
      space: SPACE,
      sessionId: aliceSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:profile",
          scope: "user",
          value: { value: { name: "alice" } },
        }],
      },
    });
    assertExists(write.ok);
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The SpaceServer's loopback session: principal = the service
    // identity the DR1 holder was minted from, holding the live lease.
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);

    // The holder names alice's instance explicitly and reads it.
    const held = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("held"),
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
    assertExists(held.ok, JSON.stringify(held.error));
    assertEquals(held.ok.entities.length, 1);
    assertEquals(held.ok.entities[0].document?.value, { name: "alice" });

    // A non-holder (bob's ordinary client session) naming a key is
    // REJECTED — the wire field exists now, so the refusal must too.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("refused"),
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
    assertEquals(refused.ok, undefined);
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("does not hold a live execution_lease"),
      true,
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

    // An EXPIRED lease matches nobody: the same holder session is
    // refused once the row lapses (liveness judged by the server's own
    // clock — serving-loop.md §2).
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
    const expired = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("expired"),
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
    assertEquals(expired.error?.name, "ProtocolError");
    assertEquals(
      expired.error?.message.includes("does not hold a live execution_lease"),
      true,
    );
    // Restore the live lease for the off-flag case below.
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);

    // Off the flag the field is unclaimable, holder or not.
    resetServerExecutionConfig();
    const offFlag = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("off-flag"),
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

// The exemption LIFECYCLE (stage-F fix round, thread r3731191378 — P0):
// `leaseHolderReads` is an authorization exemption tied to holding a LIVE
// execution lease. The push path's applicable-set filter (protocol.md §3)
// must key its bypass on CURRENT holdership, lease loss must clear the
// exemption, and a session resume must revalidate rather than trust the
// persisted bit. A former holder receives NOTHING foreign.

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

Deno.test("lease-holder push exemption dies with the lease: a former holder receives no foreign scoped instances (P0)", async () => {
  const server = newServer("memory://explicit-read-former-holder");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );

    // Holder admitted: the watch response carries alice's instance.
    const watch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));
    assertEquals(
      watch.ok.sync.upserts.map((upsert) => upsert.id),
      ["of:profile"],
    );

    // While the lease is LIVE, pushes deliver the foreign instance.
    const liveFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(
      server,
      () => effectUpsertIds(service.messages, liveFrom).includes("of:profile"),
    );
    assertEquals(
      effectUpsertIds(service.messages, liveFrom).includes("of:profile"),
      true,
      "a LIVE holder receives the foreign instance's refresh frame",
    );

    // The lease lapses. The cached exemption must die with it: the next
    // foreign-instance write is ABSENT from the former holder's frames.
    expireLease(engine, holder);
    const lapsedFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    // Drain until alice's own watcher-free delivery settles: bound the
    // drain by the server going quiet rather than by seeing a frame.
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpsertIds(service.messages, lapsedFrom).filter(
        (id) => id === "of:profile",
      ),
      [],
      "a FORMER holder must not receive foreign scoped instances " +
        "(protocol.md §2's read row is live-lease admission; §3's filter " +
        "applies once the lease is gone)",
    );

    // Recovery is re-admission, not the stale bit: re-acquire the lease
    // and RE-ISSUE the explicit watch — delivery resumes with current
    // state, including the update the filter withheld above.
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const rewatch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(rewatch.ok, JSON.stringify(rewatch.error));
    const rewatchDocs = rewatch.ok.sync.upserts.filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(rewatchDocs.length, 1);
    assertEquals(
      (rewatchDocs[0] as { doc?: { value?: unknown } }).doc?.value,
      { name: "alice-3" },
      "re-admission redelivers the update the filter withheld " +
        "(a filtered entry must never be cached as already-delivered)",
    );

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("the persisted lease-holder exemption does not survive session resume without a live lease", async () => {
  const server = newServer("memory://explicit-read-resume");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
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

    // Connection dies; the lease lapses while the session is detached.
    service.connection.close();
    expireLease(engine, holder);

    // Foreign state moves while detached.
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(server, () => false);

    // Resume. The persisted `leaseHolderReads` bit must be revalidated
    // against the (dead) lease: neither the resume catch-up nor any
    // later push may deliver the foreign instance.
    const resumedHarness = await connect(server);
    const resumed = await openSession(resumedHarness, SERVICE, {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    });
    assertEquals(resumed.sessionId, opened.sessionId);
    const resumeUpserts =
      (resumed.sync as { upserts?: Array<{ id: string }> } | undefined)
        ?.upserts ?? [];
    assertEquals(
      resumeUpserts.filter((upsert) => upsert.id === "of:profile"),
      [],
      "resume catch-up must not deliver foreign instances without a " +
        "live lease (revalidate on resume, never trust the persisted bit)",
    );

    const pushFrom = resumedHarness.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpsertIds(resumedHarness.messages, pushFrom).filter(
        (id) => id === "of:profile",
      ),
      [],
      "post-resume pushes must stay filtered while no live lease is held",
    );

    alice.connection.close();
    resumedHarness.connection.close();
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
// as a changed spec, never silently the same watch. Between those two duties
// sit the cases where a former holder's catch-up retracts a keyed delivery,
// and where a lease that blipped re-arms the exemption rather than going
// silently stale.
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

    const service = await connect(server);
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

Deno.test("finding 1 (wire half): a former holder's catch-up RETRACTS a keyed-delivered foreign instance BY KEY — its own instance of the same doc is never named; and once the lease is back, the next foreign write's pass re-arms and re-delivers the instance keyed (no re-issued watch)", async () => {
  // The exemption LIFECYCLE under the keyed wire (fan-out stage A's
  // independent review, finding 1 — 2026-08-17). Two halves of one
  // invariant: (i) a session's wire vocabulary is STICKY once it was
  // admitted explicit-instance reads — an instance delivered KEYED is
  // always retracted KEYED, so a former holder's catch-up names exactly the
  // foreign instances it retracts and never the session's own (an unkeyed
  // remove resolves against the client's OWN instance: the wipe); (ii) the
  // DELIVERY of foreign instances is live-lease-gated per pass, and a lapse
  // RE-ARMS on the first live pass with a full evaluation that re-delivers
  // what the lapse withheld — a renewal blip the SpaceServer survives
  // in-process must not leave its serving replica silently stale.

  const server = newServer("memory://explicit-read-keyed-retract");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const opened = await openSession(service, SERVICE);
    // The service writes ITS OWN instance of the same doc — the stage-A
    // serving-replica shape: the own instance and a demander's instance
    // of one (branch, id, scope) held side by side.
    await writeOwnProfile(server, opened.sessionId, 1, {
      name: "service-own",
    });
    const serviceKey = resolveScopeKey("user", { principal: SERVICE });

    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    // The holder watches BOTH: its own instance (a keyless root) and
    // Alice's (a keyed root).
    const watch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch-both"),
      space: SPACE,
      sessionId: opened.sessionId,
      watches: [{
        id: "w-both",
        kind: "graph",
        query: {
          roots: [
            {
              id: "of:profile",
              scope: "user",
              selector: { path: [], schema: false },
            },
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: aliceKey as never,
              selector: { path: [], schema: false },
            },
          ],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));
    assertEquals(
      watch.ok.sync.upserts.map((upsert) => upsert.scopeKey).toSorted(),
      [aliceKey, serviceKey].toSorted(),
      "both instances delivered, each keyed",
    );

    // The connection dies and the lease lapses while detached; foreign
    // state moves (so the catch-up diff has something to retract).
    service.connection.close();
    expireLease(engine, holder);
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(server, () => false);

    // Resume without a live lease: the catch-up is a full evaluation
    // that DROPS Alice's instance (protocol.md §3's filter) and retracts
    // it — the retraction MUST carry her key. Pre-fix the frame keying
    // hung from the live verdict, so the remove went out UNKEYED and the
    // client resolved it against its OWN instance (the service's doc
    // wiped, Alice's stale instance kept).
    const resumedHarness = await connect(server);
    const resumed = await openSession(resumedHarness, SERVICE, {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    });
    assertEquals(resumed.sessionId, opened.sessionId);
    const sync = resumed.sync as {
      upserts?: Array<{ id: string; scope?: string; scopeKey?: string }>;
      removes?: Array<{ id: string; scope?: string; scopeKey?: string }>;
    } | undefined;
    const removes = (sync?.removes ?? []).filter((remove) =>
      remove.id === "of:profile"
    );
    assertEquals(removes.length, 1, "exactly Alice's instance is retracted");
    assertEquals(
      removes[0].scopeKey,
      aliceKey,
      "a keyed-delivered foreign instance is retracted BY KEY (an unkeyed " +
        "remove would name the session's OWN instance in its replica)",
    );
    assertEquals(
      (sync?.upserts ?? []).filter((upsert) => upsert.id === "of:profile"),
      [],
      "the own instance is untouched by the catch-up (not re-sent, not " +
        "retracted)",
    );

    // The lease comes back to the SAME holder (the in-process reacquire).
    // Alice's watch never left the session's watch set — only its
    // delivery was withheld — so her next write's pass finds the lease
    // live and the session lapsed, RE-ARMS (a full evaluation), and
    // re-delivers her instance KEYED. Pre-fix the lapse had cleared the
    // bit for the session's life: this write was filtered again, and
    // nothing short of a fresh explicit-instance admission re-armed it.
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const from = resumedHarness.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    await drainDelivery(
      server,
      () =>
        effectUpserts(resumedHarness.messages, from).some((upsert) =>
          upsert.id === "of:profile"
        ),
    );
    const redelivered = effectUpserts(resumedHarness.messages, from).filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(redelivered.length, 1);
    assertEquals(redelivered[0].scopeKey, aliceKey);
    assertEquals(redelivered[0].doc?.value, { name: "alice-3" });

    alice.connection.close();
    resumedHarness.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("finding 1 (silent-stale half): a survived lease blip RE-ARMS the exemption on the next pass with NO re-issued watch — the SpaceServer's reacquire notice schedules that pass, and the update the lapse withheld is redelivered KEYED", async () => {
  const server = newServer("memory://explicit-read-blip-rearm");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));

    // The blip: the lease lapses; Alice's write inside it is WITHHELD
    // (the P0 rule — and never cached as delivered).
    expireLease(engine, holder);
    const lapsedFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpserts(service.messages, lapsedFrom).filter((upsert) =>
        upsert.id === "of:profile"
      ),
      [],
      "withheld while the lease is lapsed",
    );

    // The same holder reacquires (serving-loop.md §2's same-process
    // reacquire) and — as the SpaceServer's renew arm does — reports it.
    // NO watch is re-issued: the exemption re-arms by itself, and the
    // notice is what schedules the pass (nothing else dirties the
    // session's tracked set here). Pre-fix the lapse CLEARED the bit and
    // only a fresh explicit-instance admission re-armed it, so the
    // serving replica kept Alice's stale instance for as long as no
    // per-instance read happened to re-admit — silently.
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const rearmFrom = service.messages.length;
    server.noteLeaseReacquired({ space: SPACE, principal: SERVICE });
    await drainDelivery(
      server,
      () =>
        effectUpserts(service.messages, rearmFrom).some((upsert) =>
          upsert.id === "of:profile"
        ),
    );
    const rearmed = effectUpserts(service.messages, rearmFrom).filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(rearmed.length, 1, "the withheld update is redelivered");
    assertEquals(rearmed[0].scopeKey, aliceKey, "keyed");
    assertEquals(rearmed[0].doc?.value, { name: "alice-2" });

    // Steady state after the re-arm: later foreign updates flow
    // incrementally, keyed.
    const laterFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    await drainDelivery(
      server,
      () =>
        effectUpserts(service.messages, laterFrom).some((upsert) =>
          upsert.id === "of:profile"
        ),
    );
    const later = effectUpserts(service.messages, laterFrom).filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(later.length, 1);
    assertEquals(later[0].scopeKey, aliceKey);
    assertEquals(later[0].doc?.value, { name: "alice-3" });

    // And the notice is inert when nothing lapsed (the OFF-arm and
    // steady-state shape): no frame follows.
    const idleFrom = service.messages.length;
    server.noteLeaseReacquired({ space: SPACE, principal: SERVICE });
    await drainDelivery(server, () => false);
    assertEquals(effectUpserts(service.messages, idleFrom), []);

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("finding 1 (silent-stale half, no notice): with the lease live again, the FIRST pass that evaluates the lapsed session — here, an unrelated write to a doc it tracks — re-arms with a full evaluation, so the update the lapse withheld rides along keyed", async () => {
  const server = newServer("memory://explicit-read-blip-rearm-on-pass");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    // The service's own SPACE doc — the unrelated tracked doc.
    const settings = await server.transact({
      type: "transact",
      requestId: nextRequestId("settings"),
      space: SPACE,
      sessionId: serviceSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:settings",
          value: { value: { v: 1 } },
        }],
      },
    });
    assertExists(settings.ok, JSON.stringify(settings.error));
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch-alice-and-settings"),
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
              entityScopeKey: aliceKey as never,
              selector: { path: [], schema: false },
            },
            { id: "of:settings", selector: { path: [], schema: false } },
          ],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));

    // Lapse; Alice's write inside it is withheld.
    expireLease(engine, holder);
    const lapsedFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpserts(service.messages, lapsedFrom).filter((upsert) =>
        upsert.id === "of:profile"
      ),
      [],
    );

    // Reacquire, then a write to the UNRELATED tracked doc: the pass it
    // triggers finds the lease live and the session lapsed → a FULL
    // evaluation, whose diff carries Alice's withheld update alongside
    // the settings change. An incremental pass (pre-fix) would have
    // carried the settings change alone — Alice's doc was not dirty.
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const from = service.messages.length;
    const settings2 = await server.transact({
      type: "transact",
      requestId: nextRequestId("settings-2"),
      space: SPACE,
      sessionId: serviceSession,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:settings",
          value: { value: { v: 2 } },
        }],
      },
    });
    assertExists(settings2.ok, JSON.stringify(settings2.error));
    await drainDelivery(
      server,
      () =>
        effectUpserts(service.messages, from).some((upsert) =>
          upsert.id === "of:profile"
        ),
    );
    const upserts = effectUpserts(service.messages, from);
    const profile = upserts.filter((upsert) => upsert.id === "of:profile");
    assertEquals(profile.length, 1, "the withheld update rides the re-arm");
    assertEquals(profile[0].scopeKey, aliceKey);
    assertEquals(profile[0].doc?.value, { name: "alice-2" });

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("watch.add with a changed entityScopeKey on an existing watch id is a changed spec, not silently the old instance", async () => {
  const server = newServer("memory://explicit-read-changed-key");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server);
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
    const serviceConnection = server.connect((message) => {
      if (
        effectFailuresRemaining > 0 &&
        (message as { type?: string }).type === "session/effect"
      ) {
        effectFailuresRemaining -= 1;
        throw new Error("socket died (test-induced)");
      }
      serviceMessages.push(message);
    });
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
    const service = await connect(server);
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

// Phase 5 — the read row's cross-space widening and its fail-closed twin
// (protocol.md §2; verification-coverage.md's stage-F read-row entry):
//
// - FP2 (RULED 2026-08-03): the requester holds A live execution_lease on
//   the co-hosted memory server — its OWN space's lease, not necessarily
//   the read space's — so a home SpaceServer's cross-space serving reads
//   can name a FOREIGN space's instances.
// - The per-process sharpening: equality is against the FULL DR1 holder
//   minted by THIS process, so a second process sharing the service DID
//   no longer passes on this process's lease rows.
// - The delegated-scoped-read fail-closed refusal (RULED 2026-08-13, the
//   Phase-5 precondition): a co-hosted serving session's UNNAMED scoped
//   read of a space it does not hold refuses loudly instead of silently
//   resolving the delegating envelope's (empty) instance.

const HOME_SPACE = "did:key:z6Mk-explicit-read-home";

const openSessionIn = async (
  harness: Harness,
  space: string,
  principal: string,
): Promise<{ sessionId: string }> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session: {},
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

Deno.test("Phase 5: a home holder names a FOREIGN space's instance under its own space's lease (FP2's widened read row) and the instance's actor's READ grant", async () => {
  const server = newServer("memory://explicit-read-fp2");
  setServerExecutionConfig(true);
  try {
    // Alice's instance lives in SPACE, which she owns; the serving
    // session's lease lives in HOME_SPACE (the home SpaceServer serving
    // cross-space reads). The grant-scoped read admits the named instance
    // on alice's own READ grant in SPACE's list.
    await initializeSpaceAcl(server, SPACE, { [ALICE]: "OWNER" });
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

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

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const widened = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fp2"),
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
      widened.ok,
      `FP2's widened acceptance must admit a co-hosted home holder: ${
        JSON.stringify(widened.error)
      }`,
    );
    assertEquals(widened.ok.entities.length, 1);
    assertEquals(widened.ok.entities[0].document?.value, { name: "alice" });

    // A plain client with NO lease anywhere stays refused — the widening
    // admits holders, never everyone.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fp2-nonholder"),
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

Deno.test("Phase 5: a second process's lease row admits nobody here (the per-process DR1 sharpening)", async () => {
  const server = newServer("memory://explicit-read-per-process");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The lease row was minted by ANOTHER process sharing the service
    // DID (a deploy overlap): its holder carries a foreign
    // process-instance component. The Phase-1 service-identity-only
    // equality admitted this session on that row; the sharpened check
    // must refuse — this process's serving session holds nothing.
    const engine = await server.engineForSpace(SPACE);
    const foreignProcessHolder = executionLeaseHolder(
      SERVICE,
      "00000000-dead-beef-0000-000000000000",
    );
    assertEquals(
      acquireExecutionLease(engine, {
        space: SPACE,
        holder: foreignProcessHolder,
        ttlMs: 600_000,
      }),
      true,
    );

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("per-process"),
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
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "a session must not be admitted on ANOTHER process's lease row " +
        `(per-process sharpening): ${JSON.stringify(refused.ok)}`,
    );

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("Phase 5: a home holder naming a FOREIGN instance of an actor the space grants no READ is refused (the grant-scoped read), as is one in a space with no list", async () => {
  const server = newServer("memory://explicit-read-ungranted");
  setServerExecutionConfig(true);
  try {
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

Deno.test("Phase 5: a co-hosted serving session's UNNAMED scoped read of a foreign space is refused fail-closed (the grant-scoped read design's interim)", async () => {
  const server = newServer("memory://explicit-read-fail-closed");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });

    // The serving session's lease lives in HOME_SPACE; SPACE is foreign
    // to it.
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
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );

    // UNNAMED scoped root: pre-Phase-5 this resolved user:<serviceDID> —
    // a silently EMPTY instance. Now it refuses loudly.
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fail-closed"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "an unnamed scoped read by a foreign serving session must refuse " +
        `fail-closed, never silently resolve the service instance: ${
          JSON.stringify(refused.ok)
        }`,
    );
    assertEquals(
      refused.error?.message.includes("grant-scoped read design"),
      true,
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
    assertExists(bobOwn.ok, JSON.stringify(bobOwn.error));

    // A serving session's unnamed scoped read of ITS OWN space (it holds
    // the lease there) keeps today's tolerated behavior — the home
    // collapsed-view path (the OW17 residual), not the cross-space trap.
    const homeService = await connect(server);
    const { sessionId: homeSession } = await openSessionIn(
      homeService,
      HOME_SPACE,
      SERVICE,
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
    bob.connection.close();
    homeService.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});
