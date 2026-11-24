// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";

import {
  countSubscriptions,
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSvg } from "./index.ts";

const CIRCLE = '<svg viewBox="0 0 10 10"><circle r="4"/></svg>';
const SQUARE = '<svg viewBox="0 0 10 10"><rect width="4"/></svg>';

/** A `cf-svg` mounted showing `content`. */
function svgWith(content: CFSvg["content"]): Promise<CFSvg> {
  return mount(Object.assign(new CFSvg(), { content }));
}

/** The element wrapping what the drawing shows. */
const wrapper = (element: CFSvg) =>
  element.shadowRoot!.querySelector(".svg-content")!;

/** The local names of the elements the drawing shows, in document order. */
const drawn = (element: CFSvg) =>
  Array.from(wrapper(element).querySelectorAll("*"), (node) => node.localName);

describe("CFSvg", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-svg`", () => {
    expect(customElements.get("cf-svg")).toBe(CFSvg);
  });

  describe("render()", () => {
    it("draws the sanitized drawing a string holds", async () => {
      const element = await svgWith(
        '<svg onload="alert(1)"><script>alert(2)</script><circle r="4"/></svg>',
      );
      const root = wrapper(element).querySelector("svg")!;
      expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(root.hasAttribute("onload")).toBe(false);
      expect(drawn(element)).not.toContain("script");
      expect(wrapper(element).getAttribute("part")).toBe("content");
    });

    it("draws nothing for an empty string, or one holding no drawing", async () => {
      const element = await svgWith("");
      expect(drawn(element)).toEqual([]);

      element.content = "<p>not a drawing</p>";
      await element.updateComplete;
      expect(drawn(element)).toEqual([]);
    });

    it("draws the drawing a cell holds", async () => {
      const element = await svgWith(createMockCellHandle(CIRCLE));
      expect(drawn(element)).toEqual(["svg", "circle"]);
    });

    it("draws nothing for a cell that has read nothing", async () => {
      const element = await svgWith(createMockCellHandle<string>());
      expect(drawn(element)).toEqual([]);
    });

    it("redraws when the cell's value changes", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const element = await svgWith(cell);

      pushUpdate(cell, SQUARE);
      await element.updateComplete;
      expect(drawn(element)).toEqual(["svg", "rect"]);
    });

    it("shows the policy placeholder as text while the cell's read is refused", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const element = await svgWith(cell);

      pushRefusal(cell);
      await element.updateComplete;
      expect(drawn(element)).toEqual([]);
      expect(wrapper(element).textContent).toBe(CFC_POLICY_PLACEHOLDER_TEXT);

      pushUpdate(cell, SQUARE);
      await element.updateComplete;
      expect(drawn(element)).toEqual(["svg", "rect"]);
      expect(wrapper(element).textContent).not.toContain(
        CFC_POLICY_PLACEHOLDER_TEXT,
      );
    });

    it("shows no placeholder for a string", async () => {
      const element = await svgWith(CIRCLE);
      expect(wrapper(element).textContent).not.toContain(
        CFC_POLICY_PLACEHOLDER_TEXT,
      );
    });
  });

  describe("subscriptions", () => {
    it("holds one subscription to the cell it shows", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(cell);
      await svgWith(cell);
      expect(subscriptions.live).toBe(1);
    });

    it("drops the subscription to a cell it stops showing", async () => {
      const first = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(first);
      const element = await svgWith(first);

      const second = createMockCellHandle(SQUARE);
      element.content = second;
      await element.updateComplete;
      expect(subscriptions.live).toBe(0);
      expect(drawn(element)).toEqual(["svg", "rect"]);

      pushUpdate(first, CIRCLE);
      await element.updateComplete;
      expect(drawn(element)).toEqual(["svg", "rect"]);
    });

    it("drops the subscription when content becomes a string", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(cell);
      const element = await svgWith(cell);

      element.content = SQUARE;
      await element.updateComplete;
      expect(subscriptions.live).toBe(0);
      expect(drawn(element)).toEqual(["svg", "rect"]);
    });

    it("drops the subscription when removed from the document", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(cell);
      const element = await svgWith(cell);

      element.remove();
      expect(subscriptions.live).toBe(0);
    });

    it("follows the cell again once put back in the document", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(cell);
      const element = await svgWith(cell);
      element.remove();
      document.body.append(element);
      expect(subscriptions.live).toBe(1);

      pushUpdate(cell, SQUARE);
      await element.updateComplete;
      expect(drawn(element)).toEqual(["svg", "rect"]);
    });

    it("subscribes to nothing while out of the document", async () => {
      const cell = createMockCellHandle(CIRCLE);
      const subscriptions = countSubscriptions(cell);
      const element = await svgWith(SQUARE);
      element.remove();

      element.content = cell;
      await element.updateComplete;
      expect(subscriptions.live).toBe(0);
    });
  });
});
