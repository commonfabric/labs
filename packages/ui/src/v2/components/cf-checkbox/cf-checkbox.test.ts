/**
 * Tests for CFCheckbox component
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  holdReads,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFCheckbox } from "./index.ts";

/**
 * The element's own members the click tests drive: a Lit element mounts only
 * in a browser, so without one they bind `checked` and click through these.
 */
type CheckboxInternals = {
  checked: CellHandle<boolean>;
  willUpdate(changedProperties: Map<string, unknown>): void;
  _handleClick(event: Event): void;
};

/** A checkbox bound to `checked`, as a change of `checked` binds it. */
function boundTo(checked: CellHandle<boolean>): CheckboxInternals {
  const element = new CFCheckbox() as unknown as CheckboxInternals;
  element.checked = checked;
  element.willUpdate(new Map([["checked", undefined]]));
  return element;
}

describe("CFCheckbox click", () => {
  // A click toggles what the cell holds. A cell that has not answered holds
  // nothing, which is not unchecked: toggled, it would write `true` over a
  // value nobody was shown.
  it("writes nothing while the cell's read has not been answered", () => {
    const checked = createMockCellHandle<boolean>();
    holdReads(checked);
    const element = boundTo(checked);

    element._handleClick(new Event("click"));

    expect(writesSent(checked)).toEqual([]);
  });

  it("writes what the worker's answer toggles to", () => {
    const checked = createMockCellHandle<boolean>(true);
    const element = boundTo(checked);

    element._handleClick(new Event("click"));

    expect(writesSent(checked)).toEqual([
      expect.objectContaining({ type: "cell:set", value: false }),
    ]);
  });
});

describe("CFCheckbox", () => {
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

  it("should delegate focus into the shadow root", () => {
    expect(CFCheckbox.shadowRootOptions.delegatesFocus).toBe(true);
  });

  it("should not set attributes in constructor (custom element spec)", () => {
    // The custom element spec forbids setAttribute during construction.
    // Attributes are set in connectedCallback instead.
    const element = new CFCheckbox();
    expect(element.getAttribute("exportparts")).toBeNull();
    expect(element.getAttribute("role")).toBeNull();
  });

  if (typeof document !== "undefined") {
    it("should be creatable via document.createElement", async () => {
      const element = document.createElement("cf-checkbox") as CFCheckbox;
      document.body.append(element);
      await element.updateComplete;

      expect(element).toBeInstanceOf(CFCheckbox);
      expect(element.getAttribute("role")).toBe("checkbox");
      expect(element.getAttribute("exportparts")).toBe("checkbox,checkmark");

      element.remove();
    });
  }

  it("should have default properties", () => {
    const element = new CFCheckbox();
    expect(element.checked).toBe(false);
    expect(element.disabled).toBe(false);
    expect(element.indeterminate).toBe(false);
    expect(element.required).toBe(false);
    expect(element.name).toBe("");
    expect(element.value).toBe("on");
  });

  it("should expose aria-disabled and tabIndex when updated (enabled)", () => {
    const element = new CFCheckbox();
    // Trigger the updated lifecycle with a set of changed properties.
    // aria-disabled and tabIndex are set by _updateAriaAttributes() which
    // does not require connectedCallback.
    element.updated(new Map([["disabled", undefined]]));

    expect(element.getAttribute("aria-disabled")).toBe("false");
    expect(element.tabIndex).toBe(0);
  });

  it("should set tabIndex to 0 when enabled", () => {
    const element = new CFCheckbox();
    element.disabled = false;
    element.updated(new Map([["disabled", true]]));

    expect(element.tabIndex).toBe(0);
  });

  it("should set tabIndex to -1 when disabled", () => {
    const element = new CFCheckbox();
    element.disabled = true;
    element.updated(new Map([["disabled", false]]));

    expect(element.tabIndex).toBe(-1);
  });

  it("should expose disabled state via aria-disabled", () => {
    const element = new CFCheckbox();
    element.disabled = true;
    element.updated(new Map([["disabled", false]]));

    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(element.tabIndex).toBe(-1);
  });
});
