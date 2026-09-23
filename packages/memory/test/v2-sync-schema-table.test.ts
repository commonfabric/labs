import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type {
  FabricValue,
  MutableFabricPlainObjectLayer,
} from "@commonfabric/data-model";
import {
  isLinkRef,
  LINK_V1_TAG,
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model-schema";
import type { JSONSchema } from "@commonfabric/api";
import {
  encodeMemoryBoundary,
  type EntityDocument,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  compressServerMessageSchemas,
  compressSessionSyncSchemas,
  expandServerMessageSchemas,
  expandSessionSyncSchemas,
  type SchemaTableSessionSync,
} from "../v2/sync-schema-table.ts";
import {
  containsSyncSchemaRefString,
  findSyncSchemaRef,
} from "../v2/sync-schema-ref.ts";
import { mapLinkSchemas } from "../v2/schema-table-links.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const textEncoder = new TextEncoder();

const encodedBytes = (value: ServerMessage): number =>
  textEncoder.encode(encodeMemoryBoundary(value)).byteLength;

const largeSchema = (): JSONSchema => ({
  type: "object",
  $defs: Object.fromEntries(
    Array.from({ length: 48 }, (_, index) => [
      `Definition${index}`,
      {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          count: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["id", "title"],
      },
    ]),
  ),
  properties: Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `field${index}`,
      { $ref: `#/$defs/Definition${index % 48}` },
    ]),
  ),
});

const repeatedSchemaSync = (
  count = 128,
): SessionSync => {
  const schema = largeSchema();
  return {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: Array.from({ length: count }, (_, index) => ({
      branch: "",
      id: `of:test-${index}`,
      scope: "space" as const,
      seq: 1,
      doc: {
        value: {
          title: `Document ${index}`,
          primary: linkRefFrom({
            id: `of:target-${index}`,
            path: [],
            schema,
          }),
          secondary: linkRefFrom({
            id: `of:secondary-${index}`,
            path: ["nested"],
            schema,
          }),
        },
      },
    })),
    removes: [],
  };
};

const syncEffect = (effect: SessionSync): SessionEffectMessage => ({
  type: "session/effect",
  space: "did:key:z6Mk-sync-schema-table",
  sessionId: "session:sync-schema-table",
  effect,
});

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
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

Deno.test("sync schema table experiment captures repeated schema savings", () => {
  const sync = repeatedSchemaSync();
  const message = syncEffect(sync);
  const bytes = encodedBytes(message);
  const schemaMarkerCount =
    encodeMemoryBoundary(message).split("$defs").length - 1;
  const compressed = compressServerMessageSchemas(message);
  const compressedBytes = encodedBytes(compressed);
  const compressedSchemaMarkerCount = encodeMemoryBoundary(compressed)
    .split("$defs").length - 1;
  const expanded = expandServerMessageSchemas(compressed);

  assertEquals(expanded, message);
  assert(
    schemaMarkerCount >= sync.upserts.length,
    "baseline fixture should repeat schema definitions across many upserts",
  );
  assert(
    compressedSchemaMarkerCount < schemaMarkerCount / 100,
    "schema-table encoding should remove almost all repeated schema definitions",
  );
  assert(
    compressedBytes < bytes / 5,
    "schema-table encoding should materially reduce repeated schema frames",
  );
});

Deno.test("sync schema table reports each repeated schema once", () => {
  const observed: JSONSchema[] = [];

  compressSessionSyncSchemas(repeatedSchemaSync(2), (schema) => {
    observed.push(schema);
  });

  assertEquals(observed, [internSchema(largeSchema(), true).schema]);
});

Deno.test("sync schema table preserves own __proto__ fields", () => {
  const value = JSON.parse(
    '{"__proto__":{"safe":true}}',
  ) as MutableFabricPlainObjectLayer;
  value.ref = linkRefFrom({
    id: "of:target",
    path: [],
    schema: { type: "string" },
  });
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:proto-source",
      scope: "space",
      seq: 1,
      doc: { value },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync);
  const compressedValue = compressed.upserts[0].doc?.value as Record<
    string,
    unknown
  >;

  assert(Object.hasOwn(compressedValue, "__proto__"));
  assertEquals(compressedValue.__proto__, { safe: true });
});

