import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  boundReadValue,
  CellSelectionError,
  deriveSelectedValue,
  evaluateSelectionPredicate,
  mergeMasks,
  parseSelectionFilter,
  parseSelectionProjection,
  parseSelectProjection,
  schemaMayBeArray,
  schemaRootKind,
  selectSourceSchema,
} from "../lib/cell-selection.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cf-piece-get-transform");
const space = signer.did();

describe("cf cell get transforms", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    const runtimeErrors: Array<{ message: string }> = [];
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      errorHandlers: [
        (error) => runtimeErrors.push({ message: error.message }),
      ],
    });
    (runtime as any)[Symbol.for("cf.cli.runtimeErrorLog")] = runtimeErrors;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("parses and evaluates jq-inspired predicates", () => {
    const parsed = parseSelectionFilter(
      '.status == "open" and (.score >= 10 or .priority == true)',
    );
    expect(parsed.paths).toEqual([
      ["status"],
      ["score"],
      ["priority"],
    ]);
    expect(evaluateSelectionPredicate(parsed.predicate, {
      status: "open",
      score: 12,
      priority: false,
    })).toBe(true);
    expect(evaluateSelectionPredicate(parsed.predicate, {
      status: "closed",
      score: 12,
      priority: true,
    })).toBe(false);
  });

  it("supports bracket paths, negative indices, and not", () => {
    const parsed = parseSelectionFilter(
      'not .disabled and .["tags"][-1] == "current"',
    );
    expect(evaluateSelectionPredicate(parsed.predicate, {
      disabled: false,
      tags: ["old", "current"],
    })).toBe(true);
  });

  it("uses jq truthiness for predicate values and missing paths", () => {
    const value = {
      name: "Ada",
      zero: 0,
      empty: "",
      disabled: false,
      nil: null,
      unset: undefined,
    };
    for (
      const source of [
        ".name",
        ".zero",
        ".empty",
        "not .missing",
        "false or true",
        ".disabled == false",
      ]
    ) {
      expect(evaluateSelectionPredicate(
        parseSelectionFilter(source).predicate,
        value,
      )).toBe(true);
    }
    for (const source of [".disabled", ".nil", ".unset", ".missing"]) {
      expect(evaluateSelectionPredicate(
        parseSelectionFilter(source).predicate,
        value,
      )).toBe(false);
    }
  });

  it("returns null for missing, incompatible, and out-of-range paths", () => {
    const value = {
      nil: null,
      name: "Ada",
      tags: ["first"],
    };
    for (
      const source of [
        ".nil.child",
        ".name.child",
        ".tags.name",
        ".tags[3]",
        ".tags[-3]",
      ]
    ) {
      expect(evaluateSelectionPredicate(
        parseSelectionFilter(source).predicate,
        value,
      )).toBe(false);
    }
    expect(evaluateSelectionPredicate(
      parseSelectionFilter(".tags[0]").predicate,
      value,
    )).toBe(true);
  });

  it("compares strings, numbers, and structured equality", () => {
    const value = {
      score: 10,
      name: "Grace",
      tags: ["a", "b"],
    };
    for (
      const source of [
        ".score < 11",
        ".score <= 10",
        ".score > 9",
        ".score >= 10",
        '.name < "H"',
        '.tags == .["tags"]',
        ".tags != null",
      ]
    ) {
      expect(evaluateSelectionPredicate(
        parseSelectionFilter(source).predicate,
        value,
      )).toBe(true);
    }
    expect(() =>
      evaluateSelectionPredicate(
        parseSelectionFilter(".score > true").predicate,
        value,
      )
    ).toThrow("--filter > requires two numbers or two strings");
  });

  it("reports invalid predicate syntax", () => {
    for (
      const source of [
        "",
        "#",
        '"unterminated',
        '"\\x"',
        "(",
        ".name)",
        ".name.",
        ".name[true]",
        '.name["key"',
        "unknown",
      ]
    ) {
      expect(() => parseSelectionFilter(source)).toThrow(
        CellSelectionError,
      );
    }
  });

  it("parses concise, inline, and file projection schemas", async () => {
    const concise = await parseSelectionProjection("id,author.name");
    expect(concise.kind).toBe("concise");
    expect(concise.schema).toEqual({
      type: "object",
      properties: {
        id: true,
        author: {
          type: "object",
          properties: { name: true },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });

    const inline = await parseSelectionProjection(
      '{"type":"object","properties":{"title":{"type":"string"}}}',
    );
    expect(inline.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: false,
    });

    const fromFile = await parseSelectionProjection("@projection.json", {
      readTextFile: () =>
        Promise.resolve(
          '{"type":"array","items":{"type":"object","properties":{"id":true}}}',
        ),
    });
    expect(fromFile.kind).toBe("json");
    expect(fromFile.schema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: true },
        additionalProperties: false,
      },
    });

    const path = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await Deno.writeTextFile(path, '{"type":"object"}');
      expect((await parseSelectionProjection(`@${path}`)).schema).toEqual({
        type: "object",
        additionalProperties: true,
      });
    } finally {
      await Deno.remove(path);
    }
  });

  it("detects arrays through refs and cyclic schema compositions", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.anyOf = [cyclic, { type: "array" }];
    const rootDefs: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          anyOf: [
            { $ref: "#/$defs/Leaf" },
            { $ref: "#/$defs/Branch" },
          ],
        },
        Leaf: { type: "object" },
        Branch: { type: "array", items: { $ref: "#/$defs/Leaf" } },
      },
    };

    expect(schemaMayBeArray(false)).toBe(false);
    expect(schemaMayBeArray(cyclic as JSONSchema)).toBe(true);
    expect(schemaMayBeArray(rootDefs)).toBe(true);
    expect(() =>
      schemaMayBeArray({
        $ref: "#/$defs/Missing",
        $defs: {},
      })
    ).toThrow("Could not resolve source schema reference for --schema");
  });

  it("treats an explicit root type as authoritative over combinators", () => {
    expect(schemaMayBeArray({
      type: "object",
      anyOf: [{ type: "array" }],
    })).toBe(false);
    expect(schemaMayBeArray({
      type: "object",
      allOf: [{ type: "array" }],
    })).toBe(false);
  });

  it("classifies only unambiguous declared root shapes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.allOf = [cyclic];

    expect(schemaRootKind(undefined)).toBe("unknown");
    expect(schemaRootKind({ type: "array" })).toBe("array");
    expect(schemaRootKind({ type: "object" })).toBe("non-array");
    expect(schemaRootKind({ type: ["array", "null"] })).toBe("unknown");
    expect(schemaRootKind({
      $ref: "#/$defs/List",
      $defs: { List: { type: "array" } },
    })).toBe("array");
    expect(schemaRootKind({
      anyOf: [{ type: "array" }, { type: "array" }],
    })).toBe("array");
    expect(schemaRootKind({
      oneOf: [{ type: "array" }, { type: "object" }],
    })).toBe("unknown");
    expect(schemaRootKind({
      allOf: [{}, { type: "object" }],
    })).toBe("non-array");
    expect(schemaRootKind({
      allOf: [{ type: "array" }, { type: "object" }],
    })).toBe("unknown");
    expect(schemaRootKind(cyclic as JSONSchema)).toBe("unknown");
  });

  it("falls back conservatively when a source reference cannot resolve", () => {
    const broken: JSONSchema = {
      $ref: "#/$defs/Missing",
      $defs: {},
    };
    const mask = {
      type: "object" as const,
      properties: { id: true as const },
      additionalProperties: false as const,
    };

    expect(schemaRootKind(broken)).toBe("unknown");
    expect(schemaRootKind({ ...broken, type: "array" })).toBe("unknown");
    expect(selectSourceSchema(broken, mask)).toBe(broken);
  });

  it("merges predicate reads through aligned array masks", () => {
    expect(mergeMasks(
      {
        type: "object",
        properties: { body: true },
        additionalProperties: false,
      },
      {
        type: "array",
        items: {
          type: "object",
          properties: { author: true },
          additionalProperties: false,
        },
      },
    )).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { body: true, author: true },
        additionalProperties: false,
      },
    });
  });

  it("keeps predicate reads a rejecting projection declines", () => {
    const predicate = {
      type: "object",
      properties: { status: true },
      additionalProperties: false,
    } as const;
    expect(mergeMasks(predicate, false)).toEqual(predicate);
    expect(mergeMasks(true, false)).toBe(true);
    expect(mergeMasks(predicate, {
      type: "object",
      properties: { topic: false },
      additionalProperties: false,
    })).toEqual({
      type: "object",
      properties: { status: true, topic: false },
      additionalProperties: false,
    });
  });

  it("narrows referenced source schemas without dropping Fabric metadata", () => {
    const source: JSONSchema = {
      $ref: "#/$defs/Item",
      $defs: {
        Item: {
          type: "object",
          scope: "user",
          ifc: { confidentiality: ["item-secret"] },
          properties: {
            visible: {
              type: "string",
              ifc: { confidentiality: ["field-secret"] },
            },
            omitted: { type: "string" },
          },
          required: ["visible", "omitted"],
        },
      },
    };
    const selected = selectSourceSchema(source, {
      type: "object",
      properties: { visible: true },
      additionalProperties: false,
    });

    expect(selected).toMatchObject({
      type: "object",
      scope: "user",
      ifc: { confidentiality: ["item-secret"] },
      properties: {
        visible: {
          type: "string",
          ifc: {
            confidentiality: ["item-secret", "field-secret"],
          },
        },
      },
      required: ["visible"],
      additionalProperties: false,
    });
    expect(Object.keys((selected as { properties: object }).properties))
      .toEqual(["visible"]);
  });

  it("resolves a nested reference against the document root, not an inert inner `$defs`", () => {
    const contract: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" }, note: { type: "string" } },
    };
    const inert: Record<string, JSONSchema> = {
      T: { type: "array", items: { type: "string" } },
    };
    const mask = {
      type: "object" as const,
      properties: { title: true as const },
      additionalProperties: false as const,
    };
    const narrowed = {
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: false,
    };

    const arm = selectSourceSchema(
      {
        $defs: { T: contract },
        anyOf: [{ $ref: "#/$defs/T", $defs: inert }],
      },
      mask,
      "projected-output",
    );
    expect(arm).toMatchObject({ anyOf: [narrowed] });
    const [projectedArm] = (arm as { anyOf: Array<{ properties: object }> })
      .anyOf;
    expect(Object.keys(projectedArm.properties)).toEqual(["title"]);

    const property = selectSourceSchema({
      $defs: { T: contract },
      type: "object",
      properties: { item: { $ref: "#/$defs/T", $defs: inert } },
    }, {
      type: "object",
      properties: { item: mask },
      additionalProperties: false,
    });
    expect(property).toMatchObject({ properties: { item: narrowed } });
  });

  it("drops a required entry named like a prototype member that the mask did not select", () => {
    // `required` is filtered to the SELECTED properties. That test must ask
    // whether the selection holds the key as its own: a `required` entry
    // spelled `toString` is found on every object by `in`, and an unselected
    // one used to survive into the selected schema's `required`.
    const properties: Record<string, JSONSchema> = {
      label: { type: "string" },
    };
    properties["toString"] = { type: "string" };
    const source: JSONSchema = {
      type: "object",
      properties,
      required: ["label", "toString"],
    };
    const selected = selectSourceSchema(source, {
      type: "object",
      properties: { label: true },
      additionalProperties: false,
    }) as { properties: object; required?: string[] };

    expect(Object.keys(selected.properties)).toEqual(["label"]);
    expect(selected.required).toEqual(["label"]);
  });

  it("collapses overlapping concise paths without exposing siblings", async () => {
    for (const source of ["author,author.name", "author.name,author"]) {
      expect((await parseSelectionProjection(source)).schema).toEqual({
        type: "object",
        properties: { author: true },
        additionalProperties: false,
      });
    }
  });

  it("validates projection schema roots and nested schema objects", async () => {
    await expect(parseSelectionProjection("")).rejects.toThrow(
      "--schema must not be empty",
    );
    await expect(parseSelectionProjection("@")).rejects.toThrow(
      "--schema @file requires a file path",
    );
    await expect(parseSelectionProjection("@missing.json", {
      readTextFile: () => Promise.reject(new Error("gone")),
    })).rejects.toThrow('Could not read --schema file "missing.json": gone');
    await expect(parseSelectionProjection("@bad.json", {
      readTextFile: () => Promise.resolve("{"),
    })).rejects.toThrow('Invalid JSON in --schema file "bad.json"');
    await expect(parseSelectionProjection("@array.json", {
      readTextFile: () => Promise.resolve("[]"),
    })).rejects.toThrow("expected a JSON Schema object");
    await expect(parseSelectionProjection("{")).rejects.toThrow(
      "Invalid JSON passed to --schema",
    );
    await expect(parseSelectionProjection("false")).rejects.toThrow(
      "false cannot project a value",
    );
    await expect(parseSelectionProjection(
      '{"type":"object","properties":[]}',
    )).rejects.toThrow('"properties" must be an object');
    await expect(parseSelectionProjection("a,,b")).rejects.toThrow(
      "expected comma-separated field paths",
    );
    await expect(parseSelectionProjection("a.0")).rejects.toThrow(
      "Invalid --schema field path",
    );
  });

  it("normalizes identity and additional-property projection schemas", async () => {
    expect((await parseSelectionProjection('{"type":"object"}')).schema)
      .toEqual({
        type: "object",
        additionalProperties: true,
      });
    expect(
      (await parseSelectionProjection(
        '{"type":"object","additionalProperties":{"type":"string"}}',
      )).schema,
    ).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect((await parseSelectionProjection("true")).schema).toBe(true);
  });

  it("normalizes an untyped projection to the container its keywords name", async () => {
    expect(
      (await parseSelectionProjection('{"properties":{"label":true}}')).schema,
    ).toEqual({
      type: "object",
      properties: { label: true },
      additionalProperties: false,
    });
    expect(
      (await parseSelectionProjection(
        '{"additionalProperties":{"type":"string"}}',
      )).schema,
    ).toEqual({ type: "object", additionalProperties: { type: "string" } });
    // `required` names the container and is then consumed: the caller's
    // constraint goes no further, because the runner acts on a `required` it
    // is handed and a caller's would void the read around a position it
    // narrowed.
    expect(
      (await parseSelectionProjection('{"required":["id"]}')).schema,
    ).toEqual({ type: "object", additionalProperties: true });
    expect(
      (await parseSelectionProjection('{"items":{"properties":{"id":true}}}'))
        .schema,
    ).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: true },
        additionalProperties: false,
      },
    });
  });

  it("keeps `true`, `{}`, `false`, and a bare marker distinct from an inferred object", async () => {
    expect((await parseSelectionProjection("true")).schema).toBe(true);
    expect((await parseSelectionProjection("{}")).schema).toEqual({});
    expect((await parseSelectionProjection('{"$link":true}')).schema).toBe(
      false,
    );
    await expect(parseSelectionProjection("false")).rejects.toThrow(
      "false cannot project a value",
    );
  });

  it("does not let caller projection schemas forge CFC metadata", async () => {
    for (const key of ["asCell", "default", "ifc", "scope"]) {
      await expect(parseSelectionProjection(JSON.stringify({
        type: "object",
        properties: {
          secret: { type: "string", [key]: key === "asCell" ? ["cell"] : {} },
        },
      }))).rejects.toThrow(CellSelectionError);
    }
  });

  it("rejects unsupported projection composition keywords", async () => {
    for (
      const key of [
        "$ref",
        "$defs",
        "definitions",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "contains",
        "patternProperties",
        "prefixItems",
        "propertyNames",
        "contentSchema",
      ]
    ) {
      await expect(parseSelectionProjection(JSON.stringify({
        type: "object",
        [key]: {},
      }))).rejects.toThrow(`"${key}" is not supported`);
    }
  });

  it("filters and projects arrays through the runtime pattern graph", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "plain-transform-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([
      { id: 1, title: "First", status: "open" },
      { id: 2, title: "Second", status: "closed" },
      { id: 3, title: "Third", status: "open" },
    ]);
    expect((await tx.commit()).ok).toBeDefined();

    const result = await deriveSelectedValue(runtime, space, source, {
      filter: parseSelectionFilter('.status == "open"'),
      projection: await parseSelectionProjection("id,title"),
    });

    expect(result).toEqual([
      { id: 1, title: "First" },
      { id: 3, title: "Third" },
    ]);
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":true}}}',
        ),
      }),
    ).toEqual([
      { title: "First" },
      { title: "Second" },
      { title: "Third" },
    ]);
  });

  it("projects through a union arm whose own `$defs` conflicts with the root's", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "inert-arm-defs-source",
      {
        $defs: {
          T: {
            type: "object",
            properties: { title: { type: "string" }, note: { type: "string" } },
          },
        },
        anyOf: [{
          $ref: "#/$defs/T",
          $defs: { T: { type: "array", items: { type: "string" } } },
        }],
      },
      tx,
    );
    source.set({ title: "visible", note: "hidden" });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("title"),
      }),
    ).toEqual({ title: "visible" });
  });

  it("narrows the initial source selector to predicate and projection fields", async () => {
    const tx = runtime.edit();
    const detailsSchema = {
      type: "object",
      properties: {
        body: { type: "string" },
        comments: { type: "array", items: { type: "string" } },
      },
      required: ["body", "comments"],
    } as const satisfies JSONSchema;
    const itemSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        status: { type: "string" },
        details: { ...detailsSchema, asCell: ["cell"] },
      },
      required: ["id", "title", "status", "details"],
    } as const satisfies JSONSchema;
    const sourceSchema = {
      type: "array",
      items: { $ref: "#/$defs/Item" },
      $defs: { Item: itemSchema },
    } as const satisfies JSONSchema;
    const unavailableDetails = runtime.getCell(
      space,
      "initial-selector-unavailable-details",
      detailsSchema,
      tx,
    );
    const source = runtime.getCell(
      space,
      "initial-selector-transform-source",
      sourceSchema,
      tx,
    );
    source.set([{
      id: 1,
      title: "First",
      status: "open",
      details: unavailableDetails as never,
    }]);
    expect((await tx.commit()).ok).toBeDefined();

    const sourceRead = runtime.getCell(
      space,
      "initial-selector-transform-source",
      sourceSchema,
    );
    const sourceId = sourceRead.getAsNormalizedFullLink().id;
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const sourceSelectors: unknown[] = [];
    const syncedUris: string[] = [];
    provider.sync = ((uri, selector, scope) => {
      syncedUris.push(uri);
      if (uri === sourceId) sourceSelectors.push(selector?.schema);
      return originalSync(uri, selector, scope);
    }) as typeof provider.sync;

    expect(
      await deriveSelectedValue(runtime, space, sourceRead, {
        filter: parseSelectionFilter('.status == "open"'),
        projection: await parseSelectionProjection("id,title"),
      }),
    ).toEqual([{ id: 1, title: "First" }]);
    const initialSelector = sourceSelectors.at(0) as {
      type?: string;
      items?: {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    };
    expect(initialSelector.type).toBe("array");
    expect(Object.keys(initialSelector.items?.properties ?? {}).sort()).toEqual(
      [
        "id",
        "status",
        "title",
      ],
    );
    expect(initialSelector.items?.required).toEqual([
      "id",
      "title",
      "status",
    ]);
    expect(initialSelector.items?.additionalProperties).toBe(false);
    expect(syncedUris).not.toContain(
      unavailableDetails.getAsNormalizedFullLink().id,
    );
  });

  it("filters and projects through a linked array slot", async () => {
    const tx = runtime.edit();
    const list = runtime.getCell(
      space,
      "linked-transform-list",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
          },
        },
      },
      tx,
    );
    list.set([
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ]);
    const container = runtime.getCell(
      space,
      "linked-transform-container",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                title: { type: "string" },
              },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    container.set({ items: list as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, container.key("items"), {
        filter: parseSelectionFilter(".id == 2"),
        projection: await parseSelectionProjection("title"),
      }),
    ).toEqual([{ title: "Second" }]);
  });

  it("dereferences nested writable fields for filters and projections", async () => {
    const tx = runtime.edit();
    const author = runtime.getCell(
      space,
      "nested-writable-author",
      {
        type: "object",
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          privateEmail: { type: "string" },
        },
      },
      tx,
    );
    author.set({
      kind: "agent",
      name: "Sol",
      privateEmail: "sol@example.com",
    });
    const itemSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        createdBy: {
          type: "object",
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            privateEmail: { type: "string" },
          },
          asCell: ["cell"],
        },
      },
    } as const;
    const source = runtime.getCell(
      space,
      "nested-writable-source",
      { type: "array", items: itemSchema },
      tx,
    );
    source.set([{ title: "T1", createdBy: author as never }]);
    const direct = runtime.getCell(
      space,
      "nested-writable-direct-source",
      itemSchema,
      tx,
    );
    direct.set({ title: "T1", createdBy: author as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("title,createdBy.name"),
      }),
    ).toEqual([{ title: "T1", createdBy: { name: "Sol" } }]);
    expect(
      await deriveSelectedValue(runtime, space, source, {
        filter: parseSelectionFilter('.createdBy.name == "Sol"'),
        projection: await parseSelectionProjection("title"),
      }),
    ).toEqual([{ title: "T1" }]);
    expect(
      await deriveSelectedValue(runtime, space, direct, {
        projection: await parseSelectionProjection("title,createdBy.name"),
      }),
    ).toEqual({ title: "T1", createdBy: { name: "Sol" } });
  });

  it("projects a linked object whose target has no schema", async () => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      space,
      "linked-transform-schema-less-target",
      undefined,
      tx,
    );
    target.set({ title: "Visible", hidden: "not returned" });
    const container = runtime.getCell(
      space,
      "linked-transform-schema-less-container",
      {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              title: { type: "string" },
              hidden: { type: "string" },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    container.set({ topic: target as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, container.key("topic"), {
        projection: await parseSelectionProjection("title"),
      }),
    ).toEqual({ title: "Visible" });
  });

  it("materializes a projection instead of aliasing its broader source", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "non-aliasing-projection-source",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          hidden: { type: "string" },
        },
      },
      tx,
    );
    source.set({ title: "Visible", hidden: "not returned" });
    expect((await tx.commit()).ok).toBeDefined();

    let outputCell: Cell<unknown> | undefined;
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("title"),
      }, {
        onOutputCell: (cell) => outputCell = cell,
      }),
    ).toEqual({ title: "Visible" });
    expect(outputCell!.get()).toEqual({ title: "Visible" });
    expect(outputCell!.resolveAsCell().getAsNormalizedFullLink().id).not.toBe(
      source.getAsNormalizedFullLink().id,
    );
  });

  it("filters and projects a writable array value", async () => {
    const tx = runtime.edit();
    const first = runtime.getCell(
      space,
      "writable-transform-first",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
      },
      tx,
    );
    first.set({ id: 1, title: "First" });
    const second = runtime.getCell(
      space,
      "writable-transform-second",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
      },
      tx,
    );
    second.set({ id: 2, title: "Second" });
    const source = runtime.getCell(
      space,
      "writable-transform-list",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
          },
          asCell: ["cell"],
        },
        asCell: ["cell"],
      },
      tx,
    );
    source.set([
      first,
      second,
    ]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        filter: parseSelectionFilter(".id == 2"),
        projection: await parseSelectionProjection("title"),
      }),
    ).toEqual([{ title: "Second" }]);
  });

  it("does not leak nested siblings from overlapping concise paths", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "overlap-projection-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            author: {
              type: "object",
              properties: {
                name: { type: "string" },
                privateEmail: { type: "string" },
              },
            },
            ignored: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([{
      author: { name: "Ada", privateEmail: "ada@example.com" },
      ignored: "hidden",
    }]);
    expect((await tx.commit()).ok).toBeDefined();

    const result = await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(
        "author.name,author.name.first",
      ),
    });

    expect(result).toEqual([{ author: { name: "Ada" } }]);
  });

  it("supports direct projection and identity object schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "object-projection-source",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          subtitle: { type: ["string", "null"] },
        },
        required: ["id", "title", "subtitle"],
      },
      tx,
    );
    source.set({ id: 1, title: "Visible", subtitle: null });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("id"),
      }),
    ).toEqual({ id: 1 });
    await expect(
      deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("missing"),
      }),
    ).rejects.toThrow(
      'Invalid --schema at <root>: "missing" is not a field the source holds',
    );
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(JSON.stringify({
          type: "object",
          properties: {
            subtitle: { type: ["string", "null"] },
          },
          additionalProperties: false,
        })),
      }),
    ).toEqual({ subtitle: null });
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection('{"type":"object"}'),
      }),
    ).toEqual({ id: 1, title: "Visible", subtitle: null });
    expect(await deriveSelectedValue(runtime, space, source, {})).toEqual({
      id: 1,
      title: "Visible",
      subtitle: null,
    });
  });

  it("projects an untyped `properties` at every level of nesting", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "inferred-object-projection-source",
      {
        type: "object",
        properties: {
          label: { type: "string" },
          hidden: { type: "string" },
          topic: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
          },
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
              },
            },
          },
        },
      },
      tx,
    );
    source.set({
      label: "Visible",
      hidden: "not returned",
      topic: { title: "First", body: "not returned" },
      notes: [{ title: "Note", body: "not returned" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"properties":{"label":true}}',
        ),
      }),
    ).toEqual({ label: "Visible" });
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"type":"object","properties":{"topic":{"properties":{"title":true}}}}',
        ),
      }),
    ).toEqual({ topic: { title: "First" } });
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"properties":{"topic":{"properties":{"title":true}}}}',
        ),
      }),
    ).toEqual({ topic: { title: "First" } });
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"properties":{"notes":{"items":{"properties":{"title":true}}}}}',
        ),
      }),
    ).toEqual({ notes: [{ title: "Note" }] });
  });

  it("projects nested arrays with explicit item schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nested-array-projection-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Hello", privateNote: "not returned" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    const projection = {
      type: "object",
      properties: {
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              body: true,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    };
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(JSON.stringify(projection)),
      }),
    ).toEqual({ comments: [{ body: "Hello" }] });
  });

  it("preserves nullable array items through concise projections", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nullable-concise-projection-source",
      {
        type: "array",
        items: {
          type: ["object", "null"],
          properties: {
            name: { type: "string" },
            secret: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([{ name: "a", secret: "hidden" }, null]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(await deriveSelectedValue(runtime, space, source, {})).toEqual([
      { name: "a", secret: "hidden" },
      null,
    ]);
    expect(
      await deriveSelectedValue(runtime, space, source, {
        filter: parseSelectionFilter('.name == "a"'),
      }),
    ).toEqual([{ name: "a", secret: "hidden" }]);
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("name"),
      }),
    ).toEqual([{ name: "a" }, null]);
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(JSON.stringify({
          type: "array",
          items: {
            type: ["object", "null"],
            properties: { name: true },
            additionalProperties: false,
          },
        })),
      }),
    ).toEqual([{ name: "a" }, null]);
  });

  it("projects concise paths through nested and repeated arrays", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nested-concise-array-projection-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
                replies: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      body: { type: "string" },
                      privateNote: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{
        body: "Top level",
        privateNote: "hidden",
        replies: [{ body: "Nested", privateNote: "also hidden" }],
      }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          "comments.body,comments.replies.body",
        ),
      }),
    ).toEqual({
      comments: [{
        body: "Top level",
        replies: [{ body: "Nested" }],
      }],
    });
  });

  it("preserves nullable property unions independently of their parent", async () => {
    for (const additionalProperties of [false, true]) {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        `nullable-property-${additionalProperties}`,
        {
          type: "object",
          properties: {
            profiles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  profile: {
                    type: ["object", "null"],
                    properties: {
                      name: { type: "string" },
                      secret: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          additionalProperties,
        },
        tx,
      );
      source.set({
        profiles: [
          { profile: { name: "Ada", secret: "hidden" } },
          { profile: null },
        ],
      });
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await deriveSelectedValue(runtime, space, source, {
          projection: await parseSelectionProjection("profiles.profile.name"),
        }),
      ).toEqual({
        profiles: [{ profile: { name: "Ada" } }, { profile: null }],
      });
    }
  });

  it("preserves anyOf nullability in concise array projections", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "any-of-nullable-concise-source",
      {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string" },
                secret: { type: "string" },
              },
            },
            { type: "null" },
          ],
        },
      },
      tx,
    );
    source.set([{ name: "Ada", secret: "hidden" }, null]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("name"),
      }),
    ).toEqual([{ name: "Ada" }, null]);
  });

  it("projects concise fields through allOf source schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "all-of-concise-source",
      {
        type: "array",
        items: {
          allOf: [
            {
              type: "object",
              properties: { name: { type: "string" } },
            },
            {
              type: "object",
              properties: { secret: { type: "string" } },
            },
          ],
        },
      },
      tx,
    );
    source.set([{ name: "Ada", secret: "hidden" }]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("name"),
      }),
    ).toEqual([{ name: "Ada" }]);
  });

  it("projects concise paths through a linked nested array", async () => {
    const tx = runtime.edit();
    const comments = runtime.getCell(
      space,
      "linked-nested-comments",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            body: { type: "string" },
            privateNote: { type: "string" },
          },
        },
      },
      tx,
    );
    comments.set([{ body: "Visible", privateNote: "hidden" }]);
    const source = runtime.getCell(
      space,
      "linked-nested-array-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    source.set({ comments: comments as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("projects concise array paths through source schema references", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "referenced-nested-array-source",
      {
        type: "object",
        properties: {
          comments: {
            $ref: "#/$defs/Comments",
          },
        },
        $defs: {
          Comments: {
            anyOf: [
              { $ref: "#/$defs/CommentList" },
              { type: "null" },
            ],
          },
          CommentList: {
            type: "array",
            items: { $ref: "#/$defs/Comment" },
          },
          Comment: {
            type: "object",
            properties: {
              body: { type: "string" },
              privateNote: { type: "string" },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Visible", privateNote: "hidden" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("does not leak siblings when a nested array schema is ambiguous", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "ambiguous-nested-array-source",
      {
        type: "object",
        properties: { comments: true },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Visible", privateNote: "hidden" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("does not leak siblings when a nested value may be an array or object", async () => {
    const variants: JSONSchema[] = [
      {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
          },
          {
            type: "object",
            properties: {
              body: { type: "string" },
              privateNote: { type: "string" },
            },
          },
        ],
      },
      {
        type: ["array", "object"],
        items: {
          type: "object",
          properties: {
            body: { type: "string" },
            privateNote: { type: "string" },
          },
        },
        properties: {
          body: { type: "string" },
          privateNote: { type: "string" },
        },
      },
    ];

    for (const [index, entrySchema] of variants.entries()) {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        `array-object-union-${index}`,
        {
          type: "object",
          properties: { entry: entrySchema },
        },
        tx,
      );
      source.set({
        entry: { body: "Visible", privateNote: "hidden" },
      });
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await deriveSelectedValue(runtime, space, source, {
          projection: await parseSelectionProjection("entry.body"),
        }),
      ).toEqual({ entry: { body: "Visible" } });
    }
  });

  it("keeps anyOf and oneOf constraints distinct on source reads", () => {
    const source: JSONSchema = {
      anyOf: [{ type: "string" }, { type: "number" }],
      oneOf: [{ const: "a" }, { const: "b" }],
      allOf: [{ type: "string" }],
    };
    const mask = {
      type: "object" as const,
      properties: { body: true as const },
      additionalProperties: false as const,
    };
    expect(selectSourceSchema(source, mask)).toBe(source);
    expect(
      selectSourceSchema(source, mask, "projected-output"),
    ).toEqual({
      anyOf: source.anyOf,
      allOf: [
        { type: "string" },
        { anyOf: source.oneOf },
      ],
    });
  });

  it("handles schema-less filters and identity projection schemas", async () => {
    const tx = runtime.edit();
    const schemaLess = runtime.getCell(
      space,
      "schema-less-filter-source",
      undefined,
      tx,
    );
    schemaLess.set([1, 2]);
    const nestedArrays = runtime.getCell(
      space,
      "nested-array-filter-source",
      {
        type: "array",
        items: { type: "array", items: { type: "number" } },
      },
      tx,
    );
    nestedArrays.set([[1], []]);
    const scalar = runtime.getCell(
      space,
      "scalar-projection-source",
      { type: "string" },
      tx,
    );
    scalar.set("visible");
    const permissiveArray = runtime.getCell(
      space,
      "permissive-array-projection-source",
      {},
      tx,
    );
    permissiveArray.set([{ id: 1, hidden: true }]);
    const composedObject = runtime.getCell(
      space,
      "composed-object-projection-source",
      {
        anyOf: [{
          type: "object",
          properties: { id: { type: "number" } },
        }],
      },
      tx,
    );
    composedObject.set({ id: 2 });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, schemaLess, {
        filter: parseSelectionFilter("true"),
      }),
    ).toEqual([1, 2]);
    expect(
      await deriveSelectedValue(runtime, space, schemaLess, {
        filter: parseSelectionFilter("."),
      }),
    ).toEqual([1, 2]);
    expect(
      await deriveSelectedValue(runtime, space, nestedArrays, {
        filter: parseSelectionFilter(".[0]"),
      }),
    ).toEqual([[1]]);
    expect(
      await deriveSelectedValue(runtime, space, nestedArrays, {
        filter: parseSelectionFilter(".length"),
        projection: await parseSelectionProjection(
          '{"type":"array","items":{"type":"array","items":true}}',
        ),
      }),
    ).toEqual([]);
    expect(
      await deriveSelectedValue(runtime, space, schemaLess, {
        projection: await parseSelectionProjection("true"),
      }),
    ).toEqual([1, 2]);
    expect(
      await deriveSelectedValue(runtime, space, schemaLess, {
        projection: await parseSelectionProjection('{"type":"array"}'),
      }),
    ).toEqual([1, 2]);
    expect(
      await deriveSelectedValue(runtime, space, schemaLess, {
        projection: await parseSelectionProjection(
          '{"type":["array","null"],"items":true}',
        ),
      }),
    ).toEqual([1, 2]);
    expect(
      await deriveSelectedValue(runtime, space, scalar, {
        projection: await parseSelectionProjection('{"type":"string"}'),
      }),
    ).toBe("visible");
    expect(
      await deriveSelectedValue(runtime, space, permissiveArray, {
        projection: await parseSelectionProjection("id"),
      }),
    ).toEqual([{ id: 1 }]);
    expect(
      await deriveSelectedValue(runtime, space, composedObject, {
        projection: await parseSelectionProjection("id"),
      }),
    ).toEqual({ id: 2 });
  });

  it("supports an explicitly closed object projection", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "closed-object-projection-source",
      {
        type: "object",
        properties: { hidden: { type: "string" } },
      },
      tx,
    );
    source.set({ hidden: "not returned" });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"type":"object","additionalProperties":false}',
        ),
      }),
    ).toEqual({});
  });

  it("rejects JSON projection roots that mismatch the selected value", async () => {
    const tx = runtime.edit();
    const arraySource = runtime.getCell(
      space,
      "array-schema-mismatch-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    arraySource.set([{ id: 1 }]);
    const objectSource = runtime.getCell(
      space,
      "object-schema-mismatch-source",
      { type: "object" },
      tx,
    );
    objectSource.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    await expect(deriveSelectedValue(runtime, space, arraySource, {
      projection: await parseSelectionProjection('{"type":"object"}'),
    })).rejects.toThrow("must describe the returned array");
    await expect(deriveSelectedValue(runtime, space, objectSource, {
      projection: await parseSelectionProjection(
        '{"type":"array","items":true}',
      ),
    })).rejects.toThrow(
      "can only be applied to an array value",
    );
  });

  it("projects an untyped `items` root through an array value", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "untyped-items-root-array-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([{ title: "First", body: "not returned" }]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection(
          '{"items":{"properties":{"title":true}}}',
        ),
      }),
    ).toEqual([{ title: "First" }]);
  });

  it("masks the read of an array projection that also names `additionalProperties`", async () => {
    const listSchema = {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
          },
        },
      },
    } as const satisfies JSONSchema;

    const tx = runtime.edit();
    // The bodies are left unwritten: reading one has to reach storage, which
    // is what makes a read of a field nobody asked for observable.
    const bodies = ["a", "b"].map((suffix) =>
      runtime.getCell(space, `array-extra-props-body-${suffix}`, {
        type: "string",
      }, tx)
    );
    const source = runtime.getCell(
      space,
      "array-extra-props-source",
      listSchema,
      tx,
    );
    source.setRaw({
      notes: bodies.map((body, index) => ({
        title: ["a", "b"][index],
        body: body.getAsLink(),
      })),
    } as never);
    expect((await tx.commit()).ok).toBeDefined();

    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    const syncedUris: string[] = [];
    provider.sync = ((uri, selector, scope) => {
      syncedUris.push(uri);
      return originalSync(uri, selector, scope);
    }) as typeof provider.sync;
    const bodyUris: string[] = bodies.map((body) =>
      body.getAsNormalizedFullLink().id
    );

    const read = runtime.getCell(space, "array-extra-props-source", listSchema);
    expect(
      await deriveSelectedValue(runtime, space, read, {
        projection: await parseSelectionProjection(
          '{"properties":{"notes":{"items":{"properties":{"title":true}},' +
            '"additionalProperties":{"type":"string"}}}}',
        ),
      }),
    ).toEqual({ notes: [{ title: "a" }, { title: "b" }] });
    // `additionalProperties` describes an object, and `items` says this
    // position is an array. Reading it as an object that admits anything
    // loads every document behind a field the caller did not name.
    expect(syncedUris.filter((uri) => bodyUris.includes(uri))).toEqual([]);
  });

  it("rejects an untyped `items` root against a non-array value", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "untyped-items-root-object-source",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
      },
      tx,
    );
    source.set({ title: "First", body: "not returned" });
    expect((await tx.commit()).ok).toBeDefined();

    // A root naming `items` is an array projection, so it meets the same
    // root-shape refusal a stated `{"type":"array"}` does. The refusal is what
    // keeps the read selector and the output schema agreeing on the container:
    // where they disagree, the transform computes a value that neither of them
    // describes and hands back an empty answer that looks like a real one.
    await expect(deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(
        '{"items":{"properties":{"title":true}}}',
      ),
    })).rejects.toThrow(
      "An array-rooted JSON --schema can only be applied to an array value.",
    );
  });

  it("treats a missing filter path as a non-match", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "missing-filter-path-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "number" } },
        },
      },
      tx,
    );
    source.set([{ id: 1 }, { id: 2 }]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, source, {
        filter: parseSelectionFilter(".missing"),
      }),
    ).toEqual([]);
  });

  it("rejects --filter for non-array sources", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "object-filter-source",
      { type: "object", properties: { id: { type: "number" } } },
      tx,
    );
    source.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    await expect(deriveSelectedValue(runtime, space, source, {
      filter: parseSelectionFilter(".id == 1"),
    })).rejects.toThrow("--filter can only be applied to an array");
  });

  it("treats an unset declared array as empty for filtering", async () => {
    const tx = runtime.edit();
    const unsetSource = runtime.getCell(
      space,
      "declared-array-unset-filter-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await deriveSelectedValue(runtime, space, unsetSource, {
        filter: parseSelectionFilter("true"),
      }),
    ).toEqual([]);
  });

  it("reports schema/value root mismatches with CLI-level errors", async () => {
    const tx = runtime.edit();
    const nullSource = runtime.getCell(
      space,
      "declared-array-null-filter-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    nullSource.set(null as never);
    const objectSource = runtime.getCell(
      space,
      "declared-array-object-projection-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    objectSource.set({ id: 1 } as never);
    expect((await tx.commit()).ok).toBeDefined();

    await expect(deriveSelectedValue(runtime, space, nullSource, {
      filter: parseSelectionFilter("true"),
    })).rejects.toThrow(/^--filter can only be applied to an array$/);
    await expect(deriveSelectedValue(runtime, space, nullSource, {
      filter: parseSelectionFilter("true"),
      projection: await parseSelectionProjection("id"),
    })).rejects.toThrow(/^--filter can only be applied to an array$/);
    await expect(deriveSelectedValue(runtime, space, objectSource, {
      projection: await parseSelectionProjection("id"),
    })).rejects.toThrow(
      /^--schema can only project array items from an array value$/,
    );
    // A selection that is entirely addresses meets the mismatch on the walk
    // rather than through the map builtin, and answers with the same refusal:
    // a walk over a value that is not an array finds no elements to address,
    // which would otherwise render as an absent value.
    await expect(deriveSelectedValue(runtime, space, objectSource, {
      projection: await parseSelectionProjection(
        '{"type":"array","items":{"properties":{"id":{"$link":true}}}}',
      ),
    })).rejects.toThrow(
      /^--schema can only project array items from an array value$/,
    );
    await expect(deriveSelectedValue(runtime, space, objectSource, {
      projection: parseSelectProjection("id@"),
    })).rejects.toThrow(
      /^--select can only project array items from an array value$/,
    );
  });

  it("returns no addresses for an unset declared array rather than refusing", async () => {
    // An unset declared array is the empty array under the runner's map
    // semantics, and the unmarked spelling already answers `[]`. A marked one
    // must agree: refusing here would tell a caller its piece is malformed
    // when it merely has nothing in it yet — the state every collection
    // starts in.
    const tx = runtime.edit();
    const unsetSource = runtime.getCell(
      space,
      "declared-array-unset-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    expect((await tx.commit()).ok).toBeDefined();

    // All three spellings agree, which is the property: an unmarked
    // projection, a concise marker, and the JSON-schema marker each answer
    // with no elements rather than one refusing and another going absent.
    expect(
      await deriveSelectedValue(runtime, space, unsetSource, {
        projection: parseSelectProjection("id"),
      }),
    ).toEqual([]);
    expect(
      await deriveSelectedValue(runtime, space, unsetSource, {
        projection: parseSelectProjection("id@"),
      }),
    ).toEqual([]);
    expect(
      await deriveSelectedValue(runtime, space, unsetSource, {
        projection: await parseSelectionProjection(
          '{"type":"array","items":{"properties":{"id":{"$link":true}}}}',
        ),
      }),
    ).toEqual([]);
  });

  it("reports runtime predicate failures as transform errors", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "predicate-runtime-error-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: { score: { type: "boolean" } },
        },
      },
      tx,
    );
    source.set([{ score: true }]);
    expect((await tx.commit()).ok).toBeDefined();

    await expect(deriveSelectedValue(runtime, space, source, {
      filter: parseSelectionFilter(".score > 1"),
    })).rejects.toThrow("Could not apply get transform");
  });

  it("reports transform transaction commit failures", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "transform-commit-error-source",
      {
        type: "object",
        properties: { id: { type: "number" } },
      },
      setup,
    );
    source.set({ id: 1 });
    expect((await setup.commit()).ok).toBeDefined();

    const originalEdit = runtime.edit.bind(runtime);
    (runtime as any).edit = () => {
      const tx = originalEdit();
      (tx as any).commit = () =>
        Promise.resolve({ error: "forced commit failure" });
      return tx;
    };
    try {
      await expect(deriveSelectedValue(runtime, space, source, {
        projection: await parseSelectionProjection("id"),
      })).rejects.toThrow(
        "Could not apply get transform: forced commit failure",
      );
    } finally {
      (runtime as any).edit = originalEdit;
    }
  });

  it("sets up the projection once and returns its result without runtime-owned setup", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "accepted-projection-setup",
      { type: "object", properties: { id: { type: "number" } } },
      tx,
    );
    source.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    // Count caller-provided setup and refuse runtime-owned setup so neither
    // path can silently introduce a second setup transaction.
    using setups = spy(runtime, "setup");
    using ownedSetups = stub(runtime, "editWithRetry", () =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted",
          message: "forced setup rejection",
          reason: "forced setup rejection",
        },
      }));
    expect(
      await deriveSelectedValue(runtime, space, source, {
        projection: parseSelectProjection("id"),
      }),
    ).toEqual({ id: 1 });
    expect(setups.calls).toHaveLength(1);
    expect(ownedSetups.calls).toHaveLength(0);
  });

  for (const failure of ["sync", "start", "missing"] as const) {
    it(`reports projection startup failure: ${failure}`, async () => {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        "projection-startup-failure",
        { type: "object", properties: { id: { type: "number" } } },
        tx,
      );
      source.set({ id: 1 });
      expect((await tx.commit()).ok).toBeDefined();

      using injected = failure === "sync"
        ? stub(
          runtime.runner,
          "syncStoredPieceCells",
          () => Promise.reject(new Error("dependency sync failed")),
        )
        : stub(
          runtime,
          "start",
          () =>
            failure === "start"
              ? Promise.reject("pattern start failed")
              : Promise.resolve(false),
        );
      const message = failure === "sync"
        ? "dependency sync failed"
        : failure === "start"
        ? "pattern start failed"
        : "projection did not start";
      await expect(deriveSelectedValue(runtime, space, source, {
        projection: parseSelectProjection("id"),
      })).rejects.toThrow(`Could not apply get transform: ${message}`);
      expect(injected.calls).toHaveLength(1);
    });
  }

  it("returns projection-ordered output without a storage-wide sync", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "transform-output-readiness-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            label: { type: "string" },
            ignored: { type: "string" },
          },
        },
      },
      setup,
    );
    source.set([
      { id: 1, label: "first", ignored: "not selected" },
      { id: 2, label: "second", ignored: "not selected" },
    ]);
    expect((await setup.commit()).ok).toBeDefined();

    const originalSynced = storageManager.synced.bind(storageManager);
    let storageWideSyncs = 0;
    storageManager.synced = () => {
      storageWideSyncs++;
      return originalSynced();
    };
    try {
      const result = await deriveSelectedValue(runtime, space, source, {
        projection: parseSelectProjection("label,id"),
      });
      expect(result).toEqual([
        { label: "first", id: 1 },
        { label: "second", id: 2 },
      ]);
      expect(JSON.stringify(result)).toBe(
        '[{"label":"first","id":1},{"label":"second","id":2}]',
      );
      expect(storageWideSyncs).toBe(0);
    } finally {
      storageManager.synced = originalSynced;
    }
  });

  it("orders an open projection's declared keys first, then retained extras in value order", async () => {
    const setup = runtime.edit();
    // The `toString` entry is added by key: in an object literal TypeScript
    // types a property of that name as `Object.prototype.toString` and
    // refuses the schema.
    const sourceProperties: Record<string, JSONSchema> = {
      id: { type: "number" },
      zeta: { type: "string" },
      label: { type: "string" },
      alpha: { type: "string" },
    };
    sourceProperties["toString"] = { type: "string" };
    const source = runtime.getCell(
      space,
      "transform-open-projection-order-source",
      { type: "object", properties: sourceProperties },
      setup,
    );
    // Three extras beyond the declaration, one of them spelled like an
    // `Object.prototype` member, which `in` would have mistaken for
    // present-on-every-object and dropped.
    source.set({
      id: 1,
      zeta: "z",
      label: "first",
      toString: "own",
      alpha: "a",
    });
    expect((await setup.commit()).ok).toBeDefined();

    // Open (`additionalProperties: true`) and declaring `label` before `id`:
    // the declaration orders the keys it names, and what the projection
    // retains beyond it follows in the order the value holds them — which,
    // after a storage round trip, is the canonical (sorted) order the
    // materialized value arrives in, not the order `set()` was handed.
    const result = await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(
        '{"type":"object","properties":{"label":true,"id":true},"additionalProperties":true}',
      ),
    });
    expect(JSON.stringify(result)).toBe(
      '{"label":"first","id":1,"alpha":"a","toString":"own","zeta":"z"}',
    );
  });

  it("orders an open projection's declared keys first across an array of objects", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "transform-open-projection-array-order-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            label: { type: "string" },
            extra: { type: "string" },
          },
        },
      },
      setup,
    );
    source.set([
      { id: 1, label: "first", extra: "kept" },
      { id: 2, label: "second", extra: "kept" },
    ]);
    expect((await setup.commit()).ok).toBeDefined();

    // The open × array combination: `projectValue` decomposes the array
    // projection to its item schema, and each element renders its declared
    // keys in schema order (label before id) with the retained extra after.
    const result = await deriveSelectedValue(runtime, space, source, {
      projection: await parseSelectionProjection(
        '{"type":"array","items":{"type":"object","properties":{"label":true,"id":true},"additionalProperties":true}}',
      ),
    });
    expect(JSON.stringify(result)).toBe(
      '[{"label":"first","id":1,"extra":"kept"},{"label":"second","id":2,"extra":"kept"}]',
    );
  });

  it("a bound read composes no address for a marked position the value does not hold, prototype names included", async () => {
    // A declared result whose recursion re-enters at a property spelled like
    // an `Object.prototype` member: the cut marks that position, and the
    // bound read composes an address for it only where the value holds the
    // key as its own. `in` found `Object.prototype.toString` on a value
    // without one and composed an address for a key the value never had.
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "transform-bound-read-prototype-source",
      { type: "object", properties: { label: { type: "string" } } },
      setup,
    );
    source.set({ label: "held" });
    expect((await setup.commit()).ok).toBeDefined();

    const nodeProperties: Record<string, JSONSchema> = {
      label: { type: "string" },
    };
    nodeProperties["toString"] = { $ref: "#/$defs/Node" };
    const declared: JSONSchema = {
      $defs: { Node: { type: "object", properties: nodeProperties } },
      $ref: "#/$defs/Node",
    };

    const result = await boundReadValue(
      source,
      declared,
      { label: "held" },
      space,
    ) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["label"]);
    expect(Object.hasOwn(result, "toString")).toBe(false);
  });

  it("a closed projection emits only keys the value holds, prototype names included", async () => {
    const setup = runtime.edit();
    const sourceProperties: Record<string, JSONSchema> = {
      label: { type: "string" },
    };
    sourceProperties["toString"] = { type: "string" };
    const source = runtime.getCell(
      space,
      "transform-closed-projection-prototype-source",
      { type: "object", properties: sourceProperties },
      setup,
    );
    source.set({ label: "only" });
    expect((await setup.commit()).ok).toBeDefined();

    // `toString` is selected but absent from the value; `in` would have
    // found `Object.prototype.toString` and emitted the native function.
    const result = await deriveSelectedValue(runtime, space, source, {
      projection: parseSelectProjection("label,toString"),
    }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["label"]);
    expect(Object.hasOwn(result, "toString")).toBe(false);
  });

  describe("the labels a selection carries", () => {
    // The two assertions here read a derived label component back out of
    // storage through `derivedConfidentiality`. Persisting flow labels
    // writes that component. It reaches a probe document that declares no
    // ceiling of its own at the enforcement rungs where the writer-fit rule
    // measures a written value's taint, which is every rung below
    // `enforce-strict`.
    let measuring: Runtime;

    beforeEach(() => {
      measuring = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
      });
    });

    afterEach(async () => {
      await measuring.dispose();
    });

    it("carries predicate labels on filtered membership like a pattern", async () => {
      await seedLabeledDoc(measuring, "filter-element-a", {
        id: 1,
        status: "open",
      }, "alice-secret");
      await seedLabeledDoc(measuring, "filter-element-b", {
        id: 2,
        status: "closed",
      }, "bob-secret");

      const setup = measuring.edit();
      const elementA = measuring.getCell(
        space,
        "filter-element-a",
        undefined,
        setup,
      );
      const elementB = measuring.getCell(
        space,
        "filter-element-b",
        undefined,
        setup,
      );
      const source = measuring.getCell(
        space,
        "labeled-filter-source",
        { type: "array", items: { asCell: ["cell"] } },
        setup,
      );
      source.set([elementA, elementB]);
      setup.prepareCfc();
      expect((await setup.commit()).ok).toBeDefined();
      const sourceRead = measuring.getCell(
        space,
        "labeled-filter-source",
        { type: "array", items: { asCell: ["cell"] } },
      );

      let outputCell: Cell<unknown> | undefined;
      const result = await deriveSelectedValue(measuring, space, sourceRead, {
        filter: parseSelectionFilter('.status == "open"'),
      }, {
        onOutputCell: (cell) => outputCell = cell,
      });
      expect(result).toEqual([{ id: 1, status: "open" }]);

      const probeTx = measuring.edit();
      const kept = outputCell!.withTx(probeTx).get() as unknown[];
      const probe = measuring.getCell(
        space,
        "filter-membership-probe",
        undefined,
        probeTx,
      );
      probe.set({ count: kept.length });
      probeTx.prepareCfc();
      expect((await probeTx.commit()).ok).toBeDefined();

      const labels = derivedConfidentiality(
        probe.getAsNormalizedFullLink().id,
      );
      expect(labels).toContain("alice-secret");
      expect(labels).toContain("bob-secret");
    });

    it("derives projected field labels from source CFC metadata", async () => {
      const setup = measuring.edit();
      const source = measuring.getCell(
        space,
        "static-label-projection-source",
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "number",
                ifc: { confidentiality: ["source-secret"] },
              },
              ignored: { type: "string" },
            },
          },
        },
        setup,
      );
      source.set([{ id: 7, ignored: "not returned" }]);
      setup.prepareCfc();
      expect((await setup.commit()).ok).toBeDefined();

      let outputCell: Cell<unknown> | undefined;
      const result = await deriveSelectedValue(measuring, space, source, {
        projection: await parseSelectionProjection("id"),
      }, {
        onOutputCell: (cell) => outputCell = cell,
      });
      expect(result).toEqual([{ id: 7 }]);

      const probeTx = measuring.edit();
      const projectedId = outputCell!.key(0).key("id").withTx(
        probeTx,
      ).get();
      const probe = measuring.getCell(
        space,
        "projection-label-probe",
        undefined,
        probeTx,
      );
      probe.set({ projectedId });
      probeTx.prepareCfc();
      expect((await probeTx.commit()).ok).toBeDefined();

      expect(derivedConfidentiality(
        probe.getAsNormalizedFullLink().id,
      )).toContain("source-secret");
    });
  });

  async function seedLabeledDoc(
    targetRuntime: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<void> {
    const seed = targetRuntime.edit();
    const cell = targetRuntime.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [atom] },
          }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
  }

  describe("$link projection marker", () => {
    const noteSchema = {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
    } as const satisfies JSONSchema;
    const boardSchema = {
      type: "object",
      properties: {
        notes: { type: "array", items: noteSchema },
        topic: noteSchema,
        label: { type: "string" },
      },
    } as const satisfies JSONSchema;

    /**
     * A board whose `topic` and `notes` entries are stored as links, the shape
     * a verb produces when it hands back the piece it created. `written` says
     * whether the note documents exist: reading an unwritten one has to reach
     * storage, which is what makes a read of it observable.
     */
    async function seedBoard(
      cause: string,
      written: boolean,
    ): Promise<{ board: Cell<unknown>; notes: Cell<unknown>[] }> {
      const tx = runtime.edit();
      const notes = ["a", "b", "c"].map((suffix) => {
        const note = runtime.getCell(
          space,
          `${cause}-note-${suffix}`,
          noteSchema,
          tx,
        );
        if (written) note.set({ title: suffix, body: `body ${suffix}` });
        return note;
      });
      const board = runtime.getCell(space, `${cause}-board`, boardSchema, tx);
      board.setRaw({
        notes: notes.map((note) => note.getAsLink()),
        topic: notes[0].getAsLink(),
        label: "Field notes",
      } as never);
      expect((await tx.commit()).ok).toBeDefined();
      return {
        board: runtime.getCell(space, `${cause}-board`, boardSchema),
        notes,
      };
    }

    /** The canonical reference a marked position at `path` inside `cell`
     * renders as: one string carrying id, scope and path. */
    function addressOf(cell: Cell<unknown>, ...path: string[]) {
      return createLLMFriendlyLink(
        { ...cell.getAsNormalizedFullLink(), path },
        space,
      );
    }

    const uriOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;

    /**
     * Which of `cells`' documents `read` reaches, in the order the provider
     * first synced each. Answering a read from a document that is not loaded
     * has to reach storage, so a document seeded unwritten is one whose read is
     * observable here.
     *
     * Only the documents named are counted: a read of the transform's own
     * session documents says nothing about which of the source's data the
     * selection reached. Each is counted once — a document consulted twice is
     * still one document read — so this bounds the documents a selection
     * reaches rather than the syncs it issues, and the syncs run
     * concurrently, so a caller comparing more than one sorts.
     *
     * A document already resident is reached without a sync, so absence from
     * this list is evidence only for a document the fixture left unwritten.
     * Name those, rather than asserting over documents the fixture wrote.
     */
    async function distinctDocumentsRead(
      cells: Cell<unknown>[],
      read: () => Promise<unknown>,
    ): Promise<string[]> {
      const provider = storageManager.open(space);
      const originalSync = provider.sync.bind(provider);
      const named = cells.map(uriOf);
      const reached: string[] = [];
      provider.sync = ((uri, selector, scope) => {
        if (named.includes(uri) && !reached.includes(uri)) reached.push(uri);
        return originalSync(uri, selector, scope);
      }) as typeof provider.sync;
      try {
        await read();
      } finally {
        provider.sync = originalSync;
      }
      return reached;
    }

    /**
     * How many times `read` syncs `cell`'s document.
     * {@link distinctDocumentsRead} bounds which documents a selection
     * reaches; this bounds how often it asks for one, which is what asking
     * twice costs a caller across a real link. A sync is requested
     * synchronously even where its result is not awaited, so a second request
     * lands inside the window rather than racing it.
     */
    async function documentSyncs(
      cell: Cell<unknown>,
      read: () => Promise<unknown>,
    ): Promise<number> {
      const provider = storageManager.open(space);
      const originalSync = provider.sync.bind(provider);
      const uri = uriOf(cell);
      let syncs = 0;
      provider.sync = ((requested, selector, scope) => {
        if (requested === uri) syncs++;
        return originalSync(requested, selector, scope);
      }) as typeof provider.sync;
      try {
        await read();
      } finally {
        provider.sync = originalSync;
      }
      return syncs;
    }

    it("writes an address as one canonical reference string", async () => {
      // The form the whole fabric names a cell by: `--piece` reads it back,
      // a pattern reads it back, and nothing has to be reassembled from
      // separate fields to pass it on.
      const { board, notes } = await seedBoard("link-marker-canonical", true);
      const marked = await deriveSelectedValue(runtime, space, board, {
        projection: await parseSelectionProjection('{"$link":true}'),
      }) as { $link: string };
      expect(marked.$link).toBe(`/${uriOf(board)}`);
      expect(parseLLMFriendlyLink(marked.$link)).toMatchObject({
        id: uriOf(board),
        path: [],
      });
      expect(notes.length).toBe(3);
    });

    it("round-trips a marked position's path through the reference parser", async () => {
      // The case that made a single string necessary: an address BELOW a
      // document's root. Quoting the id alone names the root instead — a
      // different cell — so the path has to ride in the same string, and
      // come back out of it.
      const { board } = await seedBoard("link-marker-round-trip", true);
      const concise = await deriveSelectedValue(runtime, space, board, {
        projection: parseSelectProjection("label@"),
      }) as { label: { $link: string } };
      expect(parseLLMFriendlyLink(concise.label.$link)).toMatchObject({
        id: uriOf(board),
        path: ["label"],
      });
      // The other projection spelling reaches the same string, so neither
      // grammar has an address form the other lacks.
      const json = await deriveSelectedValue(runtime, space, board, {
        projection: await parseSelectionProjection(
          '{"properties":{"notes":{"$link":true}}}',
        ),
      }) as { notes: { $link: string } };
      expect(json.notes.$link).toBe(`/${uriOf(board)}/notes`);
      expect(parseLLMFriendlyLink(json.notes.$link)).toMatchObject({
        id: uriOf(board),
        path: ["notes"],
      });
    });

    it("prefixes an address with its space DID for a reader in another space", async () => {
      // The space is part of the address, and a reader working in another
      // space needs it spelled out — a bare id would resolve in the reader's
      // own space, which is a different cell.
      const reader = (await Identity.fromPassphrase("cf-other-space")).did();
      const { board } = await seedBoard("link-marker-cross-space", true);
      const marked = await deriveSelectedValue(runtime, reader, board, {
        projection: await parseSelectionProjection('{"$link":true}'),
      }) as { $link: string };
      expect(marked.$link).toBe(`//${space}/${uriOf(board)}`);
      expect(parseLLMFriendlyLink(marked.$link)).toMatchObject({
        id: uriOf(board),
        space,
      });
    });

    it("returns a marked position's address instead of its contents", async () => {
      const { board, notes } = await seedBoard("link-marker-instead", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"properties":{"topic":{"$link":true}}}',
          ),
        }),
      ).toEqual({ topic: { $link: addressOf(notes[0]) } });
    });

    /**
     * The board reopened under a schema that marks its fields required. A
     * generated pattern schema does this and `boardSchema` above does not,
     * which is the whole reason a rejected position surviving into `required`
     * stayed invisible to these tests while breaking a live read.
     */
    const requiredBoardSchema = {
      ...boardSchema,
      required: ["topic", "label"],
    } as const satisfies JSONSchema;

    it("reads a required sibling beside a marked position", async () => {
      const { notes } = await seedBoard("link-marker-required", true);
      const board = runtime.getCell(
        space,
        "link-marker-required-board",
        requiredBoardSchema,
      );
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"properties":{"topic":{"$link":true},"label":true}}',
          ),
        }),
      ).toEqual({
        topic: { $link: addressOf(notes[0]) },
        label: "Field notes",
      });
    });

    it("returns the address and the contents asked for beside it", async () => {
      const { board, notes } = await seedBoard("link-marker-beside", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"type":"object","properties":{"topic":' +
              '{"$link":true,"type":"object","properties":{"title":true}}}}',
          ),
        }),
      ).toEqual({ topic: { $link: addressOf(notes[0]), title: "a" } });
    });

    it("returns both when the marked position's projection states no type", async () => {
      const { board, notes } = await seedBoard("link-marker-untyped", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"properties":{"topic":{"$link":true,"properties":{"title":true}}}}',
          ),
        }),
      ).toEqual({ topic: { $link: addressOf(notes[0]), title: "a" } });
    });

    it("returns an address per element for a marked collection", async () => {
      const { board, notes } = await seedBoard("link-marker-collection", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"properties":{"notes":{"type":"array","items":{"$link":true}}}}',
          ),
        }),
      ).toEqual({ notes: notes.map((note) => ({ $link: addressOf(note) })) });
    });

    it("returns the link crossed above a marked position, plus the segments below it", async () => {
      const { board, notes } = await seedBoard("link-marker-below", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"properties":{"notes":{"type":"array","items":' +
              '{"properties":{"title":{"$link":true}}}}}}',
          ),
        }),
      ).toEqual({
        notes: notes.map((note) => ({
          title: { $link: addressOf(note, "title") },
        })),
      });
    });

    it("returns the link stored at the read's own source for a marked position below it", async () => {
      const { board, notes } = await seedBoard(
        "link-marker-below-source",
        true,
      );
      expect(
        await deriveSelectedValue(runtime, space, board.key("topic"), {
          projection: await parseSelectionProjection(
            '{"properties":{"title":{"$link":true}}}',
          ),
        }),
      ).toEqual({
        title: { $link: addressOf(notes[0], "title") },
      });
    });

    it("returns a stored link's own path followed by the segments below it", async () => {
      const tx = runtime.edit();
      const note = runtime.getCell(
        space,
        "link-marker-nested-note",
        { type: "object", properties: { content: noteSchema } } as const,
        tx,
      );
      note.set({ content: { title: "a", body: "body a" } });
      const board = runtime.getCell(
        space,
        "link-marker-nested-board",
        boardSchema,
        tx,
      );
      board.setRaw({
        notes: [],
        topic: note.key("content").getAsLink(),
        label: "Field notes",
      } as never);
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await deriveSelectedValue(
          runtime,
          space,
          runtime.getCell(space, "link-marker-nested-board", boardSchema),
          {
            projection: await parseSelectionProjection(
              '{"properties":{"topic":{"properties":{"title":{"$link":true}}}}}',
            ),
          },
        ),
      ).toEqual({
        topic: {
          title: {
            $link: addressOf(note, "content", "title"),
          },
        },
      });
    });

    it("reads one document for a marked collection, whether the marker sits on the link or below it", async () => {
      const { board, notes } = await seedBoard("link-marker-reads", false);
      const documents = [board, ...notes];
      const reopened = () =>
        runtime.getCell(space, "link-marker-reads-board", boardSchema);
      const onTheLink = await parseSelectionProjection(
        '{"properties":{"notes":{"type":"array","items":{"$link":true}}}}',
      );
      const belowTheLink = await parseSelectionProjection(
        '{"properties":{"notes":{"type":"array","items":' +
          '{"type":"object","properties":{"title":{"$link":true}}}}}}',
      );
      const unmarked = await parseSelectionProjection(
        '{"properties":{"notes":{"type":"array","items":' +
          '{"type":"object","properties":{"title":true}}}}}',
      );

      expect(
        await distinctDocumentsRead(
          documents,
          () =>
            deriveSelectedValue(runtime, space, board, {
              projection: onTheLink,
            }),
        ),
      ).toEqual([uriOf(board)]);
      expect(
        await distinctDocumentsRead(
          documents,
          () =>
            deriveSelectedValue(runtime, space, reopened(), {
              projection: belowTheLink,
            }),
        ),
      ).toEqual([uriOf(board)]);

      // The control: the same collection asked for its contents does load
      // every element, which is what makes the two reads above evidence of a
      // suppressed fetch rather than of a harness that observes nothing. It
      // counts the element documents alone, so what it asserts does not depend
      // on the reads above having warmed the board.
      expect(
        (await distinctDocumentsRead(
          notes,
          () =>
            deriveSelectedValue(runtime, space, reopened(), {
              projection: unmarked,
            }),
        )).toSorted(),
      ).toEqual(notes.map(uriOf).toSorted());
    });

    it("loads the source document once for a selection that is entirely addresses", async () => {
      const { board } = await seedBoard("link-marker-source-syncs", false);
      const reopened = () =>
        runtime.getCell(space, "link-marker-source-syncs-board", boardSchema);

      // The read and the walk that composes the addresses are one cell, so
      // the walk does not ask for the document the read just loaded.
      expect(
        await documentSyncs(
          board,
          () =>
            deriveSelectedValue(runtime, space, board, {
              projection: parseSelectProjection("notes@"),
            }),
        ),
      ).toBe(1);
      expect(
        await documentSyncs(
          board,
          () =>
            deriveSelectedValue(runtime, space, reopened(), {
              projection: parseSelectProjection("notes.title@"),
            }),
        ),
      ).toBe(1);
    });

    it("reads one document for a marker below a link, not the document the link names", async () => {
      const { board, notes } = await seedBoard(
        "link-marker-below-reads",
        false,
      );
      const belowTheLink = await parseSelectionProjection(
        '{"properties":{"topic":{"properties":{"title":{"$link":true}}}}}',
      );

      expect(
        await distinctDocumentsRead(
          [board, ...notes],
          () =>
            deriveSelectedValue(runtime, space, board, {
              projection: belowTheLink,
            }),
        ),
      ).toEqual([uriOf(board)]);
    });

    /**
     * A board whose `notes` is itself a link to the document holding the
     * array, which is the shape a value assembled elsewhere arrives in — a
     * collection the source names but does not contain. The elements are the
     * links `seedBoard` writes, and the note documents stay unwritten.
     */
    async function seedLinkedCollection(
      cause: string,
    ): Promise<{
      board: Cell<unknown>;
      holder: Cell<unknown>;
      notes: Cell<unknown>[];
    }> {
      const tx = runtime.edit();
      const notes = ["a", "b", "c"].map((suffix) =>
        runtime.getCell(space, `${cause}-note-${suffix}`, noteSchema, tx)
      );
      const holderSchema = {
        type: "object",
        properties: { notes: { type: "array", items: noteSchema } },
      } as const satisfies JSONSchema;
      const holder = runtime.getCell(
        space,
        `${cause}-holder`,
        holderSchema,
        tx,
      );
      holder.setRaw({ notes: notes.map((note) => note.getAsLink()) } as never);
      const board = runtime.getCell(space, `${cause}-board`, boardSchema, tx);
      board.setRaw({
        notes: holder.key("notes").getAsLink(),
        topic: notes[0].getAsLink(),
        label: "Field notes",
      } as never);
      expect((await tx.commit()).ok).toBeDefined();
      return {
        board: runtime.getCell(space, `${cause}-board`, boardSchema),
        holder,
        notes,
      };
    }

    it("reads no element document for a marker below a linked collection", async () => {
      const { board, notes } = await seedLinkedCollection(
        "link-marker-linked-collection",
      );
      const titleAddresses = notes.map((note) => ({
        title: { $link: addressOf(note, "title") },
      }));
      let value: unknown;

      // The element documents are what this asserts over. Enumerating the
      // collection reaches the document holding it — which a reader that did
      // not write it fetches, and this one already holds — while the document
      // each element links to is never reached, because every position asked
      // for below there is an address the element's own slot already holds.
      expect(
        await distinctDocumentsRead(notes, async () => {
          value = await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("notes.title@"),
          });
        }),
      ).toEqual([]);
      expect(value).toEqual({ notes: titleAddresses });
    });

    it("returns the address of the position it was read at for a marked root", async () => {
      const { board, notes } = await seedBoard("link-marker-root", true);
      expect(
        await deriveSelectedValue(runtime, space, board.key("topic"), {
          projection: await parseSelectionProjection('{"$link":true}'),
        }),
      ).toEqual({ $link: addressOf(notes[0]) });
    });

    it("returns where an inline value lives when nothing is linked there", async () => {
      const tx = runtime.edit();
      const board = runtime.getCell(
        space,
        "link-marker-inline",
        boardSchema,
        tx,
      );
      board.set({
        notes: [],
        topic: { title: "a", body: "inline" },
        label: "L",
      });
      expect((await tx.commit()).ok).toBeDefined();

      const read = runtime.getCell(space, "link-marker-inline", boardSchema);
      expect(
        await deriveSelectedValue(runtime, space, read, {
          projection: await parseSelectionProjection(
            '{"properties":{"topic":{"$link":true}}}',
          ),
        }),
      ).toEqual({
        topic: {
          $link: addressOf(read, "topic"),
        },
      });
    });

    it("returns the address alone where the contents are not an object", async () => {
      const { board } = await seedBoard("link-marker-scalar", true);
      expect(
        await deriveSelectedValue(runtime, space, board, {
          projection: await parseSelectionProjection(
            '{"type":"object","properties":{"label":{"$link":true,"type":"string"}}}',
          ),
        }),
      ).toEqual({
        label: {
          $link: addressOf(board, "label"),
        },
      });
    });

    it("leaves a marked collection alone when nothing is stored at it", async () => {
      const tx = runtime.edit();
      const board = runtime.getCell(
        space,
        "link-marker-unset",
        boardSchema,
        tx,
      );
      board.set({ topic: { title: "a", body: "b" }, label: "L" } as never);
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await deriveSelectedValue(
          runtime,
          space,
          runtime.getCell(space, "link-marker-unset", boardSchema),
          {
            projection: await parseSelectionProjection(
              '{"type":"object","properties":{"label":true,"notes":' +
                '{"type":"array","items":{"$link":true}}}}',
            ),
          },
        ),
      ).toEqual({ label: "L" });
    });

    it("refuses a marker combined with a filter", async () => {
      const { board } = await seedBoard("link-marker-filter", true);
      await expect(
        deriveSelectedValue(runtime, space, board.key("notes"), {
          filter: parseSelectionFilter('.title == "a"'),
          projection: await parseSelectionProjection(
            '{"type":"array","items":{"$link":true}}',
          ),
        }),
      ).rejects.toThrow("--filter cannot be combined");
    });

    it("refuses a marker that is not `true`", async () => {
      await expect(parseSelectionProjection('{"$link":"yes"}')).rejects
        .toThrow('"$link" must be `true`');
    });

    it("refuses a marker under `additionalProperties`", async () => {
      await expect(
        parseSelectionProjection('{"additionalProperties":{"$link":true}}'),
      ).rejects.toThrow(
        '"$link" is not supported under "additionalProperties"',
      );
    });

    it("still refuses `asCell` in a projection", async () => {
      await expect(parseSelectionProjection('{"asCell":["cell"]}')).rejects
        .toThrow('"asCell" is controlled by the source schema');
    });

    describe("the `@` suffix a concise field path writes", () => {
      it("desugars to the marker the JSON spelling writes", async () => {
        const written = await parseSelectionProjection(
          '{"properties":{"topic":{"$link":true}}}',
        );
        for (
          const parsed of [
            parseSelectProjection("topic@"),
            await parseSelectionProjection("topic@"),
          ]
        ) {
          expect(parsed.schema).toEqual(written.schema);
          expect(parsed.markers).toEqual(written.markers);
        }
      });

      it("unions a marked path with a sibling projection into one position", () => {
        const union = {
          type: "object",
          properties: {
            topic: {
              type: "object",
              properties: { title: true },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        };
        for (
          const source of [
            "topic@,topic.title",
            "topic.title,topic@",
            "topic@.title",
          ]
        ) {
          const parsed = parseSelectProjection(source);
          expect(parsed.schema).toEqual(union);
          expect(parsed.markers).toEqual({
            properties: { topic: { marked: true } },
          });
        }
      });

      it("returns a marked position's address instead of its contents", async () => {
        const { board, notes } = await seedBoard("at-suffix-instead", true);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("topic@"),
          }),
        ).toEqual({ topic: { $link: addressOf(notes[0]) } });
      });

      it("returns one result carrying the address and the projection", async () => {
        const { board, notes } = await seedBoard("at-suffix-union", true);
        for (
          const source of [
            "topic@,topic.title",
            "topic.title,topic@",
            "topic@.title",
          ]
        ) {
          expect(
            await deriveSelectedValue(runtime, space, board, {
              projection: parseSelectProjection(source),
            }),
          ).toEqual({ topic: { $link: addressOf(notes[0]), title: "a" } });
        }
      });

      it("returns the address beside the contents a bare sibling path asked for", async () => {
        const { board, notes } = await seedBoard("at-suffix-whole", true);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("topic,topic@"),
          }),
        ).toEqual({
          topic: { $link: addressOf(notes[0]), title: "a", body: "body a" },
        });
      });

      it("desugars a bare `@` to the marker at the projection's root", async () => {
        const written = await parseSelectionProjection('{"$link":true}');
        const parsed = parseSelectProjection("@");
        expect(parsed.schema).toEqual(written.schema);
        expect(parsed.markers).toEqual(written.markers);
      });

      it("returns the read source's own address for a bare `@`", async () => {
        const { board, notes } = await seedBoard("at-suffix-root", true);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("@"),
          }),
        ).toEqual({ $link: addressOf(board) });
        expect(
          await deriveSelectedValue(runtime, space, board.key("topic"), {
            projection: parseSelectProjection("@"),
          }),
        ).toEqual({ $link: addressOf(notes[0]) });
      });

      it("returns the read source's address beside a sibling projection", async () => {
        const { board } = await seedBoard("at-suffix-root-union", true);
        for (const source of ["@,label", "label,@"]) {
          expect(
            await deriveSelectedValue(runtime, space, board, {
              projection: parseSelectProjection(source),
            }),
          ).toEqual({ $link: addressOf(board), label: "Field notes" });
        }
      });

      it("points a leading `@` that names a file at --schema", () => {
        for (const source of ["@projection.json", "@label", "@label,label"]) {
          expect(() => parseSelectProjection(source)).toThrow(
            "--select takes comma-separated field paths",
          );
        }
      });

      it("returns an address per element for a marked array", async () => {
        const { board, notes } = await seedBoard("at-suffix-array", true);
        const elementAddresses = notes.map((note) => ({
          $link: addressOf(note),
        }));
        const concise = await deriveSelectedValue(runtime, space, board, {
          projection: parseSelectProjection("notes@"),
        });
        expect(concise).toEqual({ notes: elementAddresses });
        // The concise spelling of the JSON items marker, so it answers with
        // what the JSON items marker answers.
        expect(concise).toEqual(
          await deriveSelectedValue(runtime, space, board, {
            projection: await parseSelectionProjection(
              '{"properties":{"notes":{"type":"array","items":{"$link":true}}}}',
            ),
          }),
        );
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("notes@,label"),
          }),
        ).toEqual({ notes: elementAddresses, label: "Field notes" });
      });

      it("leaves a JSON marker on an array naming that array's own position", async () => {
        const { board } = await seedBoard("at-suffix-json-array", true);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: await parseSelectionProjection(
              '{"properties":{"notes":{"$link":true}}}',
            ),
          }),
        ).toEqual({
          notes: { $link: addressOf(board, "notes") },
        });
      });

      it("returns an address per element for a bare `@` at an array", async () => {
        const { board, notes } = await seedBoard("at-suffix-array-root", true);
        expect(
          await deriveSelectedValue(runtime, space, board.key("notes"), {
            projection: parseSelectProjection("@"),
          }),
        ).toEqual(notes.map((note) => ({ $link: addressOf(note) })));
      });

      it("returns each element's address beside the addresses marked below it", async () => {
        const { board, notes } = await seedBoard("at-suffix-array-deep", true);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("notes@,notes.title@"),
          }),
        ).toEqual({
          notes: notes.map((note) => ({
            $link: addressOf(note),
            title: { $link: addressOf(note, "title") },
          })),
        });
      });

      it("marks a position below an array for each of its elements", async () => {
        const { board, notes } = await seedBoard("at-suffix-elements", true);
        const titleAddresses = notes.map((note) => ({
          title: { $link: addressOf(note, "title") },
        }));

        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: parseSelectProjection("notes.title@"),
          }),
        ).toEqual({ notes: titleAddresses });
        expect(
          await deriveSelectedValue(runtime, space, board.key("notes"), {
            projection: parseSelectProjection("title@"),
          }),
        ).toEqual(titleAddresses);
        expect(
          await deriveSelectedValue(runtime, space, board, {
            projection: await parseSelectionProjection(
              '{"properties":{"notes":{"items":' +
                '{"properties":{"title":{"$link":true}}}}}}',
            ),
          }),
        ).toEqual({ notes: titleAddresses });
      });

      it("marks a position below an array the source schema leaves open", async () => {
        const openSchema = {
          type: "object",
          properties: { comments: true },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        const source = runtime.getCell(
          space,
          "at-suffix-ambiguous",
          openSchema,
          tx,
        );
        source.set({
          comments: [{ body: "Visible", privateNote: "hidden" }],
        });
        expect((await tx.commit()).ok).toBeDefined();

        // Writing an object into an array gives it a document of its own, and
        // the slot stores a link to it. That link is the deepest one the walk
        // crosses, so `body` is addressed inside the element's own document.
        const comment = source.key("comments").key(0).resolveAsCell();
        expect(
          await deriveSelectedValue(
            runtime,
            space,
            runtime.getCell(space, "at-suffix-ambiguous", openSchema),
            { projection: parseSelectProjection("comments.body@") },
          ),
        ).toEqual({
          comments: [{
            body: { $link: addressOf(comment, "body") },
          }],
        });
      });

      it("reads one document for a marked collection, whether the marker sits on the link or below it", async () => {
        const { board, notes } = await seedBoard("at-suffix-reads", false);
        const documents = [board, ...notes];
        const reopened = () =>
          runtime.getCell(space, "at-suffix-reads-board", boardSchema);

        expect(
          await distinctDocumentsRead(
            documents,
            () =>
              deriveSelectedValue(runtime, space, board, {
                projection: parseSelectProjection("notes@"),
              }),
          ),
        ).toEqual([uriOf(board)]);
        expect(
          await distinctDocumentsRead(
            documents,
            () =>
              deriveSelectedValue(runtime, space, reopened(), {
                projection: parseSelectProjection("notes.title@"),
              }),
          ),
        ).toEqual([uriOf(board)]);

        // The control, as in the JSON spelling above: the unmarked field list
        // loads every element, counted over the element documents alone so
        // the board's residency does not decide it.
        expect(
          (await distinctDocumentsRead(
            notes,
            () =>
              deriveSelectedValue(runtime, space, reopened(), {
                projection: parseSelectProjection("notes.title"),
              }),
          )).toSorted(),
        ).toEqual(notes.map(uriOf).toSorted());
      });

      it("reads one document for a marked field below the array the read starts at", async () => {
        const { board, notes } = await seedBoard("at-suffix-root-reads", false);

        expect(
          await distinctDocumentsRead(
            [board, ...notes],
            () =>
              deriveSelectedValue(runtime, space, board.key("notes"), {
                projection: parseSelectProjection("title@"),
              }),
          ),
        ).toEqual([uriOf(board)]);
      });

      it("reaches a field whose name holds an `@` of its own", async () => {
        const oddNameSchema = {
          type: "object",
          properties: {
            "user@home": { type: "string" },
            "a@": { type: "string" },
          },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        const source = runtime.getCell(
          space,
          "at-suffix-escapes",
          oddNameSchema,
          tx,
        );
        source.set({ "user@home": "here", "a@": "there" });
        expect((await tx.commit()).ok).toBeDefined();

        expect(
          await deriveSelectedValue(
            runtime,
            space,
            runtime.getCell(space, "at-suffix-escapes", oddNameSchema),
            { projection: parseSelectProjection("user@home,a\\@") },
          ),
        ).toEqual({ "user@home": "here", "a@": "there" });
      });

      it("refuses a marked path combined with a filter, naming the flag", async () => {
        const { board } = await seedBoard("at-suffix-filter", true);
        await expect(
          deriveSelectedValue(runtime, space, board.key("notes"), {
            filter: parseSelectionFilter('.title == "a"'),
            projection: parseSelectProjection("title@"),
          }),
        ).rejects.toThrow(
          "--filter cannot be combined with an `@` suffix in --select",
        );
        await expect(
          deriveSelectedValue(runtime, space, board.key("notes"), {
            filter: parseSelectionFilter('.title == "a"'),
            projection: await parseSelectionProjection("title@"),
          }),
        ).rejects.toThrow(
          "--filter cannot be combined with an `@` suffix in --schema",
        );
      });
    });
  });

  describe("--select", () => {
    it("parses the concise spelling into the projection --schema parses", async () => {
      const selected = parseSelectProjection("id,author.name");
      const schema = await parseSelectionProjection("id,author.name");

      expect(selected.kind).toBe("concise");
      expect(selected.flag).toBe("--select");
      expect(schema.flag).toBe("--schema");
      expect(selected.schema).toEqual(schema.schema);
      expect(selected.source).toBe(schema.source);
    });

    it("projects an array through the same step --schema projects through", async () => {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        "select-flag-source",
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              title: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        tx,
      );
      source.set([
        { id: 1, title: "First", status: "open" },
        { id: 2, title: "Second", status: "closed" },
      ]);
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await deriveSelectedValue(runtime, space, source, {
          filter: parseSelectionFilter('.status == "open"'),
          projection: parseSelectProjection("id,title"),
        }),
      ).toEqual([{ id: 1, title: "First" }]);
    });

    it("points a JSON Schema or @file argument at --schema", () => {
      for (
        const source of [
          '{"type":"object","properties":{"id":true}}',
          "@projection.json",
          "true",
          "false",
        ]
      ) {
        expect(() => parseSelectProjection(source)).toThrow(
          "--select takes comma-separated field paths",
        );
      }
    });

    it("names itself in the errors its own argument causes", async () => {
      expect(() => parseSelectProjection("")).toThrow(
        "--select must not be empty",
      );
      expect(() => parseSelectProjection("a,,b")).toThrow(
        "Invalid --select concise projection",
      );
      expect(() => parseSelectProjection("a.0")).toThrow(
        'Invalid --select field path "a.0"',
      );

      const tx = runtime.edit();
      const objectSource = runtime.getCell(
        space,
        "select-flag-root-mismatch-source",
        { type: "array", items: { type: "object" } },
        tx,
      );
      objectSource.set({ id: 1 } as never);
      expect((await tx.commit()).ok).toBeDefined();

      await expect(deriveSelectedValue(runtime, space, objectSource, {
        projection: parseSelectProjection("id"),
      })).rejects.toThrow(
        /^--select can only project array items from an array value$/,
      );
    });

    it("names itself when a source reference cannot resolve", () => {
      expect(() => schemaMayBeArray({ $ref: "#/$defs/Missing", $defs: {} }))
        .toThrow("Could not resolve source schema reference for --schema");
      expect(() =>
        schemaMayBeArray({ $ref: "#/$defs/Missing", $defs: {} }, "--select")
      ).toThrow("Could not resolve source schema reference for --select");
    });
  });

  describe("a read repeated over one host", () => {
    const itemsSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
      },
    } as const satisfies JSONSchema;

    /** A committed array source, so a read has something to project. */
    async function seededSource(
      host: Runtime,
      cause: string,
      value: Array<{ id: number; title: string }>,
    ): Promise<Cell<unknown>> {
      const tx = host.edit();
      const source = host.getCell(space, cause, itemsSchema, tx);
      source.set(value);
      expect((await tx.commit()).ok).toBeDefined();
      return source as Cell<unknown>;
    }

    /** The value `selection` reads, beside the cell it was answered from. */
    async function readWithCell(
      host: Runtime,
      source: Cell<unknown>,
      selection: Parameters<typeof deriveSelectedValue>[3],
    ): Promise<{ value: unknown; cell: string }> {
      let outputCell: Cell<unknown> | undefined;
      const value = await deriveSelectedValue(host, space, source, selection, {
        onOutputCell: (cell) => outputCell = cell,
      });
      return { value, cell: outputCell!.getAsNormalizedFullLink().id };
    }

    it("returns the repeat from the cell the first read set up", async () => {
      const source = await seededSource(runtime, "repeat-identical-source", [
        { id: 1, title: "First" },
        { id: 2, title: "Second" },
      ]);
      const selection = { projection: await parseSelectionProjection("id") };

      const first = await readWithCell(runtime, source, selection);
      const second = await readWithCell(runtime, source, selection);

      expect(first.value).toEqual([{ id: 1 }, { id: 2 }]);
      expect(second.value).toEqual([{ id: 1 }, { id: 2 }]);
      // The same cell, not a fresh one per read: the repeat reuses the
      // transform the first read installed rather than minting its own.
      expect(second.cell).toBe(first.cell);
    });

    it("returns the repeat with a source change made between the reads", async () => {
      const source = await seededSource(runtime, "repeat-restated-source", [
        { id: 1, title: "First" },
      ]);
      const selection = { projection: await parseSelectionProjection("id") };

      const first = await readWithCell(runtime, source, selection);
      expect(first.value).toEqual([{ id: 1 }]);

      const tx = runtime.edit();
      source.withTx(tx).set([
        { id: 1, title: "First" },
        { id: 2, title: "Second" },
      ]);
      expect((await tx.commit()).ok).toBeDefined();

      // The reused cell answers what the source says now. A repeat that
      // replayed the first read's stored answer would still report one row.
      const second = await readWithCell(runtime, source, selection);
      expect(second.value).toEqual([{ id: 1 }, { id: 2 }]);
      expect(second.cell).toBe(first.cell);
    });

    it("returns each differing selection from its own cell", async () => {
      const source = await seededSource(runtime, "repeat-distinct-source", [
        { id: 1, title: "First" },
        { id: 2, title: "Second" },
      ]);

      const ids = await readWithCell(runtime, source, {
        projection: await parseSelectionProjection("id"),
      });
      const titles = await readWithCell(runtime, source, {
        projection: await parseSelectionProjection("title"),
      });
      const filtered = await readWithCell(runtime, source, {
        filter: parseSelectionFilter(".id == 2"),
        projection: await parseSelectionProjection("id"),
      });
      const other = await seededSource(runtime, "repeat-other-source", [
        { id: 7, title: "Other" },
      ]);
      const elsewhere = await readWithCell(runtime, other, {
        projection: await parseSelectionProjection("id"),
      });
      const repeat = await readWithCell(runtime, source, {
        projection: await parseSelectionProjection("id"),
      });

      expect(ids.value).toEqual([{ id: 1 }, { id: 2 }]);
      expect(titles.value).toEqual([{ title: "First" }, { title: "Second" }]);
      expect(filtered.value).toEqual([{ id: 2 }]);
      expect(elsewhere.value).toEqual([{ id: 7 }]);
      // A differing projection, filter or source is a different read and gets
      // its own cell; only the repeat lands back on the first read's.
      expect(
        new Set([ids.cell, titles.cell, filtered.cell, elsewhere.cell]).size,
      ).toBe(4);
      expect(repeat.cell).toBe(ids.cell);
    });

    it("returns a repeat whose source changed root kind between the reads", async () => {
      // A source whose schema names no root kind has its array-ness read off
      // the value, and the projection's shape follows it. So the two reads
      // below ask the same thing of two different shapes, and answering the
      // second from the first read's transform would map over a non-array.
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        "repeat-kind-flip-source",
        true,
        tx,
      );
      source.set([{ id: 1, title: "First" }] as never);
      expect((await tx.commit()).ok).toBeDefined();
      const selection = { projection: await parseSelectionProjection("id") };

      expect(await deriveSelectedValue(runtime, space, source, selection))
        .toEqual([{ id: 1 }]);

      const flip = runtime.edit();
      source.withTx(flip).set({ id: 9, title: "Ninth" } as never);
      expect((await flip.commit()).ok).toBeDefined();

      expect(await deriveSelectedValue(runtime, space, source, selection))
        .toEqual({ id: 9 });
    });

    it("returns a second runtime's identical read over the same session", async () => {
      const source = await seededSource(runtime, "repeat-two-hosts-source", [
        { id: 1, title: "First" },
      ]);
      const selection = { projection: await parseSelectionProjection("id") };
      const first = await readWithCell(runtime, source, selection);
      expect(first.value).toEqual([{ id: 1 }]);

      const second = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const sourceThere = second.getCell(
          space,
          "repeat-two-hosts-source",
          itemsSchema,
        );
        const read = await readWithCell(second, sourceThere, selection);
        expect(read.value).toEqual([{ id: 1 }]);
        // A pattern graph belongs to the runtime that runs it, so the second
        // runtime answers from its own cell rather than inheriting the setup
        // stored on the first runtime's.
        expect(read.cell).not.toBe(first.cell);
      } finally {
        await second.dispose();
      }
    });
  });

  function derivedConfidentiality(id: string): string[] {
    type StoredEntry = {
      origin?: string;
      label: { confidentiality?: string[] };
    };
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(
        id: string,
      ): { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries
      ?.filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []) ?? [];
  }
});
