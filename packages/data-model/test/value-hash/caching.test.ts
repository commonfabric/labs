import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { hashOf } from "@";

import { hex } from "./hex.ts";

describe("value-hash/caching", () => {
  describe("`hashOf()` caching", () => {
    it("returns the same precomputed-constant object for `null`", () => {
      const a = hashOf(null);
      const b = hashOf(null);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `undefined`", () => {
      const a = hashOf(undefined);
      const b = hashOf(undefined);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `true`", () => {
      const a = hashOf(true);
      const b = hashOf(true);
      expect(a).toBe(b);
    });

    it("returns the same precomputed-constant object for `false`", () => {
      const a = hashOf(false);
      const b = hashOf(false);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive string", () => {
      const a = hashOf("cache-test-string");
      const b = hashOf("cache-test-string");
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive number", () => {
      const a = hashOf(98765);
      const b = hashOf(98765);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a primitive `bigint`", () => {
      const a = hashOf(99887766n);
      const b = hashOf(99887766n);
      expect(a).toBe(b);
    });

    it("returns the same cached object for a deep-frozen object", () => {
      const obj = Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) });
      const a = hashOf(obj);
      const b = hashOf(obj);
      expect(a).toBe(b);
    });

    it("does not cache a mutable object (recomputes each time)", () => {
      const obj = { a: 1 };
      const a = hashOf(obj);
      // Mutate
      obj.a = 2;
      const b = hashOf(obj);
      // Hashes should differ because the object changed
      expect(hex(a.bytes)).not.toEqual(hex(b.bytes));
    });

    it("produces different hashes for different primitives of the same type", () => {
      const a = hashOf("hello");
      const b = hashOf("world");
      expect(hex(a.bytes)).not.toEqual(hex(b.bytes));
    });
  });
});
