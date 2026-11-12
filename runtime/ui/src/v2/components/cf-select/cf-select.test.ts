// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFForm } from "../form/index.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFSelect, type SelectItem } from "./index.ts";

const FRUIT: SelectItem[] = [
  { label: "Apple", value: "apple" },
  { label: "Banana", value: "banana" },
  { label: "Cherry", value: "cherry" },
];

/** A select mounted with `properties`, and every `cf-change` it fires. */
async function selectWith(properties: Partial<CFSelect> = {}) {
  const element = Object.assign(new CFSelect(), properties);
  const changes: unknown[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  return { element: await mount(element), changes };
}

const select = (element: CFSelect) =>
  element.shadowRoot!.querySelector("select")!;

/** The labels of the options a person can pick, in order. */
const labels = (element: CFSelect) =>
  [...select(element).querySelectorAll("option:not([value=''])")].map(
    (option) => option.textContent!.trim(),
  );

/** Picks the options at `indexes` as a person does, firing `change`. */
function pick(element: CFSelect, ...indexes: number[]): void {
  for (const option of select(element).options) {
    option.selected = indexes.includes(Number(option.dataset.index ?? -1));
  }
  select(element).dispatchEvent(new Event("change", { bubbles: true }));
}

const written = (cell: CellHandle<unknown>) =>
  writesSent(cell).map((write) => write.value);

describe("CFSelect", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-select`", () => {
    expect(customElements.get("cf-select")).toBe(CFSelect);
  });

  describe("connected", () => {
    it("exposes itself as a focusable combobox", async () => {
      const { element } = await selectWith();
      expect(element.getAttribute("role")).toBe("combobox");
      expect(element.getAttribute("exportparts")).toBe("select");
      expect(element.getAttribute("aria-disabled")).toBe("false");
      expect(element.getAttribute("aria-required")).toBe("false");
      expect(element.tabIndex).toBe(0);
    });

    it("exposes a multiple select as a listbox, and follows `multiple` as it changes", async () => {
      const { element } = await selectWith({ multiple: true, value: [] });
      expect(element.getAttribute("role")).toBe("listbox");
      element.multiple = false;
      await element.updateComplete;
      expect(element.getAttribute("role")).toBe("combobox");
    });

    it("keeps a role and exported parts the page gave it", async () => {
      const element = new CFSelect();
      element.setAttribute("role", "menu");
      element.setAttribute("exportparts", "select: picker");
      await mount(element);
      element.multiple = true;
      await element.updateComplete;
      expect(element.getAttribute("role")).toBe("menu");
      expect(element.getAttribute("exportparts")).toBe("select: picker");
    });

    it("takes a disabled select out of the tab order, and marks a required one", async () => {
      const { element } = await selectWith({ disabled: true, required: true });
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.getAttribute("aria-required")).toBe("true");
      expect(element.tabIndex).toBe(-1);
      expect(select(element).disabled).toBe(true);
      expect(select(element).required).toBe(true);
    });
  });

  describe("render()", () => {
    it("draws an option for each item, skipping missing ones", async () => {
      const { element } = await selectWith({
        items: [FRUIT[0], undefined, { ...FRUIT[1], disabled: true }],
      });
      expect(labels(element)).toEqual(["Apple", "Banana"]);
      const options = select(element).querySelectorAll("option[data-index]");
      expect([...options].map((option) => option.getAttribute("value")))
        .toEqual(["0", "1"]);
      expect([...options].map((option) => option.hasAttribute("disabled")))
        .toEqual([false, true]);
    });

    it("draws no options for no items", async () => {
      const { element } = await selectWith({ items: undefined });
      expect(labels(element)).toEqual([]);
    });

    it("wraps grouped items in an `optgroup` per group", async () => {
      const { element } = await selectWith({
        items: [
          { label: "Red", value: "red", group: "Colors" },
          { label: "Circle", value: "circle", group: "Shapes" },
          { label: "Blue", value: "blue", group: "Colors" },
          { label: "Plain", value: "plain" },
        ],
      });
      const groups = [...select(element).querySelectorAll("optgroup")].map(
        (group) => [
          group.getAttribute("label"),
          [...group.querySelectorAll("option")].map((option) =>
            option.textContent!.trim()
          ),
        ],
      );
      expect(groups).toEqual([
        ["Colors", ["Red", "Blue"]],
        ["Shapes", ["Circle"]],
      ]);
      expect(labels(element)).toEqual(["Red", "Blue", "Circle", "Plain"]);
    });

    it("shows a placeholder, selected while nothing is", async () => {
      const { element } = await selectWith({
        items: FRUIT,
        placeholder: "Pick a fruit",
      });
      const placeholder = select(element).querySelector("option[value='']")!;
      expect(placeholder.textContent!.trim()).toBe("Pick a fruit");
      expect(placeholder.getAttribute("hidden")).toBe("true");
      expect(select(element).value).toBe("");
    });

    it("shows `-` as the placeholder when none is given", async () => {
      const { element } = await selectWith({ items: FRUIT });
      const placeholder = select(element).querySelector("option[value='']")!;
      expect(placeholder.textContent!.trim()).toBe("-");
    });

    it("sets the visible rows of a multiple select only", async () => {
      const { element } = await selectWith({
        items: FRUIT,
        visibleRows: 3,
        name: "fruit",
      });
      expect(select(element).hasAttribute("size")).toBe(false);
      expect(select(element).getAttribute("name")).toBe("fruit");
      element.multiple = true;
      element.value = [];
      await element.updateComplete;
      expect(select(element).getAttribute("size")).toBe("3");
    });

    it("applies a theme given to it directly", async () => {
      const { element } = await selectWith({
        theme: { ...defaultTheme, fontFamily: "Test Serif" },
      });
      expect(element.style.getPropertyValue("--cf-theme-font-family"))
        .toBe("Test Serif");
    });
  });

  describe("given a plain value", () => {
    it("selects the option whose value is the same", async () => {
      const apple = { name: "apple" };
      const { element } = await selectWith({
        items: [{ label: "Apple", value: apple }, ...FRUIT.slice(1)],
        value: apple,
      });
      expect(select(element).value).toBe("0");

      element.value = "cherry";
      await element.updateComplete;
      expect(select(element).value).toBe("2");
    });

    it("selects nothing for a value equal to an item's but not the same", async () => {
      const { element } = await selectWith({
        items: [{ label: "Apple", value: { name: "apple" } }],
        value: { name: "apple" },
      });
      expect(select(element).value).toBe("");
    });

    it("selects the value once items arrive", async () => {
      const { element } = await selectWith({ value: "banana" });
      element.items = FRUIT;
      await element.updateComplete;
      expect(select(element).value).toBe("1");
    });

    it("announces a pick with the picked value, the previous one, and the items", async () => {
      const { element, changes } = await selectWith({
        items: FRUIT,
        value: "apple",
      });
      const plainChanges: unknown[] = [];
      element.addEventListener("change", (event) => {
        if (event instanceof CustomEvent) plainChanges.push(event.detail);
      });

      pick(element, 2);

      const detail = { value: "cherry", oldValue: "apple", items: FRUIT };
      expect(changes).toEqual([detail]);
      expect(plainChanges).toEqual([detail]);
    });

    it("goes on showing its value after a pick until its owner sets the picked one", async () => {
      const { element } = await selectWith({ items: FRUIT, value: "apple" });
      element.addEventListener("cf-change", (event) => {
        if (event instanceof CustomEvent) element.value = event.detail.value;
      });
      pick(element, 2);
      expect(select(element).value).toBe("0");
      await element.updateComplete;
      expect(select(element).value).toBe("2");
    });

    it("announces the picks of a multiple select as a list", async () => {
      const { element, changes } = await selectWith({
        items: FRUIT,
        multiple: true,
        value: ["apple"],
      });
      // `selectedOptions` is read once, by the select itself: happy-dom
      // keeps the collection it first returns unchanged.
      expect([...select(element).options].map((option) => option.selected))
        .toEqual([false, true, false, false]);

      pick(element, 0, 2);

      expect(changes).toEqual([
        { value: ["apple", "cherry"], oldValue: ["apple"], items: FRUIT },
      ]);
    });
  });

  describe("bound to a cell", () => {
    it("selects the cell's value", async () => {
      const { element } = await selectWith({
        items: FRUIT,
        value: createMockCellHandle("banana"),
      });
      expect(select(element).value).toBe("1");
    });

    it("writes a pick to the cell, and shows it", async () => {
      const value = createMockCellHandle<unknown>("apple");
      const { element, changes } = await selectWith({ items: FRUIT, value });
      changes.length = 0;

      pick(element, 2);
      await settle();
      await element.updateComplete;

      expect(written(value)).toEqual(["cherry"]);
      expect(changes).toContainEqual({
        value: "cherry",
        oldValue: "apple",
        items: FRUIT,
      });
      expect(select(element).value).toBe("2");
    });

    it("selects and announces a value the cell is pushed", async () => {
      const value = createMockCellHandle<unknown>("apple");
      const { element, changes } = await selectWith({ items: FRUIT, value });
      changes.length = 0;

      pushUpdate(value, "banana");

      expect(select(element).value).toBe("1");
      expect(changes).toEqual([
        { value: "banana", oldValue: "apple", items: FRUIT },
      ]);
      expect(written(value)).toEqual([]);
    });

    it("writes a pick to the cell bound last", async () => {
      const first = createMockCellHandle<unknown>("apple");
      const second = createMockCellHandle<unknown>("banana", {
        id: "of:second",
      });
      const { element } = await selectWith({ items: FRUIT, value: first });
      element.value = second;
      await element.updateComplete;
      expect(select(element).value).toBe("1");

      pick(element, 2);
      await settle();

      expect(written(first)).toEqual([]);
      expect(written(second)).toEqual(["cherry"]);
    });
  });

  describe("in a `cf-form`", () => {
    it("holds a pick until the form is submitted, then writes it", async () => {
      const value = createMockCellHandle<unknown>("apple");
      const form = new CFForm();
      const element = Object.assign(new CFSelect(), { items: FRUIT, value });
      form.append(element);
      await mount(form);
      await element.updateComplete;

      pick(element, 1);
      await element.updateComplete;
      expect(select(element).value).toBe("1");
      expect(written(value)).toEqual([]);

      form.submit();
      await settle();
      expect(written(value)).toEqual(["banana"]);
    });

    it("stops a submission while a required select has nothing selected", async () => {
      const form = new CFForm();
      const element = Object.assign(new CFSelect(), {
        items: FRUIT,
        required: true,
      });
      form.append(element);
      await mount(form);
      await element.updateComplete;
      const invalid: unknown[] = [];
      form.addEventListener("cf-form-invalid", (event) => {
        if (event instanceof CustomEvent) invalid.push(event.detail);
      });

      form.submit();
      await settle();

      expect(invalid).toEqual([{
        errors: [{
          element,
          message: select(element).validationMessage,
        }],
      }]);
    });
  });

  describe("focus", () => {
    it("forwards focus on the host to the select, and announces it", async () => {
      const { element } = await selectWith({ items: FRUIT });
      const events: string[] = [];
      for (const type of ["cf-focus", "cf-blur"]) {
        element.addEventListener(type, () => events.push(type));
      }

      element.dispatchEvent(new FocusEvent("focus"));
      expect(element.shadowRoot!.activeElement).toBe(select(element));

      element.blur();
      element.focus();
      expect(element.shadowRoot!.activeElement).toBe(select(element));
      expect(events).toEqual(["cf-focus", "cf-blur", "cf-focus"]);
    });

    it("takes no focus while disabled", async () => {
      const { element } = await selectWith({ items: FRUIT, disabled: true });
      let focused = false;
      element.addEventListener("cf-focus", () => focused = true);
      element.dispatchEvent(new FocusEvent("focus"));
      element.focus();
      expect(focused).toBe(false);
    });
  });

  describe("checkValidity()", () => {
    it("returns whether a required select has a selection", async () => {
      const { element } = await selectWith({ items: FRUIT, required: true });
      expect(element.checkValidity()).toBe(false);
      element.value = "apple";
      await element.updateComplete;
      expect(element.checkValidity()).toBe(true);
    });

    it("returns `true` before the select has rendered", () => {
      expect(new CFSelect().checkValidity()).toBe(true);
    });
  });
});
