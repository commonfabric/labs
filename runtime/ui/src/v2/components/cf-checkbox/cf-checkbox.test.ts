/**
 * Tests for CFCheckbox component
 */

// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  holdReads,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFForm } from "../form/index.ts";
import { CFCheckbox } from "./index.ts";

/** A checkbox with `properties` set, mounted in the document. */
function checkbox(
  properties: Partial<
    Pick<
      CFCheckbox,
      "checked" | "disabled" | "indeterminate" | "required"
    >
  > = {},
): Promise<CFCheckbox> {
  return mount(Object.assign(new CFCheckbox(), properties));
}

/** A checkbox with `properties` set, mounted inside a `cf-form`. */
async function checkboxInForm(
  properties: Partial<Pick<CFCheckbox, "checked" | "disabled" | "required">>,
): Promise<{ form: CFForm; element: CFCheckbox }> {
  const form = new CFForm();
  const element = Object.assign(new CFCheckbox(), properties);
  form.append(element);
  await mount(form);
  await element.updateComplete;
  return { form, element };
}

/** The values written to `cell` so far. */
function written(cell: CellHandle<boolean>): unknown[] {
  return writesSent(cell).map((write) => write.value);
}

/** The box `element` renders. */
function box(element: CFCheckbox): Element {
  const found = element.shadowRoot!.querySelector(".checkbox");
  if (!found) throw new Error("cf-checkbox rendered no box");
  return found;
}

