import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/utils/logger";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  anySchema,
  ARRAY_SUBSCHEMA_KEYS,
  DEFS_KEYS,
  findSchema,
  forEachSubschema,
  isSubschema,
  mapSubschemas,
  RECORD_SUBSCHEMA_KEYS,
  type SchemaNode,
  SINGLE_SUBSCHEMA_KEYS,
  subschemaEdges,
  type SubschemaKeyword,
  UNUSED_RECORD_SUBSCHEMA_KEYS,
  UNUSED_SINGLE_SUBSCHEMA_KEYS,
  walkSchema,
} from "@commonfabric/data-model-schema/schema-walk";

interface Edge {
  schema: JSONSchema;
  keyword: SubschemaKeyword;
  key?: string;
  index?: number;
}

const edgesOf = (
  root: JSONSchema,
  opts?: Parameters<typeof forEachSubschema>[2],
): Edge[] => {
  const edges: Edge[] = [];
  forEachSubschema(root, (schema, keyword, key, index) => {
    edges.push({ schema, keyword, key, index });
  }, opts);
  return edges;
};

const collect = (
  root: JSONSchema,
  opts?: Parameters<typeof walkSchema>[2],
): SchemaNode[] => {
  const nodes: SchemaNode[] = [];
  walkSchema(root, (node) => {
    nodes.push(node);
  }, opts);
  return nodes;
};

const pathKeys = (root: JSONSchema, opts?: Parameters<typeof walkSchema>[2]) =>
  collect(root, opts).map((n) => n.path.join("/"));

describe("forEachSubschema", () => {
  it("visits immediate children across all keyword shapes", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: { type: "boolean" },
      items: { type: "null" },
      prefixItems: [{ type: "string" }, { type: "number" }],
      allOf: [{ type: "object" }],
      not: { type: "array" },
    };
    const edges = edgesOf(schema);
    // properties(2) + additionalProperties(1) + items(1) + prefixItems(2)
    // + allOf(1) + not(1) = 8
    expect(edges.length).toBe(8);
    const byKeyword = new Map<string, number>();
    for (const e of edges) {
      byKeyword.set(e.keyword, (byKeyword.get(e.keyword) ?? 0) + 1);
    }
    expect(byKeyword.get("properties")).toBe(2);
    expect(byKeyword.get("prefixItems")).toBe(2);
    expect(byKeyword.get("items")).toBe(1);
    expect(byKeyword.get("not")).toBe(1);
  });

  it("carries key for record edges and index for array edges", () => {
    const schema: JSONSchema = {
      properties: { name: { type: "string" } },
      prefixItems: [{ type: "string" }, { type: "number" }],
    };
    const edges = edgesOf(schema);
    const prop = edges.find((e) => e.keyword === "properties");
    expect(prop?.key).toBe("name");
    const prefix1 = edges.find((e) =>
      e.keyword === "prefixItems" && e.index === 1
    );
    expect(prefix1?.schema).toEqual({ type: "number" });
  });

  it("skips $defs unless includeDefs is set", () => {
    const schema: JSONSchema = {
      $defs: { Foo: { type: "string" } },
      properties: { a: { $ref: "#/$defs/Foo" } },
    };
    expect(edgesOf(schema).some((e) => e.keyword === "$defs")).toBe(false);
    expect(
      edgesOf(schema, { includeDefs: true }).some((e) => e.keyword === "$defs"),
    ).toBe(true);
  });

  it("visits nothing for boolean or empty schemas", () => {
    expect(edgesOf(true).length).toBe(0);
    expect(edgesOf(false).length).toBe(0);
    expect(edgesOf({ type: "string" }).length).toBe(0);
  });

  it("stops early and reports it when a visit returns true", () => {
    const schema: JSONSchema = {
      properties: { a: { type: "string" }, b: { type: "number" } },
      items: { type: "null" },
    };
    const seen: JSONSchema[] = [];
    const stopped = forEachSubschema(schema, (child) => {
      seen.push(child);
      return true; // stop after the very first child
    });
    expect(stopped).toBe(true);
    expect(seen.length).toBe(1);
    // A visit-all returns false.
    expect(forEachSubschema(schema, () => {})).toBe(false);
  });

  it("covers every documented keyword constant", () => {
    for (const keyword of SINGLE_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: { type: "string" } });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
    for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: [{ type: "string" }] });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
    for (const keyword of RECORD_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: { x: { type: "string" } } });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
  });
});

