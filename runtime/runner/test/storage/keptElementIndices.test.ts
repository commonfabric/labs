import { expect } from "@std/expect";

import { keptElementIndices } from "../../src/storage/array-edit-script.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** Where each element of `before` is kept in `after`, compared by `===`. */
const keptBetween = (
  before: readonly string[],
  after: readonly string[],
  maxEdits = before.length + after.length,
): number[] => [
  ...keptElementIndices(
    before.length,
    after.length,
    (beforeIndex, afterIndex) => before[beforeIndex] === after[afterIndex],
    maxEdits,
  ),
];

describe("keptElementIndices()", () => {
  it("returns each index unchanged for equal sequences", () => {
    expect(keptBetween(["a", "b", "c"], ["a", "b", "c"])).toEqual([0, 1, 2]);
  });

  it("returns the shifted indices after a removal at the start", () => {
    expect(keptBetween(["x", "y", "y"], ["y", "y"])).toEqual([-1, 0, 1]);
  });

  it("returns the shifted indices after an insertion in the middle", () => {
    expect(keptBetween(["a", "b", "c"], ["a", "n", "b", "c"])).toEqual([
      0,
      2,
      3,
    ]);
  });

  it("returns -1 for the element a reorder removes and re-adds", () => {
    expect(keptBetween(["x", "y", "z"], ["y", "x", "z"])).toEqual([-1, 0, 2]);
  });

  it("returns -1 for a substituted element", () => {
    expect(keptBetween(["a", "b", "c"], ["a", "q", "c"])).toEqual([0, -1, 2]);
  });

  it("returns only the common prefix and suffix where no script is short enough", () => {
    expect(
      keptBetween(["a", "p", "q", "r", "z"], ["a", "r", "q", "p", "z"], 2),
    ).toEqual([0, -1, -1, -1, 4]);
  });

  it("returns -1 for every element when the new sequence is empty", () => {
    expect(keptBetween(["a", "b"], [])).toEqual([-1, -1]);
  });
});
