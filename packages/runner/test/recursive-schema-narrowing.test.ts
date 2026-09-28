import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchemaObj } from "@commonfabric/api";
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
});
