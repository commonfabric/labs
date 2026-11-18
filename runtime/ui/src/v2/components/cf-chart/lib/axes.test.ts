// First, so that the document it installs is there when Lit loads.
import "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { render, type TemplateResult } from "lit";
// @ts-types="@types/d3-scale"
import { scaleBand, scaleLinear, scaleTime } from "d3-scale";
import { renderXAxis, renderYAxis } from "./axes.ts";

/** Renders an SVG template into an `<svg>` element and returns the element. */
function renderSvg(template: TemplateResult): SVGSVGElement {
  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  render(template, root);
  return root;
}

/** The text of each tick label under `root`, in order. */
function tickLabels(root: Element): (string | null)[] {
  return [...root.querySelectorAll("g > g > text")].map((t) => t.textContent);
}

/** The `translate()` offset of each tick under `root`, in order. */
function tickTransforms(root: Element): (string | null)[] {
  return [...root.querySelectorAll("g > g")].map((g) =>
    g.getAttribute("transform")
  );
}

describe("axes", () => {
  describe("renderXAxis()", () => {
    const linear = scaleLinear().domain([0, 10]).range([0, 100]);

    it("draws an axis line along the bottom of the plot with a tick at each nice value", () => {
      const root = renderSvg(renderXAxis(linear, "linear", 100, 50));
      const axis = root.querySelector("g.x-axis")!;
      expect(axis.getAttribute("transform")).toBe("translate(0, 50)");
      expect(axis.querySelector(":scope > line")!.getAttribute("x2"))
        .toBe("100");
      expect(tickLabels(root)).toEqual(["0", "2", "4", "6", "8", "10"]);
      expect(tickTransforms(root)[1]).toBe("translate(20, 0)");
    });

    it("draws no grid lines or axis label unless configured", () => {
      const root = renderSvg(renderXAxis(linear, "linear", 100, 50));
      expect(root.querySelectorAll(".grid-line").length).toBe(0);
      expect(root.querySelector(".axis-label")).toBeNull();
    });

    it("draws a grid line up the plot at each tick and the configured label", () => {
      const root = renderSvg(
        renderXAxis(linear, "linear", 100, 50, { grid: true, label: "Day" }),
      );
      const grid = [...root.querySelectorAll(".grid-line")];
      expect(grid.map((l) => l.getAttribute("x1"))).toEqual([
        "0",
        "20",
        "40",
        "60",
        "80",
        "100",
      ]);
      expect(grid[0].getAttribute("y1")).toBe("-50");
      expect(grid[0].getAttribute("y2")).toBe("0");
      const label = root.querySelector(".axis-label")!;
      expect(label.textContent).toBe("Day");
      expect(label.getAttribute("x")).toBe("50");
    });

    it("labels ticks with a configured format function", () => {
      const root = renderSvg(
        renderXAxis(linear, "linear", 100, 50, {
          tickFormat: (v) => `#${v}`,
          tickCount: 2,
        }),
      );
      expect(tickLabels(root)).toEqual(["#0", "#5", "#10"]);
    });

    it("abbreviates thousands and millions and gives fractions one decimal place", () => {
      const labels = (domain: [number, number]) =>
        tickLabels(
          renderSvg(
            renderXAxis(
              scaleLinear().domain(domain).range([0, 100]),
              "linear",
              100,
              50,
              { tickCount: 2 },
            ),
          ),
        );
      expect(labels([0, 2000])).toEqual(["0", "1.0k", "2.0k"]);
      expect(labels([0, 4000000])).toEqual(["0", "2.0M", "4.0M"]);
      expect(labels([0, 1])).toEqual(["0", "0.5", "1"]);
    });

    it("labels dates on a time scale as month and day", () => {
      const time = scaleTime()
        .domain([new Date(2024, 0, 1), new Date(2024, 0, 7)])
        .range([0, 60]);
      const root = renderSvg(renderXAxis(time, "time", 60, 50));
      expect(tickLabels(root)).toEqual([
        "1/1",
        "1/2",
        "1/3",
        "1/4",
        "1/5",
        "1/6",
        "1/7",
      ]);
      expect(tickTransforms(root)[1]).toBe("translate(10, 0)");
    });

    it("labels every category of a band scale at the center of its band", () => {
      const band = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      const root = renderSvg(renderXAxis(band, "band", 100, 50));
      expect(tickLabels(root)).toEqual(["a", "b"]);
      expect(tickTransforms(root)).toEqual([
        "translate(25, 0)",
        "translate(75, 0)",
      ]);
    });

    it("labels an evenly spaced subset of categories when there are more than the tick count", () => {
      const band = scaleBand<string>()
        .domain(["a", "b", "c", "d", "e", "f", "g"])
        .range([0, 70]);
      const root = renderSvg(
        renderXAxis(band, "band", 70, 50, { tickCount: 3 }),
      );
      expect(tickLabels(root)).toEqual(["a", "d", "g"]);
    });
  });

  describe("renderYAxis()", () => {
    const linear = scaleLinear().domain([0, 100]).range([50, 0]);

    it("draws an axis line up the left of the plot with five ticks by default", () => {
      const root = renderSvg(renderYAxis(linear, 200, 50));
      const axis = root.querySelector("g.y-axis")!;
      expect(axis.querySelector(":scope > line")!.getAttribute("y2"))
        .toBe("50");
      expect(tickLabels(root)).toEqual(["0", "20", "40", "60", "80", "100"]);
      expect(tickTransforms(root)[0]).toBe("translate(0, 50)");
      expect(root.querySelectorAll(".grid-line").length).toBe(0);
      expect(root.querySelector(".axis-label")).toBeNull();
    });

    it("draws a grid line across the plot at each tick and the configured label rotated", () => {
      const root = renderSvg(
        renderYAxis(linear, 200, 50, {
          grid: true,
          label: "Count",
          tickCount: 2,
        }),
      );
      const grid = [...root.querySelectorAll(".grid-line")];
      expect(grid.map((l) => l.getAttribute("y1"))).toEqual(["50", "25", "0"]);
      expect(grid[0].getAttribute("x2")).toBe("200");
      const label = root.querySelector(".axis-label")!;
      expect(label.textContent).toBe("Count");
      expect(label.getAttribute("transform")).toBe("rotate(-90)");
      expect(label.getAttribute("x")).toBe("-25");
    });

    it("draws at most ten ticks whatever the tick count", () => {
      const root = renderSvg(renderYAxis(linear, 200, 50, { tickCount: 50 }));
      expect(tickLabels(root)).toEqual([
        "0",
        "10",
        "20",
        "30",
        "40",
        "50",
        "60",
        "70",
        "80",
        "90",
        "100",
      ]);
    });

    it("abbreviates thousands and millions, negative ones included, and gives fractions one decimal place", () => {
      const labels = (domain: [number, number], tickFormat?: () => string) =>
        tickLabels(
          renderSvg(
            renderYAxis(scaleLinear().domain(domain).range([50, 0]), 200, 50, {
              tickCount: 2,
              tickFormat,
            }),
          ),
        );
      expect(labels([-2000, 2000])).toEqual(["-2.0k", "0", "2.0k"]);
      expect(labels([0, 4000000])).toEqual(["0", "2.0M", "4.0M"]);
      expect(labels([0, 1])).toEqual(["0", "0.5", "1"]);
      expect(labels([0, 1], () => "y")).toEqual(["y", "y", "y"]);
    });
  });
});
