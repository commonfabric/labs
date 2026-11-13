// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CFHoverCard } from "./index.ts";

/**
 * A `ResizeObserver` the test fires by hand, since happy-dom's never calls
 * back.
 */
class ResizeObserverStandIn {
  static made: ResizeObserverStandIn[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(readonly fire: () => void) {
    ResizeObserverStandIn.made.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

/**
 * Makes `descriptor` `target`'s own `name` again, or removes `name` when
 * `target` had no own property of that name.
 */
function restore(
  target: object,
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, name);
  else Object.defineProperty(target, name, descriptor);
}

/** Where `card` is placed, as its inline style says. */
function placement(card: HTMLElement): { top: string; left: string } {
  return { top: card.style.top, left: card.style.left };
}

/**
 * A hover card holding a button, with the box and card size given, since
 * happy-dom lays nothing out: its content spans 300 to 320 from the top at 50
 * from the left until the test moves `anchor`, and its card is 100 by 40, in a
 * window of 1024 by 768.
 */
function hoverCard(): {
  element: CFHoverCard;
  button: HTMLButtonElement;
  anchor: { top: number; bottom: number; left: number };
} {
  const element = new CFHoverCard();
  const button = document.createElement("button");
  element.append(button);
  const anchor = { top: 300, bottom: 320, left: 50 };
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => anchor,
  });
  return { element, button, anchor };
}

/** The card `element` rendered, given the size `hoverCard()` describes. */
function cardOf(element: CFHoverCard): HTMLElement {
  const card = element.shadowRoot!.querySelector<HTMLElement>(".card")!;
  Object.defineProperties(card, {
    offsetWidth: { configurable: true, value: 100 },
    offsetHeight: { configurable: true, value: 40 },
  });
  return card;
}

/** Fires `type` at `target` as the browser would. */
function fire(target: Element, type: string, init: FocusEventInit = {}) {
  target.dispatchEvent(
    type.startsWith("focus")
      ? new FocusEvent(type, { bubbles: true, composed: true, ...init })
      : new Event(type),
  );
}

