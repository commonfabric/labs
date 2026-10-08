import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