describe("subschemaEdges (generator form)", () => {
  it("yields the same edges as forEachSubschema, usable via for-of", () => {
    const schema: JSONSchema = {
      properties: { a: { type: "string" }, b: { type: "number" } },
      prefixItems: [{ type: "string" }],
      items: { type: "null" },
      not: { type: "array" },
    };
    // for-of + spread ergonomics.
    const gen = [...subschemaEdges(schema)];
    const cb = edgesOf(schema);
    expect(gen.length).toBe(cb.length);
    expect(gen.map((e) => `${e.keyword}:${e.key ?? e.index ?? ""}`).toSorted())
      .toEqual(
        cb.map((e) => `${e.keyword}:${e.key ?? e.index ?? ""}`).toSorted(),
      );
  });

  it("honors includeDefs / includeUnused like the callback", () => {
    const schema: JSONSchema = {
      $defs: { Foo: { type: "string" } },
      patternProperties: { ".*": { type: "number" } },
    };
    expect([...subschemaEdges(schema)].length).toBe(0);
    expect([...subschemaEdges(schema, { includeDefs: true })].length).toBe(1);
    expect([...subschemaEdges(schema, { includeUnused: true })].length).toBe(1);
  });

  it("supports early break", () => {
    const schema: JSONSchema = {
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    let count = 0;
    for (const _ of subschemaEdges(schema)) {
      count++;
      break;
    }
    expect(count).toBe(1);
  });
});

describe("mapSubschemas", () => {
  it("maps definitions and unused keywords when both tiers are enabled", () => {
    const patternChild: JSONSchema = { type: "string" };
    const conditionalChild: JSONSchema = { type: "number" };
    const definitionChild: JSONSchema = { type: "boolean" };
    const schema = {
      patternProperties: { ".*": patternChild },
      if: conditionalChild,
      $defs: { Flag: definitionChild },
    } as const;
    const mapped = mapSubschemas(
      schema,
      (child) =>
        typeof child === "boolean" ? child : { ...child, title: "mapped" },
      { includeDefs: true, includeUnused: true },
    );

    expect(mapped.patternProperties?.[".*"]).toEqual({
      type: "string",
      title: "mapped",
    });
    expect(mapped.if).toEqual({ type: "number", title: "mapped" });
    expect(mapped.$defs?.Flag).toEqual({
      type: "boolean",
      title: "mapped",
    });
  });
});

describe("walkSchema", () => {
  it("visits the root then descends depth-first", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    };
    const paths = pathKeys(schema);
    expect(paths).toEqual([
      "",
      "properties/user",
      "properties/user/properties/id",
    ]);
  });

  it("builds keyword-segmented structural paths through arrays and applicators", () => {
    const schema: JSONSchema = {
      allOf: [
        { properties: { id: { type: "string" } } },
      ],
      prefixItems: [{ type: "string" }, { items: { type: "number" } }],
    };
    const paths = pathKeys(schema);
    expect(paths).toContain("allOf/0/properties/id");
    expect(paths).toContain("prefixItems/1/items");
  });

  it("descends into prefixItems (the historically-skipped keyword)", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [
        { type: "string", ifc: { integrity: ["x"] } },
      ],
    };
    const hit = findSchema(
      schema,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
    );
    expect(hit?.path.join("/")).toBe("prefixItems/0");
  });

  it("skip prunes a subtree but continues siblings", () => {
    const schema: JSONSchema = {
      properties: {
        keep: { properties: { deep: { type: "string" } } },
        prune: { properties: { hidden: { type: "string" } } },
      },
    };
    const visited: string[] = [];
    walkSchema(schema, (node) => {
      visited.push(node.path.join("/"));
      if (node.key === "prune") return "skip";
    });
    expect(visited).toContain("properties/keep/properties/deep");
    expect(visited).toContain("properties/prune");
    expect(visited).not.toContain("properties/prune/properties/hidden");
  });

  it("stop aborts the whole walk", () => {
    const schema: JSONSchema = {
      properties: {
        a: { properties: { deep: { type: "string" } } },
        b: { type: "string" },
      },
    };
    const visited: string[] = [];
    walkSchema(schema, (node) => {
      visited.push(node.path.join("/"));
      if (node.key === "a") return "stop";
    });
    expect(visited).toEqual(["", "properties/a"]);
  });

  it("exposes parent and edge discriminants", () => {
    const schema: JSONSchema = {
      properties: { name: { type: "string" } },
    };
    const nodes = collect(schema);
    const child = nodes.find((n) => n.key === "name")!;
    expect(child.keyword).toBe("properties");
    expect(child.parent).toBe(schema);
  });

  it("skips boolean subschemas by default, visits them with visitBooleans", () => {
    const schema: JSONSchema = {
      properties: { open: true, closed: false },
    };
    expect(collect(schema).length).toBe(1); // root only
    expect(collect(schema, { visitBooleans: true }).length).toBe(3);
  });

  it("visits a subschema shared by two sibling positions at both", () => {
    const shared: JSONSchema = { type: "string" };
    const schema: JSONSchema = {
      properties: { a: shared, b: shared },
    };
    const paths = pathKeys(schema);
    expect(paths).toContain("properties/a");
    expect(paths).toContain("properties/b");
  });

  it("terminates on a self-referential (cyclic) object graph", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    const nodes = collect(cyclic as JSONSchema);
    // root + the `self` edge; recursion into `self` hits the on-path guard.
    expect(nodes.map((n) => n.path.join("/"))).toEqual([
      "",
      "properties/self",
    ]);
  });
});

