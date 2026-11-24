import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "commonfabric";
import type { JSONSchema } from "../src/builder/types.ts";
import { resolveSchema } from "../src/schema.ts";

describe("$ref with default support", () => {
  describe("resolveSchema() with default", () => {
    it("should preserve default from ref site when target has no default", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string" },
        },
        $ref: "#/$defs/String",
        default: "ref-site-default",
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "string",
        default: "ref-site-default",
      });
    });

    it("should use ref site default over target default (precedence)", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string", default: "target-default" },
        },
        $ref: "#/$defs/String",
        default: "ref-site-default",
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "string",
        default: "ref-site-default",
      });
    });

    it("should use target default when ref site has no default", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string", default: "target-default" },
        },
        $ref: "#/$defs/String",
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "string",
        default: "target-default",
      });
    });

    it("should handle chained refs with defaults at each level (outermost wins)", () => {
      const schema: JSONSchema = {
        $defs: {
          Level3: { type: "string", default: "level3" },
          Level2: { $ref: "#/$defs/Level3", default: "level2" },
          Level1: { $ref: "#/$defs/Level2", default: "level1" },
        },
        $ref: "#/$defs/Level1",
        default: "outermost",
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toHaveProperty("default", "outermost");
    });

    it("should handle chained refs with defaults at each level and none at the ref site (outermost $defs level wins)", () => {
      const schema: JSONSchema = {
        $defs: {
          Level3: { type: "string", default: "level3" },
          Level2: { $ref: "#/$defs/Level3", default: "level2" },
          Level1: { $ref: "#/$defs/Level2", default: "level1" },
        },
        $ref: "#/$defs/Level1",
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toHaveProperty("default", "level1");
    });

    it("should handle boolean schema target with ref site default", () => {
      const schema: JSONSchema = {
        $defs: {
          AlwaysTrue: true,
        },
        $ref: "#/$defs/AlwaysTrue",
        default: "foo",
      };

      const resolved = resolveSchema(schema);
      // Should convert boolean true to object to hold default
      expect(resolved).toEqual({
        $defs: schema.$defs,
        default: "foo",
      });
    });

    it("should handle boolean false schema", () => {
      const schema: JSONSchema = {
        $defs: {
          AlwaysFalse: false,
        },
        $ref: "#/$defs/AlwaysFalse",
        default: "foo",
      };

      const resolved = resolveSchema(schema);
      // false schema means nothing validates, but we can still have properties
      expect(resolved).toEqual({
        $defs: schema.$defs,
        "not": true,
        default: "foo",
      });
    });
  });

  describe("anyOf/oneOf with default", () => {
    it("should preserve default in anyOf options with refs", () => {
      const schema: JSONSchema = {
        $defs: {
          String: { type: "string" },
          Number: { type: "number" },
        },
        anyOf: [
          { $ref: "#/$defs/String", default: "string-default" },
          { $ref: "#/$defs/Number", default: 42 },
        ],
      } as const satisfies JSONSchema;

      const s1 = {
        ...(schema.anyOf![0] as JSONSchemaObj),
        $defs: schema.$defs,
      };
      const s2 = {
        ...(schema.anyOf![1] as JSONSchemaObj),
        $defs: schema.$defs,
      };
      // This would be used in validateAndTransform's anyOf handling
      const option1 = resolveSchema(s1);
      const option2 = resolveSchema(s2);

      // resolveSchema doesn't remove $defs
      expect(option1).toEqual({
        type: "string",
        default: "string-default",
        $defs: schema.$defs,
      });
      expect(option2).toEqual({
        type: "number",
        default: 42,
        $defs: schema.$defs,
      });
    });

    it("should apply ref site default to anyOf union as a whole", () => {
      const schema: JSONSchema = {
        $defs: {
          StringOrNumber: {
            anyOf: [
              { type: "string", default: "str" },
              { type: "number", default: 42 },
            ],
          },
        },
        $ref: "#/$defs/StringOrNumber",
        default: "override",
      };

      const resolved = resolveSchema(schema);

      expect(resolved).toEqual({
        $defs: schema.$defs,
        anyOf: [
          { type: "string", default: "str" },
          { type: "number", default: 42 },
        ],
        default: "override",
      });
    });

    it("should preserve asCell and default together in anyOf options", () => {
      const schema: JSONSchema = {
        $defs: {
          StringCell: { type: "string" },
        },
        anyOf: [
          {
            $ref: "#/$defs/StringCell",
            default: "cell-default",
            asCell: ["cell"],
          },
          { type: "null" },
        ],
      };

      const option1 = resolveSchema({
        ...(schema.anyOf![0] as JSONSchemaObj),
        $defs: schema.$defs,
      });

      // Resolve schema doesn't remove $defs
      expect(option1).toEqual({
        $defs: schema.$defs,
        type: "string",
        default: "cell-default",
        asCell: ["cell"],
      });
    });
  });

  describe("edge cases", () => {
    it("should handle default with value of different types (number)", () => {
      const schema: JSONSchema = {
        $defs: {
          Number: { type: "number" },
        },
        $ref: "#/$defs/Number",
        default: 42,
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "number",
        default: 42,
      });
    });

    it("should handle default with value of null", () => {
      const schema: JSONSchema = {
        $defs: {
          Nullable: { type: ["string", "null"] },
        },
        $ref: "#/$defs/Nullable",
        default: null,
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: ["string", "null"],
        default: null,
      });
    });

    it("should handle default with array value", () => {
      const schema: JSONSchema = {
        $defs: {
          StringArray: { type: "array", items: { type: "string" } },
        },
        $ref: "#/$defs/StringArray",
        default: ["item1", "item2"],
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "array",
        items: { type: "string" },
        default: ["item1", "item2"],
      });
    });

    it("should handle default with object value", () => {
      const schema: JSONSchema = {
        $defs: {
          Person: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
        },
        $ref: "#/$defs/Person",
        default: { name: "John", age: 30 },
      };

      const resolved = resolveSchema(schema);
      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        default: { name: "John", age: 30 },
      });
    });

    it("should handle ref with both asCell and default", () => {
      const schema: JSONSchema = {
        $defs: {
          StreamCell: { type: "string" },
        },
        $ref: "#/$defs/StreamCell",
        default: "ref-default",
        asCell: ["cell"],
      };

      const resolved = resolveSchema(schema);

      expect(resolved).toEqual({
        $defs: schema.$defs,
        type: "string",
        default: "ref-default",
        asCell: ["cell"],
      });
    });
  });
});
