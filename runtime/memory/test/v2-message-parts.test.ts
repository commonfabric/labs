// Messages in parts. A server splits a sync too large for its transport's
// messages, and the client handles the parts as the one sync they divide
// (`syncPartsV1`, 04-protocol.md section 4.2.3). A client stages a watch set
// too large for one message in parts, and the server applies them as one set
// (`watchSetPartsV1`, section 4.3.5).

import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  connect,
  connectionError,
  loopback,
  type Transport,
} from "../v2/client.ts";
import {
  encodeMemoryBoundary,
  type EntitySnapshot,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type WatchSetRequest,
} from "../v2.ts";
import {
  appendWatchSetPart,
  halveSyncPart,
  type PartLimits,
  payloadFits,
  serverMessageSync,
  splitSyncMessage,
  splitWatchSetRequest,
  stagedWatchSet,
  SyncPartAssembler,
} from "../v2/message-parts.ts";
import type { JSONSchema } from "@commonfabric/api";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { countValues } from "./support/routed-slots.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SESSION = { space: "did:key:z6Mk-sync-parts", sessionId: "session-1" };

const upsert = (index: number, size = 200) => ({
  branch: "",
  id: `of:sync-part-${index}`,
  seq: index + 1,
  doc: { value: { index, text: "x".repeat(size) } },
});

const responseWith = (sync: SessionSync): ServerMessage => ({
  type: "response",
  requestId: "req:1",
  ok: { serverSeq: 40, sync },
} as ServerMessage);

const syncOf = (count: number, extra: Partial<SessionSync> = {}) =>
  ({
    type: "sync",
    fromSeq: 0,
    toSeq: 40,
    caughtUpLocalSeq: 3,
    upserts: Array.from({ length: count }, (_, index) => upsert(index)),
    removes: [{ branch: "", id: "of:sync-part-removed" }],
    ...extra,
  }) as SessionSync;

/** Joins `parts` through an assembler, asserting it holds all but the last. */
const join = (parts: ServerMessage[]): ServerMessage => {
  const assembler = new SyncPartAssembler();
  for (const part of parts.slice(0, -1)) {
    assertEquals(assembler.accept(part, SESSION), undefined);
    assert(assembler.pending);
  }
  const whole = assembler.accept(parts.at(-1)!, SESSION);
  assertExists(whole);
  assert(!assembler.pending);
  return whole;
};

const valueCount = (message: ServerMessage): number =>
  countValues(JSON.parse(encodeMemoryBoundary(message).slice("fvj1:".length)));

Deno.test("a split sync's parts fit their bounds and join to the sync", () => {
  const limits: PartLimits = { bytes: 2048, values: 60 };
  const message = responseWith(syncOf(30));
  const parts = splitSyncMessage(message, SESSION, limits);
  assert(parts.length > 1);
  for (const part of parts) {
    assert(
      new TextEncoder().encode(encodeMemoryBoundary(part)).length <=
        limits.bytes,
    );
    assert(valueCount(part) <= limits.values!);
  }
  // The first part takes the response's place; the rest are effects for the
  // session, and every part but the last says more follow.
  assertEquals(parts[0].type, "response");
  for (const part of parts.slice(1)) {
    assertEquals(part.type, "session/effect");
    assertEquals((part as SessionEffectMessage).space, SESSION.space);
    assertEquals((part as SessionEffectMessage).sessionId, SESSION.sessionId);
  }
  assertEquals(
    parts.map((part) => serverMessageSync(part)!.more),
    [...parts.slice(1).map(() => true as const), undefined],
  );
  for (const part of parts) {
    const sync = serverMessageSync(part)!;
    assertEquals(
      [sync.fromSeq, sync.toSeq, sync.caughtUpLocalSeq],
      [0, 40, 3],
    );
  }
  assertEquals(join(parts), message);
});

Deno.test("a split effect joins to the effect", () => {
  const message: SessionEffectMessage = {
    type: "session/effect",
    ...SESSION,
    effect: syncOf(12, { crossings: [] }),
  };
  const parts = splitSyncMessage(message, SESSION, {
    bytes: 1500,
    values: null,
  });
  assert(parts.length > 1);
  assert(parts.every((part) => part.type === "session/effect"));
  // An empty optional list stays on the first part, so the join keeps it.
  assertEquals(serverMessageSync(parts[0])!.crossings, []);
  assertEquals(join(parts), message);
});