describe("anySchema / findSchema", () => {
  it("anySchema short-circuits and matches nested nodes", () => {
    const schema: JSONSchema = {
      properties: {
        a: { items: { ifc: { integrity: ["x"] } } },
      },
    };
    const hasIfc = (root: JSONSchema) =>
      anySchema(
        root,
        (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      );
    expect(hasIfc(schema)).toBe(true);
    expect(hasIfc({ properties: { a: { type: "string" } } })).toBe(false);
  });

  it("findSchema returns the matching node with its path", () => {
    const schema: JSONSchema = {
      anyOf: [{ type: "string" }, { const: 3 }],
    };
    const node = findSchema(
      schema,
      (n) => typeof n.schema === "object" && n.schema.const === 3,
    );
    expect(node?.path.join("/")).toBe("anyOf/1");
  });
});

describe("deliberately-excluded keywords", () => {
  const hasIfc = (root: JSONSchema, opts?: Parameters<typeof anySchema>[2]) =>
    anySchema(
      root,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      opts,
    );

  it("does not descend patternProperties / contentSchema / if-then-else / etc.", () => {
    for (
      const keyword of [
        "patternProperties",
        "dependentSchemas",
      ]
    ) {
      expect(hasIfc({ [keyword]: { x: { ifc: { integrity: ["y"] } } } }))
        .toBe(false);
    }
    for (const keyword of ["if", "then", "else", "contains", "propertyNames"]) {
      expect(hasIfc({ [keyword]: { ifc: { integrity: ["y"] } } })).toBe(false);
    }
  });

  it("ignores `definitions` even when includeDefs is set (only `$defs`)", () => {
    const schema: JSONSchema = {
      definitions: { Old: { ifc: { integrity: ["y"] } } },
      $defs: { New: { type: "string" } },
    };
    expect(hasIfc(schema, { includeDefs: true })).toBe(false);
  });

  it("visits the excluded keywords when includeUnused is set", () => {
    for (const keyword of ["patternProperties", "dependentSchemas"]) {
      const schema: JSONSchema = {
        [keyword]: { x: { ifc: { integrity: ["y"] } } },
      };
      expect(hasIfc(schema)).toBe(false);
      expect(hasIfc(schema, { includeUnused: true })).toBe(true);
    }
    for (const keyword of ["if", "then", "else", "contains", "propertyNames"]) {
      const schema: JSONSchema = { [keyword]: { ifc: { integrity: ["y"] } } };
      expect(hasIfc(schema)).toBe(false);
      expect(hasIfc(schema, { includeUnused: true })).toBe(true);
    }
  });
});

describe("values that are not schemas", () => {
  // A stored schema is not always schema-generator output, so a keyword can
  // hold one of these where a subschema belongs.
  const NON_SCHEMAS: [label: string, value: unknown][] = [
    ["null", null],
    ["a string", "ab"],
    ["a number", 7],
  ];
  const ALL_TIERS = { includeDefs: true, includeUnused: true } as const;

  /**
   * Run `fn`, returning what it produced alongside the walk's warnings, each
   * flattened to one line. Captured at the logger, which is where the message
   * is decided, rather than at the console, which also answers to
   * `LOG_TO_STDERR` and to the logger's configured level.
   */
  const withWarnings = <T>(
    fn: () => T,
  ): { result: T; warnings: string[] } => {
    const logger = getLogger("schema-walk") as unknown as {
      warn: (key: string, ...messages: unknown[]) => void;
    };
    const original = logger.warn;
    const warnings: string[] = [];
    logger.warn = (key, ...messages) => {
      warnings.push([
        key,
        ...messages.flatMap((message) =>
          typeof message === "function" ? message() : message
        ),
      ].join(" "));
    };
    try {
      return { result: fn(), warnings };
    } finally {
      logger.warn = original;
    }
  };

  it("isSubschema accepts booleans and objects and rejects the rest", () => {
    expect(isSubschema(true)).toBe(true);
    expect(isSubschema(false)).toBe(true);
    expect(isSubschema({})).toBe(true);
    expect(isSubschema({ type: "string" })).toBe(true);
    for (const [, value] of NON_SCHEMAS) expect(isSubschema(value)).toBe(false);
    expect(isSubschema(undefined)).toBe(false);
    // An array is an object to every other test in the module, and a schema to
    // none: `validateSchemaDefinition` rejects one where a subschema belongs,
    // the tuple spelling of `items` included.
    expect(isSubschema([])).toBe(false);
    expect(isSubschema([{ type: "string" }])).toBe(false);
  });

  it("ignores an array where a subschema belongs, at every shape", () => {
    const tuple = [{ type: "string" }];
    const single = withWarnings(() =>
      edgesOf({ items: tuple } as unknown as JSONSchema)
    );
    expect(single.result).toEqual([]);
    expect(single.warnings[0]).toContain("items");
    const entry = withWarnings(() =>
      edgesOf({ properties: { a: tuple } } as unknown as JSONSchema)
    );
    expect(entry.result).toEqual([]);
    expect(entry.warnings[0]).toContain("properties/a");
    const element = withWarnings(() =>
      edgesOf({ allOf: [tuple] } as unknown as JSONSchema)
    );
    expect(element.result).toEqual([]);
    expect(element.warnings[0]).toContain("allOf/0");
  });

  it("still reads a record keyword written as an array, by index", () => {
    // Validation enumerates `properties` with `Object.entries`, which names an
    // array's indices, so the walk has to see the same subschemas it does.
    const { result, warnings } = withWarnings(() =>
      edgesOf({ properties: [{ type: "string" }] } as unknown as JSONSchema)
    );
    expect(result.length).toBe(1);
    expect(result[0]!.keyword).toBe("properties");
    expect(result[0]!.key).toBe("0");
    expect(result[0]!.schema).toEqual({ type: "string" });
    expect(warnings).toEqual([]);
  });

  it("visits no edge for one under any keyword, in any tier", () => {
    // Driven off the exported keyword constants, so a keyword added to the
    // vocabulary is covered here the day it is added.
    const positions: [label: string, schema: (value: unknown) => JSONSchema][] =
      [];
    for (
      const keyword of [
        ...SINGLE_SUBSCHEMA_KEYS,
        ...UNUSED_SINGLE_SUBSCHEMA_KEYS,
      ]
    ) {
      positions.push([keyword, (value) => ({ [keyword]: value })]);
    }
    for (
      const keyword of [
        ...RECORD_SUBSCHEMA_KEYS,
        ...UNUSED_RECORD_SUBSCHEMA_KEYS,
        ...DEFS_KEYS,
      ]
    ) {
      positions.push([keyword, (value) => ({ [keyword]: value })]);
      positions.push([
        `${keyword}/x`,
        (value) => ({ [keyword]: { x: value } }),
      ]);
    }
    for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
      positions.push([keyword, (value) => ({ [keyword]: value })]);
      positions.push([`${keyword}/0`, (value) => ({ [keyword]: [value] })]);
    }

    for (const [position, build] of positions) {
      for (const [label, value] of NON_SCHEMAS) {
        const where = `${position}: ${label}`;
        const schema = build(value);
        const walked = withWarnings(() => edgesOf(schema, ALL_TIERS));
        expect(walked.result, where).toEqual([]);
        expect(walked.warnings.length, where).toBe(1);
        expect(walked.warnings[0], where).toContain(position);
        const mapped = withWarnings(() =>
          mapSubschemas(schema as Record<never, never>, () => ({
            type: "string",
          }), ALL_TIERS)
        );
        expect(mapped.result, where).toBe(schema);
      }
    }
  });

  it("visits the well-formed siblings of one, at their own key and index", () => {
    const { result: edges } = withWarnings(() =>
      edgesOf({
        properties: { bad: null, good: { type: "string" } },
        prefixItems: [null, { type: "number" }],
      } as unknown as JSONSchema)
    );
    expect(edges.length).toBe(2);
    expect(edges.find((edge) => edge.keyword === "properties")?.key).toBe(
      "good",
    );
    const prefixItem = edges.find((edge) => edge.keyword === "prefixItems");
    expect(prefixItem?.index).toBe(1);
    expect(prefixItem?.schema).toEqual({ type: "number" });
  });

  it("yields the same edges from the generator form", () => {
    const { result: edges, warnings } = withWarnings(() => [
      ...subschemaEdges(
        {
          // One of each shape the walk can refuse: a subschema position, an
          // array container, an array entry, and a record container.
          additionalProperties: "ab",
          allOf: null,
          anyOf: [7, { type: "number" }],
          patternProperties: "ab",
          properties: { bad: null, good: { type: "string" } },
        } as unknown as JSONSchema,
        ALL_TIERS,
      ),
    ]);
    expect(edges).toEqual([
      { schema: { type: "number" }, keyword: "anyOf", index: 1 },
      { schema: { type: "string" }, keyword: "properties", key: "good" },
    ]);
    expect(warnings.length).toBe(5);
  });

  it("leaves one in place when mapping, and maps around it", () => {
    const schema = {
      additionalProperties: null,
      properties: { bad: "ab", good: { type: "string" } },
      prefixItems: [7, { type: "number" }],
    } as unknown as JSONSchemaObj;
    const { result } = withWarnings(() =>
      mapSubschemas(
        schema,
        (child) =>
          typeof child === "boolean" ? child : { ...child, title: "mapped" },
        ALL_TIERS,
      )
    );
    expect(result).toEqual({
      additionalProperties: null,
      properties: { bad: "ab", good: { type: "string", title: "mapped" } },
      prefixItems: [7, { type: "number", title: "mapped" }],
    });
  });

  it("does not descend into one, with or without visitBooleans", () => {
    const schema = {
      properties: { bad: null, good: { properties: { deep: true } } },
    } as unknown as JSONSchema;
    const plain = withWarnings(() => pathKeys(schema));
    expect(plain.result).toEqual(["", "properties/good"]);
    // `visitBooleans` opens the walk to `true` and `false`, not to values a
    // schema cannot be.
    const booleans = withWarnings(() =>
      pathKeys(schema, { visitBooleans: true })
    );
    expect(booleans.result).toEqual([
      "",
      "properties/good",
      "properties/good/properties/deep",
    ]);
  });

  it("walks nothing for a root that is one", () => {
    for (const [label, value] of NON_SCHEMAS) {
      const root = value as JSONSchema;
      expect(edgesOf(root), label).toEqual([]);
      expect([...subschemaEdges(root)], label).toEqual([]);
      expect(collect(root, { visitBooleans: true }), label).toEqual([]);
    }
  });

  it("names the keyword, the value, and the schema holding it", () => {
    const { warnings } = withWarnings(() =>
      forEachSubschema(
        {
          type: "object",
          properties: { a: { type: "number" } },
          additionalProperties: null,
        } as unknown as JSONSchema,
        () => {},
      )
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("additionalProperties");
    expect(warnings[0]).toContain("null");
    expect(warnings[0]).toContain('properties:{a:{type:"number"}}');
  });

  it("names the entry of a record keyword by key, and of an array by index", () => {
    const byKey = withWarnings(() =>
      forEachSubschema(
        { properties: { a: 7 } } as unknown as JSONSchema,
        () => {
        },
      )
    );
    expect(byKey.warnings[0]).toContain("properties/a");
    const byIndex = withWarnings(() =>
      forEachSubschema({ allOf: [true, 7] } as unknown as JSONSchema, () => {})
    );
    expect(byIndex.warnings[0]).toContain("allOf/1");
  });
});
describe("resolveRef option", () => {
  const rootWithDefs: JSONSchema = {
    $defs: { Labeled: { type: "string", ifc: { integrity: ["y"] } } },
    properties: { a: { $ref: "#/$defs/Labeled" } },
  };
  const resolveRef = (node: { $ref?: string }) =>
    node.$ref === "#/$defs/Labeled"
      ? (rootWithDefs as { $defs: Record<string, JSONSchema> }).$defs.Labeled
      : undefined;

  const hasIfc = (opts?: Parameters<typeof anySchema>[2]) =>
    anySchema(
      rootWithDefs,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      opts,
    );

  it("does not follow $ref by default (target label unseen)", () => {
    expect(hasIfc()).toBe(false);
  });

  it("follows $ref when a resolver is supplied", () => {
    expect(hasIfc({ resolveRef })).toBe(true);
  });

  it("marks resolved nodes viaRef, at the ref site's path", () => {
    const node = findSchema(
      rootWithDefs,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      { resolveRef },
    );
    expect(node?.viaRef).toBe(true);
    expect(node?.path.join("/")).toBe("properties/a");
  });

  it("terminates on a self-referential $ref chain", () => {
    const recursive: JSONSchema = {
      $defs: { Node: { properties: { next: { $ref: "#/$defs/Node" } } } },
      $ref: "#/$defs/Node",
    };
    const resolve = (n: { $ref?: string }) =>
      n.$ref === "#/$defs/Node"
        ? (recursive as { $defs: Record<string, JSONSchema> }).$defs.Node
        : undefined;
    // Should complete (the on-path guard breaks the ref cycle), not hang.
    let count = 0;
    walkSchema(recursive, () => {
      count++;
    }, { resolveRef: resolve });
    expect(count).toBeGreaterThan(0);
  });
});
