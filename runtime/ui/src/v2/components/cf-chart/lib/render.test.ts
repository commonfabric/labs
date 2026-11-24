// First, so that the document it installs is there when Lit loads.
import { mount } from "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { render, type TemplateResult } from "lit";
// @ts-types="@types/d3-scale"
import { scaleBand, scaleLinear } from "d3-scale";
import { CFLineMark } from "../index.ts";
import type { DataPoint } from "../types.ts";
import {
  renderArea,
  renderBars,
  renderDots,
  renderLine,
  renderMark,
} from "./render.ts";

/** Renders an SVG template into an `<svg>` element and returns the element. */
function renderSvg(template: TemplateResult): SVGSVGElement {
  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  render(template, root);
  return root;
}

function points(...pairs: [unknown, number][]): DataPoint[] {
  return pairs.map(([x, y], index) => ({ x, y, datum: y, index }));
}

const xScale = scaleLinear().domain([0, 10]).range([0, 100]);
const yScale = scaleLinear().domain([0, 10]).range([100, 0]);
const diagonal = points([0, 0], [10, 10]);

describe("render", () => {
  describe("renderLine()", () => {
    it("draws a path through the points in the default color and width", () => {
      const path = renderSvg(renderLine(diagonal, xScale, yScale))
        .querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L100,0");
      expect(path.getAttribute("fill")).toBe("none");
      expect(path.getAttribute("stroke")).toBe("#6366f1");
      expect(path.getAttribute("stroke-width")).toBe("2");
    });

    it("draws the path with the configured color, width, and curve", () => {
      const path = renderSvg(
        renderLine(diagonal, xScale, yScale, {
          color: "red",
          strokeWidth: 4,
          curve: "step",
        }),
      ).querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L50,100L50,0L100,0");
      expect(path.getAttribute("stroke")).toBe("red");
      expect(path.getAttribute("stroke-width")).toBe("4");
    });

    it("draws nothing for no points", () => {
      expect(renderSvg(renderLine([], xScale, yScale)).childElementCount)
        .toBe(0);
    });
  });

  describe("renderArea()", () => {
    it("fills down to the bottom of the plot by default", () => {
      const path = renderSvg(renderArea(diagonal, xScale, yScale, 100))
        .querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L100,0L100,100L0,100Z");
      expect(path.getAttribute("fill")).toBe("#6366f1");
      expect(path.getAttribute("fill-opacity")).toBe("0.2");
      expect(path.getAttribute("stroke")).toBe("none");
    });

    it("fills down to a numeric `y2` with the configured color and opacity", () => {
      const path = renderSvg(
        renderArea(diagonal, xScale, yScale, 100, {
          color: "green",
          opacity: 0.5,
          y2: 5,
        }),
      ).querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L100,0L100,50L0,50Z");
      expect(path.getAttribute("fill")).toBe("green");
      expect(path.getAttribute("fill-opacity")).toBe("0.5");
    });

    it("ignores a `y2` that is not a number", () => {
      const path = renderSvg(
        renderArea(diagonal, xScale, yScale, 100, { y2: "5" }),
      ).querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L100,0L100,100L0,100Z");
    });

    it("draws nothing for no points", () => {
      expect(renderSvg(renderArea([], xScale, yScale, 100)).childElementCount)
        .toBe(0);
    });
  });

  describe("renderBars()", () => {
    it("draws each bar on a band scale across its band, from zero to the value", () => {
      const band = scaleBand<string>().domain(["a", "b"]).range([0, 100]);
      const rects = renderSvg(
        renderBars(points(["a", 4], ["b", 10]), band, yScale),
      ).querySelectorAll("rect");
      expect([...rects].map((r) => r.getAttribute("x"))).toEqual(["0", "50"]);
      expect([...rects].map((r) => r.getAttribute("width"))).toEqual([
        "50",
        "50",
      ]);
      expect([...rects].map((r) => r.getAttribute("y"))).toEqual(["60", "0"]);
      expect([...rects].map((r) => r.getAttribute("height"))).toEqual([
        "40",
        "100",
      ]);
      expect(rects[0].getAttribute("fill")).toBe("#6366f1");
      expect(rects[0].getAttribute("fill-opacity")).toBe("1");
    });

    it("sizes bars on a continuous scale to the spacing between points less the padding", () => {
      const rects = renderSvg(
        renderBars(points([0, 5], [5, 5], [10, 5]), xScale, yScale, {
          color: "blue",
          opacity: 0.7,
        }),
      ).querySelectorAll("rect");
      expect([...rects].map((r) => r.getAttribute("x"))).toEqual([
        "-20",
        "30",
        "80",
      ]);
      expect(rects[1].getAttribute("width")).toBe("40");
      expect(rects[1].getAttribute("fill")).toBe("blue");
      expect(rects[1].getAttribute("fill-opacity")).toBe("0.7");
    });

    it("applies the configured bar padding", () => {
      const rect = renderSvg(
        renderBars(points([0, 5], [10, 5]), xScale, yScale, {
          barPadding: 0.5,
        }),
      ).querySelector("rect")!;
      expect(rect.getAttribute("width")).toBe("50");
    });

    it("draws a lone bar on a continuous scale 20 wide", () => {
      const rect = renderSvg(renderBars(points([5, 5]), xScale, yScale))
        .querySelector("rect")!;
      expect(rect.getAttribute("x")).toBe("40");
      expect(rect.getAttribute("width")).toBe("20");
    });

    it("draws a negative value downward from zero", () => {
      const signed = scaleLinear().domain([-10, 10]).range([100, 0]);
      const rect = renderSvg(renderBars(points([5, -5]), xScale, signed))
        .querySelector("rect")!;
      expect(rect.getAttribute("y")).toBe("50");
      expect(rect.getAttribute("height")).toBe("25");
    });

    it("keeps a zero value visible as a bar half a pixel tall", () => {
      const rect = renderSvg(renderBars(points([5, 0]), xScale, yScale))
        .querySelector("rect")!;
      expect(rect.getAttribute("height")).toBe("0.5");
    });

    it("draws nothing for no points", () => {
      expect(renderSvg(renderBars([], xScale, yScale)).childElementCount)
        .toBe(0);
    });
  });

  describe("renderDots()", () => {
    it("draws a circle at each point with the default radius and color", () => {
      const circles = renderSvg(
        renderDots(points([2, 3], [8, 6]), xScale, yScale),
      ).querySelectorAll("circle");
      expect([...circles].map((c) => [
        c.getAttribute("cx"),
        c.getAttribute("cy"),
        c.getAttribute("r"),
        c.getAttribute("fill"),
      ])).toEqual([
        ["20", "70", "3", "#6366f1"],
        ["80", "40", "3", "#6366f1"],
      ]);
    });

    it("draws circles with the configured radius and color", () => {
      const circle = renderSvg(
        renderDots(points([2, 3]), xScale, yScale, { radius: 6, color: "red" }),
      ).querySelector("circle")!;
      expect(circle.getAttribute("r")).toBe("6");
      expect(circle.getAttribute("fill")).toBe("red");
    });

    it("draws nothing for no points", () => {
      expect(renderSvg(renderDots([], xScale, yScale)).childElementCount)
        .toBe(0);
    });
  });

  describe("renderMark()", () => {
    afterEach(() => document.body.replaceChildren());

    it("draws the shape that the mark type names", () => {
      const drawn = (type: string) => {
        const root = renderSvg(
          renderMark(type, diagonal, xScale, yScale, 100, { color: "red" }),
        );
        return [...root.children].map((child) => [
          child.tagName.toLowerCase(),
          child.getAttribute(
            child.getAttribute("fill") === "none" ? "stroke" : "fill",
          ),
        ]);
      };
      expect(drawn("line")).toEqual([["path", "red"]]);
      expect(drawn("area")).toEqual([["path", "red"]]);
      expect(drawn("bar")).toEqual([["rect", "red"], ["rect", "red"]]);
      expect(drawn("dot")).toEqual([["circle", "red"], ["circle", "red"]]);
    });

    it("draws nothing for an unknown mark type", () => {
      expect(
        renderSvg(renderMark("pie", diagonal, xScale, yScale, 100, {}))
          .childElementCount,
      ).toBe(0);
    });

    it("draws a mark element's styling, with a linear curve for an unknown curve name", async () => {
      const mark = new CFLineMark();
      mark.setAttribute("color", "purple");
      mark.setAttribute("stroke-width", "3");
      mark.setAttribute("curve", "wiggly");
      await mount(mark);
      const path = renderSvg(
        renderMark("line", diagonal, xScale, yScale, 100, mark),
      ).querySelector("path")!;
      expect(path.getAttribute("d")).toBe("M0,100L100,0");
      expect(path.getAttribute("stroke")).toBe("purple");
    });
  });
});
