import { expect } from "@std/expect";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
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
