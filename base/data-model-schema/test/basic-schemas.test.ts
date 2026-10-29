import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaTypes } from "@commonfabric/api";

import { type FabricValue, isDeepFrozen } from "@commonfabric/data-model";

import { FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY } from "@commonfabric/data-model/for-testing-only";
import { emptySchemaObject, schemaForValueType } from "@/basic-schemas.ts";
import { isInternedSchema } from "@/schema-intern.ts";

describe("basic-schemas", () => {
  describe("schemaForValueType()", () => {
    function testType(
      typeName: JSONSchemaTypes,
      example: FabricValue,
    ) {
      describe(typeName, () => {
        it(`returns { type: "${typeName}" }`, () => {
          expect(schemaForValueType(example)).toEqual({ type: typeName });
        });

        it("returns a frozen result", () => {
          expect(isDeepFrozen(schemaForValueType(example)!)).toBe(true);
        });

        it("returns an interned result", () => {
          expect(isInternedSchema(schemaForValueType(example)!)).toBe(true);
        });

        it("returns the same result every time", () => {
          expect(schemaForValueType(example)).toBe(schemaForValueType(example));
        });
      });
    }

    testType("string", "hello");
    testType("integer", 42);
    testType("number", 3.14);
    testType("boolean", true);
    testType("null", null);
    testType("array", [1, 2, 3]);
    testType("object", { a: 1 });
    // A `FabricPrimitive` gets the type name it reports, not "object". One
    // example per class, from the set the data model keeps complete.
    for (
      const [example] of Object.values(
        FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
      )
    ) {
      testType(example.schemaType, example);
    }

    describe("undefined", () => {
      it("returns `undefined`", () => {
        expect(schemaForValueType(undefined)).toBe(undefined);
      });
    });

    describe("bigint", () => {
      it("returns `undefined`", () => {
        expect(schemaForValueType(BigInt(42))).toBe(undefined);
      });
    });

    describe("symbol", () => {
      it("returns `undefined`", () => {
        expect(schemaForValueType(Symbol("test"))).toBe(undefined);
      });
    });
  });

  describe("emptySchemaObject()", () => {
    it("returns {}", () => {
      expect(emptySchemaObject()).toEqual({});
    });

    it("returns the same object every time", () => {
      expect(emptySchemaObject()).toBe(emptySchemaObject());
    });

    it("returns an interned result", () => {
      expect(isInternedSchema(emptySchemaObject())).toBe(true);
    });

    it("returns a frozen result", () => {
      expect(isDeepFrozen(emptySchemaObject())).toBe(true);
    });
  });
});
