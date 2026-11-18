// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFCard } from "./index.ts";

/** A card holding `children`, mounted in the document. */
function card(
  children: (string | Node)[] = [],
  clickable = false,
): Promise<CFCard> {
  const element = new CFCard();
  element.clickable = clickable;
  element.append(...children);
  return mount(element);
}

/** A `tag` element assigned to the slot `slot`. */
function slotted(slot: string, tag = "div"): HTMLElement {
  const element = document.createElement(tag);
  element.slot = slot;
  element.textContent = slot;
  return element;
}

/** The part of `element`'s shadow tree that `selector` names. */
function part(element: CFCard, selector: string): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`cf-card rendered no ${selector}`);
  return found;
}

/** Whether `element` hides the part that `selector` names as empty. */
function hidden(element: CFCard, selector: string): boolean {
  return part(element, selector).classList.contains("empty");
}

/** The `cf-card-click` events `element` emits while `act()` runs. */
function clicks(element: CFCard, act: () => void): unknown[] {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  element.addEventListener("cf-card-click", listener);
  try {
    act();
  } finally {
    element.removeEventListener("cf-card-click", listener);
  }
  return seen;
}

/** A keydown of `key` sent to `element`, reporting whether it was handled. */
function pressKey(element: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("cf-card", () => {
  afterEach(() => document.body.replaceChildren());

  describe("sections", () => {
    it("hides every section of a card holding nothing", async () => {
      const element = await card();
      expect(hidden(element, ".card-header")).toBe(true);
      expect(hidden(element, ".card-title-wrapper")).toBe(true);
      expect(hidden(element, ".card-content")).toBe(true);
      expect(hidden(element, ".card-footer")).toBe(true);
    });

    it("shows the sections that hold slotted content, and only those", async () => {
      const element = await card([slotted("header"), slotted("footer")]);
      expect(hidden(element, ".card-header")).toBe(false);
      expect(hidden(element, ".card-content")).toBe(true);
      expect(hidden(element, ".card-footer")).toBe(false);
    });

    it("shows the content section for children in the default slot", async () => {
      const element = await card([document.createElement("p")]);
      expect(hidden(element, ".card-content")).toBe(false);
    });

    it("shows the content section for the content slot", async () => {
      const element = await card([slotted("content")]);
      expect(hidden(element, ".card-content")).toBe(false);
    });

    it("treats whitespace-only text as no content", async () => {
      const element = await card(["  \n  "]);
      expect(hidden(element, ".card-content")).toBe(true);
    });

    it("treats text with characters in it as content", async () => {
      const element = await card(["Hello"]);
      expect(hidden(element, ".card-content")).toBe(false);
    });

    it("shows the header and its title row for a title or an action", async () => {
      for (const name of ["title", "action"]) {
        const element = await card([slotted(name)]);
        expect(hidden(element, ".card-header")).toBe(false);
        expect(hidden(element, ".card-title-wrapper")).toBe(false);
      }
    });

    it("shows the header without its title row for a description alone", async () => {
      const element = await card([slotted("description")]);
      expect(hidden(element, ".card-header")).toBe(false);
      expect(hidden(element, ".card-title-wrapper")).toBe(true);
    });

    it("shows a section when content is slotted into it after rendering", async () => {
      const element = await card();
      const footer = slotted("footer");
      element.append(footer);
      await settle();
      expect(hidden(element, ".card-footer")).toBe(false);
    });
  });

  describe("clickable", () => {
    it("makes the card a focusable button only when clickable", async () => {
      const plain = await card();
      expect(part(plain, ".card").hasAttribute("role")).toBe(false);
      expect(part(plain, ".card").hasAttribute("tabindex")).toBe(false);

      const clickable = await card([], true);
      expect(part(clickable, ".card").getAttribute("role")).toBe("button");
      expect(part(clickable, ".card").getAttribute("tabindex")).toBe("0");
    });

    it("emits cf-card-click when a clickable card is clicked", async () => {
      const element = await card([], true);
      expect(clicks(element, () => element.click())).toEqual([
        { clickable: true },
      ]);
    });

    it("emits nothing when a card that is not clickable is clicked", async () => {
      const element = await card();
      expect(clicks(element, () => element.click())).toEqual([]);
    });

    it("emits cf-card-click for Enter and Space, and takes those keys", async () => {
      const element = await card([], true);
      let handled: boolean[] = [];
      const seen = clicks(element, () => {
        handled = ["Enter", " ", "a"].map((key) => pressKey(element, key));
      });
      expect(seen).toEqual([{ clickable: true }, { clickable: true }]);
      expect(handled).toEqual([true, true, false]);
    });

    it("ignores Enter on a card that is not clickable", async () => {
      const element = await card();
      let handled = true;
      const seen = clicks(element, () => {
        handled = pressKey(element, "Enter");
      });
      expect(seen).toEqual([]);
      expect(handled).toBe(false);
    });

    it("starts and stops responding as clickable is turned on and off", async () => {
      const element = await card();
      element.clickable = true;
      await element.updateComplete;
      expect(clicks(element, () => element.click())).toEqual([
        { clickable: true },
      ]);

      element.clickable = false;
      await element.updateComplete;
      expect(clicks(element, () => element.click())).toEqual([]);
    });
  });

  describe("focus()", () => {
    it("focuses the card of a clickable card", async () => {
      const element = await card([], true);
      element.focus();
      expect(element.shadowRoot!.activeElement).toBe(part(element, ".card"));
    });

    it("leaves focus where it was for a card that is not clickable", async () => {
      const element = await card();
      element.focus();
      expect(element.shadowRoot!.activeElement).toBeNull();
    });
  });

  describe("blur()", () => {
    it("takes focus away from a focused card", async () => {
      const element = await card([], true);
      element.focus();
      expect(element.shadowRoot!.activeElement).toBe(part(element, ".card"));
      element.blur();
      expect(element.shadowRoot!.activeElement).toBeNull();
    });
  });
});
