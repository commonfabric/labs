// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import "../cf-radio-group/index.ts";
import { CFRadio } from "./index.ts";

/**
 * A radio mounted with `properties`, inside `parent` when one is given, with
 * the details of the `cf-change` events it fires.
 */
async function radioWith(
  properties: Partial<CFRadio> = {},
  parent: HTMLElement = document.body,
) {
  const element = Object.assign(new CFRadio(), { value: "yes" }, properties);
  const changes: unknown[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  parent.append(element);
  await element.updateComplete;
  return { element, changes };
}

const circle = (element: CFRadio) =>
  element.shadowRoot!.querySelector(".radio")!;

const hiddenInput = (element: CFRadio) =>
  element.shadowRoot!.querySelector("input")!;

function click(): MouseEvent {
  return new MouseEvent("click", { bubbles: true, cancelable: true });
}

describe("CFRadio", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-radio`", () => {
    expect(customElements.get("cf-radio")).toBe(CFRadio);
  });

  describe("connected", () => {
    it("exposes itself as an unchecked, focusable radio", async () => {
      const { element } = await radioWith();

      expect(element.getAttribute("role")).toBe("radio");
      expect(element.getAttribute("exportparts")).toBe("radio,indicator");
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(element.getAttribute("aria-disabled")).toBe("false");
      expect(element.tabIndex).toBe(0);
    });

    it("keeps a role and exported parts the page gave it", async () => {
      const element = new CFRadio();
      element.setAttribute("role", "menuitemradio");
      element.setAttribute("exportparts", "radio: dot");
      await mount(element);

      expect(element.getAttribute("role")).toBe("menuitemradio");
      expect(element.getAttribute("exportparts")).toBe("radio: dot");
    });

    it("takes a disabled radio out of the tab order", async () => {
      const { element } = await radioWith({ disabled: true });

      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.tabIndex).toBe(-1);
    });
  });

  describe("render()", () => {
    it("shows an empty circle, and a hidden input with the radio's value", async () => {
      const { element } = await radioWith({ value: "small" });

      expect([...circle(element).classList]).toEqual(["radio"]);
      expect(hiddenInput(element).checked).toBe(false);
      expect(hiddenInput(element).value).toBe("small");
      expect(hiddenInput(element).hasAttribute("name")).toBe(false);
    });

    it("marks the circle and the hidden input checked and disabled", async () => {
      const { element } = await radioWith({
        checked: true,
        disabled: true,
        name: "size",
      });

      expect([...circle(element).classList]).toEqual([
        "radio",
        "checked",
        "disabled",
      ]);
      expect(hiddenInput(element).checked).toBe(true);
      expect(hiddenInput(element).disabled).toBe(true);
      expect(hiddenInput(element).name).toBe("size");
    });

    it("reports a change of state to assistive technology", async () => {
      const { element } = await radioWith();

      element.checked = true;
      await element.updateComplete;

      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(element.hasAttribute("checked")).toBe(true);
    });
  });

  describe("a click", () => {
    it("checks a radio outside a group, and announces it", async () => {
      const { element, changes } = await radioWith();

      element.click();
      await element.updateComplete;

      expect(element.checked).toBe(true);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(changes).toEqual([{ checked: true, value: "yes" }]);
    });

    it("sends a radio in a group to the group, leaving the radio as it was", async () => {
      const group = document.createElement("cf-radio-group");
      document.body.append(group);
      const sent: boolean[] = [];
      group.addEventListener(
        "radio-click",
        (event) => sent.push(event.detail.radio === element),
      );
      const { element, changes } = await radioWith({}, group);

      element.click();

      expect(sent).toEqual([true]);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    it("does nothing on a disabled radio, and goes no further", async () => {
      const { element, changes } = await radioWith({ disabled: true });
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const event = click();

      element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    it("does nothing on a radio that is already checked", async () => {
      const { element, changes } = await radioWith({ checked: true });
      const event = click();

      element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(element.checked).toBe(true);
      expect(changes).toEqual([]);
    });
  });

  describe("a key press", () => {
    function press(element: CFRadio, key: string): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event;
    }

    it("checks the radio on Space", async () => {
      const { element, changes } = await radioWith();

      const event = press(element, " ");

      expect(event.defaultPrevented).toBe(true);
      expect(element.checked).toBe(true);
      expect(changes).toEqual([{ checked: true, value: "yes" }]);
    });

    it("leaves the radio unchecked on Enter", async () => {
      const { element, changes } = await radioWith();

      const event = press(element, "Enter");

      expect(event.defaultPrevented).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    it("leaves a disabled radio alone on Space", async () => {
      const { element, changes } = await radioWith({ disabled: true });

      const event = press(element, " ");

      expect(event.defaultPrevented).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  it("stops listening once removed from the page", async () => {
    const { element, changes } = await radioWith();

    element.remove();
    element.click();

    expect(element.checked).toBe(false);
    expect(changes).toEqual([]);
  });
});
