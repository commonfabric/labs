// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ContextEvent } from "@lit/context";

import { CFForm, type FieldRegistration, formContext } from "./index.ts";

/** What each field was asked to do, in order, across every field. */
type Calls = string[];

/**
 * A field inside `form`, registered through the context the form provides,
 * as a form field controller registers one. Returns the function that
 * unregisters it.
 */
function addField(
  form: CFForm,
  calls: Calls,
  name: string,
  overrides: Partial<FieldRegistration> = {},
): { element: HTMLElement; unregister: () => void } {
  const element = document.createElement("div");
  form.append(element);
  let unregister: (() => void) | undefined;
  element.dispatchEvent(
    new ContextEvent(formContext, element, (context) => {
      unregister = context?.registerField({
        element,
        validate: () => {
          calls.push(`validate ${name}`);
          return { valid: true };
        },
        flush: () => {
          calls.push(`flush ${name}`);
          return Promise.resolve();
        },
        reset: () => calls.push(`reset ${name}`),
        ...overrides,
      });
    }),
  );
  if (unregister === undefined) throw new Error("the form provided nothing");
  return { element, unregister };
}

/** A mounted form, and every event it fired, by type and detail. */
async function formWith(properties: Partial<CFForm> = {}) {
  const element = Object.assign(new CFForm(), properties);
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["cf-submit", "cf-form-invalid", "cf-submit-error"]) {
    element.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  await mount(element);
  // The native submission, which leaves the page, is counted instead.
  const form = element.shadowRoot!.querySelector("form")!;
  const native = { submissions: 0, resets: 0 };
  form.submit = () => native.submissions++;
  form.reset = () => native.resets++;
  return { element, events, form, native };
}

describe("CFForm", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-form`", () => {
    expect(customElements.get("cf-form")).toBe(CFForm);
  });

  describe("render()", () => {
    it("draws a form with the given method and action around its content", async () => {
      const { form } = await formWith({ method: "POST", action: "/save" });
      expect(form.getAttribute("method")).toBe("POST");
      expect(form.getAttribute("action")).toBe("/save");
      expect(form.querySelector("slot")).not.toBeNull();
    });
  });

  describe("submit()", () => {
    it("fires `cf-submit` for a form with no fields, and stops the native event", async () => {
      const { element, events, form, native } = await formWith();
      let reachedHost = false;
      element.addEventListener("submit", () => reachedHost = true);
      const submission = new Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      form.dispatchEvent(submission);
      await settle();

      expect(submission.defaultPrevented).toBe(true);
      expect(reachedHost).toBe(false);
      expect(events).toEqual([{ type: "cf-submit", detail: null }]);
      expect(native.submissions).toBe(0);
    });

    it("validates every field, then flushes every field, then fires `cf-submit`", async () => {
      const { element, events } = await formWith();
      const calls: Calls = [];
      addField(element, calls, "a");
      addField(element, calls, "b");
      element.addEventListener("cf-submit", () => calls.push("cf-submit"));

      element.submit();
      await settle();

      expect(calls).toEqual([
        "validate a",
        "validate b",
        "flush a",
        "flush b",
        "cf-submit",
      ]);
      expect(events.map((event) => event.type)).toEqual(["cf-submit"]);
    });

    it("waits for every flush to finish before firing `cf-submit`", async () => {
      const { element, events } = await formWith();
      const flushed = Promise.withResolvers<void>();
      addField(element, [], "a", { flush: () => flushed.promise });

      element.submit();
      await settle();
      expect(events).toEqual([]);

      flushed.resolve();
      await settle();
      expect(events.map((event) => event.type)).toEqual(["cf-submit"]);
    });

    it("fires `cf-form-invalid` naming each invalid field, and flushes nothing", async () => {
      const { element, events } = await formWith();
      const calls: Calls = [];
      const { element: bad } = addField(element, calls, "bad", {
        validate: () => ({ valid: false, message: "Required" }),
      });
      addField(element, calls, "good");

      element.submit();
      await settle();

      expect(events).toEqual([{
        type: "cf-form-invalid",
        detail: { errors: [{ element: bad, message: "Required" }] },
      }]);
      expect(calls).toEqual(["validate good"]);
    });

    it("fires `cf-submit-error` with the failure when a flush fails", async () => {
      const { element, events } = await formWith({ action: "/save" });
      const error = new Error("storage is full");
      addField(element, [], "a", { flush: () => Promise.reject(error) });

      element.submit();
      await settle();

      expect(events).toEqual([{
        type: "cf-submit-error",
        detail: { error, message: "storage is full" },
      }]);
    });

    it("names a generic failure for a flush that fails with something other than an `Error`", async () => {
      const { element, events } = await formWith();
      addField(element, [], "a", { flush: () => Promise.reject("nope") });

      element.submit();
      await settle();

      expect(events).toEqual([{
        type: "cf-submit-error",
        detail: { error: "nope", message: "Failed to save form data" },
      }]);
    });

    it("leaves out a field that has unregistered", async () => {
      const { element } = await formWith();
      const calls: Calls = [];
      addField(element, calls, "kept");
      addField(element, calls, "gone").unregister();

      element.submit();
      await settle();

      expect(calls).toEqual(["validate kept", "flush kept"]);
    });

    it("submits natively to an action once `cf-submit` is not cancelled", async () => {
      const { element, native } = await formWith({ action: "/save" });
      element.submit();
      await settle();
      expect(native.submissions).toBe(1);
    });

    it("does not submit natively when `cf-submit` is cancelled", async () => {
      const { element, native } = await formWith({ action: "/save" });
      element.addEventListener("cf-submit", (event) => event.preventDefault());
      element.submit();
      await settle();
      expect(native.submissions).toBe(0);
    });

    it("does nothing before the form has rendered", () => {
      const element = new CFForm();
      let fired = false;
      element.addEventListener("cf-submit", () => fired = true);
      element.submit();
      expect(fired).toBe(false);
    });
  });

  describe("reset()", () => {
    it("resets every field and the native form", async () => {
      const { element, native } = await formWith();
      const calls: Calls = [];
      addField(element, calls, "a");
      addField(element, calls, "b");

      element.reset();

      expect(calls).toEqual(["reset a", "reset b"]);
      expect(native.resets).toBe(1);
    });

    it("resets the fields of a form that has not rendered", () => {
      const element = new CFForm();
      expect(() => element.reset()).not.toThrow();
    });
  });
});
