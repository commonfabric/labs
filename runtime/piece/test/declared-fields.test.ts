import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  declaredFieldsAt,
  schemaIsArrayShaped,
  schemaIsObjectShaped,
} from "../src/declared-fields.ts";

describe("declared-fields", () => {
  describe("schemaIsObjectShaped()", () => {
    it("returns `true` for a stated object type and for bare `properties`", () => {
      expect(schemaIsObjectShaped({ type: "object" }, {})).toBe(true);
      expect(schemaIsObjectShaped({ properties: {} }, {})).toBe(true);
    });

    it("returns `false` for a boolean schema", () => {
      expect(schemaIsObjectShaped(true, true)).toBe(false);
    });

    it("returns `false` for a position of another type", () => {
      expect(schemaIsObjectShaped({ type: "string" }, {})).toBe(false);
    });

    it("returns `true` for an `allOf` with an object branch, reached through a local reference", () => {
      const root: JSONSchema = {
        $defs: { Thing: { type: "object" } },
        allOf: [{ $ref: "#/$defs/Thing" }],
      };
      expect(schemaIsObjectShaped(root, root)).toBe(true);
    });

    it("returns `false` for an `anyOf` of objects", () => {
      expect(
        schemaIsObjectShaped({ anyOf: [{ type: "object" }] }, {}),
      ).toBe(false);
    });
  });

  describe("schemaIsArrayShaped()", () => {
    it("returns `true` for a stated array type, alone or in a list", () => {
      expect(schemaIsArrayShaped({ type: "array" })).toBe(true);
      expect(schemaIsArrayShaped({ type: ["null", "array"] })).toBe(true);
    });

    it("returns `false` for a stated type that is not an array, even beside `items`", () => {
      expect(schemaIsArrayShaped({ type: "string", items: {} })).toBe(false);
    });

    it("returns `true` for an untyped position naming `items` or `prefixItems`", () => {
      expect(schemaIsArrayShaped({ items: {} })).toBe(true);
      expect(schemaIsArrayShaped({ prefixItems: [] })).toBe(true);
    });

    it("returns `false` for an untyped position naming neither", () => {
      expect(schemaIsArrayShaped({})).toBe(false);
    });
  });

  describe("declaredFieldsAt()", () => {
    it("returns the position's properties and required names, honoring no undeclared field", () => {
      const node = {
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      } as const;
      const fields = declaredFieldsAt(node, node);
      expect(fields.sources.map((source) => Object.keys(source.properties)))
        .toEqual([["title"]]);
      expect([...fields.required]).toEqual(["title"]);
      expect(fields.honorsUndeclared).toBe(false);
    });

    it("honors undeclared fields for a disjunction at the position", () => {
      const node = { properties: { title: {} }, anyOf: [{}, {}] };
      expect(declaredFieldsAt(node, node).honorsUndeclared).toBe(true);
    });

    it("honors undeclared fields for a disjunction inside a conjunction member", () => {
      const node = {
        allOf: [{ properties: { title: {} } }, { oneOf: [{}, {}] }],
      };
      const fields = declaredFieldsAt(node, node);
      expect(fields.honorsUndeclared).toBe(true);
      expect(fields.sources.map((source) => Object.keys(source.properties)))
        .toEqual([["title"]]);
    });

    it("returns the union of a conjunction's members' fields", () => {
      const node = {
        allOf: [
          { properties: { title: {} }, required: ["title"] },
          { properties: { body: {} } },
        ],
      } as const;
      const fields = declaredFieldsAt(node, node);
      expect(fields.sources.map((source) => Object.keys(source.properties)))
        .toEqual([["title"], ["body"]]);
      expect([...fields.required]).toEqual(["title"]);
      expect(fields.honorsUndeclared).toBe(false);
    });

    it("follows a reference that names itself once, and terminates", () => {
      const root: JSONSchema = {
        $defs: {
          Node: {
            properties: { next: {} },
            allOf: [{ $ref: "#/$defs/Node" }],
          },
        },
        allOf: [{ $ref: "#/$defs/Node" }],
      };
      const fields = declaredFieldsAt(root as Record<string, unknown>, root);
      expect(fields.sources.map((source) => Object.keys(source.properties)))
        .toEqual([["next"]]);
    });
  });
});
