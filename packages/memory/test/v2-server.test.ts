import { assertEquals, assertExists } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { debugStr, taggedHashStringOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/api";
import { parseClientMessage, Server, SessionRegistry } from "../v2/server.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MAX_ENTITY_ID_PAGE_SIZE,
  MEMORY_PROTOCOL,
  resetOwnWriteEchoConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  setOwnWriteEchoConfig,
} from "../v2.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const HELLO_FLAGS = getMemoryProtocolFlags();
const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: HELLO_FLAGS,
} as const;
const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-server-test-audience";

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const assertHelloOk = (message: ServerMessage): HelloOkMessage => {
  assertEquals(message.type, "hello.ok");
  const hello = message as HelloOkMessage;
  assertExists(hello.sessionOpen);
  return hello;
};

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata =>
  assertHelloOk(shiftMessage(messages)).sessionOpen!;

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
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

const assertEffect = (
  message: ServerMessage,
): SessionEffectMessage & { effect: SessionSync } => {
  assertEquals(message.type, "session/effect");
  return message as SessionEffectMessage & { effect: SessionSync };
};

const createServer = (
  store: string,
  refreshDelayMs = 0,
) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: refreshDelayMs,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string"
        ? principal
        : "did:key:z6Mk-memory-v2-server-principal";
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
  });

type TestConnection = ReturnType<Server["connect"]>;

const openTestSession = async (
  connection: TestConnection,
  messages: ServerMessage[],
  space: string,
  label: string,
): Promise<string> => {
  await connection.receive(encodeMemoryBoundary(HELLO));
  const sessionOpen = expectHelloOk(messages);
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `${label}-open`,
    space,
    session: {},
    invocation: authInvocation(sessionOpen),
  }));
  return assertResponse<{ sessionId: string }>(shiftMessage(messages)).ok!
    .sessionId;
};

const assertCommitBurstBeforeFanout = async (
  name: string,
  writerCount: 1 | 2,
): Promise<void> => {
  const time = new FakeTime();
  const server = createServer(`memory://${name}`, 1);
  const space = `did:key:z6Mk-${name}`;
  const observerMessages: ServerMessage[] = [];
  const observer = server.connect((message) => observerMessages.push(message));
  const writerMessages = Array.from(
    { length: writerCount },
    () => [] as ServerMessage[],
  );
  const writers = writerMessages.map((messages) =>
    server.connect((message) => messages.push(message))
  );
  const ids = ["of:doc:1", "of:doc:2"];

  try {
    const observerSessionId = await openTestSession(
      observer,
      observerMessages,
      space,
      "observer",
    );
    const writerSessionIds = await Promise.all(
      writers.map((writer, index) =>
        openTestSession(
          writer,
          writerMessages[index],
          space,
          `writer-${index + 1}`,
        )
      ),
    );

    await observer.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "observer-watch",
      space,
      sessionId: observerSessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: ids.map((id) => ({
            id,
            selector: { path: [], schema: false },
          })),
        },
      }],
    }));
    assertResponse<unknown>(shiftMessage(observerMessages));

    const transact = (index: number) => {
      const writerIndex = writerCount === 1 ? 0 : index;
      return writers[writerIndex].receive(encodeMemoryBoundary({
        type: "transact",
        requestId: `tx-${index + 1}`,
        space,
        sessionId: writerSessionIds[writerIndex],
        commit: {
          localSeq: writerCount === 1 ? index + 1 : 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: ids[index],
            value: { value: { version: index + 1 } },
          }],
        },
      }));
    };

    await Promise.all([transact(0), transact(1)]);

    const responseIds = writerMessages.flatMap((messages) =>
      messages
        .filter((message) => message.type === "response")
        .map((message) => (message as ResponseMessage<unknown>).requestId)
    ).sort();
    assertEquals(responseIds, ["tx-1", "tx-2"]);
    assertEquals(
      observerMessages,
      [],
      "both commits must receive verdicts before the next subscription fan-out",
    );

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(observerMessages));
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(
      effect.effect.upserts.map((entry) => entry.id).sort(),
      ids,
    );
    assertEquals(observerMessages, []);
  } finally {
    await server.close();
    time.restore();
  }
};

Deno.test("memory v2 server keeps publication locks independent per space", async () => {
  const server = createServer("memory://memory-v2-publication-lock-spaces");
  const internals = server.accessForTestingOnly;
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let sameSpaceEntered = false;
  let otherSpaceEntered = false;

  const first = internals.withSpacePublicationLock("space-a", async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  const sameSpace = internals.withSpacePublicationLock("space-a", () => {
    sameSpaceEntered = true;
    return Promise.resolve();
  });
  const otherSpace = internals.withSpacePublicationLock("space-b", () => {
    otherSpaceEntered = true;
    return Promise.resolve();
  });

  try {
    await otherSpace;
    assertEquals(otherSpaceEntered, true);
    assertEquals(sameSpaceEntered, false);
  } finally {
    releaseFirst.resolve();
    await Promise.all([first, sameSpace]);
    await server.close();
  }
  assertEquals(sameSpaceEntered, true);
});

Deno.test("memory v2 server stateless respond does not issue hello.ok", async () => {
  const server = createServer("memory://memory-v2-server-stateless-respond");
  try {
    const payload = await server.respond(encodeMemoryBoundary(HELLO));
    assertExists(payload);
    const response = assertResponse<unknown>(
      decodeMemoryBoundary(payload) as ServerMessage,
    );
    assertEquals(response.requestId, "handshake");
    assertEquals(response.error?.name, "ProtocolError");
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server parser ignores transact invocation and authorization payloads", () => {
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { ok: true } },
        }],
      },
      invocation: { iss: "did:key:alice" },
      authorization: { signature: "sig:alice" },
    })),
    {
      type: "transact",
      requestId: "tx-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { ok: true } },
        }],
      },
    },
  );
});

Deno.test("memory v2 server parses entity identifier listing requests", () => {
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "entity-id.list",
      requestId: "entity-list-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
    })),
    {
      type: "entity-id.list",
      requestId: "entity-list-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
    },
  );
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "entity-id.list",
      requestId: "entity-list-page",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      after: "of:fid1:first",
      limit: 100,
      expectedServerSeq: 42,
    })),
    {
      type: "entity-id.list",
      requestId: "entity-list-page",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      after: "of:fid1:first",
      limit: 100,
      expectedServerSeq: 42,
    },
  );
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "entity-id.list",
      requestId: "entity-list-2",
      space: "did:key:z6Mk-space",
    })),
    null,
  );
  assertEquals(
    parseClientMessage(encodeMemoryBoundary({
      type: "entity-id.exists",
      requestId: "entity-exists-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      id: "of:fid1:first",
    })),
    {
      type: "entity-id.exists",
      requestId: "entity-exists-1",
      space: "did:key:z6Mk-space",
      sessionId: "session:1",
      id: "of:fid1:first",
    },
  );
});

