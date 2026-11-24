// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFCollapsible } from "./index.ts";

/** A mounted collapsible with a trigger button and a paragraph of content. */
async function mountCollapsible(
  init: { open?: boolean; disabled?: boolean } = {},
): Promise<{
  element: CFCollapsible;
  trigger: HTMLButtonElement;
  body: HTMLParagraphElement;
  toggles: boolean[];
}> {
  const element = new CFCollapsible();
  Object.assign(element, init);
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "More";
  const body = document.createElement("p");
  body.textContent = "Details";
  element.append(trigger, body);
  const toggles: boolean[] = [];
  element.addEventListener("cf-toggle", (event) => {
    toggles.push((event as CustomEvent<{ open: boolean }>).detail.open);
  });
  await mount(element);
  return { element, trigger, body, toggles };
}

/** The element in `element`'s shadow root that `selector` names. */
function part(element: CFCollapsible, selector: string): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector} rendered`);
  return found;
}

describe("CFCollapsible", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-collapsible")).toBe(CFCollapsible);
  });

  describe("constructor()", () => {
    it("starts closed and enabled", () => {
      const element = new CFCollapsible();
      expect(element.open).toBe(false);
      expect(element.disabled).toBe(false);
    });
  });

  describe("rendering", () => {
    it("marks the slotted trigger as a button reporting whether it is expanded", async () => {
      const { trigger } = await mountCollapsible();
      expect(trigger.getAttribute("role")).toBe("button");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(trigger.getAttribute("aria-controls")).toBe(
        "collapsible-content",
      );
      expect(trigger.hasAttribute("aria-disabled")).toBe(false);
      expect(trigger.style.cursor).toBe("pointer");
    });

    it("marks the slotted trigger of a disabled collapsible as disabled", async () => {
      const { trigger } = await mountCollapsible({ disabled: true });
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.style.cursor).toBe("not-allowed");
    });

    it("marks a trigger slotted after the first render", async () => {
      const { element } = await mountCollapsible({ open: true });
      const late = document.createElement("button");
      late.slot = "trigger";
      element.append(late);
      // The slot reports its new element with `slotchange`.
      part(element, 'slot[name="trigger"]').dispatchEvent(
        new Event("slotchange"),
      );
      expect(late.getAttribute("role")).toBe("button");
      expect(late.getAttribute("aria-expanded")).toBe("true");
    });

    it("leaves a slotted trigger that is not an HTML element unmarked", async () => {
      const element = new CFCollapsible();
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("slot", "trigger");
      element.append(icon);
      await mount(element);
      expect(icon.hasAttribute("role")).toBe(false);
      expect(icon.hasAttribute("aria-expanded")).toBe(false);
    });

    it("reflects `open` and `disabled` as classes on the base part", async () => {
      const { element } = await mountCollapsible({ open: true });
      const base = part(element, '[part="base"]');
      expect(base.classList.contains("open")).toBe(true);
      expect(base.classList.contains("disabled")).toBe(false);

      element.open = false;
      element.disabled = true;
      await element.updateComplete;
      expect(base.classList.contains("open")).toBe(false);
      expect(base.classList.contains("disabled")).toBe(true);
    });

    it("sizes the content wrapper to the content while open, and to zero while closed", async () => {
      const element = new CFCollapsible();
      await mount(element);
      // happy-dom lays nothing out, so the content is given a height.
      Object.defineProperty(part(element, ".content"), "scrollHeight", {
        value: 120,
      });
      const wrapper = part(element, ".content-wrapper");
      expect(wrapper.style.height).toBe("0px");

      element.open = true;
      await element.updateComplete;
      expect(wrapper.style.height).toBe("120px");

      element.open = false;
      await element.updateComplete;
      expect(wrapper.style.height).toBe("0px");
    });

    it("updates the trigger when `open` or `disabled` changes", async () => {
      const { element, trigger } = await mountCollapsible();

      element.open = true;
      await element.updateComplete;
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      element.disabled = true;
      await element.updateComplete;
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.style.cursor).toBe("not-allowed");

      element.disabled = false;
      await element.updateComplete;
      expect(trigger.hasAttribute("aria-disabled")).toBe(false);
      expect(trigger.style.cursor).toBe("pointer");
    });
  });

  describe("clicks", () => {
    it("toggles on a click on the slotted trigger", async () => {
      const { element, trigger, toggles } = await mountCollapsible();

      trigger.click();
      expect(element.open).toBe(true);
      trigger.click();
      expect(element.open).toBe(false);
      expect(toggles).toEqual([true, false]);
    });

    it("toggles on a click on the indicator beside the trigger", async () => {
      const { element, toggles } = await mountCollapsible();
      part(element, ".indicator").click();
      expect(element.open).toBe(true);
      expect(toggles).toEqual([true]);
    });

    it("cancels the click it toggles on", async () => {
      const { trigger } = await mountCollapsible();
      const click = new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      trigger.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    });

    it("does not toggle on a click on the content", async () => {
      const { element, body, toggles } = await mountCollapsible();
      const click = new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      body.dispatchEvent(click);
      expect(element.open).toBe(false);
      expect(click.defaultPrevented).toBe(false);
      expect(toggles).toEqual([]);
    });

    it("does not toggle while disabled", async () => {
      const { element, trigger, toggles } = await mountCollapsible({
        disabled: true,
      });
      trigger.click();
      expect(element.open).toBe(false);
      expect(toggles).toEqual([]);
    });

    it("does not toggle once removed from the document", async () => {
      const { element, trigger, toggles } = await mountCollapsible();
      element.remove();
      trigger.click();
      expect(element.open).toBe(false);
      expect(toggles).toEqual([]);
    });
  });

  describe("instance members", () => {
    describe("toggle()", () => {
      it("flips `open` and dispatches `cf-toggle` with the new state", async () => {
        const { element, toggles } = await mountCollapsible();
        element.toggle();
        expect(element.open).toBe(true);
        element.toggle();
        expect(element.open).toBe(false);
        expect(toggles).toEqual([true, false]);
      });

      it("does nothing while disabled", async () => {
        const { element, toggles } = await mountCollapsible({ disabled: true });
        element.toggle();
        expect(element.open).toBe(false);
        expect(toggles).toEqual([]);
      });
    });

    describe("expand()", () => {
      it("opens a closed collapsible and dispatches `cf-toggle`", async () => {
        const { element, toggles } = await mountCollapsible();
        element.expand();
        expect(element.open).toBe(true);
        expect(toggles).toEqual([true]);
      });

      it("does nothing to an open collapsible", async () => {
        const { element, toggles } = await mountCollapsible({ open: true });
        element.expand();
        expect(element.open).toBe(true);
        expect(toggles).toEqual([]);
      });

      it("does nothing while disabled", async () => {
        const { element, toggles } = await mountCollapsible({ disabled: true });
        element.expand();
        expect(element.open).toBe(false);
        expect(toggles).toEqual([]);
      });
    });

    describe("collapse()", () => {
      it("closes an open collapsible and dispatches `cf-toggle`", async () => {
        const { element, toggles } = await mountCollapsible({ open: true });
        element.collapse();
        expect(element.open).toBe(false);
        expect(toggles).toEqual([false]);
      });

      it("does nothing to a closed collapsible", async () => {
        const { element, toggles } = await mountCollapsible();
        element.collapse();
        expect(element.open).toBe(false);
        expect(toggles).toEqual([]);
      });

      it("does nothing while disabled", async () => {
        const { element, toggles } = await mountCollapsible({
          open: true,
          disabled: true,
        });
        element.collapse();
        expect(element.open).toBe(true);
        expect(toggles).toEqual([]);
      });
    });
  });
});
