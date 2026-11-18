import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Module, Pattern } from "../src/builder/types.ts";
import { describePatternOrModule, mergeObjects } from "../src/runner-utils.ts";

describe("runner-utils", () => {
  describe("describePatternOrModule()", () => {
    it("returns `undefined` for an absent pattern", () => {
      expect(describePatternOrModule(undefined)).toBe("undefined");
    });

    it("returns the node count of a pattern", () => {
      const pattern: Pattern = {
        argumentSchema: true,
        resultSchema: true,
        result: undefined,
        nodes: [],
      };
      expect(describePatternOrModule(pattern)).toBe("pattern:nodes=0");
    });

    it("returns the referenced name of a `ref` module", () => {
      const module: Module = { type: "ref", implementation: "map" };
      expect(describePatternOrModule(module)).toBe("module:ref:map");
    });

    it("returns only the type of a module whose implementation is not a function", () => {
      const module: Module = { type: "javascript", implementation: "map" };
      expect(describePatternOrModule(module)).toBe("module:javascript");
      expect(describePatternOrModule({ type: "ref" })).toBe("module:ref");
    });

    it("prefers a function's `debugName` over its `src` and `name`", () => {
      const implementation = Object.assign(function named() {}, {
        debugName: "async debugged",
        src: "sourced",
      });
      expect(describePatternOrModule({ type: "javascript", implementation }))
        .toBe("module:javascript:debugged");
    });

    it("falls back to a function's `src`, then its `name`", () => {
      const sourced = Object.assign(function named() {}, { src: "sourced" });
      expect(
        describePatternOrModule({ type: "raw", implementation: sourced }),
      ).toBe("module:raw:sourced");
      expect(
        describePatternOrModule({
          type: "raw",
          implementation: function named() {},
        }),
      ).toBe("module:raw:named");
    });

    it("returns `anonymous` for a function with no usable label", () => {
      const implementation = Object.assign(() => {}, { debugName: "async " });
      Object.defineProperty(implementation, "name", { value: "" });
      expect(describePatternOrModule({ type: "javascript", implementation }))
        .toBe("module:javascript:anonymous");
    });
  });

  describe("mergeObjects()", () => {
    it("returns an empty object when every argument is absent", () => {
      expect(mergeObjects<Record<string, unknown>>()).toEqual({});
      expect(mergeObjects<Record<string, unknown>>(undefined, undefined))
        .toEqual({});
    });

    it("returns the one present argument itself", () => {
      const only = { a: 1 };
      expect(mergeObjects(undefined, only)).toBe(only);
    });
  });
});
