/**
 * Carries the dashboard's dark and light themes and everything that switches
 * between them: the color each theme binds every variable to, the styles that
 * bind them, the toggle in the page header, and the script that applies the
 * stored choice before the page paints. The status colors themselves are chosen
 * in palette.ts; what happens here is adapting them to a light page, where a
 * color picked to glow on a dark tile has to hold its contrast.
 */

import type { Status } from "./types.ts";
import { LIGHT_STATUS_TEXT, STATUS_COLOR, STATUS_TEXT } from "./palette.ts";

export type DashboardTheme = "dark" | "light";
export type DashboardThemeMode = DashboardTheme | "system";

const THEME_STORAGE_KEY = "fabricWallTheme";

const DARK_COLORS = {
  page: "#0d0e11",
  text: "#e7e9ee",
  "text-strong": "#ffffff",
  "text-secondary": "#c7ccd4",
  "text-muted": "#9aa0ab",
  "text-subtle": "#878d97",
  "text-faint": "#666c76",
  surface: "#16181d",
  "surface-deep": "#0c0d11",
  "surface-code": "#1b1e24",
  border: "#23262d",
  "border-strong": "#2f333c",
  "border-hover": "#3a4150",
  divider: "rgba(255,255,255,.09)",
  "icon-subtle": "rgba(255,255,255,.40)",
  accent: "#6ea8fe",
  "accent-contrast": "#0d0e11",
  running: "#6ea8fe",
  "chart-line": "#727882",
  "chart-highlight": "#c7ccd4",
} as const;

type ThemeColors = { [Key in keyof typeof DARK_COLORS]: string };

export const LIGHT_THEME_COLORS: ThemeColors = {
  page: "#f5f7fa",
  text: "#202630",
  "text-strong": "#10151c",
  "text-secondary": "#3f4a59",
  "text-muted": "#5f6b7a",
  "text-subtle": "#647080",
  "text-faint": "#666f7b",
  surface: "#ffffff",
  "surface-deep": "#eef2f6",
  "surface-code": "#e9edf2",
  border: "#d7dce3",
  "border-strong": "#bdc5d0",
  "border-hover": "#8e9bad",
  divider: "rgba(20,30,45,.12)",
  "icon-subtle": "rgba(25,35,48,.45)",
  accent: "#2667b8",
  "accent-contrast": "#ffffff",
  running: "#3979c9",
  "chart-line": "#6b7280",
  "chart-highlight": "#374151",
};

/** A transparent status color layer painted from the active theme. */
export function statusLayer(status: Status, alpha: number): string {
  const percent = Number((alpha * 100).toFixed(4));
  return `color-mix(in srgb,var(--status-${status}) ${
    percent
  }%,transparent)`;
}

const STATUSES: readonly Status[] = ["good", "warn", "bad", "unknown"];

function variables(
  colors: ThemeColors,
  statusText: Record<Status, string>,
  statusIndicator: Record<Status, string>,
): string {
  const neutral = Object.entries(colors).map(([name, value]) =>
    `--${name}:${value}`
  );
  const statuses = STATUSES.flatMap((status) => [
    `--status-${status}:${statusIndicator[status]}`,
    `--status-${status}-text:${statusText[status]}`,
  ]);
  return [...neutral, ...statuses].join(";");
}

const DARK_VARIABLES = variables(
  DARK_COLORS,
  STATUS_TEXT,
  STATUS_COLOR,
);
const LIGHT_VARIABLES = variables(
  LIGHT_THEME_COLORS,
  LIGHT_STATUS_TEXT,
  LIGHT_STATUS_TEXT,
);

function colorChannels(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function colorHex(channels: readonly number[]): string {
  return `#${
    channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")
  }`;
}

function mixColor(color: string, target: string, amount: number): string {
  const source = colorChannels(color);
  const destination = colorChannels(target);
  return colorHex(
    source.map((channel, index) =>
      channel + (destination[index] - channel) * amount
    ),
  );
}

function luminance(color: string): number {
  const channels = colorChannels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] +
    0.0722 * channels[2];
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

/** Darken a chart color until small labels remain readable in light mode. */
export function chartColorForLightTheme(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (contrast(color, LIGHT_THEME_COLORS.page) >= 4.8) return color;
  let lower = 0;
  let upper = 1;
  for (let step = 0; step < 12; step++) {
    const amount = (lower + upper) / 2;
    if (
      contrast(mixColor(color, "#000000", amount), LIGHT_THEME_COLORS.page) >=
        4.8
    ) {
      upper = amount;
    } else {
      lower = amount;
    }
  }
  return mixColor(color, "#000000", upper);
}

/** A chart line and its emphasized recent segment in both color schemes. */
export function themedChartSeries(color: string): {
  color: string;
  highlightColor: string;
} {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    return { color, highlightColor: color };
  }
  const light = chartColorForLightTheme(color);
  const lightHighlight = mixColor(light, "#000000", 0.2);
  const darkHighlight = mixColor(color, "#ffffff", 0.6);
  return {
    color: `light-dark(${light},${color})`,
    highlightColor: `light-dark(${lightHighlight},${darkHighlight})`,
  };
}

