// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFResizableHandle } from "../cf-resizable-handle/index.ts";
import { CFResizablePanel } from "../cf-resizable-panel/index.ts";
import type { PanelGroupDirection } from "./cf-resizable-panel-group.ts";
import { CFResizablePanelGroup } from "./index.ts";

/** A `ResizeObserver` that reports a size only when a test calls `report()`,
 * as the document has no layout to measure. */
class ReportingResizeObserver implements ResizeObserver {
  /** The observer watching each element. */
  static readonly watching = new Map<Element, ReportingResizeObserver>();

  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    ReportingResizeObserver.watching.set(target, this);
  }

  unobserve(target: Element): void {
    ReportingResizeObserver.watching.delete(target);
  }

  disconnect(): void {
    for (const [target, observer] of ReportingResizeObserver.watching) {
      if (observer === this) ReportingResizeObserver.watching.delete(target);
    }
  }

  report(entries: ResizeObserverEntry[]): void {
    this.#callback(entries, this);
  }
}

globalThis.ResizeObserver = ReportingResizeObserver;

/** Reports `width` as the group's width to whatever observes it, and resolves
 * once the group has updated. */
async function measure(
  group: CFResizablePanelGroup,
  width: number,
): Promise<void> {
  const observer = ReportingResizeObserver.watching.get(group);
  if (!observer) throw new Error("Nothing observes the group's size.");
  observer.report([{
    target: group,
    contentRect: new DOMRect(0, 0, width, 400),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  }]);
  await group.updateComplete;
}

interface Page {
  group: CFResizablePanelGroup;
  first: CFResizablePanel;
  second: CFResizablePanel;
  handle: CFResizableHandle;
}

/** Two panels and a handle in a 400px square group, not yet attached. The
 * direction is assigned as a property, as the renderer assigns it. */
function built(direction?: PanelGroupDirection): Page {
  const group = new CFResizablePanelGroup();
  if (direction) group.direction = direction;
  Object.defineProperties(group, {
    offsetWidth: { value: 400 },
    offsetHeight: { value: 400 },
  });
  const first = new CFResizablePanel();
  first.setAttribute("default-size", "36");
  first.setAttribute("min-size", "20");
  const handle = new CFResizableHandle();
  const second = new CFResizablePanel();
  second.setAttribute("default-size", "64");
  second.setAttribute("min-size", "30");
  group.append(first, handle, second);
  return { group, first, second, handle };
}

/** The group from `built`, attached and rendered. */
async function mounted(direction?: PanelGroupDirection): Promise<Page> {
  const page = built(direction);
  await mount(page.group);
  return page;
}

