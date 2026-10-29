/**
 * Tests for CFButton component
 */

import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFButton } from "./index.ts";

/** How many drops the `cf-button` logger has counted. */
const droppedCount = (): number =>
  getLoggerCountsBreakdown()["cf-button"]?.dropped?.debug ?? 0;

describe("CFButton", () => {
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

  if (typeof document !== "undefined") {
    it("should be creatable via document.createElement", async () => {
      const element = document.createElement("cf-button") as CFButton;
      document.body.append(element);
      await element.updateComplete;

      expect(element).toBeInstanceOf(CFButton);
      expect(element.getAttribute("role")).toBe("button");
      expect(element.getAttribute("exportparts")).toBe("button");

      element.remove();
    });
  }

  it("should have default properties", () => {
    const element = new CFButton();
    expect(element.color).toBe("primary");
    expect(element.variant).toBe("solid");
    expect(element.size).toBe("md");
    expect(element.disabled).toBe(false);
    expect(element.type).toBe("button");
  });

  it("should normalize invalid enum-like properties to defaults", () => {
    const element = new CFButton();
    element.color = "unexpected" as never;
    element.variant = "secondary" as never;
    element.size = "xxl" as never;
    element.type = "menu" as never;

    (element as any).willUpdate(
      new Map([
        ["color", "primary"],
        ["variant", "solid"],
        ["size", "md"],
        ["type", "button"],
      ]),
    );

    expect(element.color).toBe("primary");
    expect(element.variant).toBe("solid");
    expect(element.size).toBe("md");
    expect(element.type).toBe("button");
  });

  it("should expose button semantics on the host", () => {
    const element = new CFButton();
    element.updated(new Map([["disabled", undefined]]));

    expect(element.getAttribute("role")).toBe("button");
    expect(element.getAttribute("aria-disabled")).toBe("false");
    expect(element.getAttribute("exportparts")).toBe("button");
    expect(element.tabIndex).toBe(0);
  });

  it("should expose disabled state on the host", () => {
    const element = new CFButton();
    element.disabled = true;
    element.updated(new Map([["disabled", false]]));

    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(element.tabIndex).toBe(-1);
  });

  it("should not use delegatesFocus (incompatible with aria-hidden)", () => {
    // delegatesFocus sends focus to the inner button, but browsers
    // refuse to apply aria-hidden on a focused element.
    expect(CFButton.shadowRootOptions?.delegatesFocus).not.toBe(true);
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