Deno.test("an entry larger than a part goes alone, and a lone entry is not split", () => {
  const sync = syncOf(3);
  sync.upserts[1] = upsert(1, 5000);
  const parts = splitSyncMessage(responseWith(sync), SESSION, {
    bytes: 2048,
    values: null,
  });
  // The large entry fills a part by itself; the small ones share theirs.
  assertEquals(
    parts.map((part) => {
      const { upserts, removes } = serverMessageSync(part)!;
      return [upserts.length, removes.length];
    }),
    [[1, 0], [1, 0], [1, 1]],
  );
  assertEquals(join(parts), responseWith(sync));

  const lone = responseWith({ ...syncOf(1), removes: [] });
  assertEquals(splitSyncMessage(lone, SESSION, { bytes: 10, values: 1 }), [
    lone,
  ]);
  assertEquals(halveSyncPart(lone, SESSION), undefined);
});

Deno.test("a halved part keeps its place in the sequence", () => {
  const parts = splitSyncMessage(responseWith(syncOf(8)), SESSION, {
    bytes: 1500,
    values: null,
  });
  const [first, second] = halveSyncPart(parts.at(-1)!, SESSION)!;
  assertEquals(serverMessageSync(first)!.more, true);
  assertEquals(serverMessageSync(second)!.more, undefined);
  assertEquals(
    join([...parts.slice(0, -1), first, second]),
    responseWith(syncOf(8)),
  );
});

Deno.test("the assembler passes other sessions' messages between a split sync's parts", () => {
  const parts = splitSyncMessage(responseWith(syncOf(10)), SESSION, {
    bytes: 1500,
    values: null,
  });
  const other = { space: SESSION.space, sessionId: "session-2" };
  const otherEffect: ServerMessage = {
    type: "session/effect",
    ...other,
    effect: { ...syncOf(1), removes: [] },
  };
  const assembler = new SyncPartAssembler();
  assertEquals(assembler.accept(parts[0], SESSION), undefined);
  assertEquals(assembler.accept(otherEffect, other), otherEffect);
  for (const part of parts.slice(1, -1)) {
    assertEquals(assembler.accept(part, SESSION), undefined);
  }
  assertEquals(
    assembler.accept(parts.at(-1)!, SESSION),
    responseWith(syncOf(10)),
  );
});

Deno.test("the assembler passes a message for the session that carries no sync between its sync's parts", () => {
  const parts = splitSyncMessage(responseWith(syncOf(10)), SESSION, {
    bytes: 1500,
    values: null,
  });
  // A router's own answer to another of the session's requests, and any
  // other message that carries no sync, come as they are.
  const refusal = {
    type: "response",
    requestId: "req:2",
    error: {
      name: "AuthorizationError",
      message: "Routed memory request denied",
    },
  } as ServerMessage;
  const presence = {
    type: "presence/remove",
    ...SESSION,
    room: "room",
    participantId: "someone",
  } as ServerMessage;
  const assembler = new SyncPartAssembler();
  assertEquals(assembler.accept(parts[0], SESSION), undefined);
  assertEquals(assembler.accept(refusal, SESSION), refusal);
  assertEquals(assembler.accept(presence, SESSION), presence);
  for (const part of parts.slice(1, -1)) {
    assertEquals(assembler.accept(part, SESSION), undefined);
  }
  assertEquals(
    assembler.accept(parts.at(-1)!, SESSION),
    responseWith(syncOf(10)),
  );
});

Deno.test("the assembler refuses a split sync's parts out of sequence", () => {
  const parts = splitSyncMessage(responseWith(syncOf(10)), SESSION, {
    bytes: 1500,
    values: null,
  });
  const refuses = (messages: ServerMessage[]) => {
    const assembler = new SyncPartAssembler();
    assertThrows(
      () => {
        for (const message of messages) assembler.accept(message, SESSION);
      },
      Error,
      "Invalid session sync part",
    );
  };
  // Another sync for the session, in a response, before the last part.
  refuses([parts[0], responseWith({ ...syncOf(1), removes: [] })]);
  // A later part at another sequence than the first.
  const moved = structuredClone(parts[1]) as SessionEffectMessage;
  moved.effect.toSeq = 41;
  refuses([parts[0], moved]);
  // A first part whose session is not known.
  assertThrows(
    () => new SyncPartAssembler().accept(parts[0], undefined),
    Error,
    "Invalid session sync part",
  );
  // `more` with a value other than `true`.
  const odd = structuredClone(parts[0]) as ResponseMessage<
    { sync: Record<string, unknown> }
  >;
  odd.ok!.sync.more = false;
  refuses([odd as ServerMessage]);
});

