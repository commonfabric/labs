import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
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

const assertEffect = (message: ServerMessage): SessionEffectMessage => {
  assertEquals(message.type, "session/effect");
  return message as SessionEffectMessage;
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

Deno.test("memory v2 server replaces watch sets and emits session sync effects", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-watch-sync"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect((message) => watcherMessages.push(message));
  const space = "did:key:z6Mk-watch-sync";

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
    const writerOpen = nextResponse<{ sessionId: string; serverSeq: number }>(
      writerMessages,
    );

    await watcher.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "watcher-open",
      space,
      session: {},
      invocation: authInvocation(watcherSessionOpen),
    }));
    const watcherOpen = nextResponse<{
      sessionId: string;
      serverSeq: number;
    }>(watcherMessages);

    const writerSessionId = writerOpen.ok!.sessionId;
    const watcherSessionId = watcherOpen.ok!.sessionId;

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
          value: {
            value: {
              hello: "world",
            },
          },
        }],
      },
    }));
    assertEquals(nextResponse(writerMessages).ok, {
      seq: 1,
      branch: "",
      revisions: [{
        id: "of:doc:1",
        branch: "",
        seq: 1,
        opIndex: 0,
        commitSeq: 1,
        op: "set",
        scopeKey: "space",
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    });

    await watcher.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch-1",
      space,
      sessionId: watcherSessionId,
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
    const watchResponse = assertResponse<{
      serverSeq: number;
      sync: {
        type: "sync";
        fromSeq: number;
        toSeq: number;
        upserts: Array<{
          branch: string;
          id: string;
          scope: string;
          seq: number;
          doc?: unknown;
          deleted?: true;
        }>;
        removes: Array<{ branch: string; id: string; scope: string }>;
      };
    }>(shiftMessage(watcherMessages));
    assertEquals(watchResponse.ok?.serverSeq, 1);
    assertEquals(watchResponse.ok?.sync.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          hello: "world",
        },
      },
    }]);
    assertEquals(watchResponse.ok?.sync.removes, []);

    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "tx-2",
      space,
      sessionId: writerSessionId,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: {
            value: {
              hello: "again",
            },
          },
        }],
      },
    }));
    assertEquals(
      (nextResponse(writerMessages).ok as any)?.seq,
      2,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const effect = assertEffect(shiftMessage(watcherMessages));
    assertEquals(effect.sessionId, watcherSessionId);
    assertEquals(effect.effect.type, "sync");
    assertEquals(effect.effect.toSeq, 2);
    assertEquals(effect.effect.upserts, [{
      branch: "",
      id: "of:doc:1",
      scope: "space",
      seq: 2,
      doc: {
        value: {
          hello: "again",
        },
      },
    }]);
    assertEquals(effect.effect.removes, []);
  } finally {
    await server.close();
  }
});