Deno.test("memory v2 server rejects unknown entity identifier sessions before dispatch", async () => {
  const server = createServer("memory://memory-v2-entity-id-dispatch-session");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(messages);

    for (
      const request of [{
        type: "entity-id.list",
        requestId: "entity-list-unknown-session",
        space: "did:key:z6Mk-entity-list-unknown-session",
        sessionId: "session:missing",
      }, {
        type: "entity-id.exists",
        requestId: "entity-exists-unknown-session",
        space: "did:key:z6Mk-entity-list-unknown-session",
        sessionId: "session:missing",
        id: "of:fid1:first",
      }]
    ) {
      await connection.receive(encodeMemoryBoundary(request));
      const response = nextResponse<unknown>(messages);
      assertEquals(response.requestId, request.requestId);
      assertEquals(response.error?.name, "SessionError");
    }
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 entity identifier methods report session and query errors", async () => {
  const sessions = new SessionRegistry();
  const server = new Server({
    sessions,
    store: new URL("memory://memory-v2-entity-id-method-errors"),
    authorizeSessionOpen: () =>
      "did:key:z6Mk-memory-v2-entity-id-method-errors",
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });
  const validSpace = "did:key:z6Mk-entity-id-method-errors";
  const invalidSpace = "invalid/space";

  try {
    const unknownList = await server.listEntityIds({
      type: "entity-id.list",
      requestId: "entity-list-method-unknown-session",
      space: validSpace,
      sessionId: "session:missing",
    });
    assertEquals(unknownList.error?.name, "SessionError");

    const unknownLookup = await server.entityIdExists({
      type: "entity-id.exists",
      requestId: "entity-exists-method-unknown-session",
      space: validSpace,
      sessionId: "session:missing",
      id: "of:fid1:first",
    });
    assertEquals(unknownLookup.error?.name, "SessionError");

    sessions.open(
      invalidSpace,
      { sessionId: "session:invalid-space" },
      0,
      "entity-id-method-errors",
      "did:key:z6Mk-memory-v2-entity-id-method-errors",
    );
    const failedList = await server.listEntityIds({
      type: "entity-id.list",
      requestId: "entity-list-method-query-error",
      space: invalidSpace,
      sessionId: "session:invalid-space",
    });
    assertEquals(failedList.error?.name, "QueryError");

    const failedLookup = await server.entityIdExists({
      type: "entity-id.exists",
      requestId: "entity-exists-method-query-error",
      space: invalidSpace,
      sessionId: "session:invalid-space",
      id: "of:fid1:first",
    });
    assertEquals(failedLookup.error?.name, "QueryError");
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects oversized unpaginated identifier responses", async () => {
  const sessions = new SessionRegistry();
  const server = new Server({
    sessions,
    store: new URL("memory://memory-v2-bounded-legacy-entity-list"),
    authorizeSessionOpen: () => "did:key:z6Mk-bounded-legacy-entity-list",
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });
  const space = "did:key:z6Mk-bounded-legacy-entity-list";
  const sessionId = "session:bounded-legacy-entity-list";
  sessions.open(
    space,
    { sessionId },
    0,
    "bounded-legacy-entity-list",
    "did:key:z6Mk-bounded-legacy-entity-list",
  );

  try {
    const committed = await server.transact({
      type: "transact",
      requestId: "bounded-legacy-entity-list-commit",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: Array.from(
          { length: MAX_ENTITY_ID_PAGE_SIZE + 1 },
          (_, index) => ({
            op: "set" as const,
            id: `of:fid1:bounded-${index.toString().padStart(4, "0")}`,
            value: { value: { index } },
          }),
        ),
      },
    });
    assertExists(committed.ok);

    const unpaginated = await server.listEntityIds({
      type: "entity-id.list",
      requestId: "bounded-legacy-entity-list-unpaginated",
      space,
      sessionId,
    });
    assertEquals(unpaginated.error?.name, "ProtocolError");
    assertEquals(
      unpaginated.error?.message,
      `unpaginated entity identifier listing exceeds ${MAX_ENTITY_ID_PAGE_SIZE} entries; use pagination`,
    );

    const page = await server.listEntityIds({
      type: "entity-id.list",
      requestId: "bounded-legacy-entity-list-page",
      space,
      sessionId,
      limit: MAX_ENTITY_ID_PAGE_SIZE,
    });
    assertEquals(page.ok?.ids.length, MAX_ENTITY_ID_PAGE_SIZE);
    assertExists(page.ok?.nextAfter);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 session registry scopes session ids by space", () => {
  const sessions = new SessionRegistry();
  const first = sessions.open(
    "did:key:z6Mk-space-one",
    { sessionId: "session:fixed" },
    0,
  );
  const second = sessions.open(
    "did:key:z6Mk-space-two",
    { sessionId: "session:fixed" },
    0,
  );

  assertEquals(first.sessionId, "session:fixed");
  assertEquals(first.serverSeq, 0);
  assertExists(first.sessionToken);
  assertEquals(second.sessionId, "session:fixed");
  assertEquals(second.serverSeq, 0);
  assertExists(second.sessionToken);
});

Deno.test("memory v2 server consumes a challenged session open", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-audience";
  let now = 1_000_000;
  const server = new Server({
    store: new URL("memory://memory-v2-server-challenge-reuse"),
    authorizeSessionOpen: () => "did:key:z6Mk-memory-v2-server-principal",
    sessionOpenAuth: {
      audience,
      challengeTtlSeconds: 60,
      nowSeconds: () => now,
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const hello = shiftMessage(messages) as HelloOkMessage;
    assertEquals(hello.type, "hello.ok");
    assertEquals(hello.sessionOpen?.audience, audience);
    const challenge = hello.sessionOpen?.challenge;
    assertExists(challenge);
    assertEquals(challenge.expiresAt, now + 60);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-challenge-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    const opened = nextResponse<{
      sessionId: string;
      sessionOpen?: { challenge?: { value: string; expiresAt: number } };
    }>(messages);
    assertEquals(opened.requestId, "open-1");
    assertExists(opened.ok?.sessionId);
    const nextChallenge = opened.ok?.sessionOpen?.challenge;
    assertExists(nextChallenge);
    assertEquals(nextChallenge.expiresAt, now + 60);

    now += 1;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-memory-v2-server-challenge-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge mismatch",
        retriable: true,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects an expired session open challenge", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-expired-audience";
  let now = 1_000_000;
  const server = new Server({
    store: new URL("memory://memory-v2-server-challenge-expired"),
    authorizeSessionOpen: () => "did:key:z6Mk-memory-v2-server-principal",
    sessionOpenAuth: {
      audience,
      challengeTtlSeconds: 60,
      nowSeconds: () => now,
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const hello = shiftMessage(messages) as HelloOkMessage;
    assertEquals(hello.type, "hello.ok");
    const challenge = hello.sessionOpen?.challenge;
    assertExists(challenge);

    now = challenge.expiresAt;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-expired-space",
      session: {},
      invocation: {
        aud: audience,
        challenge: challenge.value,
      },
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge expired",
        retriable: true,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects invalid session open auth metadata", async () => {
  const server = createServer(
    "memory://memory-v2-server-invalid-session-open-auth",
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    const cases = [
      {
        requestId: "missing-audience",
        invocation: {
          challenge: sessionOpen.challenge.value,
        },
        message: "memory session.open requires audience",
      },
      {
        requestId: "wrong-audience",
        invocation: {
          aud: "did:key:z6Mk-memory-v2-server-wrong-audience",
          challenge: sessionOpen.challenge.value,
        },
        message: "memory session.open audience mismatch",
      },
      {
        requestId: "missing-challenge",
        invocation: {
          aud: sessionOpen.audience,
        },
        message: "memory session.open requires challenge",
      },
      {
        requestId: "wrong-challenge",
        invocation: {
          aud: sessionOpen.audience,
          challenge: "challenge:wrong",
        },
        message: "memory session.open challenge mismatch",
        // A stale challenge is an anti-replay race a fresh handshake heals.
        retriable: true,
      },
    ];

    for (const testCase of cases) {
      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: testCase.requestId,
        space: "did:key:z6Mk-memory-v2-server-invalid-auth-space",
        session: {},
        invocation: testCase.invocation,
      }));
      assertEquals(shiftMessage(messages), {
        type: "response",
        requestId: testCase.requestId,
        error: {
          name: "AuthorizationError",
          message: testCase.message,
          ...((testCase as { retriable?: boolean }).retriable
            ? { retriable: true }
            : {}),
        },
      });
    }
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects session open before issuing challenge", async () => {
  const server = createServer(
    "memory://memory-v2-server-session-open-before-challenge",
  );
  const connection = server.connect(() => {});

  try {
    const response = await server.openSession({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-memory-v2-server-before-challenge-space",
      session: {},
      invocation: {
        aud: TEST_AUDIENCE,
        challenge: "challenge:missing",
      },
    }, connection);
    assertEquals(response, {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge unavailable",
        retriable: true,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server consumes challenge before denied session open", async () => {
  const audience = "did:key:z6Mk-memory-v2-server-denied-audience";
  const space = "did:key:z6Mk-memory-v2-server-denied-space";
  const server = new Server({
    store: new URL("memory://memory-v2-server-denied-consumes-challenge"),
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: {
      audience,
    },
    acl: {
      mode: "enforce",
    },
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-1",
      error: {
        name: "AuthorizationError",
        message: `Principal <anonymous> lacks READ on space ${space}`,
        permanentEvidence: true,
        aclRevision: 0,
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "memory session.open challenge already used",
        retriable: true,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server allows the same session id in different spaces", async () => {
  const server = createServer("memory://memory-v2-server-session-scope");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    let sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(sessionOpen),
    }));
    const openedOne = nextResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      sessionOpen: SessionOpenAuthMetadata;
    }>(messages);
    assertEquals(openedOne.requestId, "open-1");
    assertEquals(openedOne.ok?.sessionId, "session:fixed");
    assertEquals(openedOne.ok?.serverSeq, 0);
    assertExists(openedOne.ok?.sessionToken);
    assertExists(openedOne.ok?.sessionOpen);
    sessionOpen = openedOne.ok.sessionOpen;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-two",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(sessionOpen),
    }));
    const openedTwo = nextResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(messages);
    assertEquals(openedTwo.requestId, "open-2");
    assertEquals(openedTwo.ok?.sessionId, "session:fixed");
    assertEquals(openedTwo.ok?.serverSeq, 0);
    assertExists(openedTwo.ok?.sessionToken);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 dirty refresh stays on the connection's mounted space", async () => {
  const server = createServer("memory://memory-v2-server-refresh-space-scope");
  const first = server.connect(() => {});
  const second = server.connect(() => {});
  const firstSpace = "did:key:z6Mk-refresh-space-one";
  const secondSpace = "did:key:z6Mk-refresh-space-two";
  const sessionId = "session:shared-across-spaces";

  try {
    first.addSession(firstSpace, sessionId);
    second.addSession(secondSpace, sessionId);

    const syncCalls: Array<{ space: string; sessionId: string }> = [];
    server.syncSessionForConnection = (space, mountedSessionId) => {
      syncCalls.push({ space, sessionId: mountedSessionId });
      return Promise.resolve(null);
    };

    // The server fans a dirty-space refresh to every connection. A connection
    // mounted only in another space must not consume this session's cursor,
    // even when both mounts intentionally share one execution-context id.
    await Promise.all([
      first.refreshDirty(secondSpace),
      second.refreshDirty(secondSpace),
    ]);

    assertEquals(syncCalls, [{ space: secondSpace, sessionId }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server direct writes schedule dirty refreshes without connections", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-direct-write-no-connections",
    1,
  );
  const space = "did:key:z6Mk-memory-v2-server-direct-write-no-connections";
  const contents = { type: "text/plain", body: "hello" };
  const id = `cid:${taggedHashStringOf(contents)}`;
  const originalFlush = server.flushSessions.bind(server);
  let flushCalls = 0;

  (server as unknown as {
    flushSessions(
      ...args: Parameters<Server["flushSessions"]>
    ): ReturnType<Server["flushSessions"]>;
  }).flushSessions = async (...args) => {
    flushCalls += 1;
    return await originalFlush(...args);
  };

  try {
    await server.writeDocument(space, id, {
      type: "text/plain",
      body: "hello",
    });
    assertEquals(flushCalls, 0);

    await time.tickAsync(1);
    await time.tickAsync(0);

    assertEquals(flushCalls, 1);
    assertEquals(await server.readDocument(space, id), {
      value: {
        type: "text/plain",
        body: "hello",
      },
    });
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server direct document helpers round-trip values", async () => {
  const server = createServer("memory://memory-v2-server-direct-documents");
  const space = "did:key:z6Mk-memory-v2-server-direct-documents";
  const contents = {
    type: "image/png",
    body: new FabricBytes(new Uint8Array([1, 2, 3, 4])),
  };
  const id = `cid:${taggedHashStringOf(contents)}`;

  try {
    await server.writeDocument(space, id, contents);

    assertEquals(await server.readDocument(space, id), {
      value: contents,
    });
    assertEquals(
      await server.readDocument(space, "cid:fid1:missing-document"),
      null,
    );
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server binds resumed sessions to the original principal", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-server-session-principal"),
    authorizeSessionOpen(message) {
      return typeof (message.authorization as { principal?: unknown })
          ?.principal ===
          "string"
        ? (message.authorization as { principal: string }).principal
        : undefined;
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
  });
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );

  try {
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(firstMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
      authorization: { principal: "did:key:z6Mk-alice" },
    }));
    const opened = nextResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
    }>(firstMessages);
    assertEquals(opened.requestId, "open-1");
    assertEquals(opened.ok?.sessionId, "session:fixed");
    assertEquals(opened.ok?.serverSeq, 0);
    assertExists(opened.ok?.sessionToken);

    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    const secondSessionOpen = expectHelloOk(secondMessages);

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space: "did:key:z6Mk-space-one",
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(secondSessionOpen),
      authorization: { principal: "did:key:z6Mk-bob" },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "open-2",
      error: {
        name: "AuthorizationError",
        message: "session session:fixed is already bound to did:key:z6Mk-alice",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server requires sessions to be opened on the current connection", async () => {
  const server = createServer("memory://memory-v2-server-connection-sessions");
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );
  const space = "did:key:z6Mk-space-current-connection";

  try {
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    const firstSessionOpen = expectHelloOk(firstMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(firstMessages);
    const sessionId = opened.ok!.sessionId;

    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    expectHelloOk(secondMessages);

    await secondConnection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId,
      query: { roots: [] },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:foreign",
          value: { value: { hello: "world" } },
        }],
      },
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "tx-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-set-1",
      space,
      sessionId,
      watches: [],
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "watch-set-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-add-1",
      space,
      sessionId,
      watches: [],
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "watch-add-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.ack",
      requestId: "ack-1",
      space,
      sessionId,
      seenSeq: 0,
    }));
    assertEquals(shiftMessage(secondMessages), {
      type: "response",
      requestId: "ack-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server transfers session ownership and rejects stale resume tokens", async () => {
  const server = createServer("memory://memory-v2-server-session-takeover");
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const space = "did:key:z6Mk-space-session-takeover";
  const firstConnection = server.connect((message) =>
    firstMessages.push(message)
  );
  const secondConnection = server.connect((message) =>
    secondMessages.push(message)
  );

  try {
    await firstConnection.receive(encodeMemoryBoundary(HELLO));
    await secondConnection.receive(encodeMemoryBoundary(HELLO));
    let firstSessionOpen = expectHelloOk(firstMessages);
    const secondSessionOpen = expectHelloOk(secondMessages);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: { sessionId: "session:fixed" },
      invocation: authInvocation(firstSessionOpen),
    }));
    const openedFirst = nextResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      sessionOpen: SessionOpenAuthMetadata;
    }>(firstMessages);
    const initialToken = openedFirst.ok?.sessionToken;
    assertEquals(openedFirst.ok?.sessionId, "session:fixed");
    assertEquals(openedFirst.ok?.serverSeq, 0);
    assertExists(initialToken);
    assertExists(openedFirst.ok?.sessionOpen);
    firstSessionOpen = openedFirst.ok.sessionOpen;

    await secondConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-2",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
      invocation: authInvocation(secondSessionOpen),
    }));

    assertEquals(shiftMessage(firstMessages), {
      type: "session/revoked",
      space,
      sessionId: "session:fixed",
      reason: "taken-over",
    });

    const openedSecond = nextResponse<{
      sessionId: string;
      sessionToken: string;
      serverSeq: number;
      resumed?: boolean;
    }>(secondMessages);
    assertEquals(openedSecond.ok?.sessionId, "session:fixed");
    assertEquals(openedSecond.ok?.serverSeq, 0);
    assertEquals(openedSecond.ok?.resumed, true);
    assertExists(openedSecond.ok?.sessionToken);
    assertEquals(openedSecond.ok?.sessionToken === initialToken, false);

    await firstConnection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId: "session:fixed",
      query: { roots: [] },
    }));
    assertEquals(shiftMessage(firstMessages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "SessionError",
        message: "Session is not open on this connection",
      },
    });

    await firstConnection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-3",
      space,
      session: {
        sessionId: "session:fixed",
        sessionToken: initialToken,
      },
      invocation: authInvocation(firstSessionOpen),
    }));
    assertEquals(shiftMessage(firstMessages), {
      type: "response",
      requestId: "open-3",
      error: {
        name: "SessionRevokedError",
        message: "session session:fixed resume token is no longer valid",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects handshakes when modernCellRep flags disagree", async () => {
  const server = createServer("memory://memory-v2-server-handshake-flags");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: {
        modernCellRep: !HELLO_FLAGS.modernCellRep,
      },
    }));

    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "handshake",
      error: {
        name: "ProtocolError",
        message: debugStr`memory flag mismatch: client=$quote,long${{
          modernCellRep: !HELLO_FLAGS.modernCellRep,
        }} server=$quote,long${HELLO_FLAGS}`,
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server accepts optional-capability flag mismatch", async () => {
  const server = createServer(
    "memory://memory-v2-server-handshake-optional-flag",
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: {
        ...HELLO_FLAGS,
        commitPreconditions: !HELLO_FLAGS.commitPreconditions,
      },
    }));

    expectHelloOk(messages);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects unsafe spaces before opening a store", async () => {
  const server = createServer("memory://memory-v2-server-unsafe-space");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-unsafe",
      space: "../../evil",
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "open-unsafe",
      error: {
        name: "ProtocolError",
        message: "Invalid memory space identifier for store path: ../../evil",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server opens sessions, commits documents, and answers graph queries", async () => {
  const server = createServer("memory://memory-v2-server-basic");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string; serverSeq: number }>(
      messages,
    );
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: {
            value: {
              hello: "world",
            },
          },
        }],
      },
    }));

    const committed = nextResponse<any>(messages);
    assertEquals(committed.requestId, "tx-1");
    assertEquals(committed.ok?.seq, 1);
    assertEquals(committed.ok?.revisions, [{
      id: "of:doc:1",
      scopeKey: "space",
      branch: "",
      seq: 1,
      opIndex: 0,
      commitSeq: 1,
      op: "set",
      document: {
        value: {
          hello: "world",
        },
      },
    }]);

    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId,
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }));

    const query = nextResponse<GraphQueryResult>(messages);
    assertEquals(query.requestId, "query-1");
    assertEquals(query.ok, {
      serverSeq: 1,
      entities: [{
        branch: "",
        id: "of:doc:1",
        seq: 1,
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rejects legacy live graph.query subscriptions", async () => {
  const server = createServer("memory://memory-v2-server-subscribe-reject");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-subscribe-reject";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "graph.query",
      requestId: "query-1",
      space,
      sessionId: opened.ok!.sessionId,
      query: {
        subscribe: true,
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }));

    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "query-1",
      error: {
        name: "ProtocolError",
        message:
          "live graph.query subscriptions were removed; use session.watch.set",
      },
    });
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch sets expand to previously hidden nodes after retargets", async () => {
  const server = createServer("memory://memory-v2-server-watch-expansion");
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-expansion";
  const fixture = createGraphFixture(space);

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: fixture.docs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: fixture.rootId,
            selector: {
              path: [],
              schema: fixture.schema,
            },
          }],
        },
      }],
    }));
    const watch = nextResponse<any>(messages);
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      fixture.initialReachableIds,
    );
    assertEquals(watch.ok?.sync.removes, []);

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "expand",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: fixture.expandedRootValue },
        }],
      },
    }));
    // Verdict-first (CT-1927): the response is inline; the watch-expansion
    // effect rides the batched fan-out behind it.
    assertEquals(
      assertResponse<any>(shiftMessage(messages)).requestId,
      "expand",
    );
    await tick();
    const effect = assertEffect(shiftMessage(messages));
    // The root appears too: the seed (writer session) and the expansion
    // (this session) both wrote it inside one batch window, so mixed
    // provenance clears the echo-suppression origin and the doc fans out
    // authoritatively — delivering current durable state is always sound.
    const expectedUpdatedIds = [
      fixture.rootId,
      ...fixture.expandedReachableIds.filter((id) =>
        !fixture.initialReachableIds.includes(id)
      ),
    ].sort();
    assertEquals(
      effect.effect.upserts.map((entry) => entry.id),
      expectedUpdatedIds,
    );
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server does not emit delayed exact-reconcile removes after shrink retargets", async () => {
  const time = new FakeTime();
  const server = createServer(
    "memory://memory-v2-server-watch-shrink-no-reconcile",
    0,
  );
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-shrink-no-reconcile";
  const fixture = createGraphFixture(space);
  const expandedDocs = fixture.docs.map((doc) => ({
    ...doc,
    value: doc.id === fixture.rootId ? fixture.expandedRootValue : doc.value,
  }));
  const initialRoot = fixture.docs.find((doc) => doc.id === fixture.rootId)
    ?.value;
  assertExists(initialRoot);

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: expandedDocs.map((doc) => ({
          op: "set" as const,
          id: doc.id,
          value: { value: doc.value },
        })),
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: fixture.rootId,
            selector: {
              path: [],
              schema: fixture.schema,
            },
          }],
        },
      }],
    }));
    const watch = nextResponse<any>(messages);
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      fixture.expandedReachableIds,
    );
    assertEquals(watch.ok?.sync.removes, []);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "shrink",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: fixture.rootId,
          value: { value: initialRoot },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "shrink",
    );

    await time.tickAsync(0);
    await time.runMicrotasks();
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.removes, []);

    await time.tickAsync(300);
    await time.runMicrotasks();
    assertEquals(messages, []);
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server does not send watch effects after a connection closes mid-refresh", async () => {
  const server = createServer("memory://memory-v2-server-close-during-refresh");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-close-during-refresh";
  let releaseRefresh!: () => void;
  const waitForRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let sessionId = "";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    sessionId = nextResponse<{ sessionId: string }>(messages).ok!.sessionId;

    server.syncSessionForConnection = async (...args) => {
      await waitForRefresh;
      return {
        type: "session/effect",
        space: args[0],
        sessionId,
        effect: {
          type: "sync",
          serverSeq: 0,
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
        },
      };
    };

    const refreshPromise = connection.refreshDirty(space);
    await tick();
    connection.close();
    releaseRefresh();
    await refreshPromise;

    assertEquals(messages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server refreshes watched docs by syncing only the touched entity", async () => {
  const server = createServer("memory://memory-v2-server-incremental-watch");
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-incremental-watch";

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "seed",
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }, {
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(
      nextResponse<any>(messages).requestId,
      "watch-1",
    );

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "update",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 2 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "update",
    );

    await tick();
    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.upserts.map((entry) => entry.id), ["of:doc:1"]);
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch.add bootstraps only the newly added watch", async () => {
  const server = createServer("memory://memory-v2-server-watch-add");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "seed");

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const first = nextResponse<any>(messages);
    assertEquals(
      first.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:1",
      ],
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const second = nextResponse<any>(messages);
    assertEquals(
      second.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:2",
      ],
    );
    assertEquals(second.ok?.sync.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server can bootstrap watches with session.watch.add", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-bootstrap");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-bootstrap";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { hello: "watch-add" } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "seed");

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const watch = nextResponse<any>(messages);
    assertEquals(
      watch.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      ["of:doc:1"],
    );
    assertEquals(watch.ok?.sync.removes, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server treats duplicate watch ids in session.watch.add as no-op or protocol errors", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-replace");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-replace";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "seed");

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(
      nextResponse<any>(messages).ok?.sync.upserts.map((
        entry: { id: string },
      ) => entry.id),
      ["of:doc:1"],
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }, {
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "watch-2",
      error: {
        name: "ProtocolError",
        message:
          "session.watch.add may not replace an existing watch id; use session.watch.set",
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-3",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const unchanged = nextResponse<any>(messages);
    assertEquals(unchanged.ok?.sync.upserts, []);
    assertEquals(unchanged.ok?.sync.removes, []);

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-3b",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              schema: false,
              path: [],
            },
          }],
        },
      }],
    }));
    const reorderedEquivalent = nextResponse<any>(messages);
    assertEquals(reorderedEquivalent.ok?.sync.upserts, []);
    assertEquals(reorderedEquivalent.ok?.sync.removes, []);

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-4",
      space,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(shiftMessage(messages), {
      type: "response",
      requestId: "watch-4",
      error: {
        name: "ProtocolError",
        message:
          "session.watch.add may not replace an existing watch id; use session.watch.set",
      },
    });

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "update-doc-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 3 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(messages).requestId,
      "update-doc-2",
    );

    await tick();
    // The accept's catch-up marker rides an otherwise-empty frame
    // (CT-1927); no watched novelty is echoed.
    const marker = assertEffect(shiftMessage(messages));
    assertEquals(marker.effect.upserts, []);
    assertEquals(marker.effect.caughtUpLocalSeq, 2);
    assertEquals(messages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server rolls back failed watch.add mutations", async () => {
  const server = createServer("memory://memory-v2-server-watch-add-rollback");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-add-rollback";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { one: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 2 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "seed");

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(
      nextResponse<any>(messages).ok?.sync.upserts.map((
        entry: { id: string },
      ) => entry.id),
      ["of:doc:1"],
    );

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "extra",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }, {
        id: "broken",
        kind: "graph",
        query: {
          branch: "branch:broken",
          roots: [{
            id: "of:doc:3",
          } as any],
        },
      }],
    } as any));
    // The broken watch answers with a QueryError — evaluation state is
    // staged, so the session continues on this connection and the failed
    // add's "extra" watch left nothing behind.
    const failed = nextResponse<any>(messages);
    assertEquals(failed.requestId, "watch-2");
    assertEquals(failed.error?.name, "QueryError");

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "update-doc-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { two: 3 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(messages).requestId,
      "update-doc-2",
    );

    await tick();
    // The accept's catch-up marker rides an otherwise-empty frame
    // (CT-1927); no watched novelty is echoed — a leaked "extra" watch
    // would have put doc:2's update on this frame.
    const marker2 = assertEffect(shiftMessage(messages));
    assertEquals(marker2.effect.upserts, []);
    assertEquals(marker2.effect.caughtUpLocalSeq, 2);
    assertEquals(messages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server watch set replacement emits removes for entities that leave scope", async () => {
  const server = createServer("memory://memory-v2-server-watch-replace");
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-watch-replace";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { first: true } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { second: true } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "seed");

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "first",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const first = nextResponse<any>(messages);
    assertEquals(
      first.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:1",
      ],
    );
    assertEquals(first.ok?.sync.removes, []);

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-2",
      space,
      sessionId,
      watches: [{
        id: "second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:2",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    const second = nextResponse<any>(messages);
    assertEquals(
      second.ok?.sync.upserts.map((entry: { id: string }) => entry.id),
      [
        "of:doc:2",
      ],
    );
    assertEquals(second.ok?.sync.removes, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
    }]);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server accepts same-client commit bursts before fan-out", async () => {
  await assertCommitBurstBeforeFanout(
    "memory-v2-same-client-commit-burst",
    1,
  );
});

