// M4's admission re-key, pinned MEMORY-SIDE (scopes.md §7 M4;
// protocol.md §3): an authored commit's scoped writes are marked dirty
// PER SCOPE INSTANCE — resolved from the COMMITTING session's identity,
// the same resolution admission keyed the rows with — and refresh
// delivery matches those instance keys against each session's tracked
// instances. Two halves, both load-bearing:
//
// - per-instance dirty MARKING: a watcher of the WRITTEN instance
//   (same principal, different session) receives the refresh frame —
//   a name-keyed marking (dropping the scope key) matches no tracked
//   instance and delivers nothing;
// - per-instance DELIVERY: a watcher of a DIFFERENT instance of the
//   same doc NAME receives nothing — name-granular fan-out would be
//   the cross-session spurious wake M4 removed.
//
// Why this file exists (stage-F review, F9): the name-keyed-marking
// mutation at the admission site previously survived the ENTIRE memory
// suite and was caught only cross-package by the full runner suite.
// This test localizes that failure to the memory package.

import { assert, assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import { applyWaveCommit } from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  effectIntentNonce,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  resolvePrincipalSessionKey,
  type ResponseMessage,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  setServerExecutionConfig,
  type WatchSetResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-scoped-push-audience";
const SPACE = "did:key:z6Mk-scoped-push-space";
const ALICE = "did:key:z6Mk-scoped-push-alice";
const BOB = "did:key:z6Mk-scoped-push-bob";
const DOC = "of:scoped-push";

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
): Promise<string> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space: SPACE,
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
  return response.ok.sessionId;
};

/** Doc-ids upserted by the session/effect frames at or past `from`. */
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

Deno.test("scoped push is per-instance: a user-scoped commit refreshes the SAME instance's watcher in another session, and no other instance (M4)", async () => {
  const server = new Server({
    store: new URL("memory://scoped-push"),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });
  try {
    // Three sessions: alice WATCHES her user instance on one
    // connection, alice WRITES it from a second connection (a
    // different session — so delivery cannot ride echo suppression or
    // same-session verdicts), and bob watches HIS user instance of the
    // same doc name on a third.
    const aliceWatcher = await connect(server);
    const aliceWatcherSession = await openSession(aliceWatcher, ALICE);
    const bobWatcher = await connect(server);
    const bobWatcherSession = await openSession(bobWatcher, BOB);
    const aliceWriter = await connect(server);
    const aliceWriterSession = await openSession(aliceWriter, ALICE);

    const watchFor = (sessionId: string) => ({
      type: "session.watch.set" as const,
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId,
      watches: [{
        id: "w-scoped",
        kind: "graph" as const,
        query: {
          roots: [{
            id: DOC,
            scope: "user" as const,
            selector: { path: [], schema: false as const },
          }],
        },
      }],
    });
    const aliceWatch = await server.watchSet(
      watchFor(aliceWatcherSession),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(aliceWatch.ok, JSON.stringify(aliceWatch.error));
    const bobWatch = await server.watchSet(
      watchFor(bobWatcherSession),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(bobWatch.ok, JSON.stringify(bobWatch.error));

    // Snapshot the message cursors AFTER the watches are established:
    // only frames caused by the write below count.
    const aliceFrom = aliceWatcher.messages.length;
    const bobFrom = bobWatcher.messages.length;

    // Alice's OTHER session commits the user-scoped write. Admission
    // resolves the instance from the COMMITTING session's identity
    // (user:<alice>) and must mark dirty under exactly that key.
    const write = await server.transact({
      type: "transact",
      requestId: nextRequestId("write"),
      space: SPACE,
      sessionId: aliceWriterSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: DOC,
          scope: "user",
          value: { value: { n: 7 } },
        }],
      },
    });
    assertExists(write.ok, JSON.stringify(write.error));

    // Drive delivery deterministically: each idle() drains the pending
    // refresh pass (which may requeue once internally — hence the
    // bounded loop, macrotask-yielding so a deferred requeue can arm
    // before the next drain). Iteration-bounded, never wall-clock-
    // bounded, so machine load cannot flake it.
    for (let pass = 0; pass < 50; pass++) {
      if (effectUpsertIds(aliceWatcher.messages, aliceFrom).includes(DOC)) {
        break;
      }
      await server.idle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Half 1 — per-instance MARKING: the written instance's watcher
    // (alice's other session) received the doc's refresh frame.
    assert(
      effectUpsertIds(aliceWatcher.messages, aliceFrom).includes(DOC),
      "alice's watcher session must receive the scoped-push refresh " +
        "frame for her user instance",
    );

    // Half 2 — per-instance DELIVERY: bob's watcher (his OWN user
    // instance of the same doc name) received nothing for it.
    assertEquals(
      effectUpsertIds(bobWatcher.messages, bobFrom).filter((id) => id === DOC),
      [],
      "bob's watcher must not receive another instance's refresh",
    );

    aliceWatcher.connection.close();
    bobWatcher.connection.close();
    aliceWriter.connection.close();
  } finally {
    await server.close();
  }
});

