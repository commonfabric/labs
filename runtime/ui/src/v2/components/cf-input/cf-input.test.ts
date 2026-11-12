// First, so that the document it installs is there when Lit loads.
import { internalsOf, mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { ContextProvider } from "@lit/context";
import type { CellRef } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { type FieldRegistration, formContext } from "../form/form-context.ts";
import { defaultTheme, themeProperties } from "../theme-context.ts";
import { CFInput, INPUT_PATTERNS, type InputType } from "./index.ts";

/** The native input `element` renders. */
function inputOf(element: CFInput): HTMLInputElement {
  const input = element.shadowRoot?.querySelector("input");
  if (!input) throw new Error("cf-input rendered no input");
  return input;
}

/** Sets the value of `element`'s input and dispatches `type` from it. */
function enter(element: CFInput, text: string, type = "input"): void {
  const input = inputOf(element);
  input.value = text;
  input.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
}

/** The detail of each `name` event `target` dispatches from now on. */
function detailsOf(target: EventTarget, name: string): unknown[] {
  const details: unknown[] = [];
  target.addEventListener(
    name,
    (event) => details.push(event instanceof CustomEvent ? event.detail : null),
  );
  return details;
}

/** A `cf-input` with `properties` set, mounted in the document. */
function mountInput(properties: Partial<CFInput> = {}): Promise<CFInput> {
  return mount(Object.assign(new CFInput(), properties));
}

/**
 * A stand-in for `cf-form`, in the document: an element providing the form
 * context to what is placed inside it, which records each field that
 * registers with it.
 */
function formStandIn(): { form: HTMLElement; fields: FieldRegistration[] } {
  const form = document.createElement("div");
  const fields: FieldRegistration[] = [];
  new ContextProvider(form, {
    context: formContext,
    initialValue: {
      registerField: (field) => {
        fields.push(field);
        return () => {};
      },
    },
  });
  document.body.append(form);
  return { form, fields };
}

describe("CFInput", () => {
  afterEach(() => document.body.replaceChildren());

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

  it("should be creatable via document.createElement", async () => {
    const element = document.createElement("cf-input") as CFInput;
    document.body.append(element);
    await element.updateComplete;

    expect(element).toBeInstanceOf(CFInput);
    expect(element.getAttribute("role")).toBe("textbox");
    expect(element.getAttribute("exportparts")).toBe("input");
  });

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

  describe("rendering", () => {
    it("renders the bound cell's value into its input", async () => {
      const element = await mountInput({
        value: createMockCellHandle("hello"),
      });

      expect(inputOf(element).value).toBe("hello");
    });

    it("renders the new cell's value when the value moves to another cell", async () => {
      const element = await mountInput({
        value: createMockCellHandle("first"),
      });

      element.value = createMockCellHandle("second", {
        id: "of:second" as CellRef["id"],
      });
      await element.updateComplete;

      expect(inputOf(element).value).toBe("second");
    });

    it("replaces unwritten typing when the value moves to a cell holding the text last rendered", async () => {
      // A plain string takes no write, so what is typed stays in the input
      // alone, and the new cell's value matches what was last rendered.
      const element = await mountInput({
        value: "same",
        timingStrategy: "immediate",
      });
      enter(element, "typed");

      element.value = createMockCellHandle("same");
      await element.updateComplete;

      expect(inputOf(element).value).toBe("same");
    });

    it("leaves a file input's value empty whatever the value property holds", async () => {
      const element = await mountInput({ type: "file", value: "report.pdf" });

      expect(inputOf(element).value).toBe("");
    });

    it("renders the email pattern on an email input", async () => {
      const element = await mountInput({ type: "email" });

      expect(inputOf(element).getAttribute("pattern")).toBe(
        INPUT_PATTERNS.email,
      );
    });

    it("renders the URL pattern on a URL input", async () => {
      const element = await mountInput({ type: "url" });

      expect(inputOf(element).getAttribute("pattern")).toBe(INPUT_PATTERNS.url);
    });

    it("renders no pattern on a text input", async () => {
      const element = await mountInput();

      expect(inputOf(element).hasAttribute("pattern")).toBe(false);
    });

    it("renders a predefined validation pattern over the type's own", async () => {
      const element = await mountInput({
        type: "email",
        validationPattern: "zip-us",
      });

      expect(inputOf(element).getAttribute("pattern")).toBe(
        INPUT_PATTERNS["zip-us"],
      );
    });

    it("renders a custom pattern over a predefined one", async () => {
      const element = await mountInput({
        pattern: "[a-c]+",
        validationPattern: "zip-us",
      });

      expect(inputOf(element).getAttribute("pattern")).toBe("[a-c]+");
    });

    it("renders the input mode each type implies", async () => {
      const implied: [InputType, string][] = [
        ["email", "email"],
        ["tel", "tel"],
        ["url", "url"],
        ["number", "numeric"],
        ["search", "search"],
        ["text", "text"],
        ["date", "text"],
      ];
      for (const [type, mode] of implied) {
        const element = await mountInput({ type });

        expect([type, inputOf(element).getAttribute("inputmode")]).toEqual([
          type,
          mode,
        ]);
      }
    });

    it("renders an explicit input mode over the one the type implies", async () => {
      const element = await mountInput({
        type: "number",
        inputmode: "decimal",
      });

      expect(inputOf(element).getAttribute("inputmode")).toBe("decimal");
    });

    it("renders `multiple` and `accept` on a file input", async () => {
      const element = await mountInput({
        type: "file",
        multiple: true,
        accept: "image/*",
      });

      expect(inputOf(element).hasAttribute("multiple")).toBe(true);
      expect(inputOf(element).getAttribute("accept")).toBe("image/*");
    });

    it("renders neither `multiple` nor `accept` on a text input", async () => {
      const element = await mountInput({ multiple: true, accept: "image/*" });

      expect(inputOf(element).hasAttribute("multiple")).toBe(false);
      expect(inputOf(element).hasAttribute("accept")).toBe(false);
    });

    it("renders the error class when `error` is set", async () => {
      const element = await mountInput({ error: true });

      expect(inputOf(element).classList.contains("error")).toBe(true);
    });

    it("renders no error class on a valid input when showing validation", async () => {
      // `error` is overruled: with validation shown, the input's own validity
      // decides.
      const element = await mountInput({
        value: "filled",
        required: true,
        error: true,
        showValidation: true,
      });

      expect(inputOf(element).classList.contains("error")).toBe(false);
    });
  });

  describe("typing", () => {
    it("writes what is typed to the bound cell and dispatches `cf-input`", async () => {
      const cell = createMockCellHandle("start");
      const element = await mountInput({
        value: cell,
        name: "query",
        timingStrategy: "immediate",
      });
      const inputs = detailsOf(element, "cf-input");

      enter(element, "typed");

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "typed" }),
      ]);
      expect(inputs).toEqual([{
        value: "typed",
        oldValue: "start",
        name: "query",
        files: undefined,
      }]);
    });

    it("dispatches `cf-change` with what is typed", async () => {
      const element = await mountInput({
        value: "start",
        name: "query",
        timingStrategy: "immediate",
      });
      const changes = detailsOf(element, "cf-change");

      enter(element, "typed");

      expect(changes).toEqual([{
        value: "typed",
        oldValue: "start",
        name: "query",
        files: undefined,
      }]);
    });

    it("writes and dispatches `cf-change` only once the debounce delay has passed", async () => {
      using time = new FakeTime();
      const cell = createMockCellHandle("start");
      const element = await mountInput({ value: cell, timingDelay: 200 });
      const changes = detailsOf(element, "cf-change");

      enter(element, "typed");
      time.tick(199);

      expect(writesSent(cell)).toEqual([]);
      expect(changes).toEqual([]);

      time.tick(1);

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "typed" }),
      ]);
      expect(changes).toContainEqual(
        expect.objectContaining({ value: "typed", oldValue: "start" }),
      );
    });

    it("writes what is typed only on blur under the blur strategy", async () => {
      const cell = createMockCellHandle("start");
      const element = await mountInput({
        value: cell,
        name: "query",
        timingStrategy: "blur",
      });
      const focuses = detailsOf(element, "cf-focus");
      const blurs = detailsOf(element, "cf-blur");

      inputOf(element).dispatchEvent(new FocusEvent("focus"));
      enter(element, "typed");

      expect(focuses).toEqual([{ value: "start", name: "query" }]);
      expect(writesSent(cell)).toEqual([]);

      inputOf(element).dispatchEvent(new FocusEvent("blur"));

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "typed" }),
      ]);
      expect(blurs).toEqual([{ value: "typed", name: "query" }]);
    });

    it("follows a timing strategy changed after it first rendered", async () => {
      const cell = createMockCellHandle("start");
      const element = await mountInput({
        value: cell,
        timingStrategy: "immediate",
      });

      element.timingStrategy = "blur";
      await element.updateComplete;
      enter(element, "typed");

      expect(writesSent(cell)).toEqual([]);
    });

    it("writes the committed value on `change`", async () => {
      const cell = createMockCellHandle("start");
      const element = await mountInput({
        value: cell,
        timingStrategy: "immediate",
      });
      const inputs = detailsOf(element, "cf-input");

      enter(element, "committed", "change");

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "committed" }),
      ]);
      expect(inputs).toEqual([]);
    });

    it("dispatches the chosen files rather than a value from a file input", async () => {
      const element = await mountInput({
        type: "file",
        name: "upload",
        timingStrategy: "immediate",
      });
      const input = inputOf(element);
      const inputs = detailsOf(element, "cf-input");
      const changes = detailsOf(element, "cf-change");

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const detail = {
        value: "",
        oldValue: "",
        name: "upload",
        files: input.files,
      };
      expect(input.files).not.toBeUndefined();
      expect(inputs).toEqual([detail]);
      expect(changes).toEqual([detail, detail]);
    });
  });

  describe("keys", () => {
    it("dispatches `cf-keydown` with the key and its modifiers", async () => {
      const element = await mountInput({ value: "abc", name: "query" });
      const keys = detailsOf(element, "cf-keydown");
      const submits = detailsOf(element, "cf-submit");

      inputOf(element).dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true }),
      );

      expect(keys).toEqual([{
        key: "a",
        value: "abc",
        shiftKey: false,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        name: "query",
      }]);
      expect(submits).toEqual([]);
    });

    it("dispatches `cf-submit` on Enter", async () => {
      const element = await mountInput({ value: "abc", name: "query" });
      const submits = detailsOf(element, "cf-submit");

      inputOf(element).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );

      expect(submits).toEqual([{ value: "abc", name: "query" }]);
    });
  });

  describe("validation", () => {
    it("dispatches `cf-invalid` and cancels the browser's own report", async () => {
      const element = await mountInput({ required: true, name: "email" });
      const input = inputOf(element);
      const invalids = detailsOf(element, "cf-invalid");
      let cancelled = false;
      input.addEventListener("invalid", (event) => {
        cancelled = event.defaultPrevented;
      });

      expect(element.reportValidity()).toBe(false);

      expect(cancelled).toBe(true);
      expect(invalids).toEqual([{
        value: "",
        name: "email",
        validationMessage: input.validationMessage,
        validity: input.validity,
      }]);
      expect(input.validationMessage).not.toBe("");
      expect(element.getAttribute("aria-invalid")).toBe("true");
    });

    it("repaints the error class on an invalid event when showing validation", async () => {
      const element = await mountInput({ value: "x", showValidation: true });
      const input = inputOf(element);
      expect(input.classList.contains("error")).toBe(false);

      element.setCustomValidity("Taken");
      element.checkValidity();
      await element.updateComplete;

      expect(input.classList.contains("error")).toBe(true);
    });

    it("returns its input's custom validity", async () => {
      const element = await mountInput({ value: "x" });

      element.setCustomValidity("Taken");

      expect(element.checkValidity()).toBe(false);
      expect(element.validationMessage).toBe("Taken");
      expect(element.validity?.customError).toBe(true);

      element.setCustomValidity("");

      expect(element.checkValidity()).toBe(true);
      expect(element.validationMessage).toBe("");
    });

    it("returns valid before it has rendered", () => {
      const element = new CFInput();
      element.required = true;

      expect(element.checkValidity()).toBe(true);
      expect(element.reportValidity()).toBe(true);
      expect(element.validity).toBeUndefined();
      expect(element.validationMessage).toBe("");
    });

    it("reports its value and validity through ElementInternals", async () => {
      const element = await mountInput({
        value: createMockCellHandle("start"),
        required: true,
      });

      expect(internalsOf(element)?.formValue).toBe("start");
      expect(internalsOf(element)?.validationMessage).toBe("");

      element.value = "";
      await element.updateComplete;

      expect(internalsOf(element)?.formValue).toBe("");
      expect(inputOf(element).validationMessage).not.toBe("");
      expect(internalsOf(element)?.validationMessage).toBe(
        inputOf(element).validationMessage,
      );
    });
  });

  describe("in a form", () => {
    it("registers itself with the form", async () => {
      const { form, fields } = formStandIn();
      const element = Object.assign(new CFInput(), { name: "email" });

      form.append(element);
      await element.updateComplete;

      expect(fields.map(({ element }) => element)).toEqual([element]);
    });

    it("holds what is typed for the form rather than writing the cell", async () => {
      const { form, fields } = formStandIn();
      const cell = createMockCellHandle("start");
      const element = Object.assign(new CFInput(), {
        value: cell,
        timingStrategy: "immediate" as const,
      });
      form.append(element);
      await element.updateComplete;

      enter(element, "typed");
      await element.commit();

      expect(writesSent(cell)).toEqual([]);

      await fields[0].flush();

      expect(writesSent(cell).map(({ value }) => value)).toEqual(["typed"]);
    });

    it("returns its input's validity to the form", async () => {
      const { form, fields } = formStandIn();
      const element = Object.assign(new CFInput(), { required: true });
      form.append(element);
      await element.updateComplete;

      expect(fields[0].validate()).toEqual({
        valid: false,
        message: inputOf(element).validationMessage,
      });

      enter(element, "x");

      expect(fields[0].validate()).toEqual({ valid: true, message: "" });
    });
  });

  describe("accessibility", () => {
    it("sets the spinbutton's range and value on the host", async () => {
      const element = await mountInput({
        type: "number",
        min: "1",
        max: "9",
        value: "5",
      });

      expect(element.getAttribute("aria-valuemin")).toBe("1");
      expect(element.getAttribute("aria-valuemax")).toBe("9");
      expect(element.getAttribute("aria-valuenow")).toBe("5");
    });

    it("removes the spinbutton's range and value when they are cleared", async () => {
      const element = await mountInput({
        type: "number",
        min: "1",
        max: "9",
        value: "5",
      });

      Object.assign(element, { min: "", max: "", value: "" });
      await element.updateComplete;

      expect(element.hasAttribute("aria-valuemin")).toBe(false);
      expect(element.hasAttribute("aria-valuemax")).toBe(false);
      expect(element.hasAttribute("aria-valuenow")).toBe(false);
    });

    it("removes the range and value when the type stops being a number", async () => {
      const element = await mountInput({
        type: "number",
        min: "1",
        max: "9",
        value: "5",
      });

      element.type = "text";
      await element.updateComplete;

      expect(element.getAttribute("role")).toBe("textbox");
      expect(element.hasAttribute("aria-valuemin")).toBe(false);
      expect(element.hasAttribute("aria-valuemax")).toBe(false);
      expect(element.hasAttribute("aria-valuenow")).toBe(false);
    });

    it("removes the role it set when the type changes to one with none", async () => {
      const element = await mountInput();

      element.type = "date";
      await element.updateComplete;

      expect(element.hasAttribute("role")).toBe(false);
    });

    it("keeps a role its author set when the type changes", async () => {
      const element = new CFInput();
      element.setAttribute("role", "combobox");
      await mount(element);

      element.type = "number";
      await element.updateComplete;

      expect(element.getAttribute("role")).toBe("combobox");
    });

    it("removes the aria-label it set when the placeholder is cleared", async () => {
      const element = await mountInput({ placeholder: "Search notes" });

      element.placeholder = "";
      await element.updateComplete;

      expect(element.hasAttribute("aria-label")).toBe(false);
    });
  });

  describe("focus", () => {
    it("forwards focus on the host to its input", async () => {
      const element = await mountInput();

      element.dispatchEvent(new FocusEvent("focus"));

      expect(element.shadowRoot?.activeElement).toBe(inputOf(element));
    });

    it("moves focus to its input when focused", async () => {
      const element = await mountInput();

      element.focus();

      expect(element.shadowRoot?.activeElement).toBe(inputOf(element));
    });

    it("takes no focus while disabled", async () => {
      const element = await mountInput({ disabled: true });

      element.focus();
      element.dispatchEvent(new FocusEvent("focus"));

      expect(element.shadowRoot?.activeElement).toBeNull();
    });

    it("moves focus to its input once it renders when focused before", async () => {
      const element = new CFInput();
      document.body.append(element);

      element.focus();
      await element.updateComplete;

      expect(element.shadowRoot?.activeElement).toBe(inputOf(element));
    });

    it("leaves focus where it went when it moved away before the input rendered", async () => {
      const element = new CFInput();
      const other = document.createElement("button");
      document.body.append(element, other);

      element.focus();
      other.focus();
      await element.updateComplete;

      expect(document.activeElement).toBe(other);
      expect(element.shadowRoot?.activeElement).toBeNull();
    });

    it("focuses its input on first render when `autofocus` is set", async () => {
      const element = await mountInput({ autofocus: true });

      expect(element.shadowRoot?.activeElement).toBe(inputOf(element));
    });

    it("leaves focus alone on first render when `autofocus` is unset", async () => {
      const element = await mountInput();

      expect(element.shadowRoot?.activeElement).toBeNull();
    });

    it("takes focus from its input on `blur()`", async () => {
      const element = await mountInput();
      element.focus();

      element.blur();

      expect(element.shadowRoot?.activeElement).toBeNull();
    });

    it("selects its input's text on `select()` and `setSelectionRange()`", async () => {
      const element = await mountInput({ value: "hello" });
      const input = inputOf(element);

      element.setSelectionRange(1, 3);

      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);

      element.select();

      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    });
  });

  describe("theme", () => {
    it("writes a theme set on it onto its own style, and takes it back off when unset", async () => {
      const [[name, value]] = Object.entries(themeProperties(defaultTheme));
      const element = await mountInput({ theme: defaultTheme });

      expect(element.style.getPropertyValue(name)).toBe(value);

      element.theme = undefined;
      await element.updateComplete;

      expect(element.style.getPropertyValue(name)).toBe("");
    });
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
