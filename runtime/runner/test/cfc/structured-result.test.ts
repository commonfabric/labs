import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "../../src/builder/types.ts";
import { validateAndSanitizeSchemaValueWithOpaqueLinks } from "../../src/cfc/structured-result.ts";

describe("structured-result", () => {
  describe("validateAndSanitizeSchemaValueWithOpaqueLinks()", () => {
    it("returns a caller's opaque link sealed under a position whose schema is `true`", () => {
      // A schema that admits anything declares no opaque link, so the link the
      // value carries is not one the caller was asked for.

      expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema: {
          type: "object",
          properties: { evidence: true },
          required: ["evidence"],
          additionalProperties: false,
        } satisfies JSONSchema,
        value: { evidence: { "@link": "opaque:child-run-1#/raw" } },
        opaqueHandleId: "run-1",
      })).toEqual({
        value: { evidence: { "@link": "opaque:run-1#/evidence" } },
        linkedStringCount: 0,
        sealedPaths: [["evidence"]],
      });
    });

    it("returns an empty object under a schema that is `true` as it is", () => {
      expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema: {
          type: "object",
          properties: { evidence: true },
          required: ["evidence"],
          additionalProperties: false,
        } satisfies JSONSchema,
        value: { evidence: {} },
        opaqueHandleId: "run-1",
      })).toEqual({
        value: { evidence: {} },
        linkedStringCount: 0,
        sealedPaths: [],
      });
    });

    it("returns a property governed by its own schema beside an `allOf` branch of `true`", () => {
      const schema = {
        type: "object",
        properties: {
          record: {
            type: "object",
            properties: {
              kind: { enum: ["note"] },
              text: { type: "string" },
            },
            allOf: [true],
            additionalProperties: false,
          },
        },
        required: ["record"],
        additionalProperties: false,
      } satisfies JSONSchema;
      expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema,
        value: { record: { kind: "note", text: "free text" } },
        opaqueHandleId: "run-1",
      })).toEqual({
        value: {
          record: {
            kind: "note",
            text: { "@link": "opaque:run-1#/record/text" },
          },
        },
        linkedStringCount: 1,
        sealedPaths: [["record", "text"]],
      });
    });
  });
});