Deno.test("sync schema table leaves legacy alias schemas inline", () => {
  // The mapper no longer treats `$alias.schema` as a schema position:
  // `$alias` records are Pattern-binding vocabulary, not links, and their
  // schema field is binding metadata that travels inline. The alias record
  // IS ordinary data, though — a link nested inside its schema value is a
  // live position and interns normally.
  const aliasSchema: JSONSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
    },
  };
  const nestedLinkSchema: JSONSchema = { type: "string" };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:legacy-alias-source",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          aliases: [
            {
              $alias: {
                id: "of:legacy-target",
                path: [],
                schema: aliasSchema,
              },
            },
            {
              $alias: {
                id: "of:string-schema-target",
                path: [],
                schema: "opaque-schema-name",
              },
            },
            {
              $alias: {
                id: "of:alias-with-nested-link",
                path: [],
                schema: {
                  type: "object",
                  default: {
                    "/": {
                      [LINK_V1_TAG]: {
                        id: "of:inside-alias-schema",
                        path: [],
                        schema: nestedLinkSchema,
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const nestedHash = internSchema(nestedLinkSchema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [nestedHash]);

  const compressedAliases =
    (compressed.upserts[0].doc?.value as Record<string, unknown>)
      .aliases as Record<string, unknown>[];
  assertEquals(
    (compressedAliases[0].$alias as Record<string, unknown>).schema,
    aliasSchema,
  );
  assertEquals(
    (compressedAliases[1].$alias as Record<string, unknown>).schema,
    "opaque-schema-name",
  );
  const nestedEnvelope = ((
    (compressedAliases[2].$alias as Record<string, unknown>)
      .schema as Record<string, unknown>
  ).default as Record<string, unknown>)["/"] as Record<string, unknown>;
  assertEquals(
    (nestedEnvelope[LINK_V1_TAG] as Record<string, unknown>).schema,
    `schema-ref@2:${nestedHash}`,
  );

  const expandedSchemas: JSONSchema[] = [];
  assertEquals(
    expandSessionSyncSchemas(compressed, (expanded) => {
      expandedSchemas.push(expanded);
    }),
    sync,
  );
  assertEquals(expandedSchemas, [
    internSchema(nestedLinkSchema, true).schema,
  ]);
});

Deno.test("sync schema table survives malformed link envelope payloads", () => {
  // Stored data can carry an envelope-shaped record whose payload is not a
  // record at all — cell-rep recognizes the envelope shape only. Compression
  // and expansion must treat these as ordinary data, not throw mid-sync (a
  // throw here breaks the space's sync stream for every watcher). The walk
  // still descends into them, so a valid link nested inside one interns.
  const nestedSchema: JSONSchema = { type: "number" };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:malformed-envelopes",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          nullPayload: { "/": { [LINK_V1_TAG]: null } },
          stringPayload: { "/": { [LINK_V1_TAG]: "not a payload" } },
          arrayPayload: {
            "/": {
              [LINK_V1_TAG]: [{
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:nested",
                    path: [],
                    schema: nestedSchema,
                  },
                },
              }],
            },
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const nestedHash = internSchema(nestedSchema, true).taggedHashString;
  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [nestedHash]);
  assertEquals(expandSessionSyncSchemas(compressed), sync);

  // The string scanner takes the same ordinary walk: no throw on the
  // malformed payloads, and a reserved string sitting AS the payload is
  // still found.
  assertEquals(containsSyncSchemaRefString(sync), false);
  assertEquals(
    containsSyncSchemaRefString({
      "/": { [LINK_V1_TAG]: "schema-ref@2:fid1:planted" },
    }),
    true,
  );
});

Deno.test("sync schema table expansion rejects refs at uninterpreted positions", () => {
  // An older server may still intern legacy `$alias` schema positions.
  // This expander no longer interprets them; delivering the surviving ref
  // string as data would silently corrupt the doc, so expansion fails
  // loudly even when the table carries the referenced schema.
  const schema: JSONSchema = { type: "object" };
  const interned = internSchema(schema, true);
  const sync: SchemaTableSessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:old-server-alias",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          bound: {
            $alias: {
              id: "of:target",
              path: [],
              schema: `schema-ref@2:${interned.taggedHashString}`,
            },
          },
        },
      },
    }],
    removes: [],
    schemaTable: { [interned.taggedHashString]: interned.schema },
  };

  assertThrows(
    () => expandSessionSyncSchemas(sync),
    Error,
    "Unexpanded sync schema table reference",
  );
});

