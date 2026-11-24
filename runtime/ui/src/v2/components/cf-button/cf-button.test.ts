// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { getLogger, getLoggerCountsBreakdown } from "@commonfabric/logger";
import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { defaultTheme, themeProperties } from "../theme-context.ts";
import { CFButton } from "./index.ts";

/** How many drops the `cf-button` logger has counted. */
const droppedCount = (): number =>
  getLoggerCountsBreakdown()["cf-button"]?.dropped?.debug ?? 0;

/** A button holding `text`, with `properties` set, mounted in the document. */
function button(
  text = "",
  properties: Partial<Pick<CFButton, "disabled" | "type">> = {},
): Promise<CFButton> {
  const element = Object.assign(new CFButton(), properties);
  element.append(text);
  return mount(element);
}

/** The `<button>` that `element` renders. */
function inner(element: CFButton): HTMLButtonElement {
  const found = element.shadowRoot!.querySelector("button");
  if (!found) throw new Error("cf-button rendered no button");
  return found;
}

/** The number of `click` events `element` delivers while `act()` runs. */
function clicks(element: CFButton, act: () => void): number {
  let count = 0;
  const listener = () => count++;
  element.addEventListener("click", listener);
  try {
    act();
  } finally {
    element.removeEventListener("click", listener);
  }
  return count;
}

/** A form stand-in recording which of its methods `cf-button` called. */
function form(): HTMLElement & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(document.createElement("cf-form"), {
    calls,
    submit: () => calls.push("submit"),
    reset: () => calls.push("reset"),
  });
}

