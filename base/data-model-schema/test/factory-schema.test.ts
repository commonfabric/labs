import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  addRequiredSchemaPaths,
  factorySchemasEqual,
} from "@commonfabric/data-model-schema";

describe("factory schema utilities", () => {
  describe("addRequiredSchemaPaths()", () => {
    it("adds nested required fields without weakening existing leaves", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          command: { type: "string" },
          identity: {
            type: "object",
            properties: { tenant: { type: "string", minLength: 1 } },
          },
        },
        required: ["command"],
      };

      expect(addRequiredSchemaPaths(schema, [
        ["identity", "tenant"],
        ["identity", "sandboxId"],
      ])).toEqual({
        type: "object",
        properties: {
          command: { type: "string" },
          identity: {
            type: "object",
            properties: {
              tenant: { type: "string", minLength: 1 },
              sandboxId: true,
            },
            required: ["tenant", "sandboxId"],
          },
        },
        required: ["command", "identity"],
      });
      expect(schema).toEqual({
        type: "object",
        properties: {
          command: { type: "string" },
          identity: {
            type: "object",
            properties: { tenant: { type: "string", minLength: 1 } },
          },
        },
        required: ["command"],
      });
    });

    it("preserves an impossible root schema", () => {
      expect(addRequiredSchemaPaths(false, [["sandboxId"]])).toBe(false);
    });

    it("intersects an incompatible nested child instead of replacing it", () => {
      expect(addRequiredSchemaPaths({
        type: "object",
        properties: { identity: { type: "string", minLength: 1 } },
      }, [["identity", "sandboxId"]])).toEqual({
        type: "object",
        properties: {
          identity: {
            allOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: { sandboxId: true },
                required: ["sandboxId"],
              },
            ],
          },
        },
        required: ["identity"],
      });
    });

    it("narrows a type union containing object without discarding constraints", () => {
      expect(addRequiredSchemaPaths({
        type: ["object", "null"],
        description: "optional identity",
      }, [["sandboxId"]])).toEqual({
        type: "object",
        description: "optional identity",
        properties: { sandboxId: true },
        required: ["sandboxId"],
      });
    });
  });

  describe("factorySchemasEqual()", () => {
    it("distinguishes schemas whose own __proto__ properties differ", () => {
      const properties = (value: string) =>
        Object.fromEntries([["__proto__", { const: value }]]);

      expect(factorySchemasEqual(
        { type: "object", properties: properties("left") },
        { type: "object", properties: properties("right") },
      )).toBe(false);
    });

    it("resolves percent-encoded slashes within one JSON Pointer segment", () => {
      const referenced = {
        $ref: "#/$defs/a%2Fb",
        $defs: {
          "a/b": { type: "string" },
        },
      } as const;

      expect(factorySchemasEqual(referenced, { type: "string" })).toBe(true);
    });

    it("compares exact normalized structure deterministically", () => {
      expect(factorySchemasEqual(
        {
          required: ["value"],
          properties: { value: { type: "number" } },
          type: "object",
        },
        {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      )).toBe(true);
      expect(factorySchemasEqual(
        { type: "object", required: ["left", "right"] },
        { type: "object", required: ["right", "left"] },
      )).toBe(false);
      expect(factorySchemasEqual(undefined, undefined)).toBe(true);
      expect(factorySchemasEqual(undefined, true)).toBe(false);
    });

    it("compares enum members as an unordered set", () => {
      expect(factorySchemasEqual(
        {
          type: "object",
          properties: {
            source: { enum: ["piece", "catalog", "url"] },
          },
        },
        {
          type: "object",
          properties: {
            source: { enum: ["catalog", "url", "piece"] },
          },
        },
      )).toBe(true);
      expect(factorySchemasEqual(
        { enum: ["piece", "catalog", "url"] },
        { enum: ["piece", "catalog", "other"] },
      )).toBe(false);
    });

    it("resolves local $defs and legacy definitions before comparison", () => {
      const byDefs: JSONSchema = {
        $defs: {
          Payload: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
        $ref: "#/$defs/Payload",
      };
      const byLegacyDefinitions: JSONSchema = {
        definitions: {
          "Payload/value": {
            required: ["value"],
            properties: { value: { type: "number" } },
            type: "object",
          },
        },
        $ref: "#/definitions/Payload~1value",
      };
      const inline: JSONSchema = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      expect(factorySchemasEqual(byDefs, inline)).toBe(true);
      expect(factorySchemasEqual(byLegacyDefinitions, inline)).toBe(true);
      expect(byDefs).toHaveProperty("$defs");
      expect(byLegacyDefinitions).toHaveProperty("definitions");
    });

    it("merges matching annotations beside a resolved local ref", () => {
      const referenced: JSONSchema = {
        $ref: "#/$defs/SearchQuery",
        $defs: {
          SearchQuery: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search phrase.",
              },
            },
            required: ["query"],
          },
        },
        description: "Search the web.",
      };
      const inline: JSONSchema = {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search phrase.",
          },
        },
        required: ["query"],
        description: "Search the web.",
      };

      expect(factorySchemasEqual(referenced, inline)).toBe(true);
    });

    it("normalizes every nested factory schema as its own ref document", () => {
      const referenced: JSONSchemaObj = {
        type: "object",
        properties: {
          child: {
            asFactory: {
              kind: "pattern",
              argumentSchema: {
                $defs: {
                  Input: {
                    type: "object",
                    properties: { value: { type: "number" } },
                    required: ["value"],
                  },
                },
                $ref: "#/$defs/Input",
              },
              resultSchema: {
                $defs: {
                  Output: {
                    type: "object",
                    properties: { result: { type: "string" } },
                    required: ["result"],
                  },
                },
                $ref: "#/$defs/Output",
              },
            },
          },
        },
        required: ["child"],
      };
      const inline: JSONSchemaObj = {
        type: "object",
        properties: {
          child: {
            asFactory: {
              kind: "pattern",
              argumentSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
              },
              resultSchema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
          },
        },
        required: ["child"],
      };

      expect(factorySchemasEqual(referenced, inline)).toBe(true);
    });

    it("preserves and recursively normalizes asFactory", () => {
      const referenced = {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            $defs: {
              Input: {
                type: "object",
                properties: { value: { type: "number" } },
              },
            },
            $ref: "#/$defs/Input",
          },
          resultSchema: { type: "string" },
        },
      } satisfies JSONSchema;
      const inline: JSONSchemaObj = {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            properties: { value: { type: "number" } },
            type: "object",
          },
          resultSchema: { type: "string" },
        },
      };
      const different: JSONSchemaObj = {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            properties: { value: { type: "number" } },
            type: "object",
          },
          resultSchema: { type: "number" },
        },
      };

      expect(factorySchemasEqual(referenced, inline)).toBe(true);
      expect(factorySchemasEqual(referenced, different)).toBe(false);

      const escapedDocument = {
        $defs: referenced.asFactory.argumentSchema.$defs,
        asFactory: {
          ...referenced.asFactory,
          argumentSchema: { $ref: "#/$defs/Input" },
        },
      } as JSONSchema;
      expect(factorySchemasEqual(escapedDocument, inline)).toBe(false);
    });

    it("compares recursive local refs structurally across independent documents", () => {
      const recursiveNode = (
        valueType: "string" | "number" = "string",
      ): JSONSchema => ({
        $defs: {
          Node: {
            type: "object",
            properties: {
              value: { type: valueType },
              next: {
                anyOf: [
                  { type: "null" },
                  { $ref: "#/$defs/Node" },
                ],
              },
            },
            required: ["value", "next"],
          },
        },
        $ref: "#/$defs/Node",
      });
      const inlineRecursive: JSONSchema = {
        type: "object",
        properties: {
          value: { type: "string" },
          next: {
            anyOf: [
              { type: "null" },
              { $ref: "#" },
            ],
          },
        },
        required: ["value", "next"],
      };
      const aliasedRecursive: JSONSchema = {
        $defs: {
          Node: {
            type: "object",
            properties: {
              value: { type: "string" },
              next: {
                anyOf: [
                  { type: "null" },
                  { $ref: "#/$defs/NodeAlias" },
                ],
              },
            },
            required: ["value", "next"],
          },
          NodeAlias: { $ref: "#/$defs/Node" },
        },
        $ref: "#/$defs/Node",
      };

      const left = recursiveNode();
      const right = recursiveNode();
      expect(factorySchemasEqual(left, left)).toBe(true);
      expect(factorySchemasEqual(left, right)).toBe(true);
      expect(factorySchemasEqual(left, inlineRecursive)).toBe(true);
      expect(factorySchemasEqual(left, aliasedRecursive)).toBe(true);
      expect(factorySchemasEqual(left, recursiveNode("number"))).toBe(false);
      expect(factorySchemasEqual(left, {
        ...(recursiveNode() as JSONSchemaObj),
        additionalProperties: false,
      })).toBe(false);

      expect(factorySchemasEqual(
        {
          asFactory: {
            kind: "pattern",
            argumentSchema: left,
            resultSchema: true,
          },
        },
        {
          asFactory: {
            kind: "pattern",
            argumentSchema: right,
            resultSchema: true,
          },
        },
      )).toBe(true);
    });

    it("terminates on mutual local ref cycles without conflating structure", () => {
      const mutualCycle = () =>
        ({
          $defs: {
            Left: {
              type: "object",
              properties: { right: { $ref: "#/$defs/Right" } },
              required: ["right"],
            },
            Right: {
              type: "array",
              items: { $ref: "#/$defs/Left" },
            },
          },
          $ref: "#/$defs/Left",
        }) satisfies JSONSchema;
      const differentCycle = {
        $defs: {
          Left: {
            type: "object",
            properties: { right: { $ref: "#/$defs/Right" } },
            required: ["right"],
          },
          Right: {
            type: "object",
            properties: { left: { $ref: "#/$defs/Left" } },
            required: ["left"],
          },
        },
        $ref: "#/$defs/Left",
      } satisfies JSONSchema;

      expect(factorySchemasEqual(mutualCycle(), mutualCycle())).toBe(true);
      expect(factorySchemasEqual(mutualCycle(), differentCycle)).toBe(false);
    });

    it("fails closed on unresolved, external, malformed refs and JavaScript cycles", () => {
      const unresolved = { $ref: "#/$defs/Missing" } as JSONSchema;
      const external = { $ref: "other.json#/$defs/Value" } as JSONSchema;
      const malformed = { $ref: "#/$defs/Bad~2escape" } as JSONSchema;

      for (const invalid of [unresolved, external, malformed]) {
        expect(factorySchemasEqual(invalid, invalid)).toBe(false);
        expect(factorySchemasEqual(invalid, true)).toBe(false);
      }

      const objectCycle: Record<string, unknown> = {
        type: "object",
        properties: {},
      };
      (objectCycle.properties as Record<string, unknown>).self = objectCycle;
      expect(
        factorySchemasEqual(
          objectCycle as unknown as JSONSchema,
          objectCycle as unknown as JSONSchema,
        ),
      ).toBe(false);
    });
  });
});
