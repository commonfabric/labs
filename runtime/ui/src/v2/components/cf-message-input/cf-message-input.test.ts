// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFMessageInput } from "./index.ts";

// The message input renders a `cf-input` and a `cf-button`, which this file
// leaves undefined: `cf-input` needs `attachInternals()`, which happy-dom does
// not have. Each stays a plain element, and a case plays its part, setting its
// `value` and firing the `cf-change` and `keydown` a `cf-input` would.

/** The `cf-input` the message input renders, standing in for a real one. */
interface InputStandIn extends HTMLElement {
  value?: string;
  focusCount: number;
}

/** A mounted message input with `properties`, and every `cf-send` it fires. */
async function messageInputWith(
  properties: Partial<CFMessageInput> = {},
): Promise<{
  element: CFMessageInput;
  input: InputStandIn;
  button: HTMLElement;
  sent: unknown[];
}> {
  const element = Object.assign(new CFMessageInput(), properties);
  const sent: unknown[] = [];
  element.addEventListener("cf-send", (event) => {
    if (event instanceof CustomEvent) sent.push(event.detail);
  });
  await mount(element);
  const input = Object.assign(
    element.shadowRoot!.querySelector<HTMLElement>("cf-input")!,
    {
      focusCount: 0,
      focus(this: InputStandIn) {
        this.focusCount++;
      },
    },
  );
  const button = element.shadowRoot!.querySelector<HTMLElement>("cf-button")!;
  return { element, input, button, sent };
}

/** Types `text` into the input, as `cf-input` reports it. */
async function type(
  element: CFMessageInput,
  input: InputStandIn,
  text: string,
): Promise<void> {
  input.value = text;
  input.dispatchEvent(
    new CustomEvent("cf-change", { detail: { value: text } }),
  );
  await element.updateComplete;
}

function press(input: HTMLElement, fields: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...fields });
  input.dispatchEvent(event);
  return event;
}

describe("cf-message-input", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers itself as `cf-message-input`", () => {
    expect(customElements.get("cf-message-input")).toBe(CFMessageInput);
  });

  describe("render()", () => {
    it("shows the placeholder, value, size and button text it is given", async () => {
      const { input, button } = await messageInputWith({
        placeholder: "Say something",
        value: "draft",
        size: "sm",
        buttonText: "Post",
      });

      expect(Reflect.get(input, "placeholder")).toBe("Say something");
      expect(input.value).toBe("draft");
      expect(input.getAttribute("size")).toBe("sm");
      expect(button.getAttribute("size")).toBe("sm");
      expect(button.textContent?.trim()).toBe("Post");
    });

    it("shows a large input and a `Send` button by default", async () => {
      const { input, button } = await messageInputWith();

      expect(input.getAttribute("size")).toBe("lg");
      expect(button.textContent?.trim()).toBe("Send");
    });

    it("disables the input and the button only when disabled", async () => {
      const enabled = await messageInputWith();
      expect(enabled.input.hasAttribute("disabled")).toBe(false);
      expect(enabled.button.hasAttribute("disabled")).toBe(false);

      const disabled = await messageInputWith({ disabled: true });
      expect(disabled.input.hasAttribute("disabled")).toBe(true);
      expect(disabled.button.hasAttribute("disabled")).toBe(true);
    });
  });

  it("takes its value from what is typed", async () => {
    const { element, input } = await messageInputWith();

    await type(element, input, "draft");

    expect(element.value).toBe("draft");
  });

  describe("sending", () => {
    it("emits `cf-send` with the text when the button is clicked", async () => {
      const { element, input, button, sent } = await messageInputWith();
      await type(element, input, "hello");

      button.click();

      expect(sent).toEqual([{ message: "hello" }]);
    });

    it("empties the input before announcing the send, and returns focus to it", async () => {
      const { element, input, button } = await messageInputWith();
      await type(element, input, "hello");
      let textWhenSent: string | undefined;
      element.addEventListener("cf-send", () => textWhenSent = input.value);

      button.click();
      await element.updateComplete;

      expect(textWhenSent).toBe("");
      expect(element.value).toBe("");
      expect(input.value).toBe("");
      expect(input.focusCount).toBe(1);
    });

    it("emits nothing while the input holds only whitespace", async () => {
      const { element, input, button, sent } = await messageInputWith();
      await type(element, input, "   ");

      button.click();
      press(input, { key: "Enter" });

      expect(sent).toEqual([]);
      expect(input.value).toBe("   ");
      expect(input.focusCount).toBe(0);
    });

    it("sends on Enter, and keeps the key from reaching the input", async () => {
      const { element, input, sent } = await messageInputWith();
      await type(element, input, "hello");

      const enter = press(input, { key: "Enter" });

      expect(sent).toEqual([{ message: "hello" }]);
      expect(enter.defaultPrevented).toBe(true);
    });

    it("sends nothing on Shift+Enter or on another key", async () => {
      const { element, input, sent } = await messageInputWith();
      await type(element, input, "hello");

      const shiftEnter = press(input, { key: "Enter", shiftKey: true });
      const letter = press(input, { key: "a" });

      expect(sent).toEqual([]);
      expect(shiftEnter.defaultPrevented).toBe(false);
      expect(letter.defaultPrevented).toBe(false);
    });
  });
});
