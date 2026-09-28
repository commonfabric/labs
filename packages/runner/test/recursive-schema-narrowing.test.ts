import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  cloneSchemaMutable,
  internSchema,
  internSchemaAsTaggedHashString,
} from "@commonfabric/data-model-schema";

import { ContextualFlowControl as C } from "../src/cfc.ts";
import { externalizeSchema } from "../src/link-utils.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";

describe("recursive schema narrowing", () => {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    for (const stored of [false, true]) {
      describe(`${keyword}, ${stored ? "stored" : "inline"}`, () => {
        /** Makes the recursive declaration self-contained in either form. */
        function schemaWith(branch: JSONSchemaObj): JSONSchemaObj {
          const schema: JSONSchemaObj = {
            $ref: "#/$defs/R",
            $defs: {
              R: {
                [keyword]: [
                  branch,
                  { $ref: "#/$defs/R", asCell: ["cell"] },
                ],
              },
            },
          };
          return stored ? externalizeSchema(schema) as JSONSchemaObj : schema;
        }

        it("returns `false` for a child of a nullable recursive handle", () => {
          const schema = schemaWith({ type: "null" });
          expect(C.schemaAtPath(schema, ["foo"])).toBe(false);
          expect(C.schemaAtPath(internSchema(schema), ["foo"])).toBe(false);
        });

        it("returns a productive branch's child through a recursive handle", () => {
          const schema = schemaWith({
            type: "object",
            properties: { name: { type: "string" } },
            additionalProperties: false,
          });
          expect(C.schemaAtPath(schema, ["name"]))
            .toEqual({ type: "string" });
          expect(C.schemaAtPath(schema, ["absent"])).toBe(false);
        });

        it("returns a descendant's schema after each recursive object step", () => {
          const schema = schemaWith({
            type: "object",
            properties: {
              name: { type: "string" },
              next: { $ref: "#/$defs/R" },
            },
            additionalProperties: false,
          });
          expect(C.schemaAtPath(schema, ["next", "next", "name"]))
            .toEqual({ type: "string" });
        });

        it("returns an element's schema after each recursive array step", () => {
          const schema = schemaWith({
            type: "array",
            prefixItems: [{ type: "number" }, { $ref: "#/$defs/R" }],
            items: false,
          });
          expect(C.schemaAtPath(schema, ["1", "1", "0"]))
            .toEqual({ type: "number" });
        });

        it("returns the union of distinct ref-site compounds", () => {
          const schema: JSONSchemaObj = {
            $ref: "#/$defs/R",
            $defs: {
              R: {
                [keyword]: [
                  {
                    $ref: "#/$defs/R",
                    [keyword]: [{
                      type: "object",
                      properties: { value: { type: "number" } },
                    }],
                  },
                  {
                    type: "object",
                    properties: { value: { type: "string" } },
                  },
                ],
              },
            },
          };
          const input = stored ? externalizeSchema(schema) : schema;
          expect(C.schemaAtPath(cloneSchemaMutable(input), ["value"]))
            .toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });
        });
      });
    }
  }

  it("returns a child admitted by a ref site's additional `oneOf`", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/R",
      $defs: {
        R: {
          anyOf: [{
            $ref: "#/$defs/R",
            oneOf: [{
              type: "object",
              properties: { value: { type: "number" } },
            }],
          }],
        },
      },
    };
    expect(C.schemaAtPath(schema, ["value"]))
      .toEqual({ type: "number" });
  });

  for (const keyword of ["anyOf", "oneOf"] as const) {
    it(`returns \`false\` beneath a stored recursive \`${keyword}\` in a document with local definitions`, () => {
      const stored = externalizeSchema({
        $ref: "#/$defs/R",
        $defs: {
          R: {
            [keyword]: [
              { type: "null" },
              { $ref: "#/$defs/R", asCell: ["cell"] },
            ],
          },
        },
      });
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { node: stored },
        $defs: { Other: { type: "string" } },
      };

      expect(C.schemaAtPath(schema, ["node", "foo"])).toBe(false);
    });
  }

  it("returns the child of distinct cursors sharing one type list", () => {
    const types = ["object", "null"] as const;
    const schema: JSONSchemaObj = {
      type: types,
      anyOf: [{ type: types, properties: { a: { type: "number" } } }],
    };

    expect(C.schemaAtPath(schema, ["a"]))
      .toEqual({ type: "number" });
  });

  it("returns a child through a recursive union beside a type list", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/R",
      $defs: {
        R: {
          type: ["object", "null"],
          anyOf: [
            { type: "object", properties: { v: { type: "number" } } },
            { $ref: "#/$defs/R", asCell: ["cell"] },
          ],
        },
      },
    };

    expect(C.schemaAtPath(schema, ["v"]))
      .toEqual({ type: "number" });
  });

  it("reads a shared branch list against each document's definitions", () => {
    const union: JSONSchemaObj = {
      anyOf: [{ $ref: "#/$defs/Leaf" }, { $ref: "#/$defs/Hop" }],
    };
    const target: JSONSchemaObj = {
      $ref: "#/$defs/R",
      $defs: {
        R: union,
        Leaf: {
          type: "object",
          properties: { value: { type: "number" } },
        },
        Hop: false,
      },
    };
    const hash = internSchemaAsTaggedHashString(target);
    registerSchemaDocument(hash, target);
    const source: JSONSchemaObj = {
      $ref: "#/$defs/R",
      $defs: {
        R: union,
        Leaf: false,
        Hop: { $ref: `cid:${hash}` },
      },
    };

    expect(C.schemaAtPath(source, ["value"]))
      .toEqual({ type: "number" });
  });

  it("keeps a target's unresolved name outside the referrer's definition scope", () => {
    const target: JSONSchemaObj = {
      type: "object",
      properties: { value: { $ref: "#/$defs/Missing" } },
    };
    const hash = internSchemaAsTaggedHashString(target);
    registerSchemaDocument(hash, target);
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        node: { $ref: `cid:${hash}`, description: "external node" },
      },
      $defs: {
        Missing: {
          type: "object",
          properties: { secret: { type: "string" } },
        },
      },
    };

    expect(() => C.schemaAtPath(schema, ["node", "value", "secret"]))
      .toThrow("Failed to resolve $ref: #/$defs/Missing");
  });

  describe("with definitions that name one another", () => {
    // Each definition is `null` or a handle naming others, so every handle
    // comes back to a union without consuming a path segment. Narrowing a
    // union afresh along every route that reaches it resolves exponentially
    // often in the number of definitions; a resolution count past the bound
    // below fails the case at once.

    /** `count` definitions, the `i`th naming those `steps` after it. */
    function definitions(
      count: number,
      steps: readonly number[],
    ): JSONSchemaObj {
      const handle = (i: number) => ({
        $ref: `#/$defs/R${i % count}`,
        asCell: ["cell" as const],
      });
      return {
        ...handle(0),
        $defs: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`R${i}`, {
            anyOf: [
              { type: "null" as const },
              ...steps.map((step) => handle(i + step)),
            ],
          }]),
        ),
      };
    }

    /** The references `schema` resolves while narrowing it to `path`. */
    function resolutionsNarrowing(
      schema: JSONSchema,
      path: readonly string[],
    ): { result: JSONSchema; resolutions: number } {
      const resolve = C.resolveSchemaRefsOrThrow;
      let resolutions = 0;
      using _counted = stub(
        C,
        "resolveSchemaRefsOrThrow",
        (...args: Parameters<typeof resolve>) => {
          if (++resolutions > 10_000) throw new Error("resolved without end");
          return resolve.apply(C, args);
        },
      );
      return { result: C.schemaAtPath(schema, path), resolutions };
    }

    it("resolves at most twice the references for twice the definitions, each naming the next two", () => {
      const few = resolutionsNarrowing(definitions(8, [1, 2]), ["foo"]);
      const many = resolutionsNarrowing(definitions(16, [1, 2]), ["foo"]);

      expect(few.result).toBe(false);
      expect(many.result).toBe(false);
      expect(many.resolutions).toBeLessThanOrEqual(2 * few.resolutions);
    });

    it("resolves each reference at most once, each definition naming every other", () => {
      const count = 8;
      const others = Array.from({ length: count - 1 }, (_, i) => i + 1);
      const { result, resolutions } = resolutionsNarrowing(
        definitions(count, others),
        ["foo"],
      );

      expect(result).toBe(false);
      expect(resolutions).toBeLessThanOrEqual(count * (count - 1) + 1);
    });

    it("returns the child each definition declares, whichever definition the path starts from", () => {
      const types = ["number", "string", "boolean", "null"] as const;
      const $defs = Object.fromEntries(types.map((type, i) => [`R${i}`, {
        anyOf: [
          {
            type: "object",
            properties: { x: { type } },
            additionalProperties: false,
          },
          ...types.flatMap((_, j) =>
            j === i ? [] : [{ $ref: `#/$defs/R${j}`, asCell: ["cell"] }]
          ),
        ],
      }]));

      for (let start = 0; start < types.length; start++) {
        const narrowed = C.schemaAtPath(
          { $ref: `#/$defs/R${start}`, $defs } as JSONSchemaObj,
          ["x"],
        );
        expect(childTypes(narrowed)).toEqual(new Set(types));
      }
    });

    /**
     * Two routes to `p`, the second under a label: to `V` and to `second`.
     * `V` holds a number at `v`, and `W` and `X` hold nothing there but reach
     * `V` again, `W` directly and `X` through `W`.
     */
    function twoRoutes(second: "W" | "X"): JSONSchemaObj {
      const leaf = (name: string): JSONSchemaObj => ({
        type: "object",
        properties: { [name]: { type: name === "v" ? "number" : "string" } },
        additionalProperties: false,
      });
      const handle = (name: string) => ({
        $ref: `#/$defs/${name}`,
        asCell: ["cell" as const],
      });
      return {
        anyOf: [
          {
            type: "object",
            properties: { p: { $ref: "#/$defs/V" } },
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              p: {
                $ref: `#/$defs/${second}`,
                ifc: { confidentiality: ["secret"] },
              },
            },
            additionalProperties: false,
          },
        ],
        $defs: {
          V: { anyOf: [leaf("v"), handle("W"), handle("X")] },
          W: { anyOf: [leaf("w"), handle("V")] },
          X: { anyOf: [leaf("x"), handle("W")] },
        },
      };
    }

    for (const second of ["W", "X"] as const) {
      it(`labels \`V\`'s child along a second route to \`${second}\`, which the first route narrowed within \`V\``, () => {
        // Within `V`, `W` comes back to `V` and so comes to nothing at `v`,
        // and `X` takes that in. The labeled route reaches `W` or `X` on its
        // own, where each holds `V`'s child.

        expect(C.schemaAtPath(twoRoutes(second), ["p", "v"])).toEqual({
          anyOf: [
            { type: "number" },
            { type: "number", ifc: { confidentiality: ["secret"] } },
          ],
        });
      });
    }
  });
});

/** The `type` of every schema a narrowed union holds, however deeply. */
function childTypes(schema: JSONSchema): Set<unknown> {
  const types = new Set<unknown>();
  const collect = (fragment: JSONSchema): void => {
    if (typeof fragment === "boolean") return;
    if (fragment.anyOf !== undefined) fragment.anyOf.forEach(collect);
    else types.add(fragment.type);
  };
  collect(schema);
  return types;
}
