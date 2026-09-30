import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { deepFreeze } from "@commonfabric/data-model";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  areLinksSame,
  areNormalizedLinksSame,
  areNormalizedLinksSameIgnoringScope,
  createLLMFriendlyLink,
  createSigilLinkFromParsedLink,
  decodeJsonPointer,
  encodeJsonPointer,
  inlineExternalSchemaRefsInValue,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  KeepAsCell,
  type NormalizedLink,
  parseLink,
  parseLinkOrThrow,
  parseLLMFriendlyLink,
  parseReferenceParts,
  sanitizeAndInternSchemaForLinks,
  sanitizeSchemaForLinks,
  schemaForSpaceCrossing,
} from "../src/link-utils.ts";
import { externalRefTo, resolvedSchema } from "./schema-ref-helpers.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Runtime } from "../src/runtime.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-utils", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    resetContentAddressedSchemasConfig();
    tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("schemaForSpaceCrossing()", () => {
    it("recovers after a missing closure arrives and shares the self-contained result", () => {
      const schema = {
        type: "string",
        title: "crossing cache recovery",
      } as const;
      const hash = internSchemaAsTaggedHashString(schema);
      const reference = { $ref: `cid:${hash}` };
      expect(schemaForSpaceCrossing(tx, space, reference)).toBe(false);

      registerSchemaDocument(hash, schema);
      const first = schemaForSpaceCrossing(tx, space, reference);
      expect(first).toEqual(schema);
      expect(schemaForSpaceCrossing(tx, space, { ...reference })).toBe(first);
    });

    it("requires the closure again after the storage manager's registry lease ends", async () => {
      const schema = { type: "number", title: "crossing cache epoch" } as const;
      const hash = internSchemaAsTaggedHashString(schema);
      const reference = { $ref: `cid:${hash}` };
      registerSchemaDocument(hash, schema);
      expect(schemaForSpaceCrossing(tx, space, reference)).toEqual(schema);

      tx.abort();
      await runtime.dispose();
      await storageManager.close();
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
      expect(schemaForSpaceCrossing(tx, space, reference)).toBe(false);
      registerSchemaDocument(hash, schema);
      expect(schemaForSpaceCrossing(tx, space, reference)).toEqual(schema);
    });
  });

  describe("isSigilLink", () => {
    it("should identify a link@1 sigil", () => {
      const link = { "/": { [LINK_V1_TAG]: { id: "of:test", path: [] } } };
      expect(isSigilLink(link)).toBe(true);
    });

    it("should not identify a single-key `/` sigil that isn't a link@1", () => {
      expect(isSigilLink({ "/": { someKey: "someValue" } })).toBe(false);
      expect(isSigilLink({ "/": {} })).toBe(false);
      expect(isSigilLink({ "/": { nested: { deep: "value" } } })).toBe(false);
    });

    it("should not identify objects with `/` and other properties", () => {
      expect(isSigilLink({ "/": { [LINK_V1_TAG]: {} }, otherProp: "v" }))
        .toBe(false);
      expect(isSigilLink({ "/": { key: "value" }, extra: 123 })).toBe(false);
      expect(isSigilLink({ "/": { key: "value" }, "/extra": "value" }))
        .toBe(false);
    });

    it("should not identify objects without a `/` property", () => {
      expect(isSigilLink({ otherProp: "value" })).toBe(false);
      expect(isSigilLink({})).toBe(false);
    });

    it("should not identify objects where `/` is not a record", () => {
      expect(isSigilLink({ "/": "not a record" })).toBe(false);
      expect(isSigilLink({ "/": 123 })).toBe(false);
      expect(isSigilLink({ "/": ["not", "a", "record"] })).toBe(false);
      expect(isSigilLink({ "/": null })).toBe(false);
      expect(isSigilLink({ "/": undefined })).toBe(false);
    });

    it("should not identify non-objects", () => {
      expect(isSigilLink("string")).toBe(false);
      expect(isSigilLink(123)).toBe(false);
      expect(isSigilLink(true)).toBe(false);
      expect(isSigilLink(null)).toBe(false);
      expect(isSigilLink(undefined)).toBe(false);
      expect(isSigilLink([])).toBe(false);
    });
  });

  describe("isCellLink", () => {
    it("should identify query results as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      // Has to be an object, otherwise asQueryResult() returns a literal
      cell.set({ value: 42 });
      const queryResult = cell.getAsQueryResult();
      expect(isCellLink(queryResult)).toBe(true);
    });

    it("should identify cell links as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      const cellLink = cell.getAsLink();
      expect(isCellLink(cellLink)).toBe(true);
    });

    it("should identify cells as links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      expect(isCellLink(cell)).toBe(true);
    });

    it("should not identify EntityId format as links", () => {
      expect(isCellLink({ "/": "of:test" })).toBe(false);
    });

    it("should not identify non-links as links", () => {
      expect(isCellLink("string")).toBe(false);
      expect(isCellLink(123)).toBe(false);
      expect(isCellLink({ notLink: "value" })).toBe(false);
      expect(isCellLink(null)).toBe(false);
      expect(isCellLink(undefined)).toBe(false);
    });
  });

  describe("isWriteRedirectLink", () => {
    it("should identify sigil links with overwrite redirect as write redirect links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: { id: "test", overwrite: "redirect" },
        },
      };
      expect(isWriteRedirectLink(sigilLink)).toBe(true);
    });

    it("should not identify regular sigil links as write redirect links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: { id: "test" },
        },
      };
      expect(isWriteRedirectLink(sigilLink)).toBe(false);
    });

    it("should not identify non-links as write redirect links", () => {
      expect(isWriteRedirectLink("string")).toBe(false);
      expect(isWriteRedirectLink({ notLink: "value" })).toBe(false);
    });
  });

  describe("parseLink", () => {
    it("runtime getCellFromEntityId should accept an explicit scope", () => {
      const cell = runtime.getCellFromEntityId(
        space,
        "scoped-entity",
        [],
        undefined,
        undefined,
        "user",
      );

      expect(cell.getAsNormalizedFullLink()).toMatchObject({
        id: "of:scoped-entity",
        path: [],
        space,
        scope: "user",
      });
    });

    it("should parse cells to normalized links", () => {
      const cell = runtime.getCell(space, "test", undefined, tx);
      cell.set({ value: 42 });
      const result = parseLink(cell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        scope: "space",
        schema: undefined,
      });
    });

    it("should parse cells with paths to normalized links", () => {
      const cell = runtime.getCell<any>(space, "test", undefined, tx);
      cell.set({ nested: { value: 42 } });
      const nestedCell = cell.key("nested");
      const result = parseLink(nestedCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested"],
        space: space,
        scope: "space",
        schema: undefined,
      });
    });

    it("should parse a cell's sigil link to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const result = parseLink(cell.toSigilLinkOrNull(), cell);

      // A sigil-parsed link is DATA-DERIVED: parseLink stamps a
      // read-side `viaLinkHop` so a later read dead-ending at its doc is an
      // unresolved input, not a known absence. Identity + serialization
      // ignore it; the assertions carry it because they compare full output.
      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        scope: "space",
        schema: undefined,
        viaLinkHop: true,
      });
    });

    it("should parse sigil links to normalized links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            schema: { type: "number" },
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        viaLinkHop: true,
      });
    });

    it("should drop a redundant overwrite this when parsing sigil links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            schema: { type: "number" },
            overwrite: "this",
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        viaLinkHop: true,
      });
    });

    it("should parse sigil links with overwrite redirect to normalized links", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:test",
            path: ["nested", "value"],
            space: space,
            schema: { type: "number" },
            overwrite: "redirect",
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        id: "of:test",
        path: ["nested", "value"],
        space: space,
        schema: { type: "number" },
        overwrite: "redirect",
        viaLinkHop: true,
      });
    });

    it("should parse sigil links with relative references", () => {
      const baseCell = runtime.getCell(space, "base");
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
            space: space,
          },
        },
      };
      const result = parseLink(sigilLink, baseCell);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: ["nested", "value"],
        space: space,
        scope: "space",
        schema: undefined,
        viaLinkHop: true,
      });
    });

    it("should parse sigil links with relative references and not add id, space or schema if not present in the link", () => {
      const sigilLink = {
        "/": {
          [LINK_V1_TAG]: {
            path: ["nested", "value"],
          },
        },
      };
      const result = parseLink(sigilLink);

      expect(result).toEqual({
        path: ["nested", "value"],
        viaLinkHop: true,
      });

      // Don't allow `id: undefined`, etc.
      expect("id" in result!).toBe(false);
      expect("space" in result!).toBe(false);
      expect("schema" in result!).toBe(false);
    });

    it("should parse cell links to normalized links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsLink();
      const result = parseLink(cellLink);

      expect(result).toEqual({
        id: expect.stringContaining("of:"),
        path: [],
        space: space,
        scope: "space",
        schema: undefined,
        viaLinkHop: true,
      });
    });

    it("returns `undefined` for an `$alias` record in data", () => {
      const cell = runtime.getCell(space, "test");
      expect(
        parseLink({
          $alias: {
            cell: cell.entityId,
            path: ["nested", "value"],
            schema: { type: "number" },
          },
        }, cell),
      ).toBeUndefined();
    });

    it("should return undefined for non-link values", () => {
      expect(parseLink("string")).toBeUndefined();
      expect(parseLink(123)).toBeUndefined();
      expect(parseLink({ notLink: "value" })).toBeUndefined();
    });
  });

  describe("parseLinkOrThrow", () => {
    it("should return parsed link for valid links", () => {
      const cell = runtime.getCell(space, "test");
      const result = parseLinkOrThrow(cell);
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    it("should throw error for non-link values", () => {
      expect(() => parseLinkOrThrow("string")).toThrow(
        "Cannot parse value as link",
      );
      expect(() => parseLinkOrThrow(123)).toThrow("Cannot parse value as link");
    });

    it("should not crash on BigInt values when formatting the error", () => {
      // The error message is formatted with `toCompactDebugString`, which
      // handles BigInt safely; `JSON.stringify(value)` would throw on BigInt
      // and mask the original "not a link" failure.
      expect(() => parseLinkOrThrow(123n as unknown as never)).toThrow(
        "Cannot parse value as link",
      );
    });
  });

  describe("areLinksSame", () => {
    it("should return true for identical objects", () => {
      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, cell)).toBe(true);
    });

    it("should return true for equivalent links", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink1 = cell.getAsLink();
      const cellLink2 = cell.getAsLink();
      expect(areLinksSame(cellLink1, cellLink2)).toBe(true);
    });

    it("should return true for different link formats pointing to same location", () => {
      const cell = runtime.getCell(space, "test");
      const cellLink = cell.getAsWriteRedirectLink();
      const sigilLink = cell.getAsLink();
      expect(areLinksSame(cellLink, sigilLink)).toBe(true);
    });

    it("should return false for different links", () => {
      const cell1 = runtime.getCell(space, "test1");
      const cell2 = runtime.getCell(space, "test2");
      expect(areLinksSame(cell1, cell2)).toBe(false);
    });

    it("should return false for link vs non-link", () => {
      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, "string")).toBe(false);
    });

    it("should handle null/undefined values", () => {
      expect(areLinksSame(null, null)).toBe(true);
      expect(areLinksSame(undefined, undefined)).toBe(false);
      expect(areLinksSame(null, undefined)).toBe(false);

      const cell = runtime.getCell(space, "test");
      expect(areLinksSame(cell, null)).toBe(false);
      expect(areLinksSame(null, cell)).toBe(false);
    });
  });

  describe("createSigilLinkFromParsedLink", () => {
    it("should create sigil link from normalized link", () => {
      // Reference emission is flag-gated; this pin opts in explicitly so
      // it holds whatever the build's default is.
      setContentAddressedSchemasConfig(true);
      try {
        const normalizedLink: NormalizedLink = {
          id: "of:test",
          path: ["nested", "value"],
          space: space,
          schema: { type: "number" },
        };

        const result = createSigilLinkFromParsedLink(normalizedLink, {
          includeSchema: true,
        });

        expect(result).toEqual({
          "/": {
            [LINK_V1_TAG]: {
              id: "of:test",
              path: ["nested", "value"],
              space: space,
              schema: externalRefTo({ type: "number" }),
            },
          },
        });
      } finally {
        resetContentAddressedSchemasConfig();
      }
    });

    it("serializes scoped links and parses inherited link scope from the base", () => {
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested"],
        space,
        scope: "session",
      };

      const result = createSigilLinkFromParsedLink(normalizedLink);
      expect(linkRefPayload(result).scope).toBe("session");

      expect(parseLink(result, {
        id: "of:base",
        path: [],
        space,
        scope: "user",
      })).toEqual({
        id: "of:test",
        path: ["nested"],
        space,
        scope: "session",
        viaLinkHop: true,
      });

      expect(parseLink({
        "/": {
          [LINK_V1_TAG]: {
            id: "of:relative",
            path: [],
          },
        },
      }, {
        id: "of:base",
        path: [],
        space,
        scope: "user",
      })).toEqual({
        id: "of:relative",
        path: [],
        space,
        scope: "user",
        viaLinkHop: true,
      });
    });

    it("includes scope in normal equality but exposes scope-insensitive equality for cause generation", () => {
      const userLink: NormalizedLink = {
        id: "of:test",
        path: ["value"],
        space,
        scope: "user",
      };
      const sessionLink: NormalizedLink = {
        ...userLink,
        scope: "session",
      };

      expect(areNormalizedLinksSame(userLink, sessionLink)).toBe(false);
      expect(areNormalizedLinksSameIgnoringScope(userLink, sessionLink)).toBe(
        true,
      );
    });

    it("should omit space when same as base", () => {
      const baseCell = runtime.getCell(space, "base");
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        space: space,
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, {
        base: baseCell,
      });

      expect(linkRefPayload(result).space).toBeUndefined();
    });

    it("should omit id when same as base", () => {
      const baseCell = runtime.getCell(space, "base");
      const baseId = baseCell.getAsNormalizedFullLink().id;
      const normalizedLink: NormalizedLink = {
        id: `of:${baseId}`,
        path: ["nested", "value"],
      };

      const result = createSigilLinkFromParsedLink(normalizedLink, {
        base: baseCell,
      });

      expect(linkRefPayload(result).id).toBe(`of:${baseId}`);
    });

    it("should include overwrite field when present", () => {
      const normalizedLink: NormalizedLink = {
        id: "of:test",
        path: ["nested", "value"],
        overwrite: "redirect",
      };

      const result = createSigilLinkFromParsedLink(normalizedLink);

      expect(linkRefPayload(result).overwrite).toBe("redirect");
    });

    it("should preserve stream cell schemas by default when including schema", () => {
      const schema = {
        type: "object",
        properties: {
          title: { type: "string" },
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
            asCell: ["stream"],
          },
        },
        required: ["title", "setTitle"],
      } as const satisfies JSONSchema;

      const result = createSigilLinkFromParsedLink({
        id: "of:stream-schema",
        path: [],
        space,
        schema,
      }, { includeSchema: true });

      expect(resolvedSchema(linkRefPayload(result).schema)).toEqual(
        schema,
      );
    });

    it("should strip stream cell schemas from links when requested", () => {
      const schema = {
        type: "object",
        properties: {
          title: { type: "string" },
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
            asCell: ["stream"],
          },
        },
        required: ["title", "setTitle"],
      } as const satisfies JSONSchema;

      const result = createSigilLinkFromParsedLink({
        id: "of:stream-schema",
        path: [],
        space,
        schema,
      }, { includeSchema: true, keepAsCell: KeepAsCell.None });

      expect(resolvedSchema(linkRefPayload(result).schema)).toEqual({
        type: "object",
        properties: {
          title: { type: "string" },
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        },
        required: ["title"],
      });
    });

    it("externalizes each sanitization mode for one frozen schema", () => {
      setContentAddressedSchemasConfig(true);
      const schema = deepFreeze(
        {
          type: "object",
          properties: {
            send: {
              type: "string",
              asCell: ["stream"],
            },
          },
          required: ["send"],
        } as const satisfies JSONSchema,
      );
      const link = {
        id: "of:cached-schema",
        path: [],
        space,
        schema,
      } as const;

      const kept = createSigilLinkFromParsedLink(link, {
        includeSchema: true,
      });
      const stripped = createSigilLinkFromParsedLink(link, {
        includeSchema: true,
        keepAsCell: KeepAsCell.None,
      });

      expect(resolvedSchema(linkRefPayload(kept).schema)).toEqual(schema);
      expect(resolvedSchema(linkRefPayload(stripped).schema)).toEqual({
        type: "object",
        properties: {
          send: { type: "string" },
        },
      });
    });

    it("re-registers cached schema documents after an epoch change", async () => {
      setContentAddressedSchemasConfig(true);
      const schema = deepFreeze(
        {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        } as const satisfies JSONSchema,
      );
      const link = {
        id: "of:cached-schema-epoch",
        path: [],
        space,
        schema,
      } as const;

      const first = createSigilLinkFromParsedLink(link, {
        includeSchema: true,
      });
      expect(resolvedSchema(linkRefPayload(first).schema)).toEqual(schema);

      tx.abort();
      await runtime.dispose();
      await storageManager.close();
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();

      const second = createSigilLinkFromParsedLink(link, {
        includeSchema: true,
      });
      expect(resolvedSchema(linkRefPayload(second).schema)).toEqual(schema);
    });
  });

  describe("inlineExternalSchemaRefsInValue", () => {
    it("carries a link whose schema is boolean through unchanged", () => {
      // The inliner touches only object schemas carrying an external
      // reference. A boolean schema is a valid carried schema and not a
      // reference, so the value rides through as it is.
      const sigil = {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:boolean-schema-target",
            path: [],
            schema: true,
          },
        },
      };
      const value = { entry: sigil };
      expect(inlineExternalSchemaRefsInValue(value)).toEqual(value);
    });
  });

  describe("sanitizeSchemaForLinks through references", () => {
    for (const position of ["root", "nested"]) {
      it(`revisits canonical bindings when a ${position} schema arrives`, () => {
        setContentAddressedSchemasConfig(true);
        const document: JSONSchema = { type: "string", asCell: ["cell"] };
        const hash = internSchemaAsTaggedHashString(document);
        const schema: JSONSchema = deepFreeze(
          position === "root" ? { $ref: `cid:${hash}` } : {
            type: "object",
            properties: { name: { $ref: `cid:${hash}` } },
          },
        );
        const before = sanitizeAndInternSchemaForLinks(schema);
        expect(before).toEqual(schema);
        // Exercise the next link-emission pass on the canonical result while
        // the declaration is still missing too.
        const missing = createSigilLinkFromParsedLink({
          id: "of:late-schema",
          path: [],
          schema: before,
        }, { includeSchema: true });
        expect(missing).toBeDefined();
        registerSchemaDocument(hash, document);
        const after = sanitizeAndInternSchemaForLinks(schema);
        expect(after).not.toBe(before);
        const emitted = createSigilLinkFromParsedLink({
          id: "of:late-schema",
          path: [],
          schema: before,
        }, { includeSchema: true });
        const emittedSchema = linkRefPayload(emitted).schema;
        expect(JSON.stringify(resolvedSchema(emittedSchema as JSONSchema)))
          .not.toContain("asCell");
        expect(JSON.stringify(resolvedSchema(after!))).not.toContain("asCell");
      });
    }

    it("re-externalizes a nested document the strip changed", () => {
      // Document B carries the marker; document A reaches it only by
      // reference. A sanitize that stops at the reference looks clean and
      // is not: the first reader to resolve B rediscovers the marker and
      // mints a handle where a plain value is expected. The node must stay
      // a reference, so the strip moves its target instead of inlining.
      const documentB = {
        type: "string",
        asCell: ["cell"],
      } as unknown as JSONSchema;
      const hashB = internSchemaAsTaggedHashString(documentB);
      registerSchemaDocument(hashB, documentB);
      const documentA = {
        type: "object",
        properties: { name: { $ref: `cid:${hashB}` } },
      } as unknown as JSONSchema;
      const hashA = internSchemaAsTaggedHashString(documentA);
      registerSchemaDocument(hashA, documentA);

      const sanitized = sanitizeSchemaForLinks(
        { $ref: `cid:${hashA}` } as unknown as JSONSchema,
      ) as { properties: { name: { $ref?: string } } };

      // The root resolves inline (re-externalized at the emission site);
      // the nested position stays a REFERENCE — callers pin the served
      // shape — moved off the tainted document.
      const movedRef = sanitized.properties.name.$ref;
      expect(typeof movedRef).toBe("string");
      expect(movedRef).not.toBe(`cid:${hashB}`);
      // The whole reachable closure is now marker-free.
      const resolvedTarget = resolvedSchema(
        sanitized.properties.name as JSONSchema,
      );
      expect(JSON.stringify(resolvedTarget)).not.toContain("asCell");
      expect((resolvedTarget as { type?: string }).type).toBe("string");
    });

    it("keeps a reference to a clean document verbatim", () => {
      const cleanDoc = {
        type: "string",
        title: "already-clean",
      } as unknown as JSONSchema;
      const hashClean = internSchemaAsTaggedHashString(cleanDoc);
      registerSchemaDocument(hashClean, cleanDoc);
      const container = {
        type: "object",
        properties: { note: { $ref: `cid:${hashClean}` } },
      } as unknown as JSONSchema;
      const hashContainer = internSchemaAsTaggedHashString(container);
      registerSchemaDocument(hashContainer, container);

      const sanitized = sanitizeSchemaForLinks(
        { $ref: `cid:${hashContainer}` } as unknown as JSONSchema,
      ) as { properties: { note: { $ref?: string } } };

      expect(sanitized.properties.note.$ref).toBe(`cid:${hashClean}`);
    });
  });

  describe("stripAsCellAndStreamFromSchema", () => {
    it("shares canonical sanitized schemas without sharing mutable roots", () => {
      const schema: JSONSchema = deepFreeze({
        type: "object",
        properties: { name: { type: "string", asCell: ["cell"] } },
      });
      for (const mode of Object.values(KeepAsCell)) {
        const first = sanitizeAndInternSchemaForLinks(schema, mode);
        const second = sanitizeAndInternSchemaForLinks(schema, mode);
        expect(first).toEqual(sanitizeSchemaForLinks(schema, mode));
        expect(second).toBe(first);
        expect(Object.isFrozen(first)).toBe(true);
        const mutable = sanitizeSchemaForLinks(schema, mode);
        expect(mutable).not.toBe(first);
        expect(Object.isFrozen(mutable)).toBe(false);
      }
    });

    it("interns a mutable input without freezing it or caching later edits", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string", title: "before" } },
      } satisfies JSONSchema;
      const first = sanitizeAndInternSchemaForLinks(schema);
      expect(Object.isFrozen(schema)).toBe(false);
      expect(Object.isFrozen(schema.properties.name)).toBe(false);
      schema.properties.name.title = "after";
      const second = sanitizeAndInternSchemaForLinks(schema);
      expect(second).not.toBe(first);
      expect(first).toEqual({
        type: "object",
        properties: { name: { type: "string", title: "before" } },
      });
      expect(second).toEqual(schema);
      for (const primitive of [undefined, true, false]) {
        expect(sanitizeAndInternSchemaForLinks(primitive)).toBe(primitive);
      }
    });

    it("memoizes a frozen input per keepAsCell mode, handing out a fresh top that shares the cached sub-tree", () => {
      // The memo only engages for deep-frozen inputs (a mutable input's identity
      // could go stale), so it no-ops for the non-frozen literals other tests
      // pass. On a repeat it must return a FRESH top-level object (the reactive
      // graph keys on the sanitized schema's identity — a shared top changes
      // recomputation), while reusing the cached stripped sub-tree (⇒ memo hit,
      // no recompute).
      const schema = deepFreeze({
        type: "object",
        properties: { name: { type: "string", asCell: ["cell"] } },
      }) as JSONSchema;

      const noneA = sanitizeSchemaForLinks(schema, KeepAsCell.None) as {
        properties: Record<string, JSONSchema>;
      };
      const noneB = sanitizeSchemaForLinks(schema, KeepAsCell.None) as {
        properties: Record<string, JSONSchema>;
      };
      expect(noneB).not.toBe(noneA); // fresh top-level object each call
      expect(noneB.properties).toBe(noneA.properties); // cached sub-tree reused
      expect(noneA.properties.name).toEqual({ type: "string" }); // asCell stripped

      // The shared sub-tree is deep-frozen: a consumer mutating a nested node
      // throws loudly instead of silently poisoning every later same-schema
      // build. The handed-out top itself stays caller-mutable (fresh per call).
      expect(Object.isFrozen(noneA.properties)).toBe(true);
      expect(Object.isFrozen(noneA.properties.name)).toBe(true);
      expect(() => {
        (noneA.properties.name as { type?: string }).type = "mutated";
      }).toThrow(TypeError);
      expect(Object.isFrozen(noneB)).toBe(false);

      // A different keepAsCell mode is cached separately (asCell kept here).
      const allA = sanitizeSchemaForLinks(schema, KeepAsCell.All) as {
        properties: Record<string, JSONSchema>;
      };
      expect(allA.properties.name).toEqual({
        type: "string",
        asCell: ["cell"],
      });
    });

    it("does not cross-contaminate different frozen inputs", () => {
      const s1 = deepFreeze({ type: "string", asCell: ["cell"] }) as JSONSchema;
      const s2 = deepFreeze({ type: "number", asCell: ["cell"] }) as JSONSchema;
      const o1 = sanitizeSchemaForLinks(s1, KeepAsCell.None);
      const o2 = sanitizeSchemaForLinks(s2, KeepAsCell.None);
      expect(o1).not.toBe(o2);
      expect(o1).toEqual({ type: "string" });
      expect(o2).toEqual({ type: "number" });
    });

    it("should remove asCell from simple schema", () => {
      const schema = {
        type: "object",
        asCell: ["cell"],
        properties: {
          name: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
        },
      });
    });

    it("should remove asCell from nested properties", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            asCell: ["cell"],
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                asCell: ["stream"],
                properties: {
                  theme: { type: "string" },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                properties: {
                  theme: { type: "string" },
                },
              },
            },
          },
        },
      });
    });

    it("does not promote stripped asCell entry scope to schema scope", () => {
      // The scope of an asCell value belongs to the link to its target (the
      // link carries its own scope) and acts as a follow cap. It must NOT be
      // promoted onto the stripped schema's top-level `scope`: doing so makes it
      // look like an authored container scope, which then gets stamped onto the
      // container link on reads and addresses the wrong scoped instance.
      const schema = {
        type: "object",
        properties: {
          rack: {
            type: "array",
            items: { type: "string" },
            asCell: [{ kind: "cell", scope: "user" }],
          },
          message: {
            type: "string",
            asCell: [{ kind: "cell", scope: "session" }],
          },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          rack: {
            type: "array",
            items: { type: "string" },
          },
          message: {
            type: "string",
          },
        },
      });
    });

    it("should remove required entries for stripped stream properties", () => {
      const schema = {
        type: "object",
        properties: {
          title: { type: "string" },
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
            asCell: ["stream"],
          },
        },
        required: ["title", "setTitle"],
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          title: { type: "string" },
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        },
        required: ["title"],
      });
    });

    it("keeps required entries for boolean property schemas", () => {
      const schema = {
        type: "object",
        properties: {
          payload: true,
          submit: {
            type: "object",
            asCell: ["stream"],
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["payload", "submit"],
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          payload: true,
          submit: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["payload"],
      });
    });

    it("should keep required entries for preserved stream properties", () => {
      const schema = {
        type: "object",
        properties: {
          setTitle: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
            asCell: ["stream"],
          },
        },
        required: ["setTitle"],
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema, KeepAsCell.OnlyStream);

      expect(result).toEqual(schema);
    });

    it("retains only an explicitly marked scoped pattern-result cell", () => {
      const schema = {
        type: "object",
        properties: {
          ordinary: {
            type: "number",
            asCell: [{ kind: "cell", scope: "user" }],
          },
          retained: {
            type: "number",
            asCell: ["cell"],
            scope: "user",
            __ctPreservePatternResultCell: true,
          },
        },
        required: ["ordinary", "retained"],
      } as const;

      expect(sanitizeSchemaForLinks(schema, KeepAsCell.OnlyStream)).toEqual({
        type: "object",
        properties: {
          ordinary: { type: "number" },
          retained: {
            type: "number",
            asCell: ["cell"],
            scope: "user",
          },
        },
        required: ["ordinary", "retained"],
      });
      expect(sanitizeSchemaForLinks(schema, KeepAsCell.All)).toEqual({
        type: "object",
        properties: {
          ordinary: {
            type: "number",
            asCell: [{ kind: "cell", scope: "user" }],
          },
          retained: {
            type: "number",
            asCell: ["cell"],
            scope: "user",
          },
        },
        required: ["ordinary", "retained"],
      });
    });

    it("respects KeepAsCell modes for mixed cell wrappers", () => {
      const schema = {
        type: "object",
        asCell: ["stream", "cell"],
        properties: {
          title: { type: "string" },
          count: {
            type: "number",
            asCell: [{ kind: "cell", scope: "user" }],
          },
          submit: {
            type: "object",
            asCell: ["stream"],
            properties: {
              value: { type: "string", asCell: ["opaque"] },
            },
            required: ["value"],
          },
          nestedStream: {
            type: "object",
            asCell: ["cell", "stream"],
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["title", "count", "submit", "nestedStream"],
      } as const satisfies JSONSchema;

      expect(sanitizeSchemaForLinks(schema, KeepAsCell.None)).toEqual({
        type: "object",
        properties: {
          title: { type: "string" },
          count: { type: "number" },
          submit: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
          nestedStream: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["title", "count"],
      });

      expect(sanitizeSchemaForLinks(schema, KeepAsCell.OnlyStream)).toEqual({
        type: "object",
        asCell: ["stream", "cell"],
        properties: {
          title: { type: "string" },
          count: { type: "number" },
          submit: {
            type: "object",
            asCell: ["stream"],
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
          nestedStream: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        required: ["title", "count", "submit", "nestedStream"],
      });

      expect(sanitizeSchemaForLinks(schema, KeepAsCell.All)).toEqual(schema);
    });

    it("should handle arrays of schemas", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              asCell: ["cell"],
            },
          },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      });
    });

    it("should handle anyOf arrays", () => {
      const schema = {
        type: "object",
        anyOf: [
          { type: "string", asCell: ["cell"] },
          { type: "number", asCell: ["stream"] },
        ],
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        anyOf: [
          { type: "string" },
          { type: "number" },
        ],
      });
    });

    it("should handle additionalProperties", () => {
      const schema = {
        type: "object",
        additionalProperties: {
          type: "string",
          asCell: ["cell"],
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).toEqual({
        type: "object",
        additionalProperties: {
          type: "string",
        },
      });
    });

    it("should not mutate the original schema", () => {
      const originalSchema = {
        type: "object",
        asCell: ["cell"],
        properties: {
          name: { type: "string", asCell: ["stream"] },
        },
      } as const satisfies JSONSchema;

      const result = sanitizeSchemaForLinks(originalSchema);

      // Original should be unchanged
      expect(originalSchema.asCell).toEqual(["cell"]);
      expect(originalSchema.properties.name.asCell).toEqual(["stream"]);

      // Result should have flags removed
      expect(result).not.toHaveProperty("asCell");
      expect((result as any).properties.name).not.toHaveProperty("asCell");
    });

    it("should handle circular schema references without stack overflow", () => {
      // Create a circular schema like Record pattern has
      const schema: any = {
        type: "object",
        asCell: ["cell"],
        properties: {
          name: { type: "string" },
          subPieces: {
            type: "array",
            items: {
              type: "object",
              properties: {
                schema: {} as any, // Will be set to parent schema
              },
            },
          },
        },
      };
      // Create the circular reference
      schema.properties.subPieces.items.properties.schema = schema;

      // This should not throw a stack overflow
      const result = sanitizeSchemaForLinks(schema);

      // Should have removed asCell from top level
      expect(result).not.toHaveProperty("asCell");
      // Should have processed nested properties
      expect((result as any).properties.name.type).toBe("string");
      // The result is JSON-serializable without exponential growth.
      expect(() => JSON.stringify(result)).not.toThrow();
      // The circular reference should use $ref
      const schemaRef = (result as any).properties.subPieces.items.properties
        .schema;
      expect(schemaRef.$ref).toBeDefined();
      expect(schemaRef.$ref).toMatch(/^#\/\$defs\//);
    });

    it("should handle direct self-reference cycle with $ref", () => {
      const schema: any = {
        type: "object",
        asCell: ["cell"],
      };
      schema.self = schema;
      const result = sanitizeSchemaForLinks(schema);

      // Top level asCell ["cell"] flags should be removed
      expect(result).not.toHaveProperty("asCell");
      const schema2: any = {
        type: "object",
        asCell: ["stream"],
      };
      schema.self = schema;
      const result2 = sanitizeSchemaForLinks(schema2);

      // Top level asCell ["stream"] flags should be removed
      expect(result2).not.toHaveProperty("asCell");

      // Cycle reference should be replaced with $ref
      expect((result as any).self.$ref).toBeDefined();
      expect((result as any).self.$ref).toMatch(/^#\/\$defs\//);
      // Result should have $defs section with the circular schema
      expect((result as any).$defs).toBeDefined();
      // Result should be JSON-serializable (no circular object references)
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle three-way cycle (A → B → C → A) with $ref", () => {
      const a: any = { type: "a", asCell: ["cell"], next: null };
      const b: any = { type: "b", asCell: ["stream"], next: null };
      const c: any = { type: "c", asCell: ["cell"], next: null };
      a.next = b;
      b.next = c;
      c.next = a;

      const result = sanitizeSchemaForLinks(a);

      // All flags should be removed in the processed chain
      expect(result).not.toHaveProperty("asCell");
      expect((result as any).next).not.toHaveProperty("asStream");
      expect((result as any).next.next).not.toHaveProperty("asCell");
      // The cycle back should be a $ref
      expect((result as any).next.next.next.$ref).toBeDefined();
      expect((result as any).next.next.next.$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycle through array items with $ref", () => {
      const schema: any = {
        type: "array",
        asCell: ["cell"],
        items: null,
      };
      schema.items = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).not.toHaveProperty("asCell");
      // Cycle reference should be a $ref
      expect((result as any).items.$ref).toBeDefined();
      expect((result as any).items.$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycle through anyOf with $ref", () => {
      const schema: any = {
        type: "object",
        asCell: ["cell"],
        anyOf: [{ type: "string" }, null],
      };
      schema.anyOf[1] = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).not.toHaveProperty("asCell");
      expect((result as any).anyOf[0].type).toBe("string");
      // Cycle reference should be a $ref
      expect((result as any).anyOf[1].$ref).toBeDefined();
      expect((result as any).anyOf[1].$ref).toMatch(/^#\/\$defs\//);
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle multiple independent cycles", () => {
      const cycle1: any = { type: "cycle1", asCell: ["cell"] };
      cycle1.self = cycle1;
      const cycle2: any = { type: "cycle2", asCell: ["stream"] };
      cycle2.self = cycle2;
      const schema: any = { a: cycle1, b: cycle2 };

      const result = sanitizeSchemaForLinks(schema);

      expect((result as any).a).not.toHaveProperty("asCell");
      expect((result as any).b).not.toHaveProperty("asCell");
    });

    it("should handle OnlyStream option with circular schemas", () => {
      const schema: any = {
        type: "object",
        asCell: ["stream"],
      };
      schema.self = schema;

      const result = sanitizeSchemaForLinks(schema, KeepAsCell.OnlyStream);

      // Expect the new version of asStream (where it's an entry in asCell)
      expect((result as any).asCell).toEqual(["stream"]);
      // asStream should be gone
      expect(result).not.toHaveProperty("asStream");
    });

    it("should handle shared references (diamond pattern) correctly", () => {
      // Test that same object referenced from multiple places is handled
      const shared: any = { type: "shared", asCell: ["cell"] };
      const schema: any = {
        left: { path: shared },
        right: { path: shared },
      };

      const result = sanitizeSchemaForLinks(schema);

      // First encounter should strip asCell
      expect((result as any).left.path).not.toHaveProperty("asCell");
      // Second encounter returns the same processed result (consistent!)
      expect((result as any).right.path).toBe((result as any).left.path);
      expect((result as any).right.path).not.toHaveProperty("asCell");
    });

    it("should process schemas inside existing $defs", () => {
      // Schemas inside `$defs` have `asCell` stripped too.
      const schema: any = {
        type: "object",
        $defs: {
          MyType: {
            type: "string",
            asCell: ["cell"],
          },
          NestedType: {
            type: "object",
            properties: {
              nested: { asCell: ["cell"] },
            },
          },
        },
        $ref: "#/$defs/MyType",
      };

      const result = sanitizeSchemaForLinks(schema);

      // $defs schemas should have asCell/asStream stripped
      expect((result as any).$defs.MyType).not.toHaveProperty("asCell");
      expect((result as any).$defs.MyType.type).toBe("string");
      // Nested properties too
      expect(
        (result as any).$defs.NestedType.properties.nested,
      ).not.toHaveProperty("asCell");
      // $ref should be preserved
      expect((result as any).$ref).toBe("#/$defs/MyType");
    });

    it("should avoid name collisions with existing $defs", () => {
      // Generated names do not overwrite existing `$defs`.
      const schema: any = {
        type: "object",
        $defs: {
          CircularSchema_0: { type: "string", description: "user-defined" },
          CircularSchema_1: { type: "number", description: "user-defined" },
        },
      };
      // Create a cycle that would normally generate CircularSchema_0
      schema.self = schema;

      const result = sanitizeSchemaForLinks(schema);

      // User's definitions should be preserved
      expect((result as any).$defs.CircularSchema_0.description).toBe(
        "user-defined",
      );
      expect((result as any).$defs.CircularSchema_1.description).toBe(
        "user-defined",
      );
      // The cycle should use a different name (CircularSchema_2 or higher)
      expect((result as any).self.$ref).toBeDefined();
      const refName = (result as any).self.$ref.replace("#/$defs/", "");
      expect(refName).not.toBe("CircularSchema_0");
      expect(refName).not.toBe("CircularSchema_1");
      // Result should be JSON-serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycles through oneOf", () => {
      const schema: any = {
        type: "object",
        asCell: ["cell"],
        oneOf: [{ type: "null" }, null],
      };
      schema.oneOf[1] = schema;

      const result = sanitizeSchemaForLinks(schema);

      expect(result).not.toHaveProperty("asCell");
      expect((result as any).oneOf[0].type).toBe("null");
      expect((result as any).oneOf[1].$ref).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle cycles through allOf", () => {
      const schema: any = {
        type: "object",
        asCell: ["stream"],
        allOf: [{ type: "object" }, null],
      };
      schema.allOf[1] = { properties: { nested: schema } };

      const result = sanitizeSchemaForLinks(schema);

      expect(result).not.toHaveProperty("asCell");
      expect((result as any).allOf[1].properties.nested.$ref).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle $defs with internal cycles", () => {
      // A definition that references itself
      const myDef: any = { type: "object", asCell: ["cell"] };
      myDef.properties = { child: myDef };

      const schema: any = {
        type: "object",
        $defs: {
          MyRecursiveDef: myDef,
        },
        $ref: "#/$defs/MyRecursiveDef",
      };

      const result = sanitizeSchemaForLinks(schema);

      // asCell should be stripped
      expect((result as any).$defs.MyRecursiveDef).not.toHaveProperty("asCell");
      // The internal cycle should be converted to $ref
      expect(
        (result as any).$defs.MyRecursiveDef.properties.child.$ref,
      ).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("should handle keepAsOpaque option", () => {
      const schema: any = {
        type: "object",
        asCell: ["opaque"],
      };

      // By default, asCell should be removed
      const resultDefault = sanitizeSchemaForLinks(schema);
      expect(resultDefault).not.toHaveProperty("asCell");

      // With keepAsCell: All, it should be preserved
      const resultKept = sanitizeSchemaForLinks(schema, KeepAsCell.All);
      expect((resultKept as any).asCell).toEqual(["opaque"]);
    });
  });

  describe("JSON Pointer Utils", () => {
    it("should encode JSON Pointer", () => {
      expect(encodeJsonPointer(["foo", "bar"])).toBe("foo/bar");
      expect(encodeJsonPointer(["foo/bar", "baz~qux"])).toBe(
        "foo~1bar/baz~0qux",
      );
      expect(encodeJsonPointer([])).toBe("");
    });

    it("should decode JSON Pointer", () => {
      expect(decodeJsonPointer("foo/bar")).toEqual(["foo", "bar"]);
      expect(decodeJsonPointer("foo~1bar/baz~0qux")).toEqual([
        "foo/bar",
        "baz~qux",
      ]);
      expect(decodeJsonPointer("")).toEqual([""]);
    });
  });

  describe("parseLLMFriendlyLink", () => {
    const longId = "of:bafyabc12345678901234567890";

    it("should parse valid LLM friendly link", () => {
      const link = `/${longId}/path/to/cell`;
      const result = parseLLMFriendlyLink(link, space);

      expect(result).toEqual({
        id: longId,
        path: ["path", "to", "cell"],
        space: space,
      });
    });

    it("should parse scope suffixes on the handle segment", () => {
      const link = `/${longId}@user/path/to/cell`;
      const result = parseLLMFriendlyLink(link, space);

      expect(result).toEqual({
        id: longId,
        path: ["path", "to", "cell"],
        space: space,
        scope: "user",
      });
    });

    it("should parse scope suffixes on cross-space handles", () => {
      const otherSpace = "did:key:z6MkrX123abc";
      const link = `/@${otherSpace}/${longId}@session/path`;
      const result = parseLLMFriendlyLink(link, space);

      expect(result).toEqual({
        id: longId,
        path: ["path"],
        space: otherSpace,
        scope: "session",
      });
    });

    it("should reject invalid scope suffixes on the handle segment", () => {
      expect(() => parseLLMFriendlyLink(`/${longId}@any/path`, space)).toThrow(
        /Invalid scope suffix/,
      );
      expect(parseLLMFriendlyLink(`/${longId}@inherit/path`, space).scope)
        .toBe("space");
      expect(() => parseLLMFriendlyLink(`/${longId}@/path`, space)).toThrow(
        /Invalid scope suffix/,
      );
    });

    it("should parse link without space if optional", () => {
      const link = `/${longId}/path`;
      const result = parseLLMFriendlyLink(link);

      expect(result).toEqual({
        id: longId,
        path: ["path"],
      });
    });

    it("should throw if target does not start with slash", () => {
      expect(() => parseLLMFriendlyLink(`${longId}/path`, space)).toThrow(
        "Target must include a piece handle",
      );
    });

    it("should throw if target does not include handle", () => {
      expect(() => parseLLMFriendlyLink("/path/only", space)).toThrow(
        "Target must include a piece handle",
      );
    });

    it("should throw a controlled error if cross-space target omits handle", () => {
      expect(() => parseLLMFriendlyLink("/@did:key:z6MkrX123abc", space))
        .toThrow(
          "Target must include a piece handle",
        );
    });

    it("should throw if handle is too short (human name)", () => {
      expect(() => parseLLMFriendlyLink("/of:short/path", space)).toThrow(
        /Piece references must use handles.*"of:short"/,
      );
    });

    it("should throw if the embedded space is a name rather than a DID", () => {
      // A link resolves from the string alone, so a space that needs looking
      // up is refused here even though the grammar admits it.
      expect(() => parseLLMFriendlyLink(`//my-space/${longId}`, space))
        .toThrow(/Link spaces must be DIDs.*"my-space"/);
    });
  });

  describe("parseReferenceParts", () => {
    const longId = "of:bafyabc12345678901234567890";

    it("splits the parts without holding either to a form", () => {
      // The wider vocabulary a session can resolve: a space by name and a
      // piece by slug, in the positions a DID and a handle occupy.
      expect(parseReferenceParts("//my-space/tracker@user/items/0")).toEqual({
        id: "tracker",
        scope: "user",
        space: "my-space",
        path: ["items", "0"],
      });
      expect(parseReferenceParts(`/${longId}/path`)).toEqual({
        id: longId,
        path: ["path"],
      });
    });

    it("throws for a string that is not a reference at all", () => {
      expect(() => parseReferenceParts(`${longId}/path`)).toThrow(
        "requires a context piece",
      );
      expect(() => parseReferenceParts(`/@${space}`)).toThrow(
        "Target must include a piece handle",
      );
      expect(() => parseReferenceParts("/@/tracker")).toThrow(
        "Invalid space",
      );
    });
  });

  describe("createLLMFriendlyLink", () => {
    const longId = "of:bafyabc12345678901234567890";

    it("round-trips trailing whitespace as part of the final path key", () => {
      const link = {
        id: longId,
        space,
        scope: "space" as const,
        path: ["..", "a#argument "],
      } as const;
      expect(parseLLMFriendlyLink(createLLMFriendlyLink(link), space)).toEqual(
        link,
      );
    });

    it("should create LLM friendly link from normalized link", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path", "to", "cell"],
        space: space,
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`//${space}/${longId}@space/path/to/cell`);
    });

    it("should create LLM friendly links with non-space scope suffixes", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path"],
        space: space,
        scope: "user",
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`//${space}/${longId}@user/path`);
    });

    it("omits the base scope when a context space is supplied", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path"],
        space: space,
        scope: "space",
      };
      const result = createLLMFriendlyLink(link as any, space);

      expect(result).toBe(`/${longId}/path`);
    });

    it("should handle empty path", () => {
      const link: NormalizedLink = {
        id: longId,
        path: [],
        space: space,
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(`//${space}/${longId}@space`);
    });

    it("should encode special characters in path", () => {
      const link: NormalizedLink = {
        id: longId,
        path: ["path/with/slash", "path~with~tilde"],
        space: space,
      };
      const result = createLLMFriendlyLink(link as any);

      expect(result).toBe(
        `//${space}/${longId}@space/path~1with~1slash/path~0with~0tilde`,
      );
    });
  });
});
