// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { IframePresentation } from "@commonfabric/iframe-sandbox";
import { ContextConsumer } from "@lit/context";
import { LitElement } from "lit";
import {
  countSubscriptions,
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { iframePresentationContext } from "../cf-iframe/cf-iframe.ts";
import {
  type CFTheme,
  cfThemeContext,
  defaultTheme,
  mergeWithDefaultTheme,
} from "../theme-context.ts";
import {
  CFThemeProvider,
  themeCellHandles,
  unwrapThemeCellValues,
} from "./index.ts";

/** An element recording each theme and guest presentation provided to it. */
class ThemeReader extends LitElement {
  readonly themes: CFTheme[] = [];
  readonly presentations: Array<IframePresentation | null> = [];

  constructor() {
    super();
    new ContextConsumer(this, {
      context: cfThemeContext,
      subscribe: true,
      callback: (theme) => this.themes.push(theme),
    });
    new ContextConsumer(this, {
      context: iframePresentationContext,
      subscribe: true,
      callback: (presentation) => this.presentations.push(presentation),
    });
  }

  /** The theme provided most recently. */
  get theme(): CFTheme | undefined {
    return this.themes.at(-1);
  }
}
customElements.define("cf-theme-test-reader", ThemeReader);

/** A `cf-theme` given `theme`, holding a reader, inside `parent`. */
async function providing(
  theme: unknown,
  parent: HTMLElement = document.body,
) {
  const provider = new CFThemeProvider();
  provider.theme = theme;
  const reader = new ThemeReader();
  provider.append(reader);
  if (parent === document.body) await mount(provider);
  else {
    parent.append(provider);
    await provider.updateComplete;
  }
  return { provider, reader };
}

/** Runs `body` with `matchMedia` whose dark preference `dark()` reports. */
async function withMediaQuery(
  body: (query: { dark: boolean; change(): void }) => Promise<void>,
) {
  const original = globalThis.matchMedia;
  const list = original("(prefers-color-scheme: dark)");
  const query = {
    dark: false,
    change: () => list.dispatchEvent(new Event("change")),
  };
  Object.defineProperty(list, "matches", { get: () => query.dark });
  globalThis.matchMedia = () => list;
  try {
    await body(query);
  } finally {
    globalThis.matchMedia = original;
  }
}

const style = (element: HTMLElement, name: string) =>
  element.style.getPropertyValue(name);

describe("cf-theme reactive theme values", () => {
  it("unwraps top-level CellHandle values before theme merge", () => {
    const accentColor = createMockCellHandle("#3b82f6");

    expect(unwrapThemeCellValues({ accentColor })).toEqual({
      accentColor: "#3b82f6",
    });
  });

  it("unwraps nested CellHandle values in color tokens", () => {
    const primary = createMockCellHandle("#121826");
    const darkText = createMockCellHandle("#f8fafc");

    expect(
      unwrapThemeCellValues({
        colors: {
          primary,
          text: {
            light: "#111827",
            dark: darkText,
          },
        },
      }),
    ).toEqual({
      colors: {
        primary: "#121826",
        text: {
          light: "#111827",
          dark: "#f8fafc",
        },
      },
    });
  });

  it("leaves out a color the worker refuses or has not answered, so the default stands", () => {
    const primary = createMockCellHandle("#121826");
    pushRefusal(primary);
    const accent = createMockCellHandle<string>();

    const unwrapped = unwrapThemeCellValues({ colors: { primary, accent } });

    expect(unwrapped).toEqual({ colors: {} });
    const merged = mergeWithDefaultTheme(unwrapped);
    expect(merged.colors.primary).toEqual(defaultTheme.colors.primary);
    expect(merged.colors.accent).toEqual(defaultTheme.colors.accent);
  });

  it("unwraps CellHandle values inside arrays, and returns other values as they are", () => {
    const accent = createMockCellHandle("teal");
    expect(unwrapThemeCellValues([accent, 1, null])).toEqual(["teal", 1, null]);
    expect(unwrapThemeCellValues("dark")).toBe("dark");
  });

  it("returns an object it has already visited as it is, so a cycle ends", () => {
    const cyclic: Record<string, unknown> = { fontFamily: "Georgia" };
    cyclic.self = cyclic;
    const unwrapped = unwrapThemeCellValues(cyclic);
    expect(unwrapped).toEqual({ fontFamily: "Georgia", self: cyclic });
  });

  it("returns every CellHandle once, through arrays, cycles, and the values cells hold", () => {
    const primary = createMockCellHandle("#121826");
    const accent = createMockCellHandle("teal");
    const colors = createMockCellHandle<Record<string, unknown>>({
      accent,
      primary,
    });
    const cyclic: Record<string, unknown> = { list: [primary, "x", 1], colors };
    cyclic.self = cyclic;

    expect(themeCellHandles(cyclic)).toEqual(
      new Set([primary, colors, accent]),
    );
    expect(themeCellHandles("dark")).toEqual(new Set());
  });

  it("unwraps a cell each place it appears, and leaves out one inside its own value", () => {
    const accent = createMockCellHandle("teal");
    const colors = createMockCellHandle<Record<string, unknown>>({});
    pushUpdate(colors, { accent, primary: accent, self: colors });
    expect(unwrapThemeCellValues({ colors })).toEqual({
      colors: { accent: "teal", primary: "teal" },
    });
  });

  it("unwraps the CellHandle values a cell's value holds", () => {
    const accent = createMockCellHandle("teal");
    const colors = createMockCellHandle<Record<string, unknown>>({ accent });
    expect(unwrapThemeCellValues({ colors })).toEqual({
      colors: { accent: "teal" },
    });
  });

  describe("CFThemeProvider", () => {
    afterEach(() => {
      document.body.replaceChildren();
      document.documentElement.removeAttribute("data-theme");
    });

    it("is registered as `cf-theme`", () => {
      expect(customElements.get("cf-theme")).toBe(CFThemeProvider);
    });

    describe("outermost", () => {
      it("writes the whole merged theme onto itself and provides it", async () => {
        const { provider, reader } = await providing({
          accentColor: "teal",
          colorScheme: "light",
        });
        expect(style(provider, "--cf-theme-color-primary")).toBe("teal");
        expect(style(provider, "--cf-theme-color-surface")).toBe("#ffffff");
        expect(style(provider, "font-family")).toBe(defaultTheme.fontFamily);
        expect(reader.theme).toEqual(
          mergeWithDefaultTheme({ accentColor: "teal", colorScheme: "light" }),
        );
      });

      it("writes and provides the default theme when given none", async () => {
        const provider = new CFThemeProvider();
        const reader = new ThemeReader();
        provider.append(reader);
        await mount(provider);
        expect(reader.theme).toEqual(defaultTheme);
        expect(style(provider, "--cf-theme-font-family")).toBe(
          defaultTheme.fontFamily,
        );
      });

      it("writes only what its partial changes under a host's CSS tokens", async () => {
        const host = document.createElement("div");
        host.style.setProperty("--cf-theme-color-text", "rgb(1, 2, 3)");
        document.body.append(host);
        const { provider } = await providing({ accentColor: "teal" }, host);
        expect(style(provider, "--cf-theme-color-primary")).toBe("teal");
        expect(style(provider, "--cf-theme-color-text")).toBe("");
        expect(style(provider, "--cf-theme-color-surface")).toBe("");
      });

      it("takes up a new theme, and takes back what the old one wrote", async () => {
        const { provider, reader } = await providing({
          accentColor: "teal",
          colorScheme: "light",
        });
        provider.theme = { fontFamily: "Courier", colorScheme: "light" };
        await provider.updateComplete;
        expect(style(provider, "--cf-theme-color-primary")).toBe("#4979fa");
        expect(style(provider, "font-family")).toBe("Courier");
        expect(reader.theme?.fontFamily).toBe("Courier");
      });

      it("takes up a change to a theme value held in a cell", async () => {
        const accent = createMockCellHandle("teal");
        const { provider, reader } = await providing({ accentColor: accent });
        pushUpdate(accent, "plum");
        expect(style(provider, "--cf-theme-color-primary")).toBe("plum");
        expect(reader.theme?.colors.accent).toBe("plum");
      });

      it("takes up, and follows, a cell that a followed cell's new value holds", async () => {
        const accent = createMockCellHandle("plum");
        const colors = createMockCellHandle<Record<string, unknown>>({
          accent: "teal",
        });
        const { reader } = await providing({ colors });
        pushUpdate(colors, { accent });
        expect(reader.theme?.colors.accent).toBe("plum");

        pushUpdate(accent, "olive");
        expect(reader.theme?.colors.accent).toBe("olive");
      });

      it("stops following a cell that a followed cell's new value no longer holds", async () => {
        const accent = createMockCellHandle("plum");
        const subscriptions = countSubscriptions(accent);
        const colors = createMockCellHandle<Record<string, unknown>>({
          accent,
        });
        const { reader } = await providing({ colors });
        expect(subscriptions.live).toBe(1);

        pushUpdate(colors, { accent: "teal" });
        expect(subscriptions.live).toBe(0);
        expect(reader.theme?.colors.accent).toBe("teal");
      });

      it("stops following a cell its new theme no longer holds", async () => {
        const accent = createMockCellHandle("teal");
        const { provider, reader } = await providing({ accentColor: accent });
        provider.theme = { accentColor: "plum" };
        await provider.updateComplete;
        const provided = reader.themes.length;

        pushUpdate(accent, "olive");
        expect(reader.themes.length).toBe(provided);
        expect(style(provider, "--cf-theme-color-primary")).toBe("plum");
      });
    });

    describe("nested", () => {
      it("provides the enclosing theme with its own partial over it, and writes only that partial", async () => {
        const { provider: outer, reader: outerReader } = await providing({
          fontFamily: "Georgia",
        });
        const { provider: inner, reader } = await providing(
          { accentColor: "teal" },
          outer,
        );
        expect(reader.theme?.fontFamily).toBe("Georgia");
        expect(reader.theme?.colors.primary).toBe("teal");
        expect(style(inner, "--cf-theme-color-primary")).toBe("teal");
        expect(style(inner, "font-family")).toBe("");
        expect(outerReader.theme?.colors.primary).toEqual(
          defaultTheme.colors.primary,
        );
      });

      it("follows a change the enclosing theme makes", async () => {
        const { provider: outer } = await providing({ fontFamily: "Georgia" });
        const { reader } = await providing({ accentColor: "teal" }, outer);
        outer.theme = { fontFamily: "Courier" };
        await outer.updateComplete;
        expect(reader.theme?.fontFamily).toBe("Courier");
        expect(reader.theme?.colors.primary).toBe("teal");
      });

      it("becomes outermost when moved out of the enclosing theme", async () => {
        const { provider: outer } = await providing({
          fontFamily: "Georgia",
        });
        const { provider: inner, reader } = await providing(
          { accentColor: "teal" },
          outer,
        );
        document.body.append(inner);
        await inner.updateComplete;
        expect(reader.theme?.fontFamily).toBe(defaultTheme.fontFamily);
        expect(style(inner, "font-family")).toBe(defaultTheme.fontFamily);
      });
    });

    describe("color scheme", () => {
      it("follows the system preference for an `auto` theme", async () => {
        await withMediaQuery(async (query) => {
          const { provider, reader } = await providing({});
          expect(style(provider, "--cf-theme-color-primary")).toBe("#4979fa");

          query.dark = true;
          query.change();
          expect(style(provider, "--cf-theme-color-primary")).toBe("#6b93ff");
          expect(reader.presentations.at(-1)?.attributes).toEqual({
            "data-color-scheme": "dark",
          });
        });
      });

      it("stops following the system preference once the theme names a scheme", async () => {
        await withMediaQuery(async (query) => {
          const { provider, reader } = await providing({});
          provider.theme = { colorScheme: "light" };
          await provider.updateComplete;
          const provided = reader.themes.length;

          query.dark = true;
          query.change();
          expect(reader.themes.length).toBe(provided);
          expect(style(provider, "--cf-theme-color-primary")).toBe("#4979fa");
        });
      });

      it("takes up the user's theme preference when told it changed", async () => {
        const { provider } = await providing({});
        document.documentElement.setAttribute("data-theme", "dark");
        document.dispatchEvent(new Event("theme-preference-changed"));
        expect(style(provider, "--cf-theme-color-primary")).toBe("#6b93ff");
      });
    });

    describe("guest presentation", () => {
      it("provides the theme values computed on it, with the resolved scheme", async () => {
        const { reader } = await providing({
          accentColor: "teal",
          colorScheme: "dark",
        });
        const presentation = reader.presentations.at(-1);
        expect(presentation?.css).toContain("--cf-theme-color-primary: teal;");
        expect(presentation?.attributes).toEqual({
          "data-color-scheme": "dark",
        });
      });

      it("provides nothing new for a reading like the last", async () => {
        const { provider, reader } = await providing({ accentColor: "teal" });
        const themes = reader.themes.length;
        const provided = reader.presentations.length;
        document.dispatchEvent(new Event("theme-preference-changed"));
        expect(reader.themes.length).toBe(themes + 1);
        expect(reader.presentations.length).toBe(provided);

        provider.theme = { accentColor: "plum" };
        await provider.updateComplete;
        expect(reader.presentations.length).toBe(provided + 1);
      });
    });

    describe("disconnected", () => {
      it("stops following theme cells, preferences, and the system scheme", async () => {
        await withMediaQuery(async (query) => {
          const accent = createMockCellHandle("teal");
          const { provider, reader } = await providing({ accentColor: accent });
          provider.remove();
          const provided = reader.themes.length;

          pushUpdate(accent, "plum");
          document.dispatchEvent(new Event("theme-preference-changed"));
          query.dark = true;
          query.change();
          expect(reader.themes.length).toBe(provided);
          expect(style(provider, "--cf-theme-color-primary")).toBe("teal");
        });
      });

      it("subscribes to nothing for a theme given while out of the document", async () => {
        const accent = createMockCellHandle("teal");
        const subscriptions = countSubscriptions(accent);
        const { provider } = await providing({});
        provider.remove();

        provider.theme = { accentColor: accent };
        await provider.updateComplete;
        expect(subscriptions.live).toBe(0);

        document.body.append(provider);
        expect(subscriptions.live).toBe(1);
        provider.remove();
        expect(subscriptions.live).toBe(0);
      });

      it("follows no system scheme for a theme given while out of the document", async () => {
        await withMediaQuery(async (query) => {
          const { provider } = await providing({ colorScheme: "light" });
          provider.remove();
          provider.theme = {};
          await provider.updateComplete;

          query.dark = true;
          query.change();
          expect(style(provider, "--cf-theme-color-primary")).toBe("#4979fa");
        });
      });

      it("recomputes when connected again", async () => {
        const accent = createMockCellHandle("teal");
        const { provider } = await providing({ accentColor: accent });
        provider.remove();
        pushUpdate(accent, "plum");
        document.body.append(provider);
        expect(style(provider, "--cf-theme-color-primary")).toBe("plum");
      });
    });
  });
});