Deno.test("payloadFits counts the values of text long enough to exceed the bound", () => {
  const values = 100;
  const numbers = (n: number) => `fvj1:[${"0,".repeat(n - 1)}0]`;
  // Text of at most 201 characters cannot hold more than 100 values: 97
  // numbers in an array, 98 values, take 200.
  assertEquals(numbers(97).length, 200);
  assert(payloadFits(numbers(97), { bytes: 1000, values }));
  // Longer text is counted: 99 numbers, 100 values, fit; 100 numbers, 101
  // values, do not, in 206 characters; one long string does.
  assert(payloadFits(numbers(99), { bytes: 1000, values }));
  assertEquals(numbers(100).length, 206);
  assert(!payloadFits(numbers(100), { bytes: 1000, values }));
  assert(!payloadFits(numbers(200), { bytes: 1000, values }));
  assert(payloadFits(`fvj1:["${"x".repeat(900)}"]`, { bytes: 1000, values }));
  // Bytes are UTF-8 bytes.
  assert(!payloadFits(`fvj1:"${"é".repeat(600)}"`, { bytes: 1000, values }));
  assert(payloadFits(`fvj1:"${"é".repeat(400)}"`, { bytes: 1000, values }));
});

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const DOCS = 24;

/**
 * Writes `DOCS` documents through one connection and opens a watch over
 * them all through another that splits syncs to `limits`, with `flags` in
 * its hello. Returns what the watcher was sent after its open.
 */
const watchThroughParts = async (
  storeName: string,
  limits: PartLimits,
  flags: typeof HELLO.flags = HELLO.flags,
): Promise<ServerMessage[]> => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${storeName}`),
    subscriptionRefreshDelayMs: 0,
  });
  const writerMessages: ServerMessage[] = [];
  const watcherMessages: ServerMessage[] = [];
  const writer = server.connect((message) => writerMessages.push(message));
  const watcher = server.connect(
    (message) => watcherMessages.push(message),
    limits,
  );
  const space = `did:key:z6Mk-${storeName}`;
  const open = async (
    connection: ReturnType<Server["connect"]>,
    messages: ServerMessage[],
    hello: typeof HELLO.flags,
  ): Promise<string> => {
    await connection.receive(encodeMemoryBoundary({ ...HELLO, flags: hello }));
    const ok = messages.shift() as HelloOkMessage;
    assertEquals(ok.type, "hello.ok");
    const sessionOpen = ok.sessionOpen as SessionOpenAuthMetadata;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
    assertEquals(opened.type, "response");
    return opened.ok!.sessionId;
  };
  try {
    const writerSession = await open(writer, writerMessages, HELLO.flags);
    const watcherSession = await open(watcher, watcherMessages, flags);
    await writer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "write",
      space,
      sessionId: writerSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: DOCS }, (_, index) => ({
          op: "set",
          id: `of:sync-part-${index}`,
          value: { value: { index, text: "y".repeat(300) } },
        })),
      },
    }));
    watcherMessages.length = 0;
    await watcher.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId: watcherSession,
      watches: [{
        id: "all",
        kind: "graph",
        query: {
          roots: Array.from({ length: DOCS }, (_, index) => ({
            id: `of:sync-part-${index}`,
            selector: { path: [], schema: false },
          })),
        },
      }],
    }));
    return [...watcherMessages];
  } finally {
    await server.close();
  }
};

Deno.test("a server splits a watch set's sync for a client that takes a sync in parts", async () => {
  const limits = { bytes: 2048, values: 400 };
  const messages = await watchThroughParts("sync-parts-split", limits);
  const response = messages.findIndex((message) =>
    message.type === "response" &&
    (message as ResponseMessage<unknown>).requestId === "watch"
  );
  assert(response !== -1);
  const parts = messages.slice(response);
  assert(parts.length > 1);
  for (const part of parts) {
    assert(
      new TextEncoder().encode(encodeMemoryBoundary(part)).length <=
        limits.bytes,
    );
    assert(valueCount(part) <= limits.values);
  }
  const sessionId = (parts[1] as SessionEffectMessage).sessionId;
  const assembler = new SyncPartAssembler();
  let whole: ServerMessage | undefined;
  for (const part of parts) {
    whole = assembler.accept(part, {
      space: (parts[1] as SessionEffectMessage).space,
      sessionId,
    });
  }
  assertExists(whole);
  const sync = serverMessageSync(whole)!;
  assertEquals(sync.more, undefined);
  assertEquals(
    sync.upserts.map((entry) => entry.id).sort(),
    Array.from({ length: DOCS }, (_, index) => `of:sync-part-${index}`)
      .sort(),
  );
});

Deno.test("a server sends a sync whole to a client that does not take one in parts", async () => {
  const messages = await watchThroughParts(
    "sync-parts-unnegotiated",
    { bytes: 2048, values: 400 },
    { ...HELLO.flags, syncPartsV1: false },
  );
  const response = messages.find((message) =>
    message.type === "response" &&
    (message as ResponseMessage<unknown>).requestId === "watch"
  )!;
  const sync = serverMessageSync(response)!;
  assertEquals(sync.more, undefined);
  assertEquals(sync.upserts.length, DOCS);
});

/**
 * Opens a session on a raw connection that splits syncs to `limits`, writes
 * `values` as documents `of:<name>-<i>` and sets a watch on them all. Returns
 * the messages the watch set's answer took.
 */
const watchedThrough = async (
  name: string,
  limits: PartLimits,
  values: unknown[],
): Promise<ServerMessage[]> => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${name}`),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect(
    (message) => messages.push(message),
    limits,
  );
  const space = `did:key:z6Mk-${name}`;
  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const ok = messages.shift() as HelloOkMessage;
    const sessionOpen = ok.sessionOpen as SessionOpenAuthMetadata;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const sessionId =
      (messages.shift() as ResponseMessage<{ sessionId: string }>).ok!
        .sessionId;
    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "write",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: values.map((value, n) => ({
          op: "set",
          id: `of:${name}-${n}`,
          value: { value },
        })),
      },
    } as never));
    messages.length = 0;
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "all",
        kind: "graph",
        query: {
          roots: values.map((_, n) => ({
            id: `of:${name}-${n}`,
            selector: { path: [], schema: false },
          })),
        },
      }],
    }));
    const start = messages.findIndex((message) =>
      message.type === "response" &&
      (message as ResponseMessage<unknown>).requestId === "watch"
    );
    return messages.slice(start);
  } finally {
    connection.close();
    await server.close();
  }
};

