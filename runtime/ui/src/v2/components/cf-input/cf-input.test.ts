/**
 * Full DOM interaction tests (input events, Cell two-way binding, timing
 * strategy integration, validation UI) require Lit's rendering pipeline and
 * shadow DOM, which are not available in Deno's headless test runner. These
 * cover property defaults, validation patterns, Cell property acceptance,
 * host ARIA semantics, and basic configuration; a browser-based harness
 * carries the rest.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFInput, INPUT_PATTERNS } from "./index.ts";

describe("CFInput", () => {
  it("should be defined", () => {
    expect(CFInput).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-input")).toBe(CFInput);
  });

  it("should create element instance", () => {
    const element = new CFInput();
    expect(element).toBeInstanceOf(CFInput);
  });

  if (typeof document !== "undefined") {
    it("should be creatable via document.createElement", async () => {
      const element = document.createElement("cf-input") as CFInput;
      document.body.append(element);
      await element.updateComplete;

      expect(element).toBeInstanceOf(CFInput);
      expect(element.getAttribute("role")).toBe("textbox");
      expect(element.getAttribute("exportparts")).toBe("input");

      element.remove();
    });
  }

  it("should have correct default properties", () => {
    const el = new CFInput();
    expect(el.type).toBe("text");
    expect(el.placeholder).toBe("");
    expect(el.value).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.readonly).toBe(false);
    expect(el.error).toBe(false);
    expect(el.name).toBe("");
    expect(el.required).toBe(false);
    expect(el.timingStrategy).toBe("debounce");
    expect(el.timingDelay).toBe(300);
    expect(el.showValidation).toBe(false);
  });

  it("should expose textbox semantics on the host", () => {
    const el = new CFInput();
    el.updated(new Map([["disabled", undefined]]));

    expect(el.getAttribute("role")).toBe("textbox");
    expect(el.getAttribute("aria-disabled")).toBe("false");
    expect(el.getAttribute("aria-readonly")).toBe("false");
    expect(el.getAttribute("aria-required")).toBe("false");
    expect(el.getAttribute("aria-invalid")).toBe("false");
    expect(el.getAttribute("exportparts")).toBe("input");
    expect(el.tabIndex).toBe(0);
  });

  it("should expose control state on the host", () => {
    const el = new CFInput();
    el.disabled = true;
    el.readonly = true;
    el.required = true;
    el.error = true;
    el.updated(
      new Map([["disabled", false], ["readonly", false], [
        "required",
        false,
      ], ["error", false]]),
    );

    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.getAttribute("aria-readonly")).toBe("true");
    expect(el.getAttribute("aria-required")).toBe("true");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.tabIndex).toBe(-1);
  });

  it("should use placeholder as an accessible name fallback", () => {
    const el = new CFInput();
    el.placeholder = "Search notes";
    el.updated(new Map([["placeholder", ""]]));

    expect(el.getAttribute("aria-label")).toBe("Search notes");
  });

  it("should preserve author-provided accessible names", () => {
    const el = new CFInput();
    el.setAttribute("aria-label", "Custom name");
    el.placeholder = "Search notes";
    el.updated(new Map([["placeholder", ""]]));

    expect(el.getAttribute("aria-label")).toBe("Custom name");
  });

  it("should use role=spinbutton for number inputs", () => {
    const el = new CFInput();
    el.type = "number";
    el.updated(new Map([["type", "text"]]));

    expect(el.getAttribute("role")).toBe("spinbutton");
  });

  it("should use role=slider for range inputs", () => {
    const el = new CFInput();
    el.type = "range";
    el.updated(new Map([["type", "text"]]));

    expect(el.getAttribute("role")).toBe("slider");
  });

  it("should not set a role for date inputs", () => {
    const el = new CFInput();
    el.type = "date";
    el.updated(new Map([["type", "text"]]));

    expect(el.hasAttribute("role")).toBe(false);
  });

  it("should be form-associated", () => {
    expect(CFInput.formAssociated).toBe(true);
  });

  it("should not rely on delegatesFocus for keyboard navigation", () => {
    expect(CFInput.shadowRootOptions?.delegatesFocus).not.toBe(true);
  });

  it("should accept a CellHandle as value property", () => {
    const el = new CFInput();
    const cell = createMockCellHandle("hello");
    el.value = cell;
    expect(el.value).toBe(cell);
  });

  it("should accept a plain string as value property", () => {
    const el = new CFInput();
    el.value = "world";
    expect(el.value).toBe("world");
  });

  it("should accept all input types", () => {
    const el = new CFInput();
    const types = [
      "text",
      "password",
      "email",
      "number",
      "tel",
      "url",
      "search",
      "date",
      "time",
      "datetime-local",
      "color",
      "file",
      "range",
      "hidden",
    ] as const;

    for (const type of types) {
      el.type = type;
      expect(el.type).toBe(type);
    }
  });

  it("should accept timing strategy options", () => {
    const el = new CFInput();
    el.timingStrategy = "immediate";
    expect(el.timingStrategy).toBe("immediate");

    el.timingStrategy = "blur";
    expect(el.timingStrategy).toBe("blur");

    el.timingDelay = 500;
    expect(el.timingDelay).toBe(500);
  });

  it("commit() returns a promise and resolves", async () => {
    const el = new CFInput();
    // No cell is bound (binding happens in firstUpdated, not run here), so
    // commit() flushes and falls back to the cell controller's setValue (a
    // no-op for an unbound value), then resolves.
    const result = el.commit();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

describe("CFInput — INPUT_PATTERNS", () => {
  it("should have email pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.email}$`);
    expect(re.test("user@example.com")).toBe(true);
    expect(re.test("invalid")).toBe(false);
  });

  it("should have URL pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.url}$`);
    expect(re.test("https://example.com")).toBe(true);
    expect(re.test("ftp://nope")).toBe(false);
  });

  it("should have US phone pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS["tel-us"]}$`);
    expect(re.test("555-123-4567")).toBe(true);
    expect(re.test("1-555-123-4567")).toBe(true);
  });

  it("should have US ZIP code pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS["zip-us"]}$`);
    expect(re.test("12345")).toBe(true);
    expect(re.test("12345-6789")).toBe(true);
    expect(re.test("1234")).toBe(false);
  });

  it("should have alphanumeric pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.alphanumeric}$`);
    expect(re.test("abc123")).toBe(true);
    expect(re.test("abc 123")).toBe(false);
  });
});