/** Presses `key` on `target`, and returns whether the press was taken. */
function press(target: Element, key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Dispatches a mouse event of `type` at the given point on `target`, and
 * returns whether its default was prevented. */
function mouse(
  target: EventTarget,
  type: string,
  clientX = 0,
  clientY = 0,
): boolean {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Dispatches a touch event of `type` on `target`, with one touch at the
 * given point, or none, and returns whether its default was prevented. */
function touch(
  target: EventTarget,
  type: string,
  point?: { clientX: number; clientY: number },
): boolean {
  const touches = point
    ? [new Touch({ identifier: 0, target: document.body, ...point })]
    : [];
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Every `cf-resize` the group fires, as the sizes it reports. */
function resizes(group: CFResizablePanelGroup): number[][] {
  const sizes: number[][] = [];
  group.addEventListener("cf-resize", (event) => {
    if (!(event instanceof CustomEvent)) return;
    sizes.push(event.detail.sizes);
  });
  return sizes;
}

describe("CFResizablePanelGroup", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-resizable-panel-group`", () => {
    expect(customElements.get("cf-resizable-panel-group")).toBe(
      CFResizablePanelGroup,
    );
  });

  describe("direction", () => {
    it("lays panels out horizontally by default, sizing their widths", async () => {
      const page = await mounted();
      const container = page.group.shadowRoot!.querySelector(".panel-group")!;
      expect(container.classList.contains("direction-horizontal")).toBe(true);
      expect(container.getAttribute("part")).toBe("panel-group");
      expect(page.first.style.width).toBe("36%");
      expect(page.second.style.width).toBe("64%");
      expect(page.first.style.height).toBe("");
    });

    it("names the orientation on the group and on its handle, the handle's for assistive technology as the line it draws", async () => {
      const page = await mounted("horizontal");
      expect(page.group.dataset.orientation).toBe("horizontal");
      expect(page.handle.dataset.orientation).toBe("horizontal");
      expect(page.handle.getAttribute("aria-orientation")).toBe("vertical");

      page.group.direction = "vertical";
      await page.group.updateComplete;
      expect(page.group.dataset.orientation).toBe("vertical");
      expect(page.handle.dataset.orientation).toBe("vertical");
      expect(page.handle.getAttribute("aria-orientation")).toBe("horizontal");
    });

    it("moves the panels' sizes to their heights when it changes to vertical after the panels are in place", async () => {
      const page = await mounted("horizontal");
      page.group.direction = "vertical";
      await page.group.updateComplete;
      const container = page.group.shadowRoot!.querySelector(".panel-group")!;
      expect(container.classList.contains("direction-vertical")).toBe(true);
      expect(page.first.style.height).toBe("36%");
      expect(page.first.style.width).toBe("");
      expect(press(page.handle, "ArrowDown")).toBe(true);
      expect(page.first.style.height).toBe("37%");
    });

    it("carries a direction assigned after the group is attached, before its first render, to the handle and the panels", async () => {
      const page = built();
      document.body.append(page.group);
      page.group.direction = "vertical";
      await page.group.updateComplete;
      expect(page.handle.dataset.orientation).toBe("vertical");
      expect(page.first.style.height).toBe("36%");
      expect(page.first.style.width).toBe("");
    });

    it("leaves a size the host wrote along the other axis alone while the axis stays put", async () => {
      const page = built("horizontal");
      page.first.style.height = "50px";
      await mount(page.group);
      page.group.panelSizesChanged(page.first);
      expect(page.first.style.height).toBe("50px");
    });
  });

  describe("a handle's keys", () => {
    it("move a horizontal split with Left and Right, and not with Up and Down", async () => {
      const page = await mounted();
      expect(press(page.handle, "ArrowRight")).toBe(true);
      expect(page.first.style.width).toBe("37%");
      expect(page.second.style.width).toBe("63%");
      expect(press(page.handle, "ArrowDown")).toBe(false);
      expect(press(page.handle, "ArrowUp")).toBe(false);
      expect(page.first.style.width).toBe("37%");
      press(page.handle, "ArrowLeft");
      expect(page.first.style.width).toBe("36%");
    });

    it("move a vertical split with Up and Down, and not with Left and Right", async () => {
      const page = await mounted("vertical");
      expect(page.group.hasAttribute("direction")).toBe(false);
      press(page.handle, "ArrowDown");
      expect(page.first.style.height).toBe("37%");
      expect(page.second.style.height).toBe("63%");
      expect(press(page.handle, "ArrowRight")).toBe(false);
      expect(press(page.handle, "ArrowLeft")).toBe(false);
      expect(page.first.style.height).toBe("37%");
      press(page.handle, "ArrowUp");
      expect(page.first.style.height).toBe("36%");
    });

    it("move the split at most five points toward either end with Home and End", async () => {
      const page = await mounted();
      press(page.handle, "Home");
      expect(page.first.style.width).toBe("31%");
      expect(page.second.style.width).toBe("69%");
      press(page.handle, "End");
      press(page.handle, "End");
      expect(page.first.style.width).toBe("41%");
      expect(page.second.style.width).toBe("59%");
    });

    it("report the first panel's share of the pair on the handle, and fire `cf-resize` with every panel's size", async () => {
      const page = await mounted();
      const sizes = resizes(page.group);
      press(page.handle, "End");
      expect(page.handle.getAttribute("aria-valuenow")).toBe("41");
      expect(sizes).toEqual([[41, 59]]);
    });

    it("leave the split alone when a move would take a panel past its bounds", async () => {
      const page = built();
      page.first.setAttribute("default-size", "22");
      page.second.setAttribute("default-size", "78");
      await mount(page.group);
      const sizes = resizes(page.group);
      press(page.handle, "Home");
      expect(page.first.style.width).toBe("22%");
      expect(page.second.style.width).toBe("78%");
      expect(page.handle.getAttribute("aria-valuenow")).toBe("50");
      expect(sizes).toEqual([]);
    });

    it("do nothing from a handle with no panel beyond it", async () => {
      const page = await mounted();
      const last = new CFResizableHandle();
      page.group.append(last);
      await settle();
      const sizes = resizes(page.group);
      press(last, "ArrowRight");
      expect(page.first.style.width).toBe("36%");
      expect(page.second.style.width).toBe("64%");
      expect(sizes).toEqual([]);
    });

    it("do nothing from a handle taken out of the group", async () => {
      const page = await mounted();
      const outside = document.createElement("div");
      document.body.append(outside);
      outside.append(page.handle);
      await settle();
      expect(press(page.handle, "ArrowRight")).toBe(false);
      expect(page.first.style.width).toBe("36%");
    });
  });

  describe("a drag", () => {
    it("moves a horizontal split as far as the mouse moves, and fires `cf-resize`", async () => {
      const page = await mounted("horizontal");
      const sizes = resizes(page.group);
      expect(mouse(page.handle, "mousedown", 100, 160)).toBe(true);
      expect(page.group.classList.contains("resizing")).toBe(true);
      // 40px of a 400px group is 10 points.
      mouse(document, "mousemove", 140, 900);
      expect(page.first.style.width).toBe("46%");
      expect(page.second.style.width).toBe("54%");
      expect(sizes).toEqual([[46, 54]]);

      mouse(document, "mouseup");
      expect(page.group.classList.contains("resizing")).toBe(false);
      mouse(document, "mousemove", 200, 160);
      expect(page.first.style.width).toBe("46%");
    });

    it("moves a vertical split as far as the mouse moves down", async () => {
      const page = await mounted("vertical");
      mouse(page.handle, "mousedown", 100, 160);
      mouse(document, "mousemove", 900, 120);
      expect(page.first.style.height).toBe("26%");
      expect(page.second.style.height).toBe("74%");
      mouse(document, "mouseup");
    });

    it("moves a split as far as a touch moves, until the touch ends", async () => {
      const page = await mounted("horizontal");
      expect(touch(page.handle, "touchstart", { clientX: 100, clientY: 0 }))
        .toBe(true);
      expect(page.group.classList.contains("resizing")).toBe(true);
      touch(document, "touchmove", { clientX: 120, clientY: 0 });
      expect(page.first.style.width).toBe("41%");

      touch(document, "touchend");
      expect(page.group.classList.contains("resizing")).toBe(false);
      touch(document, "touchmove", { clientX: 200, clientY: 0 });
      expect(page.first.style.width).toBe("41%");
    });

    it("ends a mouse drag when a touch on the handle ends", async () => {
      const page = await mounted("horizontal");
      mouse(page.handle, "mousedown", 100, 0);
      touch(page.handle, "touchstart", { clientX: 100, clientY: 0 });
      touch(document, "touchend");
      mouse(document, "mousemove", 140, 0);
      expect(page.first.style.width).toBe("36%");
      mouse(document, "mouseup");
    });

    it("leaves the split alone where the pointer would take a panel past its bounds", async () => {
      const page = await mounted("horizontal");
      const sizes = resizes(page.group);
      mouse(page.handle, "mousedown", 100, 0);
      // 80px left would leave the first panel at 16 points, below its 20.
      mouse(document, "mousemove", 20, 0);
      expect(page.first.style.width).toBe("36%");
      expect(sizes).toEqual([]);
      mouse(document, "mouseup");
    });

    it("moves nothing from a handle with no panel beyond it", async () => {
      const page = await mounted("horizontal");
      const last = new CFResizableHandle();
      page.group.append(last);
      await settle();
      const sizes = resizes(page.group);
      mouse(last, "mousedown", 100, 0);
      mouse(document, "mousemove", 140, 0);
      expect(page.first.style.width).toBe("36%");
      expect(sizes).toEqual([]);
      mouse(document, "mouseup");
    });

    it("moves nothing, and leaves the page's pointer alone, from a handle taken out of the group", async () => {
      const page = await mounted("horizontal");
      const outside = document.createElement("div");
      document.body.append(outside);
      outside.append(page.handle);
      await settle();
      const sizes = resizes(page.group);
      expect(mouse(page.handle, "mousedown", 100, 0)).toBe(false);
      expect(touch(page.handle, "touchstart", { clientX: 100, clientY: 0 }))
        .toBe(false);
      expect(page.group.classList.contains("resizing")).toBe(false);
      mouse(document, "mousemove", 140, 0);
      expect(page.first.style.width).toBe("36%");
      expect(sizes).toEqual([]);
      mouse(document, "mouseup");
    });

    it("ends when the direction changes, so a stationary pointer leaves the split alone", async () => {
      const page = await mounted("horizontal");
      mouse(page.handle, "mousedown", 100, 160);
      page.group.direction = "vertical";
      await page.group.updateComplete;
      expect(page.group.classList.contains("resizing")).toBe(false);
      mouse(document, "mousemove", 100, 160);
      expect(page.first.style.height).toBe("36%");
      expect(page.second.style.height).toBe("64%");
    });

    it("ends when the group reads its panels again", async () => {
      const page = await mounted("horizontal");
      mouse(page.handle, "mousedown", 100, 160);
      page.second.minSize = 25;
      await page.second.updateComplete;
      expect(page.group.classList.contains("resizing")).toBe(false);
      mouse(document, "mousemove", 140, 160);
      expect(page.first.style.width).toBe("36%");
    });

    it("ends a touch drag when the group reads its panels again", async () => {
      const page = await mounted("horizontal");
      touch(page.handle, "touchstart", { clientX: 100, clientY: 0 });
      page.second.minSize = 25;
      await page.second.updateComplete;
      touch(document, "touchmove", { clientX: 140, clientY: 0 });
      expect(page.first.style.width).toBe("36%");
    });

    it("goes on when a panel is marked hideWhenStacked", async () => {
      const page = await mounted("horizontal");
      mouse(page.handle, "mousedown", 144, 10);
      page.second.hideWhenStacked = true;
      await page.second.updateComplete;
      expect(page.group.classList.contains("resizing")).toBe(true);
      mouse(document, "mouseup");
    });

    it("goes on through a width change that crosses no stackBelow", async () => {
      const page = await mounted("horizontal");
      page.group.stackBelow = 300;
      await measure(page.group, 400);
      mouse(page.handle, "mousedown", 100, 160);
      await measure(page.group, 350);
      expect(page.group.classList.contains("resizing")).toBe(true);
      mouse(document, "mousemove", 135, 160);
      // The group's `offsetWidth` stays 400px here.
      expect(page.first.style.width).toBe("44.75%");
      mouse(document, "mouseup");
    });
  });

  describe("panel sizes", () => {
    it("reach the group when a renderer assigns them as properties after the panels are in place", async () => {
      const group = new CFResizablePanelGroup();
      const first = new CFResizablePanel();
      const second = new CFResizablePanel();
      group.append(first, new CFResizableHandle(), second);
      await mount(group);
      expect(first.style.width).toBe("50%");

      first.defaultSize = 36;
      second.defaultSize = 64;
      await first.updateComplete;
      await second.updateComplete;
      expect(first.style.width).toBe("36%");
      expect(second.style.width).toBe("64%");
    });

    it("keep a size a person moved to when the group reads its panels again", async () => {
      const page = await mounted("horizontal");
      press(page.handle, "ArrowRight");
      page.second.minSize = 25;
      await page.second.updateComplete;
      expect(page.first.style.width).toBe("37%");

      page.first.defaultSize = 40;
      await page.first.updateComplete;
      expect(page.first.style.width).toBe("40%");
      expect(page.second.style.width).toBe("64%");
    });

    it("return to their defaults when a moved size falls outside a panel's new bounds", async () => {
      const page = await mounted("horizontal");
      press(page.handle, "Home");
      expect(page.first.style.width).toBe("31%");
      page.first.minSize = 33;
      await page.first.updateComplete;
      expect(page.first.style.width).toBe("36%");
      expect(page.second.style.width).toBe("64%");
    });

    it("return to their defaults when a panel joins the group", async () => {
      const page = await mounted("horizontal");
      press(page.handle, "ArrowRight");
      const third = new CFResizablePanel();
      third.defaultSize = 0;
      page.group.append(third);
      await settle();
      expect(page.first.style.width).toBe("36%");
      expect(third.style.width).toBe("0%");
    });
  });

  describe("stackBelow", () => {
    it("stacks the panels of a group narrower than it", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 401;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.group.stacked).toBe(true);
      expect(page.group.orientation).toBe("vertical");
      expect(page.handle.dataset.orientation).toBe("vertical");
      expect(page.first.style.height).toBe("36%");
      expect(page.first.style.width).toBe("");
    });

    it("leaves the direction of a group as wide as it", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 400;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.group.stacked).toBe(false);
      expect(page.group.orientation).toBe("horizontal");
      expect(page.first.style.width).toBe("36%");
    });

    it("leaves the direction of a group not yet measured", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 400;
      await mount(page.group);
      expect(page.group.orientation).toBe("horizontal");
    });

    it("leaves the direction alone when unset, however narrow the group", async () => {
      const page = await mounted("horizontal");
      await measure(page.group, 100);
      expect(page.group.orientation).toBe("horizontal");
      expect(page.first.style.width).toBe("36%");
    });

    it("ignores a report with no entries", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 300;
      await mount(page.group);
      await measure(page.group, 200);
      ReportingResizeObserver.watching.get(page.group)!.report([]);
      await page.group.updateComplete;
      expect(page.group.stacked).toBe(true);
    });

    it("stacks a group that narrows past it, keeping the split and turning the keys, and turns back when it widens", async () => {
      const page = await mounted("horizontal");
      page.group.stackBelow = 300;
      await measure(page.group, 400);
      press(page.handle, "ArrowRight");
      expect(page.first.style.width).toBe("37%");

      await measure(page.group, 200);
      expect(page.handle.dataset.orientation).toBe("vertical");
      expect(page.first.style.height).toBe("37%");
      expect(page.first.style.width).toBe("");
      expect(press(page.handle, "ArrowRight")).toBe(false);
      press(page.handle, "ArrowDown");
      expect(page.first.style.height).toBe("38%");

      await measure(page.group, 400);
      expect(page.handle.dataset.orientation).toBe("horizontal");
      expect(page.first.style.width).toBe("38%");
      expect(page.first.style.height).toBe("");
    });

    it("never stacks a group that is vertical by its direction", async () => {
      const page = built("vertical");
      page.group.stackBelow = 500;
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.group.stacked).toBe(false);
      expect(page.second.style.display).toBe("");
      expect(page.first.style.height).toBe("36%");
    });

    for (const bad of [Number.NaN, 0, -10]) {
      it(`refuses ${bad}, which is not a positive width`, async () => {
        const page = await mounted("horizontal");
        page.group.stackBelow = bad;
        await expect(page.group.updateComplete).rejects.toThrow(RangeError);
      });
    }

    it("stops stacking once its attribute is removed", async () => {
      const page = built("horizontal");
      page.group.setAttribute("stack-below", "500");
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.group.orientation).toBe("vertical");
      page.group.removeAttribute("stack-below");
      await page.group.updateComplete;
      expect(page.group.stackBelow).toBe(null);
      expect(page.group.orientation).toBe("horizontal");
      expect(page.first.style.width).toBe("36%");
    });

    it("measures a group again once it is put back in the page", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 300;
      await mount(page.group);
      page.group.remove();
      expect(ReportingResizeObserver.watching.has(page.group)).toBe(false);
      await mount(page.group);
      await measure(page.group, 200);
      expect(page.group.stacked).toBe(true);
    });
  });

  describe("hideWhenStacked", () => {
    it("hides a marked panel and its handle while stacked, giving the others its room, and shows them again when the group widens", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 300;
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
      expect(page.first.style.width).toBe("36%");

      await measure(page.group, 200);
      expect(page.second.style.display).toBe("none");
      expect(page.handle.style.display).toBe("none");
      expect(page.first.style.height).toBe("100%");
      expect(page.first.style.display).toBe("");

      await measure(page.group, 400);
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
      expect(page.first.style.width).toBe("36%");
      expect(page.second.style.width).toBe("64%");
    });

    it("takes effect at once when assigned or cleared while stacked", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 500;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.second.style.display).toBe("");
      expect(page.first.style.height).toBe("36%");

      page.second.hideWhenStacked = true;
      await page.second.updateComplete;
      expect(page.second.style.display).toBe("none");
      expect(page.handle.style.display).toBe("none");
      expect(page.first.style.height).toBe("100%");

      page.second.hideWhenStacked = false;
      await page.second.updateComplete;
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
      expect(page.first.style.height).toBe("36%");
    });

    it("hides nothing while the group is side by side", async () => {
      const page = await mounted("horizontal");
      page.group.stackBelow = 300;
      await measure(page.group, 400);
      page.second.hideWhenStacked = true;
      await page.second.updateComplete;
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
      expect(page.first.style.width).toBe("36%");
    });

    it("hides nothing when every panel is marked", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 500;
      page.first.hideWhenStacked = true;
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.first.style.display).toBe("");
      expect(page.second.style.display).toBe("");
      expect(page.first.style.height).toBe("36%");
    });

    it("leaves alone a display the host set on a drawn panel, and restores one it set on a hidden panel", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 300;
      page.first.style.display = "flex";
      page.second.style.display = "grid";
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 200);
      expect(page.first.style.display).toBe("flex");
      expect(page.second.style.display).toBe("none");
      await measure(page.group, 400);
      expect(page.second.style.display).toBe("grid");
    });

    it("moves a handle between two drawn panels as far as the pointer and the keys say", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 500;
      for (const panel of [page.first, page.second]) {
        panel.setAttribute("default-size", "30");
        panel.setAttribute("min-size", "10");
      }
      const third = new CFResizablePanel();
      third.setAttribute("default-size", "40");
      third.hideWhenStacked = true;
      const handle2 = new CFResizableHandle();
      page.group.append(handle2, third);
      await mount(page.group);
      await measure(page.group, 400);
      expect(third.style.display).toBe("none");
      expect(handle2.style.display).toBe("none");
      expect(page.handle.style.display).toBe("");
      expect(parseFloat(page.first.style.height)).toBeCloseTo(50);

      press(page.handle, "ArrowDown");
      expect(parseFloat(page.first.style.height)).toBeCloseTo(51);
      expect(parseFloat(page.second.style.height)).toBeCloseTo(49);

      mouse(page.handle, "mousedown", 10, 0);
      mouse(document, "mousemove", 10, 40);
      mouse(document, "mouseup");
      // 40px of a 400px group is 10 points of the drawn length.
      expect(parseFloat(page.first.style.height)).toBeCloseTo(61);
    });

    it("draws again a panel and handle taken out of the group while hidden", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 500;
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.second.style.display).toBe("none");
      page.second.remove();
      page.handle.remove();
      await settle();
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
    });

    it("turns the handles when a panel is marked in the same turn the group starts stacking", async () => {
      const page = await mounted("horizontal");
      await measure(page.group, 400);
      page.first.hideWhenStacked = true;
      page.group.stackBelow = 500;
      await page.first.updateComplete;
      await page.group.updateComplete;
      expect(page.group.stacked).toBe(true);
      expect(page.handle.dataset.orientation).toBe("vertical");
      expect(page.first.style.display).toBe("none");
    });
  });

  describe("disconnected", () => {
    it("draws its hidden panel and handle again", async () => {
      const page = built("horizontal");
      page.group.stackBelow = 500;
      page.second.hideWhenStacked = true;
      await mount(page.group);
      await measure(page.group, 400);
      expect(page.second.style.display).toBe("none");
      page.group.remove();
      expect(page.second.style.display).toBe("");
      expect(page.handle.style.display).toBe("");
    });

    it("stops answering its handles", async () => {
      const page = await mounted("horizontal");
      page.group.remove();
      const key = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      page.handle.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
      expect(mouse(page.handle, "mousedown", 100, 0)).toBe(false);
      expect(touch(page.handle, "touchstart", { clientX: 100, clientY: 0 }))
        .toBe(false);
      expect(page.first.style.width).toBe("36%");
      expect(page.group.classList.contains("resizing")).toBe(false);
    });

    it("stops reading its panels", async () => {
      const page = await mounted("horizontal");
      page.group.remove();
      page.group.append(new CFResizablePanel());
      await settle();
      expect(page.first.style.width).toBe("36%");
    });
  });
});
