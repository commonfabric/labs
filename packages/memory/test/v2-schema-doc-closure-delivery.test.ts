/**
 * The read-side delivery guarantee for content-addressed schema
 * documents, pinned at the session frame: a document reaches a client
 * alongside the `cid:` closure its schema references name, and each
 * closure document reaches a session exactly once
 * (docs/specs/content-addressed-schemas.md; verification-coverage.md
 * OW61).
 *
 * The guarantee has two halves that pull against each other, and until
 * this file the memory package pinned neither — no memory test drove a
 * `cid:`-mentioning document through a session frame at all, so the
 * whole shipping side was reachable only through cross-package
 * integration lanes.
 *
 *   Shipping — `assembleSchemaDocClosures` (v2/query.ts) stages the
 *   closure of every delivered document into the same frame. A client
 *   validates arrivals against its own store and QUARANTINES a document
 *   whose refs it cannot resolve, so an under-delivered closure is
 *   silent data loss rather than a loud error.
 *
 *   Elision — a session that already holds a closure document does not
 *   receive it again. Not retransmitting schemas is why content
 *   addressing exists, so the elision is correct by design and a
 *   per-frame resend is a regression, not a safety margin.
 *
 * Every watch below uses the SELECTS-NOTHING selector (`schema: false`)
 * — the space-cell-only subscriber shape OW61 names as the trigger.
 * That shape's walk never descends through a link, so it never
 * incidentally loads the schema documents the delivered value mentions,
 * and the closure pass is the only route by which they can arrive. Under
 * a walking selector the traversal loads them anyway and every
 * assertion here passes with the closure pass entirely disabled.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import type { JSONSchema } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
import {
  collectExternalSchemaRefHashes,
  collectSchemaMetaRefHashes,
} from "@commonfabric/data-model-schema/schema-refs";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { mapLinkSchemas } from "../v2/schema-table-links.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type WatchAddResult,
  type WatchSetResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-closure-delivery-audience";
const SPACE = "did:key:z6Mk-closure-delivery-space";
const WRITER = "did:key:z6Mk-closure-delivery-writer";
const READER = "did:key:z6Mk-closure-delivery-reader";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

// `root` references `leaf`, so a pass that staged mentioned documents
// without following their own refs stops one document short of the
// closure. `mentioned` and `added` are disjoint leaves, each first named
// by one later leg.
const leafSchema = { type: "string", title: "closure-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const rootSchema = {
  type: "object",
  properties: { x: { $ref: `cid:${leafHash}` } },
} as const;
const rootHash = internSchemaAsTaggedHashString(rootSchema);
const mentionedSchema = { type: "number", title: "closure-mentioned" } as const;
const mentionedHash = internSchemaAsTaggedHashString(mentionedSchema);
const addedSchema = { type: "boolean", title: "closure-added" } as const;
const addedHash = internSchemaAsTaggedHashString(addedSchema);

/** A link whose schema position carries `$ref: cid:<hash>`. */
const linkWithSchemaRef = (id: string, hash: string) => ({
  "/": { "link@1": { id, path: [], schema: { $ref: `cid:${hash}` } } },
});

type Upsert = { id: string; doc?: unknown; deleted?: boolean };

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
  assert(response.ok !== undefined, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return response.ok.sessionId;
};

/**
 * The `cid:` hashes a frame's documents OBLIGE, computed exactly as the
 * arriving replica computes them (`SpaceReplica`'s arrival validator in
 * runner/src/storage/v2.ts): the link-schema positions and the `schema`
 * metadata member of an ordinary document, and a schema document's own
 * external refs. Keyed by hash, valued by one document that named it —
 * enough to say who quarantines.
 */
