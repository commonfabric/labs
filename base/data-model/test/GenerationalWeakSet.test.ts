/**
 * A weak identity set kept in generations, so that no one table grows past
 * V8's ceiling. What matters is what it still answers for and what it lets go:
 * every key of the generations it keeps, and nothing of the ones it dropped.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { GenerationalWeakSet } from "@/GenerationalWeakSet.ts";

describe("GenerationalWeakSet", () => {
  describe("has()", () => {
    it("returns `true` for an added value and `false` for any other", () => {
      const set = new GenerationalWeakSet<object>(2, 2);
      const added = {};
      set.add(added);
      expect(set.has(added)).toBe(true);
      expect(set.has({})).toBe(false);
    });

    it("answers for every value of each generation it keeps", () => {
      const set = new GenerationalWeakSet<object>(2, 2);
      const [a, b, c] = [{}, {}, {}];
      set.add(a);
      set.add(b);
      set.add(c); // The first generation is full, so this starts the second.
      expect([set.has(a), set.has(b), set.has(c)]).toEqual([true, true, true]);
    });

    it("forgets the values of a generation once it is dropped", () => {
      const set = new GenerationalWeakSet<object>(2, 2);
      const [a, b, c, d, e] = [{}, {}, {}, {}, {}];
      for (const value of [a, b, c, d, e]) set.add(value);
      // `e` started a third generation, so the first, holding `a` and `b`, went.
      expect([set.has(a), set.has(b)]).toEqual([false, false]);
      expect([set.has(c), set.has(d), set.has(e)]).toEqual([true, true, true]);
    });

    it("answers again for a dropped value once it is added again", () => {
      const set = new GenerationalWeakSet<object>(1, 1);
      const [a, b] = [{}, {}];
      set.add(a);
      set.add(b);
      expect(set.has(a)).toBe(false);
      set.add(a);
      expect(set.has(a)).toBe(true);
    });
  });

  describe("add()", () => {
    it("takes no room for a value the newest generation already holds", () => {
      const set = new GenerationalWeakSet<object>(2, 1);
      const [a, b, c] = [{}, {}, {}];
      set.add(a);
      set.add(a);
      set.add(b);
      // Had the second `a` counted, `b` would have started a new generation and
      // the single kept generation would hold `b` alone.
      expect([set.has(a), set.has(b)]).toEqual([true, true]);
      set.add(c);
      expect([set.has(a), set.has(b), set.has(c)]).toEqual([
        false,
        false,
        true,
      ]);
    });
  });

  describe("constructor", () => {
    it("throws a `RangeError` for a limit or generation count that is not a positive integer", () => {
      const cases: [number, number][] = [[0, 1], [1, 0], [1.5, 1], [1, -2]];
      for (const [limit, generations] of cases) {
        expect(() => new GenerationalWeakSet<object>(limit, generations))
          .toThrow(RangeError);
      }
    });
  });
});
