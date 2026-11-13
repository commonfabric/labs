// First, so that the document it installs is there when Lit loads.
import { mount, settle, window } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme, themeProperties } from "../theme-context.ts";
import type { ToolsRecord } from "./cf-tools-chip.ts";
import { CFToolsChip, type ToolsChipTool } from "./index.ts";

/** What a chip's `tools` cell holds. */
type Tools = ToolsChipTool[] | ToolsRecord;

/** Stands in for the browser's `ResizeObserver`, which happy-dom never calls. */
class FakeResizeObserver implements ResizeObserver {
  /** Every observer made since the test began. */
  static made: FakeResizeObserver[] = [];

  readonly observed = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.made.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }
}

/** Reports a resize of `element` to each observer watching it. */
function resize(element: Element) {
  for (const observer of FakeResizeObserver.made) {
    if (observer.observed.has(element)) observer.callback([], observer);
  }
}

const weather: ToolsChipTool = {
  name: "get_weather",
  description: "Get current weather for a city",
};
const search: ToolsChipTool = { name: "search_web" };

/** A chip mounted with `properties`. */
function chipWith(properties: Partial<CFToolsChip> = {}) {
  return mount(Object.assign(new CFToolsChip(), properties));
}

/** A chip mounted with `properties`, whose panel the person has opened. */
async function openChipWith(properties: Partial<CFToolsChip> = {}) {
  const element = await chipWith(properties);
  pill(element).click();
  await element.updateComplete;
  return element;
}

const pill = (element: CFToolsChip) =>
  element.shadowRoot!.querySelector<HTMLElement>(".chip")!;

const overlay = () =>
  document.querySelector<HTMLElement>("[data-cf-tools-chip-overlay]");

const panel = () => overlay()?.querySelector<HTMLElement>(".panel") ?? null;

/** The text of each node matching `selector` in the panel. */
const panelText = (selector: string) =>
  [...overlay()?.querySelectorAll(selector) ?? []].map((node) =>
    node.textContent?.trim()
  );