const obligedHashes = (upserts: readonly Upsert[]): Map<string, string> => {
  const obliged = new Map<string, string>();
  for (const upsert of upserts) {
    const doc = upsert.doc;
    if (upsert.deleted === true || !isObjectNotArray(doc)) continue;
    const inner = (doc as { value?: unknown }).value;
    if (upsert.id.startsWith("cid:")) {
      const hash = upsert.id.slice("cid:".length);
      if (
        isSubschema(inner) &&
        internSchemaAsTaggedHashString(inner as JSONSchema) === hash
      ) {
        for (const dep of collectExternalSchemaRefHashes(inner as JSONSchema)) {
          obliged.set(dep, upsert.id);
        }
        continue;
      }
    }
    mapLinkSchemas(doc as never, (schema) => {
      for (const dep of collectExternalSchemaRefHashes(schema as JSONSchema)) {
        obliged.set(dep, upsert.id);
      }
      return schema;
    });
    for (const dep of collectSchemaMetaRefHashes(doc)) {
      obliged.set(dep, upsert.id);
    }
  }
  return obliged;
};

/** The `cid:` document ids a frame carries, sorted. */
const carriedCids = (upserts: readonly Upsert[]): string[] =>
  upserts.filter((upsert) => upsert.id.startsWith("cid:"))
    .map((upsert) => upsert.id).toSorted();

/**
 * One session's accumulating replica: the closure documents it has been
 * sent, and the obligations it could not meet when a frame arrived.
 */
class DeliveryLedger {
  readonly held = new Set<string>();
  readonly unmet: string[] = [];

  /** Applies one frame in arrival order, recording what it could not resolve. */
  apply(upserts: readonly Upsert[]): readonly Upsert[] {
    for (const id of carriedCids(upserts)) {
      this.held.add(id.slice("cid:".length));
    }
    for (const [hash, referrer] of obligedHashes(upserts)) {
      if (this.held.has(hash)) continue;
      this.unmet.push(`${referrer} names cid:${hash}`);
    }
    return upserts;
  }
}

/** Every `session/effect` frame's upserts at or past `from`, in order. */
const effectFrames = (
  messages: readonly ServerMessage[],
  from: number,
): Upsert[][] => {
  const frames: Upsert[][] = [];
  for (const message of messages.slice(from)) {
    if ((message as { type?: string }).type !== "session/effect") continue;
    const effect = (message as { effect?: { upserts?: Upsert[] } }).effect;
    if (effect?.upserts !== undefined) frames.push(effect.upserts);
  }
  return frames;
};

/** The watch spec every leg uses: one root, selecting nothing. */
const watchOn = (id: string, watchId: string) => ({
  id: watchId,
  kind: "graph" as const,
  query: {
    roots: [{ id, selector: { path: [], schema: false as const } }],
  },
});

