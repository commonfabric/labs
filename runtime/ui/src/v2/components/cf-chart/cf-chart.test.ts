// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import {
  CFAreaMark,
  CFBarMark,
  CFChart,
  CFDotMark,
  CFLineMark,
  type ChartHoverDetail,
  type MarkConfig,
} from "./index.ts";

/**
 * A `ResizeObserver` whose observations the test delivers, since the
 * document does no layout.
 */
class TestResizeObserver implements ResizeObserver {
  static readonly instances: TestResizeObserver[] = [];

  readonly observed: Element[] = [];
  disconnected = false;

  #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  /** Reports each observed element as `width` pixels wide. */
  resize(width: number): void {
    this.#callback(
      this.observed.map((target) => ({
        target,
        contentRect: new DOMRect(0, 0, width, 0),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      })),
      this,
    );
  }
}

/** The width every chart here is given unless a test resizes it. */
const WIDTH = 216;

/**
 * Mounts `chart` with `children` as its light-DOM children, and reports its
 * container as {@link WIDTH} pixels wide. With the default height and
 * padding, that leaves a plot 200 pixels wide and 184 high.
 */
async function mountChart(
  chart: CFChart,
  children: readonly Element[] = [],
): Promise<{ chart: CFChart; observer: TestResizeObserver }> {
  for (const child of children) chart.append(child);
  await mount(chart);
  const observer = TestResizeObserver.instances.at(-1)!;
  observer.resize(WIDTH);
  await chart.updateComplete;
  return { chart, observer };
}

/** Builds a mark element of class `Mark` with the given properties. */
function mark<M extends CFLineMark | CFAreaMark | CFBarMark | CFDotMark>(
  Mark: new () => M,
  properties: Partial<Pick<M, "data" | "color" | "label" | "x" | "y">>,
): M {
  return Object.assign(new Mark(), properties);
}

const svgOf = (chart: CFChart) => chart.shadowRoot!.querySelector("svg")!;

const markGroupsOf = (chart: CFChart) => [
  ...chart.shadowRoot!.querySelectorAll("g.mark-group"),
];

/** The group the plot is drawn in, which sits inside the padding. */
const plotOf = (chart: CFChart) => chart.shadowRoot!.querySelector("svg > g")!;

const overlayOf = (chart: CFChart) =>
  chart.shadowRoot!.querySelector("rect.interaction-overlay")!;

const tooltipOf = (chart: CFChart) =>
  chart.shadowRoot!.querySelector<HTMLElement>(".tooltip")!;

const crosshairOf = (chart: CFChart) =>
  chart.shadowRoot!.querySelector(".crosshair line")!;

/**
 * Whether anything in `chart`'s shadow tree matches `selector`. A case
 * asserts on this rather than on the element, because a failed assertion
 * prints its operands, and printing an element walks its whole window.
 */
const has = (chart: CFChart, selector: string): boolean =>
  chart.shadowRoot!.querySelector(selector) !== null;

/** The `detail` of each `type` event `chart` emits from now on. */
function eventsFrom<T>(chart: CFChart, type: string): T[] {
  const seen: T[] = [];
  chart.addEventListener(type, (event) => {
    if (event instanceof CustomEvent) seen.push(event.detail);
  });
  return seen;
}