Deno.test("a server sends a sync whole within the bounds of a whole message, and splits only one past them", async () => {
  const values = Array.from({ length: 24 }, (_, n) => ({
    n,
    text: "w".repeat(300),
  }));
  // About 8 KB: whole within 64 KiB, though over a part's 2 KiB.
  const whole = await watchedThrough(
    "sync-parts-whole",
    { bytes: 2048, values: null, whole: 64 * 1024 },
    values,
  );
  assertEquals(whole.length, 1);
  assertEquals(serverMessageSync(whole[0])!.upserts.length, 24);
  // Past 4 KiB, it is split into parts of 2 KiB.
  const parts = await watchedThrough(
    "sync-parts-past-whole",
    { bytes: 2048, values: null, whole: 4096 },
    values,
  );
  assert(parts.length > 2);
  for (const part of parts) {
    assert(encodeMemoryBoundary(part).length <= 2048);
  }
});

Deno.test("a server cuts a sync's parts by what its entries take once compacted", async () => {
  // Forty documents link with one large schema. Inline, each document is
  // about 2 KB and the sync about 80 KB; compacted, each is about 200 bytes
  // and the schema goes once in a table. Cut by the compacted entries, with
  // room for the table, the sync takes two parts of 8 KB, not a part for
  // every three documents.
  const schema: JSONSchema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`field${i}`, { type: "string" }]),
    ),
  };
  const parts = await watchedThrough(
    "sync-parts-compacted",
    { bytes: 8192, values: null },
    Array.from({ length: 40 }, (_, n) => ({
      n,
      link: linkRefFrom({ id: `of:target-${n}`, path: [], schema }),
    })),
  );
  assertEquals(parts.length, 2);
  for (const part of parts) {
    assert(encodeMemoryBoundary(part).length <= 8192);
  }
});

