import { expect } from "@std/expect";
import { pressKey } from "@commonfabric/deno-web-test/commands";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import {
  type BetweenButtons,
  betweenButtons,
} from "../../test-utils/tab-order.ts";
import { CFCheckbox } from "./index.ts";

for (
  const { description, initial, delivered } of [
    {
      description: "hydrates to checked",
      initial: undefined,
      delivered: true,
    },
    {
      description: "changes to unchecked",
      initial: true,
      delivered: false,
    },
  ]
) {
  Deno.test(`cf-checkbox synchronizes accessible state when its bound cell ${description}`, async () => {
    const cell = createMockCellHandle<boolean>(initial);
    const element = document.createElement("cf-checkbox") as CFCheckbox;
    element.checked = cell;
    document.body.append(element);

    try {
      await element.updateComplete;
      expect(element).toBeInstanceOf(CFCheckbox);
      expect(element.getAttribute("role")).toBe("checkbox");
      expect(element.getAttribute("aria-checked")).toBe(
        String(initial ?? false),
      );

      pushUpdate(cell, delivered);
      await element.updateComplete;

      expect(element.checked).toBe(cell);
      expect(
        element.shadowRoot?.querySelector(".checkbox")?.classList.contains(
          "checked",
        ),
      ).toBe(delivered);
      expect(element.shadowRoot?.querySelector("input")?.checked).toBe(
        delivered,
      );
      expect(element.getAttribute("aria-checked")).toBe(String(delivered));
    } finally {
      element.remove();
    }
  });
}

Deno.test("cf-checkbox preserves mixed and disabled states across bound cell updates", async () => {
  const cell = createMockCellHandle(false);
  const element = document.createElement("cf-checkbox") as CFCheckbox;
  element.checked = cell;
  element.indeterminate = true;
  element.disabled = true;
  document.body.append(element);

  try {
    await element.updateComplete;
    expect(element).toBeInstanceOf(CFCheckbox);
    pushUpdate(cell, true);
    await element.updateComplete;

    const visual = element.shadowRoot?.querySelector(".checkbox");
    const input = element.shadowRoot?.querySelector("input");
    expect(visual?.classList.contains("indeterminate")).toBe(true);
    expect(visual?.classList.contains("checked")).toBe(false);
    expect(input?.checked).toBe(true);
    expect(input?.disabled).toBe(true);
    expect(element.getAttribute("aria-checked")).toBe("mixed");
    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(element.tabIndex).toBe(-1);

    element.indeterminate = false;
    element.disabled = false;
    await element.updateComplete;

    expect(visual?.classList.contains("indeterminate")).toBe(false);
    expect(visual?.classList.contains("checked")).toBe(true);
    expect(input?.disabled).toBe(false);
    expect(element.getAttribute("aria-checked")).toBe("true");
    expect(element.getAttribute("aria-disabled")).toBe("false");
    expect(element.tabIndex).toBe(0);
  } finally {
    element.remove();
  }
});

/** A checkbox between two buttons, with focus on the button before it. */
function mounted(
  options: { disabled?: boolean } = {},
): Promise<BetweenButtons<CFCheckbox>> {
  const control = new CFCheckbox();
  control.disabled = options.disabled ?? false;
  return betweenButtons(control);
}

Deno.test("Tab reaches the checkbox, and focus rests on the checkbox itself", async () => {
  using page = await mounted();
  await pressKey("Tab");
  expect(document.activeElement).toBe(page.control);
  expect(page.control.shadowRoot?.activeElement).toBeNull();
});

Deno.test("the focused checkbox shows a focus ring", async () => {
  using page = await mounted();
  const box = page.control.shadowRoot?.querySelector(".checkbox");
  if (!box) throw new Error("the checkbox did not render");
  expect(getComputedStyle(box).boxShadow).toBe("none");
  await pressKey("Tab");
  // Finishing the fade-in reads the ring itself, not its first frame.
  for (const animation of box.getAnimations()) animation.finish();
  expect(getComputedStyle(box).boxShadow).toContain("0px 0px 0px 4px");
});

Deno.test("Space toggles the focused checkbox, and Enter does not", async () => {
  using page = await mounted();
  const cell = createMockCellHandle(false);
  page.control.checked = cell;
  await page.control.updateComplete;
  const written = () => writesSent(cell).map((write) => write.value);
  await pressKey("Tab");
  await pressKey(" ");
  expect(written()).toEqual([true]);
  await page.control.updateComplete;
  expect(page.control.getAttribute("aria-checked")).toBe("true");
  await pressKey("Enter");
  expect(written()).toEqual([true]);
  await pressKey(" ");
  expect(written()).toEqual([true, false]);
});

