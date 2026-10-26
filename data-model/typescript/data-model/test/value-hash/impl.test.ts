import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  deepFreeze,
  type FabricValue,
  hashOf,
  hashStringOf,
  taggedHashStringOf,
} from "@";
import { ValueHasher } from "@/value-hash/ValueHasher.ts";

describe("value-hash/impl", () => {
  describe("hashOf()", () => {
    it("returns the hash `ValueHasher.computeHash()` does, whichever path the value takes", () => {
      // One value per arm of the dispatch: the precomputed constants, the
      // primitive cache, the deep-frozen-object cache, and a fresh hash of a
      // mutable object. `0` comes before `-0` so that the primitive cache
      // holds an entry a `-0` would find, were it looked up there.
      const values: FabricValue[] = [
        true,
        false,
        undefined,
        null,
        "str",
        12n,
        34,
        0,
        -0,
        Symbol.for("sym"),
        deepFreeze({ frozen: [1] }),
        { mutable: [2] },
      ];

      for (const value of values) {
        expect(hashOf(value).bytes).toEqual(
          ValueHasher.computeHash(value).bytes,
        );
      }
    });

    it("throws for `Symbol(desc)` (unique / uninterned)", () => {
      expect(() => hashOf(Symbol("nope"))).toThrow(
        "Cannot hash unique (uninterned) symbol",
      );
    });
  });

  describe("hashStringOf", () => {
    it("returns a string", () => {
      const result = hashStringOf(42);
      expect(typeof result).toBe("string");
    });

    it("matches `FabricHash.hashString` for primitives", () => {
      const values: FabricValue[] = [
        null,
        true,
        false,
        0,
        42,
        "",
        "hello",
        0n,
        127n,
        undefined,
      ];
      for (const v of values) {
        expect(hashStringOf(v)).toBe(hashOf(v).hashString);
      }
    });

    it("matches `FabricHash.hashString` for frozen objects", () => {
      const obj = Object.freeze({ a: 1, b: Object.freeze({ c: 2 }) });
      expect(hashStringOf(obj)).toBe(hashOf(obj).hashString);
    });

    it("matches `FabricHash.hashString` for mutable objects", () => {
      const obj = { x: [1, 2, 3] };
      expect(hashStringOf(obj)).toBe(hashOf(obj).hashString);
    });

    it("returns a result that does not contain the algorithm tag or colon", () => {
      const result = hashStringOf({ hello: "world" });
      expect(result.includes("fid1")).toBe(false);
      expect(result.includes(":")).toBe(false);
    });

    it("returns a valid unpadded base64url result", () => {
      const result = hashStringOf(42);
      // No padding characters.
      expect(result.includes("=")).toBe(false);
      // Only base64url characters.
      expect(/^[A-Za-z0-9_-]+$/.test(result)).toBe(true);
    });
  });

  describe("taggedHashStringOf", () => {
    it("returns a string", () => {
      const result = taggedHashStringOf(42);
      expect(typeof result).toBe("string");
    });

    it("returns a string that starts with a `tag:`", () => {
      const result = taggedHashStringOf(42);
      expect(result.startsWith("fid1:")).toBe(true);
    });

    it("returns a hash portion that matches that of `hashStringOf()`", () => {
      const value = 42;
      const result = taggedHashStringOf(value);
      const sansTag = result.replace(/^[a-z0-9]+:/, "");
      expect(sansTag).toBe(hashStringOf(value));
    });
  });
});
