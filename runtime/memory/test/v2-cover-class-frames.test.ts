// Server-execution v2 — the covering commit's CLASS on session frames
// (speculation.md §4's arrival-witness predicate, RULED 2026-08-22):
// under the flag, every doc snapshot a session frame carries names the
// class of its covering commit (`coverClass` — the commit at the
// snapshot's seq; one seq names exactly one commit), so the client's
// speculation overlay can tell an authored setup cover at an entry's
// floor from the derived arrival it waits for. Pinned here:
//
// - ON arm: a watch.set snapshot of an authored transact carries
//   `coverClass: "authored"`; after an engine-direct derived-class
//   commit covers the doc, a re-evaluation carries `"derived"`; a
//   never-written doc's `seq: 0` entry carries NO class (no covering
//   commit); a pushed session/effect frame carries the class too.
// - OFF arm: the field never appears — the OFF wire is byte-identical
//   (the upsert's key set is pinned exactly).

import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import { applyCommit } from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type SessionSyncUpsert,
  setServerExecutionConfig,
} from "../v2.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message);
  return message;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

// Skip the CT-1927 marker-only catch-up frames (see
// v2-watch-sync.test.ts, where the ordering contract itself is pinned).
const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      return assertResponse<Result>(message);
    }
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

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata => {
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return hello.sessionOpen;
};

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

type WatchSetOk = { serverSeq: number; sync: SessionSync };

/** Open two sessions (writer, watcher) on a fresh in-memory server and
 * run `body` with everything a frame pin needs. */
