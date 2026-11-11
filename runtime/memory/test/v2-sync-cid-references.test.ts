import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";

import { acquireSchemaRegistryLease } from "../../runner/src/schema-registry.ts";
import {
  connect,
  connectionError,
  loopback,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  hasServerMessageCidReferences,
  namesPrincipal,
  referenceServerMessageSchemaDocuments,
  resolveServerMessageCidReferences,
  type SchemaDocumentLookup,
} from "../v2/sync-cid-references.ts";
import {
  encodeMemoryBoundary,
  type EntitySnapshot,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type WatchSetResult,
} from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const leafSchema = {
  type: "string",
  title: "sync-cid-references-leaf",
} as const;
const leafHash = internSchema(leafSchema, true).taggedHashString;
const outerSchema = {
  type: "object",
  properties: { x: { $ref: `cid:${leafHash}` } },
} as const;
const outerHash = internSchema(outerSchema, true).taggedHashString;

/** A schema bound to its principal, as a creator binding writes one. */
const boundSchema = {
  type: "string",
  title: "sync-cid-references-bound",
  ifc: {
    confidentiality: [{
      type: "User",
      subject: "did:key:z6MkhSyncCidReferencesBoundPrincipal",
    }],
  },
} as const;
const boundHash = internSchema(boundSchema, true).taggedHashString;

/** A schema whose principal placeholder is not yet bound. */
const placeholderSchema = {
  type: "string",
  title: "sync-cid-references-placeholder",
  ifc: {
    confidentiality: [{
      type: "User",
      subject: { __ctCurrentPrincipal: true },
    }],
  },
} as const;
const placeholderHash = internSchema(placeholderSchema, true)
  .taggedHashString;

/** A lookup holding exactly the schemas above. */
const lookup: SchemaDocumentLookup = (hash) =>
  hash === leafHash
    ? leafSchema as JSONSchema
    : hash === outerHash
    ? outerSchema as JSONSchema
    : hash === boundHash
    ? boundSchema as unknown as JSONSchema
    : hash === placeholderHash
    ? placeholderSchema as unknown as JSONSchema
    : undefined;

/** A response carrying a sync of `upserts`. */
const responseWith = (upserts: SessionSync["upserts"]): ServerMessage => ({
  type: "response",
  requestId: "req:1",
  ok: {
    serverSeq: 9,
    sync: { type: "sync", fromSeq: 0, toSeq: 9, upserts, removes: [] },
  },
} as ServerMessage);

/** The upserts of the sync `message` carries. */
const upsertsOf = (message: unknown): SessionSync["upserts"] => {
  const outer = message as Record<string, unknown>;
  const sync = outer.type === "session/effect"
    ? outer.effect
    : (outer.ok as Record<string, unknown>).sync;
  return (sync as SessionSync).upserts;
};

const leafUpsert = {
  branch: "",
  id: `cid:${leafHash}`,
  seq: 3,
  doc: { value: leafSchema },
};
const leafReference = {
  branch: "",
  id: `cid:${leafHash}`,
  seq: 3,
  byReference: true as const,
};
const carrierUpsert = {
  branch: "",
  id: "of:sync-cid-references-carrier",
  seq: 4,
  doc: { value: { name: "carrier" } },
};

/** A link to a target whose schema references `hash`. */
const linkWithSchemaRef = (hash: string) => ({
  "/": {
    "link@1": {
      id: "of:sync-cid-references-target",
      path: [],
      schema: { $ref: `cid:${hash}` },
    },
  },
});

/** The commit that installs both schema documents and a carrier of `outer`. */
const closureOperations = (carrier: string) => [
  { op: "set" as const, id: `cid:${leafHash}`, value: { value: leafSchema } },
  { op: "set" as const, id: `cid:${outerHash}`, value: { value: outerSchema } },
  {
    op: "set" as const,
    id: carrier,
    value: { value: { x: linkWithSchemaRef(outerHash) } },
  },
];