describe("cf-chart", () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    TestResizeObserver.instances.length = 0;
    globalThis.ResizeObserver = TestResizeObserver;
  });

  afterEach(() => {
    document.body.replaceChildren();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-chart")).toBe(CFChart);
  });

  describe("sizing", () => {
    it("renders a full-width SVG 200 pixels high until its container reports a width", async () => {
      const chart = await mount(new CFChart());
      expect(svgOf(chart).getAttribute("width")).toBe("100%");
      expect(svgOf(chart).getAttribute("height")).toBe("200");
      expect(svgOf(chart).getAttribute("viewBox")).toBe("0 0 1 200");
    });

    it("observes its container and renders the SVG at the width the container reports", async () => {
      const { chart, observer } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [1, 2] }),
      ]);
      expect(observer.observed.length).toBe(1);
      expect(
        observer.observed[0] ===
          chart.shadowRoot!.querySelector(".chart-container"),
      ).toBe(true);
      expect(svgOf(chart).getAttribute("width")).toBe("216");
      expect(svgOf(chart).getAttribute("viewBox")).toBe("0 0 216 200");

      observer.resize(316);
      await chart.updateComplete;
      expect(svgOf(chart).getAttribute("width")).toBe("316");
      expect(overlayOf(chart).getAttribute("width")).toBe("300");
    });

    it("renders no plot before its container reports a width", async () => {
      const chart = await mount(new CFChart());
      chart.append(mark(CFLineMark, { data: [1, 2, 3] }));
      await chart.updateComplete;
      expect(has(chart, "svg > g")).toBe(false);
    });

    it("renders the SVG and its container at the `height` it is given", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [1, 2] }),
      ]);
      chart.height = 100;
      await chart.updateComplete;
      expect(svgOf(chart).getAttribute("height")).toBe("100");
      expect(
        chart.shadowRoot!.querySelector<HTMLElement>(".chart-container")!
          .style.height,
      ).toBe("100px");
      expect(overlayOf(chart).getAttribute("height")).toBe("84");
    });

    it("disconnects its resize observer when it is removed", async () => {
      const { chart, observer } = await mountChart(new CFChart());
      expect(observer.disconnected).toBe(false);
      chart.remove();
      expect(observer.disconnected).toBe(true);
    });
  });

  describe("marks", () => {
    it("renders one group per child mark, in document order, in each mark's color", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFLineMark, { data: [1, 2, 3], color: "red" }),
        mark(CFBarMark, { data: [1, 2, 3], color: "blue" }),
        mark(CFAreaMark, { data: [1, 2, 3], color: "green" }),
        mark(CFDotMark, { data: [1, 2, 3], color: "black" }),
      ]);
      const groups = markGroupsOf(chart);
      expect(groups.map((g) => g.getAttribute("data-mark-index"))).toEqual([
        "0",
        "1",
        "2",
        "3",
      ]);
      expect(groups[0].querySelector("path")!.getAttribute("stroke")).toBe(
        "red",
      );
      expect(
        [...groups[1].querySelectorAll("rect")].map((r) =>
          r.getAttribute("fill")
        ),
      ).toEqual(["blue", "blue", "blue"]);
      expect(groups[2].querySelector("path")!.getAttribute("fill")).toBe(
        "green",
      );
      expect(
        [...groups[3].querySelectorAll("circle")].map((c) =>
          c.getAttribute("fill")
        ),
      ).toEqual(["black", "black", "black"]);
    });

    it("renders no group for a child that is not a mark", async () => {
      const { chart } = await mountChart(new CFChart(), [
        document.createElement("span"),
        mark(CFDotMark, { data: [1, 2] }),
      ]);
      expect(markGroupsOf(chart).length).toBe(1);
    });

    it("renders no plot when no mark has data", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [] }),
      ]);
      expect(has(chart, "svg > g")).toBe(false);
    });

    it("renders the marks in `marks` beneath its child marks", async () => {
      const chart = Object.assign(new CFChart(), {
        marks: [{ type: "dot", data: [1, 2], color: "orange" }],
      });
      await mountChart(chart, [
        mark(CFLineMark, { data: [1, 2], color: "red" }),
      ]);
      const groups = markGroupsOf(chart);
      expect(groups.length).toBe(2);
      expect(groups[0].querySelector("circle")!.getAttribute("fill")).toBe(
        "orange",
      );
      expect(groups[1].querySelector("path")!.getAttribute("stroke")).toBe(
        "red",
      );
    });

    it("renders the marks of a new `marks` array", async () => {
      const chart = Object.assign(new CFChart(), {
        marks: [{ type: "dot", data: [1, 2] }],
      });
      await mountChart(chart);
      chart.marks = [
        { type: "dot", data: [1, 2] },
        { type: "line", data: [3, 4] },
      ];
      await chart.updateComplete;
      expect(markGroupsOf(chart).length).toBe(2);
    });

    it("renders the marks a bound `marks` cell holds, and follows the cell", async () => {
      const cell = createMockCellHandle<MarkConfig[]>([
        { type: "dot", data: [1, 2, 3] },
      ]);
      const chart = Object.assign(new CFChart(), { marks: cell });
      await mountChart(chart);
      expect(chart.shadowRoot!.querySelectorAll("circle").length).toBe(3);

      pushUpdate(cell, [{ type: "dot", data: [1, 2, 3, 4, 5] }]);
      await chart.updateComplete;
      expect(chart.shadowRoot!.querySelectorAll("circle").length).toBe(5);
    });

    it("re-renders when a child mark's data changes", async () => {
      const dots = mark(CFDotMark, { data: [1, 2] });
      const { chart } = await mountChart(new CFChart(), [dots]);
      dots.data = [1, 2, 3, 4];
      await dots.updateComplete;
      await chart.updateComplete;
      expect(chart.shadowRoot!.querySelectorAll("circle").length).toBe(4);
    });

    it("stops re-rendering for its marks' changes once it is removed", async () => {
      const dots = mark(CFDotMark, { data: [1, 2] });
      const { chart } = await mountChart(new CFChart(), [dots]);
      chart.remove();
      dots.data = [1, 2, 3, 4];
      await dots.updateComplete;
      expect(chart.isUpdatePending).toBe(false);
      expect(chart.shadowRoot!.querySelectorAll("circle").length).toBe(2);
    });

    it("renders a mark added after its first render", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [1, 2] }),
      ]);
      chart.append(mark(CFLineMark, { data: [1, 2] }));
      await chart.updateComplete;
      expect(markGroupsOf(chart).length).toBe(2);
    });

    it("places points within `xDomain` and `yDomain` when given them", async () => {
      // The y scale extends a domain by 5% and rounds it outward, so a
      // `yDomain` of 0 to 190 spans 0 to 200.

      const chart = Object.assign(new CFChart(), {
        xDomain: [0, 2] as [number, number],
        yDomain: [0, 190] as [number, number],
      });
      await mountChart(chart, [mark(CFDotMark, { data: [50, 100] })]);
      expect(
        [...chart.shadowRoot!.querySelectorAll("circle")].map((c) => [
          c.getAttribute("cx"),
          c.getAttribute("cy"),
        ]),
      ).toEqual([["0", "138"], ["100", "92"]]);
    });
  });

  describe("padding", () => {
    it("insets the plot by 8 pixels on every side when it has no axes", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [1, 2] }),
      ]);
      expect(plotOf(chart).getAttribute("transform")).toBe("translate(8, 8)");
      expect(overlayOf(chart).getAttribute("width")).toBe("200");
      expect(overlayOf(chart).getAttribute("height")).toBe("184");
      expect(has(chart, ".axis")).toBe(false);
    });

    it("renders axes, and insets the plot to make room for them", async () => {
      const chart = Object.assign(new CFChart(), { xAxis: true, yAxis: true });
      await mountChart(chart, [mark(CFDotMark, { data: [1, 2] })]);
      expect(has(chart, ".x-axis")).toBe(true);
      expect(has(chart, ".y-axis")).toBe(true);
      expect(plotOf(chart).getAttribute("transform")).toBe("translate(48, 8)");
      expect(overlayOf(chart).getAttribute("width")).toBe("160");
      expect(overlayOf(chart).getAttribute("height")).toBe("164");
    });

    it("renders axis labels, and insets the plot further to make room for them", async () => {
      const chart = Object.assign(new CFChart(), {
        xAxis: { label: "Day" },
        yAxis: { label: "Count" },
      });
      await mountChart(chart, [mark(CFDotMark, { data: [1, 2] })]);
      expect(
        [...chart.shadowRoot!.querySelectorAll(".axis-label")].map((l) =>
          l.textContent
        ),
      ).toEqual(["Day", "Count"]);
      expect(plotOf(chart).getAttribute("transform")).toBe("translate(56, 8)");
      expect(overlayOf(chart).getAttribute("width")).toBe("152");
      expect(overlayOf(chart).getAttribute("height")).toBe("152");
    });

    it("insets the plot by a numeric `padding` on every side", async () => {
      const chart = Object.assign(new CFChart(), { padding: 20, xAxis: true });
      await mountChart(chart, [mark(CFDotMark, { data: [1, 2] })]);
      expect(plotOf(chart).getAttribute("transform")).toBe(
        "translate(20, 20)",
      );
      expect(overlayOf(chart).getAttribute("width")).toBe("176");
      expect(overlayOf(chart).getAttribute("height")).toBe("160");
    });

    it("reads a `padding` array as top, right, bottom, and left", async () => {
      const chart = Object.assign(new CFChart(), {
        padding: [1, 2, 3, 4] as [number, number, number, number],
      });
      await mountChart(chart, [mark(CFDotMark, { data: [1, 2] })]);
      expect(plotOf(chart).getAttribute("transform")).toBe("translate(4, 1)");
      expect(overlayOf(chart).getAttribute("width")).toBe("210");
      expect(overlayOf(chart).getAttribute("height")).toBe("196");
    });
  });

  describe("pointer interaction", () => {
    // The document does no layout, so the overlay's bounding box sits at the
    // origin and a pointer's client coordinates are its plot coordinates.

    async function salesChart(chart = new CFChart()) {
      return (await mountChart(chart, [
        mark(CFLineMark, { data: [10, 20, 30], label: "Sales" }),
      ])).chart;
    }

    it("emits cf-hover with the datum nearest the pointer", async () => {
      const chart = await salesChart();
      const hovers = eventsFrom<ChartHoverDetail>(chart, "cf-hover");
      overlayOf(chart).dispatchEvent(
        new MouseEvent("mousemove", { clientX: 110, clientY: 46 }),
      );
      expect(hovers.length).toBe(1);
      expect(hovers[0].x).toBe(110);
      expect(hovers[0].y).toBe(46);
      expect(hovers[0].nearest).toEqual({
        datum: 20,
        index: 1,
        label: "Sales",
      });
    });

    it("shows a crosshair and a tooltip at the hovered datum", async () => {
      const chart = await salesChart();
      expect(has(chart, ".crosshair")).toBe(false);
      expect(has(chart, ".tooltip")).toBe(false);

      overlayOf(chart).dispatchEvent(
        new MouseEvent("mousemove", { clientX: 110 }),
      );
      await chart.updateComplete;
      expect(crosshairOf(chart).getAttribute("x1")).toBe("100");
      const tooltip = tooltipOf(chart);
      expect(tooltip.textContent!.replace(/\s+/g, " ").trim()).toBe(
        "Sales: 20",
      );
      expect(tooltip.style.left).toBe("108px");
    });

    it("shows a fractional value to two decimal places, with no label for an unlabeled mark", async () => {
      const { chart } = await mountChart(new CFChart(), [
        mark(CFDotMark, { data: [1.2345, 2] }),
      ]);
      overlayOf(chart).dispatchEvent(
        new MouseEvent("mousemove", { clientX: 0 }),
      );
      await chart.updateComplete;
      expect(tooltipOf(chart).textContent!.trim()).toBe("1.23");
      expect(has(chart, ".tooltip-label")).toBe(false);
    });

    it("shows no crosshair or tooltip when `crosshair` is off", async () => {
      const chart = await salesChart(
        Object.assign(new CFChart(), { crosshair: false }),
      );
      const hovers = eventsFrom<ChartHoverDetail>(chart, "cf-hover");
      overlayOf(chart).dispatchEvent(
        new MouseEvent("mousemove", { clientX: 110 }),
      );
      await chart.updateComplete;
      expect(hovers.length).toBe(1);
      expect(has(chart, ".crosshair")).toBe(false);
      expect(has(chart, ".tooltip")).toBe(false);
    });

    it("emits cf-click with the datum nearest the pointer", async () => {
      const chart = await salesChart();
      const clicks = eventsFrom<ChartHoverDetail>(chart, "cf-click");
      overlayOf(chart).dispatchEvent(
        new MouseEvent("click", { clientX: 190, clientY: 10 }),
      );
      expect(clicks.length).toBe(1);
      expect(clicks[0].nearest).toEqual({
        datum: 30,
        index: 2,
        label: "Sales",
      });
      await chart.updateComplete;
      expect(has(chart, ".tooltip")).toBe(false);
    });

    it("hides the crosshair and tooltip and emits cf-leave when the pointer leaves", async () => {
      const chart = await salesChart();
      const leaves = eventsFrom<unknown>(chart, "cf-leave");
      overlayOf(chart).dispatchEvent(
        new MouseEvent("mousemove", { clientX: 110 }),
      );
      await chart.updateComplete;
      expect(leaves).toEqual([]);

      overlayOf(chart).dispatchEvent(new MouseEvent("mouseleave"));
      await chart.updateComplete;
      expect(leaves).toEqual([{}]);
      expect(has(chart, ".crosshair")).toBe(false);
      expect(has(chart, ".tooltip")).toBe(false);
    });
  });
});