Deno.test("same-principal two-session isolation (Phase-4 review MINOR-5): a derived write into session:p:s1's effects instance delivers the frame to s1 and ZERO rows to s2", async () => {
  // The sharpest instance pair — `session:p:s1` vs `session:p:s2`
  // differ ONLY in the session segment (one principal). The write is
  // the effect channel's own shape: a DERIVED wave commit addressed by
  // annotation to s1's instance of the well-known effects doc
  // (protocol.md §5), reported through `noteExecutorCommit` exactly as
  // the serving loop reports its wave commits. Push must refresh s1's
  // watcher and deliver NOTHING of the doc to s2 — a name-granular (or
  // principal-granular) fan-out here would hand one session another
  // session's navigation intents (protocol.md §3's applicable set).
  const server = new Server({
    store: new URL("memory://scoped-push-two-sessions"),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });
  setServerExecutionConfig(true);
  try {
    const s1 = await connect(server);
    const s1Session = await openSession(s1, ALICE);
    const s2 = await connect(server);
    const s2Session = await openSession(s2, ALICE);
    assert(s1Session !== s2Session, "two distinct sessions");

    const watchFor = (sessionId: string) => ({
      type: "session.watch.set" as const,
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId,
      watches: [{
        id: "w-effects",
        kind: "graph" as const,
        query: {
          roots: [{
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session" as const,
            selector: { path: [], schema: false as const },
          }],
        },
      }],
    });
    const s1Watch = await server.watchSet(
      watchFor(s1Session),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(s1Watch.ok, JSON.stringify(s1Watch.error));
    const s2Watch = await server.watchSet(
      watchFor(s2Session),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(s2Watch.ok, JSON.stringify(s2Watch.error));

    const s1From = s1.messages.length;
    const s2From = s2.messages.length;

    // The derived intent write into s1's instance, engine-plane (the
    // serving loop's path), then the push notify.
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(`service:${SPACE}`);
    assert(acquireExecutionLease(engine, { space: SPACE, holder }));
    const s1Key = resolvePrincipalSessionKey(ALICE, s1Session);
    const applied = applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commitClass: "derived",
      holder,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
          scope: "session",
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [{
              nonce: effectIntentNonce("evt-s1", "of:nav-s1"),
              kind: "navigate",
              args: { target: { id: "of:nav-s1", path: [] } },
              issuedIn: null,
            }] as never[],
          }],
        }],
      },
      annotations: [{ op: 0, scopeKey: s1Key }],
      waveBasis: { basisSeq: 0, rebasedHeads: [] },
    });
    assert(applied.seq !== undefined);
    server.noteExecutorCommit({
      space: SPACE,
      seq: applied.seq,
      class: "derived",
      holder,
      sessionId: holder,
      writes: [{
        id: SERVER_EXECUTION_EFFECTS_DOC_ID,
        scopeKey: s1Key as never,
      }],
    });

    // Drain the refresh; s1's frame must arrive.
    const deadline = Date.now() + 5_000;
    while (
      !effectUpsertIds(s1.messages, s1From)
        .includes(SERVER_EXECUTION_EFFECTS_DOC_ID) &&
      Date.now() < deadline
    ) {
      await server.idle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Push half 1: s1 (the written instance's session) received the
    // effects-doc refresh frame.
    assert(
      effectUpsertIds(s1.messages, s1From)
        .includes(SERVER_EXECUTION_EFFECTS_DOC_ID),
      "s1 must receive its own instance's refresh frame",
    );
    // Push half 2: s2 — same principal, different session — received
    // ZERO rows of the doc.
    await server.idle();
    assertEquals(
      effectUpsertIds(s2.messages, s2From)
        .filter((id) => id === SERVER_EXECUTION_EFFECTS_DOC_ID),
      [],
      "s2 must receive zero rows of s1's instance",
    );

    s1.connection.close();
    s2.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});
