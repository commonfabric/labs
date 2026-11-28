import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  ARRAY_SUBSCHEMA_KEYS,
  DEFS_KEYS,
  RECORD_SUBSCHEMA_KEYS,
  SINGLE_SUBSCHEMA_KEYS,
  UNUSED_RECORD_SUBSCHEMA_KEYS,
  UNUSED_SINGLE_SUBSCHEMA_KEYS,
} from "@commonfabric/data-model-schema/schema-walk";
import { describe, it } from "@commonfabric/test-support/test";

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

    it("returns no entry below a property whose reference resolves to a boolean schema", () => {
      const schema = {
        type: "object",
        properties: {
          open: { $ref: "#/$defs/Anything" },
          title: { $ref: "#/$defs/Labeled" },
        },
        $defs: {
          Anything: true,
          Labeled: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      } as const satisfies JSONSchema;
      expect(cfcSchemaEntries(schema).map((entry) => entry.path)).toEqual([
        ["title"],
      ]);
    });

    describe("subschema keywords", () => {
      const labeled = { ifc: { confidentiality: ["secret"] } } as const;
      type Placement = { path: string[]; conditional?: true } | undefined;
      const placements = (schema: JSONSchema) =>
        cfcSchemaEntries(schema).map(({ path, conditional }) => ({
          path,
          ...(conditional ? { conditional } : {}),
        }));

      // Each table names every keyword of its group in the default walk, so a
      // keyword added to a group fails to compile here until it has a rule.
      const single: Record<
        (typeof SINGLE_SUBSCHEMA_KEYS)[number],
        Placement
      > = {
        not: undefined,
        items: { path: ["*"] },
        additionalProperties: { path: ["*"] },
      };
      const array: Record<(typeof ARRAY_SUBSCHEMA_KEYS)[number], Placement> = {
        allOf: { path: [] },
        anyOf: { path: [], conditional: true },
        oneOf: { path: [], conditional: true },
        prefixItems: { path: ["0"] },
      };
      const record: Record<
        (typeof RECORD_SUBSCHEMA_KEYS)[number],
        Placement
      > = {
        properties: { path: ["field"] },
      };
      const expected = (placement: Placement) =>
        placement === undefined ? [] : [placement];

      it("places a declaration under each keyword of the default walk", () => {
        for (const keyword of SINGLE_SUBSCHEMA_KEYS) {
          expect(placements({ [keyword]: labeled })).toEqual(
            expected(single[keyword]),
          );
        }
        for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
          expect(placements({ [keyword]: [labeled] })).toEqual(
            expected(array[keyword]),
          );
        }
        for (const keyword of RECORD_SUBSCHEMA_KEYS) {
          expect(placements({ [keyword]: { field: labeled } })).toEqual(
            expected(record[keyword]),
          );
        }
      });

      it("returns no wildcard entry for additional properties beside named ones", () => {
        expect(placements({
          properties: { named: { type: "string" } },
          additionalProperties: labeled,
        })).toEqual([]);
      });

      it("returns no entry for a keyword outside the default walk", () => {
        for (const keyword of UNUSED_SINGLE_SUBSCHEMA_KEYS) {
          expect(placements({ [keyword]: labeled })).toEqual([]);
        }
        for (const keyword of [...UNUSED_RECORD_SUBSCHEMA_KEYS, ...DEFS_KEYS]) {
          expect(placements({ [keyword]: { field: labeled } })).toEqual([]);
        }
      });
    });
  });
});
