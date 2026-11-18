// First, so that the document it installs is there when Lit loads.
import { mount, window } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAutoLayout } from "./index.ts";

/** An element for `slot`, or for the content area when `slot` is empty. */
function pane(text: string, slot = ""): HTMLElement {
  const element = document.createElement("div");
  if (slot) element.slot = slot;
  element.textContent = text;
  return element;
}

/** A layout holding `children`, with `properties` set, mounted. */
function layout(
  children: HTMLElement[],
  properties: Partial<Pick<CFAutoLayout, "tabNames" | "tabsPosition">> = {},
): Promise<CFAutoLayout> {
  const element = Object.assign(new CFAutoLayout(), properties);
  element.append(...children);
  return mount(element);
}

/** A layout with a left sidebar, two content panes, and a right sidebar. */
const fullLayout = (): Promise<CFAutoLayout> =>
  layout([
    pane("Outline", "left"),
    pane("Chat"),
    pane("Tools"),
    pane("Details", "right"),
  ]);

/** The element in `element`'s shadow root matching `selector`. */
function part(element: CFAutoLayout, selector: string): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector} rendered`);
  return found;
}

/** The `open` detail of each `type` event `element` emits from now on. */
function opens(element: CFAutoLayout, type: string): boolean[] {
  const seen: boolean[] = [];
  element.addEventListener(
    type,
    (event) => seen.push((event as CustomEvent<{ open: boolean }>).detail.open),
  );
  return seen;
}

/** Sizes the window as a phone, which the layout treats as mobile. */
const usePhoneViewport = () =>
  window.happyDOM.setViewport({ width: 500, height: 800 });

/** Presses Escape where the whole page hears it. */
function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape" });
  globalThis.dispatchEvent(event);
  return event;
}

describe("CFAutoLayout", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.happyDOM.setViewport({ width: 1024, height: 768 });
  });

  describe("constructor()", () => {
    it("starts with both sidebars open and the tabs at the bottom", async () => {
      const element = await fullLayout();

      expect(element.hasAttribute("leftopen")).toBe(true);
      expect(element.hasAttribute("rightopen")).toBe(true);
      expect(element.getAttribute("tabsposition")).toBe("bottom");
      expect(part(element, ".mobile-bar").classList.contains("top")).toBe(
        false,
      );
    });
  });

  describe("rendering", () => {
    it("labels the tabs with `tabNames` when it names each content pane", async () => {
      const element = await layout(
        [pane("Outline", "left"), pane("Chat"), pane("Tools")],
        { tabNames: ["Chat", "Tools"] },
      );

      const tabs = [...element.shadowRoot!.querySelectorAll(".tab")];
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
        "Chat",
        "Tools",
      ]);
    });

    it("numbers the tabs when `tabNames` does not name each content pane", async () => {
      const element = await layout(
        [pane("Chat"), pane("Tools"), pane("Details", "right")],
        { tabNames: ["Only one"] },
      );

      const tabs = [...element.shadowRoot!.querySelectorAll(".tab")];
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
        "Pane 1",
        "Pane 2",
      ]);
    });

    it("marks the first content pane and its tab active, and no sidebar", async () => {
      const outline = pane("Outline", "left");
      const chat = pane("Chat");
      const tools = pane("Tools");
      const element = await layout([outline, chat, tools]);

      expect(chat.classList.contains("active-tab")).toBe(true);
      expect(tools.classList.contains("active-tab")).toBe(false);
      expect(outline.classList.contains("active-tab")).toBe(false);
      const tabs = [...element.shadowRoot!.querySelectorAll(".tab")];
      expect(tabs.map((tab) => tab.classList.contains("active"))).toEqual([
        true,
        false,
      ]);
    });

    it("places the mobile bar at the top when `tabsPosition` is `top`", async () => {
      const element = await layout([pane("Chat")], { tabsPosition: "top" });

      expect(element.getAttribute("tabsposition")).toBe("top");
      expect(part(element, ".mobile-bar").classList.contains("top")).toBe(true);
    });

    it("lays out a sidebar as open only when it has content", async () => {
      const element = await layout([pane("Outline", "left"), pane("Chat")]);

      const classes = part(element, ".layout").classList;
      expect(classes.contains("has-left")).toBe(true);
      expect(classes.contains("left-open")).toBe(true);
      expect(classes.contains("has-right")).toBe(false);
      expect(classes.contains("right-open")).toBe(false);
    });
  });

  describe("tabs", () => {
    it("makes the clicked tab and its pane the active ones", async () => {
      const chat = pane("Chat");
      const tools = pane("Tools");
      const element = await layout([chat, tools]);

      element.shadowRoot!.querySelectorAll<HTMLElement>(".tab")[1].click();
      await element.updateComplete;

      expect(chat.classList.contains("active-tab")).toBe(false);
      expect(tools.classList.contains("active-tab")).toBe(true);
      const tabs = [...element.shadowRoot!.querySelectorAll(".tab")];
      expect(tabs.map((tab) => tab.classList.contains("active"))).toEqual([
        false,
        true,
      ]);
    });
  });

  describe("sidebar toggles", () => {
    it("closes and reopens the left sidebar, emitting `cf-toggle-left` once each time", async () => {
      const element = await fullLayout();
      const seen = opens(element, "cf-toggle-left");
      const toggle = part(element, ".desktop-toggle-left cf-button");

      toggle.click();
      await element.updateComplete;
      expect(element.leftOpen).toBe(false);
      expect(element.hasAttribute("leftopen")).toBe(false);
      expect(part(element, ".layout").classList.contains("left-open")).toBe(
        false,
      );
      expect(seen).toEqual([false]);

      toggle.click();
      await element.updateComplete;
      expect(element.leftOpen).toBe(true);
      expect(seen).toEqual([false, true]);
    });

    it("closes the right sidebar from the mobile bar, emitting `cf-toggle-right` once", async () => {
      const element = await fullLayout();
      const seen = opens(element, "cf-toggle-right");

      part(element, ".mobile-bar cf-button[aria-label='Toggle right sidebar']")
        .click();
      await element.updateComplete;

      expect(element.rightOpen).toBe(false);
      expect(seen).toEqual([false]);
    });

    it("leaves the other sidebar open on a desktop", async () => {
      const element = await fullLayout();
      const toggle = part(element, ".desktop-toggle-right cf-button");

      toggle.click();
      await element.updateComplete;
      toggle.click();
      await element.updateComplete;

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(true);
    });

    it("does nothing for a side with no sidebar", async () => {
      const element = await layout([pane("Chat")]);
      const left = opens(element, "cf-toggle-left");
      const right = opens(element, "cf-toggle-right");

      part(element, ".desktop-toggle-left cf-button").click();
      part(element, ".desktop-toggle-right cf-button").click();
      await element.updateComplete;

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(true);
      expect(left).toEqual([]);
      expect(right).toEqual([]);
    });
  });

  describe("on a phone", () => {
    it("opens only the left sidebar when both start open", async () => {
      usePhoneViewport();
      const element = await fullLayout();
      await element.updateComplete;

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(false);
    });

    it("closes the left sidebar when the right one is toggled open", async () => {
      usePhoneViewport();
      const element = await fullLayout();
      await element.updateComplete;
      const left = opens(element, "cf-toggle-left");
      const right = opens(element, "cf-toggle-right");

      part(element, ".mobile-bar cf-button[aria-label='Toggle right sidebar']")
        .click();
      await element.updateComplete;

      expect(element.rightOpen).toBe(true);
      expect(element.leftOpen).toBe(false);
      expect(right).toEqual([true]);
      expect(left).toEqual([false]);
    });

    it("closes the right sidebar when the left one is toggled open", async () => {
      usePhoneViewport();
      const element = await fullLayout();
      const toggle = part(element, ".mobile-bar cf-button");
      toggle.click();
      await element.updateComplete;
      element.rightOpen = true;
      await element.updateComplete;

      toggle.click();
      await element.updateComplete;

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(false);
    });

    it("closes the sidebar opened earlier when a host opens the other", async () => {
      usePhoneViewport();
      const element = await fullLayout();
      await element.updateComplete;
      const left = opens(element, "cf-toggle-left");

      element.rightOpen = true;
      await element.updateComplete;
      await element.updateComplete;

      expect(element.rightOpen).toBe(true);
      expect(element.leftOpen).toBe(false);
      expect(left).toEqual([false]);
    });

    it("closes both sidebars when the scrim is clicked", async () => {
      usePhoneViewport();
      const element = await fullLayout();
      await element.updateComplete;

      part(element, ".scrim").click();
      await element.updateComplete;

      expect(element.leftOpen).toBe(false);
      expect(element.rightOpen).toBe(false);
    });
  });

  describe("Escape", () => {
    it("closes both sidebars and returns focus to the toggle last used", async () => {
      const element = await fullLayout();
      const toggle = part(element, ".desktop-toggle-left cf-button");
      const focused: HTMLElement[] = [];
      toggle.focus = () => focused.push(toggle);
      toggle.click();
      toggle.click();
      await element.updateComplete;

      const event = pressEscape();
      await element.updateComplete;

      expect(element.leftOpen).toBe(false);
      expect(element.rightOpen).toBe(false);
      expect(focused).toEqual([toggle]);
      expect(event.cancelBubble).toBe(true);
    });

    it("leaves the key alone when no sidebar is open", async () => {
      const element = await fullLayout();
      element.leftOpen = false;
      element.rightOpen = false;
      await element.updateComplete;

      const event = pressEscape();

      expect(event.cancelBubble).toBe(false);
    });

    it("leaves the sidebars open on another key", async () => {
      const element = await fullLayout();

      globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(true);
    });

    it("leaves the sidebars open once the layout is removed", async () => {
      const element = await fullLayout();

      element.remove();
      pressEscape();

      expect(element.leftOpen).toBe(true);
      expect(element.rightOpen).toBe(true);
    });
  });
});