Deno.test("memory v2 server accepts cross-client commit bursts before fan-out", async () => {
  await assertCommitBurstBeforeFanout(
    "memory-v2-cross-client-commit-burst",
    2,
  );
});

Deno.test("memory v2 server elides own set heads and delivers own patch heads through watches", async () => {
  const server = createServer("memory://memory-v2-server-suppress-own-watch");
  const writerMessages: ServerMessage[] = [];
  const observerMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const observer = server.connect((message) => observerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-suppress-own-watch";

  try {
    for (const connection of [writer, observer]) {
      await connection.receive(encodeMemoryBoundary(HELLO));
    }
    const writerSessionOpen = expectHelloOk(writerMessages);
    const observerSessionOpen = expectHelloOk(observerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await observer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "observer-open",
      space,
      session: {},
      invocation: authInvocation(observerSessionOpen),
    }));
    const observerSessionId =
      nextResponse<{ sessionId: string }>(observerMessages).ok!.sessionId;

    for (
      const [connection, sessionId, requestId, messages] of [
        [writer, writerSessionId, "writer-watch", writerMessages],
        [observer, observerSessionId, "observer-watch", observerMessages],
      ] as const
    ) {
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.set",
        requestId,
        space,
        sessionId,
        watches: [{
          id: "root",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:1",
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        }],
      }));
      shiftMessage(messages);
    }

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "writer-tx",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    const committed = nextResponse<any>(writerMessages);
    assertEquals(committed.requestId, "writer-tx");
    assertEquals(committed.ok?.seq, 1);

    await server.flushSessions([space]);

    // The writer hears no echo of its own SET — it provably holds those
    // bytes (CT-1965 elision) — only the accept's marker on an
    // otherwise-empty frame (CT-1927).
    const writerMarker = assertEffect(shiftMessage(writerMessages));
    assertEquals(writerMarker.effect.upserts, []);
    assertEquals(writerMarker.effect.caughtUpLocalSeq, 1);
    assertEquals(writerMessages, []);
    const observerEffect = assertEffect(shiftMessage(observerMessages));
    assertEquals(observerEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(observerEffect.effect.removes, []);
    assertEquals(observerMessages, []);

    // A PATCH head rides the writer's own covering frame as the full
    // post-apply document (CT-1965): merged state is truth the writer
    // cannot extrapolate, so the frame is the truth channel.
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "writer-patch",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:doc:1",
          patches: [{ op: "replace", path: "/value/version", value: 2 }],
        }],
      },
    }));
    const patched = nextResponse<any>(writerMessages);
    assertEquals(patched.requestId, "writer-patch");
    assertEquals(patched.ok?.seq, 2);

    await server.flushSessions([space]);

    const writerEcho = assertEffect(shiftMessage(writerMessages));
    assertEquals(writerEcho.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(writerEcho.effect.caughtUpLocalSeq, 2);
    assertEquals(writerMessages, []);
    const observerPatchEffect = assertEffect(shiftMessage(observerMessages));
    assertEquals(observerPatchEffect.effect.upserts.map((u) => u.seq), [2]);
    assertEquals(observerMessages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server classifies own-write echo by the head-producing op", async () => {
  const server = createServer("memory://memory-v2-server-echo-classification");
  const messages: ServerMessage[] = [];
  const writer = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-echo-classification";

  try {
    await writer.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const sessionId =
      nextResponse<{ sessionId: string }>(messages).ok!.sessionId;
    await writer.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:c",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    shiftMessage(messages);

    const transact = async (
      requestId: string,
      localSeq: number,
      operations: FabricValue[],
    ) => {
      await writer.receive(encodeMemoryBoundary({
        type: "transact",
        requestId,
        space,
        sessionId,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      }));
      return nextResponse<any>(messages).ok!.seq;
    };

    await transact("seed", 1, [{
      op: "set",
      id: "of:doc:c",
      value: { value: { items: [] } },
    }]);
    await server.flushSessions([space]);
    const seeded = assertEffect(shiftMessage(messages));
    assertEquals(seeded.effect.upserts, []);
    assertEquals(seeded.effect.caughtUpLocalSeq, 1);

    // Multi-op ending in a set: the set produced the head, the writer holds
    // its bytes — elided.
    await transact("patch-then-set", 2, [
      {
        op: "patch",
        id: "of:doc:c",
        patches: [{ op: "replace", path: "/value/items", value: ["a"] }],
      },
      { op: "set", id: "of:doc:c", value: { value: { items: ["b"] } } },
    ]);
    await server.flushSessions([space]);
    const elided = assertEffect(shiftMessage(messages));
    assertEquals(elided.effect.upserts, []);
    assertEquals(elided.effect.caughtUpLocalSeq, 2);

    // Multi-op ending in a patch: the patch produced the head — full
    // post-apply doc.
    await transact("set-then-patch", 3, [
      { op: "set", id: "of:doc:c", value: { value: { items: [] } } },
      {
        op: "patch",
        id: "of:doc:c",
        patches: [{ op: "replace", path: "/value/items", value: ["c"] }],
      },
    ]);
    await server.flushSessions([space]);
    const echoed = assertEffect(shiftMessage(messages));
    assertEquals(echoed.effect.upserts, [{
      branch: "",
      id: "of:doc:c",
      scope: "space",
      seq: 3,
      doc: { value: { items: ["c"] } },
    }]);
    assertEquals(echoed.effect.caughtUpLocalSeq, 3);

    // Two commits coalesced into one flush: the origin tracks the latest
    // commit — a patch head — so the frame carries the full doc at the
    // latest seq.
    await transact("coalesced-set", 4, [{
      op: "set",
      id: "of:doc:c",
      value: { value: { items: ["d"] } },
    }]);
    await transact("coalesced-patch", 5, [{
      op: "patch",
      id: "of:doc:c",
      patches: [{ op: "append", path: "/value/items", values: ["e"] }],
    }]);
    await server.flushSessions([space]);
    const coalesced = assertEffect(shiftMessage(messages));
    assertEquals(coalesced.effect.upserts, [{
      branch: "",
      id: "of:doc:c",
      scope: "space",
      seq: 5,
      doc: { value: { items: ["d", "e"] } },
    }]);
    assertEquals(coalesced.effect.caughtUpLocalSeq, 5);

    // An own DELETE head is elided: the writer trivially holds its outcome.
    await transact("delete", 6, [{ op: "delete", id: "of:doc:c" }]);
    await server.flushSessions([space]);
    const deleted = assertEffect(shiftMessage(messages));
    assertEquals(deleted.effect.upserts, []);
    assertEquals(deleted.effect.caughtUpLocalSeq, 6);
    assertEquals(messages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server suppresses own patch heads when the own-write echo config is off", async () => {
  setOwnWriteEchoConfig(false);
  const server = createServer("memory://memory-v2-server-echo-config-off");
  const messages: ServerMessage[] = [];
  const writer = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-echo-config-off";

  try {
    await writer.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);
    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const sessionId =
      nextResponse<{ sessionId: string }>(messages).ok!.sessionId;
    await writer.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:k",
            selector: { path: [], schema: false },
          }],
        },
      }],
    }));
    shiftMessage(messages);

    for (
      const [requestId, localSeq, operations] of [
        ["seed", 1, [{
          op: "set",
          id: "of:doc:k",
          value: { value: { version: 1 } },
        }]],
        ["patch", 2, [{
          op: "patch",
          id: "of:doc:k",
          patches: [{ op: "replace", path: "/value/version", value: 2 }],
        }]],
      ] as const
    ) {
      await writer.receive(encodeMemoryBoundary({
        type: "transact",
        requestId,
        space,
        sessionId,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: operations as unknown as FabricValue[],
        },
      }));
      nextResponse<any>(messages);
      await server.flushSessions([space]);
      // Config off restores full suppression: patch heads included.
      const marker = assertEffect(shiftMessage(messages));
      assertEquals(marker.effect.upserts, []);
      assertEquals(marker.effect.caughtUpLocalSeq, localSeq);
    }
    assertEquals(messages, []);
  } finally {
    resetOwnWriteEchoConfig();
    await server.close();
  }
});