Deno.test("sync schema table interns only strict link envelopes", () => {
  // Link recognition goes through the cell-rep link API, which defines a
  // legacy link as the single-key `{ "/": { "link@1": ... } }` envelope. An
  // envelope with sibling keys is NOT a link: its inner "schema" is inert
  // user data — uniformly for compression, expansion, and the reserved-ref
  // hardening — while a strict sibling link in the same record is interned.
  const primarySchema: JSONSchema = {
    type: "object",
    properties: { title: { type: "string" } },
  };
  const siblingSchema: JSONSchema = {
    type: "object",
    properties: { count: { type: "number" } },
  };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:link-with-sibling",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          compound: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:primary",
                path: [],
                schema: primarySchema,
              },
            },
            sibling: linkRefFrom({
              id: "of:sibling",
              path: [],
              schema: siblingSchema,
            }),
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const compressedCompound =
    (compressed.upserts[0].doc?.value as Record<string, unknown>)
      .compound as Record<string, unknown>;
  const compressedPayload =
    (compressedCompound["/"] as Record<string, unknown>)[
      LINK_V1_TAG
    ] as Record<string, unknown>;
  const compressedSiblingPayload =
    ((compressedCompound.sibling as Record<string, unknown>)[
      "/"
    ] as Record<string, unknown>)[LINK_V1_TAG] as Record<string, unknown>;
  const siblingHash = internSchema(siblingSchema, true).taggedHashString;

  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [siblingHash]);
  // The sibling'd envelope is not a link: its schema stays inline.
  assertEquals(compressedPayload.schema, primarySchema);
  assertEquals(compressedSiblingPayload.schema, `schema-ref@2:${siblingHash}`);
  assertEquals(expandSessionSyncSchemas(compressed), sync);

  // The hardening applies the same strictness: a reserved string inside a
  // sibling'd envelope's payload is ordinary data, not a schema position.
  assertEquals(
    findSyncSchemaRef({
      "/": {
        [LINK_V1_TAG]: { id: "of:x", path: [], schema: "schema-ref@2:z" },
      },
      sibling: true,
    }),
    undefined,
  );
});

Deno.test("sync schema table ignores inherited fields while finding schema refs", () => {
  const inherited = {
    hidden: {
      $alias: {
        schema: "schema-ref@2:inherited",
      },
    },
  };
  const payload = Object.create(inherited) as Record<string, unknown>;
  payload.visible = { value: "ordinary data" };

  assertEquals(findSyncSchemaRef(payload), undefined);
});

Deno.test("sync schema table leaves syncs without compressible schemas unchanged", () => {
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [
      {
        branch: "",
        id: "of:missing-doc",
        scope: "space",
        seq: 1,
      },
      {
        branch: "",
        id: "of:no-compressible-schema",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:string-schema",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
          },
        },
      },
    ],
    removes: [],
  };
  const emptyTableSync: SchemaTableSessionSync = { ...sync, schemaTable: {} };

  assertStrictEquals(compressSessionSyncSchemas(sync), sync);
  assertStrictEquals(expandSessionSyncSchemas(sync), sync);
  assertStrictEquals(expandSessionSyncSchemas(emptyTableSync), emptyTableSync);
});