/**
 * A loopback transport to `server` that counts the `graph.query` requests a
 * client sends and the payloads it receives naming a document by
 * reference, and calls `onReference` on each of the latter before the
 * client sees it. With `queryAnswers`, an answer to a query reaches the
 * client only once that promise settles.
 */
const countingTransport = (
  server: Server,
  onReference: () => void = () => {},
  queryAnswers?: Promise<void>,
) => {
  const counts = { queries: 0, references: 0 };
  const inner = loopback(server);
  const transport: Transport = {
    ...inner,
    send: (payload: string) => {
      if (payload.includes('"graph.query"')) counts.queries++;
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver(receiver: (payload: string) => void) {
      inner.setReceiver((payload: string) => {
        if (payload.includes('"byReference":true')) {
          counts.references++;
          onReference();
        }
        if (queryAnswers !== undefined && payload.includes('"entities"')) {
          void queryAnswers.then(() => receiver(payload));
        } else {
          receiver(payload);
        }
      });
    },
  };
  return { counts, transport };
};

/** The document `view` holds under `id`. */
const documentIn = (view: { entities: EntitySnapshot[] }, id: string) =>
  view.entities.find((entity) => entity.id === id)?.document;

/** The `cid:` upserts in `upserts` that carry their bodies. */
const bodiesOf = (upserts: SessionSync["upserts"]) =>
  upserts.filter((upsert) =>
    upsert.id.startsWith("cid:") && upsert.doc !== undefined &&
    upsert.byReference === undefined
  );

/**
 * Opens a session on a fresh server through a raw connection whose hello
 * carries `flags`, installs the closure and a carrier of it, and returns the
 * upserts of the watch set over the carrier.
 */
const watchRaw = async (
  name: string,
  flags: Record<string, unknown>,
): Promise<SessionSync["upserts"]> => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://sync-cid-references-${name}`),
    subscriptionRefreshDelayMs: 0,
  });
  const space = `did:key:z6Mk-sync-cid-references-${name}`;
  const carrier = `of:sync-cid-references-${name}`;
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  const send = async (request: Record<string, unknown>) => {
    messages.length = 0;
    await connection.receive(encodeMemoryBoundary(request as never));
    return messages.find((message) =>
      message.type === "response" &&
      (message as ResponseMessage<unknown>).requestId === request.requestId
    ) as ResponseMessage<Record<string, unknown>>;
  };
  try {
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags,
    } as never));
    const sessionOpen = (messages.shift() as HelloOkMessage)
      .sessionOpen as SessionOpenAuthMetadata;
    const opened = await send({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        aud: sessionOpen.audience,
        challenge: sessionOpen.challenge.value,
      },
    });
    const sessionId = opened.ok!.sessionId;
    await send({
      type: "transact",
      requestId: "write",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: closureOperations(carrier),
      },
    });
    const watched = await send({
      type: "session.watch.set",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "carrier",
        kind: "graph",
        query: {
          roots: [{ id: carrier, selector: { path: [], schema: false } }],
        },
      }],
    });
    return (watched.ok as unknown as WatchSetResult).sync.upserts;
  } finally {
    connection.close();
    await server.close();
  }
};

/**
 * Installs the closure and a carrier of it in a space of `server`, watches
 * the carrier from a client that opts in to references when `optedIn` and
 * leaves the option unset otherwise, and
 * returns how many references and `graph.query` requests crossed, and how
 * many schema documents the client's view holds with their bodies.
 */
const watchThrough = async (
  name: string,
  server: Server,
  optedIn: boolean,
): Promise<{ references: number; queries: number; bodies: number }> => {
  const { counts, transport } = countingTransport(server);
  const writerClient = await connect({ transport: loopback(server) });
  const watcherClient = await connect(
    optedIn ? { transport, syncCidReferences: true } : { transport },
  );
  const space = `did:key:z6Mk-sync-cid-references-${name}`;
  const carrier = `of:sync-cid-references-${name}`;
  try {
    const writer = await writerClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: closureOperations(carrier),
    });
    const watcher = await watcherClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    const view = await watcher.watchSet([{
      id: "carrier",
      kind: "graph",
      query: {
        roots: [{ id: carrier, selector: { path: [], schema: false } }],
      },
    }]);
    const bodies = [
      documentIn(view, `cid:${outerHash}`),
      documentIn(view, `cid:${leafHash}`),
    ].filter((document) => document !== undefined && document !== null);
    return { ...counts, bodies: bodies.length };
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
};