Deno.test("memory v2 server delivers a foreign-moved head to the earlier own-set writer", async () => {
  const server = createServer("memory://memory-v2-server-echo-foreign-moved");
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  const first = server.connect((message) => firstMessages.push(message));
  const second = server.connect((message) => secondMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-echo-foreign-moved";

  try {
    const firstSessionId = await openTestSession(
      first,
      firstMessages,
      space,
      "first",
    );
    const secondSessionId = await openTestSession(
      second,
      secondMessages,
      space,
      "second",
    );

    for (
      const [connection, sessionId, messages] of [
        [first, firstSessionId, firstMessages],
        [second, secondSessionId, secondMessages],
      ] as const
    ) {
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "watch",
        space,
        sessionId,
        watches: [{
          id: "root",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:f",
              selector: { path: [], schema: false },
            }],
          },
        }],
      }));
      shiftMessage(messages);
    }

    // The first session sets; a foreign set moves the head PAST it inside
    // the same un-flushed batch. The first writer no longer holds the head,
    // so its frame MUST carry the doc — with the foreign value — despite
    // its own set being elidable a moment earlier.
    await first.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "first-set",
      space,
      sessionId: firstSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:f",
          value: { value: { author: "first" } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(firstMessages).requestId, "first-set");

    await second.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "second-set",
      space,
      sessionId: secondSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:f",
          value: { value: { author: "second" } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(secondMessages).requestId, "second-set");

    await server.flushSessions([space]);

    const firstEffect = assertEffect(shiftMessage(firstMessages));
    assertEquals(firstEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:f",
      scope: "space",
      seq: 2,
      doc: { value: { author: "second" } },
    }]);
    assertEquals(firstEffect.effect.caughtUpLocalSeq, 1);
    assertEquals(firstMessages, []);

    // Mixed provenance also delivers to the head-owning second writer: the
    // doc fans out authoritatively to every session once two sessions wrote
    // it in one batch window.
    const secondEffect = assertEffect(shiftMessage(secondMessages));
    assertEquals(secondEffect.effect.upserts.map((u) => u.seq), [2]);
    assertEquals(secondEffect.effect.caughtUpLocalSeq, 1);
    assertEquals(secondMessages, []);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server returns conflicts before deferred caught-up session sync", async () => {
  // Verdict-first is the design (CT-1927): the rejection returns inline and
  // the deferred sync (with its marker) follows on the batch pass.
  const server = createServer("memory://memory-v2-server-conflict-flush", 20);
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-flush";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    assertEquals(nextResponse<any>(messages).ok?.sync.upserts, [
      {
        branch: "",
        id: "of:doc:1",
        scope: "space",
        seq: 0,
        deleted: true,
      },
    ]);

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<unknown>(messages).requestId,
      "tx-1",
    );

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }, {
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 3 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "tx-2");
    assertEquals(messages.length, 0);

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [
            {
              id: "of:doc:1",
              path: [],
              seq: 1,
            },
            {
              id: "of:doc:2",
              path: [],
              seq: 1,
            },
          ],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 2 } },
        }],
      },
    }));

    const rejected = nextResponse<unknown>(messages);
    assertEquals(rejected.requestId, "tx-3");
    assertEquals(rejected.error, {
      name: "ConflictError",
      message:
        "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2; " +
        "stale confirmed read: of:doc:2 at seq 1 conflicted with seq 2",
      retryAfterSeq: 2,
      conflicts: [
        { of: "of:doc:1", scope: "space", seq: 1, conflictSeq: 2 },
        { of: "of:doc:2", scope: "space", seq: 1, conflictSeq: 2 },
      ],
    });
    assertEquals(messages.length, 0);

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.caughtUpLocalSeq, 3);
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 3 },
      },
    }]);
    assertEquals(messages.length, 0);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server empty caught-up sync preserves previous fromSeq", async () => {
  // Verdict-first is the design (CT-1927): the rejection returns inline and
  // the deferred sync (with its marker) follows on the batch pass.
  const server = createServer(
    "memory://memory-v2-server-empty-caught-up-from-seq",
    20,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-empty-caught-up-from-seq";

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "tx-1");

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "of:doc:1",
            path: [],
            seq: 0,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 2 } },
        }],
      },
    }));
    const rejected = nextResponse<any>(messages);
    assertEquals(rejected.requestId, "tx-2");
    assertEquals(rejected.error?.name, "ConflictError");

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect, {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      upserts: [],
      removes: [],
      caughtUpLocalSeq: 2,
    });
    assertEquals(messages.length, 0);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server processes back-to-back websocket messages in receive order before returning conflicts", async () => {
  // Verdict-first is the design (CT-1927): the rejection returns inline and
  // the deferred sync (with its marker) follows on the batch pass.
  const server = createServer(
    "memory://memory-v2-server-conflict-receive-order",
    20,
  );
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = "did:key:z6Mk-memory-v2-conflict-receive-order";
  const originalTransact = server.transact.bind(server);
  const releaseTx2 = Promise.withResolvers<void>();

  (server as unknown as {
    transact(
      ...args: Parameters<Server["transact"]>
    ): ReturnType<Server["transact"]>;
  }).transact = async (...args) => {
    const [message] = args;
    if (message.requestId === "tx-2") {
      await releaseTx2.promise;
    }
    return await originalTransact(...args);
  };

  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const sessionOpen = expectHelloOk(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }],
    }));
    shiftMessage(messages);

    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(nextResponse<any>(messages).requestId, "tx-1");

    const tx2 = connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));
    await tick();

    const tx3 = connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [{
            id: "of:doc:1",
            path: [],
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 2 } },
        }],
      },
    }));

    releaseTx2.resolve();
    await Promise.all([tx2, tx3]);

    assertEquals(nextResponse<any>(messages).requestId, "tx-2");

    const rejected = nextResponse<any>(messages);
    assertEquals(rejected.requestId, "tx-3");
    assertEquals(rejected.error, {
      name: "ConflictError",
      message: "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2",
      retryAfterSeq: 2,
      conflicts: [{ of: "of:doc:1", scope: "space", seq: 1, conflictSeq: 2 }],
    });
    assertEquals(messages.length, 0);

    await server.flushSessions([space]);

    const effect = assertEffect(shiftMessage(messages));
    assertEquals(effect.effect.caughtUpLocalSeq, 3);
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 3 },
      },
    }]);
    assertEquals(messages.length, 0);
  } finally {
    await server.close();
  }
});

