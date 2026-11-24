import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spliceAll } from "@commonfabric/collections/splice";

describe("splice", () => {
  describe("spliceAll()", () => {
    it("replaces a range and returns what it removed, like splice()", () => {
      const array = [1, 2, 3, 4, 5];
      expect(spliceAll(array, 1, 2, [7, 8, 9])).toEqual([2, 3]);
      expect(array).toEqual([1, 7, 8, 9, 4, 5]);
    });

    it("counts a negative start from the end, like splice()", () => {
      const array = [1, 2, 3, 4];
      expect(spliceAll(array, -2, 1, [9])).toEqual([3]);
      expect(array).toEqual([1, 2, 9, 4]);
    });

    it("clamps a range that runs past the end, like splice()", () => {
      const array = [1, 2, 3];
      expect(spliceAll(array, 2, 10, [8, 9])).toEqual([3]);
      expect(array).toEqual([1, 2, 8, 9]);
    });

    it("inserts without removing when the count is zero", () => {
      const array = [1, 2];
      expect(spliceAll(array, 1, 0, new Set([5, 6]))).toEqual([]);
      expect(array).toEqual([1, 5, 6, 2]);
    });

    it("keeps the holes of a sparse array, like splice()", () => {
      // deno-lint-ignore no-sparse-arrays
      const array = [1, , 3, , 5];
      // deno-lint-ignore no-sparse-arrays
      const native = [1, , 3, , 5];
      expect(spliceAll(array, 1, 1, [7, 8])).toEqual(native.splice(1, 1, 7, 8));
      expect(array.length).toBe(native.length);
      expect(Object.keys(array)).toEqual(Object.keys(native));
      expect(Object.keys(array)).toEqual(["0", "1", "2", "3", "5"]);
    });

    it("reads all of the items before changing the array, like splice()", () => {
      const array = [1, 2, 3];
      spliceAll(array, 1, 0, array);
      expect(array).toEqual([1, 1, 2, 3, 2, 3]);

      function* failing() {
        yield 9;
        throw new Error("stop");
      }
      const untouched = [1, 2, 3];
      expect(() => spliceAll(untouched, 1, 1, failing())).toThrow("stop");
      expect(untouched).toEqual([1, 2, 3]);
    });

    it("handles more items than fit in a call's argument list", () => {
      const items = Array.from({ length: 1_000_000 }, (_, i) => i);
      // deno-lint-ignore cf-spread/no-spread-arguments -- shows that the spread overflows
      expect(() => [0, 0].splice(1, 0, ...items)).toThrow(RangeError);
      const array = [-1, -2];
      spliceAll(array, 1, 0, items);
      expect(array.length).toBe(1_000_002);
      expect(array[1]).toBe(0);
      expect(array.at(-1)).toBe(-2);
    });
  });
});
