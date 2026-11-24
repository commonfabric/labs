// First, so that the document it installs is there when Lit loads.
import "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { render } from "lit";
// @ts-types="@types/d3-scale"
import { scaleBand, scaleLinear, scaleTime } from "d3-scale";
import type { DataPoint } from "../types.ts";
import type { CollectedMarkData } from "./scales.ts";
import {
  computeEventDetail,
  findNearest,
  renderCrosshair,
} from "./interaction.ts";

function mark(
  markIndex: number,
  label: string | undefined,
  ...pairs: [unknown, number][]
): CollectedMarkData {
  const points: DataPoint[] = pairs.map(([x, y], index) => ({
    x,
    y,
    datum: { x, y },
    index,
  }));
  return { points, markIndex, type: "line", label };
}

const xScale = scaleLinear().domain([0, 10]).range([0, 100]);
const yScale = scaleLinear().domain([0, 10]).range([100, 0]);
const marks = [
  mark(0, "first", [0, 1], [4, 2], [8, 3]),
  mark(1, "second", [5, 5]),
];

describe("interaction", () => {
  describe("findNearest()", () => {
    it("returns the point across all marks horizontally closest to the pixel", () => {
      expect(findNearest(52, marks, xScale, yScale)).toEqual({
        datum: { x: 5, y: 5 },
        index: 0,
        label: "second",
        point: marks[1].points[0],
        markIndex: 1,
        pixelX: 50,
        pixelY: 50,
      });
      expect(findNearest(78, marks, xScale, yScale)?.datum).toEqual({
        x: 8,
        y: 3,
      });
    });

    it("returns the earlier point when two are equally close", () => {
      expect(findNearest(45, marks, xScale, yScale)?.datum).toEqual({
        x: 4,
        y: 2,
      });
    });

    it("measures a band scale's points from the centers of their bands", () => {
      const band = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      const nearest = findNearest(
        70,
        [mark(0, undefined, ["a", 1], ["b", 2])],
        band,
        yScale,
      );
      expect(nearest?.pixelX).toBe(75);
      expect(nearest?.index).toBe(1);
      expect(nearest?.label).toBeUndefined();
    });

    it("returns `null` when there are no points", () => {
      expect(findNearest(10, [], xScale, yScale)).toBeNull();
      expect(findNearest(10, [mark(0, "empty")], xScale, yScale)).toBeNull();
    });
  });

  describe("computeEventDetail()", () => {
    it("reports the pixel, its data coordinates, and the nearest point", () => {
      const { detail, nearest } = computeEventDetail(
        25,
        40,
        marks,
        xScale,
        yScale,
        "linear",
      );
      expect(detail).toEqual({
        x: 25,
        y: 40,
        dataX: 2.5,
        dataY: 6,
        nearest: { datum: { x: 4, y: 2 }, index: 1, label: "first" },
      });
      expect(nearest?.pixelX).toBe(40);
    });

    it("reports the data x of a time scale as a date", () => {
      const time = scaleTime()
        .domain([new Date(2024, 0, 1), new Date(2024, 0, 3)])
        .range([0, 100]);
      const { detail } = computeEventDetail(50, 0, [], time, yScale, "time");
      expect(detail.dataX).toEqual(new Date(2024, 0, 2));
    });

    it("reports the pixel itself as the data x of a band scale", () => {
      const band = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      const { detail } = computeEventDetail(30, 0, [], band, yScale, "band");
      expect(detail.dataX).toBe(30);
    });

    it("reports no nearest point when there are no points", () => {
      const { detail, nearest } = computeEventDetail(
        30,
        0,
        [],
        xScale,
        yScale,
        "linear",
      );
      expect(detail.nearest).toBeNull();
      expect(nearest).toBeNull();
    });
  });

  describe("renderCrosshair()", () => {
    it("draws a vertical line at the pixel down the height of the plot", () => {
      const root = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      render(renderCrosshair(30, 80), root);
      const line = root.querySelector("g.crosshair > line")!;
      expect([
        line.getAttribute("x1"),
        line.getAttribute("y1"),
        line.getAttribute("x2"),
        line.getAttribute("y2"),
      ]).toEqual(["30", "0", "30", "80"]);
    });
  });
});
