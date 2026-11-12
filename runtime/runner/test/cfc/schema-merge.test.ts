import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { droppedStoredClaim } from "../../src/cfc/claim-preservation.ts";
import { CfcEnvelopeStabilityError } from "../../src/cfc/envelope-stability-reason.ts";
import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";
import {
  cfcSchemaPoliciesEqual,
  mergeCfcSchemaEnvelopes,
} from "../../src/cfc/schema-merge.ts";

const writer = (moduleIdentity: string, binding = "admit") => ({
  __ctWriterIdentityOf: {
    file: "/admission.tsx",
    path: [binding],
    moduleIdentity,
  },
});

describe("schema-merge", () => {
  describe("mergeCfcSchemaEnvelopes()", () => {
    describe("a union whose branches reach a shared definition", () => {
      // Each stored branch pairs with the candidate's branch of its shape.
      // The `piece` branch's writer is restamped by the candidate, which the
      // merge holds to the stored stamp; the `url` branch names `Fixed`, a
      // definition both sides declare alike, beside a constraint that
      // shadows the reference.

      const document = (
        moduleIdentity: string,
        href: JSONSchemaObj,
      ): JSONSchema => ({
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: { kind: { type: "string", enum: ["url"] }, href },
            required: ["kind"],
            dependentRequired: { href: ["kind"] },
            additionalProperties: false,
          }, {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["piece"] },
              addedBy: { $ref: "#/$defs/Adder" },
            },
            required: ["kind"],
          }],
        },
        $defs: {
          Adder: {
            type: "string",
            ifc: { writeAuthorizedBy: writer(moduleIdentity) },
          },
          Fixed: {
            type: "string",
            ifc: { writeAuthorizedBy: writer("fixed") },
          },
        },
      });

      const writers = (schema: JSONSchema) =>
        cfcSchemaEntries(schema).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        );

      for (
        const [description, stored, candidate] of [
          [
            "the same constraint",
            { $ref: "#/$defs/Fixed", minLength: 1 },
            { $ref: "#/$defs/Fixed", minLength: 1 },
          ],
          [
            "an annotation the candidate changes",
            { $ref: "#/$defs/Fixed", minLength: 1, description: "old" },
            { $ref: "#/$defs/Fixed", minLength: 1, description: "new" },
          ],
        ] as const
      ) {
        it(`returns the reference spelled as the candidate spells it, beside ${description}, and keeps the stored writer`, () => {
          const storedSchema = document("stored", stored);
          const merged = mergeCfcSchemaEnvelopes(
            storedSchema,
            document("next", candidate),
          ) as JSONSchemaObj;

          expect(
            ((merged.items as JSONSchemaObj).anyOf![0] as JSONSchemaObj)
              .properties!.href,
          ).toEqual(candidate);
          expect(writers(merged)).toEqual([writer("fixed"), writer("stored")]);
          expect(droppedStoredClaim(storedSchema, merged)).toBeUndefined();
        });
      }
    });

    it("throws for a `writePolicyAnyOf` alternative whose writer binds another handler", () => {
      const schema = (binding: string): JSONSchema => ({
        type: "string",
        ifc: {
          writePolicyAnyOf: [{ writeAuthorizedBy: writer("m", binding) }],
        },
      });
      expect(() => mergeCfcSchemaEnvelopes(schema("admit"), schema("other")))
        .toThrow(CfcEnvelopeStabilityError);
      expect(() => mergeCfcSchemaEnvelopes(schema("admit"), schema("other")))
        .toThrow("writePolicyAnyOf must remain stable at /");
      expect(mergeCfcSchemaEnvelopes(schema("admit"), schema("admit")))
        .toEqual(schema("admit"));
    });
  });

  describe("cfcSchemaPoliciesEqual()", () => {
    const CLAIMED: JSONSchemaObj = {
      type: "string",
      ifc: { writeAuthorizedBy: ["a"] },
    };
    const OTHER: JSONSchemaObj = {
      type: "string",
      ifc: { writeAuthorizedBy: ["b"] },
    };

    it("compares a tuple position's claim at its index, which `omits` can name", () => {
      const tuple = (slot: JSONSchema): JSONSchema => ({
        type: "array",
        prefixItems: [slot],
        additionalProperties: false,
      });
      expect(cfcSchemaPoliciesEqual(tuple(CLAIMED), tuple(CLAIMED))).toBe(true);
      expect(cfcSchemaPoliciesEqual(tuple(CLAIMED), tuple(OTHER))).toBe(false);
      expect(
        cfcSchemaPoliciesEqual(
          tuple(CLAIMED),
          tuple(OTHER),
          (path) => path.join("/") === "0",
        ),
      ).toBe(true);
    });

    it("compares a claim beneath a keyword that describes no single path, whatever `omits` says", () => {
      const negated = (inner: JSONSchema): JSONSchema => ({
        type: "string",
        not: inner,
      });
      expect(
        cfcSchemaPoliciesEqual(negated(CLAIMED), negated(OTHER), () => true),
      ).toBe(false);
      expect(
        cfcSchemaPoliciesEqual(negated(CLAIMED), negated(CLAIMED), () => true),
      ).toBe(true);
    });

    it("returns `true` for a reference to a boolean schema and the same reference", () => {
      const open: JSONSchema = {
        type: "object",
        properties: { any: { $ref: "#/$defs/Anything" } },
        $defs: { Anything: true },
      };
      expect(cfcSchemaPoliciesEqual(open, open)).toBe(true);
      expect(
        cfcSchemaPoliciesEqual(open, {
          type: "object",
          properties: { any: { $ref: "#/$defs/Anything" } },
          $defs: { Anything: { type: "string", ifc: CLAIMED.ifc } },
        }),
      ).toBe(false);
    });
  });
});
