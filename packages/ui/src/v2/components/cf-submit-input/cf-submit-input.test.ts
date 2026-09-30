import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFSubmitInput } from "./index.ts";

// The unit runner uses Lit's SSR DOM shim: instances and direct method/lifecycle
// calls work, but there is no real shadow-DOM rendering. These tests exercise
// the component's logic by constructing an instance and driving its handlers
// with realistic mock events, asserting the observable value / clear behavior.
// Full rendered-DOM interaction is covered by the browser integration tests
// (home-profile / shared-profile).

type Internals = {
  _onInput(event: Event): void;
  _onClick(event: Event): void;
  _onFormSubmit(event: Event): void;
  _isSubmitGesture(event: Event): boolean;
  _submitting: boolean;
  _seeded: boolean;
  willUpdate(changed: Map<string, unknown>): void;
  render(): unknown;
};

function internals(el: CFSubmitInput): Internals {
  return el as unknown as Internals;
}

// How a click reached the form: through the visible cf-button, through the
// hidden native submit button (the browser's implicit-submission click on
// Enter), or through neither (a click on the field or surrounding gap).
type ClickVia = "button" | "submit" | "none";

// A click event with the composed path for the given route, plus a
// stopPropagation spy.
function clickEvent(via: ClickVia): Event & { stopped: boolean } {
  const path = via === "button"
    ? [{ tagName: "INPUT" }, { tagName: "CF-BUTTON" }]
    : via === "submit"
    ? [{ tagName: "BUTTON", type: "submit" }, { tagName: "FORM" }]
    : [{ tagName: "INPUT" }, { tagName: "DIV" }];
  const event = {
    stopped: false,
    composedPath: () => path,
    stopPropagation() {
      (this as { stopped: boolean }).stopped = true;
    },
  };
  return event as unknown as Event & { stopped: boolean };
}

