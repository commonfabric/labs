/**
 * A radio group of slotted radios driven by real key presses: the group is one
 * Tab stop, entered on its checked radio or, with none checked, on its first
 * enabled one; the arrow keys move focus and selection among its enabled
 * radios, wrapping at the ends.
 */

import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";

import {
  type BetweenButtons,
  betweenButtons,
} from "../../test-utils/tab-order.ts";
import { CFRadio } from "../cf-radio/index.ts";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFRadioGroup } from "./index.ts";

/** What a mounted group holds, beyond its place between the buttons. */
type Group = BetweenButtons<CFRadioGroup> & {
  /** The group's radios, by value. */
  radio: Record<string, CFRadio>;
  /** The `value` of each `cf-change` the group fired. */
  changes: unknown[];
};

/**
 * A group of radios `a`, `b`, and `c` between two buttons, with focus on the
 * button before it, holding `value` and with the radios in `disabled`
 * disabled.
 */
async function mounted(
  options: { value?: unknown; disabled?: string[] } = {},
): Promise<Group> {
  const group = new CFRadioGroup();
  if (options.value !== undefined) group.value = options.value;
  const radio: Record<string, CFRadio> = {};
  for (const value of ["a", "b", "c"]) {
    const control = new CFRadio();
    control.setAttribute("value", value);
    control.toggleAttribute(
      "disabled",
      options.disabled?.includes(value) ?? false,
    );
    control.textContent = value;
    radio[value] = control;
    group.append(control);
  }
  const changes: unknown[] = [];
  group.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail.value);
  });
  const page = await betweenButtons(group);
  await settled(page.control, radio);
  return { ...page, radio, changes };
}

/** Resolves once the group and its radios have rendered what they hold. */
async function settled(group: CFRadioGroup, radio: Record<string, CFRadio>) {
  await group.updateComplete;
  for (const control of Object.values(radio)) await control.updateComplete;
}

Deno.test("Tab enters the group on its checked radio, and a second Tab leaves the group", async () => {
  using page = await mounted({ value: "b" });
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
});

Deno.test("Tab enters a group with no checked radio on its first enabled radio", async () => {
  using page = await mounted({ disabled: ["a"] });
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
});

Deno.test("Shift+Tab from the button after the group returns to its checked radio", async () => {
  using page = await mounted({ value: "c" });
  page.after.focus();
  await pressKey("Tab", { modifiers: ["Shift"] });
  expect(document.activeElement).toBe(page.radio.c);
  await pressKey("Tab", { modifiers: ["Shift"] });
  expect(document.activeElement).toBe(page.before);
});

Deno.test("ArrowDown moves focus and selection to the next enabled radio, passing a disabled one, and wraps", async () => {
  using page = await mounted({ value: "a", disabled: ["b"] });
  await pressKey("Tab");
  await pressKey("ArrowDown");
  await settled(page.control, page.radio);
  expect(document.activeElement).toBe(page.radio.c);
  expect(page.radio.c.checked).toBe(true);
  expect(page.radio.a.checked).toBe(false);
  expect(page.radio.b.checked).toBe(false);
  expect(page.control.getValue()).toBe("c");
  await pressKey("ArrowDown");
  await settled(page.control, page.radio);
  expect(document.activeElement).toBe(page.radio.a);
  expect(page.radio.a.checked).toBe(true);
  expect(page.radio.c.checked).toBe(false);
  expect(page.changes).toEqual(["c", "a"]);
});

Deno.test("ArrowRight selects the next radio of a group holding no value, and Tab then enters on it", async () => {
  using page = await mounted();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.a);
  expect(page.radio.a.checked).toBe(false);
  await pressKey("ArrowRight");
  await settled(page.control, page.radio);
  expect(document.activeElement).toBe(page.radio.b);
  expect(page.radio.b.checked).toBe(true);
  expect(page.radio.b.getAttribute("aria-checked")).toBe("true");
  expect(page.control.getValue()).toBe("b");
  expect(page.changes).toEqual(["b"]);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
  await pressKey("Tab", { modifiers: ["Shift"] });
  expect(document.activeElement).toBe(page.radio.b);
  page.before.focus();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
});

Deno.test("Tab enters on the first enabled radio once the checked radio is removed", async () => {
  using page = await mounted({ value: "c", disabled: ["a"] });
  page.radio.c.remove();
  await settled(page.control, page.radio);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
});

Deno.test("ArrowUp moves focus and selection to the previous enabled radio, wrapping from the first to the last", async () => {
  using page = await mounted({ value: "a" });
  await pressKey("Tab");
  await pressKey("ArrowUp");
  await settled(page.control, page.radio);
  expect(document.activeElement).toBe(page.radio.c);
  expect(page.radio.c.checked).toBe(true);
  expect(page.radio.a.checked).toBe(false);
  expect(page.changes).toEqual(["c"]);
});

Deno.test("the arrow keys move on from the focused radio of a group inside a shadow root", async () => {
  using page = await mounted({ value: "b" });
  const host = document.createElement("div");
  using _host = { [Symbol.dispose]: () => host.remove() };
  document.body.append(host);
  host.attachShadow({ mode: "open" }).append(
    page.before,
    page.control,
    page.after,
  );
  await settled(page.control, page.radio);
  page.before.focus();
  await pressKey("Tab");
  expect(page.control.getRootNode()).not.toBe(document);
  expect(host.shadowRoot?.activeElement).toBe(page.radio.b);
  await pressKey("ArrowDown");
  await settled(page.control, page.radio);
  expect(host.shadowRoot?.activeElement).toBe(page.radio.c);
  expect(page.radio.c.checked).toBe(true);
  expect(page.radio.a.checked).toBe(false);
  expect(page.changes).toEqual(["c"]);
});

Deno.test("Tab passes over a radio disabled after the group rendered, and enters on it again once it is enabled", async () => {
  using page = await mounted({ value: "b" });
  page.radio.b.disabled = true;
  await settled(page.control, page.radio);
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.a);
  page.radio.b.disabled = false;
  await settled(page.control, page.radio);
  page.before.focus();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
});

Deno.test("ArrowDown in a group bound to a cell writes the next radio's value to the cell, and Tab then enters on it", async () => {
  const cell = createMockCellHandle<unknown>("a");
  using page = await mounted({ value: cell });
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.a);
  await pressKey("ArrowDown");
  await settled(page.control, page.radio);
  expect(writesSent(cell).map((write) => write.value)).toEqual(["b"]);
  expect(page.control.value).toBe(cell);
  expect(page.radio.b.checked).toBe(true);
  expect(page.radio.a.checked).toBe(false);
  page.before.focus();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.radio.b);
});
