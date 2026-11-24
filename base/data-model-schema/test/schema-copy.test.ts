import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";

import { deepFreeze } from "@commonfabric/data-model";
import { internSchema } from "@/schema-intern.ts";
import { cloneSchemaMutable, toDeepFrozenSchema } from "@/schema-copy.ts";

describe("schema-copy", () => {
  describe("toDeepFrozenSchema()", () => {
    for (const prim of [false, true, undefined]) {
      describe(`on primitive \`${prim}\``, () => {
        it("returns the value as-is given both values of `canShare`", () => {
          const result1 = toDeepFrozenSchema(prim, false);
          const result2 = toDeepFrozenSchema(prim, true);
          expect(result1).toBe(prim);
          expect(result2).toBe(prim);
        });
      });
    }

    describe("canShare=true", () => {
      it("freezes input in place", () => {
        const originalProperties = {
          name: { type: "string" } as JSONSchemaObj,
        };
        const schema: JSONSchemaObj = {
          type: "object",
          properties: originalProperties,
        };

        const result = toDeepFrozenSchema(schema, true);

        // Top-level should be the same reference — frozen in place.
        expect(result).toBe(schema);
        expect(Object.isFrozen(schema)).toBe(true);

        // Property values are frozen in place — same references, now frozen.
        expect(Object.isFrozen(schema.properties)).toBe(true);
        expect(schema.properties).toBe(originalProperties);
        expect(Object.isFrozen(schema.properties!.name)).toBe(true);
      });

      it("freezes an unfrozen schema in place (same reference)", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        };

        const result = toDeepFrozenSchema(schema, true);

        // Same reference — frozen in place, not cloned.
        expect(result).toBe(schema);
        expect(Object.isFrozen(result)).toBe(true);
      });
    });

    describe("canShare=false", () => {
      it("clones before freezing", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: {
            age: { type: "integer" },
          },
        };

        const result = toDeepFrozenSchema(schema, false);

        // Should NOT be the same reference.
        expect(result).not.toBe(schema);

        // Original should NOT be frozen.
        expect(Object.isFrozen(schema)).toBe(false);

        // Result should be deeply frozen.
        expect(Object.isFrozen(result)).toBe(true);
        const obj = result as JSONSchemaObj;
        expect(Object.isFrozen(obj.properties)).toBe(true);
        expect(Object.isFrozen(obj.properties!.age)).toBe(true);
      });

      it("preserves original schema", () => {
        const inner: JSONSchemaObj = { type: "string" };
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { name: inner },
        };

        toDeepFrozenSchema(schema, false);

        // Original should still be mutable.
        expect(Object.isFrozen(schema)).toBe(false);
        expect(Object.isFrozen(inner)).toBe(false);

        // Prove mutability by actually mutating.
        (inner as Record<string, unknown>).type = "number";
        expect(inner.type).toBe("number");
      });

      it("does not freeze original property values", () => {
        const innerProp = { type: "string" } as JSONSchemaObj;
        const schema: JSONSchemaObj = {
          type: "object",
          properties: { x: innerProp },
        };

        toDeepFrozenSchema(schema, false);

        // Original property value should not be frozen.
        expect(Object.isFrozen(innerProp)).toBe(false);
      });
    });

    describe("deeply nested schemas", () => {
      it("freezes deeply nested schemas", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: {
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
              },
              required: ["street"],
            },
          },
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.properties)).toBe(true);

        const address = result.properties!.address as JSONSchemaObj;
        expect(Object.isFrozen(address)).toBe(true);
        expect(Object.isFrozen(address.properties)).toBe(true);
        expect(Object.isFrozen(address.required)).toBe(true);
        expect(Object.isFrozen(address.properties!.street)).toBe(true);
      });

      it("freezes a schema with arrays", () => {
        const schema: JSONSchemaObj = {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["tags"],
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.required)).toBe(true);

        const tags = result.properties!.tags as JSONSchemaObj;
        expect(Object.isFrozen(tags)).toBe(true);
        expect(Object.isFrozen(tags.items)).toBe(true);
      });

      it("freezes anyOf schemas", () => {
        const schema: JSONSchemaObj = {
          anyOf: [
            { type: "string" },
            { type: "number" },
          ],
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.anyOf)).toBe(true);
        expect(Object.isFrozen(result.anyOf![0])).toBe(true);
        expect(Object.isFrozen(result.anyOf![1])).toBe(true);
      });

      it("freezes enum values", () => {
        const schema: JSONSchemaObj = {
          type: "string",
          enum: ["a", "b", "c"],
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;
        expect(Object.isFrozen(result.enum)).toBe(true);
      });
    });

    describe("immutability enforcement", () => {
      it("throws on mutation of a frozen schema", () => {
        const schema: JSONSchemaObj = { type: "string" };
        toDeepFrozenSchema(schema, true);

        expect(() => {
          (schema as Record<string, unknown>).type = "number";
        }).toThrow(TypeError);
      });
    });

    describe("interned schema handling", () => {
      it("returns an interned schema as-is", () => {
        const schema = internSchema({ type: "string" });
        const result = toDeepFrozenSchema(schema);
        expect(result).toBe(schema);
      });

      it("returns an interned schema as-is even with `canShare=false`", () => {
        const schema = internSchema({
          type: "object",
          properties: { x: { type: "number" } },
        });
        const result = toDeepFrozenSchema(schema, false);
        expect(result).toBe(schema);
      });
    });

    describe("already-frozen input handling", () => {
      it("returns an already-frozen schema by identity", () => {
        const schema: JSONSchemaObj = Object.freeze({
          type: "string" as const,
        });
        const result = toDeepFrozenSchema(schema, true);
        expect(result).toBe(schema);
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("returns the same reference when already deep-frozen (`canShare=true`)", () => {
        const schema: JSONSchemaObj = deepFreeze({
          type: "object",
          properties: { name: { type: "string" } },
        });

        const result = toDeepFrozenSchema(schema, true);
        expect(result).toBe(schema);
      });

      it("returns the same reference when already deep-frozen (`canShare=false`)", () => {
        const schema: JSONSchemaObj = deepFreeze({
          type: "object",
          properties: { age: { type: "number" } },
        });

        const result = toDeepFrozenSchema(schema, false);
        expect(result).toBe(schema);
      });

      it("deep-freezes a frozen-but-not-deep schema in place (`canShare=true`)", () => {
        const inner = { type: "string" } as JSONSchemaObj;
        const schema: JSONSchemaObj = Object.freeze({
          type: "object",
          properties: Object.freeze({ name: inner }),
        } as JSONSchemaObj);
        // schema is frozen, but inner is not — so not deep-frozen.

        const result = toDeepFrozenSchema(schema, true);

        // Same reference: `canShare=true` lets us complete the deep-freeze
        // in place rather than cloning.
        expect(result).toBe(schema);

        // The result, and the `inner` that went in unfrozen, must both come
        // out deeply frozen.
        expect(Object.isFrozen(result)).toBe(true);
        const obj = result as JSONSchemaObj;
        expect(Object.isFrozen(obj.properties)).toBe(true);
        expect(Object.isFrozen(inner)).toBe(true);
      });
    });

    describe("subtree reuse", () => {
      it("reuses already-deep-frozen subtrees, freezes the rest in place (`canShare=true`)", () => {
        const frozenProperties = deepFreeze({
          name: { type: "string" },
        } as Record<string, JSONSchemaObj>);
        const unfrozenRequired = ["name"];
        const schema: JSONSchemaObj = {
          type: "object",
          properties: frozenProperties,
          required: unfrozenRequired,
        };

        const result = toDeepFrozenSchema(schema, true) as JSONSchemaObj;

        // The already-deep-frozen "properties" subtree is reused by reference.
        expect(result.properties).toBe(frozenProperties);

        // The unfrozen `required` is frozen in place -- same reference, and
        // frozen on the way out -- rather than cloned, since `canShare=true`.
        expect(result.required).toBe(unfrozenRequired);

        // Both are deeply frozen in the result.
        expect(Object.isFrozen(result.properties)).toBe(true);
        expect(Object.isFrozen(result.required)).toBe(true);
      });
    });
  });

  describe("cloneSchemaMutable()", () => {
    it("returns `{}` for boolean `true`", () => {
      expect(cloneSchemaMutable(true)).toEqual({});
    });

    it("returns `{ not: true }` for boolean `false`", () => {
      expect(cloneSchemaMutable(false)).toEqual({ not: true });
    });

    it("returns `{}` for `undefined`", () => {
      const result = cloneSchemaMutable(undefined);
      expect(result).toEqual({});
    });

    it("returns a shallow copy by default", () => {
      const inner: JSONSchemaObj = { type: "string" };
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: inner },
      };

      const result = cloneSchemaMutable(schema) as JSONSchemaObj;

      // Different top-level reference.
      expect(result).not.toBe(schema);
      // Content is equal.
      expect(result.type).toBe("object");
      expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
      // Nested objects share references (shallow).
      expect(result.properties).toBe(schema.properties);
    });

    it("returns a deep copy when `deep=true`", () => {
      const inner: JSONSchemaObj = { type: "string" };
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { name: inner },
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      // Different top-level reference.
      expect(result).not.toBe(schema);
      // Content is equal.
      expect(result.type).toBe("object");
      expect((result.properties!.name as JSONSchemaObj).type).toBe("string");
      // Nested objects are also cloned (deep).
      expect(result.properties).not.toBe(schema.properties);
    });

    it("produces a deeply mutable result when `deep=true`", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;
      expect(Object.isFrozen(result)).toBe(false);

      // Top-level mutation should work.
      (result as Record<string, unknown>).type = "array";
      expect(result.type).toBe("array");

      // Nested mutation should also work.
      expect(Object.isFrozen(result.properties)).toBe(false);
      const xProp = result.properties!.x as Record<string, unknown>;
      expect(Object.isFrozen(xProp)).toBe(false);
      xProp.type = "string";
      expect((result.properties!.x as JSONSchemaObj).type).toBe("string");
    });

    it("does not mutate the original", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { a: { type: "string" } },
      };

      const result = cloneSchemaMutable(schema) as Record<string, unknown>;
      result.type = "array";

      expect(schema.type).toBe("object");
    });

    it("produces a fully mutable deep clone of a frozen schema", () => {
      const schema = toDeepFrozenSchema({
        type: "object",
        properties: { y: { type: "number" } },
      } as JSONSchemaObj);

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      expect(Object.isFrozen(result)).toBe(false);
      expect(result.type).toBe("object");
      // Nested properties should also be mutable.
      expect(Object.isFrozen(result.properties)).toBe(false);
    });

    it("copies an `anyOf` array when `deep=true`", () => {
      const schema: JSONSchemaObj = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };

      const result = cloneSchemaMutable(schema, true) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(result.anyOf!.length).toBe(2);
      expect(result.anyOf).not.toBe(schema.anyOf);
    });

    it("returns a fresh empty object for an empty object schema", () => {
      const schema: JSONSchemaObj = {};
      const result = cloneSchemaMutable(schema) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(Object.keys(result).length).toBe(0);
    });
  });
});
