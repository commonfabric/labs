import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";

import {
  annotate,
  parseSigilLink,
  stringifyInspectorJson,
  summarize,
  summarizeLink,
} from "../decode.ts";

const SPACE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("decode", () => {
  describe("parseSigilLink()", () => {
    it("returns the payload fields of a sigil link", () => {
      expect(
        parseSigilLink({ "/": { "link@1": { id: "of:x", path: ["a"] } } }),
      ).toEqual({
        id: "of:x",
        space: undefined,
        path: ["a"],
        scope: undefined,
        schema: undefined,
      });
    });

    it("returns `null` for a sigil whose payload is not a record", () => {
      expect(parseSigilLink({ "/": { "link@1": "of:x" } })).toBeNull();
      expect(parseSigilLink({ "/": { "link@1": ["of:x"] } })).toBeNull();
    });
  });

  describe("summarizeLink()", () => {
    it("returns a question mark for a link without an id", () => {
      expect(summarizeLink({})).toBe("🔗 ?");
    });

    it("returns the path as slash-joined segments when every one is safe", () => {
      expect(summarizeLink({ id: "of:x", path: ["items", "0"] })).toBe(
        "🔗 x/items/0",
      );
      expect(summarizeLink({ id: "of:x", path: [] })).toBe("🔗 x");
    });

    it("returns the path as escaped JSON when a segment is unsafe", () => {
      expect(summarizeLink({ id: "of:x", path: ["a/b", "line "] })).toBe(
        '🔗 x["a/b","line\\u2028"]',
      );
    });

    it("returns the space as a shortened DID", () => {
      expect(summarizeLink({ id: "of:x", space: SPACE })).toBe(
        "🔗 x @z6Mkha…2doK",
      );
    });
  });

  describe("summarize()", () => {
    it("returns a link's summary for a link", () => {
      expect(summarize({ "/": { "link@1": { id: "of:x" } } })).toBe("🔗 x");
    });

    it("returns `#` and the short id for an entity reference", () => {
      expect(summarize({ "/": "of:abc" })).toBe("#abc");
      expect(summarize({ "/": "of:0123456789abcdefghij" })).toBe(
        "#01234567…ghij",
      );
    });

    it("returns compact forms for null, bigint and arrays", () => {
      expect(summarize(null)).toBe("null");
      expect(summarize(12n)).toBe("12n");
      expect(summarize([1, 2, 3])).toBe("[3]");
      expect(summarize([])).toBe("[0]");
    });
  });

  describe("annotate()", () => {
    it("returns a symbol as its description", () => {
      expect(annotate(Symbol("marker"))).toBe("Symbol(marker)");
    });

    it("returns an ellipsis where an array contains itself at full depth", () => {
      const cyclic: FabricValue[] = [1];
      cyclic.push(cyclic);
      expect(annotate(cyclic, Number.POSITIVE_INFINITY)).toEqual([1, "…"]);
    });

    it("returns a repeated, non-cyclic array in full at full depth", () => {
      const shared = [1];
      expect(annotate([shared, shared], Number.POSITIVE_INFINITY)).toEqual([
        [1],
        [1],
      ]);
    });
  });

  describe("stringifyInspectorJson()", () => {
    it("returns empty containers on one line", () => {
      expect(stringifyInspectorJson([])).toBe("[]");
      expect(stringifyInspectorJson({})).toBe("{}");
      expect(stringifyInspectorJson({ a: [], b: {} })).toBe(
        JSON.stringify({ a: [], b: {} }, null, 2),
      );
    });

    it("returns `null` for array items JSON cannot represent", () => {
      const items = [undefined, () => 1, Symbol("s")];
      expect(stringifyInspectorJson(items)).toBe(
        JSON.stringify(items, null, 2),
      );
      expect(stringifyInspectorJson(items)).toBe(
        "[\n  null,\n  null,\n  null\n]",
      );
    });

    it("omits object properties JSON cannot represent", () => {
      const record = { kept: 1, gone: undefined, fn: () => 1, sym: Symbol() };
      expect(stringifyInspectorJson(record)).toBe('{\n  "kept": 1\n}');
    });

    it("throws for a bigint, which annotation lowers first", () => {
      expect(() => stringifyInspectorJson({ n: 1n })).toThrow(
        "unannotated BigInt",
      );
    });

    it("throws for a circular structure but not for a shared one", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => stringifyInspectorJson(cyclic)).toThrow(
        "circular structure",
      );
      const shared = { x: 1 };
      expect(JSON.parse(stringifyInspectorJson([shared, shared]))).toEqual([
        { x: 1 },
        { x: 1 },
      ]);
    });
  });
});
