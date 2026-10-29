import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFTextarea } from "./index.ts";

describe("CFTextarea", () => {
  // NOTE: Full DOM interaction tests (input events, Cell two-way binding,
  // auto-resize, timing strategy integration) require Lit's rendering
  // pipeline and shadow DOM. Tests below cover property defaults, Cell
  // property acceptance, and basic configuration.

  it("should be defined", () => {
    expect(CFTextarea).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-textarea")).toBe(CFTextarea);
  });

  it("should create element instance", () => {
    const element = new CFTextarea();
    expect(element).toBeInstanceOf(CFTextarea);
  });

  if (typeof document !== "undefined") {
    it("should be creatable via document.createElement", async () => {
      const element = document.createElement("cf-textarea") as CFTextarea;
      document.body.append(element);
      await element.updateComplete;

      expect(element).toBeInstanceOf(CFTextarea);
      expect(element.getAttribute("role")).toBe("textbox");
      expect(element.getAttribute("exportparts")).toBe("textarea");

      element.remove();
    });
  }

  it("should have correct default properties", () => {
    const el = new CFTextarea();
    expect(el.placeholder).toBe("");
    expect(el.value).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.readonly).toBe(false);
    expect(el.error).toBe(false);
    expect(el.rows).toBe(4);
    expect(el.name).toBe("");
    expect(el.required).toBe(false);
    expect(el.autoResize).toBe(false);
    expect(el.timingStrategy).toBe("debounce");
    expect(el.timingDelay).toBe(300);
  });

  it("should expose textbox semantics on the host", () => {
    const el = new CFTextarea();
    el.updated(new Map([["disabled", undefined]]));

    expect(el.getAttribute("role")).toBe("textbox");
    expect(el.getAttribute("aria-disabled")).toBe("false");
    expect(el.getAttribute("aria-readonly")).toBe("false");
    expect(el.getAttribute("aria-required")).toBe("false");
    expect(el.getAttribute("aria-invalid")).toBe("false");
    expect(el.getAttribute("exportparts")).toBe("textarea");
    expect(el.tabIndex).toBe(0);
  });

  it("should expose control state on the host", () => {
    const el = new CFTextarea();
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
    const el = new CFTextarea();
    el.placeholder = "Write your message";
    el.updated(new Map([["placeholder", ""]]));

    expect(el.getAttribute("aria-label")).toBe("Write your message");
  });

  it("should preserve author-provided accessible names", () => {
    const el = new CFTextarea();
    el.setAttribute("aria-label", "Custom name");
    el.placeholder = "Write your message";
    el.updated(new Map([["placeholder", ""]]));

    expect(el.getAttribute("aria-label")).toBe("Custom name");
  });

  it("should be form-associated", () => {
    expect(CFTextarea.formAssociated).toBe(true);
  });

  it("should not rely on delegatesFocus for keyboard navigation", () => {
    expect(CFTextarea.shadowRootOptions?.delegatesFocus).not.toBe(true);
  });

  it("should not set attributes in constructor (custom element spec)", () => {
    // The custom element spec forbids setAttribute during construction.
    // Attributes are set in connectedCallback instead.
    const el = new CFTextarea();
    expect(el.getAttribute("role")).toBeNull();
    expect(el.getAttribute("exportparts")).toBeNull();
  });

  it("should accept a CellHandle as value property", () => {
    const el = new CFTextarea();
    const cell = createMockCellHandle("multi\nline\ntext");
    el.value = cell;
    expect(el.value).toBe(cell);
  });

  it("should accept a plain string as value property", () => {
    const el = new CFTextarea();
    el.value = "hello world";
    expect(el.value).toBe("hello world");
  });

  it("should accept timing strategy options", () => {
    const el = new CFTextarea();
    el.timingStrategy = "immediate";
    expect(el.timingStrategy).toBe("immediate");

    el.timingStrategy = "blur";
    expect(el.timingStrategy).toBe("blur");

    el.timingDelay = 500;
    expect(el.timingDelay).toBe(500);
  });

  it("should accept auto-resize option", () => {
    const el = new CFTextarea();
    el.autoResize = true;
    expect(el.autoResize).toBe(true);
  });

  it("should accept rows and cols", () => {
    const el = new CFTextarea();
    el.rows = 10;
    el.cols = 40;
    expect(el.rows).toBe(10);
    expect(el.cols).toBe(40);
  });
});