describe("CFButton", () => {
  afterEach(() => document.body.replaceChildren());

  it("should be defined", () => {
    expect(CFButton).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-button")).toBe(CFButton);
  });

  it("should create element instance", () => {
    const element = new CFButton();
    expect(element).toBeInstanceOf(CFButton);
  });

  it("should be creatable via document.createElement", () => {
    const element = document.createElement("cf-button");
    document.body.append(element);

    expect(element).toBeInstanceOf(CFButton);
    expect(element.getAttribute("role")).toBe("button");
    expect(element.getAttribute("exportparts")).toBe("button");
  });

  it("should have default properties", () => {
    const element = new CFButton();
    expect(element.color).toBe("primary");
    expect(element.variant).toBe("solid");
    expect(element.size).toBe("md");
    expect(element.disabled).toBe(false);
    expect(element.type).toBe("button");
  });

  it("should normalize invalid enum-like properties to defaults", async () => {
    const element = Object.assign(new CFButton(), {
      color: "unexpected",
      variant: "secondary",
      size: "xxl",
      type: "menu",
    });
    await mount(element);

    expect(element.color).toBe("primary");
    expect(element.variant).toBe("solid");
    expect(element.size).toBe("md");
    expect(element.type).toBe("button");
  });

  it("keeps valid enum-like properties as given", async () => {
    const element = Object.assign(new CFButton(), {
      color: "danger",
      variant: "ghost",
      size: "icon",
      type: "submit",
    });
    await mount(element);

    expect(element.color).toBe("danger");
    expect(element.variant).toBe("ghost");
    expect(element.size).toBe("icon");
    expect(element.type).toBe("submit");
  });

  it("should expose button semantics on the host", async () => {
    const element = await button("Send");

    expect(element.getAttribute("role")).toBe("button");
    expect(element.getAttribute("aria-disabled")).toBe("false");
    expect(element.getAttribute("exportparts")).toBe("button");
    expect(element.tabIndex).toBe(0);
  });

  it("keeps a role and exportparts the author gave the host", async () => {
    const element = new CFButton();
    element.setAttribute("role", "menuitem");
    element.setAttribute("exportparts", "button: action");
    await mount(element);

    expect(element.getAttribute("role")).toBe("menuitem");
    expect(element.getAttribute("exportparts")).toBe("button: action");
  });

  it("should expose disabled state on the host", async () => {
    const element = await button("Send");
    element.disabled = true;
    await element.updateComplete;

    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(element.tabIndex).toBe(-1);
  });

  it("renders a button classed by its variant and size, carrying its type and disabled state", async () => {
    const element = await button("Send", { type: "reset" });
    expect([...inner(element).classList]).toEqual(["button", "solid", "md"]);
    expect(inner(element).type).toBe("reset");
    expect(inner(element).disabled).toBe(false);

    element.variant = "outline";
    element.size = "lg";
    element.disabled = true;
    await element.updateComplete;
    expect([...inner(element).classList]).toEqual(["button", "outline", "lg"]);
    expect(inner(element).disabled).toBe(true);
  });

  it("should not use delegatesFocus (incompatible with aria-hidden)", () => {
    // delegatesFocus sends focus to the inner button, but browsers
    // refuse to apply aria-hidden on a focused element.
    expect(CFButton.shadowRootOptions?.delegatesFocus).not.toBe(true);
  });

  describe("accessible name", () => {
    it("labels the host with its text", async () => {
      const element = await button("  Send  ");
      expect(element.getAttribute("aria-label")).toBe("Send");
    });

    it("relabels the host when its slotted content changes", async () => {
      const element = await button("Send");
      element.replaceChildren("Save");
      await settle();
      expect(element.getAttribute("aria-label")).toBe("Save");
    });

    it("leaves the host unlabeled when it has no text", async () => {
      const element = await button();
      expect(element.hasAttribute("aria-label")).toBe(false);
    });

    it("keeps an aria-label the author gave", async () => {
      const element = new CFButton();
      element.setAttribute("aria-label", "Send the message");
      element.append("Send");
      await mount(element);
      expect(element.getAttribute("aria-label")).toBe("Send the message");

      element.replaceChildren("Save");
      await settle();
      expect(element.getAttribute("aria-label")).toBe("Send the message");
    });

    it("adds no aria-label when the author gave aria-labelledby", async () => {
      const element = new CFButton();
      element.setAttribute("aria-labelledby", "caption");
      element.append("Send");
      await mount(element);
      expect(element.hasAttribute("aria-label")).toBe(false);
    });
  });

  describe("theme", () => {
    it("writes the given theme's properties onto the host, and removes them when cleared", async () => {
      const name = "--cf-theme-color-primary";
      const element = await button("Send");
      expect(element.style.getPropertyValue(name)).toBe("");

      element.theme = defaultTheme;
      await element.updateComplete;
      expect(element.style.getPropertyValue(name)).toBe(
        themeProperties(defaultTheme)[name],
      );

      element.theme = undefined;
      await element.updateComplete;
      expect(element.style.getPropertyValue(name)).toBe("");
    });
  });

  describe("keyboard", () => {
    for (const key of ["Enter", " "]) {
      it(`clicks the host when ${JSON.stringify(key)} is pressed`, async () => {
        const element = await button("Send");
        const event = new KeyboardEvent("keydown", { key, cancelable: true });
        expect(clicks(element, () => element.dispatchEvent(event))).toBe(1);
        expect(event.defaultPrevented).toBe(true);
      });
    }

    it("does not click the host when another key is pressed", async () => {
      const element = await button("Send");
      const event = new KeyboardEvent("keydown", {
        key: "a",
        cancelable: true,
      });
      expect(clicks(element, () => element.dispatchEvent(event))).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    });

    it("does not click the host when Enter is pressed while it is disabled", async () => {
      const element = await button("Send", { disabled: true });
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      });
      expect(clicks(element, () => element.dispatchEvent(event))).toBe(0);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("forms", () => {
    for (const type of ["submit", "reset"] as const) {
      it(`calls ${type}() on the enclosing cf-form when a ${type} button is clicked`, async () => {
        const target = form();
        const element = Object.assign(new CFButton(), { type });
        target.append(element);
        document.body.append(target);
        await element.updateComplete;

        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);

        expect(target.calls).toEqual([type]);
        expect(event.defaultPrevented).toBe(true);
      });
    }

    it("calls nothing on the enclosing cf-form when a plain button is clicked", async () => {
      const target = form();
      const element = new CFButton();
      target.append(element);
      document.body.append(target);
      await element.updateComplete;

      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);

      expect(target.calls).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it("leaves a submit click outside any cf-form to the browser", async () => {
      const element = await button("Send", { type: "submit" });
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("calls nothing on the enclosing cf-form when a disabled submit button is clicked", async () => {
      const target = form();
      const element = Object.assign(new CFButton(), {
        type: "submit",
        disabled: true,
      });
      target.append(element);
      document.body.append(target);
      await element.updateComplete;

      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      expect(target.calls).toEqual([]);
    });
  });

  it("should suppress click events when disabled via host listener", () => {
    const element = new CFButton();
    element.disabled = true;

    // Verify the element has a capture-phase click listener that stops propagation
    // We test this by creating a click event and dispatching it
    let listenerCalled = false;
    element.addEventListener("click", () => {
      listenerCalled = true;
    });

    const clickEvent = new Event("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(clickEvent);

    // When disabled, the capture-phase listener should stop immediate propagation
    expect(listenerCalled).toBe(false);
  });

  it("counts a click it drops while disabled, and logs it once its logger is enabled", () => {
    const element = new CFButton();
    element.disabled = true;
    element.textContent = "Send";
    let listenerCalled = false;
    element.addEventListener("click", () => {
      listenerCalled = true;
    });
    const logger = getLogger("cf-button");
    const wasDisabled = logger.disabled;
    const logged: unknown[][] = [];
    const originalDebug = console.debug;
    console.debug = (...args: unknown[]) => {
      logged.push(args);
    };
    const before = droppedCount();
    try {
      logger.disabled = false;
      element.dispatchEvent(
        new Event("click", { bubbles: true, cancelable: true }),
      );
    } finally {
      console.debug = originalDebug;
      logger.disabled = wasDisabled;
    }

    expect(listenerCalled).toBe(false);
    expect(droppedCount()).toBe(before + 1);
    expect(logged.map((args) => args.join(" "))).toEqual([
      expect.stringContaining(
        'dropped cf-button dropped a click while disabled ("Send")',
      ),
    ]);
  });

  it("should allow click events when not disabled", () => {
    const element = new CFButton();
    element.disabled = false;

    let listenerCalled = false;
    element.addEventListener("click", () => {
      listenerCalled = true;
    });

    const clickEvent = new Event("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(clickEvent);

    expect(listenerCalled).toBe(true);
  });
});
