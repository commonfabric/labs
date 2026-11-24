import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";

import { deepFreeze } from "@commonfabric/data-model";
import { isNontrivialSchema } from "@/isNontrivialSchema.ts";

describe("isNontrivialSchema()", () => {
  describe("nullish inputs", () => {
    it("returns `false` for `undefined`", () => {
      expect(isNontrivialSchema(undefined)).toBe(false);
    });

    it("returns `false` for `null`", () => {
      expect(isNontrivialSchema(null)).toBe(false);
    });
  });

  describe("boolean schemas", () => {
    it("returns `false` for `true`", () => {
      expect(isNontrivialSchema(true)).toBe(false);
    });

    it("returns `false` for `false`", () => {
      expect(isNontrivialSchema(false)).toBe(false);
    });
  });

  describe("empty object schema", () => {
    it("returns `false` for `{}`", () => {
      expect(isNontrivialSchema({})).toBe(false);
    });
  });

  describe("non-trivial schemas", () => {
    it("returns `true` for a schema with `type`", () => {
      expect(isNontrivialSchema({ type: "string" })).toBe(true);
    });

    it("returns `true` for a schema with `properties`", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      expect(isNontrivialSchema(schema)).toBe(true);
    });

    it("returns `true` for a schema with only `$ref`", () => {
      expect(isNontrivialSchema({ $ref: "#/definitions/Foo" })).toBe(true);
    });

    it("returns `true` for a schema with `anyOf`", () => {
      expect(
        isNontrivialSchema({
          anyOf: [{ type: "string" }, { type: "number" }],
        }),
      ).toBe(true);
    });

    it("returns `true` for a frozen non-empty schema", () => {
      const schema = Object.freeze({ type: "number" as const });
      expect(isNontrivialSchema(schema)).toBe(true);
    });

    it("returns `true` for a deep-frozen schema", () => {
      const schema: JSONSchemaObj = deepFreeze({
        type: "object",
        properties: { x: { type: "number" } },
      });
      expect(isNontrivialSchema(schema)).toBe(true);
    });
  });

  describe("type narrowing", () => {
    it("narrows to `JSONSchemaObj` (allows property access)", () => {
      const schema: JSONSchemaObj | undefined = {
        type: "object",
        properties: { a: { type: "string" } },
      };
      if (isNontrivialSchema(schema)) {
        expect(schema.type).toBe("object");
        expect(typeof schema.properties).toBe("object");
      } else {
        throw new Error("Expected isNontrivialSchema to return true");
      }
    });
  });
});