describe("CFHoverCard", () => {
  // happy-dom has no popovers, so `HTMLElement` is given a stand-in for the
  // part of the API the card uses: showing, hiding, and `:popover-open`. Its
  // `ResizeObserver` never calls back, so that is replaced too.

  const shown = new WeakSet<Element>();
  const proto = HTMLElement.prototype;
  const replaced = ["showPopover", "hidePopover", "matches"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  let savedResizeObserver: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = replaced.map((name) =>
      Object.getOwnPropertyDescriptor(proto, name)
    );
    const matches = proto.matches;
    Object.defineProperties(proto, {
      showPopover: {
        configurable: true,
        value(this: HTMLElement) {
          shown.add(this);
        },
      },
      hidePopover: {
        configurable: true,
        value(this: HTMLElement) {
          shown.delete(this);
        },
      },
      matches: {
        configurable: true,
        value(this: HTMLElement, selector: string) {
          return selector === ":popover-open"
            ? shown.has(this)
            : matches.call(this, selector);
        },
      },
    });
    savedResizeObserver = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );
    ResizeObserverStandIn.made = [];
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStandIn,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    replaced.forEach((name, index) => restore(proto, name, saved[index]));
    restore(globalThis, "ResizeObserver", savedResizeObserver);
  });

  it("registers the custom element", () => {
    expect(customElements.get("cf-hover-card")).toBe(CFHoverCard);
  });

  describe("instance members", () => {
    describe("open", () => {
      it("is `false` before the card has rendered", () => {
        expect(new CFHoverCard().open).toBe(false);
      });
    });
  });

  describe("pointer", () => {
    it("shows the card above its content while the pointer is on the content", async () => {
      const { element } = hoverCard();
      await mount(element);
      const card = cardOf(element);
      expect(element.open).toBe(false);

      fire(element, "pointerenter");
      expect(element.open).toBe(true);
      expect(placement(card)).toEqual({ top: "254px", left: "50px" });
    });

    it("hides the card once the pointer leaves", async () => {
      const { element } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");

      fire(element, "pointerleave");
      expect(element.open).toBe(false);
    });

    it("keeps the card shown when the pointer leaves while focus is inside", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");
      fire(button, "focusin");

      fire(element, "pointerleave");
      expect(element.open).toBe(true);
    });

    it("shows the card once it renders, for a pointer that entered before", async () => {
      const { element } = hoverCard();
      document.body.append(element);
      fire(element, "pointerenter");
      expect(element.open).toBe(false);

      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("does not show the card once it renders, for a pointer that has left again", async () => {
      const { element } = hoverCard();
      document.body.append(element);
      fire(element, "pointerenter");
      fire(element, "pointerleave");

      await element.updateComplete;
      expect(element.open).toBe(false);
    });

    it("does not show the card once it renders, after it has left the document", async () => {
      const { element } = hoverCard();
      document.body.append(element);
      fire(element, "pointerenter");
      const rendered = element.updateComplete;
      element.remove();

      await rendered;
      expect(element.open).toBe(false);
    });
  });

  describe("focus", () => {
    it("shows the card while focus is inside", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);

      fire(button, "focusin");
      expect(element.open).toBe(true);
    });

    it("hides the card when focus moves outside", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      const outside = document.createElement("input");
      document.body.append(outside);
      fire(button, "focusin");

      fire(button, "focusout", { relatedTarget: outside });
      expect(element.open).toBe(false);
    });

    it("hides the card when focus leaves the window", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(button, "focusin");

      fire(button, "focusout", { relatedTarget: null });
      expect(element.open).toBe(false);
    });

    it("keeps the card shown when focus moves to another element inside", async () => {
      const { element, button } = hoverCard();
      const other = document.createElement("button");
      element.append(other);
      await mount(element);
      cardOf(element);
      fire(button, "focusin");

      fire(button, "focusout", { relatedTarget: other });
      expect(element.open).toBe(true);
    });

    it("keeps the card shown when focus leaves while the pointer is on the content", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");
      fire(button, "focusin");

      fire(button, "focusout", { relatedTarget: null });
      expect(element.open).toBe(true);
    });
  });

  describe("placement", () => {
    it("places the card again when its size changes", async () => {
      const { element } = hoverCard();
      await mount(element);
      const card = cardOf(element);
      fire(element, "pointerenter");
      const [observer] = ResizeObserverStandIn.made;
      expect(observer.observed).toEqual([card]);

      // Too tall to fit above, so it goes below.
      Object.defineProperty(card, "offsetHeight", { value: 400 });
      observer.fire();
      expect(placement(card)).toEqual({ top: "326px", left: "50px" });
    });

    it("stops watching the card's size once it hides", async () => {
      const { element } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");
      fire(element, "pointerleave");
      expect(ResizeObserverStandIn.made.map((made) => made.disconnected))
        .toEqual([true]);
    });

    it("does not show or place the card again while it is showing", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");
      fire(button, "focusin");
      expect(ResizeObserverStandIn.made.length).toBe(1);
    });

    it("places the card again when anything in the page scrolls", async () => {
      const { element, anchor } = hoverCard();
      const scroller = document.createElement("div");
      scroller.append(element);
      document.body.append(scroller);
      await element.updateComplete;
      const card = cardOf(element);
      fire(element, "pointerenter");

      anchor.top = 200;
      scroller.dispatchEvent(new Event("scroll"));
      expect(placement(card)).toEqual({ top: "154px", left: "50px" });
    });

    it("places the card again when the window resizes", async () => {
      const { element, anchor } = hoverCard();
      await mount(element);
      const card = cardOf(element);
      fire(element, "pointerenter");

      anchor.left = 80;
      globalThis.dispatchEvent(new Event("resize"));
      expect(placement(card)).toEqual({ top: "254px", left: "80px" });
    });

    it("does not place the card again on a scroll or a resize once it hides", async () => {
      const { element, anchor } = hoverCard();
      await mount(element);
      const card = cardOf(element);
      fire(element, "pointerenter");
      fire(element, "pointerleave");

      anchor.top = 200;
      anchor.left = 80;
      document.body.dispatchEvent(new Event("scroll"));
      globalThis.dispatchEvent(new Event("resize"));
      expect(placement(card)).toEqual({ top: "254px", left: "50px" });
    });
  });

  describe("leaving the document", () => {
    it("hides the card", async () => {
      const { element } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");

      element.remove();
      expect(element.open).toBe(false);
    });

    it("forgets that the pointer was on it, so focus alone holds the card when it returns", async () => {
      const { element, button } = hoverCard();
      await mount(element);
      cardOf(element);
      fire(element, "pointerenter");
      element.remove();

      await mount(element);
      expect(element.open).toBe(false);
      fire(button, "focusin");
      fire(button, "focusout", { relatedTarget: null });
      expect(element.open).toBe(false);
    });

    it("stops listening for the pointer", async () => {
      const { element } = hoverCard();
      await mount(element);
      cardOf(element);
      element.remove();

      fire(element, "pointerenter");
      expect(element.open).toBe(false);
    });
  });
});
