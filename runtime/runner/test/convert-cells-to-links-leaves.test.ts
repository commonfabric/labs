/**
 * What `convertCellsToLinks()` does with a value that is not a container: a
 * primitive and `null` come back as given, and a function is refused with the
 * same reason every vetting of a value gives.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type CellLinkInput, convertCellsToLinks } from "../src/cell.ts";

describe("convert-cells-to-links-leaves", () => {
  it("returns `null` for `null`", () => {
    expect(convertCellsToLinks(null)).toBe(null);
  });

  it("returns a primitive as given", () => {
    expect(convertCellsToLinks(42)).toBe(42);
    expect(convertCellsToLinks("forty-two")).toBe("forty-two");
    expect(convertCellsToLinks(true)).toBe(true);
    expect(convertCellsToLinks(undefined)).toBe(undefined);
  });

  it("throws the vetting's refusal for a function", () => {
    // The cast is the point: `CellLinkInput` refuses a function already, and
    // what is pinned is that the runtime refuses one that gets past it, with
    // the reason the vetting gives everywhere else.
    expect(() => convertCellsToLinks((() => 1) as unknown as CellLinkInput))
      .toThrow("Not representable as a `FabricValue`: function");
  });
});
