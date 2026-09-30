import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { resetSyncSchemaTableConfig } from "@commonfabric/memory/v2";
import {
  classifySchemaMetaValue,
  collectExternalSchemaRefHashes,
  collectSchemaMetaRefHashes,
  MalformedSchemaMetaError,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import { getResultCellWithSourceSchema } from "../src/piece-helpers.ts";
import {
  inlineResultSchemaMeta,
  readResultSchemaMeta,
  resultSchemaMetaSpelling,
  writeResultSchemaMeta,
} from "../src/result-schema-meta.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { recomposeSchemaRefs } from "../src/schema-decompose.ts";
import { resolveSchema } from "../src/schema.ts";
import { resetContentAddressedSchemasConfig } from "../src/schema-doc-config.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import type { URI } from "../src/sigil-types.ts";

// The `schema` metadata of a result document takes the link spelling: a
// content-addressed reference under `contentAddressedSchemas`, whose
// closure the commit installs into the space (the write-side delivery
// guarantee), and the inline schema where a reference is not minted.
describe("result-schema-meta", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let space: MemorySpace;
  let signer: Identity;

  const resultSchema: JSONSchemaObj = {
    type: "object",
    properties: {
      title: { $ref: "#/$defs/Title" },
      detail: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
    },
    required: ["title", "detail"],
    $defs: { Title: { type: "string" } },
  };

  const runtimeWith = (contentAddressedSchemas: boolean) =>
    new Runtime({
      storageManager: writerStorage,
      apiUrl: new URL(import.meta.url),
      experimental: { contentAddressedSchemas },
    });

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("result-schema-meta");
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = runtimeWith(true);
    space = signer.did();
  });

  afterEach(async () => {
    // The ambient flag is realm-sticky; later test files must see its
    // default, and so must the sync schema table the flag-on Runtime
    // construction disabled.
    resetContentAddressedSchemasConfig();
    resetSyncSchemaTableConfig();
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  const closureOf = (rootHash: string): Set<string> => {
    const closure = new Set<string>([rootHash]);
    for (const hash of closure) {
      for (
        const dep of collectExternalSchemaRefHashes(lookupSchemaDocument(hash))
      ) {
        closure.add(dep);
      }
    }
    return closure;
  };

  it("writes a `cid:` reference whose closure the commit installs into the space", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta reference",
      undefined,
      tx,
    );
    cell.set({ title: "Ada", detail: { count: 3 } });
    expect(writeResultSchemaMeta(cell, resultSchema)).toBe(true);

    const stored = cell.getMetaRaw("schema") as JSONSchemaObj;
    expect(stored).toEqual(resultSchemaMetaSpelling(resultSchema));
    expect(typeof stored.$ref).toBe("string");
    const rootHash = parseExternalSchemaRef(stored.$ref!)!.taggedHash;
    expect(lookupSchemaDocument(rootHash)).toBeDefined();
    expect((await tx.commit()).error).toBeUndefined();

    // A reader pulls every closure document from storage, where only this
    // commit can have put it.
    const provider = readerStorage.open(space);
    for (const hash of closureOf(rootHash)) {
      const synced = await provider.sync(`cid:${hash}` as URI, {
        path: [],
        schema: false,
      });
      expect(synced.error).toBeUndefined();
      const document = (provider as unknown as {
        get: (uri: URI) => { value?: unknown } | undefined;
      }).get(`cid:${hash}` as URI);
      expect(document?.value).toEqual(lookupSchemaDocument(hash));
    }
  });

  it("returns the inline schema from a stored reference", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta inline",
      undefined,
      tx,
    );
    writeResultSchemaMeta(cell, resultSchema);
    expect((await tx.commit()).error).toBeUndefined();

    const inline = readResultSchemaMeta(cell) as JSONSchemaObj;
    expect(inline.$ref).toBeUndefined();
    expect(inline.type).toBe("object");
    expect(inline.required).toEqual(["title", "detail"]);
    // The typed handle a reader recovers narrows through the reference the
    // same way it narrows through an inline schema. A narrowed position
    // keeps its local `$defs` ref (and the definitions it needs), so the
    // comparison is on the resolved type.
    const narrowedType = (target: Cell<unknown>) =>
      (resolveSchema(target.getAsNormalizedFullLink().schema) as JSONSchemaObj)
        .type;
    expect(narrowedType(getResultCellWithSourceSchema(cell.key("title"))))
      .toBe("string");
    expect(
      narrowedType(
        getResultCellWithSourceSchema(cell.key("detail").key("count")),
      ),
    ).toBe("number");
  });

  it("skips the write when the stored spelling already matches", async () => {
    const first = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta rewrite",
      undefined,
      first,
    );
    writeResultSchemaMeta(cell, resultSchema);
    expect((await first.commit()).error).toBeUndefined();

    const again = writer.edit();
    expect(writeResultSchemaMeta(cell.withTx(again), resultSchema)).toBe(false);
    expect([...again.getWriteDetails?.(space) ?? []]).toEqual([]);
    expect((await again.commit()).error).toBeUndefined();
  });

  it("keeps a trivial schema inline", () => {
    expect(resultSchemaMetaSpelling({})).toEqual({});
    expect(resultSchemaMetaSpelling(true)).toBe(true);
  });

  it("keeps a schema decomposition refuses inline", () => {
    const refused: JSONSchema = {
      type: "object",
      properties: {
        refused: { $id: "https://example.invalid/x", type: "string" },
      },
    };
    expect(resultSchemaMetaSpelling(refused)).toEqual(refused);
  });

  it("resolves the reference in a session that never wrote it", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta fresh reader",
      undefined,
      tx,
    );
    cell.set({ title: "Ada", detail: { count: 1 } });
    writeResultSchemaMeta(cell, resultSchema);
    const stored = cell.getMetaRaw("schema") as JSONSchemaObj;
    const rootHash = parseExternalSchemaRef(stored.$ref!)!.taggedHash;
    expect((await tx.commit()).error).toBeUndefined();
    const link = cell.getAsNormalizedFullLink();

    // The writer's session ends before the reader's begins, and it held
    // the realm registry's only leases: the registry clears, so the reader
    // starts cold and everything it resolves came through delivery.
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    expect(lookupSchemaDocument(rootHash)).toBeUndefined();

    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerStorage = readerStorage;
    writer = new Runtime({
      storageManager: readerStorage,
      apiUrl: new URL(import.meta.url),
      experimental: { contentAddressedSchemas: true },
    });
    const arrived = writer.getCellFromLink<unknown>(link);
    await arrived.sync();
    // One round trip delivered the document with its closure: arrival
    // registered the documents, and the inline form resolves from them.
    expect(lookupSchemaDocument(rootHash)).toBeDefined();
    const inline = readResultSchemaMeta(arrived) as JSONSchemaObj;
    expect(inline.$ref).toBeUndefined();
    expect(inline.required).toEqual(["title", "detail"]);
  });

  it("classifies the member's grammar", () => {
    const ref = "cid:fid1:grammar-target";
    expect(classifySchemaMetaValue(undefined)).toEqual({ kind: "absent" });
    expect(classifySchemaMetaValue(null)).toEqual({
      kind: "malformed",
      reason: "the member holds a value that is not a schema",
    });
    const nullableDefault = { type: "null", default: null } as const;
    expect(classifySchemaMetaValue(nullableDefault)).toEqual({
      kind: "inline",
      schema: nullableDefault,
    });
    expect(classifySchemaMetaValue({ $ref: ref })).toEqual({
      kind: "reference",
      ref,
      taggedHash: "fid1:grammar-target",
    });
    expect(classifySchemaMetaValue({ $ref: `${ref}#/$defs/Member` })).toEqual({
      kind: "reference",
      ref: `${ref}#/$defs/Member`,
      taggedHash: "fid1:grammar-target",
      defName: "Member",
    });
    expect(classifySchemaMetaValue(resultSchema)).toEqual({
      kind: "inline",
      schema: resultSchema,
    });
    // The two shapes the grammar excludes: a root reference with sibling
    // keywords, and a reference nested inside an inline schema.
    expect(classifySchemaMetaValue({ $ref: ref, title: "sibling" }).kind)
      .toBe("malformed");
    expect(
      classifySchemaMetaValue({
        type: "object",
        properties: { nested: { $ref: ref } },
      }).kind,
    ).toBe("malformed");
    // A `cid:` string that does not parse names no document at all, at the
    // root or nested; a non-schema value is not inline metadata either.
    expect(classifySchemaMetaValue({ $ref: "cid:" }).kind).toBe("malformed");
    expect(
      classifySchemaMetaValue({
        type: "object",
        properties: { nested: { $ref: `${ref}#/not/a/def` } },
      }).kind,
    ).toBe("malformed");
    expect(classifySchemaMetaValue("not a schema").kind).toBe("malformed");
    expect(classifySchemaMetaValue([{ type: "string" }]).kind).toBe(
      "malformed",
    );
    expect(classifySchemaMetaValue(true)).toEqual({
      kind: "inline",
      schema: true,
    });
  });

  it("throws on a malformed member wherever it is read", () => {
    // State the boundary refuses can still be met by a reader — a store
    // that predates the enforcement, or one written out of band — and
    // every reader treats it as a defect rather than as a schema.
    const hybrid = { $ref: "cid:fid1:hybrid-target", title: "sibling" };
    expect(() => inlineResultSchemaMeta(hybrid)).toThrow(
      MalformedSchemaMetaError,
    );
    expect(() => collectSchemaMetaRefHashes({ schema: hybrid })).toThrow(
      MalformedSchemaMetaError,
    );
    expect(() => recomposeSchemaRefs(hybrid, lookupSchemaDocument)).toThrow(
      MalformedSchemaMetaError,
    );
    expect(() => inlineResultSchemaMeta(null)).toThrow(
      MalformedSchemaMetaError,
    );
    expect(() => collectSchemaMetaRefHashes({ schema: null })).toThrow(
      MalformedSchemaMetaError,
    );
    // The inline and absent forms pass straight through.
    expect(inlineResultSchemaMeta(undefined)).toBeUndefined();
    expect(inlineResultSchemaMeta(resultSchema)).toBe(resultSchema);
    expect(collectSchemaMetaRefHashes({ schema: resultSchema }).size).toBe(0);
  });

  it("refuses a malformed member at write time", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta malformed write",
      undefined,
      tx,
    );
    cell.set({ title: "Ada", detail: { count: 1 } });
    expect(() => writeResultSchemaMeta(cell, null as unknown as JSONSchema))
      .toThrow(MalformedSchemaMetaError);
    expect(() =>
      cell.setMetaRaw(
        "schema",
        {
          type: "object",
          properties: { nested: { $ref: "cid:fid1:nested-target" } },
        },
        rawMetaWriteAuthorization,
      )
    ).toThrow(MalformedSchemaMetaError);
    expect(() =>
      cell.setMetaRaw(
        "schema",
        { $ref: "cid:fid1:sibling-target", title: "sibling" },
        rawMetaWriteAuthorization,
      )
    ).toThrow(MalformedSchemaMetaError);
    // Nothing staged: the refusal came before the write.
    expect(
      [...tx.getWriteDetails?.(space) ?? []].some((detail) =>
        detail.address.path[0] === "schema"
      ),
    ).toBe(false);
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("writes the schema inline with the flag off", async () => {
    await writer.dispose();
    writer = runtimeWith(false);
    const tx = writer.edit();
    const cell = writer.getCell(
      space,
      "result-schema-meta flag off",
      undefined,
      tx,
    );
    writeResultSchemaMeta(cell, resultSchema);
    expect(cell.getMetaRaw("schema")).toEqual(resultSchema);
    expect(readResultSchemaMeta(cell)).toEqual(resultSchema);
    expect((await tx.commit()).error).toBeUndefined();
  });
});
