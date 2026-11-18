// First, so that the document it installs is there when Lit loads.
import { internalsOf, mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFForm } from "../form/index.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFTextarea } from "./index.ts";

/** A textarea mounted with `properties`, and every event it fired. */
async function textareaWith(properties: Partial<CFTextarea> = {}) {
  const element = Object.assign(new CFTextarea(), properties);
  const events: { type: string; detail: unknown }[] = [];
  for (
    const type of [
      "cf-input",
      "cf-change",
      "cf-focus",
      "cf-blur",
      "cf-keydown",
      "cf-submit",
    ]
  ) {
    element.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  return { element: await mount(element), events };
}

const field = (element: CFTextarea) =>
  element.shadowRoot!.querySelector("textarea")!;

/** Types `text` over what the textarea holds, as a person does. */
function type(element: CFTextarea, text: string): void {
  field(element).value = text;
  field(element).dispatchEvent(new Event("input", { bubbles: true }));
}

const written = (cell: CellHandle<string>) =>
  writesSent(cell).map((write) => write.value);

describe("CFTextarea", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-textarea`", () => {
    expect(customElements.get("cf-textarea")).toBe(CFTextarea);
  });

  describe("connected", () => {
    it("exposes itself as a focusable, valid textbox", async () => {
      const { element } = await textareaWith();
      expect(element.getAttribute("role")).toBe("textbox");
      expect(element.getAttribute("exportparts")).toBe("textarea");
      expect(element.getAttribute("aria-disabled")).toBe("false");
      expect(element.getAttribute("aria-readonly")).toBe("false");
      expect(element.getAttribute("aria-required")).toBe("false");
      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(element.hasAttribute("aria-label")).toBe(false);
      expect(element.tabIndex).toBe(0);
    });

    it("keeps a role and exported parts the page gave it", async () => {
      const element = new CFTextarea();
      element.setAttribute("role", "searchbox");
      element.setAttribute("exportparts", "textarea: box");
      await mount(element);
      expect(element.getAttribute("role")).toBe("searchbox");
      expect(element.getAttribute("exportparts")).toBe("textarea: box");
    });

    it("exposes a disabled, read-only, required textarea in error", async () => {
      const { element } = await textareaWith({
        disabled: true,
        readonly: true,
        required: true,
        error: true,
      });
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.getAttribute("aria-readonly")).toBe("true");
      expect(element.getAttribute("aria-required")).toBe("true");
      expect(element.getAttribute("aria-invalid")).toBe("true");
      expect(element.tabIndex).toBe(-1);
    });

    it("marks itself invalid while a required textarea is empty, and reports that to its form", async () => {
      const { element } = await textareaWith({ required: true });
      expect(element.getAttribute("aria-invalid")).toBe("true");
      expect(internalsOf(element)?.validity).toEqual({ valueMissing: true });

      element.value = "filled";
      await element.updateComplete;
      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(internalsOf(element)?.validity).toEqual({});
      expect(internalsOf(element)?.formValue).toBe("filled");
    });
  });

  describe("accessible name", () => {
    it("takes the placeholder as its name, and drops it with the placeholder", async () => {
      const { element } = await textareaWith({ placeholder: "Your message" });
      expect(element.getAttribute("aria-label")).toBe("Your message");

      element.placeholder = "";
      await element.updateComplete;
      expect(element.hasAttribute("aria-label")).toBe(false);
    });

    it("keeps a name the page gave it", async () => {
      const element = new CFTextarea();
      element.setAttribute("aria-label", "Notes");
      element.placeholder = "Your message";
      await mount(element);
      expect(element.getAttribute("aria-label")).toBe("Notes");

      const labelled = new CFTextarea();
      labelled.setAttribute("aria-labelledby", "heading");
      labelled.placeholder = "Your message";
      await mount(labelled);
      expect(labelled.hasAttribute("aria-label")).toBe(false);
    });
  });

  describe("render()", () => {
    it("draws a textarea with its defaults", async () => {
      const { element } = await textareaWith();
      const textarea = field(element);
      expect(textarea.getAttribute("rows")).toBe("4");
      expect(textarea.getAttribute("cols")).toBe("50");
      expect(textarea.getAttribute("wrap")).toBe("soft");
      expect(textarea.getAttribute("autocomplete")).toBe("off");
      expect(textarea.hasAttribute("spellcheck")).toBe(true);
      expect(textarea.getAttribute("style")).toBe("resize: vertical;");
      expect(textarea.getAttribute("class")).toBe("");
      for (const name of ["placeholder", "name", "maxlength", "minlength"]) {
        expect(textarea.hasAttribute(name)).toBe(false);
      }
    });

    it("draws a textarea with what it is given", async () => {
      const { element } = await textareaWith({
        placeholder: "Write",
        name: "bio",
        rows: 2,
        cols: 30,
        maxlength: "200",
        minlength: "3",
        wrap: "hard",
        spellcheck: false,
        resize: "both",
        error: true,
        value: "hello",
      });
      const textarea = field(element);
      expect(textarea.getAttribute("placeholder")).toBe("Write");
      expect(textarea.getAttribute("name")).toBe("bio");
      expect(textarea.getAttribute("rows")).toBe("2");
      expect(textarea.getAttribute("cols")).toBe("30");
      expect(textarea.getAttribute("maxlength")).toBe("200");
      expect(textarea.getAttribute("minlength")).toBe("3");
      expect(textarea.getAttribute("wrap")).toBe("hard");
      expect(textarea.hasAttribute("spellcheck")).toBe(false);
      expect(textarea.getAttribute("style")).toBe("resize: both;");
      expect(textarea.getAttribute("class")).toBe("error");
      expect(textarea.value).toBe("hello");
    });

    it("applies a theme given to it directly", async () => {
      const { element } = await textareaWith({
        theme: { ...defaultTheme, fontFamily: "Test Serif" },
      });
      expect(element.style.getPropertyValue("--cf-theme-font-family"))
        .toBe("Test Serif");
    });
  });

  describe("given a plain string", () => {
    it("announces typing with the new value, the previous one, and its name", async () => {
      const { element, events } = await textareaWith({
        value: "a",
        name: "bio",
      });
      type(element, "ab");
      expect(events).toEqual([{
        type: "cf-input",
        detail: { value: "ab", oldValue: "a", name: "bio" },
      }]);
    });

    it("announces a committed change", async () => {
      const { element, events } = await textareaWith({ value: "a" });
      field(element).value = "done";
      field(element).dispatchEvent(new Event("change", { bubbles: true }));
      expect(events).toEqual([{
        type: "cf-change",
        detail: { value: "done", oldValue: "a", name: "" },
      }]);
    });

    it("shows a value set from code", async () => {
      const { element } = await textareaWith({ value: "a" });
      element.value = "b";
      await element.updateComplete;
      expect(field(element).value).toBe("b");
    });
  });

  describe("bound to a cell", () => {
    it("shows the cell's value, and a value it is pushed", async () => {
      const value = createMockCellHandle("first");
      const { element } = await textareaWith({ value });
      expect(field(element).value).toBe("first");

      pushUpdate(value, "second");
      await element.updateComplete;
      expect(field(element).value).toBe("second");
      expect(written(value)).toEqual([]);
    });

    it("writes typing once it pauses for the debounce delay", async () => {
      const value = createMockCellHandle("");
      const { element } = await textareaWith({ value });
      const time = new FakeTime();
      try {
        type(element, "h");
        type(element, "hi");
        time.tick(299);
        expect(written(value)).toEqual([]);
        time.tick(1);
        expect(written(value)).toEqual(["hi"]);
      } finally {
        time.restore();
      }
    });

    it("writes typing at once with the `immediate` strategy", async () => {
      const value = createMockCellHandle("");
      const { element } = await textareaWith({
        value,
        timingStrategy: "immediate",
      });
      type(element, "h");
      expect(written(value)).toEqual(["h"]);
    });

    it("writes typing on blur with the `blur` strategy, set after it rendered", async () => {
      const value = createMockCellHandle("");
      const { element, events } = await textareaWith({ value, name: "bio" });
      element.timingStrategy = "blur";
      await element.updateComplete;

      field(element).dispatchEvent(new FocusEvent("focus"));
      type(element, "hi");
      expect(written(value)).toEqual([]);
      field(element).dispatchEvent(new FocusEvent("blur"));

      expect(written(value)).toEqual(["hi"]);
      expect(events.filter((event) => event.type !== "cf-input")).toEqual([
        { type: "cf-focus", detail: { value: "", name: "bio" } },
        { type: "cf-blur", detail: { value: "hi", name: "bio" } },
      ]);
    });
  });

  describe("a key press", () => {
    it("announces the key, its modifiers, and the value", async () => {
      const { element, events } = await textareaWith({ value: "a" });
      field(element).dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", shiftKey: true }),
      );
      expect(events).toEqual([{
        type: "cf-keydown",
        detail: {
          key: "b",
          value: "a",
          shiftKey: true,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          name: "",
        },
      }]);
    });

    for (const modifier of ["ctrlKey", "metaKey"]) {
      it(`fires \`cf-submit\` on Enter with \`${modifier}\``, async () => {
        const { element, events } = await textareaWith({ value: "a" });
        field(element).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", [modifier]: true }),
        );
        expect(events.map((event) => event.type)).toEqual([
          "cf-keydown",
          "cf-submit",
        ]);
        expect(events[1].detail).toEqual({ value: "a", name: "" });
      });
    }

    it("fires no `cf-submit` on a bare Enter", async () => {
      const { element, events } = await textareaWith();
      field(element).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
      expect(events.map((event) => event.type)).toEqual(["cf-keydown"]);
    });
  });

  describe("auto-resize", () => {
    // The document has no layout, so each case gives the textarea the height
    // its content would take.

    it("grows the textarea to its content as it is typed in, and as its value is set", async () => {
      const { element } = await textareaWith({ autoResize: true });
      const textarea = field(element);
      expect(textarea.getAttribute("style")).toContain("resize: none;");

      Object.defineProperty(textarea, "scrollHeight", {
        configurable: true,
        value: 80,
      });
      type(element, "a\nb\nc");
      expect(textarea.style.height).toBe("80px");

      Object.defineProperty(textarea, "scrollHeight", { value: 120 });
      element.value = "a\nb\nc\nd";
      await element.updateComplete;
      expect(textarea.style.height).toBe("120px");
    });

    it("keeps the height it started at as the least it shrinks to", async () => {
      const { element } = await textareaWith();
      const textarea = field(element);
      Object.defineProperty(textarea, "scrollHeight", {
        configurable: true,
        value: 64,
      });
      element.autoResize = true;
      await element.updateComplete;
      expect(textarea.style.height).toBe("64px");

      Object.defineProperty(textarea, "scrollHeight", { value: 20 });
      type(element, "");
      expect(textarea.style.height).toBe("64px");
    });

    it("lets the textarea be resized as it was given once it is turned off", async () => {
      const { element } = await textareaWith({
        autoResize: true,
        resize: "horizontal",
      });
      expect(field(element).style.getPropertyValue("resize")).toBe("none");
      element.autoResize = false;
      await element.updateComplete;
      expect(field(element).style.getPropertyValue("resize")).toBe(
        "horizontal",
      );
    });
  });

  describe("focus", () => {
    it("forwards focus on the host, and `focus()`, to the textarea", async () => {
      const { element } = await textareaWith();
      element.dispatchEvent(new FocusEvent("focus"));
      expect(element.shadowRoot!.activeElement).toBe(field(element));

      element.blur();
      element.focus();
      expect(element.shadowRoot!.activeElement).toBe(field(element));
    });

    it("takes no focus while disabled", async () => {
      const { element, events } = await textareaWith({ disabled: true });
      element.dispatchEvent(new FocusEvent("focus"));
      element.focus();
      expect(events).toEqual([]);
    });

    it("focuses the textarea as it first renders when `autofocus` is set", async () => {
      const { events } = await textareaWith({ autofocus: true });
      expect(events.map((event) => event.type)).toEqual(["cf-focus"]);
    });
  });

  describe("checkValidity()", () => {
    it("returns whether a required textarea holds text, with the textarea's message", async () => {
      const { element } = await textareaWith({ required: true });
      expect(element.checkValidity()).toBe(false);
      expect(element.validationMessage).toBe(field(element).validationMessage);

      element.value = "text";
      await element.updateComplete;
      expect(element.checkValidity()).toBe(true);
      expect(element.validationMessage).toBe("");
    });

    it("returns `true`, with no message, before the textarea has rendered", () => {
      const element = new CFTextarea();
      expect(element.checkValidity()).toBe(true);
      expect(element.validationMessage).toBe("");
    });
  });

  describe("in a `cf-form`", () => {
    it("holds typing until the form is submitted, then writes it", async () => {
      const value = createMockCellHandle("");
      const form = new CFForm();
      const element = Object.assign(new CFTextarea(), { value });
      form.append(element);
      await mount(form);
      await element.updateComplete;

      type(element, "draft");
      await element.updateComplete;
      expect(field(element).value).toBe("draft");
      expect(written(value)).toEqual([]);

      form.submit();
      await settle();
      expect(written(value)).toEqual(["draft"]);
    });

    it("stops a submission while a required textarea is empty", async () => {
      const form = new CFForm();
      const element = Object.assign(new CFTextarea(), { required: true });
      form.append(element);
      await mount(form);
      await element.updateComplete;
      const invalid: unknown[] = [];
      form.addEventListener("cf-form-invalid", (event) => {
        if (event instanceof CustomEvent) invalid.push(event.detail);
      });

      form.submit();
      await settle();

      expect(invalid).toEqual([{
        errors: [{ element, message: element.validationMessage }],
      }]);
    });
  });
});
