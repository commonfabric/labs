/**
 * A reconnecting client's DECLARED holdings as the delivery diff base
 * (04-protocol.md §4.1.2, §4.3.5): what the server ships on a
 * re-establishing `session.watch.set` and on a resumed `session.open` is
 * the difference between the watch union and what the client says it
 * holds — not the whole union, and not the server's own memory of what
 * it once delivered.
 *
 * The cases drive the server through its wire boundary, the way the
 * closure-delivery pins do: raw connections, raw messages.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionHolding,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type WatchSetResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-holdings-audience";
const SPACE = "did:key:z6Mk-holdings-space";
const WRITER = "did:key:z6Mk-holdings-writer";
const READER = "did:key:z6Mk-holdings-reader";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const leafSchema = { type: "string", title: "holdings-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);

type Upsert = { id: string; seq: number; deleted?: true };
type Remove = { id: string };
type Sync = { upserts: Upsert[]; removes: Remove[] };

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assert(message !== undefined, "expected a server message");
  return message;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  expect(hello.type).toBe("hello.ok");
  assert(hello.sessionOpen !== undefined, "expected session-open metadata");
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

/** Opens (or resumes) a session; `holdings` ride the request, not the
 * signed descriptor. */
const open = async (
  harness: Harness,
  principal: string,
  session: { sessionId?: string; sessionToken?: string } = {},
  holdings?: SessionHolding[],
): Promise<SessionOpenResult> => {
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
    ...(holdings !== undefined ? { holdings } : {}),
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    SessionOpenResult
  >;
  assert(response.ok !== undefined, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return response.ok;
};

const watchOn = (id: string, watchId: string) => ({
  id: watchId,
  kind: "graph" as const,
  query: {
    roots: [{ id, selector: { path: [], schema: false as const } }],
  },
});

const linkWithSchemaRef = (id: string, hash: string) => ({
  "/": { "link@1": { id, path: [], schema: { $ref: `cid:${hash}` } } },
});

const ids = (entries: readonly { id: string }[]): string[] =>
  entries.map((entry) => entry.id).toSorted();

describe("session holdings", () => {
  let server: Server;
  let writerSession: string;

  /** The union every reader watches: two roots, one of which mentions
   * the leaf schema, so the closure joins `cid:<leaf>`. */
  const roots = ["of:holdings-a", "of:holdings-b"];

  const watches = [
    watchOn("of:holdings-a", "w-a"),
    watchOn("of:holdings-b", "w-b"),
  ];
  let fullUnion: Sync;
  let seqOf: (id: string) => number;

  const commit = async (
    localSeq: number,
    operations: unknown[],
  ): Promise<void> => {
    const response = await server.transact(
      {
        type: "transact",
        requestId: nextRequestId("write"),
        space: SPACE,
        sessionId: writerSession,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      } as Parameters<Server["transact"]>[0],
    );
    assert(response.ok !== undefined, JSON.stringify(response.error));
  };

  /** Sends the watch set through the harness's wire boundary, so the
   * parse of `holdings` is under test along with its handling. */
  const watchSet = async (
    harness: Harness,
    sessionId: string,
    holdings?: SessionHolding[],
  ): Promise<Sync> => {
    await harness.connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId,
      watches,
      ...(holdings !== undefined ? { holdings } : {}),
    }));
    const response = shiftMessage(harness.messages) as ResponseMessage<
      WatchSetResult
    >;
    assert(response.ok !== undefined, JSON.stringify(response.error));
    return response.ok.sync as unknown as Sync;
  };

  beforeAll(async () => {
    server = new Server({
      store: new URL("memory://session-holdings"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    const writer = await connect(server);
    writerSession = (await open(writer, WRITER)).sessionId;
    await commit(1, [
      { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
      {
        op: "set",
        id: "of:holdings-a",
        value: {
          value: { mention: linkWithSchemaRef("of:holdings-absent", leafHash) },
        },
      },
      { op: "set", id: "of:holdings-b", value: { value: { b: 1 } } },
    ]);
    // The baseline: a fresh session with no holdings receives the whole
    // union, closure included — and its seqs are what a holder declares.
    const baseline = await connect(server);
    const baselineSession = (await open(baseline, READER)).sessionId;
    fullUnion = await watchSet(baseline, baselineSession);
    seqOf = (id) => {
      const upsert = fullUnion.upserts.find((entry) => entry.id === id);
      assert(upsert !== undefined, `the union carries ${id}`);
      return upsert.seq;
    };
  });

  afterAll(async () => {
    await server.close();
  });

  it("delivers the whole union to a watch.set that declares nothing", () => {
    expect(ids(fullUnion.upserts)).toEqual(
      [...roots, `cid:${leafHash}`].toSorted(),
    );
    expect(fullUnion.removes).toEqual([]);
  });

  it("delivers only what a watch.set's declared holdings lack", async () => {
    // Holds `a` and the closure document at their current seqs, `b` at a
    // seq behind the union's, and a document the union never covered.
    const reader = await connect(server);
    const session = (await open(reader, READER)).sessionId;
    const sync = await watchSet(reader, session, [
      { id: "of:holdings-a", seq: seqOf("of:holdings-a") },
      { id: `cid:${leafHash}`, seq: seqOf(`cid:${leafHash}`) },
      { id: "of:holdings-b", seq: seqOf("of:holdings-b") - 1 },
      { id: "of:holdings-gone", seq: 1 },
    ]);
    expect(ids(sync.upserts)).toEqual(["of:holdings-b"]);
    expect(ids(sync.removes)).toEqual(["of:holdings-gone"]);
  });

  it("re-delivers on resume what the declared holdings do not claim", async () => {
    // A session that was delivered the whole union, then resumes claiming
    // everything but the closure document — the shape of a client that
    // quarantined or never absorbed it. The server's memory says the
    // session holds it; the client's statement wins.
    const first = await connect(server);
    const opened = await open(first, READER);
    const delivered = await watchSet(first, opened.sessionId);
    expect(ids(delivered.upserts)).toContain(`cid:${leafHash}`);
    const again = await connect(server);
    const resumed = await open(
      again,
      READER,
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      roots.map((id) => ({ id, seq: seqOf(id) })),
    );
    expect(resumed.resumed).toBe(true);
    assert(resumed.sync !== undefined, "a resumed catch-up frame");
    expect(ids((resumed.sync as unknown as Sync).upserts)).toEqual([
      `cid:${leafHash}`,
    ]);
  });

  it("elides everything on resume when the holdings match the union", async () => {
    const first = await connect(server);
    const opened = await open(first, READER);
    await watchSet(first, opened.sessionId);
    const again = await connect(server);
    const resumed = await open(
      again,
      READER,
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      [...roots, `cid:${leafHash}`].map((id) => ({ id, seq: seqOf(id) })),
    );
    expect(resumed.resumed).toBe(true);
    const sync = resumed.sync as unknown as Sync | undefined;
    expect(sync?.upserts ?? []).toEqual([]);
    expect(sync?.removes ?? []).toEqual([]);
  });

  it("keeps delivering a document whose only declared holding is on another branch", async () => {
    // The diff keys by branch: a same-id, same-seq claim on branch "b"
    // says nothing about the default-branch document, which is delivered.
    const reader = await connect(server);
    const session = (await open(reader, READER)).sessionId;
    const sync = await watchSet(reader, session, [
      { id: "of:holdings-a", branch: "b", seq: seqOf("of:holdings-a") },
      { id: "of:holdings-b", seq: seqOf("of:holdings-b") },
      { id: `cid:${leafHash}`, seq: seqOf(`cid:${leafHash}`) },
    ]);
    expect(ids(sync.upserts)).toEqual(["of:holdings-a"]);
  });

  it("fails a watch.set whose declared holdings do not parse", async () => {
    // A declaration the server cannot spell — here a non-string branch —
    // fails the whole message as unparseable rather than silently
    // degrading to full delivery.
    const reader = await connect(server);
    const session = (await open(reader, READER)).sessionId;
    await reader.connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: session,
      watches,
      holdings: [{ id: "of:holdings-a", branch: 7, seq: 3 }],
    } as never));
    const response = shiftMessage(reader.messages) as ResponseMessage<
      WatchSetResult
    >;
    expect(response.error?.name).toBe("InvalidMessageError");
  });

  it("fails a watch.set whose declared holdings are not a list", async () => {
    const reader = await connect(server);
    const session = (await open(reader, READER)).sessionId;
    await reader.connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: session,
      watches,
      holdings: { id: "of:holdings-a", seq: 3 },
    } as never));
    const response = shiftMessage(reader.messages) as ResponseMessage<
      WatchSetResult
    >;
    expect(response.error?.name).toBe("InvalidMessageError");
  });

  it("fails a session.open whose declared holdings do not parse", async () => {
    // The open-site parse refuses a malformed declaration the same way
    // the watch.set one does — here a negative seq.
    const reader = await connect(server);
    await reader.connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: nextRequestId("open"),
      space: SPACE,
      session: {},
      invocation: {
        iss: READER,
        aud: reader.sessionOpen.audience,
        challenge: reader.sessionOpen.challenge.value,
      },
      holdings: [{ id: "of:holdings-a", seq: -1 }],
    } as never));
    const response = shiftMessage(reader.messages) as ResponseMessage<
      SessionOpenResult
    >;
    expect(response.error?.name).toBe("InvalidMessageError");
  });

  it("re-delivers a live document declared as a tombstone, and retracts a scoped claim outside the union", async () => {
    // Deletedness is part of the snapshot the diff compares: a claim to
    // hold `b` as a tombstone at its current seq does not match the live
    // document, which is re-delivered. A scope-carrying claim names an
    // instance the union does not cover and is retracted.
    const reader = await connect(server);
    const session = (await open(reader, READER)).sessionId;
    const sync = await watchSet(reader, session, [
      { id: "of:holdings-a", seq: seqOf("of:holdings-a") },
      { id: `cid:${leafHash}`, seq: seqOf(`cid:${leafHash}`) },
      { id: "of:holdings-b", seq: seqOf("of:holdings-b"), deleted: true },
      { id: "of:holdings-scoped", scope: "user", seq: 4 },
    ]);
    expect(ids(sync.upserts)).toEqual(["of:holdings-b"]);
    expect(ids(sync.removes)).toEqual(["of:holdings-scoped"]);
  });

  it("retracts a declaration resumed onto a session with no watches", async () => {
    // Zero watches cover nothing: the declared holdings are removed and
    // nothing lingers as delivery memory or tracked demand — a following
    // watch.set that declares nothing is delivered in full.
    const first = await connect(server);
    const opened = await open(first, READER);
    const again = await connect(server);
    const resumed = await open(
      again,
      READER,
      { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
      roots.map((id) => ({ id, seq: seqOf(id) })),
    );
    expect(resumed.resumed).toBe(true);
    const sync = resumed.sync as unknown as Sync | undefined;
    expect(ids(sync?.removes ?? [])).toEqual(roots.toSorted());
    expect(sync?.upserts ?? []).toEqual([]);
    const full = await watchSet(again, opened.sessionId);
    expect(ids(full.upserts)).toEqual(
      [...roots, `cid:${leafHash}`].toSorted(),
    );
  });

  it("keeps the server's own memory as the base when a resume declares nothing", async () => {
    const first = await connect(server);
    const opened = await open(first, READER);
    await watchSet(first, opened.sessionId);
    const again = await connect(server);
    const resumed = await open(again, READER, {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    });
    expect(resumed.resumed).toBe(true);
    const sync = resumed.sync as unknown as Sync | undefined;
    expect(sync?.upserts ?? []).toEqual([]);
  });
});
