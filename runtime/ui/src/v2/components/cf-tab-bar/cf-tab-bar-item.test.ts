// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFTabBarItem } from "./index.ts";

/** An item mounted with `properties`, and every `tab-bar-click` it fires. */
async function itemWith(properties: Partial<CFTabBarItem> = {}) {
  const item = Object.assign(new CFTabBarItem(), properties);
  const clicks: unknown[] = [];
  item.addEventListener("tab-bar-click", (event) => {
    if (event instanceof CustomEvent) clicks.push(event.detail.item);
  });
  return { item: await mount(item), clicks };
}

describe("CFTabBarItem", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tab-bar-item`", () => {
    expect(customElements.get("cf-tab-bar-item")).toBe(CFTabBarItem);
  });

  describe("render()", () => {
    it("shows its label under the icon", async () => {
      const { item } = await itemWith({ label: "Home" });
      expect(item.button!.querySelector("[part=label]")!.textContent!.trim())
        .toBe("Home");
      expect(item.button!.hasAttribute("aria-label")).toBe(false);
    });

    it("moves a hidden label into the button's accessible name", async () => {
      const { item } = await itemWith({ label: "Home", hideLabel: true });
      expect(item.button!.querySelector("[part=label]")).toBeNull();
      expect(item.button!.getAttribute("aria-label")).toBe("Home");
      expect(item.hasAttribute("hide-label")).toBe(true);
    });
  });

  describe("state", () => {
    it("marks an unselected item as neither current nor in the tab order", async () => {
      const { item } = await itemWith();
      expect(item.button!.hasAttribute("aria-current")).toBe(false);
      expect(item.button!.getAttribute("tabindex")).toBe("-1");
      expect(item.hasAttribute("data-selected")).toBe(false);
    });

    it("marks a selected item as the current page, in the tab order", async () => {
      const { item } = await itemWith({ selected: true });
      expect(item.button!.getAttribute("aria-current")).toBe("page");
      expect(item.button!.getAttribute("tabindex")).toBe("0");
      expect(item.getAttribute("data-selected")).toBe("true");

      item.selected = false;
      await item.updateComplete;
      expect(item.button!.hasAttribute("aria-current")).toBe(false);
      expect(item.hasAttribute("data-selected")).toBe(false);
    });

    it("takes a disabled item out of the tab order, and puts it back", async () => {
      const { item } = await itemWith({ selected: true, disabled: true });
      expect(item.button!.disabled).toBe(true);
      expect(item.button!.getAttribute("aria-disabled")).toBe("true");
      expect(item.button!.getAttribute("tabindex")).toBe("-1");

      item.disabled = false;
      await item.updateComplete;
      expect(item.button!.hasAttribute("aria-disabled")).toBe(false);
      expect(item.button!.getAttribute("tabindex")).toBe("0");
    });
  });

  describe("a click", () => {
    it("fires `tab-bar-click` naming the item", async () => {
      const { item, clicks } = await itemWith({ value: "home" });
      item.button!.click();
      expect(clicks).toEqual([item]);
    });

    it("fires nothing once the item is disabled, and goes no further", async () => {
      const { item, clicks } = await itemWith();
      // The button is still enabled until the item renders again.
      item.disabled = true;
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const click = new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      item.button!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
      expect(clicks).toEqual([]);
    });
  });

  describe("focus() and blur()", () => {
    it("focus and blur the inner button", async () => {
      const { item } = await itemWith();
      item.focus();
      expect(item.shadowRoot!.activeElement).toBe(item.button);
      item.blur();
      expect(item.shadowRoot!.activeElement).toBeNull();
    });

    it("do nothing before the item has rendered", () => {
      const item = new CFTabBarItem();
      item.focus();
      item.blur();
      expect(item.button).toBeNull();
    });
  });
});
