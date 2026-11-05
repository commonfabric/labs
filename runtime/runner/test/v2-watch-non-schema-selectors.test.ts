/**
 * Sync selectors carry whatever schema a read asked with, and a schema that
 * reached the runtime from storage is not always schema-generator output. A
 * keyword can hold a value no schema can be, and normalization prunes each
 * selector's definitions, so every one of those shapes passes through this
 * walk. It runs on the storage path, away from the call site that supplied the
 * schema, so a throw here surfaces as an uncaught error attributable to
 * nothing.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema, SchemaPathSelector } from "@commonfabric/api";
import type { MIME, URI } from "@commonfabric/memory/interface";

import { normalizeSyncSelector } from "../src/storage/v2-watch.ts";
import { watchIdForEntry } from "../src/storage/v2.ts";

const MALFORMED: [label: string, schema: JSONSchema][] = [
  ["additionalProperties holds null", {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: null,
  } as unknown as JSONSchema],
  [
    "properties holds a string",
    { type: "object", properties: "ab" } as unknown as JSONSchema,
  ],
  [
    "properties holds null",
    { type: "object", properties: null } as unknown as JSONSchema,
  ],
  [
    "a property holds null",
    { type: "object", properties: { a: null } } as unknown as JSONSchema,
  ],
  ["items holds null", { type: "array", items: null } as unknown as JSONSchema],
  [
    "prefixItems holds a string",
    { type: "array", prefixItems: "ab" } as unknown as JSONSchema,
  ],
  [
    "a prefixItems entry holds null",
    { type: "array", prefixItems: [null] } as unknown as JSONSchema,
  ],
  ["allOf holds null", { allOf: null } as unknown as JSONSchema],
  ["an anyOf entry holds a number", { anyOf: [7] } as unknown as JSONSchema],
  ["oneOf holds a string", { oneOf: "ab" } as unknown as JSONSchema],
  ["not holds a number", { not: 3 } as unknown as JSONSchema],
  [
    "patternProperties holds a number",
    { patternProperties: 4 } as unknown as JSONSchema,
  ],
  ["$defs holds null", { $defs: null } as unknown as JSONSchema],
  ["a definition holds null", {
    $ref: "#/$defs/Broken",
    $defs: { Broken: null },
  } as unknown as JSONSchema],
];

const address = {
  id: "of:non-schema-selector" as URI,
  type: "application/json" as MIME,
};

describe("v2-watch", () => {
  for (const [label, schema] of MALFORMED) {
    it(`normalizes a selector whose schema's ${label}`, () => {
      const selector: SchemaPathSelector = { path: ["value"], schema };

      const normalized = normalizeSyncSelector(selector);

      expect(normalized.path).toEqual(["value"]);
      // Pruning removes definitions the schema cannot reach and leaves the
      // rest as it arrived, malformed keyword and all.
      expect(normalized.schema).toEqual(schema);
      // Two reads asking with the same schema watch one entry, not two: the
      // id hashes the selector's content, so it has to reach a value the
      // hash cannot be keyed on by identity.
      const separate = normalizeSyncSelector({
        path: ["value"],
        schema: structuredClone(schema),
      });
      expect(watchIdForEntry(address, normalized, "main")).toBe(
        watchIdForEntry(address, separate, "main"),
      );
    });
  }

  it("keeps normalizing selectors that carry no schema at all", () => {
    expect(normalizeSyncSelector(undefined).schema).toBe(false);
    expect(normalizeSyncSelector({ path: [], schema: false }).schema).toBe(
      false,
    );
  });
});
