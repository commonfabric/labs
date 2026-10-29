/**
 * `deepEqualKey()` against the one property a caller relies on: deeply equal
 * values share a key. A caller groups by the key and then compares within the
 * group, so a pair that keys apart is never compared at all — a value that
 * escapes its group is a duplicate silently kept, with no failure anywhere to
 * say so.
 *
 * The corpus below is checked pairwise, every value against every other, so
 * the property is tested over the traps rather than over a chosen list of
 * them: key order in a record and in an array's named properties, `NaN`,
 * `-0`, sparse arrays, a property holding `undefined` against an absent one,
 * and a null-prototype object against a plain one.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepEqual, deepEqualKey } from "@commonfabric/utils/deep-equal";

/** Named so a failure says which pair of values broke the property. */
const CORPUS: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["zero", 0],
  ["negative zero", -0],
  ["one", 1],
  ["the string one", "1"],
  ["NaN", NaN],
  ["another NaN", Number("banana")],
  ["infinity", Infinity],
  ["negative infinity", -Infinity],
  ["true", true],
  ["false", false],
  ["the string true", "true"],
  ["the empty string", ""],
  ["a bigint", 1n],
  ["the empty array", []],
  ["the empty object", {}],
  ["a null-prototype empty object", Object.create(null)],
  ["one element", [1]],
  ["one hole", Array(1)],
  ["one stored undefined", [undefined]],
  ["two elements", [1, 2]],
  ["two elements, reversed", [2, 1]],
  [
    "an array with two named properties",
    Object.assign([1], {
      tag: "a",
      other: "b",
    }),
  ],
  [
    "that array, named properties added in the other order",
    Object.assign([1], {
      other: "b",
      tag: "a",
    }),
  ],
  [
    "an array with one of those named properties",
    Object.assign([1], {
      tag: "a",
    }),
  ],
  ["a record", { a: 1, b: 2 }],
  ["the same record, keys reversed", { b: 2, a: 1 }],
  ["a record with an undefined value", { a: undefined }],
  ["a record with that key absent", {}],
  ["a null-prototype record", Object.assign(Object.create(null), { a: 1 })],
  ["a plain record with the same property", { a: 1 }],
  ["a nested record", { a: { b: [1, { c: "d" }] } }],
  ["the same nested record", { a: { b: [1, { c: "d" }] } }],
  ["a nested record differing deep down", { a: { b: [1, { c: "e" }] } }],
];

/** Every pair of distinct corpus values `deepEqual()` calls equal. */
const equalPairs = (): [string, unknown, string, unknown][] => {
  const pairs: [string, unknown, string, unknown][] = [];
  for (const [leftName, left] of CORPUS) {
    for (const [rightName, right] of CORPUS) {
      if (leftName === rightName || !deepEqual(left, right)) continue;
      pairs.push([leftName, left, rightName, right]);
    }
  }
  return pairs;
};

