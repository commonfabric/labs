import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  getEffectiveTheme,
  getThemePreference,
  setThemePreference,
  type ThemePreference,
  toggleTheme,
} from "../src/lib/theme-preference.ts";
import { installGlobals } from "./browser-globals.ts";

const STORAGE_KEY = "cf-theme-preference";

/** A storage which refuses every access, as a browser's private mode may. */
const unavailableStorage = {
  getItem(): never {
    throw new DOMException("denied", "SecurityError");
  },
  setItem(): never {
    throw new DOMException("denied", "SecurityError");
  },
  removeItem(): never {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("theme-preference", () => {
  let restore: () => void;
  let stored: Map<string, string>;
  let attributes: Map<string, string>;
  let announced: (ThemePreference | undefined)[];
  let systemPrefersDark: boolean | undefined;

  // The module keeps the preference in `localStorage`, marks it on `<html>`,
  // announces it on `document`, and reads the system's preference from
  // `matchMedia()`; each is a stand-in the test sets up or reads back. A
  // `systemPrefersDark` left `undefined` installs no `matchMedia()` at all.
  beforeEach(() => {
    stored = new Map();
    attributes = new Map();
    announced = [];
    systemPrefersDark = undefined;
    const document = Object.assign(new EventTarget(), {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
    });
    document.addEventListener("theme-preference-changed", (event) => {
      if (event instanceof CustomEvent) announced.push(event.detail);
    });
    restore = installGlobals({
      document,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
  });

  afterEach(() => restore());

  /** Installs `matchMedia()`, reporting `systemPrefersDark` for dark mode. */
  function installMatchMedia(): () => void {
    return installGlobals({
      matchMedia: (query: string) => ({
        matches: query === "(prefers-color-scheme: dark)" && systemPrefersDark,
      }),
    });
  }

  describe("getThemePreference()", () => {
    it("returns the stored preference", () => {
      stored.set(STORAGE_KEY, "dark");
      expect(getThemePreference()).toBe("dark");

      stored.set(STORAGE_KEY, "light");
      expect(getThemePreference()).toBe("light");
    });

    it("returns `auto` with nothing stored", () => {
      expect(getThemePreference()).toBe("auto");
    });

    it("returns `auto` for a stored value that is not a theme", () => {
      stored.set(STORAGE_KEY, "sepia");
      expect(getThemePreference()).toBe("auto");
    });

    it("returns `auto` when storage is unavailable", () => {
      const restoreStorage = installGlobals({
        localStorage: unavailableStorage,
      });
      try {
        expect(getThemePreference()).toBe("auto");
      } finally {
        restoreStorage();
      }
    });
  });

  describe("getEffectiveTheme()", () => {
    it("returns the stored preference over the system's", () => {
      stored.set(STORAGE_KEY, "light");
      systemPrefersDark = true;
      const restoreMedia = installMatchMedia();
      try {
        expect(getEffectiveTheme()).toBe("light");
      } finally {
        restoreMedia();
      }
    });

    it("returns the system's preference with nothing stored", () => {
      const restoreMedia = installMatchMedia();
      try {
        systemPrefersDark = true;
        expect(getEffectiveTheme()).toBe("dark");

        systemPrefersDark = false;
        expect(getEffectiveTheme()).toBe("light");
      } finally {
        restoreMedia();
      }
    });

    it("returns `light` where the system's preference cannot be read", () => {
      expect(getEffectiveTheme()).toBe("light");
    });
  });

  describe("setThemePreference()", () => {
    it("stores a theme, marks it on the page, and announces it", () => {
      setThemePreference("dark");

      expect(stored.get(STORAGE_KEY)).toBe("dark");
      expect(attributes.get("data-theme")).toBe("dark");
      expect(announced).toEqual(["dark"]);
    });

    it("clears the stored theme and the page's mark for `auto`", () => {
      setThemePreference("light");

      setThemePreference("auto");

      expect(stored.has(STORAGE_KEY)).toBe(false);
      expect(attributes.has("data-theme")).toBe(false);
      expect(announced).toEqual(["light", "auto"]);
    });

    it("still marks and announces the theme when storage is unavailable", () => {
      const restoreStorage = installGlobals({
        localStorage: unavailableStorage,
      });
      try {
        setThemePreference("dark");
        expect(attributes.get("data-theme")).toBe("dark");

        setThemePreference("auto");
        expect(attributes.has("data-theme")).toBe(false);
      } finally {
        restoreStorage();
      }

      expect(announced).toEqual(["dark", "auto"]);
    });
  });

  describe("toggleTheme()", () => {
    it("switches a stored light theme to dark, and back", () => {
      stored.set(STORAGE_KEY, "light");

      expect(toggleTheme()).toBe("dark");
      expect(stored.get(STORAGE_KEY)).toBe("dark");

      expect(toggleTheme()).toBe("light");
      expect(stored.get(STORAGE_KEY)).toBe("light");
      expect(announced).toEqual(["dark", "light"]);
    });

    it("switches away from the system's theme when nothing is stored", () => {
      systemPrefersDark = true;
      const restoreMedia = installMatchMedia();
      try {
        expect(toggleTheme()).toBe("light");
      } finally {
        restoreMedia();
      }
      expect(attributes.get("data-theme")).toBe("light");
    });
  });
});
