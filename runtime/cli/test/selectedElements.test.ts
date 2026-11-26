import { expect } from "@std/expect";
import {
  parseSelectionFilter,
  parseSelectProjection,
  selectedElements,
} from "../lib/cell-selection.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("selectedElements()", () => {
  const filter = parseSelectionFilter('.title == "Kept"');

  it("returns the elements the filter keeps", () => {
    expect(
      selectedElements(
        [{ title: "Kept" }, { title: "Dropped" }],
        { filter },
        false,
      ),
    ).toEqual([{ title: "Kept" }]);
  });

  it("returns an empty list for an unset value under a filter", () => {
    expect(selectedElements(undefined, { filter }, false)).toEqual([]);
  });

  it("returns the value itself for a selection that is not a list", () => {
    const value = { title: "Whole" };

    expect(
      selectedElements(
        value,
        { projection: parseSelectProjection("title") },
        false,
      ),
    ).toBe(value);
  });

  it("throws for a filter over a value that is not an array", () => {
    expect(() => selectedElements({ title: "Kept" }, { filter }, false))
      .toThrow("--filter can only be applied to an array");
  });

  it("throws for an item projection over a value that is not an array", () => {
    expect(() =>
      selectedElements(
        { title: "Kept" },
        { projection: parseSelectProjection("title") },
        true,
      )
    ).toThrow("--select can only project array items from an array value");
  });
});