const withSessions = async (
  storeName: string,
  body: (context: {
    server: Server;
    space: string;
    writerSessionId: string;
    watcherSessionId: string;
    writer: ReturnType<Server["connect"]>;
    watcher: ReturnType<Server["connect"]>;
    writerMessages: ServerMessage[];
    watcherMessages: ServerMessage[];
  }) => Promise<void>,
): Promise<void> => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${storeName}`),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect((message) => watcherMessages.push(message));
  const space = `did:key:z6Mk-${storeName}`;
  try {
    for (const connection of [writer, watcher]) {
      await connection.receive(encodeMemoryBoundary(HELLO));
    }
    const writerSessionOpen = expectHelloOk(writerMessages);
    const watcherSessionOpen = expectHelloOk(watcherMessages);
    await writer.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "writer-open",
      space,
      session: {},
      invocation: authInvocation(writerSessionOpen),
    }));
    const writerOpen = nextResponse<{ sessionId: string }>(writerMessages);
    await watcher.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "watcher-open",
      space,
      session: {},
      invocation: authInvocation(watcherSessionOpen),
    }));
    const watcherOpen = nextResponse<{ sessionId: string }>(watcherMessages);
    await body({
      server,
      space,
      writerSessionId: writerOpen.ok!.sessionId,
      watcherSessionId: watcherOpen.ok!.sessionId,
      writer,
      watcher,
      writerMessages,
      watcherMessages,
    });
  } finally {
    await server.close();
  }
};

const transact = (
  sessionId: string,
  space: string,
  localSeq: number,
  id: string,
  n: number,
) =>
  encodeMemoryBoundary({
    type: "transact",
    requestId: `tx-${localSeq}`,
    space,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value: { n } } }],
    },
  });

const watchSet = (
  sessionId: string,
  space: string,
  requestId: string,
  ids: string[],
) =>
  encodeMemoryBoundary({
    type: "session.watch.set",
    requestId,
    space,
    sessionId,
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
  });

const upsertFor = (
  sync: SessionSync,
  id: string,
): SessionSyncUpsert => {
  const upsert = sync.upserts.find((entry) => entry.id === id);
  assertExists(upsert, `no upsert for ${id}`);
  return upsert;
};

Deno.test("ON arm: session frames carry the covering commit's class — authored transact, derived engine commit, none for a never-written doc — on both the watch.set response and the push frame", async () => {
  setServerExecutionConfig(true);
  try {
    await withSessions("cover-class-on", async (context) => {
      const {
        server,
        space,
        writerSessionId,
        watcherSessionId,
        writer,
        watcher,
        writerMessages,
        watcherMessages,
      } = context;

      // An AUTHORED cover: the writer session's transact at seq 1.
      await writer.receive(transact(writerSessionId, space, 1, "of:doc:a", 1));
      nextResponse(writerMessages);

      await watcher.receive(
        watchSet(watcherSessionId, space, "watch-1", [
          "of:doc:a",
          "of:doc:absent",
        ]),
      );
      const first = assertResponse<WatchSetOk>(shiftMessage(watcherMessages));
      const authoredUpsert = upsertFor(first.ok!.sync, "of:doc:a");
      assertEquals(authoredUpsert.seq, 1);
      assertEquals(authoredUpsert.coverClass, "authored");
      // A never-written doc has no covering commit: seq 0, NO class key.
      const absentUpsert = upsertFor(first.ok!.sync, "of:doc:absent");
      assertEquals(absentUpsert.seq, 0);
      assertEquals("coverClass" in absentUpsert, false);

      // A DERIVED cover: an engine-direct derived-class commit under a
      // live execution lease (the serving plane's own admission shape —
      // sessionId IS the holder, no principal; serving-loop.md §2).
      const engine = await server.engineForSpace(space);
      const holder = executionLeaseHolder("did:key:z6Mk-serving-service");
      assertEquals(
        acquireExecutionLease(engine, { space, holder }),
        true,
      );
      applyCommit(engine, {
        sessionId: holder,
        space,
        holder,
        commitClass: "derived",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:a",
            value: { value: { n: 2 } },
          }],
        },
      });
      // A fresh evaluation reads the new cover.
      await watcher.receive(
        watchSet(watcherSessionId, space, "watch-2", ["of:doc:a"]),
      );
      const second = assertResponse<WatchSetOk>(shiftMessage(watcherMessages));
      const derivedUpsert = upsertFor(second.ok!.sync, "of:doc:a");
      assertEquals(derivedUpsert.seq, 2);
      assertEquals(derivedUpsert.coverClass, "derived");

      // The PUSH path (a session/effect frame) carries the class too.
      await writer.receive(transact(writerSessionId, space, 2, "of:doc:a", 3));
      nextResponse(writerMessages);
      // Let the 0-delay refresh fan out (the watch-sync pin's pattern).
      await new Promise((resolve) => setTimeout(resolve, 0));
      const effect = watcherMessages
        .filter((message) => message.type === "session/effect")
        .map((message) => (message as SessionEffectMessage).effect)
        .find((frame) =>
          frame.upserts.some((entry) => entry.id === "of:doc:a")
        );
      assertExists(effect, "no pushed frame carried of:doc:a");
      const pushed = upsertFor(effect, "of:doc:a");
      assertEquals(pushed.seq, 3);
      assertEquals(pushed.coverClass, "authored");
    });
  } finally {
    resetServerExecutionConfig();
  }
});

Deno.test("OFF arm: the field never appears — the exact upsert key set is the pre-predicate wire shape, byte-identical", async () => {
  // EXPLICITLY false, not merely ambient-unset: the pin must hold against
  // the flag's declared OFF state, not against whatever the process
  // happened to inherit.
  setServerExecutionConfig(false);
  try {
    await withSessions("cover-class-off", async (context) => {
      const {
        space,
        writerSessionId,
        watcherSessionId,
        writer,
        watcher,
        writerMessages,
        watcherMessages,
      } = context;
      await writer.receive(transact(writerSessionId, space, 1, "of:doc:a", 1));
      nextResponse(writerMessages);
      await watcher.receive(
        watchSet(watcherSessionId, space, "watch-1", [
          "of:doc:a",
          "of:doc:absent",
        ]),
      );
      const response = assertResponse<WatchSetOk>(
        shiftMessage(watcherMessages),
      );
      const authored = upsertFor(response.ok!.sync, "of:doc:a");
      // The whole key set, pinned: the OFF wire carries exactly the
      // pre-predicate fields, in the pre-predicate order.
      assertEquals(Object.keys(authored), [
        "branch",
        "id",
        "scope",
        "seq",
        "doc",
      ]);
      const absent = upsertFor(response.ok!.sync, "of:doc:absent");
      assertEquals(Object.keys(absent), [
        "branch",
        "id",
        "scope",
        "seq",
        "deleted",
      ]);
      // The push frame too.
      await writer.receive(transact(writerSessionId, space, 2, "of:doc:a", 2));
      nextResponse(writerMessages);
      // Let the 0-delay refresh fan out (the watch-sync pin's pattern).
      await new Promise((resolve) => setTimeout(resolve, 0));
      const effect = watcherMessages
        .filter((message) => message.type === "session/effect")
        .map((message) => (message as SessionEffectMessage).effect)
        .find((frame) =>
          frame.upserts.some((entry) => entry.id === "of:doc:a")
        );
      assertExists(effect, "no pushed frame carried of:doc:a");
      const pushed = upsertFor(effect, "of:doc:a");
      assertEquals(Object.keys(pushed), [
        "branch",
        "id",
        "scope",
        "seq",
        "doc",
      ]);
    });
  } finally {
    resetServerExecutionConfig();
  }
});
