import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";

import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";
import { decomposeSchema } from "../../src/schema-decompose.ts";
import { registerSchemaDocument } from "../../src/schema-registry.ts";

describe("schema-label-view", () => {
  describe("cfcSchemaEntries()", () => {
    const document = {
      type: "object",
      properties: {
        title: { type: "string", ifc: { integrity: ["reviewed"] } },
        rows: {
          type: "array",
          items: { type: "object", ifc: { confidentiality: ["secret"] } },
        },
      },
    } as const;

    it("keeps a deep-frozen document's entries by the document", () => {
      const frozen = internSchema(document);
      const entries = cfcSchemaEntries(frozen);
      expect(entries.map((entry) => entry.path)).toEqual([
        ["title"],
        ["rows", "*"],
      ]);
      expect(cfcSchemaEntries(frozen)).toBe(entries);
      expect(Object.isFrozen(entries)).toBe(true);
      expect(Object.isFrozen(entries[0])).toBe(true);
      expect(Object.isFrozen(entries[0].label.integrity)).toBe(true);
    });

    it("walks a mutable document on every ask", () => {
      const mutable = structuredClone(document) as {
        properties: { title: unknown };
      };
      const entries = cfcSchemaEntries(mutable as JSONSchema);
      expect(entries).toHaveLength(2);
      expect(cfcSchemaEntries(mutable as JSONSchema)).not.toBe(entries);
      mutable.properties.title = { type: "string" };
      expect(
        cfcSchemaEntries(mutable as JSONSchema).map((entry) => entry.path),
      ).toEqual([
        ["rows", "*"],
      ]);
    });

    it("does not keep a walk that lacked a referenced schema document", () => {
      const decomposed = decomposeSchema({
        type: "object",
        properties: { late: { $ref: "#/$defs/LateLabeled" } },
        $defs: {
          LateLabeled: {
            type: "object",
            ifc: { confidentiality: ["schema-label-view-late"] },
          },
        },
      });
      const reference = internSchema({ $ref: decomposed.rootRef });

      expect(cfcSchemaEntries(reference)).toEqual([]);
      for (const [hash, schemaDocument] of decomposed.documents) {
        registerSchemaDocument(hash, schemaDocument);
      }
      const resolved = cfcSchemaEntries(reference);
      expect(resolved.map((entry) => entry.path)).toEqual([["late"]]);
      expect(cfcSchemaEntries(reference)).toBe(resolved);
    });
  });
});
