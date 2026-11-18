// First, so that the document it installs is there when Lit loads.
import { mount } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";

import {
  AmbientThemeWatch,
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  copyThemeProperties,
  defaultTheme,
  getAnimationDuration,
  getSemanticSpacing,
  mergeWithDefaultTheme,
  resolveColor,
  resolveColorScheme,
  themeProperties,
  themePropertyNames,
  tokenAround,
} from "./theme-context.ts";

/** An element that counts the changes its `AmbientThemeWatch` reports. */
class WatchingElement extends LitElement {
  changes = 0;

  constructor() {
    super();
    new AmbientThemeWatch(this, () => this.changes++);
  }
}
customElements.define("theme-context-watching-element", WatchingElement);

/** Runs `body` with `globalThis.matchMedia` reporting `dark` as preferred. */
function preferringDark(dark: boolean, body: () => void) {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = (query: string) => {
    const list = original(query);
    Object.defineProperty(list, "matches", { value: dark });
    return list;
  };
  try {
    body();
  } finally {
    globalThis.matchMedia = original;
  }
}

describe("theme-context", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-theme");
  });

  describe("resolveColorScheme()", () => {
    it("returns an explicit scheme as it is", () => {
      document.documentElement.setAttribute("data-theme", "dark");
      expect(resolveColorScheme("light")).toBe("light");
      expect(resolveColorScheme("dark")).toBe("dark");
    });

    for (const scheme of ["light", "dark"] as const) {
      it(`returns the document's \`data-theme\` of ${scheme} for \`auto\``, () => {
        document.documentElement.setAttribute("data-theme", scheme);
        preferringDark(scheme === "light", () => {
          expect(resolveColorScheme("auto")).toBe(scheme);
        });
      });
    }

    it("returns the system preference for `auto` when `data-theme` names no scheme", () => {
      document.documentElement.setAttribute("data-theme", "sepia");
      preferringDark(true, () => {
        expect(resolveColorScheme("auto")).toBe("dark");
      });
      preferringDark(false, () => {
        expect(resolveColorScheme("auto")).toBe("light");
      });
    });

    it("returns `light` for `auto` where there is no `matchMedia`", () => {
      const original = globalThis.matchMedia;
      Reflect.deleteProperty(globalThis, "matchMedia");
      try {
        expect(resolveColorScheme("auto")).toBe("light");
      } finally {
        globalThis.matchMedia = original;
      }
    });
  });

  describe("resolveColor()", () => {
    it("returns a plain color for either scheme", () => {
      expect(resolveColor("red", "light")).toBe("red");
      expect(resolveColor("red", "dark")).toBe("red");
    });

    it("returns the variant of an adaptive color for the scheme", () => {
      const token = { light: "white", dark: "black" };
      expect(resolveColor(token, "light")).toBe("white");
      expect(resolveColor(token, "dark")).toBe("black");
    });
  });

  describe("getSemanticSpacing()", () => {
    it("returns the scaled size as the fallback of the nearest spacing level", () => {
      expect(getSemanticSpacing("comfortable", "sm", "normal")).toBe(
        "var(--cf-spacing-1, 0.2875rem)",
      );
      expect(getSemanticSpacing("compact", "xs", "tight")).toBe(
        "var(--cf-spacing-0, 0.09375rem)",
      );
    });

    it("returns at most spacing level 4", () => {
      expect(getSemanticSpacing("spacious", "xxl", "loose")).toBe(
        "var(--cf-spacing-4, 2.625rem)",
      );
    });

    it("scales for the normal context when given none", () => {
      expect(getSemanticSpacing("compact", "xl")).toBe(
        getSemanticSpacing("compact", "xl", "normal"),
      );
      expect(getSemanticSpacing("compact", "xl")).toBe(
        "var(--cf-spacing-3, 0.85rem)",
      );
    });
  });

  describe("mergeWithDefaultTheme()", () => {
    it("returns the base theme for anything that is not an object", () => {
      expect(mergeWithDefaultTheme(undefined)).toBe(defaultTheme);
      expect(mergeWithDefaultTheme("dark")).toBe(defaultTheme);
      const base = { ...defaultTheme, fontSize: "2rem" };
      expect(mergeWithDefaultTheme(null, base)).toBe(base);
    });

    it("returns the defaults for an empty partial, without changing them", () => {
      const merged = mergeWithDefaultTheme({});
      expect(merged).toEqual(defaultTheme);
      expect(merged).not.toBe(defaultTheme);
    });

    it("takes a pattern-style accent as both the primary and accent colors", () => {
      const merged = mergeWithDefaultTheme({ accentColor: "teal" });
      expect(merged.colors.primary).toBe("teal");
      expect(merged.colors.accent).toBe("teal");
      expect(merged.colors.text).toEqual(defaultTheme.colors.text);
      expect(defaultTheme.colors.primary).not.toBe("teal");
    });

    it("takes a pattern-style font face, and prefers a font family to it", () => {
      expect(mergeWithDefaultTheme({ fontFace: "Georgia" }).fontFamily).toBe(
        "Georgia",
      );
      expect(
        mergeWithDefaultTheme({ fontFace: "Georgia", fontFamily: "Courier" })
          .fontFamily,
      ).toBe("Courier");
    });

    it("takes every theme property the partial names over the base", () => {
      const partial = {
        borderRadius: "2px",
        monoFontFamily: "Menlo",
        fontSize: "18px",
        density: "compact",
        colorScheme: "dark",
        animationSpeed: "fast",
        roundness: 0,
        scale: 1.2,
        motion: 0,
        colors: { text: "black" },
      };
      const merged = mergeWithDefaultTheme(partial);
      expect(merged).toEqual({
        ...defaultTheme,
        ...partial,
        colors: { ...defaultTheme.colors, text: "black" },
      });
    });

    it("merges over the theme it is given in place of the defaults", () => {
      const base = mergeWithDefaultTheme({ fontFamily: "Courier" });
      const merged = mergeWithDefaultTheme({ accentColor: "teal" }, base);
      expect(merged.fontFamily).toBe("Courier");
      expect(merged.colors.primary).toBe("teal");
    });
  });

  describe("getAnimationDuration()", () => {
    it("returns the duration for each speed", () => {
      expect(getAnimationDuration("none")).toBe("0ms");
      expect(getAnimationDuration("slow")).toBe("500ms");
      expect(getAnimationDuration("normal")).toBe("200ms");
      expect(getAnimationDuration("fast")).toBe("100ms");
    });

    it("returns the normal duration for an unknown speed", () => {
      // @ts-expect-error: a pattern can hand over any string.
      expect(getAnimationDuration("glacial")).toBe("200ms");
    });
  });

  describe("themeProperties()", () => {
    const light = { ...defaultTheme, colorScheme: "light" } as const;
    const dark = { ...defaultTheme, colorScheme: "dark" } as const;

    it("returns the fonts, and the light colors for a light theme", () => {
      const properties = themeProperties(light);
      expect(properties["font-family"]).toBe(defaultTheme.fontFamily);
      expect(properties["--cf-theme-font-family"]).toBe(
        defaultTheme.fontFamily,
      );
      expect(properties["--cf-theme-font-mono"]).toBe(
        defaultTheme.monoFontFamily,
      );
      expect(properties["--cf-theme-color-primary"]).toBe("#4979fa");
      expect(properties["--cf-theme-primary"]).toBe("#4979fa");
      expect(properties["--cf-theme-color-text-pressed"]).toBe("#16181d");
    });

    it("returns the dark colors for a dark theme", () => {
      const properties = themeProperties(dark);
      expect(properties["--cf-theme-color-primary"]).toBe("#6b93ff");
      expect(properties["--cf-theme-color-status-error-foreground"]).toBe(
        "#451a03",
      );
    });

    it("returns families of colors derived from each intent's base", () => {
      const properties = themeProperties({
        ...light,
        colors: { ...light.colors, error: "red", surface: "white" },
      });
      expect(properties["--cf-theme-color-danger-pressed"]).toBe(
        "color-mix(in srgb, red 85%, black)",
      );
      expect(properties["--cf-theme-color-status-error"]).toBe("red");
      expect(properties["--cf-theme-color-status-error-soft"]).toBe(
        "color-mix(in srgb, red 20%, transparent)",
      );
      expect(properties["--cf-theme-color-status-error-subtle"]).toBe(
        "color-mix(in srgb, red 10%, transparent)",
      );
      expect(properties["--cf-theme-color-error-surface"]).toBe(
        "color-mix(in srgb, red 12%, white)",
      );
    });

    it("returns the radius, font size, and duration the scalars scale when those are left at their defaults", () => {
      const properties = themeProperties({
        ...light,
        roundness: 0.5,
        scale: 1.25,
        motion: 0.5,
      });
      expect(properties["--cf-theme-border-radius"]).toBe("0.25rem");
      expect(properties["--cf-theme-font-size"]).toBe("1.25rem");
      expect(properties["--cf-theme-animation-duration"]).toBe("100ms");
    });

    it("returns an explicit radius, font size, and speed over the scalars", () => {
      const properties = themeProperties({
        ...light,
        borderRadius: "3px",
        fontSize: "14px",
        animationSpeed: "slow",
        roundness: 0,
        scale: 2,
        motion: 0,
      });
      expect(properties["--cf-theme-border-radius"]).toBe("3px");
      expect(properties["--cf-theme-font-size"]).toBe("14px");
      expect(properties["--cf-theme-animation-duration"]).toBe("500ms");
    });

    it("returns the spacing for the theme's density", () => {
      const properties = themeProperties({ ...light, density: "compact" });
      expect(properties["--cf-theme-spacing-normal"]).toBe(
        getSemanticSpacing("compact", "sm", "normal"),
      );
      expect(properties["--cf-theme-spacing"]).toBe(
        properties["--cf-theme-spacing-normal"],
      );
      expect(properties["--cf-theme-spacing-compact"]).toBe(
        getSemanticSpacing("compact", "xs", "tight"),
      );
    });
  });

  describe("themePropertyNames()", () => {
    it("returns the names `themeProperties()` returns for any theme", () => {
      const names = themePropertyNames();
      expect(names).toEqual(
        Object.keys(themeProperties({ ...defaultTheme, colorScheme: "dark" })),
      );
      expect(names).toContain("font-family");
      expect(
        names.every((name) =>
          name === "font-family" || name.startsWith("--cf-theme-")
        ),
      ).toBe(true);
    });
  });

  describe("applyThemeToElement()", () => {
    const teal = mergeWithDefaultTheme({ accentColor: "teal" });

    it("writes every theme property onto the element's style", () => {
      const element = document.createElement("div");
      applyThemeToElement(element, teal);
      const properties = themeProperties(teal);
      for (const name of themePropertyNames()) {
        expect(element.style.getPropertyValue(name)).toBe(properties[name]);
      }
    });

    it("writes only what differs from the theme in effect around it", () => {
      const element = document.createElement("div");
      applyThemeToElement(element, teal, defaultTheme);
      expect(element.style.getPropertyValue("--cf-theme-color-primary")).toBe(
        "teal",
      );
      expect(element.style.getPropertyValue("--cf-theme-color-text")).toBe("");
      expect(element.style.getPropertyValue("font-family")).toBe("");
    });

    it("takes back what it wrote when the theme is taken off", () => {
      const element = document.createElement("div");
      applyThemeToElement(element, teal);
      applyThemeToElement(element, undefined);
      expect(element.style.length).toBe(0);
    });

    it("puts back what the element's author set", () => {
      const element = document.createElement("div");
      element.style.setProperty("--cf-theme-color-primary", "plum");
      element.style.setProperty("color", "green");
      applyThemeToElement(element, teal);
      expect(element.style.getPropertyValue("--cf-theme-color-primary")).toBe(
        "teal",
      );

      applyThemeToElement(element, undefined);
      expect(element.style.getPropertyValue("--cf-theme-color-primary")).toBe(
        "plum",
      );
      expect(element.style.getPropertyValue("color")).toBe("green");
      expect(element.style.length).toBe(2);
    });

    it("takes back a property the next theme leaves to inherit", () => {
      const element = document.createElement("div");
      applyThemeToElement(element, teal, defaultTheme);
      applyThemeToElement(
        element,
        mergeWithDefaultTheme({ fontFamily: "Courier" }),
        defaultTheme,
      );
      expect(element.style.getPropertyValue("--cf-theme-color-primary")).toBe(
        "",
      );
      expect(element.style.getPropertyValue("font-family")).toBe("Courier");
    });
  });

  describe("tokenAround()", () => {
    it("returns the value the element's parent has for the property", () => {
      const parent = document.createElement("div");
      parent.style.setProperty("--cf-theme-color-text", " red ");
      const child = document.createElement("span");
      parent.append(child);
      document.body.append(parent);
      expect(tokenAround(child, "--cf-theme-color-text")).toBe("red");
      expect(tokenAround(child, "--cf-theme-color-surface")).toBe("");
    });

    it("returns the value the shadow host has for an element at a shadow root's top", () => {
      const host = document.createElement("div");
      host.style.setProperty("--cf-theme-color-text", "red");
      const child = document.createElement("span");
      host.attachShadow({ mode: "open" }).append(child);
      document.body.append(host);
      expect(tokenAround(child, "--cf-theme-color-text")).toBe("red");
    });

    it("returns an empty string for an element with nothing around it", () => {
      const element = document.createElement("div");
      expect(tokenAround(element, "--cf-theme-color-text")).toBe("");
    });
  });

  describe("copyThemeProperties()", () => {
    it("copies the theme properties in effect at one element onto another, and clears the rest", () => {
      const from = document.createElement("div");
      from.style.setProperty("--cf-theme-color-text", "red");
      document.body.append(from);
      const to = document.createElement("div");
      to.style.setProperty("--cf-theme-color-surface", "blue");
      to.style.setProperty("color", "green");

      copyThemeProperties(from, to);

      expect(to.style.getPropertyValue("--cf-theme-color-text")).toBe("red");
      expect(to.style.getPropertyValue("--cf-theme-color-surface")).toBe("");
      expect(to.style.getPropertyValue("color")).toBe("green");
    });
  });

  describe("AmbientThemeWatch", () => {
    /** A watching element inside a provider of `cfThemeContext`. */
    async function watchingInProvider() {
      const parent = document.createElement("div");
      const provider = new ContextProvider(parent, {
        context: cfThemeContext,
        initialValue: defaultTheme,
      });
      const element = new WatchingElement();
      parent.append(element);
      document.body.append(parent);
      await element.updateComplete;
      return { provider, element };
    }

    it("reports the enclosing provider's theme, and each new one", async () => {
      const { provider, element } = await watchingInProvider();
      const reported = element.changes;
      expect(reported).toBe(1);

      const next: CFTheme = mergeWithDefaultTheme({ accentColor: "teal" });
      provider.setValue(next);
      expect(element.changes).toBe(reported + 1);
    });

    it("reports a change of the user's theme preference while connected", async () => {
      const element = await mount(new WatchingElement());
      expect(element.changes).toBe(0);
      document.dispatchEvent(new Event("theme-preference-changed"));
      expect(element.changes).toBe(1);

      element.remove();
      document.dispatchEvent(new Event("theme-preference-changed"));
      expect(element.changes).toBe(1);
    });
  });
});
