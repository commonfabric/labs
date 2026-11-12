// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { CFInputOTP } from "./index.ts";

/** A `cf-input-otp` with `properties` set, mounted in the document. */
function mountOTP(properties: Partial<CFInputOTP> = {}): Promise<CFInputOTP> {
  return mount(Object.assign(new CFInputOTP(), properties));
}

/** The digit inputs `element` renders, in order. */
function digitsOf(element: CFInputOTP): HTMLInputElement[] {
  return [
    ...element.shadowRoot?.querySelectorAll<HTMLInputElement>(".otp-input") ??
      [],
  ];
}

/** The index of the digit input holding focus, or -1 when none does. */
function focusedDigit(element: CFInputOTP): number {
  return digitsOf(element).findIndex((input) =>
    input === element.shadowRoot?.activeElement
  );
}

/** Sets the digit input at `index` to `text` and dispatches `input` from it. */
function enter(element: CFInputOTP, index: number, text: string): void {
  const input = digitsOf(element)[index];
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Dispatches a cancelable `keydown` of `key` from the digit input at
 * `index`, and returns whether the element cancelled it.
 */
function press(element: CFInputOTP, index: number, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  digitsOf(element)[index].dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Dispatches a cancelable `paste` of `text` from the digit input at `index`,
 * and returns whether the element cancelled it.
 */
function paste(element: CFInputOTP, index: number, text: string): boolean {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text", text);
  const event = new ClipboardEvent("paste", {
    clipboardData,
    cancelable: true,
  });
  digitsOf(element)[index].dispatchEvent(event);
  return event.defaultPrevented;
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

describe("CFInputOTP", () => {
  afterEach(() => document.body.replaceChildren());

  describe("rendering", () => {
    it("renders one labeled input per digit", async () => {
      const element = await mountOTP({ length: 4 });

      expect(digitsOf(element).map((input) => input.getAttribute("aria-label")))
        .toEqual([
          "Digit 1 of 4",
          "Digit 2 of 4",
          "Digit 3 of 4",
          "Digit 4 of 4",
        ]);
    });

    it("renders each digit of the value into its input, marking it filled", async () => {
      const element = await mountOTP({ length: 4, value: "12" });

      expect(digitsOf(element).map((input) => input.value)).toEqual([
        "1",
        "2",
        "",
        "",
      ]);
      expect(
        digitsOf(element).map((input) => input.classList.contains("filled")),
      ).toEqual([true, true, false, false]);
    });

    it("renders a value set after it first rendered", async () => {
      const element = await mountOTP({ length: 3 });

      element.value = "789";
      await element.updateComplete;

      expect(digitsOf(element).map((input) => input.value)).toEqual([
        "7",
        "8",
        "9",
      ]);
    });

    it("renders the placeholder and disabled state on every input", async () => {
      const element = await mountOTP({
        length: 2,
        placeholder: "-",
        disabled: true,
      });

      expect(digitsOf(element).map((input) => input.placeholder)).toEqual([
        "-",
        "-",
      ]);
      expect(digitsOf(element).map((input) => input.disabled)).toEqual([
        true,
        true,
      ]);
    });

    it("renders the one-time-code autocomplete hint only when `autoComplete` is set", async () => {
      const hinted = await mountOTP({ length: 1, autoComplete: true });
      const unhinted = await mountOTP({ length: 1 });

      expect(digitsOf(hinted)[0].getAttribute("autocomplete")).toBe(
        "one-time-code",
      );
      expect(digitsOf(unhinted)[0].getAttribute("autocomplete")).toBe("off");
    });

    it("renders a hidden input carrying the value when named", async () => {
      const element = await mountOTP({ name: "otp", value: "42" });
      const hidden = element.shadowRoot?.querySelector<HTMLInputElement>(
        "input[type='hidden']",
      );

      expect([hidden?.name, hidden?.value]).toEqual(["otp", "42"]);
    });

    it("renders no hidden input when unnamed", async () => {
      const element = await mountOTP({ value: "42" });

      expect(element.shadowRoot?.querySelector("input[type='hidden']"))
        .toBeNull();
    });
  });

  describe("typing", () => {
    it("takes a typed digit, moves focus to the next input, and dispatches `cf-change`", async () => {
      const element = await mountOTP({ length: 3 });
      const changes = detailsOf(element, "cf-change");
      const completes = detailsOf(element, "cf-complete");

      enter(element, 0, "4");

      expect(element.value).toBe("4");
      expect(focusedDigit(element)).toBe(1);
      expect(changes).toEqual([{ value: "4", complete: false }]);
      expect(completes).toEqual([]);
    });

    it("dispatches `cf-complete` once the last digit is typed, keeping focus there", async () => {
      const element = await mountOTP({ length: 3, value: "12" });
      const changes = detailsOf(element, "cf-change");
      const completes = detailsOf(element, "cf-complete");
      digitsOf(element)[2].focus();

      enter(element, 2, "3");

      expect(element.value).toBe("123");
      expect(focusedDigit(element)).toBe(2);
      expect(changes).toEqual([{ value: "123", complete: true }]);
      expect(completes).toEqual([{ value: "123" }]);
    });

    it("clears a typed non-digit without changing the value", async () => {
      const element = await mountOTP({ length: 3, value: "1" });
      const changes = detailsOf(element, "cf-change");

      enter(element, 1, "x");

      expect(digitsOf(element)[1].value).toBe("");
      expect(element.value).toBe("1");
      expect(changes).toEqual([]);
    });

    it("selects an input's digit when the input takes focus", async () => {
      const element = await mountOTP({ length: 2, value: "5" });
      const input = digitsOf(element)[0];

      input.dispatchEvent(new FocusEvent("focus"));

      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]);
    });
  });

  describe("keys", () => {
    it("moves focus back on Backspace in an empty input", async () => {
      const element = await mountOTP({ length: 3, value: "1" });

      expect(press(element, 1, "Backspace")).toBe(true);
      expect(focusedDigit(element)).toBe(0);
    });

    it("leaves Backspace in a filled input to the browser", async () => {
      const element = await mountOTP({ length: 3, value: "12" });

      expect(press(element, 1, "Backspace")).toBe(false);
      expect(focusedDigit(element)).toBe(-1);
    });

    it("moves focus with the arrow keys", async () => {
      const element = await mountOTP({ length: 3 });

      expect(press(element, 1, "ArrowLeft")).toBe(true);
      expect(focusedDigit(element)).toBe(0);

      expect(press(element, 1, "ArrowRight")).toBe(true);
      expect(focusedDigit(element)).toBe(2);
    });

    it("leaves the arrow keys to the browser at either end", async () => {
      const element = await mountOTP({ length: 3 });

      expect(press(element, 0, "ArrowLeft")).toBe(false);
      expect(press(element, 2, "ArrowRight")).toBe(false);
      expect(focusedDigit(element)).toBe(-1);
    });

    it("moves focus to the first input on Home and the last on End", async () => {
      const element = await mountOTP({ length: 3 });

      expect(press(element, 1, "End")).toBe(true);
      expect(focusedDigit(element)).toBe(2);

      expect(press(element, 1, "Home")).toBe(true);
      expect(focusedDigit(element)).toBe(0);
    });

    it("leaves other keys to the browser", async () => {
      const element = await mountOTP({ length: 3 });

      expect(press(element, 1, "5")).toBe(false);
    });

    it("moves focus to inputs added when `length` grows", async () => {
      const element = await mountOTP({ length: 2 });

      element.length = 4;
      await element.updateComplete;

      expect(press(element, 1, "End")).toBe(true);
      expect(focusedDigit(element)).toBe(3);
    });
  });

  describe("pasting", () => {
    it("fills the digits pasted from where the paste lands and focuses the next empty input", async () => {
      const element = await mountOTP({ length: 6 });
      const changes = detailsOf(element, "cf-change");
      const completes = detailsOf(element, "cf-complete");

      expect(paste(element, 0, "12-34")).toBe(true);

      expect(element.value).toBe("1234");
      expect(focusedDigit(element)).toBe(4);
      expect(changes).toEqual([{ value: "1234", complete: false }]);
      expect(completes).toEqual([]);
    });

    it("keeps only the digits that fit and dispatches `cf-complete` when they fill it", async () => {
      const element = await mountOTP({ length: 4, value: "9" });
      const completes = detailsOf(element, "cf-complete");

      paste(element, 1, "123456");

      expect(element.value).toBe("9123");
      expect(focusedDigit(element)).toBe(3);
      expect(completes).toEqual([{ value: "9123" }]);
    });

    it("cancels a paste holding no digits without changing the value", async () => {
      const element = await mountOTP({ length: 4, value: "9" });
      const changes = detailsOf(element, "cf-change");

      expect(paste(element, 1, "abc")).toBe(true);

      expect(element.value).toBe("9");
      expect(changes).toEqual([]);
    });
  });

  describe("focus", () => {
    it("focuses the first input on `focus()`", async () => {
      const element = await mountOTP({ length: 3 });

      element.focus();

      expect(focusedDigit(element)).toBe(0);
    });

    it("empties the value and focuses the first input on `clear()`", async () => {
      const element = await mountOTP({ length: 3, value: "123" });

      element.clear();
      await element.updateComplete;

      expect(element.value).toBe("");
      expect(digitsOf(element).map((input) => input.value)).toEqual([
        "",
        "",
        "",
      ]);
      expect(focusedDigit(element)).toBe(0);
    });

    it("focuses the first input once connected when `autofocus` is set", async () => {
      using time = new FakeTime();
      const element = await mountOTP({ autofocus: true });

      time.tick(0);

      expect(focusedDigit(element)).toBe(0);
    });

    it("leaves focus alone once connected when `autofocus` is unset", async () => {
      using time = new FakeTime();
      const element = await mountOTP();

      time.tick(0);

      expect(focusedDigit(element)).toBe(-1);
    });
  });
});
