// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFResizablePanel } from "./index.ts";

/** A panel mounted with `properties`, and the names of the events it fires
 * to its group, which hears them only from its own children. */
async function panelWith(properties: Partial<CFResizablePanel> = {}) {
  const element = Object.assign(new CFResizablePanel(), properties);
  const heard: string[] = [];
  for (const type of ["cf-panel-sizes", "cf-panel-shown"]) {
    element.addEventListener(type, (event) => {
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(false);
      heard.push(type);
    });
  }
  return { element: await mount(element), heard };
}

describe("CFResizablePanel", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-resizable-panel`", () => {
    expect(customElements.get("cf-resizable-panel")).toBe(CFResizablePanel);
  });

  it("renders its content into a `panel` part", async () => {
    const { element } = await panelWith();
    const panel = element.shadowRoot!.querySelector(".panel")!;
    expect(panel.getAttribute("part")).toBe("panel");
    expect(panel.querySelector("slot")).not.toBe(null);
  });

  describe("sizes", () => {
    it("default to half the group, between nothing and all of it", async () => {
      const { element } = await panelWith();
      expect([element.minSize, element.defaultSize, element.maxSize])
        .toEqual([0, 50, 100]);
      expect(element.collapsible).toBe(false);
      expect(element.hideWhenStacked).toBe(false);
    });

    it("are read from their attributes", async () => {
      const element = new CFResizablePanel();
      element.setAttribute("min-size", "10");
      element.setAttribute("default-size", "30");
      element.setAttribute("max-size", "60");
      element.setAttribute("hide-when-stacked", "");
      await mount(element);
      expect([element.minSize, element.defaultSize, element.maxSize])
        .toEqual([10, 30, 60]);
      expect(element.hideWhenStacked).toBe(true);
    });

    it("are held between 0 and 100", async () => {
      const { element } = await panelWith({
        minSize: -5,
        defaultSize: 150,
        maxSize: 120,
      });
      expect([element.minSize, element.defaultSize, element.maxSize])
        .toEqual([0, 100, 100]);
    });

    it("swap a minimum above the maximum", async () => {
      const { element } = await panelWith({ minSize: 70, maxSize: 20 });
      expect([element.minSize, element.maxSize]).toEqual([20, 70]);
    });

    it("raise a default below the minimum to it", async () => {
      const { element } = await panelWith({ minSize: 40, defaultSize: 10 });
      expect(element.defaultSize).toBe(40);
    });

    it("lower a default above the maximum to it", async () => {
      const { element } = await panelWith({ maxSize: 40, defaultSize: 90 });
      expect(element.defaultSize).toBe(40);
    });

    it("drop the minimum of a collapsible panel to 0", async () => {
      const { element } = await panelWith({ minSize: 25, collapsible: true });
      expect(element.minSize).toBe(0);
    });

    it("are checked again when assigned after the panel is in place", async () => {
      const { element } = await panelWith();
      element.defaultSize = 140;
      await element.updateComplete;
      expect(element.defaultSize).toBe(100);
    });
  });

  describe("events", () => {
    it("fires `cf-panel-sizes` when a size changes, and not `cf-panel-shown`", async () => {
      const { element, heard } = await panelWith();
      heard.length = 0;
      element.maxSize = 80;
      await element.updateComplete;
      expect(heard).toEqual(["cf-panel-sizes"]);
    });

    it("fires `cf-panel-shown` when only hideWhenStacked changes", async () => {
      const { element, heard } = await panelWith();
      heard.length = 0;
      element.hideWhenStacked = true;
      await element.updateComplete;
      expect(heard).toEqual(["cf-panel-shown"]);
    });

    it("fires neither when nothing it sizes or hides by changes", async () => {
      const { element, heard } = await panelWith();
      heard.length = 0;
      element.collapsible = true;
      await element.updateComplete;
      expect(heard).toEqual([]);
    });
  });
});
