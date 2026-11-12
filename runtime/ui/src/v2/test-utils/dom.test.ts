// First, so that the document it installs is there when Lit loads.
import { internalsOf, mount, settle, window } from "./dom.ts";

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

  describe("printing", () => {
    // What a failed assertion prints, which must stay short.

    it("prints an element as its markup", () => {
      const div = document.createElement("div");
      div.className = "x";
      div.textContent = "hi";

      expect(Deno.inspect([div])).toBe('[ <div class="x">hi</div> ]');
    });

    it("prints at most 200 characters of a long element", () => {
      const div = document.createElement("div");
      div.textContent = "a".repeat(500);

      const printed = Deno.inspect(div);
      expect(printed).toBe(`<div>${"a".repeat(195)}…`);
    });

    it("prints a text node as its name and text", () => {
      expect(Deno.inspect(document.createTextNode("hi"))).toBe('#text "hi"');
    });

    it("prints the window as its name", () => {
      expect(Deno.inspect(window)).toBe("Window");
    });
  });

  describe("an exception a listener throws", () => {
    /**
     * Runs `body`, then returns what reached the global object as an
     * uncaught error once the microtasks it queued have run, keeping it from
     * failing the test.
     */
    async function uncaughtFrom(body: () => void): Promise<unknown[]> {
      const uncaught: unknown[] = [];
      const record = (event: Event) => {
        event.preventDefault();
        uncaught.push((event as ErrorEvent).error);
      };
      globalThis.addEventListener("error", record);
      try {
        body();
        await Promise.resolve();
      } finally {
        globalThis.removeEventListener("error", record);
      }
      return uncaught;
    }

    it("is thrown again as an uncaught error, after the dispatch carries on", async () => {
      const button = document.createElement("button");
      const problem = new Error("listener failed");
      button.addEventListener("click", () => {
        throw problem;
      });
      let carriedOn = false;

      const uncaught = await uncaughtFrom(() => {
        button.click();
        carriedOn = true;
      });

      expect(carriedOn).toBe(true);
      expect(uncaught).toEqual([problem]);
    });

    it("is not invented for an `error` event that carries none", async () => {
      const uncaught = await uncaughtFrom(() => {
        window.dispatchEvent(new window.Event("error"));
      });

      expect(uncaught).toEqual([]);
    });
  });

  it("writes a window property assigned through the global object to the window", () => {
    const handler = () => {};
    try {
      Reflect.set(globalThis, "onresize", handler);
      expect(window.onresize).toBe(handler);
    } finally {
      Reflect.set(globalThis, "onresize", null);
    }
  });

  describe("settle()", () => {
    it("resolves once the animation frames the page asked for have run", async () => {
      let ran = false;
      requestAnimationFrame(() => ran = true);
      expect(ran).toBe(false);

      await settle();

      expect(ran).toBe(true);
    });
  });

  it("follows no link, staying on its page", () => {
    const link = document.createElement("a");
    link.href = "http://example.com/elsewhere";
    document.body.append(link);

    link.click();

    expect(location.href).toBe("http://localhost/");
  });

  it("fires one `selectionchange` once the calls changing the selection return", async () => {
    const text = document.createElement("p");
    text.textContent = "hello";
    document.body.append(text);
    const heard: string[] = [];
    const listener = () => heard.push("selectionchange");
    document.addEventListener("selectionchange", listener);

    const selection = document.getSelection()!;
    selection.selectAllChildren(text);
    selection.collapseToStart();
    heard.push("returned");
    await Promise.resolve();
    document.removeEventListener("selectionchange", listener);

    expect(heard).toEqual(["returned", "selectionchange"]);
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
