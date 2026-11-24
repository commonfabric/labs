/**
 * The controls whose host is the control, seen as a page sees them: a page's
 * click handler hears every activation, by pointer or key, and none while
 * the control is disabled.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFButton } from "../components/cf-button/index.ts";
import { CFCheckbox } from "../components/cf-checkbox/index.ts";
import { CFRadio } from "../components/cf-radio/index.ts";
import { CFSwitch } from "../components/cf-switch/index.ts";
import { CFToggle } from "../components/cf-toggle/index.ts";

interface Control {
  name: string;
  make(): HTMLElement & {
    disabled: boolean;
    readonly updateComplete: Promise<boolean>;
  };
  /** The key that activates it, and one that does not. */
  key: string;
  otherKey: string;
}

const controls: Control[] = [
  {
    name: "cf-button",
    make: () => new CFButton(),
    key: "Enter",
    otherKey: "a",
  },
  { name: "cf-toggle", make: () => new CFToggle(), key: " ", otherKey: "a" },
  {
    name: "cf-switch",
    make: () => new CFSwitch(),
    key: "Enter",
    otherKey: "a",
  },
  {
    name: "cf-checkbox",
    make: () => new CFCheckbox(),
    key: " ",
    otherKey: "Enter",
  },
  { name: "cf-radio", make: () => new CFRadio(), key: " ", otherKey: "Enter" },
];

function press(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

describe("a control whose host is the control", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  for (const control of controls) {
    describe(control.name, () => {
      /** The control, mounted, and the clicks a page's handler on it hears. */
      async function mounted(disabled = false) {
        const element = await mount(
          Object.assign(control.make(), { disabled }),
        );
        let clicks = 0;
        element.addEventListener("click", () => clicks++);
        return { element, clicks: () => clicks };
      }

      it("sends a page's click handler the click its activation key makes", async () => {
        const { element, clicks } = await mounted();

        const event = press(element, control.key);

        expect(event.defaultPrevented).toBe(true);
        expect(clicks()).toBe(1);
      });

      it("leaves other keys alone", async () => {
        const { element, clicks } = await mounted();

        const event = press(element, control.otherKey);

        expect(event.defaultPrevented).toBe(false);
        expect(clicks()).toBe(0);
      });

      it("sends a page's click handler no click while disabled", async () => {
        const { element, clicks } = await mounted(true);

        click(element);
        const event = press(element, control.key);

        expect(event.defaultPrevented).toBe(false);
        expect(clicks()).toBe(0);
      });

      it("sends a page's click handler clicks again once enabled", async () => {
        const { element, clicks } = await mounted(true);

        element.disabled = false;
        await element.updateComplete;
        click(element);

        expect(clicks()).toBe(1);
      });
    });
  }
});
