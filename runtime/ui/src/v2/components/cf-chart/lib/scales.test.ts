// First, so that the document it installs is there when Lit loads.
import { mount } from "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
// @ts-types="@types/d3-scale"
import { scaleBand, scaleLinear, scaleTime } from "d3-scale";
import { CFBarMark } from "../index.ts";
import type { MarkConfig } from "../types.ts";
import {
  collectAllMarkData,
  type CollectedMarkData,
  createScales,
  detectXScaleType,
  extractDataPoints,
  xPosition,
} from "./scales.ts";

const padding = { top: 10, right: 20, bottom: 30, left: 40 };

/** One line mark collected from `data`. */
function marksOf(data: number[] | Record<string, unknown>[]) {
  return collectAllMarkData([{ type: "line", data, x: "x", y: "y" }], []);
}

function xy(...pairs: [unknown, number][]): Record<string, unknown>[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

describe("scales", () => {
  describe("xPosition()", () => {
    it("returns the pixel a number maps to on a linear scale", () => {
      const scale = scaleLinear().domain([0, 10]).range([0, 100]);
      expect(xPosition(scale, 5)).toBe(50);
      expect(xPosition(scale, "7")).toBe(70);
    });

    it("returns the pixel a date maps to on a time scale", () => {
      const scale = scaleTime()
        .domain([new Date(2024, 0, 1), new Date(2024, 0, 3)])
        .range([0, 100]);
      expect(xPosition(scale, new Date(2024, 0, 2))).toBe(50);
    });

    it("returns the center of a category's band on a band scale", () => {
      const scale = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      expect(xPosition(scale, "b")).toBe(75);
    });

    it("returns half a band for a category the band scale lacks", () => {
      const scale = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      expect(xPosition(scale, "z")).toBe(25);
    });
  });

  describe("extractDataPoints()", () => {
    it("returns a number array's values with their indexes as x", () => {
      expect(extractDataPoints([3, 7])).toEqual([
        { x: 0, y: 3, datum: 3, index: 0 },
        { x: 1, y: 7, datum: 7, index: 1 },
      ]);
    });

    it("returns no points for no data", () => {
      expect(extractDataPoints([])).toEqual([]);
    });

    it("returns the keyed fields of records, with numeric strings as numbers", () => {
      const datum = { day: "mon", n: "4" };
      expect(extractDataPoints([datum], "day", "n")).toEqual([
        { x: "mon", y: 4, datum, index: 0 },
      ]);
    });

    it("returns `value`, then `y`, then zero as y and the index as x when no keys are given", () => {
      const points = extractDataPoints([{ value: 4, y: 9 }, { y: 5 }, {}]);
      expect(points.map((p) => [p.x, p.y])).toEqual([[0, 4], [1, 5], [2, 0]]);
    });

    it("returns zero for a y that is not a number", () => {
      expect(extractDataPoints([{ y: "many" }])[0].y).toBe(0);
    });

    it("returns ISO date strings as dates and keeps other strings and dates", () => {
      const date = new Date(2024, 4, 6);
      const xs = extractDataPoints(
        [
          { t: "2024-05-06" },
          { t: "2024-05-06T12:00:00Z" },
          { t: "2024-13-45" },
          { t: "May 6" },
          { t: date },
        ],
        "t",
      ).map((p) => p.x);
      expect(xs[0]).toEqual(new Date("2024-05-06"));
      expect(xs[1]).toEqual(new Date("2024-05-06T12:00:00Z"));
      expect(xs[2]).toBe("2024-13-45");
      expect(xs[3]).toBe("May 6");
      expect(xs[4]).toBe(date);
    });
  });

  describe("detectXScaleType()", () => {
    const at = (x: unknown) => [{ x, y: 0, datum: null, index: 0 }];

    it("returns the forced type whatever the data", () => {
      expect(detectXScaleType(at("a"), "linear")).toBe("linear");
    });

    it("returns the type the first x value implies", () => {
      expect(detectXScaleType(at(new Date()))).toBe("time");
      expect(detectXScaleType(at("a"))).toBe("band");
      expect(detectXScaleType(at(3))).toBe("linear");
    });

    it("returns `linear` for no points", () => {
      expect(detectXScaleType([])).toBe("linear");
    });
  });

  describe("collectAllMarkData()", () => {
    afterEach(() => document.body.replaceChildren());

    it("returns the configured marks and then the child mark elements, indexed in that order", async () => {
      const config: MarkConfig[] = [
        { type: "line", data: [1, 2], color: "red", label: "Line" },
        { type: "dot", data: [{ a: 1, b: 5 }], x: "a", y: "b" },
      ];
      const bar = Object.assign(new CFBarMark(), {
        data: [{ k: "x", v: 3 }],
        color: "blue",
        label: "Bars",
      });
      bar.setAttribute("x", "k");
      bar.setAttribute("y", "v");
      await mount(bar);

      const collected = collectAllMarkData(config, [bar]);
      expect(collected.map((m) => [m.markIndex, m.type, m.color, m.label]))
        .toEqual([
          [0, "line", "red", "Line"],
          [1, "dot", undefined, undefined],
          [2, "bar", "blue", "Bars"],
        ]);
      expect(collected.map((m) => m.points.map((p) => [p.x, p.y]))).toEqual([
        [[0, 1], [1, 2]],
        [[1, 5]],
        [["x", 3]],
      ]);
    });

    it("returns no points for a mark element without data", () => {
      expect(collectAllMarkData([], [new CFBarMark()])[0].points).toEqual([]);
    });
  });

  describe("createScales()", () => {
    it("maps a linear x domain across the plot width and y from zero up the plot height", () => {
      const { xScale, yScale, xType } = createScales(
        marksOf(xy([0, 20], [10, 100])),
        240,
        140,
        padding,
      );
      expect(xType).toBe("linear");
      expect(xScale.domain()).toEqual([0, 10]);
      expect(xScale.range()).toEqual([0, 180]);
      expect(yScale.domain()).toEqual([0, 110]);
      expect(yScale.range()).toEqual([100, 0]);
    });

    it("extends the y domain below zero for negative values", () => {
      const { yScale } = createScales(
        marksOf(xy([0, -40], [1, 20])),
        240,
        140,
        padding,
      );
      expect(yScale.domain()).toEqual([-40, 25]);
    });

    it("gives a flat series a y domain one above its value", () => {
      const { yScale } = createScales(
        marksOf(xy([0, 3], [1, 3])),
        240,
        140,
        padding,
      );
      expect(yScale.domain()).toEqual([0, 4]);
    });

    it("uses the given x and y domains in place of the data's", () => {
      const { xScale, yScale } = createScales(
        marksOf(xy([0, 3], [1, 5])),
        240,
        140,
        padding,
        { xDomain: ["2", 8], yDomain: [0, 20] },
      );
      expect(xScale.domain()).toEqual([2, 8]);
      expect(yScale.domain()).toEqual([0, 22]);
    });

    it("returns unit domains when there are no points", () => {
      const { xScale, yScale } = createScales([], 240, 140, padding);
      expect(xScale.domain()).toEqual([0, 1]);
      expect(yScale.domain()).toEqual([0, 1.1]);
    });

    it("returns a log y scale whose domain starts above zero", () => {
      const options = { yType: "log" as const };
      const positive = createScales(
        marksOf(xy([0, 1], [1, 1000])),
        240,
        140,
        padding,
        options,
      );
      expect(positive.yScale.domain()).toEqual([1, 10000]);
      const withZero = createScales(
        marksOf(xy([0, 0], [1, 100])),
        240,
        140,
        padding,
        options,
      );
      expect(withZero.yScale.domain()).toEqual([0.001, 1000]);
    });

    describe("time x scales", () => {
      it("spans the dates in the data", () => {
        const { xScale, xType } = createScales(
          marksOf(xy(["2024-01-01", 1], ["2024-01-05", 2])),
          240,
          140,
          padding,
        );
        expect(xType).toBe("time");
        expect(xScale.domain()).toEqual([
          new Date("2024-01-01"),
          new Date("2024-01-05"),
        ]);
      });

      it("reads numbers as timestamps when the type is forced", () => {
        const { xScale } = createScales(
          marksOf(xy([0, 1], [86400000, 2])),
          240,
          140,
          padding,
          { xType: "time" },
        );
        expect(xScale.domain()).toEqual([new Date(0), new Date(86400000)]);
      });

      it("spans the given x domain in place of the data's", () => {
        const { xScale } = createScales(
          marksOf(xy(["2024-01-01", 1])),
          240,
          140,
          padding,
          { xDomain: ["2023-06-01", "2023-07-01"] },
        );
        expect(xScale.domain()).toEqual([
          new Date("2023-06-01"),
          new Date("2023-07-01"),
        ]);
      });

      it("spans the present moment when there are no points", () => {
        using time = new FakeTime(new Date("2024-03-03T00:00:00Z"));
        const { xScale } = createScales([], 240, 140, padding, {
          xType: "time",
        });
        expect(xScale.domain()).toEqual([
          new Date(time.now),
          new Date(time.now),
        ]);
      });
    });

    describe("band x scales", () => {
      const categories: CollectedMarkData[] = marksOf(
        xy(["a", 1], ["b", 2], ["c", 3], ["a", 4], ["d", 5]),
      );

      it("lists each category once in first-seen order, with padding between bands", () => {
        const { xScale, xType } = createScales(categories, 240, 140, padding);
        expect(xType).toBe("band");
        expect(xScale.domain()).toEqual(["a", "b", "c", "d"]);
        expect("bandwidth" in xScale && xScale.padding()).toBe(0.2);
      });

      it("keeps the categories between two given ones, in either order", () => {
        const range = (xDomain: [unknown, unknown]) =>
          createScales(categories, 240, 140, padding, { xDomain }).xScale
            .domain();
        expect(range(["b", "d"])).toEqual(["b", "c", "d"]);
        expect(range(["c", "a"])).toEqual(["a", "b", "c"]);
      });

      it("uses the given domain as the categories when either is not in the data", () => {
        const { xScale } = createScales(categories, 240, 140, padding, {
          xDomain: ["a", "z"],
        });
        expect(xScale.domain()).toEqual(["a", "z"]);
      });
    });
  });
});