export const DASHBOARD_THEME_HEAD =
  `<meta name="color-scheme" content="dark light"><script>` +
  `document.documentElement.dataset.theme="dark";` +
  `try{const t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(t==="light"||t==="system")document.documentElement.dataset.theme=` +
  `t==="light"||matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}catch{}` +
  `</script>`;

export const DASHBOARD_THEME_STYLES = `
  :root{color-scheme:dark;${DARK_VARIABLES}}
  :root[data-theme="dark"]{color-scheme:dark;${DARK_VARIABLES}}
  :root[data-theme="light"]{color-scheme:light;${LIGHT_VARIABLES}}
  .theme-toggle{display:flex;width:88px;box-sizing:border-box;margin:16px 0 0 auto;align-items:center;justify-content:center;gap:6px;background:var(--surface);color:var(--text-secondary);border:1px solid var(--border-strong);border-radius:999px;padding:6px 11px;font:inherit;font-size:11px;line-height:1.2;cursor:pointer;white-space:nowrap}
  .theme-toggle:hover{border-color:var(--border-hover);color:var(--text-strong)}
  .theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .theme-toggle [data-theme-icon]{font-size:13px;line-height:1}`;

export const dashboardThemeToggle = (): string =>
  `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Theme: Dark. Switch to light mode" title="Theme: Dark. Switch to light mode"><span data-theme-icon aria-hidden="true">☾</span><span data-theme-label>Dark</span></button>`;

/** Connect every theme switch on the page to the saved dashboard theme. */
export function initializeDashboardTheme(
  preference = matchMedia("(prefers-color-scheme: light)"),
): void {
  const storageKey = "fabricWallTheme";
  const root = document.documentElement;
  const modes: DashboardThemeMode[] = ["dark", "light", "system"];
  let mode: DashboardThemeMode = "dark";
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "dark" || saved === "light" || saved === "system") {
      mode = saved;
    }
  } catch {
    // A storage failure uses the dark default.
  }
  const resolved = (): DashboardTheme =>
    mode === "system" ? (preference.matches ? "light" : "dark") : mode;
  const apply = (): void => {
    root.dataset.theme = resolved();
  };
  const paint = (): void => {
    const next = modes[(modes.indexOf(mode) + 1) % modes.length];
    const label = mode[0].toUpperCase() + mode.slice(1);
    const icons: Record<DashboardThemeMode, string> = {
      dark: "☾",
      light: "☀",
      system: "◐",
    };
    for (
      const button of document.querySelectorAll<HTMLButtonElement>(
        "[data-theme-toggle]",
      )
    ) {
      const labelTarget = button.querySelector<HTMLElement>(
        "[data-theme-label]",
      );
      const icon = button.querySelector<HTMLElement>("[data-theme-icon]");
      if (labelTarget) labelTarget.textContent = label;
      if (icon) icon.textContent = icons[mode];
      button.ariaLabel = `Theme: ${label}. Switch to ${next} mode`;
      button.title = `Theme: ${label}. Switch to ${next} mode`;
    }
  };
  const announce = (): void => {
    apply();
    paint();
    dispatchEvent(
      new CustomEvent("dashboardthemechange", {
        detail: { theme: resolved() },
      }),
    );
  };
  for (
    const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-theme-toggle]",
    )
  ) {
    button.addEventListener("click", () => {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length];
      try {
        localStorage.setItem(storageKey, mode);
      } catch {
        // A storage failure leaves the document theme in place.
      }
      announce();
    });
  }
  preference.addEventListener("change", () => {
    if (mode === "system") announce();
  });
  apply();
  paint();
}

export const DASHBOARD_THEME_CLIENT =
  `<script>(${initializeDashboardTheme.toString()})()</script>`;

export const CHART_LINE = "var(--chart-line)";
export const CHART_HIGHLIGHT = "var(--chart-highlight)";
