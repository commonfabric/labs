import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "../../src/builder/types.ts";
import {
  schemaWithInjectionSafeAnnotations,
  validateSchemaValue,
} from "../../src/cfc/schema-sanitization.ts";

describe("schema-sanitization", () => {
  describe("schemaWithInjectionSafeAnnotations()", () => {
    it("returns an annotation for definitions that refer to each other through properties", () => {
      const schema = {
        $defs: {
          A: {
            type: "object",
            properties: { b: { $ref: "#/$defs/B" } },
            additionalProperties: false,
          },
          B: {
            type: "object",
            properties: { a: { $ref: "#/$defs/A" } },
            additionalProperties: false,
          },
        },
        $ref: "#/$defs/A",
      } as const satisfies JSONSchema;

      // The walk comes back to `A` beneath `B`, which ends it there; that
      // position is not shown injection-safe, so neither is the root.
      expect(schemaWithInjectionSafeAnnotations(schema, ["secret"])).toEqual({
        ...schema,
        ifc: { confidentiality: ["secret"] },
      });
    });
  });

  describe("validateSchemaValue()", () => {
    it("returns the definition issue for a `multipleOf` that is not positive", () => {
      for (const multipleOf of [0, -2]) {
        expect(validateSchemaValue({ type: "number", multipleOf }, 4)).toBe(
          "schema multipleOf must be a positive finite number",
        );
      }
      expect(validateSchemaValue({ type: "number", multipleOf: 2 }, 4))
        .toBeUndefined();
    });

    it("returns a format mismatch for a string that is not a URI", () => {
      const schema = { type: "string", format: "uri" } as const;
      expect(validateSchemaValue(schema, "not a uri")).toBe(
        "value does not match format uri",
      );
      expect(validateSchemaValue(schema, "https://example.com/x"))
        .toBeUndefined();
    });
  });
});
