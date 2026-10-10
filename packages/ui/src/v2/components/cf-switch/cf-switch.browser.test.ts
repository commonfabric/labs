/**
 * A switch driven by real key presses: Tab reaches it, focus rests on the host
 * that carries its role, it shows a focus ring, and Space and Enter toggle it;
 * Tab passes over a disabled switch, and keys leave it alone.
 */

import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";

import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSwitch } from "./index.ts";

/** A switch between two buttons, with focus on the button before it. */
async function mounted(options: { disabled?: boolean } = {}): Promise<{
  control: CFSwitch;
  after: HTMLButtonElement;
  [Symbol.dispose]: () => void;
}> {
  const before = document.createElement("button");
  const control = new CFSwitch();
  control.disabled = options.disabled ?? false;
  const after = document.createElement("button");
  document.body.append(before, control, after);
  await control.updateComplete;
  before.focus();
  return {
    control,
    after,
    [Symbol.dispose]: () => {
      before.remove();
      control.remove();
      after.remove();
    },
  };
}

Deno.test("Tab reaches the switch, and focus rests on the switch itself", async () => {
  using page = await mounted();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.control);
  expect(page.control.shadowRoot?.activeElement).toBeNull();
});

Deno.test("the focused switch shows a focus ring", async () => {
  using page = await mounted();
  const track = page.control.shadowRoot?.querySelector(".switch");
  if (!track) throw new Error("the switch did not render");
  expect(getComputedStyle(track).boxShadow).toBe("none");
  await pressKey("Tab");
  expect(getComputedStyle(track).boxShadow).not.toBe("none");
});

Deno.test("Space and Enter toggle the focused switch", async () => {
  using page = await mounted();
  await pressKey("Tab");
  await pressKey(" ");
  await page.control.updateComplete;
  expect(page.control.checked).toBe(true);
  expect(page.control.getAttribute("aria-checked")).toBe("true");
  await pressKey("Enter");
  await page.control.updateComplete;
  expect(page.control.checked).toBe(false);
  expect(page.control.getAttribute("aria-checked")).toBe("false");
});

Deno.test("Tab passes over a disabled switch, and Space leaves it alone", async () => {
  using page = await mounted({ disabled: true });
  const cell = createMockCellHandle(false);
  page.control.checked = cell;
  await page.control.updateComplete;
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
  page.control.focus();
  expect(document.activeElement).toBe(page.control);
  await pressKey(" ");
  expect(writesSent(cell)).toEqual([]);
});
