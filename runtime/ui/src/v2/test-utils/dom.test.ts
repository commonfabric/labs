// First, so that the document it installs is there when Lit loads.
import { internalsOf, mount, window } from "./dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ContextConsumer, createContext } from "@lit/context";
import { html, LitElement } from "lit";

const greetingContext = createContext<string>("dom-test-greeting");

/** Provides a greeting to the elements inside it. */
class GreetingProvider extends LitElement {
  constructor() {
    super();
    this.addEventListener("context-request", (event) => {
      const request = event as Event & {
        context: unknown;
        callback(value: string): void;
      };
      if (request.context !== greetingContext) return;
      event.stopPropagation();
      request.callback("hello");
    });
  }

  override render() {
    return html`<slot></slot>`;
  }
}
customElements.define("dom-test-greeting-provider", GreetingProvider);

/** Reads the greeting its provider offers. */
class GreetingConsumer extends LitElement {
  readonly greeting = new ContextConsumer(this, { context: greetingContext });
}
customElements.define("dom-test-greeting-consumer", GreetingConsumer);

/** Reports a form value and validity, as a form-associated control does. */
class FormControl extends LitElement {
  readonly internals = this.attachInternals();
}
customElements.define("dom-test-form-control", FormControl);

describe("dom", () => {
  afterEach(() => document.body.replaceChildren());

  it("installs the window's event classes, the bare `Event` among them", () => {
    expect(globalThis.Event).toBe(window.Event);
    expect(globalThis.CustomEvent).toBe(window.CustomEvent);
    expect(globalThis.KeyboardEvent).toBe(window.KeyboardEvent);
  });

  it("makes the global object the window a document event bubbles to", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(event.type);
    globalThis.addEventListener("click", listener);

    button.click();
    globalThis.dispatchEvent(new Event("resize"));
    globalThis.removeEventListener("click", listener);
    button.click();

    expect(heard).toEqual(["click"]);
  });

  it("delivers a global event to a listener on the global object", () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(event.type);
    globalThis.addEventListener("resize", listener);

    globalThis.dispatchEvent(new Event("resize"));
    globalThis.removeEventListener("resize", listener);
    globalThis.dispatchEvent(new Event("resize"));

    expect(heard).toEqual(["resize"]);
  });

  it("delivers a context request from a consumer to its provider", async () => {
    const provider = await mount(new GreetingProvider());
    const consumer = new GreetingConsumer();
    provider.append(consumer);
    await consumer.updateComplete;

    expect(consumer.greeting.value).toBe("hello");
  });

  describe("internalsOf()", () => {
    it("returns the form value and validity an element reported", () => {
      const control = new FormControl();
      control.internals.setFormValue("typed");
      control.internals.setValidity({ valueMissing: true }, "Required");

      const internals = internalsOf(control);
      expect(internals?.formValue).toBe("typed");
      expect(internals?.validity).toEqual({ valueMissing: true });
      expect(internals?.validationMessage).toBe("Required");
      expect(internals?.checkValidity()).toBe(false);
    });

    it("returns a valid state once the flags are cleared", () => {
      const control = new FormControl();
      control.internals.setValidity({ valueMissing: true }, "Required");
      control.internals.setValidity({});

      expect(internalsOf(control)?.checkValidity()).toBe(true);
      expect(internalsOf(control)?.validationMessage).toBe("");
    });

    it("records only the flags set in a validity state passed whole", () => {
      const control = new FormControl();
      const state = { valid: true, valueMissing: false, tooShort: false };
      control.internals.setValidity(state);

      expect(internalsOf(control)?.validity).toEqual({});
      expect(internalsOf(control)?.checkValidity()).toBe(true);
    });

    it("returns `undefined` for an element that attached none", () => {
      expect(internalsOf(document.createElement("div"))).toBeUndefined();
    });
  });

  it("refuses to attach internals to an element twice", () => {
    const control = new FormControl();

    expect(() => control.attachInternals()).toThrow("already attached");
  });
});
