// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFListItem } from "./index.ts";

/**
 * An item mounted with `properties`, with the details of the `cf-click` and
 * `cf-expand` events it fires.
 */
async function itemWith(properties: Partial<CFListItem> = {}) {
  const element = Object.assign(new CFListItem(), properties);
  const clicks: unknown[] = [];
  const expansions: unknown[] = [];
  element.addEventListener("cf-click", (event) => {
    if (event instanceof CustomEvent) clicks.push(event.detail);
  });
  element.addEventListener("cf-expand", (event) => {
    if (event instanceof CustomEvent) expansions.push(event.detail);
  });
  return { element: await mount(element), clicks, expansions };
}

const part = (element: CFListItem, name: string) =>
  element.shadowRoot!.querySelector(`[part="${name}"]`);

/** How many elements in the item's shadow root match `selector`. */
const count = (element: CFListItem, selector: string) =>
  element.shadowRoot!.querySelectorAll(selector).length;

const button = (element: CFListItem) =>
  element.shadowRoot!.querySelector("button")!;

/** Whether the area `name` is hidden for having nothing to show. */
const isEmpty = (element: CFListItem, name: string) =>
  part(element, name)!.classList.contains("empty");

describe("CFListItem", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-list-item`", () => {
    expect(customElements.get("cf-list-item")).toBe(CFListItem);
  });

  describe("render()", () => {
    it("shows the label and description where nothing is slotted in their place", async () => {
      const { element } = await itemWith({
        label: "New Project",
        description: "Create a new project",
      });

      expect(part(element, "label")!.textContent!.trim()).toBe("New Project");
      expect(part(element, "description")!.textContent!.trim()).toBe(
        "Create a new project",
      );
      expect(isEmpty(element, "description")).toBe(false);
    });

    it("hides the icon, description and action areas while they are empty", async () => {
      const { element } = await itemWith({ label: "Settings" });

      expect(isEmpty(element, "icon")).toBe(true);
      expect(isEmpty(element, "description")).toBe(true);
      expect(isEmpty(element, "action")).toBe(true);
    });

    it("shows a chevron and a detail area only when expandable", async () => {
      const { element } = await itemWith({ label: "Settings" });
      expect(count(element, '[part="chevron"], [part="detail"]')).toBe(0);

      element.expandable = true;
      await element.updateComplete;
      expect(part(element, "chevron")!.textContent).toBe("›");
      expect(isEmpty(element, "detail")).toBe(true);
    });

    it("disables its button when disabled", async () => {
      const { element } = await itemWith({ disabled: true });

      expect(button(element).disabled).toBe(true);
      expect(element.hasAttribute("disabled")).toBe(true);
    });
  });

  describe("a click", () => {
    it("announces the label, and leaves a row that is not expandable unexpanded", async () => {
      const { element, clicks, expansions } = await itemWith({
        label: "Settings",
      });

      button(element).click();

      expect(clicks).toEqual([{ label: "Settings" }]);
      expect(expansions).toEqual([]);
      expect(element.expanded).toBe(false);
    });

    it("toggles an expandable row, reflecting and announcing the new state", async () => {
      const { element, clicks, expansions } = await itemWith({
        expandable: true,
      });

      button(element).click();
      await element.updateComplete;
      expect(element.hasAttribute("expanded")).toBe(true);

      button(element).click();
      await element.updateComplete;
      expect(element.hasAttribute("expanded")).toBe(false);

      expect(expansions).toEqual([{ expanded: true }, { expanded: false }]);
      expect(clicks).toHaveLength(2);
    });

    it("does nothing on a row disabled before its button is", async () => {
      // The button takes no clicks once it renders disabled; until then, the
      // row's own state is what stops one.
      const { element, clicks, expansions } = await itemWith({
        expandable: true,
      });

      element.disabled = true;
      button(element).click();

      expect(element.expanded).toBe(false);
      expect(clicks).toEqual([]);
      expect(expansions).toEqual([]);
    });
  });

  describe("slotted content", () => {
    for (const area of ["icon", "description", "action", "detail"]) {
      it(`shows the ${area} area while an element is slotted into it`, async () => {
        const { element } = await itemWith({ expandable: true });
        const slot = element.shadowRoot!.querySelector<HTMLSlotElement>(
          `slot[name="${area}"]`,
        )!;
        const content = document.createElement("span");
        content.slot = area;

        element.append(content);
        slot.dispatchEvent(new CustomEvent("slotchange"));
        await element.updateComplete;
        expect(isEmpty(element, area)).toBe(false);

        content.remove();
        slot.dispatchEvent(new CustomEvent("slotchange"));
        await element.updateComplete;
        expect(isEmpty(element, area)).toBe(true);
      });
    }
  });
});