Deno.test("sync schema table expands unused tables and rejects bad refs", () => {
  const schema: JSONSchema = { type: "string" };
  const schemaHash = internSchema(schema, true).taggedHashString;
  const syncWithUnusedTable: SchemaTableSessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [
      {
        branch: "",
        id: "of:missing-doc",
        scope: "space",
        seq: 1,
      },
      {
        branch: "",
        id: "of:non-ref-schema",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:non-ref-schema-target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
            refWithoutSchema: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:no-schema-target",
                  path: [],
                },
              },
            },
          },
        },
      },
    ],
    removes: [],
    schemaTable: { [schemaHash]: schema },
  };

  const expanded = expandSessionSyncSchemas(syncWithUnusedTable);
  const { schemaTable: _unusedSchemaTable, ...syncWithoutTable } =
    syncWithUnusedTable;
  assertEquals(expanded, syncWithoutTable);
  assertEquals(
    (expanded as unknown as { schemaTable?: Record<string, JSONSchema> })
      .schemaTable,
    undefined,
  );
  assert(Object.isFrozen(expanded));

  assertThrows(
    () =>
      expandSessionSyncSchemas({
        ...syncWithUnusedTable,
        upserts: [{
          branch: "",
          id: "of:bad-ref",
          scope: "space",
          seq: 1,
          doc: {
            value: {
              ref: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:bad-ref-target",
                    path: [],
                    schema: "schema-ref@2:sha256:missing",
                  },
                },
              },
            },
          },
        }],
      }),
    Error,
    "Invalid sync schema table reference",
  );

  assertThrows(
    () =>
      expandSessionSyncSchemas({
        ...syncWithUnusedTable,
        upserts: [{
          branch: "",
          id: "of:poisoned-ref",
          scope: "space",
          seq: 1,
          doc: {
            value: {
              ref: {
                "/": {
                  [LINK_V1_TAG]: {
                    id: "of:poisoned-ref-target",
                    path: [],
                    schema: `schema-ref@2:${schemaHash}`,
                  },
                },
              },
            },
          },
        }],
        schemaTable: { [schemaHash]: { type: "number" } },
      }),
    Error,
    "Invalid sync schema table content",
  );
});

Deno.test("sync schema table rejects refs without a populated table", () => {
  const compressed = compressSessionSyncSchemas(
    repeatedSchemaSync(1),
  ) as SchemaTableSessionSync;
  const { schemaTable: _schemaTable, ...withoutTable } = compressed;

  assertThrows(
    () => expandSessionSyncSchemas(withoutTable),
    Error,
    "Invalid sync schema table reference",
  );
  assertThrows(
    () => expandSessionSyncSchemas({ ...withoutTable, schemaTable: {} }),
    Error,
    "Invalid sync schema table reference",
  );
});

Deno.test("sync schema table validates dangling refs without recursive traversal", () => {
  const danglingRef = "schema-ref@2:sha256:missing";
  let deeplyNested: FabricValue = {
    $alias: {
      id: "of:deep-target",
      path: [],
      schema: danglingRef,
    },
  };
  for (let index = 0; index < 20_000; index += 1) {
    deeplyNested = { next: deeplyNested };
  }

  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:deep-dangling-ref",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          harmless: danglingRef,
          nested: deeplyNested,
        },
      },
    }],
    removes: [],
  };

  assertThrows(
    () => expandSessionSyncSchemas(sync),
    Error,
    "Invalid sync schema table reference",
  );
});

Deno.test("server schema table helpers ignore non-sync messages", () => {
  const hello = {
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  } satisfies ServerMessage;
  const responseWithoutOk = {
    type: "response",
    requestId: "without-ok",
  } satisfies ServerMessage;
  const responseWithPrimitiveOk = {
    type: "response",
    requestId: "primitive-ok",
    ok: "done",
  } satisfies ServerMessage;
  const responseWithNonSyncOk = {
    type: "response",
    requestId: "non-sync",
    ok: { sync: { type: "not-sync" } },
  } satisfies ServerMessage;

  assertStrictEquals(compressServerMessageSchemas(hello), hello);
  assertStrictEquals(
    compressServerMessageSchemas(responseWithoutOk),
    responseWithoutOk,
  );
  assertStrictEquals(
    compressServerMessageSchemas(responseWithPrimitiveOk),
    responseWithPrimitiveOk,
  );
  assertStrictEquals(
    compressServerMessageSchemas(responseWithNonSyncOk),
    responseWithNonSyncOk,
  );

  assertStrictEquals(
    expandServerMessageSchemas("not-an-object"),
    "not-an-object",
  );
  assertStrictEquals(
    expandServerMessageSchemas(responseWithoutOk),
    responseWithoutOk,
  );
  assertStrictEquals(
    expandServerMessageSchemas(responseWithNonSyncOk),
    responseWithNonSyncOk,
  );
});

