import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { maxOf, minOf } from "@commonfabric/utils/math";

describe("math", () => {
  describe("minOf()", () => {
    it("returns the smallest value", () => {
      expect(minOf([3, -1, 2])).toBe(-1);
    });

    it("returns Infinity for an empty collection, like Math.min()", () => {
      expect(minOf([])).toBe(Infinity);
    });

    it("returns NaN when any value is NaN, like Math.min()", () => {
      expect(minOf([1, NaN, 0])).toBeNaN();
    });

    it("prefers -0 over 0, like Math.min()", () => {
      expect(Object.is(minOf([0, -0]), -0)).toBe(true);
    });

    it("walks any iterable, not only arrays", () => {
      expect(minOf(new Set([5, 4, 6]).values())).toBe(4);
    });

    it("handles more values than fit in a call's argument list", () => {
      const values = Array.from({ length: 1_000_000 }, (_, i) => i + 1);
      expect(() => Math.min(...values)).toThrow(RangeError);
      expect(minOf(values)).toBe(1);
    });
  });

  describe("maxOf()", () => {
    it("returns the largest value", () => {
      expect(maxOf([3, -1, 2])).toBe(3);
    });

    it("returns -Infinity for an empty collection, like Math.max()", () => {
      expect(maxOf([])).toBe(-Infinity);
    });

    it("returns NaN when any value is NaN, like Math.max()", () => {
      expect(maxOf([1, NaN, 0])).toBeNaN();
    });

    it("prefers 0 over -0, like Math.max()", () => {
      expect(Object.is(maxOf([-0, 0]), 0)).toBe(true);
    });

    it("walks any iterable, not only arrays", () => {
      expect(maxOf(new Map([["a", 5], ["b", 7]]).values())).toBe(7);
    });

    it("handles more values than fit in a call's argument list", () => {
      const values = Array.from({ length: 1_000_000 }, (_, i) => i + 1);
      expect(() => Math.max(...values)).toThrow(RangeError);
      expect(maxOf(values)).toBe(1_000_000);
    });
  });
});
