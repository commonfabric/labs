/**
 * The controls whose host is the control (HostActivationController), seen as
 * a page sees them: the host carries the role, the Tab stop and
 * aria-disabled; a page's click handler hears every activation, by pointer or
 * key, and none while the control is disabled or out of the document.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFButton } from "./cf-button/index.ts";
import { CFCheckbox } from "./cf-checkbox/index.ts";
import { CFRadio } from "./cf-radio/index.ts";
import { CFRadioGroup } from "./cf-radio-group/index.ts";
import { CFSwitch } from "./cf-switch/index.ts";
import { CFToggle } from "./cf-toggle/index.ts";

type HostControl = HTMLElement & {
  disabled: boolean;
  readonly updateComplete: Promise<boolean>;
};

interface Control {
  name: string;
  make(): HostControl;
  role: string;
  /** The key that activates it, and one that does not. */
  key: string;
  otherKey: string;
  /** The state an activation changes, as the accessibility tree sees it. */
  state: string | undefined;
}

const controls: Control[] = [
  {
    name: "cf-button",
    make: () => new CFButton(),
    role: "button",
    key: "Enter",
    otherKey: "a",
    state: undefined,
  },
  {
    name: "cf-toggle",
    make: () => new CFToggle(),
    role: "button",
    key: " ",
    otherKey: "a",
    state: "aria-pressed",
  },
  {
    name: "cf-switch",
    make: () => new CFSwitch(),
    role: "switch",
    key: "Enter",
    otherKey: "a",
    state: "aria-checked",
  },
  {
    name: "cf-checkbox",
    make: () => new CFCheckbox(),
    role: "checkbox",
    key: " ",
    otherKey: "Enter",
    state: "aria-checked",
  },
  {
    name: "cf-radio",
    make: () => new CFRadio(),
    role: "radio",
    key: " ",
    otherKey: "Enter",
    state: "aria-checked",
  },
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

      /** The control's state as the accessibility tree sees it. */
      const state = (element: HTMLElement) =>
        control.state && element.getAttribute(control.state);

      it(`takes the role ${control.role}, unless the page gave it one`, async () => {
        const { element } = await mounted();
        expect(element.getAttribute("role")).toBe(control.role);

        const given = control.make();
        given.setAttribute("role", "menuitem");
        await mount(given);
        expect(given.getAttribute("role")).toBe("menuitem");
      });

      it("is a Tab stop while enabled, and none while disabled", async () => {
        const { element } = await mounted();
        expect(element.tabIndex).toBe(0);
        expect(element.getAttribute("aria-disabled")).toBe("false");

        element.disabled = true;
        await element.updateComplete;
        expect(element.tabIndex).toBe(-1);
        expect(element.getAttribute("aria-disabled")).toBe("true");

        element.disabled = false;
        await element.updateComplete;
        expect(element.tabIndex).toBe(0);
        expect(element.getAttribute("aria-disabled")).toBe("false");
      });

      it("sends a page's click handler the click its activation key makes", async () => {
        const { element, clicks } = await mounted();
        const before = state(element);

        const event = press(element, control.key);
        await element.updateComplete;

        expect(event.defaultPrevented).toBe(true);
        expect(clicks()).toBe(1);
        if (control.state) expect(state(element)).not.toBe(before);
      });

      it("leaves other keys alone", async () => {
        const { element, clicks } = await mounted();
        const before = state(element);

        const event = press(element, control.otherKey);
        await element.updateComplete;

        expect(event.defaultPrevented).toBe(false);
        expect(clicks()).toBe(0);
        expect(state(element)).toBe(before);
      });

      it("answers no click or key while disabled", async () => {
        const { element, clicks } = await mounted(true);
        const before = state(element);

        click(element);
        const event = press(element, control.key);
        await element.updateComplete;

        expect(event.defaultPrevented).toBe(false);
        expect(clicks()).toBe(0);
        expect(state(element)).toBe(before);
      });

      it("answers clicks again once enabled", async () => {
        const { element, clicks } = await mounted(true);
        const before = state(element);

        element.disabled = false;
        await element.updateComplete;
        click(element);
        await element.updateComplete;

        expect(clicks()).toBe(1);
        if (control.state) expect(state(element)).not.toBe(before);
      });

      it("answers no key once out of the document", async () => {
        const { element, clicks } = await mounted();
        const before = state(element);
        element.remove();

        const event = press(element, control.key);
        await element.updateComplete;

        expect(event.defaultPrevented).toBe(false);
        expect(clicks()).toBe(0);
        expect(state(element)).toBe(before);
      });
    });
  }

  it("leaves a radio's Tab stop in a group to the group", async () => {
    const group = new CFRadioGroup();
    const radios = ["a", "b", "c"].map((value) =>
      Object.assign(new CFRadio(), { value })
    );
    for (const radio of radios) group.append(radio);
    await mount(group);
    await Promise.all(radios.map((radio) => radio.updateComplete));

    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    // A radio's own update does not take the Tab stop back from the group.
    radios[2].requestUpdate();
    await radios[2].updateComplete;
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });
});