Deno.test("memory v2 server waits for queued receives before rerunning scheduled watch refresh", async () => {
  const time = new FakeTime();
  // Pins the TIMER pipeline's drain-wait choreography.
  const server = createServer(
    "memory://memory-v2-server-refresh-after-queue-drain",
    1,
  );
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-refresh-after-queue-drain";
  const originalSync = server.syncSessionForConnection.bind(server);
  const originalTransact = server.transact.bind(server);
  const releaseFirstRefresh = Promise.withResolvers<void>();
  const releaseTx3 = Promise.withResolvers<void>();
  let syncCalls = 0;

  (server as unknown as {
    syncSessionForConnection(
      ...args: Parameters<Server["syncSessionForConnection"]>
    ): ReturnType<Server["syncSessionForConnection"]>;
  }).syncSessionForConnection = async (...args) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      await releaseFirstRefresh.promise;
    }
    return await originalSync(...args);
  };

  (server as unknown as {
    transact(
      ...args: Parameters<Server["transact"]>
    ): ReturnType<Server["transact"]>;
  }).transact = async (...args) => {
    const [message] = args;
    if (message.requestId === "tx-3") {
      await releaseTx3.promise;
    }
    return await originalTransact(...args);
  };

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [
        {
          id: "root-1",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:1",
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        },
        {
          id: "root-2",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:2",
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        },
      ],
    }));
    shiftMessage(messages);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-1",
    );

    await time.tickAsync(1);
    await time.tickAsync(0);

    const tx2 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 2 } },
        }],
      },
    }));

    const tx3 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));

    await time.tickAsync(0);
    releaseFirstRefresh.resolve();
    await time.tickAsync(0);

    const firstEffect = assertEffect(shiftMessage(messages));
    assertEquals(firstEffect.effect.toSeq, 1);
    assertEquals(firstEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(messages, []);

    await tx2;
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-2",
    );

    releaseTx3.resolve();
    await tx3;
    await time.tickAsync(1);
    await time.tickAsync(0);

    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-3",
    );
    const secondEffect = assertEffect(shiftMessage(messages));
    assertEquals(secondEffect.effect.toSeq, 3);
    assertEquals(secondEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 3,
      doc: {
        value: { version: 3 },
      },
    }, {
      branch: "",
      id: "of:doc:2",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(messages, []);
  } finally {
    await server.close();
    time.restore();
  }
});