describe("deepEqualKey()", () => {
  describe("consistency with `deepEqual()`", () => {
    // The property runs one way only. Two values that key alike may still
    // differ, which is why a caller compares within a group; two values that
    // are equal keying apart is the failure this guards.

    it("gives deeply equal values the same key", () => {
      const apart: string[] = [];
      for (const [leftName, left, rightName, right] of equalPairs()) {
        if (deepEqualKey(left) !== deepEqualKey(right)) {
          apart.push(`${leftName} and ${rightName}`);
        }
      }
      expect(apart).toEqual([]);
    });

    it("holds over a corpus that has deeply equal pairs to check", () => {
      // Without this the test above passes on a corpus where nothing is
      // equal to anything else, which is every corpus one careless edit away.

      expect(equalPairs().length).toBeGreaterThan(8);
    });
  });

  describe("values it groups together", () => {
    // Each of these is a distinction `deepEqual()` draws that the key does
    // not. Grouping them costs a comparison and nothing else, so these pin
    // what the documented contract promises rather than a result to preserve.

    it("returns one key for `0` and `-0`", () => {
      expect(deepEqualKey(0)).toBe(deepEqualKey(-0));
    });

    it("returns one key for two symbols sharing a description", () => {
      expect(deepEqualKey(Symbol("a"))).toBe(deepEqualKey(Symbol("a")));
    });

    it("returns one key for two functions", () => {
      expect(deepEqualKey(() => 1)).toBe(deepEqualKey(function other() {}));
    });

    it("returns one key for a class instance and a matching record", () => {
      class Donut {
        grams = 1;
      }
      expect(deepEqualKey(new Donut())).toBe(deepEqualKey({ grams: 1 }));
    });
  });

  describe("the boundary of the domain the property holds over", () => {
    // `deepEqual()` counts properties with `Object.keys` and reads them with
    // `b[key]`, which resolves through the prototype chain, so a value keeping
    // data anywhere but its own enumerable properties compares equal to
    // values that are not equal to each other. Grouping cannot reproduce a
    // comparison that is not transitive, and neither can deduplicating a list
    // under one, so the key's property is stated over the values `deepEqual()`
    // is built for. These pin where that edge is: a comparison that gains
    // transitivity is a comparison the key can be widened to cover.

    const shared = { x: 1, y: 2 };
    const inheritsY = Object.assign(Object.create(shared), { x: 1 });
    const inheritsX = Object.assign(Object.create(shared), { y: 2 });

    it("returns `true` from `deepEqual()` for two values equal to different third values", () => {
      expect(deepEqual(inheritsY, inheritsX)).toBe(true);
      expect(deepEqual(inheritsY, { x: 1 })).toBe(true);
      expect(deepEqual(inheritsX, { x: 1 })).toBe(false);
    });

    it("gives that pair different keys", () => {
      expect(deepEqualKey(inheritsY)).not.toBe(deepEqualKey(inheritsX));
    });
  });

  describe("values that bound the walk", () => {
    // A key is a grouping device, so a value the walk stops short of keys
    // coarsely and is told apart by the comparison. What the bound buys is
    // that the function returns at all: without it a value reaching itself
    // never terminates, and one reaching a subtree along many paths builds a
    // key exponentially larger than the value.

    it("returns a key for a value that refers to itself", () => {
      const cyclic: Record<string, unknown> = { kind: "atom" };
      cyclic.self = cyclic;
      expect(deepEqualKey(cyclic).length).toBeGreaterThan(0);
    });

    it("returns one key for two values that refer to themselves alike", () => {
      const left: Record<string, unknown> = { kind: "atom" };
      left.self = left;
      const right: Record<string, unknown> = { kind: "atom" };
      right.self = right;
      expect(deepEqualKey(left)).toBe(deepEqualKey(right));
    });

    it("returns a bounded key for a value reached along many paths", () => {
      let shared: unknown = { leaf: 1 };
      for (let depth = 0; depth < 18; depth++) {
        shared = { left: shared, right: shared };
      }
      // Two to the eighteenth leaves, were every path walked.
      expect(deepEqualKey(shared).length).toBeLessThan(20_000);
    });

    it("returns a bounded key for a value carrying a great many properties", () => {
      // Wide rather than deep. A budget checked only where a value is entered
      // bounds nesting and lets a record's own property list run to any
      // length, which is the shape that says whether it is checked per
      // property as well.

      const wide = Object.fromEntries(
        Array.from({ length: 50_000 }, (_, index) => [`k${index}`, index]),
      );
      expect(deepEqualKey(wide).length).toBeLessThan(20_000);
    });
  });

  describe("values it keeps apart", () => {
    // Not required by the contract, but a key that collided here would put
    // every atom of a label in one group and give back the scan it replaces.

    it("returns different keys for values differing deep inside", () => {
      expect(deepEqualKey({ a: { b: [1, 2] } }))
        .not.toBe(deepEqualKey({ a: { b: [1, 3] } }));
    });

    it("returns different keys for a number and its string spelling", () => {
      expect(deepEqualKey(1)).not.toBe(deepEqualKey("1"));
    });

    it("returns different keys for an array and a record of its indices", () => {
      expect(deepEqualKey([7])).not.toBe(deepEqualKey({ 0: 7 }));
    });

    it("returns different keys for two records with different key counts", () => {
      expect(deepEqualKey({ a: 1 })).not.toBe(deepEqualKey({ a: 1, b: 2 }));
    });
  });
});
