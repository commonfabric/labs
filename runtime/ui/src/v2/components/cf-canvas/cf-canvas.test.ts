// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFCanvas } from "./index.ts";

/** The canvas's container, placed at (100, 40) in the viewport. */
const containerOf = (element: CFCanvas): HTMLElement => {
  const container = element.shadowRoot!.querySelector<HTMLElement>(
    ".canvas-container",
  )!;
  container.getBoundingClientRect = () => new DOMRect(100, 40, 800, 600);
  return container;
};

/** The details of the `cf-canvas-click` events `element` fires. */
const clicksOf = (element: CFCanvas): unknown[] => {
  const clicks: unknown[] = [];
  element.addEventListener(
    "cf-canvas-click",
    (event) => clicks.push((event as CustomEvent).detail),
  );
  return clicks;
};

describe("CFCanvas", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-canvas")).toBe(CFCanvas);
  });

  it("sizes its container from its width and height", async () => {
    const element = await mount(new CFCanvas());
    const style = containerOf(element).style;
    expect(style.getPropertyValue("--canvas-width")).toBe("800px");
    expect(style.getPropertyValue("--canvas-height")).toBe("600px");

    element.width = 320;
    element.height = 240;
    await element.updateComplete;
    expect(style.getPropertyValue("--canvas-width")).toBe("320px");
    expect(style.getPropertyValue("--canvas-height")).toBe("240px");
  });

  it("emits `cf-canvas-click` with the rounded position of a click on its background", async () => {
    const element = await mount(new CFCanvas());
    const clicks = clicksOf(element);
    containerOf(element).dispatchEvent(
      new MouseEvent("click", { clientX: 150.4, clientY: 99.6, bubbles: true }),
    );
    expect(clicks).toEqual([{ x: 50, y: 60 }]);
  });

  it("emits nothing for a click on something inside its container", async () => {
    // happy-dom does not route an event from a slotted child through its
    // slot, so the click starts at the slot, which sits inside the container
    // as a slotted child does.

    const element = await mount(new CFCanvas());
    const container = containerOf(element);
    const reached: EventTarget[] = [];
    container.addEventListener("click", (e) => reached.push(e.target!));
    const clicks = clicksOf(element);
    const slot = container.querySelector("slot")!;
    slot.dispatchEvent(
      new MouseEvent("click", { clientX: 150, clientY: 100, bubbles: true }),
    );
    expect(reached).toEqual([slot]);
    expect(clicks).toEqual([]);
  });
});
