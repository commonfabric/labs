import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type MarginGroup, placeMarginGroups } from "./margin.ts";

/** A shown group of `height` beside the text at `anchorTop`. */
const beside = (
  anchorTop: number | undefined,
  height = 20,
  active = false,
): MarginGroup => ({ anchorTop, height, active });

describe("placeMarginGroups()", () => {
  it("returns each group's anchor as its top when the groups have room", () => {
    const placed = placeMarginGroups([beside(0), beside(100)], 0, 10);

    expect(placed).toEqual({ tops: [0, 100], height: 120 });
  });

  it("returns a top `gap` below the group above for a group that would overlap it", () => {
    const placed = placeMarginGroups([beside(0, 50), beside(30)], 0, 10);

    expect(placed.tops).toEqual([0, 60]);
  });

  it("returns tops in the order the groups were given, placed in their anchors' order", () => {
    // The group given first is the lower of the two, so it is the one moved.

    const placed = placeMarginGroups([beside(30), beside(0, 50)], 0, 10);

    expect(placed.tops).toEqual([60, 0]);
  });

  it("returns tops at least `gap` below the leading children", () => {
    const placed = placeMarginGroups([beside(0)], 40, 10);

    expect(placed.tops).toEqual([50]);
  });

  it("returns the active group's anchor as its top, moving the groups above it up", () => {
    const placed = placeMarginGroups(
      [beside(100, 50), beside(120, 20, true), beside(130)],
      0,
      10,
    );

    expect(placed.tops).toEqual([60, 120, 150]);
  });

  it("returns a top below its anchor for an active group the leading children leave no room above", () => {
    const placed = placeMarginGroups(
      [beside(20, 30), beside(30, 20, true)],
      10,
      10,
    );

    expect(placed.tops).toEqual([20, 60]);
  });

  it("returns tops after the anchored groups for groups without an anchor, in the order given", () => {
    const placed = placeMarginGroups(
      [beside(undefined), beside(200), beside(undefined, 5)],
      0,
      10,
    );

    expect(placed).toEqual({ tops: [230, 200, 260], height: 265 });
  });

  it("returns a top of `0` for a group with no height, which takes no place", () => {
    const placed = placeMarginGroups(
      [beside(0, 0), beside(0), beside(5, 0, true)],
      0,
      10,
    );

    expect(placed).toEqual({ tops: [0, 0, 0], height: 20 });
  });

  it("returns the leading height as the height of a margin with no shown group", () => {
    expect(placeMarginGroups([], 40, 10)).toEqual({ tops: [], height: 40 });
  });
});
