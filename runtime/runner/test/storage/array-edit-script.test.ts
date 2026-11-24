import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { spliceAll } from "@commonfabric/collections/splice";

import {
  type ArrayEditHunk,
  shortestEditHunks,
} from "../../src/storage/array-edit-script.ts";

/** The runs of a shortest script from `before` to `after`, compared by `===`. */
const hunksBetween = (
  before: readonly string[],
  after: readonly string[],
  maxEdits = before.length + after.length,
): ArrayEditHunk[] | undefined =>
  shortestEditHunks(
    before.length,
    after.length,
    (beforeIndex, afterIndex) => before[beforeIndex] === after[afterIndex],
    maxEdits,
  );

/** What `hunks` make of `before`, each taking its elements from `after`. */
const applyHunks = (
  before: readonly string[],
  after: readonly string[],
  hunks: readonly ArrayEditHunk[],
): string[] => {
  const result = [...before];
  // From the last run back, so each run's `start` still names its place.
  for (const hunk of [...hunks].reverse()) {
    spliceAll(
      result,
      hunk.start,
      hunk.remove,
      after.slice(hunk.addStart, hunk.addStart + hunk.add),
    );
  }
  return result;
};

/** The length of a longest common subsequence, by the quadratic table. */
const commonSubsequenceLength = (
  before: readonly string[],
  after: readonly string[],
): number => {
  const table = Array.from(
    { length: before.length + 1 },
    () => new Array<number>(after.length + 1).fill(0),
  );
  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      table[i]![j] = before[i - 1] === after[j - 1]
        ? table[i - 1]![j - 1]! + 1
        : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[before.length]![after.length]!;
};

/** A deterministic generator of numbers in `[0, 1)`, from `seed`. */
const seededRandom = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

describe("shortestEditHunks()", () => {
  it("returns no runs for two equal sequences", () => {
    expect(hunksBetween(["a", "b"], ["a", "b"])).toEqual([]);
    expect(hunksBetween([], [])).toEqual([]);
  });

  it("returns one run for an element inserted at the head", () => {
    expect(hunksBetween(["a", "b", "c"], ["x", "a", "b", "c"])).toEqual([
      { start: 0, remove: 0, addStart: 0, add: 1 },
    ]);
  });

  it("returns one run for an element removed from the middle", () => {
    expect(hunksBetween(["a", "b", "c"], ["a", "c"])).toEqual([
      { start: 1, remove: 1, addStart: 1, add: 0 },
    ]);
  });

  it("returns an addition and a removal for an element moved to the head", () => {
    expect(hunksBetween(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual([
      { start: 0, remove: 0, addStart: 0, add: 1 },
      { start: 3, remove: 1, addStart: 4, add: 0 },
    ]);
  });

  it("returns one run that removes and adds for an element changed in place", () => {
    expect(hunksBetween(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { start: 1, remove: 1, addStart: 1, add: 1 },
    ]);
  });

  it("returns runs that take each of many sequences to another with as few edits as any script makes", () => {
    const random = seededRandom(20261118);
    const sequence = () =>
      Array.from(
        { length: Math.floor(random() * 12) },
        () => "abcd"[Math.floor(random() * 4)]!,
      );
    for (let trial = 0; trial < 500; trial += 1) {
      const before = sequence();
      const after = sequence();
      const hunks = hunksBetween(before, after);
      expect(hunks).toBeDefined();
      expect(applyHunks(before, after, hunks!)).toEqual(after);
      const edits = hunks!.reduce((sum, h) => sum + h.remove + h.add, 0);
      expect(edits).toBe(
        before.length + after.length -
          2 * commonSubsequenceLength(before, after),
      );
      // Runs are in increasing order, and each is separated from the next by
      // at least one element both sequences keep.
      for (let index = 1; index < hunks!.length; index += 1) {
        const previous = hunks![index - 1]!;
        expect(hunks![index]!.start).toBeGreaterThan(
          previous.start + previous.remove,
        );
      }
    }
  });

  it("returns `undefined` where a shortest script makes more edits than the bound, and the script where it makes exactly as many", () => {
    const before = ["a", "b", "c", "d"];
    const after = ["d", "c", "b", "a"];
    const edits = before.length + after.length -
      2 * commonSubsequenceLength(before, after);

    expect(hunksBetween(before, after, edits - 1)).toBeUndefined();
    const hunks = hunksBetween(before, after, edits);
    expect(hunks).toBeDefined();
    expect(applyHunks(before, after, hunks!)).toEqual(after);
  });

  it("returns `undefined` for a bound of zero between two sequences that differ", () => {
    expect(hunksBetween(["a"], ["b"], 0)).toBeUndefined();
    expect(hunksBetween(["a"], ["a"], 0)).toEqual([]);
  });
});