Deno.test("server schema table helpers expand response sync payloads", () => {
  const sync = repeatedSchemaSync(1);
  const response = {
    type: "response",
    requestId: "sync-response",
    ok: {
      sync: compressSessionSyncSchemas(sync),
    },
  } satisfies ServerMessage;

  const expanded = expandServerMessageSchemas(response) as ResponseMessage<{
    sync: SessionSync;
  }>;

  assertEquals(expanded.ok?.sync, sync);
});

Deno.test("memory server negotiates schema-table v2 sync frames per connection", async () => {
  const flags = getMemoryProtocolFlags();
  const run = async (
    mode: "v2" | "legacy" | "off",
  ) => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(
        `memory://sync-schema-table-negotiation-${mode}`,
      ),
    });
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    const space = `did:key:z6Mk-sync-schema-table-${mode}`;
    const clientFlags = mode === "v2" ? flags : {
      modernCellRep: flags.modernCellRep,
      stableExpressionResultIds: true,
      versionedGeneratedCellIds: true,
      commitPreconditions: flags.commitPreconditions,
      ...(mode === "legacy" ? { syncSchemaTable: true } : {}),
    };

    try {
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: clientFlags,
      }));
      const sessionOpen = expectHelloOk(messages);

      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open",
        space,
        session: {},
        invocation: authInvocation(sessionOpen),
      }));
      const opened = nextResponse<SessionOpenResult>(messages);
      assertExists(opened.ok);

      const upsert = repeatedSchemaSync(1).upserts[0];
      await connection.receive(encodeMemoryBoundary({
        type: "transact",
        requestId: "write",
        space,
        sessionId: opened.ok.sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: upsert.id,
            value: upsert.doc,
          }],
        },
      }));
      // Consume the transact verdict (and, CT-1927 default-on, the
      // marker-only frame preceding it).
      nextResponse(messages);

      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch",
        space,
        sessionId: opened.ok.sessionId,
        watches: [{
          id: "root",
          kind: "graph",
          query: {
            roots: [{
              id: upsert.id,
              selector: {
                path: [],
                schema: false,
              },
            }],
          },
        }],
      }));

      const watched = nextResponse<WatchAddResult>(messages);
      assertExists(watched.ok);
      return (watched.ok.sync as SchemaTableSessionSync).schemaTable;
    } finally {
      connection.close();
      await server.close();
    }
  };

  assertExists(await run("v2"));
  assertEquals(await run("legacy"), undefined);
  assertEquals(await run("off"), undefined);
});

Deno.test("findSyncSchemaRef ignores inherited object properties", () => {
  // The traversal must only follow own properties: an enumerable INHERITED
  // key carrying a link-payload shape must not surface as a reserved
  // reference. Built on a custom prototype so the test never touches
  // Object.prototype.
  const pollutedProto = {
    polluted: {
      $alias: { id: "of:polluted", path: [], schema: "schema-ref@2:fid1:evil" },
    },
  };
  const doc = Object.assign(Object.create(pollutedProto), {
    value: { plain: "doc" },
  }) as Record<string, unknown>;
  assertEquals(findSyncSchemaRef(doc), undefined);
  // Sanity: the same shape as an OWN property is found.
  assertEquals(
    findSyncSchemaRef({ nested: pollutedProto.polluted }),
    "schema-ref@2:fid1:evil",
  );
});

Deno.test("sync schema table compression preserves own __proto__ keys", () => {
  const schema: JSONSchema = { type: "object" };
  const canonical = internSchema(schema, true);
  const linkWithSchema = {
    "/": {
      [LINK_V1_TAG]: { id: "of:target", path: [], schema },
    },
  };
  // An own "__proto__" data property (constructible via defineProperty or a
  // hostile codec) must survive the rewrite as an own property — plain
  // assignment would silently hit the prototype accessor instead.
  const doc: Record<string, unknown> = { value: { nested: linkWithSchema } };
  Object.defineProperty(doc.value as object, "__proto__", {
    value: { alsoHere: linkWithSchema },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const sync = {
    type: "sync" as const,
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:example",
      seq: 1,
      doc: doc as unknown as EntityDocument,
    }],
    removes: [],
  };
  const compressed = compressSessionSyncSchemas(sync) as SessionSync & {
    schemaTable?: Record<string, JSONSchema>;
  };
  assertExists(compressed.schemaTable);
  assertEquals(
    compressed.schemaTable![canonical.taggedHashString],
    canonical.schema,
  );

  const value = compressed.upserts[0].doc?.value as Record<string, unknown>;
  const protoEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
  assertExists(protoEntry, "own __proto__ key must remain an own property");
  assertEquals(Object.getPrototypeOf(value), Object.prototype);
  const relocated =
    (protoEntry!.value as Record<string, Record<string, unknown>>)
      .alsoHere["/"] as Record<string, Record<string, unknown>>;
  assertEquals(
    relocated[LINK_V1_TAG].schema,
    `schema-ref@2:${canonical.taggedHashString}`,
  );
});

