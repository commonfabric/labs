/**
 * Schema traversal as contextual flow control needs it, where the recurring
 * hazard is which document a `#/$defs/<name>` ref names a definition of. It
 * names one of the document root's, so a `$defs` on a subschema below that
 * root is inert. Following an embedded or external `$ref` enters another
 * document, and a traversal carrying the wrong root either resolves a name it
 * should not see or fails to resolve one it should.
 *
 * Two narrower ways that goes wrong get their own cases. An inherited property
 * name is not a declared definition, however much it looks like one to a bare
 * property read. And a definition the derived schema cannot reach is dropped
 * rather than carried along -- not merely left unresolved, but neither
 * enumerated nor read.
 *
 * The label side is here too, and its point is that the lattice is open: a
 * join preserves whatever confidentiality atoms it is given rather than
 * rounding them to fixed levels.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchemaObj } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  formatExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../src/builder/types.ts";
import { cfcAtom, ContextualFlowControl } from "../src/cfc.ts";
import {
  cfcSchemaWithInheritedDefs,
  findCfcSchemaRefs,
  hoistCfcSchemaDefs,
  pruneCfcSchemaDefinitions,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefs,
  resolveExternalCfcSchemaRefAsDocument,
  selectReferencedCfcSchemaDefs,
} from "../src/cfc/schema-refs.ts";
import { validateSchemaValue } from "../src/cfc/schema-sanitization.ts";
import { resolveSchema, schemaHasIfc } from "../src/schema.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";

describe("ContextualFlowControl.schemaAtPath", () => {
  it("rejects leading-zero array index like '01'", () => {
    const schema: JSONSchema = {
      type: "array",
      items: { type: "string" },
    };

    // "01" is not a valid array index (leading zero), should return false
    const result01 = ContextualFlowControl.schemaAtPath(schema, ["01"]);
    // "1" is a valid array index, should return the items schema
    const result1 = ContextualFlowControl.schemaAtPath(schema, ["1"]);

    expect(result01).toBe(false);
    expect(result1).toEqual({ type: "string" });
  });

  it("does not collide cached paths whose segments contain NUL bytes", () => {
    // Deep-frozen so the schemaAtPath memo engages; "a\0b" as a single
    // property name must not share a cache entry with the nested path
    // ["a", "b"].
    const schema: JSONSchema = Object.freeze({
      type: "object",
      properties: Object.freeze({
        "a\0b": Object.freeze({ type: "number" }),
        a: Object.freeze({
          type: "object",
          properties: Object.freeze({
            b: Object.freeze({ type: "string" }),
          }),
        }),
      }),
    }) as JSONSchema;

    const flat = ContextualFlowControl.schemaAtPath(schema, ["a\0b"]);
    const nested = ContextualFlowControl.schemaAtPath(schema, ["a", "b"]);

    expect(flat).toEqual({ type: "number" });
    expect(nested).toEqual({ type: "string" });
  });

  it("narrows a schema that omits `type` to what its object and array readings both admit, and a declared non-container type to `false`", () => {
    // A schema declaring no `type` admits every type, and without a value
    // nothing says whether its `properties` or its `items` apply, so the
    // narrowing is the union of the two readings: a named property beside an
    // element schema gives both at an index, a key only one reading names
    // gives that reading's answer, and a key the object reading leaves open
    // admits anything. A declared type other than object, array or unknown
    // holds no children.
    const typeless: JSONSchema = {
      properties: { title: { type: "string" }, "0": { type: "boolean" } },
      items: { type: "number" },
    };
    expect(ContextualFlowControl.schemaAtPath(typeless, ["title"])).toEqual({
      type: "string",
    });
    expect(ContextualFlowControl.schemaAtPath(typeless, ["0"])).toEqual({
      anyOf: [{ type: "boolean" }, { type: "number" }],
    });
    expect(ContextualFlowControl.schemaAtPath(typeless, ["extra"])).toBe(
      true,
    );
    expect(
      ContextualFlowControl.schemaAtPath({ items: { type: "number" } }, ["1"]),
    ).toBe(true);
    // A conjunction is not narrowed here: a type-less `allOf` holds no
    // children rather than admitting one a part constrains as anything.
    expect(
      ContextualFlowControl.schemaAtPath(
        { allOf: [{ properties: { a: { type: "number" } } }] },
        ["a"],
      ),
    ).toBe(false);
    expect(
      ContextualFlowControl.schemaAtPath(
        { additionalProperties: { type: "boolean" } },
        ["extra"],
      ),
    ).toEqual({ type: "boolean" });
    expect(
      ContextualFlowControl.schemaAtPath({ type: "string" }, ["extra"]),
    ).toBe(false);
    // A false schema spelled as an object holds no children under either
    // reading.
    expect(ContextualFlowControl.schemaAtPath({ not: true }, ["extra"])).toBe(
      false,
    );
    // An `enum` or `const` beside no `type` is read as the type list of its
    // members' types, and nothing more of the members is read, since
    // traversal does not validate the keyword: a string enumeration holds no
    // children, and an object member admits any key, one no member holds
    // included. That last answer holds only for as long as the values go
    // unread; an exact-match reading would narrow `extra` to `false` and `a`
    // to what the members hold.
    expect(
      ContextualFlowControl.schemaAtPath({ enum: ["a", "b"] }, ["extra"]),
    ).toBe(false);
    expect(
      ContextualFlowControl.schemaAtPath({ enum: [{ a: 1 }, "b"] }, ["extra"]),
    ).toBe(true);
    expect(
      ContextualFlowControl.schemaAtPath({ const: [1, 2] }, ["0"]),
    ).toBe(true);
    expect(
      ContextualFlowControl.schemaAtPath({ const: [1, 2] }, ["extra"]),
    ).toBe(false);
    expect(
      ContextualFlowControl.schemaAtPath({
        type: "object",
        enum: [{}],
        properties: { a: { type: "number", default: 1 } },
      }, ["a"]),
    ).toEqual({ type: "number", default: 1 });
  });

  it("settles a schema that omits `type` to the container a reader holds, and leaves the rest standing", () => {
    // A reader that holds an object narrows through the object reading, so a
    // type-less schema takes `type: "object"`. A declared type, a reference,
    // an enumeration — typed by its members — and a true schema stand as
    // they are.
    const settle = ContextualFlowControl.settledForContainer;
    expect(settle({ items: { type: "number" } }, "object")).toEqual({
      items: { type: "number" },
      type: "object",
    });
    expect(settle({ items: { type: "number" } }, "array")).toEqual({
      items: { type: "number" },
      type: "array",
    });
    for (
      const standing of [
        { type: "string" },
        { $ref: "#/$defs/X", $defs: { X: { type: "object" } } },
        { asCell: ["cell"] },
        { enum: ["a", "b"] },
      ] as JSONSchema[]
    ) {
      expect(settle(standing, "object")).toBe(standing);
    }
  });

  it("hands a wildcard down to its children without its `default`", () => {
    // A true schema is what every child below it narrows to, markers and
    // labels included, but its `default` describes the wildcard's own value:
    // an absent child under `{ default: {…} }` must not read the parent's
    // default as its own. The schema itself, asked for at an empty path,
    // keeps it.
    const wildcard: JSONSchema = {
      default: { a: 1 },
      asCell: ["cell"],
      ifc: { confidentiality: ["secret"] },
    };
    expect(ContextualFlowControl.schemaAtPath(wildcard, ["a"])).toEqual({
      asCell: ["cell"],
      ifc: { confidentiality: ["secret"] },
    });
    expect(ContextualFlowControl.schemaAtPath(wildcard, ["a", "b"])).toEqual({
      asCell: ["cell"],
      ifc: { confidentiality: ["secret"] },
    });
    expect(ContextualFlowControl.schemaAtPath(wildcard, [])).toEqual(wildcard);
  });

  it("does not treat inherited property names as declared properties", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        actual: { type: "number" },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["toString"])).toBe(true);
    expect(ContextualFlowControl.schemaAtPath({
      type: "object",
      properties: Object.fromEntries([
        ["toString", { type: "string" }],
      ]) as Record<string, JSONSchema>,
    }, ["toString"])).toEqual({ type: "string" });
  });

  it("classifies frozen root refs and unions without mixing path results", () => {
    const schema = deepFreeze({
      $ref: "#/$defs/Root",
      $defs: {
        Root: {
          anyOf: [
            {
              type: "array",
              prefixItems: [{ type: "number" }],
              items: { type: "string" },
            },
            {
              type: "object",
              properties: {
                "0": { type: "boolean" },
                named: { type: "null" },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    } as JSONSchemaObj);

    expect(ContextualFlowControl.schemaAtPath(schema, ["0"])).toEqual({
      anyOf: [{ type: "number" }, { type: "boolean" }],
    });
    const homogeneous = ContextualFlowControl.schemaAtPath(schema, ["1"]);
    expect(homogeneous).toEqual({ type: "string" });
    expect(ContextualFlowControl.schemaAtPath(schema, ["1"])).toBe(homogeneous);
    expect(ContextualFlowControl.schemaAtPath(schema, ["2000"])).toBe(
      homogeneous,
    );
    expect(ContextualFlowControl.schemaAtPath(schema, ["named"])).toEqual({
      type: "null",
    });
    expect(ContextualFlowControl.schemaAtPath(schema, ["missing"])).toBe(false);
  });

  it("classifies combined unions with boolean branches", () => {
    const schema = deepFreeze({
      anyOf: [{
        type: "array",
        items: { type: "string" },
      }],
      oneOf: [true],
    } as JSONSchemaObj);

    expect(ContextualFlowControl.schemaAtPath(schema, ["0"])).toBe(true);
  });

  it("falls back when composition branches contain an indirect ref cycle", () => {
    const schema = deepFreeze({
      $ref: "#/$defs/A",
      $defs: {
        A: {
          anyOf: [true, { $ref: "#/$defs/B" }],
        },
        B: {
          oneOf: [{ $ref: "#/$defs/A" }],
        },
      },
    } as JSONSchemaObj);

    expect(ContextualFlowControl.schemaAtPath(schema, ["value"])).toBe(true);
  });

  it("falls back when a union classifier cannot resolve a ref", () => {
    const schema = deepFreeze({
      anyOf: [{ $ref: "#/$defs/Missing" }],
      $defs: { Present: { type: "string" } },
    } as JSONSchemaObj);

    expect(() => ContextualFlowControl.schemaAtPath(schema, ["value"]))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("falls back when a type-array classifier contains an unresolved union", () => {
    const schema = deepFreeze({
      type: ["object", "undefined"],
      anyOf: [{ $ref: "#/$defs/Missing" }],
      $defs: { Present: { type: "string" } },
    } as JSONSchemaObj);

    expect(() => ContextualFlowControl.schemaAtPath(schema, ["value"]))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("considers a schema with only $defs true'", () => {
    const schema: JSONSchema = {
      $defs: { Test: { type: "array", items: { type: "string" } } },
    };
    expect(ContextualFlowControl.isTrueSchema(schema)).toBe(true);
  });

  it("considers a schema with only scope metadata true", () => {
    expect(ContextualFlowControl.isTrueSchema({ scope: "any" })).toBe(true);
  });

  it("does not resolve a subschema's `$ref` when the root declares no `$defs`, whatever the subschema declares", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        argument: {
          type: "object",
          $defs: {
            Item: {
              type: "object",
              properties: {
                values: {
                  type: "array",
                  items: { type: "number" },
                },
              },
            },
          },
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/$defs/Item" },
            },
          },
        },
      },
    };

    expect(() =>
      ContextualFlowControl.schemaAtPath(schema, [
        "argument",
        "items",
        "0",
        "values",
      ])
    ).toThrow(/Failed to resolve \$ref/);
  });

  const armsWithOwnDefinitions: JSONSchema[] = [
    {
      $ref: "#/$defs/Obj",
      $defs: {
        Obj: {
          type: "object",
          properties: { a: { type: "number" } },
          additionalProperties: false,
        },
      },
    },
    {
      $ref: "#/$defs/Obj",
      $defs: {
        Obj: {
          type: "object",
          properties: { b: { type: "number" } },
          additionalProperties: false,
        },
      },
    },
  ];

  it("resolves an anyOf arm's `$ref` against the union's `$defs`, not the arm's own", () => {
    const schema = deepFreeze({
      anyOf: armsWithOwnDefinitions,
      $defs: {
        Obj: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
      },
    } as JSONSchemaObj);

    expect(
      ContextualFlowControl.schemaAtPath(schema, ["a"], undefined, true, false),
    ).toEqual({
      type: "string",
    });
    expect(
      ContextualFlowControl.schemaAtPath(schema, ["b"], undefined, true, false),
    ).toBe(false);
  });

  it("does not resolve an anyOf arm's `$ref` against the arm's own `$defs` when the union declares none", () => {
    const schema = deepFreeze({
      anyOf: armsWithOwnDefinitions,
    } as JSONSchemaObj);

    expect(() =>
      ContextualFlowControl.schemaAtPath(schema, ["a"], undefined, true, false)
    ).toThrow(/Failed to resolve \$ref/);
  });

  it("hoists the definitions each union arm reaches onto the derived schema's root", () => {
    const schema = deepFreeze({
      type: "object",
      properties: {
        value: {
          anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        },
      },
      $defs: {
        A: { type: "object", properties: { a: { $ref: "#/$defs/Leaf" } } },
        B: { type: "object", properties: { a: { $ref: "#/$defs/Leaf2" } } },
        Leaf: { type: "string" },
        Leaf2: { type: "number" },
      },
    } as JSONSchemaObj);

    expect(ContextualFlowControl.schemaAtPath(schema, ["value", "a"])).toEqual({
      anyOf: [{ $ref: "#/$defs/Leaf" }, { $ref: "#/$defs/Leaf2" }],
      $defs: { Leaf: { type: "string" }, Leaf2: { type: "number" } },
    });
  });

  it("descends through object and array type unions containing undefined", () => {
    const objectSchema = deepFreeze({
      type: ["object", "undefined"],
      properties: { x: { type: "string" } },
    } as JSONSchemaObj);
    const arraySchema = deepFreeze({
      type: ["array", "undefined"],
      items: { type: "number" },
    } as JSONSchemaObj);

    expect(ContextualFlowControl.schemaAtPath(objectSchema, ["x"])).toEqual({
      type: "string",
    });
    expect(ContextualFlowControl.schemaAtPath(arraySchema, ["0"])).toEqual({
      type: "number",
    });
  });

  it("drops definitions that the derived schema cannot reach", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      $defs: {
        Unused: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["title"])).toEqual({
      type: "string",
    });
  });

  it("keeps the transitive definition closure for a derived schema", () => {
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Entry" },
      $defs: {
        Entry: {
          type: "object",
          properties: {
            label: { $ref: "#/$defs/Label" },
          },
        },
        Label: { type: "string" },
        Unused: { type: "number" },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Entry",
      $defs: {
        Entry: {
          type: "object",
          properties: {
            label: { $ref: "#/$defs/Label" },
          },
        },
        Label: { type: "string" },
      },
    });
  });

  it("does not enumerate or read unreachable definitions", () => {
    const definitions = new Proxy<Record<string, JSONSchema>>(
      {
        Used: { type: "string" },
        Unused: { type: "number" },
      },
      {
        ownKeys: () => {
          throw new Error("definition map was enumerated");
        },
        get: (target, property, receiver) => {
          if (property === "Unused") {
            throw new Error("unreachable definition was read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Used" },
      $defs: definitions,
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Used",
      $defs: { Used: { type: "string" } },
    });
  });

  it("resolves a reached definition body's refs against the document's map, not the body's own `$defs`", () => {
    const entry: JSONSchema = {
      type: "object",
      properties: {
        value: { $ref: "#/$defs/Shared" },
      },
      $defs: {
        Shared: { type: "number" },
      },
    };
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/Entry" },
      $defs: {
        Entry: entry,
        Shared: { type: "string" },
        Unused: { type: "boolean" },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["0"])).toEqual({
      $ref: "#/$defs/Entry",
      $defs: {
        Entry: entry,
        Shared: { type: "string" },
      },
    });
    expect(ContextualFlowControl.schemaAtPath(schema, ["0", "value"])).toEqual(
      { $ref: "#/$defs/Shared", $defs: { Shared: { type: "string" } } },
    );
  });

  it("keeps cyclic and JSON-pointer-escaped definition references", () => {
    const schema: JSONSchema = {
      type: "array",
      items: { $ref: "#/$defs/a~1b~0c" },
      $defs: {
        "a/b~c": { $ref: "#/$defs/Back" },
        Back: { $ref: "#/$defs/a~1b~0c" },
        Unused: { type: "boolean" },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["17"])).toEqual({
      $ref: "#/$defs/a~1b~0c",
      $defs: {
        "a/b~c": { $ref: "#/$defs/Back" },
        Back: { $ref: "#/$defs/a~1b~0c" },
      },
    });
  });

  it("resolves a subschema's `$ref` against the document's map, not the subschema's own `$defs`", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Inner",
          $defs: {
            Inner: { type: "string" },
            NestedUnused: { type: "null" },
          },
        },
      },
      $defs: {
        Inner: { type: "number" },
        OuterUnused: { type: "boolean" },
      },
    };

    expect(ContextualFlowControl.schemaAtPath(schema, ["nested"])).toEqual({
      $ref: "#/$defs/Inner",
      $defs: {
        Inner: { type: "number" },
      },
    });
  });
});

describe("ContextualFlowControl atom joins", () => {
  it("preserves arbitrary confidentiality atoms instead of collapsing through fixed lattice levels", () => {
    const caveatAtom = cfcAtom.caveat("prompt-influence", "of:prompt-source");
    const provenanceAtom = cfcAtom.resource(
      "SourceProvenance",
      "did:example:source",
    );
    const schema: JSONSchema = {
      type: "object",
      ifc: { confidentiality: [caveatAtom] },
      properties: {
        body: {
          type: "string",
          ifc: { confidentiality: [provenanceAtom] },
        },
      },
    };

    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, schema);

    expect(ContextualFlowControl.lub(joined)).toEqual([
      caveatAtom,
      provenanceAtom,
    ]);
    expect(ContextualFlowControl.schemaAtPath(schema, ["body"])).toMatchObject({
      type: "string",
      ifc: {
        confidentiality: [caveatAtom, provenanceAtom],
      },
    });
  });
});

describe("CFC schema reference discovery", () => {
  it("visits every supported subschema keyword but not dormant definitions", () => {
    const ref = (name: string): JSONSchema => ({ $ref: `urn:${name}` });
    const names = [
      "not",
      "if",
      "then",
      "else",
      "items",
      "contains",
      "additionalProperties",
      "propertyNames",
      "contentSchema",
      "allOf",
      "anyOf",
      "oneOf",
      "prefixItems",
      "dependentSchemas",
      "properties",
      "patternProperties",
    ];
    const schema: JSONSchema = {
      not: ref("not"),
      if: ref("if"),
      then: ref("then"),
      else: ref("else"),
      items: ref("items"),
      contains: ref("contains"),
      additionalProperties: ref("additionalProperties"),
      propertyNames: ref("propertyNames"),
      contentSchema: ref("contentSchema"),
      allOf: [ref("allOf")],
      anyOf: [ref("anyOf")],
      oneOf: [ref("oneOf")],
      prefixItems: [ref("prefixItems")],
      dependentSchemas: { value: ref("dependentSchemas") },
      properties: { value: ref("properties") },
      patternProperties: { ".*": ref("patternProperties") },
      $defs: { Dormant: ref("dormant") },
    };
    const refs = new Set<string>();

    findCfcSchemaRefs(schema, refs);

    expect([...refs].toSorted()).toEqual(
      names.map((name) => `urn:${name}`).toSorted(),
    );
  });

  it("selects no definitions for boolean schemas or unresolved local refs", () => {
    const definitions = { Present: { type: "string" } } as const;

    expect(selectReferencedCfcSchemaDefs(true, definitions)).toBeUndefined();
    expect(
      selectReferencedCfcSchemaDefs(
        { $ref: "#/$defs/Missing" },
        definitions,
      ),
    ).toBeUndefined();
  });

  it("does not resolve inherited Object prototype names as definitions", () => {
    const fullSchema: JSONSchema = {
      $defs: { Present: { type: "string" } },
    };

    for (const name of ["toString", "constructor", "__proto__"]) {
      const ref = `#/$defs/${name}`;
      expect(
        selectReferencedCfcSchemaDefs({ $ref: ref }, fullSchema.$defs),
      ).toBeUndefined();
      expect(resolveCfcSchemaRef(fullSchema, ref)).toBeUndefined();
    }
  });

  it("retains own definitions that shadow Object prototype names", () => {
    const definitions = Object.fromEntries([
      ["toString", { type: "string" }],
      ["constructor", { type: "number" }],
    ]) as Record<string, JSONSchema>;
    const schema: JSONSchema = {
      anyOf: Object.keys(definitions).map((name) => ({
        $ref: `#/$defs/${name}`,
      })),
      $defs: definitions,
    };

    expect(selectReferencedCfcSchemaDefs(schema, definitions)).toEqual(
      definitions,
    );
    for (const [name, definition] of Object.entries(definitions)) {
      expect(resolveCfcSchemaRef(schema, `#/$defs/${name}`)).toEqual(
        definition,
      );
    }
  });

  it("attaches the document's map to a referenced definition body in place of the body's own `$defs`", () => {
    const entry: JSONSchema = {
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: { Value: { type: "string", default: "local" } },
    };
    const schema: JSONSchema = {
      $defs: {
        Entry: entry,
        Value: { type: "number", default: 1 },
      },
    };

    expect(resolveCfcSchemaRef(schema, "#/$defs/Entry")).toEqual({
      ...entry,
      $defs: schema.$defs,
    });
  });

  it("removes a referenced definition body's own `$defs` when no local ref needs a map", () => {
    const schema: JSONSchema = {
      $defs: {
        Entry: { type: "string", $defs: { Inert: { type: "number" } } },
      },
    };

    expect(resolveCfcSchemaRef(schema, "#/$defs/Entry")).toEqual({
      type: "string",
    });
  });

  it("resolves a chained reference against the document's map, not an intermediate body's `$defs`", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/Entry",
      $defs: {
        Entry: {
          $ref: "#/$defs/Value",
          $defs: { Value: { type: "string" } },
        },
        Value: { type: "number" },
      },
    };

    expect(resolveCfcSchemaRefs(schema)).toMatchObject({ type: "number" });
  });

  it("preserves ref-site sibling constraints on the resolved view", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/Base",
      $defs: {
        Base: { $ref: "#/$defs/BaseTarget" },
        BaseTarget: { type: "object" },
        RefSiteLocal: { type: "string" },
      },
      properties: {
        value: { $ref: "#/$defs/RefSiteLocal" },
      },
    };

    const resolved = resolveCfcSchemaRefs(schema) as JSONSchemaObj;
    const valueSchema = resolved.properties?.value as JSONSchemaObj;

    expect(resolved).toMatchObject({ type: "object" });
    expect(resolveCfcSchemaRefs(valueSchema, resolved)).toMatchObject({
      type: "string",
    });
  });

  it("resolves a target's refs and its ref site's siblings against the one document they share", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        item: {
          $ref: "#/$defs/Base",
          type: "object",
          properties: { sibling: { $ref: "#/$defs/Value" } },
          required: ["sibling"],
        },
      },
      required: ["item"],
      $defs: {
        Base: {
          $defs: { Value: { type: "number" } },
          allOf: [{
            type: "object",
            properties: { target: { $ref: "#/$defs/Value" } },
            required: ["target"],
          }],
        },
        Value: { type: "string" },
      },
    };

    expect(
      validateSchemaValue(schema, {
        item: { target: "document", sibling: "ref-site" },
      }),
    ).toBeUndefined();
    expect(
      validateSchemaValue(schema, { item: { target: "document", sibling: 2 } }),
    ).toBeDefined();
    expect(
      validateSchemaValue(schema, {
        item: { target: 1, sibling: "ref-site" },
      }),
    ).toBeDefined();
  });

  it("does not bind unresolved target refs to generated sibling names", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/Base",
      $defs: {
        Base: {
          $defs: { Other: { type: "number" } },
          allOf: [{ $ref: "#/$defs/__cfc_ref_site_1_Value" }],
        },
        Value: { type: "string" },
      },
    };

    expect(validateSchemaValue(schema, "must remain unresolved")).toBeDefined();
  });

  it("keeps missing refs unresolved across a definition-less ref site", () => {
    const refSiteRoot: JSONSchemaObj = {};
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
      allOf: [{ $ref: "#/$defs/Props" }],
    };
    const vnode = { type: "vnode", name: "div", props: {} };

    expect(validateSchemaValue(schema, vnode, refSiteRoot)).toBeDefined();
  });

  it("removes a `$defs` below the document's map while pruning", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        other: { $ref: "#/$defs/Outer" },
        child: {
          $ref: "#/$defs/Outer",
          $defs: { Unused: { type: "boolean" } },
        },
      },
      $defs: { Outer: { type: "string" } },
    };

    const pruned = pruneCfcSchemaDefinitions(schema);

    expect(pruned).toEqual({
      type: "object",
      properties: {
        other: { $ref: "#/$defs/Outer" },
        child: { $ref: "#/$defs/Outer" },
      },
      $defs: { Outer: { type: "string" } },
    });
    expect(ContextualFlowControl.schemaAtPath(pruned, ["child"])).toEqual(
      ContextualFlowControl.schemaAtPath(schema, ["child"]),
    );
  });

  it("removes a `$defs` below a root definition it keeps", () => {
    const schema: JSONSchema = {
      $ref: "#/$defs/Outer",
      $defs: {
        Outer: {
          type: "object",
          properties: {
            inner: {
              $ref: "#/$defs/Inner",
              $defs: { Stale: { type: "boolean" } },
            },
          },
        },
        Inner: { type: "string" },
      },
    };

    expect(pruneCfcSchemaDefinitions(schema)).toEqual({
      $ref: "#/$defs/Outer",
      $defs: {
        Outer: {
          type: "object",
          properties: { inner: { $ref: "#/$defs/Inner" } },
        },
        Inner: { type: "string" },
      },
    });
  });

  it("removes a `$defs` below a root that declares none while pruning", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        child: {
          $ref: "#/$defs/Inner",
          $defs: { Inner: { type: "string" }, Unused: { type: "boolean" } },
        },
      },
    };

    expect(pruneCfcSchemaDefinitions(schema)).toEqual({
      type: "object",
      properties: { child: { $ref: "#/$defs/Inner" } },
    });
  });

  it("carries a boolean subschema through a namespaced ref site", () => {
    // A ref site whose target is another document has its siblings
    // namespaced, which walks and rewrites every subschema beside the `$ref`.
    // `true` and `false` are schemas with nothing to rename, and the walk hands
    // them to that rewrite like any other.
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
      properties: { flag: true },
      additionalProperties: { $ref: "#/$defs/Site" },
      $defs: { Site: { type: "string" } },
    };

    const resolved = resolveCfcSchemaRefs(schema) as JSONSchemaObj;

    expect(resolved.properties?.flag).toBe(true);
    // The ref site's own `Site` name is renamed out of the way of the
    // target document's names.
    expect(resolved.additionalProperties).toEqual({
      $ref: "#/$defs/__cfc_ref_site_0_Site",
    });
    expect(resolved.$defs?.__cfc_ref_site_0_Site).toEqual({ type: "string" });
  });

  describe("a keyword holding a value that is not a schema", () => {
    // A schema reaching the runtime has not necessarily come from the schema
    // generator, so a keyword can hold a value no schema can be. Pruning walks
    // every subschema-bearing keyword, so each one is a way in.

    const MALFORMED: [label: string, schema: JSONSchema][] = [
      ["additionalProperties", {
        type: "object",
        properties: { a: { type: "number" } },
        additionalProperties: null,
      } as unknown as JSONSchema],
      [
        "properties",
        { type: "object", properties: "ab" } as unknown as JSONSchema,
      ],
      [
        "a properties entry",
        { type: "object", properties: { a: null } } as unknown as JSONSchema,
      ],
      ["items", { type: "array", items: null } as unknown as JSONSchema],
      [
        "prefixItems",
        { type: "array", prefixItems: "ab" } as unknown as JSONSchema,
      ],
      [
        "a prefixItems entry",
        { type: "array", prefixItems: [null] } as unknown as JSONSchema,
      ],
      ["allOf", { allOf: null } as unknown as JSONSchema],
      ["an anyOf entry", { anyOf: [7] } as unknown as JSONSchema],
      ["oneOf", { oneOf: "ab" } as unknown as JSONSchema],
      ["not", { not: 3 } as unknown as JSONSchema],
      ["patternProperties", { patternProperties: 4 } as unknown as JSONSchema],
      ["$defs", { $defs: null } as unknown as JSONSchema],
    ];

    for (const [label, schema] of MALFORMED) {
      it(`prunes a schema whose ${label} holds one`, () => {
        expect(pruneCfcSchemaDefinitions(schema)).toEqual(schema);
        expect(pruneCfcSchemaDefinitions(deepFreeze(schema))).toEqual(schema);
        const refs = new Set<string>();
        findCfcSchemaRefs(schema, refs);
        expect(refs.size).toBe(0);
        expect(
          selectReferencedCfcSchemaDefs(
            schema,
            (schema as JSONSchemaObj).$defs,
          ),
        ).toBeUndefined();
      });
    }

    it("prunes around one, keeping the definitions its siblings reach", () => {
      const schema = {
        type: "object",
        properties: { bad: null, good: { $ref: "#/$defs/Kept" } },
        additionalProperties: "ab",
        $defs: { Kept: { type: "string" }, Dropped: { type: "number" } },
      } as unknown as JSONSchema;

      expect(pruneCfcSchemaDefinitions(schema)).toEqual({
        type: "object",
        properties: { bad: null, good: { $ref: "#/$defs/Kept" } },
        additionalProperties: "ab",
        $defs: { Kept: { type: "string" } },
      });
    });

    it("leaves a $ref at a definition holding one unresolved", () => {
      const schema = {
        $ref: "#/$defs/Broken",
        $defs: { Broken: null },
      } as unknown as JSONSchemaObj;

      expect(resolveCfcSchemaRef(schema, "#/$defs/Broken")).toBeUndefined();
      expect(resolveCfcSchemaRefs(schema)).toBeUndefined();
      // A schema the runtime cannot read matches nothing, rather than letting
      // the raw value through.
      expect(resolveSchema(schema)).toBe(false);
    });
  });
});

describe("schemaHasIfc", () => {
  it("honors a caller-provided visited set", () => {
    const secret: JSONSchema = {
      type: "string",
      ifc: { confidentiality: [cfcAtom.resource("AlreadySeen")] },
    };
    const schema: JSONSchema = { allOf: [secret] };

    expect(schemaHasIfc(schema, new Set<JSONSchema>([secret]), schema)).toBe(
      false,
    );
  });

  it("does not reach an ifc behind a `$ref` that names no root definition", () => {
    // The `$defs` on `nested` is inert under a root that declares none, so
    // the ref resolves to nothing and the labeled definition is unreachable.
    const schema: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Nested",
          $defs: {
            Nested: {
              type: "object",
              properties: {
                value: {
                  $ref: "#/$defs/SecretValue",
                },
              },
            },
            SecretValue: {
              type: "string",
              ifc: {
                confidentiality: [cfcAtom.resource("NestedSecret")],
              },
            },
          },
        },
      },
    };

    expect(schemaHasIfc(schema)).toBe(false);
  });
});

describe("resolveCfcSchemaRef() on a cyclic-group member", () => {
  const node: JSONSchema = {
    type: "object",
    properties: {
      children: { type: "array", items: { $ref: "#/$defs/Node" } },
    },
  };

  // Registers the group document `node` decomposes into, and returns the
  // external ref naming its `Node` member.
  const registerGroup = (): string => {
    const { documents } = decomposeSchema(
      { $ref: "#/$defs/Node", $defs: { Node: node } } as Parameters<
        typeof decomposeSchema
      >[0],
    );
    let memberRef: string | undefined;
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
      if (
        isObjectOrArray(document) &&
        isObjectOrArray(document.$defs) &&
        Object.hasOwn(document.$defs, "Node")
      ) {
        memberRef = formatExternalSchemaRef(hash, "Node");
      }
    }
    return memberRef!;
  };

  it("returns a view whose refs into the group are external and which carries no `$defs`", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const memberRef = registerGroup();
      expect(resolveCfcSchemaRef({}, memberRef)).toEqual({
        type: "object",
        properties: {
          children: { type: "array", items: { $ref: memberRef } },
        },
      });
    } finally {
      release();
    }
  });

  it("resolves the view's refs below a root whose own `$defs` names the member differently", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const memberRef = registerGroup();
      const schema: JSONSchema = {
        type: "object",
        properties: { tree: { $ref: memberRef } },
        $defs: { Node: { type: "string" } },
      };
      expect(
        ContextualFlowControl.schemaAtPath(schema, [
          "tree",
          "children",
          "0",
          "children",
        ]),
      ).toEqual({ type: "array", items: { $ref: memberRef } });
    } finally {
      release();
    }
  });
});

describe("resolveCfcSchemaRef() on an external ref", () => {
  it("drops a `$defs` the member itself declares from its view", () => {
    // A member's own map is inert in the group document, and the view's refs
    // name the group externally, so nothing in the view can reach it.
    const release = acquireSchemaRegistryLease();
    try {
      const group = {
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" } },
            $defs: { Stale: { type: "null" } },
          },
        },
      } as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(group);
      registerSchemaDocument(hash, group);
      const memberRef = formatExternalSchemaRef(hash, "Node");
      expect(resolveCfcSchemaRef({}, memberRef)).toEqual({
        type: "object",
        properties: { next: { $ref: memberRef } },
      });
    } finally {
      release();
    }
  });

  it("resolves nothing for a fragment ref into an unregistered document", () => {
    const release = acquireSchemaRegistryLease();
    try {
      const hash = internSchemaAsTaggedHashString({ type: "null" });
      expect(resolveCfcSchemaRef({}, formatExternalSchemaRef(hash, "Node")))
        .toBeUndefined();
      expect(
        resolveExternalCfcSchemaRefAsDocument(
          formatExternalSchemaRef(hash, "Node"),
        ),
      ).toBeUndefined();
    } finally {
      release();
    }
  });

  it("reads no document from a ref that is not external", () => {
    expect(resolveExternalCfcSchemaRefAsDocument("#/$defs/Node"))
      .toBeUndefined();
  });
});

describe("hoistCfcSchemaDefs()", () => {
  it("merges the maps of fragments that carry the same definitions", () => {
    const leaf = { type: "string" } as const;
    const { fragments, definitions } = hoistCfcSchemaDefs([
      { $ref: "#/$defs/Leaf", $defs: { Leaf: leaf } },
      { $ref: "#/$defs/Leaf", $defs: { Leaf: { ...leaf } } },
      { type: "null" },
    ]);

    expect(fragments).toEqual([
      { $ref: "#/$defs/Leaf" },
      { $ref: "#/$defs/Leaf" },
      { type: "null" },
    ]);
    expect(definitions).toEqual({ Leaf: leaf });
  });

  it("renames a fragment's map apart when it defines a name differently", () => {
    const { fragments, definitions } = hoistCfcSchemaDefs([
      { $ref: "#/$defs/Leaf", $defs: { Leaf: { type: "string" } } },
      {
        properties: { a: { $ref: "#/$defs/Leaf" } },
        $defs: { Leaf: { type: "number" } },
      },
    ]);

    expect(fragments).toEqual([
      { $ref: "#/$defs/Leaf" },
      { properties: { a: { $ref: "#/$defs/__cfc_hoisted_0_Leaf" } } },
    ]);
    expect(definitions).toEqual({
      Leaf: { type: "string" },
      __cfc_hoisted_0_Leaf: { type: "number" },
    });
  });

  it("returns no map when no fragment carries one", () => {
    const fragments: JSONSchema[] = [{ type: "string" }, true];
    expect(hoistCfcSchemaDefs(fragments)).toEqual({
      fragments,
      definitions: undefined,
    });
  });
});

describe("ContextualFlowControl.isFalseSchema", () => {
  it("treats false as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema(false)).toBe(true);
  });

  it("does not treat true as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema(true)).toBe(false);
  });

  it("does not treat a normal object schema as false", () => {
    expect(ContextualFlowControl.isFalseSchema({ type: "string" })).toBe(false);
  });

  it("treats {not: true} as a false schema (negation of true matches nothing)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: true })).toBe(true);
  });

  it("treats {not: {}} as a false schema ({} is a true schema, so its negation is false)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: {} })).toBe(true);
  });

  it("does not treat {not: false} as a false schema (negation of false matches everything)", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: false })).toBe(false);
  });

  it("does not treat {not: {type: 'string'}} as a false schema", () => {
    expect(ContextualFlowControl.isFalseSchema({ not: { type: "string" } }))
      .toBe(false);
  });
});

describe("ContextualFlowControl.resolveSchemaRefsOrThrow", () => {
  it("resolves a local $ref successfully", () => {
    const schema: JSONSchemaObj = {
      $defs: { Foo: { type: "string" } as JSONSchema },
      $ref: "#/$defs/Foo",
    };
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toMatchObject({ type: "string" });
  });

  it("resolves embedded external $ref (vnode.json)", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    };
    // Should not throw — vnode.json is registered in embeddedSchemas
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(schema);
    expect(resolved).toBeDefined();
  });

  it("resolves an embedded schema to a view whose refs into its definitions are external", () => {
    const url = "https://commonfabric.org/schemas/vnode.json";
    const document = resolveCfcSchemaRef({}, url) as JSONSchemaObj;
    expect(document.$defs).toBeUndefined();
    expect(document.$ref).toBe(`${url}#/$defs/VNode`);
    const node = resolveCfcSchemaRef({}, `${url}#/$defs/VNode`);
    expect(node).toMatchObject({ type: "object" });
    expect((node as JSONSchemaObj).$defs).toBeUndefined();
  });

  it("throws with actionable message for unknown external $ref", () => {
    const schema: JSONSchemaObj = {
      $ref: "https://commonfabric.org/schemas/unknown.json",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/embeddedSchemas/);
  });

  it("throws with schema details for unresolvable local $ref", () => {
    const schema: JSONSchemaObj = {
      $defs: {},
      $ref: "#/$defs/Missing",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("rejects anchor $refs", () => {
    const schema: JSONSchemaObj = {
      $ref: "#named-anchor",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("rejects local $refs outside root $defs", () => {
    const schema: JSONSchemaObj = {
      properties: {
        name: { type: "string" },
      },
      $ref: "#/properties/name",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });

  it("rejects local $refs into nested paths under root $defs", () => {
    const schema: JSONSchemaObj = {
      $defs: {
        Foo: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      $ref: "#/$defs/Foo/properties/name",
    };
    expect(() => ContextualFlowControl.resolveSchemaRefsOrThrow(schema))
      .toThrow(/Failed to resolve \$ref/);
  });
});

describe("cfcSchemaWithInheritedDefs()", () => {
  const definitions: Record<string, JSONSchema> = {
    Name: { type: "string" },
  };

  it("attaches the inherited definitions to a fragment whose `$ref` names one, so the ref resolves", () => {
    const scoped = cfcSchemaWithInheritedDefs(
      { $ref: "#/$defs/Name" },
      definitions,
    );
    expect(scoped).toEqual({ $ref: "#/$defs/Name", $defs: definitions });
    expect(resolveCfcSchemaRefs(scoped as JSONSchemaObj)).toMatchObject({
      type: "string",
    });
  });

  it("attaches them when the local ref sits in a nested arm", () => {
    const arm: JSONSchema = {
      oneOf: [{ $ref: "#/$defs/Name" }, { type: "null" }],
    };
    expect(cfcSchemaWithInheritedDefs(arm, definitions)).toEqual({
      ...arm,
      $defs: definitions,
    });
  });

  it("returns a deep-frozen fragment with no local ref as the same object", () => {
    const plain = deepFreeze({
      type: "object",
      properties: { count: { type: "number" } },
    }) as JSONSchema;
    expect(cfcSchemaWithInheritedDefs(plain, definitions)).toBe(plain);
  });

  it("attaches the inherited definitions to a fragment that is not deep-frozen without scanning it for a local ref", () => {
    // The scan memoizes only by identity of a deep-frozen object, so an
    // unfrozen fragment is given the definitions whether or not it needs them.
    const plain: JSONSchema = {
      type: "object",
      properties: { count: { type: "number" } },
    };
    expect(cfcSchemaWithInheritedDefs(plain, definitions)).toEqual({
      ...plain,
      $defs: definitions,
    });
  });

  it("attaches the inherited definitions in place of a fragment's own `$defs`", () => {
    const own: JSONSchema = {
      $ref: "#/$defs/Name",
      $defs: { Name: { type: "number" } },
    };
    expect(cfcSchemaWithInheritedDefs(own, definitions)).toEqual({
      $ref: "#/$defs/Name",
      $defs: definitions,
    });
  });

  it("attaches them to a deep-frozen fragment whose only local ref sits under a child that declares its own `$defs`", () => {
    const fragment = deepFreeze({
      type: "object",
      properties: {
        inner: { $ref: "#/$defs/Name", $defs: { Name: { type: "number" } } },
      },
    }) as JSONSchemaObj;
    expect(cfcSchemaWithInheritedDefs(fragment, definitions)).toEqual({
      ...fragment,
      $defs: definitions,
    });
  });

  it("returns a fragment already carrying the inherited definitions as the same object", () => {
    const carrying: JSONSchema = { $ref: "#/$defs/Name", $defs: definitions };
    expect(cfcSchemaWithInheritedDefs(carrying, definitions)).toBe(carrying);
  });

  it("returns the fragment as the same object when there is nothing to inherit", () => {
    const ref: JSONSchema = { $ref: "#/$defs/Name" };
    expect(cfcSchemaWithInheritedDefs(ref, undefined)).toBe(ref);
    expect(cfcSchemaWithInheritedDefs(true, definitions)).toBe(true);
  });

  it("returns the fragment as the same object when the inherited definitions are an array", () => {
    const ref: JSONSchema = { $ref: "#/$defs/0" };
    const arrayDefinitions = [{ type: "string" }] as unknown as Record<
      string,
      JSONSchema
    >;
    expect(cfcSchemaWithInheritedDefs(ref, arrayDefinitions)).toBe(ref);
  });
});
