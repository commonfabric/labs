// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFRadio } from "../cf-radio/index.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFRadioGroup, type RadioItem } from "./index.ts";

const SIZES: RadioItem[] = [
  { label: "Small", value: "small" },
  { label: "Medium", value: "medium" },
  { label: "Large", value: "large" },
];

/**
 * A group mounted with `properties` around a radio for each of
 * `radioValues`, with the details of the `cf-change` and `change` events it
 * fires once mounted.
 */
async function groupWith(
  properties: Partial<CFRadioGroup> = {},
  radioValues: string[] = [],
) {
  const group = Object.assign(new CFRadioGroup(), properties);
  const radios = radioValues.map((value) =>
    Object.assign(new CFRadio(), { value })
  );
  group.append(...radios);
  await mount(group);
  await Promise.all(radios.map((radio) => radio.updateComplete));
  const changes: unknown[] = [];
  const plainChanges: unknown[] = [];
  group.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  group.addEventListener("change", (event) => {
    if (event instanceof CustomEvent) plainChanges.push(event.detail);
  });
  return { group, radios, changes, plainChanges };
}

/** A cell holding `value`, as a pattern binds `$value`. */
function cell(value: unknown): CellHandle<unknown> {
  return createMockCellHandle<unknown>(value);
}

/**
 * Asserts that `details` holds `expected` and nothing else. The cell
 * controller announces a write twice: as it makes the write, and again as the
 * cell echoes it back.
 */
function expectOnly(details: unknown[], expected: unknown): void {
  expect(details).not.toEqual([]);
  expect(details).toEqual(details.map(() => expected));
}

const inputs = (group: CFRadioGroup) => [
  ...group.shadowRoot!.querySelectorAll("input"),
];