Deno.test("a server halves a sync whose own tables take it past its bounds", async () => {
  // Two documents, each linking with a large schema of its own. Compacted,
  // each document is small, and by their own sizes both fit one part; but
  // the message carries both schemas in its table, which takes it past the
  // bound. Halved, each part carries the one schema it uses, and fits.
  const schemaOf = (n: number): JSONSchema => ({
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`field${n}x${i}`, {
        type: "string",
      }]),
    ),
  });
  const limits = { bytes: 3072, values: null };
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-parts-halved"),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect(
    (message) => messages.push(message),
    limits,
  );
  const space = "did:key:z6Mk-sync-parts-halved";
  try {
    await connection.receive(encodeMemoryBoundary(HELLO));
    const ok = messages.shift() as HelloOkMessage;
    const sessionOpen = ok.sessionOpen as SessionOpenAuthMetadata;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const sessionId =
      (messages.shift() as ResponseMessage<{ sessionId: string }>).ok!
        .sessionId;
    await connection.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "write",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [0, 1].map((n) => ({
          op: "set",
          id: `of:halved-${n}`,
          value: {
            value: {
              link: linkRefFrom({
                id: `of:target-${n}`,
                path: [],
                schema: schemaOf(n),
              }),
            },
          },
        })),
      },
    }));
    messages.length = 0;
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "both",
        kind: "graph",
        query: {
          roots: [0, 1].map((n) => ({
            id: `of:halved-${n}`,
            selector: { path: [], schema: false },
          })),
        },
      }],
    }));
    const start = messages.findIndex((message) =>
      message.type === "response" &&
      (message as ResponseMessage<unknown>).requestId === "watch"
    );
    const parts = messages.slice(start);
    assertEquals(parts.length, 2);
    for (const part of parts) {
      assert(encodeMemoryBoundary(part).length <= limits.bytes);
      const sync = serverMessageSync(part) as SessionSync & {
        schemaTable?: Record<string, unknown>;
      };
      assertEquals(Object.keys(sync.schemaTable ?? {}).length, 1);
    }
  } finally {
    connection.close();
    await server.close();
  }
});

