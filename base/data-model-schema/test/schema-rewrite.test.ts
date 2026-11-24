/**
 * The operations that build one schema from another, where the recurring
 * question is what may be shared.
 *
 * Freezing a schema deeply can reuse subtrees that are already frozen, or
 * decline to, and which of those a caller gets is an explicit choice rather
 * than an optimization applied behind its back -- so the same operation is run
 * both ways.
 *
 * Deriving from an interned schema carries interning into the result, and two
 * groups follow that consequence: adding properties and removing them each
 * have to say what becomes of the interning the input arrived with.
 *
 * The remainder are smaller answers about a schema -- whether it constrains
 * anything, what shape a given value type calls for, how one is turned into a
 * key -- kept together here because they share that vocabulary.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import {
  schemaWithoutProperties,
  schemaWithProperties,
} from "@/schema-rewrite.ts";
import { internSchema, isInternedSchema } from "@/schema-intern.ts";
import { toDeepFrozenSchema } from "@/schema-copy.ts";

describe("schema-rewrite", () => {
  describe("schemaWithProperties()", () => {
    it("returns a new object with overrides applied", () => {
      const schema: JSONSchemaObj = { type: "object", description: "old" };
      const result = schemaWithProperties(schema, {
        description: "new",
      }) as JSONSchemaObj;

      expect(result).not.toBe(schema);
      expect(result.type).toBe("object");
      expect(result.description).toBe("new");
    });

    it("does not mutate the original", () => {
      const schema: JSONSchemaObj = { type: "string" };
      schemaWithProperties(schema, { type: "number" });

      expect(schema.type).toBe("string");
    });

    it("can set properties to `undefined`, leaving the key present", () => {
      const schema = { type: "object", asCell: ["stream"] } as JSONSchemaObj;
      const result = schemaWithProperties(schema, {
        default: undefined,
      }) as JSONSchemaObj;

      // The key must still exist on the result — `undefined` is a meaningful
      // value distinct from absence, which matters once schemas carry
      // FabricValue-typed fields.
      expect(result.default).toBe(undefined);
      expect("default" in result).toBe(true);
      expect(result.asCell).toEqual(["stream"]);
    });

    it("can add new properties", () => {
      const schema: JSONSchemaObj = { type: "object" };
      const result = schemaWithProperties(schema, {
        $defs: { Foo: { type: "string" } },
      }) as JSONSchemaObj;

      expect(result.$defs!.Foo).toEqual({ type: "string" });
    });

    it("preserves properties not in overrides", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      };
      const result = schemaWithProperties(schema, {
        type: "array",
      }) as JSONSchemaObj;

      expect(result.type).toBe("array");
      expect(result.required).toEqual(["a"]);
      expect((result.properties!.a as JSONSchemaObj).type).toBe("string");
    });

    it("returns a frozen result", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
      };
      const result = schemaWithProperties(schema, {
        description: "hi",
      }) as JSONSchemaObj;

      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.properties)).toBe(true);
    });

    it("distinguishes `undefined`-valued key from absent key", () => {
      // A schema with no `description` key at all.
      const schema: JSONSchemaObj = { type: "string" };
      expect("description" in schema).toBe(false);

      // Setting `description` to `undefined`: the key is present, and its
      // value is `undefined`.
      const withUndefined = schemaWithProperties(schema, {
        description: undefined,
      }) as JSONSchemaObj;
      expect("description" in withUndefined).toBe(true);
      expect(withUndefined.description).toBe(undefined);

      // Not mentioning description: key remains absent.
      const withoutOverride = schemaWithProperties(schema, {
        type: "number",
      }) as JSONSchemaObj;
      expect("description" in withoutOverride).toBe(false);
    });

    for (const truish of [true, undefined]) {
      describe(`for \`schema = ${truish}\``, () => {
        it("treats it as `{}` (any) and returns `overrides`", () => {
          const result = schemaWithProperties(truish, { type: "string" });
          expect(result).toEqual({ type: "string" });
        });

        it("returns an interned result", () => {
          const result = schemaWithProperties(truish, { type: "string" });
          expect(isInternedSchema(result)).toBe(true);
        });

        it("does not freeze `overrides`", () => {
          const overrides: JSONSchemaObj = { type: "boolean" };
          schemaWithProperties(truish, overrides);
          expect(Object.isFrozen(overrides)).toBe(false);
        });
      });
    }

    describe("for `overrides = true`", () => {
      it("treats it as `{}` (any) and returns `schema`", () => {
        const result = schemaWithProperties({ type: "string" }, true);
        expect(result).toEqual({ type: "string" });
      });

      it("returns an interned result given an interned `schema`", () => {
        const schema = internSchema({ type: "string" });
        const result = schemaWithProperties(schema, true);
        expect(isInternedSchema(result)).toBe(true);
      });

      it("returns an uninterned result given an uninterned `schema`", () => {
        const result = schemaWithProperties({ type: "string" }, true);
        expect(isInternedSchema(result)).toBe(false);
      });

      it("does not freeze a mutable `schema`", () => {
        const schema: JSONSchemaObj = { type: "boolean" };
        schemaWithProperties(schema, true);
        expect(Object.isFrozen(schema)).toBe(false);
      });
    });

    describe("for `schema = false`", () => {
      for (const overrides of [false, true, { type: "string" } as JSONSchema]) {
        const label = (typeof overrides === "boolean")
          ? `\`overrides = ${overrides}\``
          : "`overrides` of type `object`";
        it(`returns \`false\` given ${label}`, () => {
          const result = schemaWithProperties(false, overrides);
          expect(result).toBe(false);
        });
      }
    });

    describe("for `overrides = false`", () => {
      for (const schema of [false, true, { type: "string" } as JSONSchema]) {
        const label = (typeof schema === "boolean")
          ? `\`schema = ${schema}\``
          : "`schema` of type `object`";
        it(`returns \`false\` given ${label}`, () => {
          const result = schemaWithProperties(schema, false);
          expect(result).toBe(false);
        });
      }
    });

    describe("intern contagion of `object`s", () => {
      it("interns the result when the base schema is interned", () => {
        const base = internSchema({ type: "object" });
        const result = schemaWithProperties(base, {
          properties: { x: { type: "string" } },
        });
        expect(isInternedSchema(result)).toBe(true);
      });

      it("leaves the result uninterned when the base schema is not interned", () => {
        const base: JSONSchemaObj = { type: "object" };
        const result = schemaWithProperties(base, {
          properties: { x: { type: "string" } },
        });
        expect(isInternedSchema(result)).toBe(false);
        // But it should still be frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  });

  describe("schemaWithoutProperties()", () => {
    it("removes a single named property", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      const result = schemaWithoutProperties(schema, "asCell") as JSONSchemaObj;

      expect(result).toEqual({ type: "object" });
      expect("asCell" in result).toBe(false);
    });

    it("removes multiple named properties", () => {
      const schema = {
        type: "object",
        asCell: ["cell"],
        default: {},
      } as JSONSchemaObj;
      const result = schemaWithoutProperties(
        schema,
        "asCell",
        "default",
      ) as JSONSchemaObj;

      expect(result).toEqual({ type: "object" });
      expect("asCell" in result).toBe(false);
      expect("default" in result).toBe(false);
    });

    it("returns a frozen result", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      const result = schemaWithoutProperties(schema, "asCell");

      expect(Object.isFrozen(result)).toBe(true);
    });

    it("does not mutate the original", () => {
      const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
      schemaWithoutProperties(schema, "asCell");

      expect(schema.asCell).toEqual(["cell"]);
    });

    it("is a no-op (deep-frozen clone) when the named property is absent from a mutable schema", () => {
      const schema: JSONSchemaObj = { not: { type: "string" } };
      const result = schemaWithoutProperties(schema, "asCell");

      expect(result).toEqual(schema);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen((result as JSONSchemaObj).not)).toBe(true);
    });

    it("is a true no-op when the named property is absent from a deep-frozen schema", () => {
      const schema = toDeepFrozenSchema(
        { type: "string" } as JSONSchemaObj,
        true,
      );
      const result = schemaWithoutProperties(schema, "asCell");

      expect(result).toBe(schema);
    });

    it("treats `undefined` as `true` (accept everything)", () => {
      expect(schemaWithoutProperties(undefined, "asCell")).toBe(true);
    });

    it("returns boolean `true` as-is", () => {
      expect(schemaWithoutProperties(true, "asCell")).toBe(true);
    });

    it("returns boolean `false` as-is", () => {
      expect(schemaWithoutProperties(false, "asCell")).toBe(false);
    });

    describe("intern contagion", () => {
      it("interns the result when the input schema is interned", () => {
        const schema = internSchema({ type: "object", asCell: ["cell"] });
        const result = schemaWithoutProperties(schema, "asCell");
        expect(isInternedSchema(result)).toBe(true);
      });

      it("leaves the result uninterned when the input schema is not interned", () => {
        const schema: JSONSchemaObj = { type: "object", asCell: ["cell"] };
        const result = schemaWithoutProperties(schema, "asCell");
        expect(isInternedSchema(result)).toBe(false);
        // But it should still be frozen.
        expect(Object.isFrozen(result)).toBe(true);
      });

      it("preserves interned identity on a no-op over an interned schema", () => {
        const schema = internSchema({ type: "string" });
        const result = schemaWithoutProperties(schema, "nonexistent");
        expect(result).toBe(schema);
        expect(isInternedSchema(result)).toBe(true);
      });
    });
  });
});
