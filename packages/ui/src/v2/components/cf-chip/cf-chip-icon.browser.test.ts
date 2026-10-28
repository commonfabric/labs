/**
 * A chip's icon takes room only while one is slotted: without an icon, the
 * label starts where the chip's content starts, with no gap before it; an icon
 * sits before the label, and one added or removed later shows or gives back
 * that room, in both the plain and the interactive chip.
 */

import { expect } from "@std/expect";

import { CFChip } from "./index.ts";

/** Mounts a chip in the page, removed again on disposal. */
async function mounted(
  options: { icon?: HTMLElement; interactive?: boolean } = {},
): Promise<CFChip & Disposable> {
  const chip = new CFChip();
  chip.label = "Label";
  chip.interactive = options.interactive ?? false;
  if (options.icon) chip.append(options.icon);
  document.body.append(chip);
  await chip.updateComplete;
  return Object.assign(chip, { [Symbol.dispose]: () => chip.remove() });
}

/** Creates a span assigned to the icon slot. */
function icon(): HTMLElement {
  const element = document.createElement("span");
  element.slot = "icon";
  element.textContent = "*";
  return element;
}

/** Returns the left edge of the chip's label. */
function labelStart(chip: CFChip): number {
  const label = chip.shadowRoot?.querySelector(".chip-label");
  if (!label) throw new Error("the chip did not render");
  return label.getBoundingClientRect().left;
}

/** Returns how far the label starts past the start of the chip's content box. */
function labelInset(chip: CFChip): number {
  const box = chip.shadowRoot?.querySelector(".chip");
  if (!box) throw new Error("the chip did not render");
  const style = getComputedStyle(box);
  const contentStart = box.getBoundingClientRect().left +
    parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  return labelStart(chip) - contentStart;
}

/** Expects `element` to be laid out, ending before the chip's label starts. */
function expectBeforeLabel(chip: CFChip, element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.right).toBeLessThan(labelStart(chip));
}

for (const interactive of [false, true]) {
  const kind = interactive ? "an interactive chip" : "a chip";

  Deno.test(`${kind} without an icon starts its label with no gap`, async () => {
    using chip = await mounted({ interactive });
    expect(labelInset(chip)).toBeCloseTo(0);
  });

  Deno.test(`${kind} with an icon shows it before the label`, async () => {
    const slotted = icon();
    using chip = await mounted({ icon: slotted, interactive });
    expectBeforeLabel(chip, slotted);
  });

  Deno.test(`${kind} makes room for an icon added later, and gives it back once removed`, async () => {
    using chip = await mounted({ interactive });
    const added = icon();
    chip.append(added);
    expectBeforeLabel(chip, added);
    added.remove();
    expect(labelInset(chip)).toBeCloseTo(0);
  });
}