Deno.test("a client applies a watch set and a commit that arrive in parts", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-parts-client"),
    subscriptionRefreshDelayMs: 0,
  });
  let parts = 0;
  const inner = loopback(server, { syncParts: { bytes: 2048, values: 400 } });
  const transport: Transport = {
    ...inner,
    send: (payload: string) => inner.send(payload),
    close: () => inner.close(),
    setReceiver(receiver: (payload: string) => void) {
      inner.setReceiver((payload: string) => {
        if (payload.includes('"more":true')) parts++;
        receiver(payload);
      });
    },
  };
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect({ transport });
  const space = "did:key:z6Mk-sync-parts-client";
  try {
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const watcher = await watcherClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const write = (localSeq: number, text: string) =>
      writer.transact({
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: Array.from({ length: DOCS }, (_, index) => ({
          op: "set" as const,
          id: `of:sync-part-${index}`,
          value: { value: { index, text } },
        })),
      });
    await write(1, "a".repeat(300));
    const view = await watcher.watchSet([{
      id: "all",
      kind: "graph",
      query: {
        roots: Array.from({ length: DOCS }, (_, index) => ({
          id: `of:sync-part-${index}`,
          selector: { path: [], schema: false },
        })),
      },
    }]);
    assert(parts > 0);
    assertEquals(view.entities.length, DOCS);

    // A commit touching every document comes back as a split effect, which
    // the view applies whole.
    const before = parts;
    const updates = view.subscribe();
    const next = updates.next();
    await write(2, "b".repeat(300));
    const update = await next;
    assert(parts > before);
    assertEquals(update.done, false);
    assertEquals(
      update.value.entities.map((entity: EntitySnapshot) =>
        (entity.document?.value as { text: string }).text
      ),
      Array.from({ length: DOCS }, () => "b".repeat(300)),
    );
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

const watchSet = (count: number): WatchSetRequest => ({
  type: "session.watch.set",
  requestId: "set-1",
  space: SESSION.space,
  sessionId: SESSION.sessionId,
  watches: Array.from({ length: count }, (_, index) => ({
    id: `watch-${index}`,
    kind: "graph" as const,
    query: {
      roots: [{
        id: `of:sync-part-${index}`,
        selector: { path: [], schema: false },
      }],
    },
  })),
  holdings: Array.from({ length: count }, (_, index) => ({
    id: `of:sync-part-${index}`,
    seq: index + 1,
  })),
  views: [],
});

Deno.test("a staged watch set's parts are numbered, fit their bounds and join to the set", () => {
  const limits = { bytes: 1024, values: 80 };
  const message = watchSet(20);
  const parts = splitWatchSetRequest(message, limits);
  assert(parts.length > 1);
  for (const part of parts) {
    assert(payloadFits(encodeMemoryBoundary(part), limits));
    assertEquals(part.type, "session.watch.set");
    assertEquals(part.sessionId, SESSION.sessionId);
  }
  assertEquals(parts.map((part) => part.part), parts.map((_, index) => index));
  // Every part names its set.
  assert(parts.every((part) => part.stage === message.requestId));
  assertEquals(
    parts.map((part) => part.more),
    [...parts.slice(1).map(() => true as const), undefined],
  );
  // Every part has a request of its own; the last answers for the set.
  assertEquals(new Set(parts.map((part) => part.requestId)).size, parts.length);
  assertEquals(parts.at(-1)!.requestId, message.requestId);
  // An empty list the set sent is still sent, on the first part.
  assertEquals(parts[0].views, []);
  const joined = stagedWatchSet(parts[0]);
  for (const part of parts.slice(1)) appendWatchSetPart(joined, part);
  assertEquals({ ...joined, requestId: message.requestId }, message);
});

/**
 * Opens a session through a raw connection and returns its sender and the
 * messages it was sent, for driving staged watch sets frame by frame.
 */
const rawSession = async (storeName: string) => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${storeName}`),
    subscriptionRefreshDelayMs: 0,
  });
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const space = `did:key:z6Mk-${storeName}`;
  await connection.receive(encodeMemoryBoundary(HELLO));
  const ok = messages.shift() as HelloOkMessage;
  // Each open is answered with the challenge for the next.
  let sessionOpen = ok.sessionOpen as SessionOpenAuthMetadata;
  /** Opens a session of the space on the connection, and returns its ID. */
  const open = async (requestId: string) => {
    messages.length = 0;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId,
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    }));
    const opened = messages.shift() as ResponseMessage<
      { sessionId: string; sessionOpen: SessionOpenAuthMetadata }
    >;
    sessionOpen = opened.ok!.sessionOpen;
    return opened.ok!.sessionId;
  };
  const sessionId = await open("open");
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "write",
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: Array.from({ length: DOCS }, (_, index) => ({
        op: "set",
        id: `of:sync-part-${index}`,
        value: { value: { index } },
      })),
    },
  }));
  /** Sends `request` for a session, the first by default, and returns the answer to it. */
  const send = async (
    request: Record<string, unknown>,
    session = sessionId,
  ) => {
    messages.length = 0;
    await connection.receive(
      encodeMemoryBoundary(
        { ...request, space, sessionId: session } as never,
      ),
    );
    return messages.find((message) =>
      message.type === "response" &&
      (message as ResponseMessage<unknown>).requestId === request.requestId
    ) as ResponseMessage<Record<string, unknown>>;
  };
  const watch = (index: number) => ({
    id: `watch-${index}`,
    kind: "graph",
    query: {
      roots: [{
        id: `of:sync-part-${index}`,
        selector: { path: [], schema: false },
      }],
    },
  });
  return { server, send, watch, open };
};

Deno.test("a server holds a watch set's staged parts and applies them as one set", async () => {
  const { server, send, watch } = await rawSession("staged-set-applied");
  try {
    for (let part = 0; part < 3; part++) {
      const answer = await send({
        type: "session.watch.set",
        requestId: `part-${part}`,
        watches: [watch(2 * part), watch(2 * part + 1)],
        stage: "set",
        part,
        more: true,
      });
      assertEquals(answer.ok, { staged: true });
    }
    const final = await send({
      type: "session.watch.set",
      requestId: "set",
      watches: [watch(6)],
      stage: "set",
      part: 3,
    });
    assertEquals(
      (final.ok!.sync as SessionSync).upserts.map((entry) => entry.id).sort(),
      Array.from({ length: 7 }, (_, index) => `of:sync-part-${index}`).sort(),
    );
  } finally {
    await server.close();
  }
});

Deno.test("a server refuses a staged part that does not follow the parts of its set it holds, and the rest of the set", async () => {
  const { server, send, watch } = await rawSession("staged-set-gap");
  const part = (
    requestId: string,
    index: number,
    stage: string,
    more = true,
  ) =>
    send({
      type: "session.watch.set",
      requestId,
      watches: [watch(index)],
      stage,
      part: index,
      ...(more ? { more: true } : {}),
    });
  try {
    assertEquals((await part("a-0", 0, "a")).ok, { staged: true });
    // Part 1 never arrives: part 2 is refused, and so is the last part,
    // which would otherwise replace the watch set with part 0 and itself.
    assertEquals((await part("a-2", 2, "a")).error?.name, "ProtocolError");
    assertEquals(
      (await part("a-3", 3, "a", false)).error?.name,
      "ProtocolError",
    );
    // A part of another set, at the place the held parts end, is refused:
    // set b's first part never arrived, and set a's held part is not one of
    // b's.
    assertEquals((await part("a-0", 0, "a")).ok, { staged: true });
    assertEquals(
      (await part("b-1", 1, "b", false)).error?.name,
      "ProtocolError",
    );
    // Another watch mutation is applied, and ends a staged set: a router
    // may have refused the set's last part itself.
    assertEquals((await part("c-0", 0, "c")).ok, { staged: true });
    const add = await send({
      type: "session.watch.add",
      requestId: "add",
      watches: [watch(4)],
    });
    assertEquals(add.error, undefined);
    assertEquals(
      (await part("c-1", 1, "c", false)).error?.name,
      "ProtocolError",
    );
    // A whole set applies as ever.
    const whole = await send({
      type: "session.watch.set",
      requestId: "whole",
      watches: [watch(5)],
    });
    assertEquals(
      (whole.ok!.sync as SessionSync).upserts.map((entry) => entry.id),
      ["of:sync-part-5"],
    );
  } finally {
    await server.close();
  }
});

Deno.test("a client stages a watch set past its connection's bounds", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://staged-set-client"),
    subscriptionRefreshDelayMs: 0,
  });
  const staged: string[] = [];
  const inner = loopback(server, {
    messageLimits: { bytes: 2048, values: 400 },
  });
  const transport: Transport = {
    ...inner,
    send: (payload: string) => {
      if (payload.includes('"more":true')) staged.push(payload);
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver: (receiver: (payload: string) => void) =>
      inner.setReceiver(receiver),
  };
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect({ transport });
  const space = "did:key:z6Mk-staged-set-client";
  try {
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: Array.from({ length: DOCS }, (_, index) => ({
        op: "set" as const,
        id: `of:sync-part-${index}`,
        value: { value: { index } },
      })),
    });
    const watcher = await watcherClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const view = await watcher.watchSet(
      Array.from({ length: DOCS }, (_, index) => ({
        id: `watch-${index}`,
        kind: "graph" as const,
        query: {
          roots: [{
            id: `of:sync-part-${index}`,
            selector: { path: [], schema: false },
          }],
        },
      })),
    );
    assert(staged.length > 0);
    assertEquals(view.entities.length, DOCS);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

Deno.test("a client restores a watch set past its connection's bounds in staged parts, and the server applies all of it", async () => {
  const server = (phase: string) =>
    new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://staged-set-restore-${phase}`),
      subscriptionRefreshDelayMs: 0,
    });
  const before = server("before");
  // A server that never held the session: the reconnect opens it again, and
  // its restore sets the whole watch set.
  const after = server("after");
  let host = before;
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  let stagedParts = 0;
  const reach = (next: Server): Transport => {
    const connection = loopback(next);
    connection.setReceiver((payload) => receiver(payload));
    return connection;
  };
  let active: Transport | null = reach(before);
  const transport: Transport = {
    messageLimits: { bytes: 2048, values: 400 },
    async send(payload) {
      if (active === null) throw connectionError("connection refused");
      if (payload.includes('"more":true')) stagedParts++;
      await active.send(payload);
    },
    close: () => active?.close() ?? Promise.resolve(),
    reset() {
      if (active === null) return;
      void active.close();
      active = reach(host);
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      disconnected = next;
    },
  };
  const space = "did:key:z6Mk-staged-set-restore";
  const watcherClient = await connect({ transport });
  const writerClient = await connect({ transport: loopback(after) });
  try {
    const watcher = await watcherClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await watcher.watchSet(
      Array.from({ length: DOCS }, (_, index) => ({
        id: `watch-${index}`,
        kind: "graph" as const,
        query: {
          roots: [{
            id: `of:sync-part-${index}`,
            selector: { path: [], schema: false },
          }],
        },
      })),
    );
    const stagedBefore = stagedParts;
    assert(stagedBefore > 0);

    const down = active;
    active = null;
    await down?.close();
    disconnected(new Error("synthetic outage"));
    host = after;
    active = reach(after);
    await watcherClient.restoreConnection();
    assert(stagedParts > stagedBefore);

    // Every watch, whichever part named it, reaches the restored session.
    const updates = (await watcher.watchAddSync([])).view.subscribe();
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: Array.from({ length: DOCS }, (_, index) => ({
        op: "set" as const,
        id: `of:sync-part-${index}`,
        value: { value: { index } },
      })),
    });
    const next = await updates.next();
    assertEquals(
      (next.value?.entities ?? []).filter((entity: EntitySnapshot) =>
        entity.seq > 0
      ).map((entity: EntitySnapshot) => entity.id).sort(),
      Array.from({ length: DOCS }, (_, index) => `of:sync-part-${index}`)
        .sort(),
    );
  } finally {
    await watcherClient.close();
    await writerClient.close();
    await before.close();
    await after.close();
  }
});