Deno.test("findSyncSchemaRef traverses arrays and containsSyncSchemaRefString scans leaves", () => {
  assertEquals(
    findSyncSchemaRef([
      "plain",
      [{
        "/": {
          [LINK_V1_TAG]: {
            id: "of:in-array",
            path: [],
            schema: "schema-ref@2:fid1:inside-array",
          },
        },
      }],
    ]),
    "schema-ref@2:fid1:inside-array",
  );

  assertEquals(
    containsSyncSchemaRefString({
      a: 1,
      b: [null, true, { c: "schema-cas@1:fid1:leaf" }],
    }),
    true,
  );
  assertEquals(
    containsSyncSchemaRefString({
      a: 1,
      b: [null, true, { c: "an ordinary string" }],
    }),
    false,
  );
});

Deno.test("schema table and reserved-ref detection handle modern cell-rep links", () => {
  // Under modernCellRep, links are FabricLink instances rather than plain
  // envelopes; recognition must go through the cell-rep chokepoint or every
  // link becomes an opaque leaf and both interning and hardening no-op.
  setModernCellRepConfig(true);
  try {
    const schema: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const canonical = internSchema(schema, true);
    const sync: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      upserts: [{
        branch: "",
        id: "of:modern",
        scope: "space",
        seq: 1,
        doc: {
          value: {
            contact: linkRefFrom({
              id: "of:contact",
              path: [],
              schema,
            }),
          },
        } as unknown as EntityDocument,
      }],
      removes: [],
    };

    const compressed = compressSessionSyncSchemas(
      sync,
    ) as SchemaTableSessionSync;
    assertExists(compressed.schemaTable, "modern links must be interned");
    const compressedLink =
      (compressed.upserts[0].doc?.value as Record<string, unknown>).contact;
    assert(isLinkRef(compressedLink), "rewrite must preserve the link form");
    assertEquals(
      (linkRefPayload(compressedLink) as Record<string, unknown>).schema,
      `schema-ref@2:${canonical.taggedHashString}`,
    );

    // Hardening detection sees inside FabricLink payloads too.
    assertEquals(
      findSyncSchemaRef(compressed.upserts[0].doc),
      `schema-ref@2:${canonical.taggedHashString}`,
    );
    assertEquals(
      containsSyncSchemaRefString(compressed.upserts[0].doc),
      true,
    );

    const expanded = expandSessionSyncSchemas(compressed);
    const expandedLink =
      (expanded.upserts[0].doc?.value as Record<string, unknown>).contact;
    assert(isLinkRef(expandedLink));
    assertEquals(
      (linkRefPayload(expandedLink) as Record<string, unknown>).schema,
      canonical.schema,
    );
  } finally {
    setModernCellRepConfig(false);
    resetModernCellRepConfig();
  }
});

Deno.test("schema subtrees are opaque: nested link shapes inside schemas are data", () => {
  // A schema whose `default` embeds a link-shaped structure with a reserved
  // ref string: the whole schema is one position. Compression swallows it
  // wholesale, expansion restores it byte-identically without interpreting
  // the nested shape, and the validator does not flag it.
  const schemaWithNestedLink: JSONSchema = {
    type: "object",
    default: {
      "/": {
        [LINK_V1_TAG]: {
          id: "of:inner",
          path: [],
          schema: "schema-ref@2:fid1:nested-as-data",
        },
      },
    },
  } as unknown as JSONSchema;
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:opaque-schema",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          ref: linkRefFrom({
            id: "of:target",
            path: [],
            schema: schemaWithNestedLink,
          }),
        },
      },
    }],
    removes: [],
  };

  assertEquals(findSyncSchemaRef(sync.upserts[0].doc), undefined);

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  assertExists(compressed.schemaTable);
  const canonical = internSchema(schemaWithNestedLink, true);
  assertEquals(
    compressed.schemaTable![canonical.taggedHashString],
    canonical.schema,
  );
  const expanded = expandSessionSyncSchemas(compressed);
  assertEquals(expanded, sync);
});