describe("schema document closure delivery", () => {
  let server: Server;
  let reader: DeliveryLedger;
  let watchSetUpserts: readonly Upsert[];
  let elisionFrames: Upsert[][];
  let newRefFrames: Upsert[][];
  let watchAddUpserts: readonly Upsert[];
  let secondSession: DeliveryLedger;
  let secondSessionUpserts: readonly Upsert[];

  beforeAll(async () => {
    server = new Server({
      store: new URL("memory://closure-delivery"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    const writer = await connect(server);
    const writerSession = await openSession(writer, WRITER);
    const readerOne = await connect(server);
    const readerOneSession = await openSession(readerOne, READER);

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

    /** Rewrites the watched document to mention `hash`. */
    const mentionFrom = (revision: number, hash: string) => ({
      op: "set",
      id: "of:closure-watched",
      value: {
        value: {
          revision,
          mention: linkWithSchemaRef("of:closure-absent", hash),
        },
      },
    });

    await commit(1, [
      { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
      { op: "set", id: `cid:${rootHash}`, value: { value: rootSchema } },
      {
        op: "set",
        id: `cid:${mentionedHash}`,
        value: { value: mentionedSchema },
      },
      { op: "set", id: `cid:${addedHash}`, value: { value: addedSchema } },
      mentionFrom(1, rootHash),
      {
        op: "set",
        id: "of:closure-extended",
        value: {
          value: { mention: linkWithSchemaRef("of:closure-absent", addedHash) },
        },
      },
    ]);

    reader = new DeliveryLedger();

    // Leg 1 — watch.set, the initial full evaluation (`trackGraph`).
    const watchSet = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: readerOneSession,
      watches: [watchOn("of:closure-watched", "w-closure")],
    }) as ResponseMessage<WatchSetResult>;
    assert(watchSet.ok !== undefined, JSON.stringify(watchSet.error));
    watchSetUpserts = reader.apply(watchSet.ok.sync.upserts as Upsert[]);

    // Leg 2 — a push (`refreshTrackedGraph`) re-delivering the watched
    // document with the SAME mention.
    const elisionFrom = readerOne.messages.length;
    await commit(2, [mentionFrom(2, rootHash)]);
    await drainUntil(
      server,
      () => hasDoc(effectFrames(readerOne.messages, elisionFrom)),
      "the same-reference rewrite reaching the reader",
    );
    elisionFrames = effectFrames(readerOne.messages, elisionFrom);
    for (const frame of elisionFrames) reader.apply(frame);

    // Leg 3 — the same push path delivering a mention of a schema this
    // session has never been sent.
    const newRefFrom = readerOne.messages.length;
    await commit(3, [mentionFrom(3, mentionedHash)]);
    await drainUntil(
      server,
      () => hasDoc(effectFrames(readerOne.messages, newRefFrom)),
      "the changed-reference rewrite reaching the reader",
    );
    newRefFrames = effectFrames(readerOne.messages, newRefFrom);
    for (const frame of newRefFrames) reader.apply(frame);

    // Leg 4 — watch.add on the live session (`extendTrackedGraph`).
    const watchAdd = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: readerOneSession,
      watches: [
        watchOn("of:closure-watched", "w-closure"),
        watchOn("of:closure-extended", "w-closure-extended"),
      ],
    }) as ResponseMessage<WatchAddResult>;
    assert(watchAdd.ok !== undefined, JSON.stringify(watchAdd.error));
    watchAddUpserts = reader.apply(watchAdd.ok.sync.upserts as Upsert[]);

    // Leg 5 — a second session of the same space, holding nothing.
    const readerTwo = await connect(server);
    const readerTwoSession = await openSession(readerTwo, READER);
    const secondWatch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: readerTwoSession,
      watches: [watchOn("of:closure-watched", "w-closure")],
    }) as ResponseMessage<WatchSetResult>;
    assert(secondWatch.ok !== undefined, JSON.stringify(secondWatch.error));
    secondSession = new DeliveryLedger();
    secondSessionUpserts = secondSession.apply(
      secondWatch.ok.sync.upserts as Upsert[],
    );

    writer.connection.close();
    readerOne.connection.close();
    readerTwo.connection.close();
  });

  afterAll(async () => {
    await server.close();
  });

  it("ships the schema a delivered document mentions, in the frame that delivers it", () => {
    expect(carriedCids(watchSetUpserts)).toContain(`cid:${rootHash}`);
  });

  it("ships a schema document reachable only through another schema document", () => {
    expect(carriedCids(watchSetUpserts)).toEqual(
      [`cid:${leafHash}`, `cid:${rootHash}`].toSorted(),
    );
  });

  it("ships no schema document on a push to a session that already holds the closure", () => {
    expect(elisionFrames.map(carriedCids)).toEqual(elisionFrames.map(() => []));
  });

  it("ships a schema the first time a push delivers a document mentioning it", () => {
    expect(newRefFrames.flatMap(carriedCids)).toEqual([
      `cid:${mentionedHash}`,
    ]);
  });

  it("ships a newly mentioned schema when a watch is added to a live session", () => {
    expect(carriedCids(watchAddUpserts)).toEqual([`cid:${addedHash}`]);
  });

  it("ships the whole closure to a second session of the same space", () => {
    expect(carriedCids(secondSessionUpserts)).toEqual([
      `cid:${mentionedHash}`,
    ]);
  });

  it("leaves every delivered document's schema refs resolvable in each receiving session", () => {
    // The whole guarantee, stated over the arrival order both sessions
    // actually saw: an unmet entry is a document the receiving replica
    // quarantines (verification-coverage.md OW61).
    expect({ reader: reader.unmet, second: secondSession.unmet }).toEqual({
      reader: [],
      second: [],
    });
  });
});

