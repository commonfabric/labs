import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TwoLevelWeakCache } from "@commonfabric/utils/two-level-weak-cache";

describe("TwoLevelWeakCache", () => {
  describe("memoize()", () => {
    it("computes once per (outer, key) pair", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      const key = {};
      let calls = 0;
      const compute = () => {
        calls++;
        return 42;
      };

      expect(cache.memoize(outer, key, compute)).toBe(42);
      expect(cache.memoize(outer, key, compute)).toBe(42);
      expect(calls).toBe(1);
    });

    it("returns the same reference on a cache hit", () => {
      const cache = new TwoLevelWeakCache<object, object, object>();
      const outer = {};
      const key = {};
      const value = {};

      const first = cache.memoize(outer, key, () => value);
      const second = cache.memoize(outer, key, () => ({}));
      expect(first).toBe(value);
      expect(second).toBe(value);
    });

    it("caches a computed `undefined` and does not recompute", () => {
      const cache = new TwoLevelWeakCache<object, object, number | undefined>();
      const outer = {};
      const key = {};
      let calls = 0;
      const compute = () => {
        calls++;
        return undefined;
      };

      expect(cache.memoize(outer, key, compute)).toBe(undefined);
      expect(cache.memoize(outer, key, compute)).toBe(undefined);
      expect(calls).toBe(1);
    });

    it("keeps entries separate per outer key", () => {
      const cache = new TwoLevelWeakCache<object, object, string>();
      const outerA = {};
      const outerB = {};
      const key = {};

      expect(cache.memoize(outerA, key, () => "a")).toBe("a");
      // Same inner key, different outer key: a distinct entry rather than the
      // cached `a`.
      expect(cache.memoize(outerB, key, () => "b")).toBe("b");
      expect(cache.memoize(outerA, key, () => "ignored")).toBe("a");
    });

    it("keeps entries separate per inner key within an outer", () => {
      const cache = new TwoLevelWeakCache<object, object, string>();
      const outer = {};
      const keyA = {};
      const keyB = {};

      expect(cache.memoize(outer, keyA, () => "a")).toBe("a");
      expect(cache.memoize(outer, keyB, () => "b")).toBe("b");
      expect(cache.memoize(outer, keyA, () => "ignored")).toBe("a");
    });
  });

  describe("groupFor()", () => {
    it("returns the same inner map across calls for one outer key", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      expect(cache.groupFor(outer)).toBe(cache.groupFor(outer));
    });

    it("returns distinct inner maps for distinct outer keys", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      expect(cache.groupFor({})).not.toBe(cache.groupFor({}));
    });

    it("shares storage with memoize", () => {
      const cache = new TwoLevelWeakCache<object, object, number>();
      const outer = {};
      const key = {};
      cache.groupFor(outer).set(key, 7);
      expect(cache.memoize(outer, key, () => 99)).toBe(7);
    });
  });
});