/** A keydown of `key` sent to `element`, reporting whether it was handled. */
function pressKey(element: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The details of the `type` events `target` emits while `act()` runs. */
async function emitted(
  target: HTMLElement,
  type: string,
  act: () => void,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  target.addEventListener(type, listener);
  try {
    act();
    await settle();
  } finally {
    target.removeEventListener(type, listener);
  }
  return seen;
}

describe("CFCheckbox", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFCheckbox).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-checkbox")).toBe(CFCheckbox);
  });

  it("should create element instance", () => {
    const element = new CFCheckbox();
    expect(element).toBeInstanceOf(CFCheckbox);
  });

  it("should not set attributes in constructor (custom element spec)", () => {
    // The custom element spec forbids setAttribute during construction.
    // Attributes are set in connectedCallback instead.
    const element = new CFCheckbox();
    expect(element.getAttribute("exportparts")).toBeNull();
    expect(element.getAttribute("role")).toBeNull();
  });

  it("should be creatable via document.createElement", async () => {
    const element = document.createElement("cf-checkbox") as CFCheckbox;
    await mount(element);

    expect(element).toBeInstanceOf(CFCheckbox);
    expect(element.getAttribute("role")).toBe("checkbox");
    expect(element.getAttribute("exportparts")).toBe("checkbox,checkmark");
  });

  it("keeps a role and exported parts the page gave it", async () => {
    const element = new CFCheckbox();
    element.setAttribute("role", "switch");
    element.setAttribute("exportparts", "checkbox");
    await mount(element);

    expect(element.getAttribute("role")).toBe("switch");
    expect(element.getAttribute("exportparts")).toBe("checkbox");
  });

  it("should have default properties", () => {
    const element = new CFCheckbox();
    expect(element.checked).toBe(false);
    expect(element.disabled).toBe(false);
    expect(element.indeterminate).toBe(false);
    expect(element.required).toBe(false);
  });

  describe("render()", () => {
    it("renders a checked box for a checked value", async () => {
      const element = await checkbox({ checked: true });

      expect(box(element).classList.contains("checked")).toBe(true);
      expect(element.getAttribute("aria-checked")).toBe("true");
    });

    it("renders an unchecked box for an unchecked value, with no native input of its own", async () => {
      const element = await checkbox();

      expect(element.shadowRoot!.querySelector("input")).toBeNull();
      expect(box(element).classList.contains("checked")).toBe(false);
      expect(element.getAttribute("aria-checked")).toBe("false");
    });

    it("renders the mixed state over the checked one when indeterminate", async () => {
      const element = await checkbox({ checked: true, indeterminate: true });

      expect(box(element).classList.contains("indeterminate")).toBe(true);
      expect(box(element).classList.contains("checked")).toBe(false);
      expect(element.getAttribute("aria-checked")).toBe("mixed");
    });

    it("renders a disabled box when disabled", async () => {
      const element = await checkbox({ disabled: true });

      expect(box(element).classList.contains("disabled")).toBe(true);
    });
  });

  describe("click", () => {
    // A click toggles what the cell holds. A cell that has not answered holds
    // nothing, which is not unchecked: toggled, it would write `true` over a
    // value nobody was shown.
    it("writes nothing while the cell's read has not been answered", async () => {
      const checked = createMockCellHandle<boolean>();
      holdReads(checked);
      const element = await checkbox({ checked });

      element.click();
      await settle();

      expect(written(checked)).toEqual([]);
    });

    it("writes what the worker's answer toggles to", async () => {
      const checked = createMockCellHandle<boolean>(true);
      const element = await checkbox({ checked });

      element.click();
      await settle();

      expect(written(checked)).toEqual([false]);
    });

    it("emits cf-change with the state it toggles to", async () => {
      const element = await checkbox();

      const seen = await emitted(element, "cf-change", () => element.click());

      expect(seen).toEqual([{ checked: true, indeterminate: false }]);
    });

    it("shows the state it toggles a bound cell to", async () => {
      const element = await checkbox({ checked: createMockCellHandle(false) });

      element.click();
      await settle();
      await element.updateComplete;

      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(box(element).classList.contains("checked")).toBe(true);
    });

    it("leaves the mixed state", async () => {
      const element = await checkbox({ indeterminate: true });

      element.click();
      await element.updateComplete;

      expect(element.indeterminate).toBe(false);
      expect(element.hasAttribute("indeterminate")).toBe(false);
    });

    it("writes nothing, and stops the click, when disabled", async () => {
      const checked = createMockCellHandle(false);
      const element = await checkbox({ checked, disabled: true });
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });

      element.dispatchEvent(event);
      await settle();

      expect(written(checked)).toEqual([]);
      expect(event.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
    });

    it("writes nothing once the checkbox leaves the document", async () => {
      const checked = createMockCellHandle(false);
      const element = await checkbox({ checked });

      element.remove();
      element.click();
      await settle();

      expect(written(checked)).toEqual([]);
    });
  });

  describe("keyboard", () => {
    it("toggles on Space, and takes the key", async () => {
      for (const key of [" ", "Spacebar"]) {
        const checked = createMockCellHandle(false);
        const element = await checkbox({ checked });

        const handled = pressKey(element, key);
        await settle();

        expect(handled).toBe(true);
        expect(written(checked)).toEqual([true]);
      }
    });

    it("leaves Enter alone", async () => {
      const checked = createMockCellHandle(false);
      const element = await checkbox({ checked });

      const handled = pressKey(element, "Enter");
      await settle();

      expect(handled).toBe(false);
      expect(written(checked)).toEqual([]);
    });

    it("leaves Space alone when disabled", async () => {
      const checked = createMockCellHandle(false);
      const element = await checkbox({ checked, disabled: true });

      const handled = pressKey(element, " ");
      await settle();

      expect(handled).toBe(false);
      expect(written(checked)).toEqual([]);
    });
  });

  describe("in a cf-form", () => {
    it("shows a click at once and writes it only when the form submits", async () => {
      const checked = createMockCellHandle(false);
      const { form, element } = await checkboxInForm({ checked });

      element.click();
      await element.updateComplete;

      expect(written(checked)).toEqual([]);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(box(element).classList.contains("checked")).toBe(true);

      form.submit();
      await settle();

      expect(written(checked)).toEqual([true]);
    });

    it("keeps the form from submitting while a required checkbox is unchecked", async () => {
      const { form, element } = await checkboxInForm({ required: true });

      const invalid = await emitted(
        form,
        "cf-form-invalid",
        () => form.submit(),
      );

      expect(invalid).toEqual([{
        errors: [{ element, message: "This checkbox is required" }],
      }]);
    });

    it("lets the form submit once a required checkbox is checked", async () => {
      const { form, element } = await checkboxInForm({ required: true });
      element.click();

      const submitted = await emitted(form, "cf-submit", () => form.submit());

      expect(submitted).toHaveLength(1);
    });

    it("lets the form submit with a required checkbox that is disabled", async () => {
      const { form } = await checkboxInForm({ required: true, disabled: true });

      const submitted = await emitted(form, "cf-submit", () => form.submit());

      expect(submitted).toHaveLength(1);
    });
  });
});