Deno.test("validator covers mapper schema positions plus legacy aliases", () => {
  // Drift guard: findSyncSchemaRef is iterative (stack-safe) while
  // mapLinkSchemas is recursive. The validator must see every position the
  // mapper interprets — equal on link positions — plus exactly one extra
  // family: legacy `$alias` schema positions, which clients shipped before
  // the mapper stopped interpreting them still expand (see
  // sync-schema-ref.ts). If either walker learns or prunes a position,
  // this corpus fails until the other (and its expectation here) is
  // updated.
  const planted = "schema-ref@2:fid1:planted";
  const probe = (value: unknown): string | undefined => {
    let found: string | undefined;
    mapLinkSchemas(value as never, (schema) => {
      if (
        found === undefined && typeof schema === "string" &&
        schema.startsWith("schema-ref@2:")
      ) {
        found = schema;
      }
      return schema;
    });
    return found;
  };

  const corpus: Array<{
    label: string;
    value: unknown;
    validator: string | undefined;
    mapper: string | undefined;
  }> = [
    {
      label: "legacy link payload",
      value: {
        "/": { [LINK_V1_TAG]: { id: "of:a", path: [], schema: planted } },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "alias payload is validator-only",
      value: { $alias: { id: "of:b", path: [], schema: planted } },
      validator: planted,
      mapper: undefined,
    },
    {
      label: "nested in array",
      value: [1, [{ $alias: { id: "of:c", path: [], schema: planted } }]],
      validator: planted,
      mapper: undefined,
    },
    {
      label: "sibling'd envelope is not a link",
      value: {
        "/": { [LINK_V1_TAG]: { id: "of:d", path: [], schema: planted } },
        sibling: true,
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "plain strings inside an alias schema value are data",
      value: {
        $alias: {
          id: "of:e",
          path: [],
          schema: { type: "object", default: { deep: planted } },
        },
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "link nested in an alias schema value is live for both",
      value: {
        $alias: {
          id: "of:h",
          path: [],
          schema: {
            type: "object",
            default: {
              "/": { [LINK_V1_TAG]: { id: "of:i", path: [], schema: planted } },
            },
          },
        },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "link schema subtree stays opaque",
      value: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:j",
            path: [],
            schema: { type: "object", default: { deep: planted } },
          },
        },
      },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "malformed envelope payload is not a link",
      value: { "/": { [LINK_V1_TAG]: null } },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "malformed envelope contents are walked as data",
      value: {
        "/": {
          [LINK_V1_TAG]: [{
            "/": { [LINK_V1_TAG]: { id: "of:k", path: [], schema: planted } },
          }],
        },
      },
      validator: planted,
      mapper: planted,
    },
    {
      label: "harmless string position",
      value: { note: planted },
      validator: undefined,
      mapper: undefined,
    },
    {
      label: "alias sibling fields still walked",
      value: {
        $alias: {
          id: "of:f",
          path: [],
          extra: { $alias: { id: "of:g", path: [], schema: planted } },
        },
      },
      validator: planted,
      mapper: undefined,
    },
  ];

  for (const { label, value, validator, mapper } of corpus) {
    assertEquals(findSyncSchemaRef(value), validator, `validator on: ${label}`);
    assertEquals(probe(value), mapper, `mapper on: ${label}`);
  }

  // Modern regime: same agreement through FabricLink instances.
  setModernCellRepConfig(true);
  try {
    const modern = {
      wrapped: linkRefFrom({ id: "of:m", path: [], schema: planted }),
    };
    assertEquals(findSyncSchemaRef(modern), probe(modern));
    assertEquals(findSyncSchemaRef(modern), planted);
  } finally {
    setModernCellRepConfig(false);
    resetModernCellRepConfig();
  }
});

Deno.test("encodeMemoryBoundary embeds reserved prefixes verbatim", () => {
  // Pins the property the substring gates depend on (see the note on
  // encodeMemoryBoundary): strings serialize byte-verbatim, so a payload's
  // text contains a reserved prefix iff some string value carries it.
  const withRefs = encodeMemoryBoundary({
    doc: {
      value: {
        a: "schema-ref@2:fid1:x",
        b: { nested: ["schema-cas@1:fid1:y"] },
      },
    },
  });
  assert(withRefs.includes("schema-ref@2:"));
  assert(withRefs.includes("schema-cas@1:"));

  const withoutRefs = encodeMemoryBoundary({
    doc: { value: { a: "plain", b: { nested: [1, true, null] } } },
  });
  assert(!withoutRefs.includes("schema-ref@2:"));
  assert(!withoutRefs.includes("schema-cas@1:"));
});

Deno.test("sync schema table leaves schema-document references inline", () => {
  // A reference-only schema position — `{ "$ref": "cid:…" }` pointing at a
  // content-addressed schema document — is already smaller than a table
  // ref, so compression leaves it in place. A sibling inline schema in the
  // same frame still compresses.
  const documentRef: JSONSchema = {
    $ref: "cid:fid1:0123456789abcdefghijklmnopqrstuvwxyzABCDEF#/$defs/Node",
  };
  const inlineSchema: JSONSchema = {
    type: "object",
    properties: { title: { type: "string" } },
  };
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:document-ref-source",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          byRef: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:ref-target",
                path: [],
                schema: documentRef,
              },
            },
          },
          inline: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:inline-target",
                path: [],
                schema: inlineSchema,
              },
            },
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const inlineHash = internSchema(inlineSchema, true).taggedHashString;
  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [inlineHash]);

  const value = compressed.upserts[0].doc?.value as Record<string, unknown>;
  const refEnvelope = (value.byRef as Record<string, unknown>)["/"] as Record<
    string,
    unknown
  >;
  assertEquals(
    (refEnvelope[LINK_V1_TAG] as Record<string, unknown>).schema,
    documentRef,
  );

  assertEquals(expandSessionSyncSchemas(compressed), sync);
});

