/**
 * A sparse array stays sparse across the conversion. A hole is not a member
 * holding `undefined`, and the two are different values in this system: the
 * conversion rebuilds every container it walks, so the rebuild is where the
 * distinction is at risk of being flattened away.
 *
 * The assertions count own keys rather than comparing shapes, because
 * `toEqual()` reads a hole and an `undefined` member as the same thing, and a
 * test written that way would pass against a conversion that filled every
 * hole.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { convertCellsToLinks } from "../src/cell.ts";

/** Own index keys of `array`, which a hole does not contribute. */
function presentIndexes(array: readonly unknown[]): number[] {
  return Object.keys(array).map(Number);
}

describe("convert-cells-to-links-arrays", () => {
  it("returns an array whose holes are still holes", () => {
    const sparse: unknown[] = [1, , 3];

    sparse[6] = "far";

    const result = convertCellsToLinks(sparse as never) as unknown[];

    expect(result.length).toBe(7);
    expect(presentIndexes(result)).toEqual([0, 2, 6]);
    expect(1 in result).toBe(false);
  });

  it("returns the members a sparse array does have, converted", () => {
    const sparse: unknown[] = [{ n: 1 }, , { n: 3 }];

    const result = convertCellsToLinks(sparse as never) as unknown[];

    expect(result[0]).toEqual({ n: 1 });
    expect(result[2]).toEqual({ n: 3 });
  });

  it("returns a hole for a hole nested inside a record", () => {
    const nested = { list: [1, , 3] as unknown[] };
    const result = convertCellsToLinks(nested as never) as { list: unknown[] };

    expect(presentIndexes(result.list)).toEqual([0, 2]);
  });

  it("returns an explicit `undefined` member as a member, not a hole", () => {
    // The other side of the distinction. Without this, a conversion that
    // turned every `undefined` into a hole would satisfy the tests above.

    const dense: unknown[] = [1, undefined, 3];
    const result = convertCellsToLinks(dense as never) as unknown[];

    expect(presentIndexes(result)).toEqual([0, 1, 2]);
    expect(1 in result).toBe(true);
  });
});