Deno.test("a server holds at most 64 parts of a staged set before its last", async () => {
  const { server, send, watch } = await rawSession("staged-set-bound");
  try {
    for (let part = 0; part < 64; part++) {
      const answer = await send({
        type: "session.watch.set",
        requestId: `part-${part}`,
        watches: [watch(part % DOCS)],
        stage: "set",
        part,
        more: true,
      });
      assertEquals(answer.ok, { staged: true }, `part ${part}`);
    }
    const over = await send({
      type: "session.watch.set",
      requestId: "part-64",
      watches: [watch(0)],
      stage: "set",
      part: 64,
      more: true,
    });
    assertEquals(over.error?.name, "ProtocolError");
    // The set ended with the refusal: its last part follows nothing.
    const last = await send({
      type: "session.watch.set",
      requestId: "part-65",
      watches: [watch(1)],
      stage: "set",
      part: 65,
    });
    assertEquals(last.error?.name, "ProtocolError");
  } finally {
    await server.close();
  }
});

Deno.test("a connection's staged sets hold at most 64 Mi characters together", async () => {
  const { server, send, watch, open } = await rawSession("staged-set-chars");
  // Parts of just under 8 Mi characters: eight fit the bound together.
  const pad = "x".repeat(8 * 1024 * 1024 - 1024);
  const part = (
    requestId: string,
    index: number,
    stage: string,
    session?: string,
  ) =>
    send({
      type: "session.watch.set",
      requestId,
      watches: [{
        ...watch(index),
        query: {
          roots: [{
            id: `of:sync-part-${index}`,
            selector: { path: [], schema: { description: pad } },
          }],
        },
      }],
      stage,
      part: index,
      more: true,
    }, session);
  try {
    const second = await open("open-second");
    for (let index = 0; index < 5; index++) {
      assertEquals((await part(`a-${index}`, index, "a")).ok, {
        staged: true,
      });
    }
    for (let index = 0; index < 3; index++) {
      assertEquals((await part(`b-${index}`, index, "b", second)).ok, {
        staged: true,
      });
    }
    // A ninth part takes the connection past the bound, though the second
    // session's set would hold four parts, not 64. The refusal ends that set.
    assertEquals(
      (await part("b-3", 3, "b", second)).error?.name,
      "ProtocolError",
    );
    for (let index = 0; index < 3; index++) {
      assertEquals((await part(`c-${index}`, index, "c", second)).ok, {
        staged: true,
      });
    }
    // The first session's whole set ends its staged set, which makes room.
    assertEquals(
      (await send({
        type: "session.watch.set",
        requestId: "whole",
        watches: [watch(0)],
      })).error,
      undefined,
    );
    assertEquals((await part("c-3", 3, "c", second)).ok, { staged: true });
  } finally {
    await server.close();
  }
});

