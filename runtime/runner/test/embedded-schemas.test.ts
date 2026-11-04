import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  embeddedSchemas,
  externalized,
  isEmbeddedCfcSchemaRef,
} from "../src/embedded-schemas.ts";

describe("embedded-schemas", () => {
  describe("externalized", () => {
    const url = "https://example.test/schemas/doc.json";
    const document = {
      $id: url,
      type: "object",
      properties: {
        named: { $ref: "#/$defs/Named" },
        anything: { $ref: "#/$defs/Anything" },
        elsewhere: { $ref: "https://example.test/schemas/other.json" },
        items: { type: "array", items: { $ref: "#/$defs/Named" } },
      },
      $defs: {
        Named: { type: "string" },
        Anything: true,
      },
    } as unknown as JSONSchema;

    it("keys the body by the URL, without its `$id` or `$defs`", () => {
      const entries = externalized(url, document);
      expect(entries[url]).toEqual({
        type: "object",
        properties: {
          named: { $ref: `${url}#/$defs/Named` },
          anything: { $ref: `${url}#/$defs/Anything` },
          elsewhere: { $ref: "https://example.test/schemas/other.json" },
          items: { type: "array", items: { $ref: `${url}#/$defs/Named` } },
        },
      });
    });

    it("keys each definition by the ref that names it", () => {
      const entries = externalized(url, document);
      expect(entries[`${url}#/$defs/Named`]).toEqual({ type: "string" });
      expect(entries[`${url}#/$defs/Anything`]).toBe(true);
    });

    it("keys a boolean document by its URL alone", () => {
      expect(externalized(url, true)).toEqual({ [url]: true });
    });
  });

  describe("isEmbeddedCfcSchemaRef", () => {
    it("returns true for a resident's URL and for one of its definitions", () => {
      const url = "https://commonfabric.org/schemas/vnode.json";
      expect(isEmbeddedCfcSchemaRef(url)).toBe(true);
      expect(isEmbeddedCfcSchemaRef(`${url}#/$defs/VNode`)).toBe(true);
      expect(embeddedSchemas[`${url}#/$defs/VNode`]).toMatchObject({
        type: "object",
      });
    });

    it("returns false for a definition no resident declares", () => {
      expect(
        isEmbeddedCfcSchemaRef(
          "https://commonfabric.org/schemas/vnode.json#/$defs/Missing",
        ),
      ).toBe(false);
    });
  });
});