const BLOB = { bytes: "closure-blob" } as const;
const BLOB_ID = `cid:${taggedHashStringOf(BLOB)}`;

describe("schema document closure delivery for `schema` metadata", () => {
  // A result document's `schema` metadata member is a schema position in
  // the link spelling, and assembly ships its closure the same way: the
  // reference-bearing document arrives with the documents it names, in
  // the frame that delivers it, and a ref-only root schema whose closure
  // runs through another document is followed to the end.
  let server: Server;
  let ledger: DeliveryLedger;
  let upserts: readonly Upsert[];

  beforeAll(async () => {
    server = new Server({
      store: new URL("memory://closure-delivery-schema-meta"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    const writer = await connect(server);
    const writerSession = await openSession(writer, WRITER);
    const response = await server.transact(
      {
        type: "transact",
        requestId: nextRequestId("write"),
        space: SPACE,
        sessionId: writerSession,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
            { op: "set", id: `cid:${rootHash}`, value: { value: rootSchema } },
            {
              op: "set",
              id: "of:result-with-schema-meta",
              value: {
                value: { x: "described" },
                schema: { $ref: `cid:${rootHash}` },
              },
            },
            // A content-addressed carrier: its identity hashes `.value`
            // alone, and its `schema` member is shipped like any other's.
            {
              op: "set",
              id: `cid:${mentionedHash}`,
              value: { value: mentionedSchema },
            },
            {
              op: "set",
              id: BLOB_ID,
              value: { value: BLOB, schema: { $ref: `cid:${mentionedHash}` } },
            },
          ],
        },
      } as Parameters<Server["transact"]>[0],
    );
    assert(response.ok !== undefined, JSON.stringify(response.error));

    const reader = await connect(server);
    const readerSession = await openSession(reader, READER);
    const watchSet = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("watch"),
      space: SPACE,
      sessionId: readerSession,
      watches: [
        watchOn("of:result-with-schema-meta", "w-schema-meta"),
        watchOn(BLOB_ID, "w-blob-schema-meta"),
      ],
    }) as ResponseMessage<WatchSetResult>;
    assert(watchSet.ok !== undefined, JSON.stringify(watchSet.error));
    ledger = new DeliveryLedger();
    upserts = ledger.apply(watchSet.ok.sync.upserts as Upsert[]);

    writer.connection.close();
    reader.connection.close();
  });

  afterAll(async () => {
    await server.close();
  });

  it("ships the closure a delivered document's `schema` metadata references, in the frame that delivers it", () => {
    expect(carriedCids(upserts)).toEqual(
      [`cid:${leafHash}`, `cid:${rootHash}`, `cid:${mentionedHash}`, BLOB_ID]
        .toSorted(),
    );
  });

  it("leaves the delivered document's `schema` reference resolvable in the receiving session", () => {
    expect(ledger.unmet).toEqual([]);
  });
});

/** Whether any frame carries the watched document. */
function hasDoc(frames: readonly Upsert[][]): boolean {
  return frames.some((frame) =>
    frame.some((upsert) => upsert.id === "of:closure-watched")
  );
}

/**
 * Drains pending refresh passes until `done`, iteration-bounded, and
 * THROWS naming `awaited` when the passes run out first. Returning
 * quietly on exhaustion would let a dropped push frame reach the
 * assertions as an empty frame list, which several of them cannot
 * distinguish from a frame that carried nothing — the vacuous green this
 * file exists to make impossible.
 */
async function drainUntil(
  server: Server,
  done: () => boolean,
  awaited: string,
): Promise<void> {
  for (let pass = 0; pass < 50; pass++) {
    if (done()) return;
    await server.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(
    `drained 50 refresh passes without ${awaited}; the push never arrived`,
  );
}