function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("CFRadioGroup", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-radio-group`", () => {
    expect(customElements.get("cf-radio-group")).toBe(CFRadioGroup);
  });

  it("exposes itself as a radio group", async () => {
    const { group } = await groupWith();

    expect(group.getAttribute("role")).toBe("radiogroup");
  });

  describe("items", () => {
    it("shows each item's label, and checks the one holding the value", async () => {
      const { group } = await groupWith({
        items: SIZES,
        value: cell("medium"),
      });

      const labels = [...group.shadowRoot!.querySelectorAll(".radio-label")];
      expect(labels.map((label) => label.textContent)).toEqual([
        "Small",
        "Medium",
        "Large",
      ]);
      expect(inputs(group).map((input) => input.checked)).toEqual([
        false,
        true,
        false,
      ]);
      const items = [...group.shadowRoot!.querySelectorAll(".radio-item")];
      expect(items.map((item) => item.classList.contains("checked"))).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("matches a value to an item by its text", async () => {
      const { group } = await groupWith({
        items: [{ label: "One", value: "1" }, { label: "Two", value: "2" }],
        value: 2,
      });

      expect(inputs(group).map((input) => input.checked)).toEqual([
        false,
        true,
      ]);
    });

    it("checks no item while the group holds no value", async () => {
      const { group } = await groupWith({ items: SIZES });

      expect(inputs(group).some((input) => input.checked)).toBe(false);
    });

    it("gives every input the group's name, and an id its label points to", async () => {
      const { group } = await groupWith({ items: SIZES, name: "size" });

      expect(inputs(group).map((input) => input.name)).toEqual([
        "size",
        "size",
        "size",
      ]);
      const label = group.shadowRoot!.querySelector("label")!;
      expect(label.htmlFor).toBe("radio-size-0");
      expect(inputs(group)[0].id).toBe("radio-size-0");
    });

    it("gives every input of an unnamed group one name no other group has", async () => {
      const { group } = await groupWith({ items: SIZES });
      const { group: other } = await groupWith({ items: SIZES });

      const names = new Set(inputs(group).map((input) => input.name));
      expect(names.size).toBe(1);
      expect(names.has(inputs(other)[0].name)).toBe(false);
    });

    it("disables an item disabled on its own, and every item in a disabled group", async () => {
      const { group } = await groupWith({
        items: [SIZES[0], { ...SIZES[1], disabled: true }],
      });
      expect(inputs(group).map((input) => input.disabled)).toEqual([
        false,
        true,
      ]);

      group.disabled = true;
      await group.updateComplete;
      expect(inputs(group).map((input) => input.disabled)).toEqual([
        true,
        true,
      ]);
    });

    it("writes the value of the item picked, and announces it", async () => {
      const value = cell("medium");
      const { group, changes, plainChanges } = await groupWith({
        items: SIZES,
        value,
      });

      inputs(group)[2].click();
      await group.updateComplete;

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "large" }),
      ]);
      const detail = { value: "large", oldValue: "medium", items: SIZES };
      expectOnly(changes, detail);
      expectOnly(plainChanges, detail);
      expect(group.getValue()).toBe("large");
      expect(inputs(group).map((input) => input.checked)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("writes nothing for a disabled item, or for any item in a disabled group", async () => {
      const value = cell("small");
      const { group, changes } = await groupWith({
        items: [SIZES[0], { ...SIZES[1], disabled: true }],
        value,
      });
      inputs(group)[1].dispatchEvent(new CustomEvent("change"));

      group.disabled = true;
      await group.updateComplete;
      inputs(group)[0].dispatchEvent(new CustomEvent("change"));

      expect(writesSent(value)).toEqual([]);
      expect(changes).toEqual([]);
    });

    it("moves focus and the selection to the next enabled item on an arrow key", async () => {
      const { group } = await groupWith({
        items: [SIZES[0], { ...SIZES[1], disabled: true }, SIZES[2]],
        value: cell("small"),
      });

      const event = press(inputs(group)[0], "ArrowDown");
      await group.updateComplete;

      expect(event.defaultPrevented).toBe(true);
      expect(
        inputs(group).findIndex((input) =>
          input === group.shadowRoot!.activeElement
        ),
      ).toBe(2);
      expect(group.getValue()).toBe("large");
    });

    it("leaves arrow keys to the items, passing over radios it does not show", async () => {
      const value = cell("small");
      const { group } = await groupWith({ items: SIZES, value }, ["large"]);

      const event = press(group, "ArrowDown");

      expect(event.defaultPrevented).toBe(false);
      expect(writesSent(value)).toEqual([]);
    });
  });

  describe("slotted radios", () => {
    it("shows them through a slot when the group has no items", async () => {
      const { group } = await groupWith({}, ["small"]);

      expect(group.shadowRoot!.querySelectorAll("slot").length).toBe(1);
      expect(inputs(group).length).toBe(0);
    });

    it("checks the radio holding the group's value, and only that one", async () => {
      const { radios } = await groupWith({ value: cell("medium") }, [
        "small",
        "medium",
        "large",
      ]);

      expect(radios.map((radio) => radio.checked)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("gives the group's name to radios with none, and leaves a radio's own name", async () => {
      const group = Object.assign(new CFRadioGroup(), { name: "size" });
      const own = Object.assign(new CFRadio(), { value: "a", name: "mine" });
      const unnamed = Object.assign(new CFRadio(), { value: "b" });
      group.append(own, unnamed);
      await mount(group);

      expect([own.name, unnamed.name]).toEqual(["mine", "size"]);
    });

    it("names no radio while the group has no name", async () => {
      const { radios } = await groupWith({}, ["small"]);

      expect(radios[0].name).toBe("");
    });

    it("disables every radio while the group is disabled, and enables again only the ones it disabled", async () => {
      const { group, radios } = await groupWith({}, ["small", "medium"]);
      radios[1].disabled = true;

      group.disabled = true;
      await group.updateComplete;
      expect(radios.map((radio) => radio.disabled)).toEqual([true, true]);

      group.disabled = false;
      await group.updateComplete;
      expect(radios.map((radio) => radio.disabled)).toEqual([false, true]);
    });

    it("brings a radio added later in line with the group", async () => {
      const { group } = await groupWith({
        value: cell("large"),
        disabled: true,
      }, ["small"]);
      const added = Object.assign(new CFRadio(), { value: "large" });

      group.append(added);
      const slot = group.shadowRoot!.querySelector("slot")!;
      slot.dispatchEvent(new CustomEvent("slotchange"));

      expect(added.checked).toBe(true);
      expect(added.disabled).toBe(true);
    });

    it("selects the radio a click lands on, writing its value", async () => {
      const value = cell("small");
      const { radios, changes } = await groupWith({ value }, [
        "small",
        "large",
      ]);
      const radioChanges: unknown[] = [];
      radios[1].addEventListener(
        "cf-change",
        (event) => radioChanges.push(event.type),
      );

      radios[1].click();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "large" }),
      ]);
      expectOnly(changes, { value: "large", oldValue: "small", items: [] });
      expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
      // The radio left its selection to the group, so announced nothing of
      // its own.
      expect(radioChanges).toEqual([]);
    });

    it("selects a radio given its value as a property rather than an attribute", async () => {
      const value = cell("small");
      const { radios } = await groupWith({ value }, ["small", "large"]);

      radios[1].click();

      expect(radios[1].hasAttribute("value")).toBe(false);
      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "large" }),
      ]);
    });

    it("writes nothing for a click on a radio without a value", async () => {
      const value = cell("small");
      const { radios, changes } = await groupWith({ value }, ["small", ""]);

      radios[1].click();

      expect(writesSent(value)).toEqual([]);
      expect(changes).toEqual([]);
    });

    it("stops answering its radios once removed from the page", async () => {
      const value = cell("small");
      const { group, radios } = await groupWith({ value }, ["small", "large"]);

      group.remove();
      group.dispatchEvent(
        new CustomEvent("radio-click", { detail: { radio: radios[1] } }),
      );

      expect(writesSent(value)).toEqual([]);
    });

    describe("arrow keys", () => {
      /** A group around radios `a`, `b` and `c`, holding `a`. */
      async function row(disabled: string[] = []) {
        const result = await groupWith({ value: cell("a") }, ["a", "b", "c"]);
        for (const radio of result.radios) {
          radio.disabled = disabled.includes(radio.value);
        }
        // The position of the focused radio, -1 when focus is elsewhere.
        const focused = () =>
          result.radios.findIndex((radio) => radio === document.activeElement);
        return { ...result, focused };
      }

      it("moves focus and the selection to the next radio on Down and on Right", async () => {
        const { group, radios, focused } = await row();

        const down = press(radios[0], "ArrowDown");
        expect(down.defaultPrevented).toBe(true);
        expect(focused()).toBe(1);
        expect(group.getValue()).toBe("b");

        press(radios[1], "ArrowRight");
        expect(focused()).toBe(2);
        expect(group.getValue()).toBe("c");
      });

      it("moves focus and the selection to the previous radio on Up and on Left", async () => {
        const { group, radios, focused } = await row();

        press(radios[2], "ArrowUp");
        expect(focused()).toBe(1);
        expect(group.getValue()).toBe("b");

        press(radios[1], "ArrowLeft");
        expect(focused()).toBe(0);
        expect(group.getValue()).toBe("a");
      });

      it("wraps around at either end", async () => {
        const { radios, focused } = await row();

        press(radios[2], "ArrowDown");
        expect(focused()).toBe(0);

        press(radios[0], "ArrowUp");
        expect(focused()).toBe(2);
      });

      it("passes over a disabled radio", async () => {
        const { group, radios, focused } = await row(["b"]);

        press(radios[0], "ArrowDown");

        expect(focused()).toBe(2);
        expect(group.getValue()).toBe("c");
      });

      it("moves from the radio the key was pressed on, wherever the page's focus is", async () => {
        // In a group inside another component's shadow root, the page's
        // focused element is that component, never the radio.
        const { radios, focused } = await row();
        radios[2].focus();

        press(radios[0], "ArrowDown");

        expect(focused()).toBe(1);
      });

      it("goes to the first radio on Down, and the last on Up, from the group itself", async () => {
        const { group, focused } = await row();

        press(group, "ArrowDown");
        expect(focused()).toBe(0);

        press(group, "ArrowUp");
        expect(focused()).toBe(2);
      });

      it("leaves other keys alone", async () => {
        const { group, radios, focused } = await row();
        radios[0].focus();

        const event = press(radios[0], "Tab");

        expect(event.defaultPrevented).toBe(false);
        expect(focused()).toBe(0);
        expect(group.getValue()).toBe("a");
      });

      it("leaves arrow keys alone when every radio is disabled", async () => {
        const { group } = await row(["a", "b", "c"]);

        const event = press(group, "ArrowDown");

        expect(event.defaultPrevented).toBe(false);
        expect(group.getValue()).toBe("a");
      });
    });
  });

  describe("theme", () => {
    it("writes a theme it is given onto its own style", async () => {
      const { group } = await groupWith();

      group.theme = { ...defaultTheme, fontFamily: "Test Serif" };
      await group.updateComplete;

      expect(group.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "Test Serif",
      );
    });
  });

  describe("setValue()", () => {
    it("writes the value it is given, and announces it", async () => {
      const value = cell("small");
      const { group, changes } = await groupWith({ value });

      group.setValue("medium");

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "medium" }),
      ]);
      expectOnly(changes, { value: "medium", oldValue: "small", items: [] });
    });
  });

  describe("clear()", () => {
    it("writes `undefined`, leaving no radio checked", async () => {
      const value = cell("small");
      const { group, radios } = await groupWith({ value }, ["small"]);

      group.clear();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: undefined }),
      ]);
      expect(group.getValue()).toBeUndefined();
      expect(radios[0].checked).toBe(false);
    });
  });
});