Deno.test("memory v2 server reruns scheduled watch refresh after max deferral", async () => {
  const time = new FakeTime();
  // Pins the TIMER pipeline's deferral choreography (its gated sync stub
  // scripts the batched pass).
  const server = createServer(
    "memory://memory-v2-server-refresh-max-deferral",
    1,
  );
  const messages: ServerMessage[] = [];
  const writerMessages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const writer = server.connect((message) => writerMessages.push(message));
  const space = "did:key:z6Mk-memory-v2-server-refresh-max-deferral";
  const originalSync = server.syncSessionForConnection.bind(server);
  const originalTransact = server.transact.bind(server);
  const releaseFirstRefresh = Promise.withResolvers<void>();
  const releaseTx3 = Promise.withResolvers<void>();
  let syncCalls = 0;

  (server as unknown as {
    syncSessionForConnection(
      ...args: Parameters<Server["syncSessionForConnection"]>
    ): ReturnType<Server["syncSessionForConnection"]>;
  }).syncSessionForConnection = async (...args) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      await releaseFirstRefresh.promise;
    }
    return await originalSync(...args);
  };

  (server as unknown as {
    transact(
      ...args: Parameters<Server["transact"]>
    ): ReturnType<Server["transact"]>;
  }).transact = async (...args) => {
    const [message] = args;
    if (message.requestId === "tx-3") {
      await releaseTx3.promise;
    }
    return await originalTransact(...args);
  };

  try {
    for (const client of [connection, writer]) {
      await client.receive(encodeMemoryBoundary(HELLO));
    }
    const sessionOpen = expectHelloOk(messages);
    const writerSessionOpen = expectHelloOk(writerMessages);

    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerSessionId =
      nextResponse<{ sessionId: string }>(writerMessages).ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open-1",
      space,
      session: {},
      invocation: authInvocation(sessionOpen),
    }));
    const opened = nextResponse<{ sessionId: string }>(messages);
    const sessionId = opened.ok!.sessionId;

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId,
      watches: [
        {
          id: "root-1",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:1",
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        },
        {
          id: "root-2",
          kind: "graph",
          query: {
            roots: [{
              id: "of:doc:2",
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        },
      ],
    }));
    shiftMessage(messages);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-1",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 1 } },
        }],
      },
    }));
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-1",
    );

    await time.tickAsync(1);
    await time.tickAsync(0);

    const tx2 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:2",
          value: { value: { version: 2 } },
        }],
      },
    }));

    const tx3 = writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-3",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 3 } },
        }],
      },
    }));

    await time.tickAsync(0);
    releaseFirstRefresh.resolve();
    await time.tickAsync(0);

    const firstEffect = assertEffect(shiftMessage(messages));
    assertEquals(firstEffect.effect.toSeq, 1);
    assertEquals(firstEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 1,
      doc: {
        value: { version: 1 },
      },
    }]);
    assertEquals(messages, []);

    await tx2;
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-2",
    );

    await time.tickAsync(1);
    await time.tickAsync(0);

    await time.tickAsync(499);
    await time.tickAsync(0);
    assertEquals(messages, []);

    await time.tickAsync(1);
    await time.tickAsync(0);
    assertEquals(messages, []);

    await time.tickAsync(499);
    await time.tickAsync(0);
    assertEquals(messages, []);

    await time.tickAsync(1);
    await time.tickAsync(0);
    const secondEffect = assertEffect(shiftMessage(messages));
    assertEquals(secondEffect.effect.toSeq, 2);
    assertEquals(secondEffect.effect.upserts, [{
      branch: "",
      id: "of:doc:2",
      scope: "space",
      seq: 2,
      doc: {
        value: { version: 2 },
      },
    }]);
    assertEquals(messages, []);

    releaseTx3.resolve();
    await tx3;
    assertEquals(
      nextResponse<any>(writerMessages).requestId,
      "tx-3",
    );
  } finally {
    await server.close();
    time.restore();
  }
});
