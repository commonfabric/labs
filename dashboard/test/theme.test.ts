import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Window } from "happy-dom";
import {
  chartColorForLightTheme,
  DASHBOARD_THEME_CLIENT,
  DASHBOARD_THEME_HEAD,
  DASHBOARD_THEME_STYLES,
  dashboardThemeToggle,
  initializeDashboardTheme,
  LIGHT_THEME_COLORS,
  themedChartSeries,
} from "../theme.ts";
import { LIGHT_STATUS_TEXT, STATUS_COLOR } from "../palette.ts";

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string) => {
    const value = parseInt(color.slice(1), 16);
    const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
      .map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * channels[0] + 0.7152 * channels[1] +
      0.0722 * channels[2];
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("theme", () => {
  describe("DASHBOARD_THEME_STYLES", () => {
    it("defines explicit light and dark themes", () => {
      expect(DASHBOARD_THEME_STYLES).not.toContain(
        "@media(prefers-color-scheme:light)",
      );
      expect(DASHBOARD_THEME_STYLES).toContain(
        ':root[data-theme="light"]{color-scheme:light',
      );
      expect(DASHBOARD_THEME_STYLES).toContain(
        ':root[data-theme="dark"]{color-scheme:dark',
      );
    });

    it("defines every status and text color in both themes", () => {
      for (const status of ["good", "warn", "bad", "unknown"] as const) {
        expect(
          DASHBOARD_THEME_STYLES.match(
            new RegExp(`--status-${status}:${STATUS_COLOR[status]}`, "g"),
          )?.length,
        ).toBe(2);
        expect(
          DASHBOARD_THEME_STYLES.match(
            new RegExp(
              `--status-${status}:${LIGHT_STATUS_TEXT[status]}`,
              "g",
            ),
          )?.length,
        ).toBe(1);
        expect(
          DASHBOARD_THEME_STYLES.match(
            new RegExp(`--status-${status}-text:`, "g"),
          )?.length,
        ).toBe(3);
      }
    });

    it("aligns the theme control at the bottom-right of the document", () => {
      expect(DASHBOARD_THEME_STYLES).toContain(
        ".theme-toggle,.pill{display:flex;box-sizing:border-box;margin-top:16px;align-items:center;justify-content:center",
      );
      expect(DASHBOARD_THEME_STYLES).toContain(
        ".theme-toggle{width:88px;margin-left:auto}",
      );
      expect(DASHBOARD_THEME_STYLES).not.toContain("position:fixed");
    });

    it("keeps every light-theme text token readable on its surfaces", () => {
      const textColors = Object.entries(LIGHT_THEME_COLORS).filter(([name]) =>
        name.startsWith("text")
      );
      for (const [, color] of textColors) {
        expect(contrastRatio(color, LIGHT_THEME_COLORS.page))
          .toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(color, LIGHT_THEME_COLORS.surface))
          .toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe("themedChartSeries()", () => {
    it("darkens pale lines enough for small light-theme labels", () => {
      const pale = "#fabfd2";
      const light = chartColorForLightTheme(pale);
      expect(contrastRatio(light, LIGHT_THEME_COLORS.page))
        .toBeGreaterThanOrEqual(4.8);
      expect(themedChartSeries(pale).color).toBe(
        `light-dark(${light},${pale})`,
      );
    });

    it("keeps a line already readable on the light page as it is in both schemes", () => {
      const readable = LIGHT_THEME_COLORS.accent;
      expect(chartColorForLightTheme(readable)).toBe(readable);
      expect(themedChartSeries(readable).color).toBe(
        `light-dark(${readable},${readable})`,
      );
    });

    it("returns a color that is not a six-digit hex value unchanged, for the line and its highlight", () => {
      expect(chartColorForLightTheme("var(--chart-line)")).toBe(
        "var(--chart-line)",
      );
      expect(themedChartSeries("#abc")).toEqual({
        color: "#abc",
        highlightColor: "#abc",
      });
    });
  });

  describe("dashboardThemeToggle()", () => {
    it("returns a dark-mode button with separate icon and text targets", () => {
      const html = dashboardThemeToggle();
      expect(html).toContain(
        'data-theme-toggle aria-label="Theme: Dark. Switch to light mode"',
      );
      expect(html).toContain("data-theme-icon");
      expect(html).toContain("data-theme-label");
    });
  });

  describe("initializeDashboardTheme()", () => {
    // Each case runs against a happy-dom document and storage put in place of
    // the globals the function reads, and a system preference it can change.

    let window: Window;
    let announced: string[];
    const announce = (event: Event) => {
      if (event instanceof CustomEvent) announced.push(event.detail.theme);
    };
    const savedStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );

    class Preference extends EventTarget {
      matches = false;

      prefer(light: boolean): void {
        this.matches = light;
        this.dispatchEvent(new Event("change"));
      }
    }

    beforeEach(() => {
      window = new Window({ url: "http://localhost/" });
      window.document.body.innerHTML =
        "<button data-theme-toggle><span data-theme-icon></span><span data-theme-label></span></button>" +
        "<button data-theme-toggle><span data-theme-label></span></button>";
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: window.document,
      });
      useStorage(window.localStorage);
      announced = [];
      addEventListener("dashboardthemechange", announce);
    });

    afterEach(() => {
      removeEventListener("dashboardthemechange", announce);
      Reflect.deleteProperty(globalThis, "document");
      if (savedStorage) {
        Object.defineProperty(globalThis, "localStorage", savedStorage);
      }
      window.close();
    });

    function useStorage(storage: Pick<Storage, "getItem" | "setItem">): void {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: storage,
      });
    }

    function root(): HTMLElement {
      return document.documentElement;
    }

    function buttons(): { label: string | null; text: string | null }[] {
      return [...document.querySelectorAll("[data-theme-toggle]")].map(
        (button) => ({
          label: button.getAttribute("aria-label"),
          text: button.textContent,
        }),
      );
    }

    function click(): void {
      document.querySelector<HTMLElement>("[data-theme-toggle]")!.click();
    }

    it("starts dark, labels every switch, and announces nothing with nothing saved", () => {
      initializeDashboardTheme(new Preference());
      expect(root().dataset.theme).toBe("dark");
      expect(buttons()).toEqual([
        { label: "Theme: Dark. Switch to light mode", text: "☾Dark" },
        { label: "Theme: Dark. Switch to light mode", text: "Dark" },
      ]);
      expect(announced).toEqual([]);
    });

    it("cycles through dark, light, and system, saving and announcing each", () => {
      const preference = new Preference();
      initializeDashboardTheme(preference);

      click();
      expect(root().dataset.theme).toBe("light");
      expect(localStorage.getItem("fabricWallTheme")).toBe("light");
      expect(buttons()[0]).toEqual({
        label: "Theme: Light. Switch to system mode",
        text: "☀Light",
      });

      click();
      expect(root().dataset.theme).toBe("dark");
      expect(localStorage.getItem("fabricWallTheme")).toBe("system");
      expect(buttons()[0]).toEqual({
        label: "Theme: System. Switch to dark mode",
        text: "◐System",
      });

      click();
      expect(localStorage.getItem("fabricWallTheme")).toBe("dark");
      expect(buttons()[0].label).toBe("Theme: Dark. Switch to light mode");
      expect(announced).toEqual(["light", "dark", "dark"]);
    });

    it("follows the system preference in system mode and ignores it otherwise", () => {
      const preference = new Preference();
      localStorage.setItem("fabricWallTheme", "system");
      initializeDashboardTheme(preference);
      expect(root().dataset.theme).toBe("dark");

      preference.prefer(true);
      expect(root().dataset.theme).toBe("light");
      expect(announced).toEqual(["light"]);

      preference.prefer(false);
      expect(root().dataset.theme).toBe("dark");

      click();
      expect(root().dataset.theme).toBe("dark");
      preference.prefer(true);
      expect(root().dataset.theme).toBe("dark");
      expect(announced).toEqual(["light", "dark", "dark"]);
    });

    it("applies a saved light theme and ignores a saved value it does not know", () => {
      localStorage.setItem("fabricWallTheme", "light");
      initializeDashboardTheme(new Preference());
      expect(root().dataset.theme).toBe("light");
      expect(buttons()[0].text).toBe("☀Light");

      localStorage.setItem("fabricWallTheme", "sepia");
      initializeDashboardTheme(new Preference());
      expect(root().dataset.theme).toBe("dark");
    });

    it("uses the dark default when storage cannot be read, and switches when it cannot be written", () => {
      useStorage({
        getItem: () => {
          throw new Error("storage is disabled");
        },
        setItem: () => {
          throw new Error("storage is disabled");
        },
      });
      initializeDashboardTheme(new Preference());
      expect(root().dataset.theme).toBe("dark");

      click();
      expect(root().dataset.theme).toBe("light");
      expect(announced).toEqual(["light"]);
    });
  });

  describe("browser scripts", () => {
    it("defaults to dark and loads the saved theme before painting", () => {
      expect(DASHBOARD_THEME_HEAD).toContain(
        'document.documentElement.dataset.theme="dark"',
      );
      expect(DASHBOARD_THEME_HEAD).toContain(
        'localStorage.getItem("fabricWallTheme")',
      );
      expect(DASHBOARD_THEME_HEAD).toContain(
        't==="light"||t==="system"',
      );
      expect(DASHBOARD_THEME_HEAD).toContain(
        'matchMedia("(prefers-color-scheme: light)").matches',
      );
    });

    it("injects a stand-alone browser function", () => {
      expect(DASHBOARD_THEME_CLIENT).toContain(
        initializeDashboardTheme.toString(),
      );
      const source = DASHBOARD_THEME_CLIENT.match(
        /^<script>\((.*)\)\(\)<\/script>$/s,
      )?.[1];
      expect(source).toBeDefined();
      expect(() => new Function(`return (${source})`)).not.toThrow();
    });
  });
});
