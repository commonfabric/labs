/**
 * A radio button driven by real key presses: Tab reaches it, focus rests on
 * the host that carries its role, it shows a focus ring, and Space selects it
 * while Enter does not; Tab passes over a disabled radio, and keys leave it
 * alone.
 */

import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";

import {
  type BetweenButtons,
  betweenButtons,
} from "../../test-utils/tab-order.ts";
import { CFRadio } from "./index.ts";

/**
 * A radio between two buttons, with focus on the button before it, and the
 * details of the `cf-change` events it fires.
 */
async function mounted(
  options: { disabled?: boolean } = {},
): Promise<BetweenButtons<CFRadio> & { changes: unknown[] }> {
  const control = new CFRadio();
  control.value = "yes";
  control.disabled = options.disabled ?? false;
  const changes: unknown[] = [];
  control.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  return { ...await betweenButtons(control), changes };
}

Deno.test("Tab reaches the radio, and focus rests on the radio itself", async () => {
  using page = await mounted();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.control);
  expect(page.control.shadowRoot?.activeElement).toBeNull();
});

Deno.test("the focused radio shows a focus ring", async () => {
  using page = await mounted();
  const circle = page.control.shadowRoot?.querySelector(".radio");
  if (!circle) throw new Error("the radio did not render");
  expect(getComputedStyle(circle).boxShadow).toBe("none");
  await pressKey("Tab");
  // Finishing the fade-in reads the ring itself, not its first frame.
  for (const animation of circle.getAnimations()) animation.finish();
  expect(getComputedStyle(circle).boxShadow).toContain("0px 0px 0px 4px");
});

Deno.test("Space selects the focused radio, and Enter does not", async () => {
  using page = await mounted();
  await pressKey("Tab");
  await pressKey("Enter");
  expect(page.control.checked).toBe(false);
  await pressKey(" ");
  await page.control.updateComplete;
  expect(page.control.checked).toBe(true);
  expect(page.control.getAttribute("aria-checked")).toBe("true");
  expect(page.changes).toEqual([{ checked: true, value: "yes" }]);
});

Deno.test("Tab passes over a disabled radio, and Space leaves it alone", async () => {
  using page = await mounted({ disabled: true });
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.after);
  page.control.focus();
  expect(document.activeElement).toBe(page.control);
  await pressKey(" ");
  expect(page.control.checked).toBe(false);
  expect(page.changes).toEqual([]);
});