describe("sync-cid-references", () => {
  describe("referenceServerMessageSchemaDocuments()", () => {
    it("names a schema document the lookup holds by id and seq alone", () => {
      const message = referenceServerMessageSchemaDocuments(
        responseWith([leafUpsert, carrierUpsert]),
        lookup,
      );
      expect(upsertsOf(message)).toStrictEqual([leafReference, carrierUpsert]);
    });

    it("rewrites an effect's sync as a response's is", () => {
      const effect = {
        type: "session/effect",
        space: "did:key:z6Mk-sync-cid-references",
        sessionId: "session-1",
        effect: {
          type: "sync",
          fromSeq: 0,
          toSeq: 9,
          upserts: [leafUpsert],
          removes: [],
        },
      } as ServerMessage;
      expect(
        upsertsOf(referenceServerMessageSchemaDocuments(effect, lookup)),
      ).toStrictEqual([leafReference]);
    });

    it("keeps the body of a document the lookup does not hold", () => {
      const message = responseWith([leafUpsert]);
      expect(referenceServerMessageSchemaDocuments(message, () => undefined))
        .toBe(message);
    });

    it("keeps the body of a document holding a member beside `value`", () => {
      const message = responseWith([{
        ...leafUpsert,
        doc: { value: leafSchema, schema: true },
      }]);
      expect(referenceServerMessageSchemaDocuments(message, lookup)).toBe(
        message,
      );
    });

    it("keeps the body of a value that is not the schema its id names", () => {
      const message = responseWith([{
        ...leafUpsert,
        doc: { value: { type: "number" } },
      }]);
      expect(referenceServerMessageSchemaDocuments(message, lookup)).toBe(
        message,
      );
    });

    it("keeps the body of a schema that names a principal", () => {
      const message = responseWith([{
        branch: "",
        id: `cid:${boundHash}`,
        seq: 6,
        doc: { value: boundSchema },
      }]);
      expect(referenceServerMessageSchemaDocuments(message, lookup)).toBe(
        message,
      );
    });

    it("names a schema whose principal placeholder is unbound by reference", () => {
      const message = referenceServerMessageSchemaDocuments(
        responseWith([{
          branch: "",
          id: `cid:${placeholderHash}`,
          seq: 7,
          doc: { value: placeholderSchema },
        }]),
        lookup,
      );
      expect(upsertsOf(message)).toStrictEqual([{
        branch: "",
        id: `cid:${placeholderHash}`,
        seq: 7,
        byReference: true,
      }]);
    });

    it("keeps a `cid:` upsert that carries no document as it is", () => {
      const message = responseWith([{
        branch: "",
        id: `cid:${leafHash}`,
        seq: 3,
      }]);
      expect(referenceServerMessageSchemaDocuments(message, lookup)).toBe(
        message,
      );
    });

    it("keeps deleted and non-`cid:` upserts as they are", () => {
      const message = responseWith([
        { branch: "", id: `cid:${leafHash}`, seq: 5, deleted: true },
        { ...carrierUpsert, id: `of:${leafHash}`, doc: { value: leafSchema } },
      ]);
      expect(referenceServerMessageSchemaDocuments(message, lookup)).toBe(
        message,
      );
    });
  });

  describe("namesPrincipal()", () => {
    it("returns `true` for a schema holding a DID and `false` for one holding a placeholder", () => {
      expect(namesPrincipal(boundSchema as unknown as JSONSchema)).toBe(true);
      expect(namesPrincipal(placeholderSchema as unknown as JSONSchema)).toBe(
        false,
      );
    });

    it("returns `false` for a boolean schema", () => {
      expect(namesPrincipal(true)).toBe(false);
    });
  });

  describe("hasServerMessageCidReferences()", () => {
    it("returns `true` only for a sync naming a document by reference", () => {
      expect(hasServerMessageCidReferences(responseWith([leafReference])))
        .toBe(true);
      expect(hasServerMessageCidReferences(responseWith([leafUpsert])))
        .toBe(false);
      expect(hasServerMessageCidReferences({ type: "response" })).toBe(false);
    });
  });

  describe("resolveServerMessageCidReferences()", () => {
    it("replaces each reference with its registered schema as `value`", () => {
      const resolved = resolveServerMessageCidReferences(
        responseWith([leafReference, carrierUpsert]),
        lookup,
      );
      expect(resolved.missing).toStrictEqual([]);
      expect(upsertsOf(resolved.message)).toStrictEqual([
        leafUpsert,
        carrierUpsert,
      ]);
    });

    it("returns the message as received and every hash that misses", () => {
      const message = responseWith([leafReference, carrierUpsert]);
      const resolved = resolveServerMessageCidReferences(
        message,
        () => undefined,
      );
      expect(resolved.missing).toStrictEqual([leafHash]);
      expect(resolved.message).toBe(message);
    });

    it("drops a reference whose hash could not be fetched", () => {
      const resolved = resolveServerMessageCidReferences(
        responseWith([leafReference, carrierUpsert]),
        () => undefined,
        new Set([leafHash]),
      );
      expect(resolved.missing).toStrictEqual([]);
      expect(upsertsOf(resolved.message)).toStrictEqual([carrierUpsert]);
    });

    it("returns a held schema that names a principal as missing until its own space returned it", () => {
      const message = responseWith([{
        branch: "",
        id: `cid:${boundHash}`,
        seq: 6,
        byReference: true,
      }]);
      expect(resolveServerMessageCidReferences(message, lookup).missing)
        .toStrictEqual([boundHash]);
      const resolved = resolveServerMessageCidReferences(
        message,
        lookup,
        new Set(),
        new Set([boundHash]),
      );
      expect(resolved.missing).toStrictEqual([]);
      expect(upsertsOf(resolved.message)).toStrictEqual([{
        branch: "",
        id: `cid:${boundHash}`,
        seq: 6,
        doc: { value: boundSchema },
      }]);
    });

    it("throws on a reference that carries a body", () => {
      expect(() =>
        resolveServerMessageCidReferences(
          responseWith([{ ...leafReference, doc: { value: leafSchema } }]),
          lookup,
        )
      ).toThrow(TypeError);
    });
  });

  describe("over a connection with both sides on", () => {
    it("names a schema document by reference and the client applies its body", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-hit"),
        subscriptionRefreshDelayMs: 0,
      });
      const { counts, transport } = countingTransport(server);
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const space = "did:key:z6Mk-sync-cid-references-hit";
      const carrier = "of:sync-cid-references-hit";
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const view = await watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]);
        expect(counts.references).toBeGreaterThan(0);
        expect(counts.queries).toBe(0);
        expect(documentIn(view, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
        expect(documentIn(view, `cid:${leafHash}`)).toEqual({
          value: leafSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("fetches a body its registry lacks once for every space naming it", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-fetch"),
        subscriptionRefreshDelayMs: 0,
      });
      // The client shares this realm's registry with the server, so each
      // reference it receives empties the registry first, as a client in a
      // realm of its own would hold nothing yet. The fetch's answer waits
      // for both spaces' frames, so the second finds the first's fetch in
      // flight.
      const bothFramesArrived = Promise.withResolvers<void>();
      const { counts, transport } = countingTransport(
        server,
        () => {
          acquireSchemaRegistryLease()();
          if (counts.references === 2) bothFramesArrived.resolve();
        },
        bothFramesArrived.promise,
      );
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const spaces = [
        "did:key:z6Mk-sync-cid-references-fetch-a",
        "did:key:z6Mk-sync-cid-references-fetch-b",
      ];
      const carrier = "of:sync-cid-references-fetch";
      try {
        for (const space of spaces) {
          const writer = await writerClient.mount(
            space,
            {},
            testSessionOpenAuthFactory,
          );
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: closureOperations(carrier),
          });
        }
        const watchers = await Promise.all(
          spaces.map((space) =>
            watcherClient.mount(space, {}, testSessionOpenAuthFactory)
          ),
        );
        const views = await Promise.all(
          watchers.map((watcher) =>
            watcher.watchSet([{
              id: "carrier",
              kind: "graph",
              query: {
                roots: [{ id: carrier, selector: { path: [], schema: false } }],
              },
            }])
          ),
        );
        expect(counts.references).toBe(2);
        expect(counts.queries).toBe(1);
        for (const view of views) {
          expect(documentIn(view, `cid:${outerHash}`)).toEqual({
            value: outerSchema,
          });
          expect(documentIn(view, `cid:${leafHash}`)).toEqual({
            value: leafSchema,
          });
        }
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("resolves `delivered()` only once a sync held for a body is handed on", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-delivered"),
        subscriptionRefreshDelayMs: 0,
      });
      const referenced = Promise.withResolvers<void>();
      const answers = Promise.withResolvers<void>();
      const { transport } = countingTransport(
        server,
        () => {
          acquireSchemaRegistryLease()();
          referenced.resolve();
        },
        answers.promise,
      );
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const space = "did:key:z6Mk-sync-cid-references-delivered";
      const carrier = "of:sync-cid-references-delivered";
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const watching = watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]);
        await referenced.promise;
        // The fetch's answer is let through once the transport has handed
        // over everything else, so a barrier that waited for the transport
        // alone would resolve with the watch's answer still held.
        let pendingAtDelivered: number | undefined;
        const delivered = watcherClient.delivered().then(() => {
          pendingAtDelivered = watcherClient.pendingRequestCount;
        });
        await transport.delivered!();
        answers.resolve();
        await delivered;
        await watching;
        expect(pendingAtDelivered).toBe(0);
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("sends a schema that names a principal with its body", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-bound"),
        subscriptionRefreshDelayMs: 0,
      });
      const { counts, transport } = countingTransport(server);
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const space = "did:key:z6Mk-sync-cid-references-bound";
      const carrier = "of:sync-cid-references-bound";
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: `cid:${boundHash}`,
              value: { value: boundSchema },
            },
            {
              op: "set",
              id: carrier,
              value: { value: { x: linkWithSchemaRef(boundHash) } },
            },
          ],
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const view = await watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]);
        expect(counts.references).toBe(0);
        expect(documentIn(view, `cid:${boundHash}`)).toEqual({
          value: boundSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("hands on a session's later syncs after its held one, in order", async () => {
      // A write lands while the watch's answer waits for a body. The effect
      // carrying it is held behind that answer, and both apply once the
      // body arrives, the write last.
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-queued"),
        subscriptionRefreshDelayMs: 0,
      });
      const referenced = Promise.withResolvers<void>();
      const effected = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inner = loopback(server);
      const transport: Transport = {
        ...inner,
        send: (payload: string) => inner.send(payload),
        close: () => inner.close(),
        setReceiver(receiver: (payload: string) => void) {
          inner.setReceiver((payload: string) => {
            if (payload.includes('"byReference":true')) {
              acquireSchemaRegistryLease()();
              referenced.resolve();
            }
            if (payload.includes('"session/effect"')) effected.resolve();
            if (payload.includes('"entities"')) {
              void release.promise.then(() => receiver(payload));
            } else {
              receiver(payload);
            }
          });
        },
      };
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const space = "did:key:z6Mk-sync-cid-references-queued";
      const carrier = "of:sync-cid-references-queued";
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const watching = watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]);
        await referenced.promise;
        // The write names a schema of its own, so its effect needs a body
        // too, which the hold fetches when it reaches it.
        await writer.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: `cid:${placeholderHash}`,
              value: { value: placeholderSchema },
            },
            {
              op: "set",
              id: carrier,
              value: {
                value: {
                  x: linkWithSchemaRef(outerHash),
                  y: linkWithSchemaRef(placeholderHash),
                },
              },
            },
          ],
        });
        await effected.promise;
        release.resolve();
        await watching;
        await watcherClient.delivered(watcher);
        const view = (await watcher.watchAddSync([])).view;
        expect(documentIn(view, carrier)?.value).toEqual({
          x: linkWithSchemaRef(outerHash),
          y: linkWithSchemaRef(placeholderHash),
        });
        expect(documentIn(view, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
        expect(documentIn(view, `cid:${placeholderHash}`)).toEqual({
          value: placeholderSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("ends a sync's wait for a body when the client closes", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-closed"),
        subscriptionRefreshDelayMs: 0,
      });
      const referenced = Promise.withResolvers<void>();
      const inner = loopback(server);
      const transport: Transport = {
        ...inner,
        send: (payload: string) => inner.send(payload),
        close: () => inner.close(),
        setReceiver(receiver: (payload: string) => void) {
          inner.setReceiver((payload: string) => {
            if (payload.includes('"byReference":true')) {
              acquireSchemaRegistryLease()();
              referenced.resolve();
            }
            // The body fetch is never answered.
            if (!payload.includes('"entities"')) receiver(payload);
          });
        },
      };
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const space = "did:key:z6Mk-sync-cid-references-closed";
      const carrier = "of:sync-cid-references-closed";
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        let failure: unknown;
        const watching = watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]).catch((error) => {
          failure = error;
        });
        await referenced.promise;
        await watcherClient.close();
        await watching;
        await watcherClient.delivered();
        expect((failure as Error | undefined)?.message).toBe(
          "memory client closed",
        );
      } finally {
        await writerClient.close();
        await server.close();
      }
    });

    it("fetches a body again from its own space when the fetch it shared returns none", async () => {
      // Two spaces' frames name the same bodies on one direct connection.
      // The first space's fetch comes back empty, after the second's frame
      // has begun to wait on it, so the second asks its own space.
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-shared-empty"),
        subscriptionRefreshDelayMs: 0,
      });
      let references = 0;
      let answers = 0;
      let queries = 0;
      const bothFramesArrived = Promise.withResolvers<void>();
      const inner = loopback(server);
      const transport: Transport = {
        ...inner,
        send: (payload: string) => {
          if (payload.includes('"graph.query"')) queries++;
          return inner.send(payload);
        },
        close: () => inner.close(),
        setReceiver(receiver: (payload: string) => void) {
          inner.setReceiver((payload: string) => {
            if (payload.includes('"byReference":true')) {
              acquireSchemaRegistryLease()();
              if (++references === 2) bothFramesArrived.resolve();
            }
            if (payload.includes('"entities"') && answers++ === 0) {
              // The first fetch's answer, emptied, once both frames wait.
              const message = JSON.parse(payload.slice("fvj1:".length));
              message.ok.entities = [];
              const emptied = `fvj1:${JSON.stringify(message)}`;
              void bothFramesArrived.promise.then(() => receiver(emptied));
            } else {
              receiver(payload);
            }
          });
        },
      };
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const spaces = [
        "did:key:z6Mk-sync-cid-references-shared-empty-a",
        "did:key:z6Mk-sync-cid-references-shared-empty-b",
      ];
      const carrier = "of:sync-cid-references-shared-empty";
      try {
        for (const space of spaces) {
          const writer = await writerClient.mount(
            space,
            {},
            testSessionOpenAuthFactory,
          );
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: closureOperations(carrier),
          });
        }
        const [a, b] = await Promise.all(
          spaces.map((space) =>
            watcherClient.mount(space, {}, testSessionOpenAuthFactory)
          ),
        );
        const watch = [{
          id: "carrier",
          kind: "graph" as const,
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }];
        const [viewA, viewB] = await Promise.all([
          a.watchSet(watch),
          b.watchSet(watch),
        ]);
        expect(queries).toBe(2);
        expect(documentIn(viewA, `cid:${outerHash}`)).toBeUndefined();
        expect(documentIn(viewB, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("resolves one session's `delivered()` while another session's sync waits for a body", async () => {
      // Two spaces share the watcher's connection. Space A's frame names a
      // body the registry lacks, and the answer to its fetch is held until
      // the end. Space B's frame names none. B's barrier must not wait for
      // A's fetch: by the time a further round trip of B's has come back, it
      // has resolved.
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-two-barriers"),
        subscriptionRefreshDelayMs: 0,
      });
      const referenced = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inner = loopback(server);
      const transport: Transport = {
        ...inner,
        send: (payload: string) => inner.send(payload),
        close: () => inner.close(),
        setReceiver(receiver: (payload: string) => void) {
          inner.setReceiver((payload: string) => {
            if (payload.includes('"byReference":true')) {
              acquireSchemaRegistryLease()();
              referenced.resolve();
            }
            if (payload.includes('"entities"') && payload.includes(outerHash)) {
              void release.promise.then(() => receiver(payload));
            } else {
              receiver(payload);
            }
          });
        },
      };
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      const spaceA = "did:key:z6Mk-sync-cid-references-two-barriers-a";
      const spaceB = "did:key:z6Mk-sync-cid-references-two-barriers-b";
      const carrier = "of:sync-cid-references-two-barriers";
      try {
        const writerA = await writerClient.mount(
          spaceA,
          {},
          testSessionOpenAuthFactory,
        );
        await writerA.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const writerB = await writerClient.mount(
          spaceB,
          {},
          testSessionOpenAuthFactory,
        );
        await writerB.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: carrier,
            value: { value: { plain: true } },
          }],
        });
        const a = await watcherClient.mount(
          spaceA,
          {},
          testSessionOpenAuthFactory,
        );
        const b = await watcherClient.mount(
          spaceB,
          {},
          testSessionOpenAuthFactory,
        );
        const watch = [{
          id: "carrier",
          kind: "graph" as const,
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }];
        const watchingA = a.watchSet(watch);
        await referenced.promise;
        await b.watchSet(watch);
        let bDelivered = false;
        const deliveredB = watcherClient.delivered(b).then(() => {
          bDelivered = true;
        });
        await b.queryGraph({ roots: [] });
        const deliveredWhileAWaited = bDelivered;
        release.resolve();
        await deliveredB;
        await watchingA;
        expect(deliveredWhileAWaited).toBe(true);
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("delivers again the syncs held when the connection fetching their bodies closes", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-outage"),
        subscriptionRefreshDelayMs: 0,
      });
      // The client's first body fetch is lost with its connection, and the
      // client reconnects to the same server. Each reference empties the
      // shared registry first, as in the test above.
      let receiver = (_payload: string) => {};
      let disconnected = (_error?: Error) => {};
      const reach = (): Transport => {
        const connection = loopback(server);
        connection.setReceiver((payload) => {
          if (payload.includes('"byReference":true')) {
            acquireSchemaRegistryLease()();
          }
          receiver(payload);
        });
        return connection;
      };
      let active: Transport | null = reach();
      let queries = 0;
      const outage = Promise.withResolvers<void>();
      const transport: Transport = {
        async send(payload) {
          if (active === null) throw connectionError("connection refused");
          if (payload.includes('"graph.query"') && queries++ === 0) {
            // The fetch's own send fails as its connection goes.
            const down = active;
            active = null;
            await down.close();
            disconnected(new Error("synthetic outage"));
            outage.resolve();
            throw connectionError("connection lost");
          }
          await active.send(payload);
        },
        close: () => active?.close() ?? Promise.resolve(),
        reset() {
          if (active === null) active = reach();
        },
        setReceiver(next) {
          receiver = next;
        },
        setCloseReceiver(next) {
          disconnected = next;
        },
      };
      const space = "did:key:z6Mk-sync-cid-references-outage";
      const carrier = "of:sync-cid-references-outage";
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      try {
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: closureOperations(carrier),
        });
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const watching = watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]).catch(() => undefined);
        await outage.promise;
        await watcherClient.restoreConnection();
        await watching;
        const view = (await watcher.watchAddSync([])).view;
        expect(queries).toBeGreaterThan(0);
        expect(documentIn(view, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
        expect(documentIn(view, `cid:${leafHash}`)).toEqual({
          value: leafSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });
  });

  describe("across a reconnect", () => {
    it("renegotiates when a session reconnects from a server with its option off to one with it on", async () => {
      // The same space's documents on two servers: the session first opens on
      // one that offers no references, then reconnects to one that does, and
      // takes references there.
      const offServer = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-renegotiate-off"),
        subscriptionRefreshDelayMs: 0,
        syncCidReferences: false,
      });
      const onServer = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-renegotiate-on"),
        subscriptionRefreshDelayMs: 0,
      });
      const space = "did:key:z6Mk-sync-cid-references-renegotiate";
      const carrier = "of:sync-cid-references-renegotiate";
      let references = 0;
      let receiver = (_payload: string) => {};
      let disconnected = (_error?: Error) => {};
      let host = offServer;
      const reach = (next: Server): Transport => {
        const connection = loopback(next);
        connection.setReceiver((payload) => {
          if (payload.includes('"byReference":true')) references++;
          receiver(payload);
        });
        return connection;
      };
      let active: Transport | null = reach(offServer);
      const transport: Transport = {
        async send(payload) {
          if (active === null) throw connectionError("connection refused");
          await active.send(payload);
        },
        close: () => active?.close() ?? Promise.resolve(),
        reset() {
          if (active === null) active = reach(host);
        },
        setReceiver(next) {
          receiver = next;
        },
        setCloseReceiver(next) {
          disconnected = next;
        },
      };
      const writers = await Promise.all(
        [offServer, onServer].map((server) =>
          connect({ transport: loopback(server) })
        ),
      );
      const watcherClient = await connect({
        transport,
        syncCidReferences: true,
      });
      try {
        for (const writerClient of writers) {
          const writer = await writerClient.mount(
            space,
            {},
            testSessionOpenAuthFactory,
          );
          await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: closureOperations(carrier),
          });
        }
        const watcher = await watcherClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const before = await watcher.watchSet([{
          id: "carrier",
          kind: "graph",
          query: {
            roots: [{ id: carrier, selector: { path: [], schema: false } }],
          },
        }]);
        const referencesBefore = references;
        expect(documentIn(before, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });

        const down = active;
        active = null;
        await down.close();
        disconnected(new Error("synthetic outage"));
        host = onServer;
        await watcherClient.restoreConnection();
        const after = (await watcher.watchAddSync([])).view;

        expect(referencesBefore).toBe(0);
        expect(references).toBeGreaterThan(0);
        expect(documentIn(after, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
      } finally {
        for (const writerClient of writers) await writerClient.close();
        await watcherClient.close();
        await offServer.close();
        await onServer.close();
      }
    });
  });

  describe("over a connection with one side off", () => {
    it("sends every body and no reference to a client that has not opted in", async () => {
      const upserts = await watchThrough(
        "client-off",
        new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://sync-cid-references-client-off"),
          subscriptionRefreshDelayMs: 0,
        }),
        false,
      );
      expect(upserts).toStrictEqual({ references: 0, queries: 0, bodies: 2 });
    });

    it("sends every body to a client that opted in when its server's option is off", async () => {
      const upserts = await watchThrough(
        "server-off",
        new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://sync-cid-references-server-off"),
          subscriptionRefreshDelayMs: 0,
          syncCidReferences: false,
        }),
        true,
      );
      expect(upserts).toStrictEqual({ references: 0, queries: 0, bodies: 2 });
    });

    it("sends every body to a client that does not advertise the flag", async () => {
      const { syncCidReferencesV1: _omitted, ...flags } =
        getMemoryProtocolFlags();
      const upserts = await watchRaw("older", flags);
      expect(upserts.filter((upsert) => upsert.id.startsWith("cid:")))
        .toStrictEqual(bodiesOf(upserts));
      expect(bodiesOf(upserts).length).toBe(2);
    });
  });
});