Deno.test("a client handles a message for the session that carries no sync between its sync's parts", async () => {
  // A router answers some of a session's requests itself, between the parts
  // of the session's sync; here a presence notice stands in for its answer.
  // The client handles it and completes the sync, on the one connection.
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://sync-parts-client-between"),
    subscriptionRefreshDelayMs: 0,
  });
  let hellos = 0;
  let injected = false;
  const inner = loopback(server, { syncParts: { bytes: 2048, values: 400 } });
  let deliver = (_payload: string) => {};
  const transport: Transport = {
    ...inner,
    send: (payload: string) => {
      if (payload.includes('"type":"hello"')) hellos++;
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver(receiver: (payload: string) => void) {
      deliver = receiver;
      inner.setReceiver((payload: string) => {
        receiver(payload);
        // After a part that names the session and says more follow.
        const match = /"sessionId":"([^"]+)"/.exec(payload);
        if (!injected && payload.includes('"more":true') && match !== null) {
          injected = true;
          deliver(encodeMemoryBoundary({
            type: "presence/remove",
            space,
            sessionId: match[1],
            room: "room",
            participantId: "someone",
          }));
        }
      });
    },
  };
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect({ transport });
  const space = "did:key:z6Mk-sync-parts-client-between";
  try {
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: Array.from({ length: DOCS }, (_, index) => ({
        op: "set" as const,
        id: `of:sync-part-${index}`,
        value: { value: { index, text: "c".repeat(300) } },
      })),
    });
    const watcher = await watcherClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const view = await watcher.watchSet([{
      id: "all",
      kind: "graph",
      query: {
        roots: Array.from({ length: DOCS }, (_, index) => ({
          id: `of:sync-part-${index}`,
          selector: { path: [], schema: false },
        })),
      },
    }]);
    assert(injected);
    assertEquals(view.entities.length, DOCS);
    assertEquals(hellos, 1);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});
