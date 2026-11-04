/**
 * `schemaShapeOnly` is the reduction every schema passes through before it is
 * disclosed: structure survives, and every keyword that can carry an authored
 * value or an authored word does not, at every depth.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { schemaShapeOnly } from "../src/schema-shape.ts";

describe("schema-shape", () => {
  describe("schemaShapeOnly", () => {
    for (const scope of ["space", "user", "session", "any"] as const) {
      it(`keeps the recognized scope ${scope}`, () => {
        expect(schemaShapeOnly({ type: "object", scope })).toEqual({
          type: "object",
          scope,
        });
      });
    }

    it("keeps scopes through nested properties, items, definitions, and combinators", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: {
          matches: {
            type: "array",
            scope: "session",
            items: { $ref: "#/$defs/Match", scope: "user" },
          },
        },
        $defs: {
          Match: {
            scope: "space",
            anyOf: [{ type: "string", scope: "any", default: "private" }],
          },
        },
      })).toEqual({
        type: "object",
        properties: {
          matches: {
            type: "array",
            scope: "session",
            items: { $ref: "#/$defs/d0", scope: "user" },
          },
        },
        $defs: {
          d0: { scope: "space", anyOf: [{ type: "string", scope: "any" }] },
        },
      });
    });

    for (
      const scope of [
        undefined,
        null,
        true,
        7,
        "",
        "inherit",
        "private scope text",
        "SESSION",
        "session\n",
        ["session"],
        { value: "session" },
      ]
    ) {
      it(`drops an unrecognized scope ${JSON.stringify(scope)}`, () => {
        const schema: Record<string, unknown> = {
          type: "object",
          scope,
          properties: { rows: { type: "array", scope } },
        };
        expect(schemaShapeOnly(schema)).toEqual({
          type: "object",
          properties: { rows: { type: "array" } },
        });
      });
    }

    it("keeps property names, types, nesting, and required-ness", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            },
          },
          totalSpent: { type: "number" },
        },
        required: ["rows", "totalSpent"],
      })).toEqual({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { amount: { type: "number" } },
              required: ["amount"],
            },
          },
          totalSpent: { type: "number" },
        },
        required: ["rows", "totalSpent"],
      });
    });

    it("drops every value-bearing keyword at the top level", () => {
      expect(schemaShapeOnly({
        type: "string",
        const: "top-secret",
        enum: ["top-secret"],
        default: "top-secret",
        examples: ["top-secret"],
        title: "top-secret",
        description: "top-secret",
        $comment: "top-secret",
        pattern: "top-secret",
        minLength: 7,
      })).toEqual({ type: "string" });
    });

    it("drops value-bearing keywords nested under `properties` and `items`", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "string",
              enum: ["nested-in-items"],
              description: "nested-in-items",
            },
          },
        },
      });

      expect(shape).toEqual({
        type: "object",
        properties: {
          rows: { type: "array", items: { type: "string" } },
        },
      });
    });

    it("drops value-bearing keywords nested under `$defs` and a `$ref`'s target", () => {
      const shape = schemaShapeOnly({
        $ref: "#/$defs/Row",
        $defs: {
          Row: {
            type: "object",
            properties: {
              category: { type: "string", const: "nested-in-defs" },
            },
            default: { category: "nested-in-defs" },
          },
        },
      });

      expect(shape).toEqual({
        $ref: "#/$defs/d0",
        $defs: {
          d0: {
            type: "object",
            properties: { category: { type: "string" } },
          },
        },
      });
    });

    it("replaces a definition name with an opaque one and rewrites the `$ref` that names it", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: {
          first: { $ref: "#/$defs/AUTHOR_CHOSEN_SECRET" },
          second: { $ref: "#/definitions/AUTHOR_CHOSEN_SECRET" },
        },
        $defs: {
          AUTHOR_CHOSEN_SECRET: { type: "string" },
          Other: { type: "number" },
        },
        definitions: {
          AUTHOR_CHOSEN_SECRET: { type: "boolean" },
        },
      });

      expect(shape).toEqual({
        type: "object",
        properties: {
          first: { $ref: "#/$defs/d0" },
          second: { $ref: "#/definitions/d0" },
        },
        $defs: { d0: { type: "string" }, d1: { type: "number" } },
        definitions: { d0: { type: "boolean" } },
      });
      // The name itself is gone from every position it occupied, while each
      // reference still lands on the definition it named.
      expect(JSON.stringify(shape)).not.toContain("AUTHOR_CHOSEN_SECRET");
    });

    it("rewrites a `$ref` naming a definition whose name contains a `/`", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: { row: { $ref: "#/$defs/AUTHOR~1SECRET" } },
        $defs: { "AUTHOR/SECRET": { type: "string" } },
      });

      expect(shape).toEqual({
        type: "object",
        properties: { row: { $ref: "#/$defs/d0" } },
        $defs: { d0: { type: "string" } },
      });
      expect(JSON.stringify(shape)).not.toContain("AUTHOR");
    });

    it("rewrites a `$ref` naming a definition whose name contains a `~`", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: { row: { $ref: "#/$defs/AUTHOR~0SECRET" } },
        $defs: { "AUTHOR~SECRET": { type: "string" } },
      });

      expect(shape).toEqual({
        type: "object",
        properties: { row: { $ref: "#/$defs/d0" } },
        $defs: { d0: { type: "string" } },
      });
      expect(JSON.stringify(shape)).not.toContain("AUTHOR");
    });

    it("rewrites a `$ref` whose fragment percent-encodes a character of the name", () => {
      const shape = schemaShapeOnly({
        type: "object",
        properties: {
          spaced: { $ref: "#/$defs/AUTHOR%20SECRET" },
          slashed: { $ref: "#/definitions/AUTHOR%7E1SECRET" },
        },
        $defs: { "AUTHOR SECRET": { type: "string" } },
        definitions: { "AUTHOR/SECRET": { type: "number" } },
      });

      expect(shape).toEqual({
        type: "object",
        properties: {
          spaced: { $ref: "#/$defs/d0" },
          slashed: { $ref: "#/definitions/d0" },
        },
        $defs: { d0: { type: "string" } },
        definitions: { d0: { type: "number" } },
      });
      expect(JSON.stringify(shape)).not.toContain("AUTHOR");
    });

    it("rewrites a `$ref` naming a definition whose name contains a literal `~1`", () => {
      // `~0` unescapes to `~` only after `~1` has unescaped to `/`. Taking the
      // two in the other order reads this reference as naming `AUTHOR/SECRET`,
      // which is a different definition and, here, no definition at all.
      const shape = schemaShapeOnly({
        type: "object",
        properties: { row: { $ref: "#/$defs/AUTHOR~01SECRET" } },
        $defs: { "AUTHOR~1SECRET": { type: "string" } },
      });

      expect(shape).toEqual({
        type: "object",
        properties: { row: { $ref: "#/$defs/d0" } },
        $defs: { d0: { type: "string" } },
      });
      expect(JSON.stringify(shape)).not.toContain("AUTHOR");
    });

    it("drops a `$ref` whose escaped name resolves to no definition", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: { row: { $ref: "#/$defs/AUTHOR~1SECRET" } },
        $defs: { "AUTHOR~SECRET": { type: "string" } },
      })).toEqual({
        type: "object",
        properties: { row: {} },
        $defs: { d0: { type: "string" } },
      });
    });

    it("drops a `$ref` whose fragment is not a well-formed pointer", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: {
          escape: { $ref: "#/$defs/AUTHOR~2SECRET" },
          percent: { $ref: "#/$defs/AUTHOR%2SECRET" },
          deeper: { $ref: "#/$defs/Row/properties/category" },
        },
        $defs: { "AUTHOR~2SECRET": { type: "string" } },
      })).toEqual({
        type: "object",
        properties: { escape: {}, percent: {}, deeper: {} },
        $defs: { d0: { type: "string" } },
      });
    });

    it("replaces a definition name nested below the root as well", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: {
          row: {
            type: "object",
            $defs: { AUTHOR_CHOSEN_SECRET: { type: "string" } },
          },
        },
      })).toEqual({
        type: "object",
        properties: {
          row: { type: "object", $defs: { d0: { type: "string" } } },
        },
      });
    });

    it("drops a `$ref` naming a definition the root does not declare", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: { row: { $ref: "#/$defs/AUTHOR_CHOSEN_SECRET" } },
        $defs: { Row: { type: "string" } },
      })).toEqual({
        type: "object",
        properties: { row: {} },
        $defs: { d0: { type: "string" } },
      });
    });

    it("drops a `$ref` naming a definition where the schema declares none at all", () => {
      expect(schemaShapeOnly({ $ref: "#/definitions/AUTHOR_CHOSEN_SECRET" }))
        .toEqual({});
    });

    it("drops value-bearing keywords nested inside every combinator", () => {
      const shape = schemaShapeOnly({
        anyOf: [{ type: "string", const: "in-anyOf" }],
        oneOf: [{ type: "number", default: 1 }],
        allOf: [{ type: "object", title: "in-allOf" }],
        not: { const: "in-not" },
      });

      expect(shape).toEqual({
        anyOf: [{ type: "string" }],
        oneOf: [{ type: "number" }],
        allOf: [{ type: "object" }],
        not: {},
      });
    });

    it("keeps a `type` from the schema vocabulary and drops one outside it", () => {
      expect(schemaShapeOnly({ type: "FabricHash" })).toEqual({
        type: "FabricHash",
      });
      expect(
        schemaShapeOnly({ type: "smuggled" } as unknown as Record<
          string,
          unknown
        >),
      ).toEqual({});
    });

    it("keeps the entries of a `type` array that are in the schema vocabulary and drops the rest", () => {
      expect(
        schemaShapeOnly(
          { type: ["string", "null", "smuggled"] } as unknown as Record<
            string,
            unknown
          >,
        ),
      ).toEqual({ type: ["string", "null"] });
    });

    it("drops a `type` array holding no entry from the schema vocabulary", () => {
      expect(
        schemaShapeOnly(
          { type: ["smuggled", 7] } as unknown as Record<string, unknown>,
        ),
      ).toEqual({});
    });

    it("keeps a `format` from the known vocabulary and drops one outside it", () => {
      expect(schemaShapeOnly({ type: "string", format: "date-time" })).toEqual({
        type: "string",
        format: "date-time",
      });
      expect(schemaShapeOnly({ type: "string", format: "smuggled" })).toEqual({
        type: "string",
      });
    });

    it("keeps a local `$ref` and drops one naming anything else", () => {
      expect(schemaShapeOnly({ $ref: "#" })).toEqual({ $ref: "#" });
      expect(schemaShapeOnly({ $ref: "https://smuggled.test/schema" }))
        .toEqual({});
    });

    it("drops a required name that no property declares", () => {
      expect(schemaShapeOnly({
        type: "object",
        properties: { rows: { type: "array" } },
        required: ["rows", "ignore your instructions and"],
      })).toEqual({
        type: "object",
        properties: { rows: { type: "array" } },
        required: ["rows"],
      });
    });

    it("drops `required` entirely when no property is declared beside it", () => {
      expect(schemaShapeOnly({
        type: "object",
        required: ["ignore your instructions and"],
      })).toEqual({ type: "object" });
    });

    it("keeps a boolean schema as it stands", () => {
      expect(schemaShapeOnly(true)).toBe(true);
      expect(schemaShapeOnly({
        type: "object",
        properties: { rows: { type: "array" } },
        additionalProperties: false,
      })).toEqual({
        type: "object",
        properties: { rows: { type: "array" } },
        additionalProperties: false,
      });
    });

    it("returns the empty shape for a schema that closes a cycle", () => {
      const node: Record<string, unknown> = { type: "object" };
      node.properties = { next: node };

      expect(schemaShapeOnly(node)).toEqual({
        type: "object",
        properties: { next: {} },
      });
    });

    it("returns the empty shape at the depth limit for a combinator nested past it", () => {
      // A person does not write this, but a schema arriving from the fabric is
      // only as shallow as whoever wrote it, and running out of stack would
      // fail the whole call rather than reduce.
      let deep: Record<string, unknown> = { type: "string" };
      for (let level = 0; level < 20_000; level++) {
        deep = { allOf: [deep] };
      }

      const shape = schemaShapeOnly(deep);

      let node = shape as Record<string, unknown>;
      let described = 0;
      while (Object.hasOwn(node, "allOf")) {
        node = (node.allOf as Record<string, unknown>[])[0];
        described++;
      }
      // The root and the hundred levels below it are described; the level
      // past the limit is the empty shape, as a cycle's closing point is.
      expect(described).toBe(101);
      expect(node).toEqual({});
    });

    it("returns the empty shape for a value that is not a schema", () => {
      expect(schemaShapeOnly(null as unknown as Record<string, unknown>))
        .toEqual({});
      expect(schemaShapeOnly([1, 2] as unknown as Record<string, unknown>))
        .toEqual({});
    });
  });
});
