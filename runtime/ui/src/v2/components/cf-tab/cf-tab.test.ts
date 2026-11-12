// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFTab } from "./index.ts";

/** A tab mounted with `properties`, and every `tab-click` it fires. */
async function tabWith(properties: Partial<CFTab> = {}) {
  const tab = Object.assign(new CFTab(), properties);
  const clicks: unknown[] = [];
  tab.addEventListener("tab-click", (event) => {
    if (event instanceof CustomEvent) clicks.push(event.detail.tab);
  });
  return { tab: await mount(tab), clicks };
}

describe("CFTab", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tab`", () => {
    expect(customElements.get("cf-tab")).toBe(CFTab);
  });

  describe("state", () => {
    it("exposes an unselected tab outside the tab order", async () => {
      const { tab } = await tabWith({ value: "profile" });
      expect(tab.getAttribute("role")).toBe("tab");
      expect(tab.getAttribute("value")).toBe("profile");
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.getAttribute("aria-disabled")).toBe("false");
      expect(tab.getAttribute("tabindex")).toBe("-1");
      expect(tab.button!.getAttribute("data-selected")).toBe("false");
    });

    it("puts a selected tab in the tab order, and takes it out when deselected", async () => {
      const { tab } = await tabWith({ selected: true });
      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(tab.getAttribute("tabindex")).toBe("0");
      expect(tab.button!.getAttribute("data-selected")).toBe("true");

      tab.selected = false;
      await tab.updateComplete;
      expect(tab.getAttribute("aria-selected")).toBe("false");
      expect(tab.getAttribute("tabindex")).toBe("-1");
    });

    it("keeps a disabled tab out of the tab order even when selected", async () => {
      const { tab } = await tabWith({ selected: true, disabled: true });
      expect(tab.getAttribute("aria-disabled")).toBe("true");
      expect(tab.getAttribute("tabindex")).toBe("-1");
      expect(tab.button!.disabled).toBe(true);
    });
  });

  describe("a click", () => {
    it("fires `tab-click` naming the tab", async () => {
      const { tab, clicks } = await tabWith({ value: "profile" });
      tab.button!.click();
      expect(clicks).toEqual([tab]);
    });

    it("fires nothing once the tab is disabled, and goes no further", async () => {
      const { tab, clicks } = await tabWith();
      // The button is still enabled until the tab renders again.
      tab.disabled = true;
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const click = new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      tab.button!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
      expect(clicks).toEqual([]);
    });
  });

  describe("focus() and blur()", () => {
    it("focus and blur the inner button", async () => {
      const { tab } = await tabWith();
      tab.focus();
      expect(tab.shadowRoot!.activeElement).toBe(tab.button);
      tab.blur();
      expect(tab.shadowRoot!.activeElement).toBeNull();
    });

    it("do nothing before the tab has rendered", () => {
      const tab = new CFTab();
      tab.focus();
      tab.blur();
      expect(tab.button).toBeNull();
    });
  });
});
