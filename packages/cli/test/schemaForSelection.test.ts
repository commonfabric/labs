import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchemaObj } from "@commonfabric/api";
import { containsExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { anySchema } from "@commonfabric/data-model-schema/schema-walk";
import { decomposeSchema, type JSONSchema } from "@commonfabric/runner";
import type { IfcKey } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { schemaForSelection } from "../lib/cell-selection.ts";
import { externalizeSchema } from "../../runner/src/link-utils.ts";

/** A value of the shape the runtime reads each `ifc` key as. */
const SAMPLES = {
  confidentiality: ["source-secret"],
  observes: "shape",
  integrity: ["source-endorsed"],
  addIntegrity: ["source-added"],
  requiredIntegrity: ["source-floor"],
  maxConfidentiality: ["source-ceiling"],
  ownerPrincipal: { __ctCurrentPrincipal: true },
  writeAuthorizedBy: {
    __ctWriterIdentityOf: { path: ["setName"], moduleIdentity: "module" },
  },
  writePolicyAnyOf: [{ writeAuthorizedBy: ["a-builtin"] }],
  uiContract: { helper: "UiAction", action: "EditProfile" },
  exactCopyOf: ["draft"],
  projection: { from: "/draft", path: "/name" },
  collection: { subsetOf: ["all"] },
  flowPrecisionClaim: { kind: "pointwise" },
} satisfies Record<IfcKey | "observes", unknown>;

/**
 * What the rewrite is expected to do with each key. The `satisfies` clause
 * fails to compile for a key the runtime knows that has no row here, which
 * closes the set the two cases below iterate. It is blind to a row naming a
 * key the runtime does not know.
 */
const EXPECTED = {
  confidentiality: "carried",
  observes: "carried",
  integrity: "dropped",
  addIntegrity: "dropped",
  requiredIntegrity: "dropped",
  maxConfidentiality: "dropped",
  ownerPrincipal: "dropped",
  writeAuthorizedBy: "dropped",
  writePolicyAnyOf: "dropped",
  uiContract: "dropped",
  exactCopyOf: "dropped",
  projection: "dropped",
  collection: "dropped",
  flowPrecisionClaim: "dropped",
} satisfies Record<IfcKey | "observes", "carried" | "dropped">;

const keysExpected = (outcome: "carried" | "dropped") =>
  (Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]).filter((key) =>
    EXPECTED[key] === outcome
  );

/** A string schema stating one `ifc` key beside a label. */
const labeledWith = (key: keyof typeof SAMPLES): JSONSchema =>
  ({
    type: "string",
    ifc: { confidentiality: ["beside"], [key]: SAMPLES[key] },
  }) as JSONSchema;

describe("schemaForSelection()", () => {
  it("returns the same object for a schema stating only keys it carries", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        id: { type: "number", ifc: { confidentiality: ["source-secret"] } },
        title: { type: "string" },
      },
    };
    expect(schemaForSelection(schema)).toBe(schema);
    expect(schemaForSelection(true)).toBe(true);
    expect(schemaForSelection(false)).toBe(false);
  });

  it("returns each carried key as the source states it", () => {
    for (const key of keysExpected("carried")) {
      const schema = labeledWith(key);
      expect(schemaForSelection(schema)).toEqual(schema);
    }
  });

  it("returns a schema without each key that binds or vouches for a writer", () => {
    for (const key of keysExpected("dropped")) {
      expect(schemaForSelection(labeledWith(key))).toEqual({
        type: "string",
        ifc: { confidentiality: ["beside"] },
      });
    }
  });

  it("returns a schema without `ifc` where every key it stated is dropped", () => {
    expect(schemaForSelection({
      type: "string",
      default: "",
      ifc: {
        writeAuthorizedBy: SAMPLES.writeAuthorizedBy,
        ownerPrincipal: SAMPLES.ownerPrincipal,
        addIntegrity: SAMPLES.addIntegrity,
      },
    } as JSONSchema)).toEqual({ type: "string", default: "" });
  });

  it("returns a key the runtime does not know as the source states it", () => {
    const schema = {
      type: "string",
      ifc: { someFutureClaim: ["kept"], writeAuthorizedBy: ["a-builtin"] },
    } as unknown as JSONSchema;
    expect(schemaForSelection(schema)).toEqual({
      type: "string",
      ifc: { someFutureClaim: ["kept"] },
    });
  });

  it("returns every position a schema holds without its dropped keys, definitions included", () => {
    const claimed = {
      confidentiality: ["source-secret"],
      writeAuthorizedBy: ["a-builtin"],
    };
    const kept = { confidentiality: ["source-secret"] };
    const position = (ifc: object) => ({ type: "string", ifc });
    const shape = (ifc: object) => ({
      type: "object",
      ifc,
      properties: {
        field: position(ifc),
        list: {
          type: "array",
          ifc,
          items: position(ifc),
          prefixItems: [position(ifc)],
        },
        named: { $ref: "#/$defs/Named" },
        union: { anyOf: [position(ifc), { oneOf: [position(ifc)] }] },
        both: { allOf: [position(ifc)] },
      },
      additionalProperties: position(ifc),
      patternProperties: { "^x-": position(ifc) },
      $defs: { Named: position(ifc) },
    });
    expect(schemaForSelection(shape(claimed) as unknown as JSONSchema))
      .toEqual(shape(kept));
  });

  it("returns a schema object that holds itself, rewritten down to where it re-enters", () => {
    const cyclic: Record<string, unknown> = {
      type: "object",
      ifc: { writeAuthorizedBy: ["a-builtin"] },
    };
    cyclic.properties = { self: cyclic };
    const rewritten = schemaForSelection(cyclic as JSONSchema) as {
      ifc?: unknown;
      properties: { self: unknown };
    };
    expect(rewritten.ifc).toBeUndefined();
    expect(rewritten.properties.self).toBe(cyclic);
  });

  describe("a schema naming a content-addressed document", () => {
    const claimed: JSONSchemaObj = {
      type: "string",
      ifc: {
        confidentiality: ["source-secret"],
        writeAuthorizedBy: ["a-builtin"],
      },
    };

    /** Whether any position `schema` holds states `key` in its `ifc`. */
    const states = (schema: JSONSchema, key: string): boolean =>
      anySchema(
        schema,
        (node) =>
          isObjectNotArray(node.schema) && isObjectNotArray(node.schema.ifc) &&
          Object.hasOwn(node.schema.ifc, key),
        { includeDefs: true, includeUnused: true },
      );

    it("returns the document's positions inline, without the keys it drops", () => {
      for (
        const schema of [
          externalizeSchema({
            type: "object",
            properties: { name: claimed },
          }),
          {
            type: "object",
            properties: { name: externalizeSchema(claimed) },
          } as JSONSchema,
        ]
      ) {
        const rewritten = schemaForSelection(schema);
        expect(containsExternalSchemaRef(rewritten)).toBe(false);
        expect(states(rewritten, "writeAuthorizedBy")).toBe(false);
        expect(states(rewritten, "confidentiality")).toBe(true);
      }
    });

    it("returns a schema naming a document the registry does not hold as written", () => {
      // Decomposing without a registry hands back the reference a document
      // would have, and registers nothing.
      const { rootRef } = decomposeSchema({
        ...claimed,
        description: "held by no registry",
      });
      const schema: JSONSchema = {
        type: "object",
        properties: { name: { $ref: rootRef } },
      };
      expect(schemaForSelection(schema)).toBe(schema);
    });
  });
});