Deno.test("stored-document validation ignores schema-document references", () => {
  // The engine's stored-document gate refuses reserved TRANSPORT prefixes in
  // schema positions; an object-valued `cid:` reference is the STORAGE form
  // and passes. This pins the boundary between the two.
  const linkWithDocumentRef = {
    value: {
      x: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:target",
            path: [],
            schema: { $ref: "cid:fid1:someDocumentHash" },
          },
        },
      },
    },
  };
  assertEquals(findSyncSchemaRef(linkWithDocumentRef), undefined);
  assertEquals(containsSyncSchemaRefString(linkWithDocumentRef), false);

  const linkWithTransportRef = {
    value: {
      x: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:target",
            path: [],
            schema: "schema-cas@1:fid1:someDocumentHash",
          },
        },
      },
    },
  };
  assertEquals(
    findSyncSchemaRef(linkWithTransportRef),
    "schema-cas@1:fid1:someDocumentHash",
  );
  assertEquals(containsSyncSchemaRefString(linkWithTransportRef), true);
});

Deno.test("sync schema table compresses boolean link schemas", () => {
  // The schema-document carve-out asks its ref-only question of every
  // compressible schema, booleans included; a boolean is not a ref-only
  // position, so it compresses like any other schema and round-trips.
  const sync: SessionSync = {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:boolean-schema-source",
      scope: "space",
      seq: 1,
      doc: {
        value: {
          open: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:boolean-target",
                path: [],
                schema: true,
              },
            },
          },
        },
      },
    }],
    removes: [],
  };

  const compressed = compressSessionSyncSchemas(sync) as SchemaTableSessionSync;
  const booleanHash = internSchema(true, true).taggedHashString;
  assertExists(compressed.schemaTable);
  assertEquals(Object.keys(compressed.schemaTable), [booleanHash]);

  const expanded = expandSessionSyncSchemas(compressed);
  const value = expanded.upserts[0].doc?.value as Record<string, unknown>;
  const envelope = (value.open as Record<string, unknown>)["/"] as Record<
    string,
    unknown
  >;
  assertEquals(
    (envelope[LINK_V1_TAG] as Record<string, unknown>).schema,
    true,
  );
});
