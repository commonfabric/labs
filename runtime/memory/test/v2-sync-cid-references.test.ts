import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
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
  resetSyncCidReferencesConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  setSyncCidReferencesConfig,
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

/** A lookup holding exactly the two schemas above. */
const lookup: SchemaDocumentLookup = (hash) =>
  hash === leafHash
    ? leafSchema as JSONSchema
    : hash === outerHash
    ? outerSchema as JSONSchema
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

    it("throws on a reference that carries a body", () => {
      expect(() =>
        resolveServerMessageCidReferences(
          responseWith([{ ...leafReference, doc: { value: leafSchema } }]),
          lookup,
        )
      ).toThrow(TypeError);
    });
  });

  describe("over a connection with the option on", () => {
    beforeEach(() => setSyncCidReferencesConfig(true));
    afterEach(() => resetSyncCidReferencesConfig());

    it("names a schema document by reference and the client applies its body", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-hit"),
        subscriptionRefreshDelayMs: 0,
      });
      const { counts, transport } = countingTransport(server);
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({ transport });
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
      const watcherClient = await connect({ transport });
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
      const watcherClient = await connect({ transport });
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
            const down = active;
            active = null;
            await down.close();
            disconnected(new Error("synthetic outage"));
            outage.resolve();
            return;
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
      const watcherClient = await connect({ transport });
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

    it("sends every body to a client that does not advertise the flag", async () => {
      const { syncCidReferencesV1: _omitted, ...flags } =
        getMemoryProtocolFlags();
      const upserts = await watchRaw("older", flags);
      expect(upserts.filter((upsert) => upsert.id.startsWith("cid:")))
        .toStrictEqual(bodiesOf(upserts));
      expect(bodiesOf(upserts).length).toBe(2);
    });
  });

  describe("over a connection with the option off", () => {
    it("sends every body and no reference, as by default", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-cid-references-off"),
        subscriptionRefreshDelayMs: 0,
      });
      const { counts, transport } = countingTransport(server);
      const writerClient = await connect({ transport: loopback(server) });
      const watcherClient = await connect({ transport });
      const space = "did:key:z6Mk-sync-cid-references-off";
      const carrier = "of:sync-cid-references-off";
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
        expect(counts.references).toBe(0);
        expect(counts.queries).toBe(0);
        expect(documentIn(view, `cid:${outerHash}`)).toEqual({
          value: outerSchema,
        });
      } finally {
        await writerClient.close();
        await watcherClient.close();
        await server.close();
      }
    });

    it("sends every body to a client that advertises the flag when its server has it off", async () => {
      const upserts = await watchRaw("off-server", {
        ...getMemoryProtocolFlags(),
        syncCidReferencesV1: true,
      });
      expect(upserts.filter((upsert) => upsert.id.startsWith("cid:")))
        .toStrictEqual(bodiesOf(upserts));
      expect(bodiesOf(upserts).length).toBe(2);
    });
  });
});