/** Presses `key` on `element`, and returns the event. */
function press(element: CFToolsChip, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

const hover = (target: Element) =>
  target.dispatchEvent(new MouseEvent("mouseenter"));
const unhover = (target: Element) =>
  target.dispatchEvent(new MouseEvent("mouseleave"));

describe("CFToolsChip", () => {
  const { ResizeObserver } = globalThis;

  beforeEach(() => {
    FakeResizeObserver.made = [];
    globalThis.ResizeObserver = FakeResizeObserver;
    window.happyDOM.setViewport({ width: 1000, height: 800 });
  });

  afterEach(() => {
    document.body.replaceChildren();
    globalThis.ResizeObserver = ResizeObserver;
  });

  it("is registered as `cf-tools-chip`", () => {
    expect(customElements.get("cf-tools-chip")).toBe(CFToolsChip);
  });

  describe("render()", () => {
    it("labels the pill and counts the tools beside it", async () => {
      const element = await chipWith({
        label: "Workspace",
        tools: [weather, search],
      });
      expect(pill(element).querySelector("slot")!.textContent).toBe(
        "Workspace",
      );
      expect(pill(element).querySelector(".count")!.textContent).toBe("2");
      expect(pill(element).getAttribute("aria-expanded")).toBe("false");
    });

    it("labels the pill `Tools` when the label is empty", async () => {
      const element = await chipWith({ label: "" });
      expect(pill(element).querySelector("slot")!.textContent).toBe("Tools");
    });

    it("shows no count with no tools, or with `showCount` off", async () => {
      const empty = await chipWith();
      expect(pill(empty).querySelector(".count")).toBe(null);
      const hidden = await chipWith({ tools: [weather], showCount: false });
      expect(pill(hidden).querySelector(".count")).toBe(null);
      expect(hidden.hasAttribute("show-count")).toBe(false);
    });

    it("counts each entry of a tools record", async () => {
      const element = await chipWith({ tools: { a: {}, b: {}, c: {} } });
      expect(pill(element).querySelector(".count")!.textContent).toBe("3");
    });

    it("counts the tools a bound cell holds, as they change", async () => {
      const cell = createMockCellHandle<Tools>([weather]);
      const element = await chipWith({ tools: cell });
      expect(pill(element).querySelector(".count")!.textContent).toBe("1");
      pushUpdate(cell, [weather, search]);
      await element.updateComplete;
      expect(pill(element).querySelector(".count")!.textContent).toBe("2");
    });

    it("counts nothing while a bound cell holds nothing yet", async () => {
      const element = await chipWith({
        tools: createMockCellHandle<Tools>(),
      });
      expect(pill(element).querySelector(".count")).toBe(null);
    });

    it("counts nothing once its tools are unset", async () => {
      const element = await chipWith({ tools: [weather] });
      element.tools = undefined;
      await element.updateComplete;
      expect(pill(element).querySelector(".count")).toBe(null);
    });
  });

  describe("panel", () => {
    it("is absent while the chip is closed", async () => {
      await chipWith({ tools: [weather] });
      expect(overlay()).toBe(null);
    });

    it("lists each tool with its description, and a count in the header", async () => {
      await openChipWith({ label: "Workspace", tools: [weather, search] });
      expect(panelText(".panel-title")).toEqual(["Workspace"]);
      expect(panelText(".panel-header .count")).toEqual(["2 tools"]);
      expect(panelText(".tool-name")).toEqual(["get_weather", "search_web"]);
      expect(panelText(".tool-desc")).toEqual([
        "Get current weather for a city",
      ]);
    });

    it("counts a single tool in the singular", async () => {
      await openChipWith({ tools: [weather] });
      expect(panelText(".panel-header .count")).toEqual(["1 tool"]);
    });

    it("styles its own panel and no `.panel` elsewhere on the page", async () => {
      const other = document.body.appendChild(document.createElement("div"));
      other.className = "panel";
      await openChipWith();
      expect(getComputedStyle(panel()!).position).toBe("absolute");
      expect(getComputedStyle(other).position).not.toBe("absolute");
    });

    it("says so when there are no tools", async () => {
      await openChipWith();
      expect(panelText(".panel-header .count")).toEqual([]);
      expect(panelText(".tool-desc")).toEqual(["No tools available."]);
    });

    it("lists the tools a bound cell holds, as they change while open", async () => {
      const cell = createMockCellHandle<Tools>([weather]);
      const element = await openChipWith({ tools: cell });
      pushUpdate(cell, [weather, search]);
      await element.updateComplete;
      expect(panelText(".tool-name")).toEqual(["get_weather", "search_web"]);
    });

    it("lists each parameter of a JSON Schema, marking the required ones", async () => {
      await openChipWith({
        tools: [{
          name: "get_weather",
          schema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
              units: {},
            },
            required: ["city"],
          },
        }],
      });
      expect(panelText(".schema")).toEqual([
        "• city: string (required) — City name\n• units: unknown",
      ]);
    });

    it("lists each parameter of an OpenAI-style schema", async () => {
      await openChipWith({
        tools: [{
          name: "get_weather",
          schema: {
            parameters: { properties: { city: { type: "string" } } },
          },
        }],
      });
      expect(panelText(".schema")).toEqual(["• city: string"]);
    });

    it("shows no parameters for a schema without properties", async () => {
      await openChipWith({
        tools: [{ name: "now", schema: { type: "object" } }],
      });
      expect(panelText(".tool-name")).toEqual(["now"]);
      expect(panelText(".schema")).toEqual([]);
    });

    describe("tools record", () => {
      // Each entry is a record entry, then the description and parameter list
      // the panel shows for it.

      const cases: [string, Record<string, unknown>, string[], string[]][] = [
        ["a bare entry", {}, [], []],
        ["a top-level description", { description: "Top" }, ["Top"], []],
        ["a `meta` description", { meta: { description: "Meta" } }, [
          "Meta",
        ], []],
        ["a `desc`", { desc: "Short" }, ["Short"], []],
        ["a `docs` description", { docs: { description: "Docs" } }, [
          "Docs",
        ], []],
        ["a `doc` description", { doc: { description: "Doc" } }, ["Doc"], []],
        [
          "an `inputSchema`",
          {
            inputSchema: {
              description: "Input",
              properties: { q: { type: "string" } },
            },
          },
          ["Input"],
          ["• q: string"],
        ],
        [
          "an `input_schema`",
          { input_schema: { properties: { q: { type: "string" } } } },
          [],
          ["• q: string"],
        ],
        [
          "a `parameters` schema",
          { parameters: { properties: { q: { type: "string" } } } },
          [],
          ["• q: string"],
        ],
        [
          "an `argsSchema`",
          { argsSchema: { properties: { q: { type: "string" } } } },
          [],
          ["• q: string"],
        ],
        [
          "an entry that is itself a schema",
          { type: "object", properties: { q: { type: "number" } } },
          [],
          ["• q: number"],
        ],
        [
          "a pattern's description and argument schema",
          {
            pattern: {
              description: "Pattern",
              argumentSchema: { properties: { q: { type: "string" } } },
            },
          },
          ["Pattern"],
          ["• q: string"],
        ],
        [
          "a pattern's argument schema description",
          { pattern: { argumentSchema: { description: "Argument" } } },
          ["Argument"],
          [],
        ],
        [
          "a pattern that is itself a schema",
          { pattern: { properties: { q: { type: "boolean" } } } },
          [],
          ["• q: boolean"],
        ],
        [
          "an `argumentSchema`",
          {
            argumentSchema: {
              description: "Argument",
              properties: { q: { type: "string" } },
            },
          },
          ["Argument"],
          ["• q: string"],
        ],
        ["a pattern's `desc`", { pattern: { desc: "Short" } }, ["Short"], []],
        ["a description that is not text", { description: 42 }, [], []],
        [
          "a top-level description over a pattern's",
          { description: "Top", pattern: { description: "Pattern" } },
          ["Top"],
          [],
        ],
      ];

      for (const [shape, entry, description, schema] of cases) {
        it(`shows what ${shape} describes`, async () => {
          await openChipWith({ tools: { tool: entry } });
          expect(panelText(".tool-name")).toEqual(["tool"]);
          expect(panelText(".tool-desc")).toEqual(description);
          expect(panelText(".schema")).toEqual(schema);
        });
      }
    });
  });

  describe("opening and closing", () => {
    it("opens on a click and closes on the next", async () => {
      const element = await openChipWith({ tools: [weather] });
      expect(element.open).toBe(true);
      expect(element.hasAttribute("open")).toBe(true);
      expect(pill(element).getAttribute("aria-expanded")).toBe("true");
      expect(panel()).not.toBe(null);

      pill(element).click();
      await element.updateComplete;
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });

    it("ignores clicks with `toggleOnClick` off", async () => {
      const element = await openChipWith({ toggleOnClick: false });
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });

    it("toggles on Enter and Space, taking the keypress", async () => {
      const element = await chipWith();
      const enter = press(element, "Enter");
      await element.updateComplete;
      expect(enter.defaultPrevented).toBe(true);
      expect(element.open).toBe(true);

      const space = press(element, " ");
      await element.updateComplete;
      expect(space.defaultPrevented).toBe(true);
      expect(element.open).toBe(false);
    });

    it("leaves Enter alone with `toggleOnClick` off", async () => {
      const element = await chipWith({ toggleOnClick: false });
      const enter = press(element, "Enter");
      await element.updateComplete;
      expect(enter.defaultPrevented).toBe(false);
      expect(element.open).toBe(false);
    });

    it("closes on Escape, taking the keypress", async () => {
      const element = await openChipWith();
      const escape = press(element, "Escape");
      await element.updateComplete;
      expect(escape.defaultPrevented).toBe(true);
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });

    it("leaves Escape alone while closed", async () => {
      const element = await chipWith();
      expect(press(element, "Escape").defaultPrevented).toBe(false);
    });

    it("opens while hovered, and closes after the close delay once left", async () => {
      using time = new FakeTime();
      const element = await chipWith({ closeDelay: 100 });
      hover(pill(element));
      await element.updateComplete;
      expect(element.open).toBe(true);

      unhover(pill(element));
      time.tick(99);
      await element.updateComplete;
      expect(element.open).toBe(true);
      time.tick(1);
      await element.updateComplete;
      expect(element.open).toBe(false);
    });

    it("stays open while the pointer moves from the chip to the panel", async () => {
      using time = new FakeTime();
      const element = await chipWith({ closeDelay: 100 });
      hover(pill(element));
      await element.updateComplete;
      unhover(pill(element));
      hover(panel()!);
      time.tick(100);
      await element.updateComplete;
      expect(element.open).toBe(true);

      unhover(panel()!);
      unhover(panel()!);
      time.tick(100);
      await element.updateComplete;
      expect(element.open).toBe(false);
    });

    it("ignores hovering with `openOnHover` off", async () => {
      using time = new FakeTime();
      const element = await chipWith({ openOnHover: false });
      hover(pill(element));
      await element.updateComplete;
      expect(element.open).toBe(false);

      pill(element).click();
      await element.updateComplete;
      unhover(pill(element));
      time.tick(element.closeDelay);
      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("stays open after the pointer leaves when opened by a click", async () => {
      using time = new FakeTime();
      const element = await chipWith();
      hover(pill(element));
      pill(element).click();
      unhover(pill(element));
      time.tick(element.closeDelay);
      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("stays open on a second click while hovered", async () => {
      const element = await chipWith();
      hover(pill(element));
      pill(element).click();
      pill(element).click();
      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("closes on a click elsewhere when opened by hovering", async () => {
      const element = await chipWith();
      hover(pill(element));
      await element.updateComplete;
      document.body.click();
      await element.updateComplete;
      expect(element.open).toBe(false);
    });

    it("stays open on a click elsewhere when opened by a click", async () => {
      const element = await openChipWith();
      document.body.click();
      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("stays open on a click inside the panel", async () => {
      const element = await chipWith();
      hover(pill(element));
      await element.updateComplete;
      panel()!.click();
      await element.updateComplete;
      expect(element.open).toBe(true);
    });

    it("closes a panel opened by hovering when removed while hovered, and stays closed once added", async () => {
      const element = await chipWith();
      hover(pill(element));
      await element.updateComplete;
      element.remove();
      await element.updateComplete;
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);

      await mount(element);
      expect(element.hasAttribute("open")).toBe(false);
      expect(pill(element).getAttribute("aria-expanded")).toBe("false");
      expect(overlay()).toBe(null);
    });

    it("closes a panel opened by hovering when removed during its close delay, and stays closed once added", async () => {
      using _time = new FakeTime();
      const element = await chipWith();
      hover(pill(element));
      await element.updateComplete;
      unhover(pill(element));
      element.remove();
      expect(element.open).toBe(false);

      await mount(element);
      expect(overlay()).toBe(null);
    });

    it("keeps a panel a click opened while hovered across removal", async () => {
      const element = await chipWith();
      hover(pill(element));
      pill(element).click();
      element.remove();
      await mount(element);
      expect(element.open).toBe(true);
      expect(panel()).not.toBe(null);
    });

    it("keeps `open` set by the page across removal, showing the panel again once added", async () => {
      const element = await chipWith({ open: true, tools: [weather] });
      expect(panel()).not.toBe(null);
      element.remove();
      await element.updateComplete;
      expect(overlay()).toBe(null);

      await mount(element);
      expect(element.open).toBe(true);
      expect(element.hasAttribute("open")).toBe(true);
      expect(pill(element).getAttribute("aria-expanded")).toBe("true");
      expect(panelText(".tool-name")).toEqual(["get_weather"]);
    });

    it("forgets its toggle when removed, closing on a click elsewhere once added again", async () => {
      const element = await openChipWith();
      element.remove();
      await mount(element);
      expect(panel()).not.toBe(null);
      document.body.click();
      await element.updateComplete;
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });
  });

  describe("panel position", () => {
    /**
     * Opens a chip occupying `chip`, gives its panel the size `size`, and
     * returns where the panel is placed once the browser has measured it.
     */
    async function placed(
      chip: DOMRect,
      size: { width: number; height: number },
      after?: (element: CFToolsChip) => void,
    ) {
      const element = new CFToolsChip();
      element.getBoundingClientRect = () => chip;
      await mount(element);
      pill(element).click();
      await element.updateComplete;
      const top = Number.parseFloat(panel()!.style.top);
      const left = Number.parseFloat(panel()!.style.left);
      panel()!.getBoundingClientRect = () =>
        new DOMRect(left, top, size.width, size.height);
      after?.(element);
      await settle();
      return { top: panel()!.style.top, left: panel()!.style.left };
    }

    it("places the panel below the chip, at its left edge", async () => {
      expect(await placed(new DOMRect(100, 20, 80, 24), sizeOf(300, 200)))
        .toEqual({ top: "50px", left: "100px" });
    });

    it("keeps the panel inside the right edge of the viewport", async () => {
      expect(await placed(new DOMRect(900, 20, 80, 24), sizeOf(300, 200)))
        .toEqual({ top: "50px", left: "692px" });
    });

    it("keeps the panel off the left edge of the viewport", async () => {
      expect(await placed(new DOMRect(2, 20, 80, 24), sizeOf(300, 200)))
        .toEqual({ top: "50px", left: "8px" });
    });

    it("places the panel above the chip when it would overflow below", async () => {
      expect(await placed(new DOMRect(100, 600, 80, 24), sizeOf(300, 200)))
        .toEqual({ top: "394px", left: "100px" });
    });

    it("keeps a panel too tall for either side inside the viewport", async () => {
      expect(await placed(new DOMRect(100, 100, 80, 24), sizeOf(300, 700)))
        .toEqual({ top: "92px", left: "100px" });
    });

    it("places the panel again when the chip moves", async () => {
      let chip = new DOMRect(100, 20, 80, 24);
      expect(
        await placed(chip, sizeOf(300, 200), (element) => {
          chip = new DOMRect(300, 40, 80, 24);
          element.getBoundingClientRect = () => chip;
          resize(element);
        }),
      ).toEqual({ top: "70px", left: "300px" });
    });

    it("places the panel again when the window resizes or scrolls", async () => {
      for (const type of ["resize", "scroll"]) {
        expect(
          await placed(
            new DOMRect(100, 20, 80, 24),
            sizeOf(300, 200),
            (element) => {
              element.getBoundingClientRect = () =>
                new DOMRect(200, 30, 80, 24);
              globalThis.dispatchEvent(new Event(type));
            },
          ),
        ).toEqual({ top: "60px", left: "200px" });
      }
    });

    it("ignores the chip resizing while closed", async () => {
      const element = await chipWith();
      resize(element);
      await settle();
      expect(overlay()).toBe(null);
    });

    it("ignores the window resizing while closed", async () => {
      const element = await chipWith();
      globalThis.dispatchEvent(new Event("resize"));
      await settle();
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });
  });

  describe("theme", () => {
    it("writes a theme given to it onto its own style and the panel", async () => {
      const theme = { ...defaultTheme, fontFamily: "Georgia, serif" };
      const font = themeProperties(theme)["--cf-theme-font-family"];
      const element = await openChipWith();
      element.theme = theme;
      await element.updateComplete;
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        font,
      );
      expect(overlay()!.style.getPropertyValue("--cf-theme-font-family"))
        .toBe(font);
    });

    it("gives a panel it opens the theme in effect around it", async () => {
      const element = await chipWith();
      element.style.setProperty("--cf-theme-color-text", "red");
      pill(element).click();
      await element.updateComplete;
      expect(overlay()!.style.getPropertyValue("--cf-theme-color-text")).toBe(
        "red",
      );
    });

    it("copies the theme onto the open panel again when the preference changes", async () => {
      const element = await openChipWith();
      element.style.setProperty("--cf-theme-color-text", "blue");
      document.dispatchEvent(new Event("theme-preference-changed"));
      expect(overlay()!.style.getPropertyValue("--cf-theme-color-text")).toBe(
        "blue",
      );
    });

    it("copies nothing when the preference changes while closed", async () => {
      const element = await chipWith();
      document.dispatchEvent(new Event("theme-preference-changed"));
      expect(element.open).toBe(false);
      expect(overlay()).toBe(null);
    });
  });
});

/** A panel size. */
function sizeOf(width: number, height: number) {
  return { width, height };
}
