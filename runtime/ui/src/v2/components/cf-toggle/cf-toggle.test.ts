// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFToggle } from "./index.ts";

/** A toggle mounted with `properties`, and every `cf-change` it fires. */
async function toggleWith(properties: Partial<CFToggle> = {}) {
  const element = Object.assign(new CFToggle(), properties);
  const changes: unknown[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  return { element: await mount(element), changes };
}

const button = (element: CFToggle) =>
  element.shadowRoot!.querySelector("button")!;

describe("CFToggle", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-toggle`", () => {
    expect(customElements.get("cf-toggle")).toBe(CFToggle);
  });

  describe("connected", () => {
    it("exposes itself as an unpressed, focusable button", async () => {
      const { element } = await toggleWith();
      expect(element.getAttribute("role")).toBe("button");
      expect(element.getAttribute("exportparts")).toBe("toggle");
      expect(element.getAttribute("aria-pressed")).toBe("false");
      expect(element.getAttribute("aria-disabled")).toBe("false");
      expect(element.tabIndex).toBe(0);
    });

    it("keeps a role and exported parts the page gave it", async () => {
      const element = new CFToggle();
      element.setAttribute("role", "switch");
      element.setAttribute("exportparts", "toggle: chip");
      await mount(element);
      expect(element.getAttribute("role")).toBe("switch");
      expect(element.getAttribute("exportparts")).toBe("toggle: chip");
    });

    it("takes a disabled toggle out of the tab order", async () => {
      const { element } = await toggleWith({ disabled: true });
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.tabIndex).toBe(-1);
      expect(button(element).disabled).toBe(true);
    });
  });

  describe("render()", () => {
    it("classes the inner button by variant, size, and pressed state", async () => {
      const { element } = await toggleWith({
        pressed: true,
        variant: "outline",
        size: "lg",
      });
      expect([...button(element).classList].sort()).toEqual([
        "pressed",
        "size-lg",
        "toggle",
        "variant-outline",
      ]);
    });

    it("falls back to the default variant and size for unknown ones", async () => {
      const { element } = await toggleWith({
        // @ts-expect-error: a page can set any string as the attribute.
        variant: "loud",
        // @ts-expect-error: as above.
        size: "huge",
      });
      expect(element.variant).toBe("default");
      expect(element.size).toBe("md");
      expect(button(element).classList.contains("variant-default")).toBe(true);
      expect(button(element).classList.contains("size-md")).toBe(true);
    });
  });

  describe("a click", () => {
    it("flips the pressed state, reflects it, and announces it", async () => {
      const { element, changes } = await toggleWith();
      element.click();
      await element.updateComplete;
      expect(element.pressed).toBe(true);
      expect(element.hasAttribute("pressed")).toBe(true);
      expect(element.getAttribute("aria-pressed")).toBe("true");

      element.click();
      await element.updateComplete;
      expect(element.pressed).toBe(false);
      expect(changes).toEqual([{ pressed: true }, { pressed: false }]);
    });

    it("does nothing on a disabled toggle, and goes no further", async () => {
      const { element, changes } = await toggleWith({ disabled: true });
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
      expect(element.pressed).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  describe("a key press", () => {
    for (const key of [" ", "Enter"]) {
      it(`flips the pressed state on ${JSON.stringify(key)}`, async () => {
        const { element, changes } = await toggleWith();
        const press = new KeyboardEvent("keydown", { key, cancelable: true });
        element.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        expect(element.pressed).toBe(true);
        expect(changes).toEqual([{ pressed: true }]);
      });
    }

    it("ignores other keys", async () => {
      const { element, changes } = await toggleWith();
      const press = new KeyboardEvent("keydown", {
        key: "a",
        cancelable: true,
      });
      element.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
      expect(element.pressed).toBe(false);
      expect(changes).toEqual([]);
    });

    it("ignores every key on a disabled toggle", async () => {
      const { element, changes } = await toggleWith({ disabled: true });
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(element.pressed).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  describe("toggle()", () => {
    it("flips the pressed state without announcing it", async () => {
      const { element, changes } = await toggleWith();
      element.toggle();
      expect(element.pressed).toBe(true);
      expect(changes).toEqual([]);
    });

    it("leaves a disabled toggle as it is", async () => {
      const { element } = await toggleWith({ disabled: true, pressed: true });
      element.toggle();
      expect(element.pressed).toBe(true);
    });
  });

  describe("disconnected", () => {
    it("stops answering clicks", async () => {
      const { element, changes } = await toggleWith();
      element.remove();
      element.click();
      expect(element.pressed).toBe(false);
      expect(changes).toEqual([]);
    });
  });
});
