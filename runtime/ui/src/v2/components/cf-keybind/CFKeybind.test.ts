// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { ContextProvider } from "@lit/context";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { keyboardRouterContext } from "../keyboard-context.ts";
import type { ShortcutHandler, ShortcutSpec } from "../keyboard-router.ts";
import type { CFKeybindDetail } from "./cf-keybind.ts";
import { CFKeybind } from "./index.ts";

/** A connected binding with `settings`, and the details of its matches. */
async function binding(settings: Partial<CFKeybind>) {
  const element = Object.assign(new CFKeybind(), settings);
  const matches: CFKeybindDetail[] = [];
  element.addEventListener(
    "cf-keybind",
    (event) => matches.push((event as CustomEvent<CFKeybindDetail>).detail),
  );
  await mount(element);
  return { element, matches };
}

/** Dispatches a cancelable `type` event from `target`, and returns it. */
function press(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
  type = "keydown",
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("CFKeybind", () => {
  afterEach(() => document.body.replaceChildren());

  describe("without a keyboard router", () => {
    it("dispatches `cf-keybind` for a keydown anywhere in the document that matches its key and modifiers", async () => {
      const { matches } = await binding({ name: "open", key: "o", meta: true });

      press({ code: "KeyO", key: "o", metaKey: true });

      expect(matches).toStrictEqual([{
        name: "open",
        code: "KeyO",
        key: "o",
        alt: false,
        ctrl: false,
        meta: true,
        shift: false,
        repeat: false,
      }]);
    });

    it("matches a single-character key regardless of case", async () => {
      const { matches } = await binding({ key: "O", shift: true });

      press({ key: "o", shiftKey: true });
      press({ key: "O", shiftKey: true });

      expect(matches.map((detail) => detail.key)).toEqual(["o", "O"]);
    });

    it("does not dispatch for another key", async () => {
      const { matches } = await binding({ key: "o" });

      press({ key: "p" });
      press({ key: "Escape" });

      expect(matches).toEqual([]);
    });

    it("matches `code` alone when it is set, whatever the key", async () => {
      const { matches } = await binding({ code: "KeyO", key: "x" });

      press({ code: "KeyO", key: "ø" });
      press({ code: "KeyX", key: "x" });

      expect(matches.map((detail) => detail.code)).toEqual(["KeyO"]);
    });

    it("dispatches nothing when neither `code` nor `key` is set", async () => {
      const { matches } = await binding({});

      press({ code: "KeyO", key: "o" });
      press({ code: "", key: "" });

      expect(matches).toEqual([]);
    });

    it("does not dispatch when a modifier is held that the binding does not require, or one it requires is not", async () => {
      const { matches } = await binding({ key: "o", ctrl: true });

      press({ key: "o" });
      press({ key: "o", ctrlKey: true, altKey: true });
      press({ key: "o", ctrlKey: true, shiftKey: true });
      press({ key: "o", ctrlKey: true, metaKey: true });
      press({ key: "o", ctrlKey: true });

      expect(matches).toHaveLength(1);
      expect(matches[0].ctrl).toBe(true);
    });

    it("counts a modifier pressed as its own key, until it is released", async () => {
      // Each binding is for a modifier key with that modifier required, and
      // the keydown carries no modifier flags, as on layouts that report them
      // only as separate key events. The other modifier is pressed first, so
      // it is held unless its keyup arrives.
      const modifiers = [
        ["Alt", "alt"],
        ["Control", "ctrl"],
        ["Meta", "meta"],
        ["Shift", "shift"],
      ] as const;
      for (const [index, [key, flag]] of modifiers.entries()) {
        const [other] = modifiers[(index + 1) % modifiers.length];
        const { element, matches } = await binding({ key, [flag]: true });

        press({ key: other });
        press({ key });
        expect(matches).toEqual([]);

        press({ key: other }, document.body, "keyup");
        press({ key });
        expect(matches.map((detail) => detail.key)).toEqual([key]);
        element.remove();
      }
    });

    it("does not dispatch for an auto-repeated keydown unless `allow-repeat` is set", async () => {
      const once = await binding({ key: "o" });
      const repeating = await binding({ key: "o", allowRepeat: true });

      press({ key: "o", repeat: true });

      expect(once.matches).toEqual([]);
      expect(repeating.matches.map((detail) => detail.repeat)).toEqual([true]);
    });

    it("does not dispatch for a keydown in a text field unless `ignore-editable` is turned off", async () => {
      const ignoring = await binding({ key: "o" });
      const listening = await binding({ key: "o", ignoreEditable: false });
      const input = document.createElement("input");
      document.body.append(input);

      press({ key: "o" }, input);

      expect(ignoring.matches).toEqual([]);
      expect(listening.matches).toHaveLength(1);
    });

    it("prevents the default and stops propagation on a match only when told to", async () => {
      // The binding listens on the document as the event is captured, so an
      // event it stops never reaches the element it was dispatched at.
      const target = document.body.appendChild(document.createElement("div"));
      let reachedTarget = 0;
      target.addEventListener("keydown", () => reachedTarget++);

      const quiet = await binding({ key: "o" });
      const plain = press({ key: "o" }, target);
      expect(quiet.matches).toHaveLength(1);
      expect(plain.defaultPrevented).toBe(false);
      expect(reachedTarget).toBe(1);
      quiet.element.remove();

      const told = await binding({
        key: "o",
        preventDefault: true,
        stopPropagation: true,
      });
      const handled = press({ key: "o" }, target);
      expect(told.matches).toHaveLength(1);
      expect(handled.defaultPrevented).toBe(true);
      expect(reachedTarget).toBe(1);
    });

    it("dispatches nothing once removed from the document", async () => {
      const { element, matches } = await binding({ key: "o" });

      element.remove();
      press({ key: "o" });

      expect(matches).toEqual([]);
    });
  });

  describe("with a keyboard router", () => {
    /** A router that records what registers with it, and what it disposed. */
    function routed() {
      const registered: { spec: ShortcutSpec; handler: ShortcutHandler }[] = [];
      let disposed = 0;
      const host = document.createElement("div");
      new ContextProvider(host, {
        context: keyboardRouterContext,
        initialValue: {
          register(spec, handler) {
            registered.push({ spec, handler });
            return () => {
              disposed++;
            };
          },
          dispose() {},
        },
      });
      document.body.append(host);
      return { host, registered, disposed: () => disposed };
    }

    it("registers its shortcut with the router, and listens to the document for none", async () => {
      const router = routed();
      const element = Object.assign(new CFKeybind(), {
        name: "open",
        key: "o",
        meta: true,
      });
      const matches: unknown[] = [];
      element.addEventListener("cf-keybind", (event) => matches.push(event));
      router.host.append(element);
      await element.updateComplete;

      expect(router.registered.map(({ spec }) => spec)).toEqual([{
        name: "open",
        code: undefined,
        key: "o",
        alt: false,
        ctrl: false,
        meta: true,
        shift: false,
        ignoreEditable: true,
        allowRepeat: false,
        preventDefault: false,
        stopPropagation: false,
      }]);
      press({ key: "o", metaKey: true });
      expect(matches).toEqual([]);
    });

    it("dispatches `cf-keybind` for the keydown the router hands it, and prevents its default when told to", async () => {
      const router = routed();
      const element = Object.assign(new CFKeybind(), {
        name: "next",
        code: "ArrowRight",
        preventDefault: true,
      });
      const matches: CFKeybindDetail[] = [];
      element.addEventListener(
        "cf-keybind",
        (event) => matches.push((event as CustomEvent<CFKeybindDetail>).detail),
      );
      router.host.append(element);
      await element.updateComplete;
      const event = new KeyboardEvent("keydown", {
        code: "ArrowRight",
        key: "ArrowRight",
        cancelable: true,
      });

      router.registered[0].handler(event);

      expect(matches.map((detail) => detail.name)).toEqual(["next"]);
      expect(event.defaultPrevented).toBe(true);
    });

    it("disposes of its registration once removed from the document", async () => {
      const router = routed();
      const element = new CFKeybind();
      router.host.append(element);
      await element.updateComplete;
      expect(router.disposed()).toBe(0);

      element.remove();

      expect(router.disposed()).toBe(1);
    });
  });
});