// Lets a pending setTimeout(0) callback run.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("CFSubmitInput", () => {
  it("is defined and registered", () => {
    expect(CFSubmitInput).toBeDefined();
    expect(customElements.get("cf-submit-input")).toBe(CFSubmitInput);
  });

  it("has the expected property defaults", () => {
    const el = new CFSubmitInput();
    expect(el.placeholder).toBe("");
    expect(el.buttonText).toBe("Submit");
    expect(el.inputId).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.initialValue).toBe("");
    expect(el.value).toBe("");
  });

  it("retains controlled text until its caller accepts the submission", () => {
    const el = new CFSubmitInput();
    el.clearOnSubmit = false;
    el.value = "Shared draft";
    const event = clickEvent("button");
    internals(el)._onClick(event);
    expect(event.stopped).toBe(false);
    expect(el.value).toBe("Shared draft");
    const duplicate = clickEvent("submit");
    internals(el)._onClick(duplicate);
    expect(duplicate.stopped).toBe(true);
    el.value = "";
    internals(el).willUpdate(new Map([["value", "Shared draft"]]));
    el.value = "Next message";
    const next = clickEvent("button");
    internals(el)._onClick(next);
    expect(next.stopped).toBe(false);
  });

  it("accepts an explicit false clear-on-submit attribute", () => {
    const el = new CFSubmitInput();
    el.attributeChangedCallback("clear-on-submit", null, "false");
    expect(el.clearOnSubmit).toBe(false);
    el.attributeChangedCallback("clear-on-submit", "false", null);
    expect(el.clearOnSubmit).toBe(true);
  });

  describe("willUpdate / initialValue seeding", () => {
    it("seeds value from initialValue once on first update", () => {
      const el = new CFSubmitInput();
      el.initialValue = "Ada";
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("Ada");
      expect(internals(el)._seeded).toBe(true);
    });

    it("does not re-seed after the first time", () => {
      const el = new CFSubmitInput();
      el.initialValue = "Ada";
      internals(el).willUpdate(new Map());
      // A later initialValue change is ignored; the field is uncontrolled.
      el.initialValue = "Bob";
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("Ada");
    });

    it("does not seed when initialValue is empty", () => {
      const el = new CFSubmitInput();
      internals(el).willUpdate(new Map());
      expect(el.value).toBe("");
      expect(internals(el)._seeded).toBe(false);
    });
  });

  it("_onInput mirrors the inner input value into `value`", () => {
    const el = new CFSubmitInput();
    internals(el)._onInput({ target: { value: "typed" } } as unknown as Event);
    expect(el.value).toBe("typed");
  });

  describe("_isSubmitGesture", () => {
    it("recognizes a click through the visible cf-button", () => {
      const el = new CFSubmitInput();
      expect(internals(el)._isSubmitGesture(clickEvent("button"))).toBe(true);
    });

    it("recognizes the implicit-submission click on the hidden submit button", () => {
      const el = new CFSubmitInput();
      expect(internals(el)._isSubmitGesture(clickEvent("submit"))).toBe(true);
    });

    it("does not treat a field or gap click as a submit", () => {
      const el = new CFSubmitInput();
      expect(internals(el)._isSubmitGesture(clickEvent("none"))).toBe(false);
    });
  });

  describe("_onClick gating", () => {
    it("stops a click that is not a submit gesture", () => {
      const el = new CFSubmitInput();
      const event = clickEvent("none");
      internals(el)._onClick(event);
      expect(event.stopped).toBe(true);
    });

    it("lets a button-click submit gesture reach the host", () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      const event = clickEvent("button");
      internals(el)._onClick(event);
      expect(event.stopped).toBe(false);
    });

    it("lets an Enter-driven submit-button gesture reach the host", () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      const event = clickEvent("submit");
      internals(el)._onClick(event);
      expect(event.stopped).toBe(false);
    });
  });

  describe("_onFormSubmit", () => {
    it("cancels the form's native submission so the page does not navigate", () => {
      const el = new CFSubmitInput();
      let prevented = false;
      const event = {
        preventDefault() {
          prevented = true;
        },
      } as unknown as Event;
      internals(el)._onFormSubmit(event);
      expect(prevented).toBe(true);
    });
  });

  describe("_onClick submit handling", () => {
    it("ignores an empty submit and stops it reaching the host", async () => {
      const el = new CFSubmitInput();
      el.value = "   ";
      const event = clickEvent("button");
      internals(el)._onClick(event);
      // An empty submit fires no create: the flag stays clear, the value is
      // untouched, and the click is stopped at the shadow boundary so a held
      // Enter that repeats cannot spin up no-op creates.
      expect(internals(el)._submitting).toBe(false);
      expect(event.stopped).toBe(true);
      await tick();
      expect(el.value).toBe("   ");
    });

    it("stops an empty Enter-driven submit reaching the host", () => {
      const el = new CFSubmitInput();
      el.value = "";
      const event = clickEvent("submit");
      internals(el)._onClick(event);
      expect(internals(el)._submitting).toBe(false);
      expect(event.stopped).toBe(true);
    });

    it("clears the field after the submit click is handled", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onClick(clickEvent("button"));
      // In-flight immediately after the click, before the deferred clear.
      expect(internals(el)._submitting).toBe(true);
      expect(el.value).toBe("Ada");
      await tick();
      expect(el.value).toBe("");
      expect(internals(el)._submitting).toBe(false);
    });

    it("clears the field after an Enter-driven submit", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      // Enter fires the browser's implicit-submission click on the hidden
      // submit button, which routes through the same handler.
      internals(el)._onClick(clickEvent("submit"));
      expect(internals(el)._submitting).toBe(true);
      await tick();
      expect(el.value).toBe("");
      expect(internals(el)._submitting).toBe(false);
    });

    it("stops a re-entrant click and does not schedule a second clear", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onClick(clickEvent("button"));
      const second = clickEvent("button");
      internals(el)._onClick(second);
      expect(second.stopped).toBe(true);
      await tick();
      // The first submit's clear still runs.
      expect(el.value).toBe("");
    });

    it("stops an Enter submit re-entering on a click before the clear (no duplicate create)", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      // Enter submits first...
      internals(el)._onClick(clickEvent("submit"));
      // ...then a button click arrives before the deferred clear. It must be
      // suppressed so the host fires only one create.
      const second = clickEvent("button");
      internals(el)._onClick(second);
      expect(second.stopped).toBe(true);
      await tick();
      expect(el.value).toBe("");
    });

    it("does not wipe a value the user retyped before the clear runs", async () => {
      const el = new CFSubmitInput();
      el.value = "Ada";
      internals(el)._onClick(clickEvent("button"));
      // A new name typed before the deferred clear fires must survive.
      el.value = "Alan";
      await tick();
      expect(el.value).toBe("Alan");
      // The in-flight flag still resets, so a later submit is not blocked.
      expect(internals(el)._submitting).toBe(false);
    });

    it("clears the inner input element when present", async () => {
      const el = new CFSubmitInput();
      const fakeInput = { value: "Ada" } as HTMLInputElement;
      Object.defineProperty(el, "_input", {
        configurable: true,
        get: () => fakeInput,
      });
      el.value = "Ada";
      internals(el)._onClick(clickEvent("button"));
      await tick();
      expect(el.value).toBe("");
      expect(fakeInput.value).toBe("");
    });
  });

  it("render() produces a template", () => {
    const el = new CFSubmitInput();
    el.inputId = "name";
    el.value = "Ada";
    el.placeholder = "Your name...";
    el.buttonText = "Create profile";
    expect(internals(el).render()).toBeDefined();
  });
});
