// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAccordionItem } from "./index.ts";

/** An item with `properties` set, mounted in the document. */
function item(
  properties: Partial<
    Pick<CFAccordionItem, "value" | "expanded" | "disabled">
  > = {},
): Promise<CFAccordionItem> {
  return mount(
    Object.assign(new CFAccordionItem(), { value: "a" }, properties),
  );
}

/** The element of `element`'s shadow tree that `selector` names. */
function part<T extends HTMLElement = HTMLElement>(
  element: CFAccordionItem,
  selector: string,
): T {
  const found = element.shadowRoot!.querySelector<T>(selector);
  if (!found) throw new Error(`cf-accordion-item rendered no ${selector}`);
  return found;
}

/** The details of the toggles `element` emits while `act()` runs. */
function toggles(element: CFAccordionItem, act: () => void): unknown[] {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  element.addEventListener("cf-accordion-toggle", listener);
  try {
    act();
  } finally {
    element.removeEventListener("cf-accordion-toggle", listener);
  }
  return seen;
}

describe("CFAccordionItem", () => {
  afterEach(() => document.body.replaceChildren());

  describe("trigger", () => {
    it("emits cf-accordion-toggle asking to expand when a collapsed item's trigger is clicked", async () => {
      const element = await item();
      const trigger = part<HTMLButtonElement>(element, "button.trigger");
      expect(toggles(element, () => trigger.click())).toEqual([
        { value: "a", expanded: true },
      ]);
      // The parent accordion decides; the item does not open itself.
      expect(element.expanded).toBe(false);
    });

    it("emits cf-accordion-toggle asking to collapse when an expanded item's trigger is clicked", async () => {
      const element = await item({ expanded: true });
      const trigger = part<HTMLButtonElement>(element, "button.trigger");
      expect(toggles(element, () => trigger.click())).toEqual([
        { value: "a", expanded: false },
      ]);
    });

    it("emits nothing when a disabled item's trigger is clicked", async () => {
      const element = await item({ disabled: true });
      const trigger = part<HTMLButtonElement>(element, "button.trigger");
      expect(trigger.disabled).toBe(true);
      const event = new MouseEvent("click", { cancelable: true });
      expect(toggles(element, () => trigger.dispatchEvent(event))).toEqual([]);
    });
  });

  describe("rendering", () => {
    it("shows its expanded and disabled state on its trigger and frame", async () => {
      const element = await item();
      const trigger = part<HTMLButtonElement>(element, "button.trigger");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect([...part(element, "[part=base]").classList]).toEqual([
        "accordion-item",
      ]);

      element.expanded = true;
      element.disabled = true;
      await element.updateComplete;
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect([...part(element, "[part=base]").classList]).toEqual([
        "accordion-item",
        "expanded",
        "disabled",
      ]);
    });

    it("opens its content to the content's height while expanded, and closes it otherwise", async () => {
      const element = await item();
      const wrapper = part(element, ".content-wrapper");
      expect(wrapper.style.height).toBe("0px");
      Object.defineProperty(part(element, ".content"), "scrollHeight", {
        value: 120,
      });

      element.expanded = true;
      await element.updateComplete;
      expect(wrapper.style.height).toBe("120px");

      element.expanded = false;
      await element.updateComplete;
      expect(wrapper.style.height).toBe("0px");
    });

    it("reads its expanded state from the expanded attribute", async () => {
      const element = await item();
      element.setAttribute("expanded", "");
      await element.updateComplete;
      expect(element.expanded).toBe(true);
      expect(
        part(element, "button.trigger").getAttribute("aria-expanded"),
      ).toBe("true");
    });
  });

  describe("contentWrapper", () => {
    it("returns `null` before the item renders, and the rendered `.content-wrapper` element after", async () => {
      const element = new CFAccordionItem();
      expect(element.contentWrapper).toBeNull();

      await mount(element);
      expect(element.contentWrapper).toBe(part(element, ".content-wrapper"));
    });
  });

  describe("content", () => {
    it("returns `null` before the item renders, and the rendered `.content` element after", async () => {
      const element = new CFAccordionItem();
      expect(element.content).toBeNull();

      await mount(element);
      expect(element.content).toBe(part(element, ".content"));
    });
  });

  describe("expand()", () => {
    it("expands a collapsed item and emits cf-accordion-toggle", async () => {
      const element = await item();
      expect(toggles(element, () => element.expand())).toEqual([
        { value: "a", expanded: true },
      ]);
      expect(element.expanded).toBe(true);
    });

    it("emits nothing for an item already expanded", async () => {
      const element = await item({ expanded: true });
      expect(toggles(element, () => element.expand())).toEqual([]);
      expect(element.expanded).toBe(true);
    });

    it("leaves a disabled item collapsed", async () => {
      const element = await item({ disabled: true });
      expect(toggles(element, () => element.expand())).toEqual([]);
      expect(element.expanded).toBe(false);
    });
  });

  describe("collapse()", () => {
    it("collapses an expanded item and emits cf-accordion-toggle", async () => {
      const element = await item({ expanded: true });
      expect(toggles(element, () => element.collapse())).toEqual([
        { value: "a", expanded: false },
      ]);
      expect(element.expanded).toBe(false);
    });

    it("emits nothing for an item already collapsed", async () => {
      const element = await item();
      expect(toggles(element, () => element.collapse())).toEqual([]);
    });

    it("leaves a disabled item expanded", async () => {
      const element = await item({ expanded: true, disabled: true });
      expect(toggles(element, () => element.collapse())).toEqual([]);
      expect(element.expanded).toBe(true);
    });
  });

  describe("toggle()", () => {
    it("emits nothing for a disabled item", async () => {
      const element = await item({ disabled: true });
      expect(toggles(element, () => element.toggle())).toEqual([]);
    });
  });
});