Deno.test("Tab passes over a disabled checkbox, and Space leaves it alone", async () => {
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

type CheckboxChange = { checked: boolean; indeterminate: boolean };

/** Records the detail of every `cf-change` the checkbox fires. */
function changesOf(control: CFCheckbox): CheckboxChange[] {
  const changes: CheckboxChange[] = [];
  control.addEventListener("cf-change", (event) => {
    if (!(event instanceof CustomEvent)) throw new Error("not a CustomEvent");
    changes.push(event.detail);
  });
  return changes;
}

/** What the unbound checkbox shows: its property, ARIA state, and box. */
async function shown(control: CFCheckbox) {
  await control.updateComplete;
  const box = control.shadowRoot?.querySelector(".checkbox");
  return {
    checked: control.checked,
    ariaChecked: control.getAttribute("aria-checked"),
    boxChecked: box?.classList.contains("checked"),
    boxIndeterminate: box?.classList.contains("indeterminate"),
  };
}

const UNCHECKED = {
  checked: false,
  ariaChecked: "false",
  boxChecked: false,
  boxIndeterminate: false,
};
const CHECKED = {
  checked: true,
  ariaChecked: "true",
  boxChecked: true,
  boxIndeterminate: false,
};

Deno.test("Space toggles an unbound checkbox, and Enter does not", async () => {
  using page = await mounted();
  const changes = changesOf(page.control);
  await pressKey("Tab");
  await pressKey(" ");
  expect(await shown(page.control)).toEqual(CHECKED);
  expect(changes).toEqual([{ checked: true, indeterminate: false }]);
  await pressKey("Enter");
  expect(await shown(page.control)).toEqual(CHECKED);
  expect(changes).toHaveLength(1);
  await pressKey(" ");
  expect(await shown(page.control)).toEqual(UNCHECKED);
  expect(changes).toEqual([
    { checked: true, indeterminate: false },
    { checked: false, indeterminate: false },
  ]);
});

Deno.test("a click toggles an unbound checkbox", async () => {
  using page = await mounted();
  const changes = changesOf(page.control);
  page.control.click();
  expect(await shown(page.control)).toEqual(CHECKED);
  page.control.click();
  expect(await shown(page.control)).toEqual(UNCHECKED);
  expect(changes).toEqual([
    { checked: true, indeterminate: false },
    { checked: false, indeterminate: false },
  ]);
});

Deno.test("two clicks in one task leave an unbound checkbox unchecked", async () => {
  using page = await mounted();
  const changes = changesOf(page.control);
  page.control.click();
  page.control.click();
  expect(await shown(page.control)).toEqual(UNCHECKED);
  expect(changes).toEqual([
    { checked: true, indeterminate: false },
    { checked: false, indeterminate: false },
  ]);
});

Deno.test("a click on an indeterminate checkbox bound to a cell reports it settled", async () => {
  using page = await mounted();
  const cell = createMockCellHandle(false);
  page.control.checked = cell;
  page.control.indeterminate = true;
  await page.control.updateComplete;
  const changes = changesOf(page.control);
  page.control.click();
  expect(writesSent(cell).map((write) => write.value)).toEqual([true]);
  expect(page.control.indeterminate).toBe(false);
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.every((change) => !change.indeterminate)).toBe(true);
});

Deno.test("a click on an indeterminate unbound checkbox checks it", async () => {
  using page = await mounted();
  page.control.indeterminate = true;
  expect((await shown(page.control)).ariaChecked).toBe("mixed");
  const changes = changesOf(page.control);
  page.control.click();
  expect(await shown(page.control)).toEqual(CHECKED);
  expect(page.control.indeterminate).toBe(false);
  expect(changes).toEqual([{ checked: true, indeterminate: false }]);
});

Deno.test("a disabled unbound checkbox ignores clicks and Space", async () => {
  using page = await mounted({ disabled: true });
  const changes = changesOf(page.control);
  page.control.click();
  page.control.focus();
  await pressKey(" ");
  expect(await shown(page.control)).toEqual(UNCHECKED);
  expect(changes).toEqual([]);
});
