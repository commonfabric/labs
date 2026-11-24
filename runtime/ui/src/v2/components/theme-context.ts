import { ContextConsumer, createContext } from "@lit/context";
import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Color scheme for dynamic theming (SwiftUI-style)
 */
export type ColorScheme = "light" | "dark" | "auto";

/**
 * Semantic color token that can be a concrete value or reference
 */
export type ColorToken = string | {
  light: string;
  dark: string;
};

/**
 * Standard component size tokens (Figma coordinated sizing scale)
 */
export type ComponentSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Color intent for interactive components (buttons, chips, badges). */
export type ColorIntent = "neutral" | "primary" | "accent" | "danger";

/** Status intent for feedback components (toasts, alerts). */
export type StatusIntent = "info" | "success" | "warning" | "error";

/**
 * Comprehensive theme configuration for CF components
 */
export interface CFTheme {
  /** Font family for text content */
  fontFamily: string;

  /** Monospace font family for code */
  monoFontFamily: string;

  /** Base font size for UI elements */
  fontSize: string;

  /** Border radius for UI elements */
  borderRadius: string;

  /** Overall density/spacing preference */
  density: "compact" | "comfortable" | "spacious";

  /** Color scheme preference */
  colorScheme: ColorScheme;

  /** Animation speed preference */
  animationSpeed: "none" | "slow" | "normal" | "fast";

  /** Roundness scalar (0-1). Scales all structural radii. */
  roundness: number;

  /** Typography scale factor (0.8-1.2). */
  scale: number;

  /** Motion scalar (0-1). Scales transition durations. 0 = instant. */
  motion: number;

  /** Color palette with semantic tokens that adapt to light/dark */
  colors: {
    /** Primary brand color */
    primary: ColorToken;

    /** Primary foreground (text on primary) */
    primaryForeground: ColorToken;

    /** Secondary color */
    secondary: ColorToken;

    /** Secondary foreground */
    secondaryForeground: ColorToken;

    /** Main background color */
    background: ColorToken;

    /** Surface color (cards, containers) */
    surface: ColorToken;

    /** Surface hover state */
    surfaceHover: ColorToken;

    /** Primary text color */
    text: ColorToken;

    /** Muted/secondary text color */
    textMuted: ColorToken;

    /** Border color */
    border: ColorToken;

    /** Muted border color */
    borderMuted: ColorToken;

    /** Success color */
    success: ColorToken;

    /** Success foreground */
    successForeground: ColorToken;

    /** Error color */
    error: ColorToken;

    /** Error foreground */
    errorForeground: ColorToken;

    /** Warning color */
    warning: ColorToken;

    /** Warning foreground */
    warningForeground: ColorToken;

    /** Accent color for highlights */
    accent: ColorToken;

    /** Accent foreground */
    accentForeground: ColorToken;

    /** Brand color (purple) */
    brand: ColorToken;

    /** Brand foreground (text on brand) */
    brandForeground: ColorToken;

    /** Tertiary text color */
    textTertiary: ColorToken;

    /** Disabled text color */
    textDisabled: ColorToken;

    /** Disabled surface color */
    surfaceDisabled: ColorToken;

    /** Surface pressed state */
    surfacePressed: ColorToken;

    /** Tertiary surface color */
    surfaceTertiary: ColorToken;

    /** Inverse surface color */
    surfaceInverse: ColorToken;

    /** Secondary text on colored backgrounds */
    textOnColorSecondary: ColorToken;

    /** Text on inverse surfaces */
    textOnInverse: ColorToken;

    /** Pressed text color */
    textPressed: ColorToken;
  };
}

/**
 * Density scaling factors for different spacing contexts
 */
const DENSITY_SCALES = {
  compact: { tight: 0.75, normal: 0.85, loose: 1.0 },
  comfortable: { tight: 1.0, normal: 1.15, loose: 1.3 },
  spacious: { tight: 1.25, normal: 1.5, loose: 1.75 },
} as const;

/**
 * Base spacing values in rem that get scaled by density
 */
const BASE_SPACING = {
  xs: 0.125, // 2px at 16px base
  sm: 0.25, // 4px
  md: 0.5, // 8px
  lg: 0.75, // 12px
  xl: 1.0, // 16px
  xxl: 1.5, // 24px
} as const;

/**
 * Detect the current color scheme preference
 * @param scheme - Theme color scheme setting
 * @returns Resolved color scheme ("light" or "dark")
 */
export function resolveColorScheme(scheme: ColorScheme): "light" | "dark" {
  if (scheme === "auto") {
    // Check for explicit user override via data-theme attribute on <html>
    if (typeof document !== "undefined") {
      const dataTheme = document.documentElement.getAttribute("data-theme");
      if (dataTheme === "light" || dataTheme === "dark") return dataTheme;
    }
    // Fall back to system preference
    if (typeof globalThis !== "undefined" && globalThis.matchMedia) {
      return globalThis.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light"; // Fallback for non-browser environments
  }
  return scheme;
}

/**
 * Resolve a color token to a concrete color value
 * @param token - Color token (string or light/dark object)
 * @param colorScheme - Current color scheme
 * @returns Resolved color string
 */
export function resolveColor(
  token: ColorToken,
  colorScheme: "light" | "dark",
): string {
  if (typeof token === "string") {
    return token;
  }
  return token[colorScheme];
}

/**
 * Get semantic spacing value for a component context
 * @param density - Theme density setting
 * @param size - Base size (xs, sm, md, lg, xl, xxl)
 * @param context - Spacing context (tight, normal, loose)
 * @returns CSS custom property with fallback
 */
export function getSemanticSpacing(
  density: CFTheme["density"],
  size: keyof typeof BASE_SPACING,
  context: "tight" | "normal" | "loose" = "normal",
): string {
  const scale = DENSITY_SCALES[density][context];
  const baseValue = BASE_SPACING[size];
  const scaledValue = baseValue * scale;

  // Map to the closest spacing level for compatibility
  const spacingLevel = Math.min(4, Math.round(scaledValue * 4));
  const fallback = `${scaledValue}rem`;

  return `var(--cf-spacing-${spacingLevel}, ${fallback})`;
}

/**
 * Derive interaction state variants from a base color.
 */
function deriveColorFamily(base: string): {
  default: string;
  pressed: string;
  soft: string;
  subtle: string;
} {
  return {
    default: base,
    pressed: `color-mix(in srgb, ${base} 85%, black)`,
    soft: `color-mix(in srgb, ${base} 20%, transparent)`,
    subtle: `color-mix(in srgb, ${base} 10%, transparent)`,
  };
}

/**
 * Default theme values with SwiftUI-style adaptive colors
 */
export const defaultTheme: CFTheme = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  monoFontFamily:
    "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  fontSize: "1rem",
  borderRadius: "0.5rem",
  density: "comfortable",
  colorScheme: "auto",
  animationSpeed: "normal",
  roundness: 1,
  scale: 1,
  motion: 1,
  colors: {
    primary: {
      light: "#4979fa",
      dark: "#6b93ff",
    },
    primaryForeground: {
      light: "#ffffff",
      dark: "#16181d",
    },
    secondary: {
      light: "#f2f3f6",
      dark: "#2a2d33",
    },
    secondaryForeground: {
      light: "#34373c",
      dark: "#e4e6ea",
    },
    background: {
      light: "#f2f3f6",
      dark: "#16181d",
    },
    surface: {
      light: "#ffffff",
      dark: "#1e2127",
    },
    surfaceHover: {
      light: "#f9fafb",
      dark: "#2a2d33",
    },
    text: {
      light: "#34373c",
      dark: "#e4e6ea",
    },
    textMuted: {
      light: "#71747a",
      dark: "#94979e",
    },
    border: {
      light: "rgba(79, 89, 103, 0.15)",
      dark: "rgba(200, 210, 220, 0.15)",
    },
    borderMuted: {
      light: "rgba(46, 53, 64, 0.06)",
      dark: "rgba(200, 210, 220, 0.06)",
    },
    success: {
      light: "#21c17b",
      dark: "#34d399",
    },
    successForeground: {
      light: "#ffffff",
      dark: "#064e3b",
    },
    error: {
      light: "#ff6057",
      dark: "#ff8a72",
    },
    errorForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
    warning: {
      light: "#e5a126",
      dark: "#f0b944",
    },
    warningForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
    accent: {
      light: "#fc856d",
      dark: "#ff9a87",
    },
    accentForeground: {
      light: "#ffffff",
      dark: "#451a03",
    },
    brand: {
      light: "#8952fd",
      dark: "#a77dfe",
    },
    brandForeground: {
      light: "#ffffff",
      dark: "#1a0e3b",
    },
    textTertiary: {
      light: "#b3b6bc",
      dark: "#5b5f65",
    },
    textDisabled: {
      light: "rgba(0, 0, 0, 0.3)",
      dark: "rgba(255, 255, 255, 0.3)",
    },
    surfaceDisabled: {
      light: "#e4e6ea",
      dark: "#2a2d33",
    },
    surfacePressed: {
      light: "rgba(54, 63, 74, 0.1)",
      dark: "rgba(200, 210, 220, 0.1)",
    },
    surfaceTertiary: {
      light: "#e4e6ea",
      dark: "#34373c",
    },
    surfaceInverse: {
      light: "#16181d",
      dark: "#ffffff",
    },
    textOnColorSecondary: {
      light: "rgba(255, 255, 255, 0.6)",
      dark: "rgba(255, 255, 255, 0.6)",
    },
    textOnInverse: {
      light: "#ffffff",
      dark: "#16181d",
    },
    textPressed: {
      light: "#16181d",
      dark: "#ffffff",
    },
  },
};

/**
 * Merge a partial theme with the default theme, supporting pattern-style partial objects
 * @param partialTheme - Partial theme object that may contain pattern-style properties
 * @param baseTheme - Base theme to merge with (defaults to defaultTheme)
 * @returns Full CFTheme with merged properties
 */
export function mergeWithDefaultTheme(
  partialTheme: any,
  baseTheme: CFTheme = defaultTheme,
): CFTheme {
  if (!partialTheme || typeof partialTheme !== "object") {
    return baseTheme;
  }

  // Handle pattern-style theme objects with specific properties
  const mergedTheme = { ...baseTheme };

  // Map common pattern theme properties to CFTheme properties
  if (partialTheme.accentColor) {
    mergedTheme.colors = {
      ...mergedTheme.colors,
      primary: partialTheme.accentColor,
      accent: partialTheme.accentColor,
    };
  }

  if (partialTheme.fontFace) {
    mergedTheme.fontFamily = partialTheme.fontFace;
  }

  if (partialTheme.borderRadius) {
    mergedTheme.borderRadius = partialTheme.borderRadius;
  }

  // Also handle direct CFTheme properties
  if (partialTheme.fontFamily) {
    mergedTheme.fontFamily = partialTheme.fontFamily;
  }

  if (partialTheme.monoFontFamily) {
    mergedTheme.monoFontFamily = partialTheme.monoFontFamily;
  }

  if (partialTheme.fontSize) {
    mergedTheme.fontSize = partialTheme.fontSize;
  }

  if (partialTheme.density) {
    mergedTheme.density = partialTheme.density;
  }

  if (partialTheme.colorScheme) {
    mergedTheme.colorScheme = partialTheme.colorScheme;
  }

  if (partialTheme.animationSpeed) {
    mergedTheme.animationSpeed = partialTheme.animationSpeed;
  }

  if (partialTheme.roundness !== undefined) {
    mergedTheme.roundness = partialTheme.roundness;
  }
  if (partialTheme.scale !== undefined) mergedTheme.scale = partialTheme.scale;
  if (partialTheme.motion !== undefined) {
    mergedTheme.motion = partialTheme.motion;
  }

  if (partialTheme.colors) {
    mergedTheme.colors = {
      ...mergedTheme.colors,
      ...partialTheme.colors,
    };
  }

  return mergedTheme;
}

/**
 * Get CSS animation duration based on theme animation speed
 * @param speed - Theme animation speed setting
 * @returns CSS duration value
 */
export function getAnimationDuration(speed: CFTheme["animationSpeed"]): string {
  switch (speed) {
    case "none":
      return "0ms";
    case "slow":
      return "500ms";
    case "normal":
      return "200ms";
    case "fast":
      return "100ms";
    default:
      return "200ms";
  }
}

/**
 * The style properties that carry `theme`, by name: the `--cf-theme-*` tokens
 * and `font-family`.
 * @param theme - Theme configuration
 */
export function themeProperties(theme: CFTheme): Record<string, string> {
  const properties: Record<string, string> = {};
  const set = (name: string, value: string) => {
    properties[name] = value;
  };

  /*
   * Canonical theme contract:
   * - Semantic colors are emitted as `--cf-theme-color-*`.
   * - Typography is emitted as `--cf-theme-font-*` plus border radius and animation duration.
   * - Spacing is emitted as `--cf-theme-spacing-*`.
   *
   * Colors are additionally emitted under their legacy `--cf-theme-*` names,
   * which `docs/common/patterns/style.md` lists for pattern authors. New code
   * should prefer the canonical namespaces above.
   */
  const colorScheme = resolveColorScheme(theme.colorScheme);

  // Typography and base properties
  set("--cf-theme-font-family", theme.fontFamily);
  set("font-family", theme.fontFamily);
  set(
    "--cf-theme-mono-font-family",
    theme.monoFontFamily,
  );
  set("--cf-theme-font-mono", theme.monoFontFamily);
  const effectiveBorderRadius = theme.borderRadius !== defaultTheme.borderRadius
    ? theme.borderRadius
    : `${theme.roundness * 0.5}rem`;
  set(
    "--cf-theme-border-radius",
    effectiveBorderRadius,
  );
  set(
    "--cf-theme-border-radius-full",
    "var(--cf-border-radius-full, 9999px)",
  );
  const effectiveFontSize = theme.fontSize !== defaultTheme.fontSize
    ? theme.fontSize
    : `${theme.scale}rem`;
  set("--cf-theme-font-size", effectiveFontSize);
  const effectiveDuration = theme.animationSpeed !== "normal"
    ? getAnimationDuration(theme.animationSpeed)
    : `${Math.round(200 * theme.motion)}ms`;
  set(
    "--cf-theme-animation-duration",
    effectiveDuration,
  );

  // Colors - resolve all ColorTokens
  const colorMap = {
    "primary": theme.colors.primary,
    "primary-foreground": theme.colors.primaryForeground,
    "secondary": theme.colors.secondary,
    "secondary-foreground": theme.colors.secondaryForeground,
    "background": theme.colors.background,
    "surface": theme.colors.surface,
    "surface-hover": theme.colors.surfaceHover,
    "text": theme.colors.text,
    "text-muted": theme.colors.textMuted,
    "border": theme.colors.border,
    "border-muted": theme.colors.borderMuted,
    "success": theme.colors.success,
    "success-foreground": theme.colors.successForeground,
    "error": theme.colors.error,
    "error-foreground": theme.colors.errorForeground,
    "warning": theme.colors.warning,
    "warning-foreground": theme.colors.warningForeground,
    "accent": theme.colors.accent,
    "accent-foreground": theme.colors.accentForeground,
    "brand": theme.colors.brand,
    "brand-foreground": theme.colors.brandForeground,
    "text-tertiary": theme.colors.textTertiary,
    "text-disabled": theme.colors.textDisabled,
    "surface-disabled": theme.colors.surfaceDisabled,
    "surface-pressed": theme.colors.surfacePressed,
    "surface-tertiary": theme.colors.surfaceTertiary,
    "surface-inverse": theme.colors.surfaceInverse,
    "text-on-color-secondary": theme.colors.textOnColorSecondary,
    "text-on-inverse": theme.colors.textOnInverse,
    "text-pressed": theme.colors.textPressed,
  };

  Object.entries(colorMap).forEach(([key, token]) => {
    set(
      `--cf-theme-color-${key}`,
      resolveColor(token, colorScheme),
    );
  });

  const legacyColorAliases = {
    "background": resolveColor(theme.colors.background, colorScheme),
    "border": resolveColor(theme.colors.border, colorScheme),
    "border-muted": resolveColor(theme.colors.borderMuted, colorScheme),
    "error": resolveColor(theme.colors.error, colorScheme),
    "primary": resolveColor(theme.colors.primary, colorScheme),
    "success": resolveColor(theme.colors.success, colorScheme),
    "surface": resolveColor(theme.colors.surface, colorScheme),
    "surface-hover": resolveColor(theme.colors.surfaceHover, colorScheme),
    "text": resolveColor(theme.colors.text, colorScheme),
    "text-muted": resolveColor(theme.colors.textMuted, colorScheme),
  };

  Object.entries(legacyColorAliases).forEach(([key, value]) => {
    set(`--cf-theme-${key}`, value);
  });

  set(
    "--cf-theme-color-error-surface",
    `color-mix(in srgb, ${resolveColor(theme.colors.error, colorScheme)} 12%, ${
      resolveColor(theme.colors.surface, colorScheme)
    })`,
  );
  set(
    "--cf-theme-color-error-light",
    `color-mix(in srgb, ${resolveColor(theme.colors.error, colorScheme)} 18%, ${
      resolveColor(theme.colors.surface, colorScheme)
    })`,
  );
  set(
    "--cf-theme-color-primary-light",
    `color-mix(in srgb, ${
      resolveColor(theme.colors.primary, colorScheme)
    } 18%, ${resolveColor(theme.colors.surface, colorScheme)})`,
  );
  set(
    "--cf-theme-color-success-light",
    `color-mix(in srgb, ${
      resolveColor(theme.colors.success, colorScheme)
    } 18%, ${resolveColor(theme.colors.surface, colorScheme)})`,
  );
  set(
    "--cf-theme-color-muted",
    resolveColor(theme.colors.surfaceTertiary, colorScheme),
  );
  set(
    "--cf-theme-color-text-secondary",
    resolveColor(theme.colors.textMuted, colorScheme),
  );

  // Derived color families for ColorIntent
  const intentMap: Array<{ name: string; base: ColorToken }> = [
    { name: "primary", base: theme.colors.primary },
    { name: "accent", base: theme.colors.accent },
    { name: "danger", base: theme.colors.error },
  ];
  for (const { name, base: token } of intentMap) {
    const base = resolveColor(token, colorScheme);
    const family = deriveColorFamily(base);
    set(
      `--cf-theme-color-${name}-pressed`,
      family.pressed,
    );
    set(`--cf-theme-color-${name}-soft`, family.soft);
    set(
      `--cf-theme-color-${name}-subtle`,
      family.subtle,
    );
  }

  // Derived color families for StatusIntent
  const statusEntries: Array<
    { name: string; base: ColorToken; fg: ColorToken }
  > = [
    {
      name: "info",
      base: theme.colors.primary,
      fg: theme.colors.primaryForeground,
    },
    {
      name: "success",
      base: theme.colors.success,
      fg: theme.colors.successForeground,
    },
    {
      name: "warning",
      base: theme.colors.warning,
      fg: theme.colors.warningForeground,
    },
    {
      name: "error",
      base: theme.colors.error,
      fg: theme.colors.errorForeground,
    },
  ];
  for (const { name, base: baseToken, fg: fgToken } of statusEntries) {
    const base = resolveColor(baseToken, colorScheme);
    const family = deriveColorFamily(base);
    set(`--cf-theme-color-status-${name}`, base);
    set(
      `--cf-theme-color-status-${name}-pressed`,
      family.pressed,
    );
    set(
      `--cf-theme-color-status-${name}-soft`,
      family.soft,
    );
    set(
      `--cf-theme-color-status-${name}-subtle`,
      family.subtle,
    );
    set(
      `--cf-theme-color-status-${name}-foreground`,
      resolveColor(fgToken, colorScheme),
    );
  }

  // Semantic spacing
  const spacingMap = {
    "tight": getSemanticSpacing(theme.density, "xs", "tight"),
    "normal": getSemanticSpacing(theme.density, "sm", "normal"),
    "loose": getSemanticSpacing(theme.density, "md", "loose"),
    "padding-message": getSemanticSpacing(theme.density, "lg", "normal"),
    "padding-code": getSemanticSpacing(theme.density, "sm", "tight"),
    "padding-block": getSemanticSpacing(theme.density, "md", "normal"),
  };

  Object.entries(spacingMap).forEach(([key, value]) => {
    set(`--cf-theme-spacing-${key}`, value);
  });

  set("--cf-theme-spacing", spacingMap.normal);
  set("--cf-theme-spacing-compact", spacingMap.tight);
  set("--cf-theme-padding", spacingMap.normal);

  return properties;
}

let propertyNames: readonly string[] | undefined;

/**
 * The name of every style property `themeProperties` returns, which is the
 * same set for every theme: the `--cf-theme-*` tokens and `font-family`.
 */
export function themePropertyNames(): readonly string[] {
  propertyNames ??= Object.keys(themeProperties(defaultTheme));
  return propertyNames;
}

/**
 * What an element's own style held for each theme property before
 * `applyThemeToElement` wrote it, so that taking the theme back off restores
 * what the element's author set rather than clearing it.
 */
const authored = new WeakMap<HTMLElement, Map<string, string>>();

/**
 * Write `theme` onto `element`'s own style, where it overrides the theme the
 * element would otherwise inherit, for the element and everything inside it.
 * Passing `undefined` takes back what this function wrote, so the element
 * inherits again; a style the element's author set is left, or put back.
 * @param element - Element to apply theme properties to
 * @param theme - Theme configuration, or `undefined` to inherit
 * @param inherited - The theme an enclosing `cf-theme` already puts in effect
 *   around `element`. Only the properties `theme` changes are written; the
 *   rest are left to inherit, so a later change to the enclosing theme reaches
 *   them.
 */
export function applyThemeToElement(
  element: HTMLElement,
  theme: CFTheme | undefined,
  inherited?: CFTheme,
) {
  const properties = theme ? themeProperties(theme) : {};
  const around = inherited ? themeProperties(inherited) : {};
  const wrote = authored.get(element) ?? new Map<string, string>();
  for (const name of themePropertyNames()) {
    const value = properties[name];
    if (value !== undefined && value !== around[name]) {
      if (!wrote.has(name)) {
        wrote.set(name, element.style.getPropertyValue(name));
      }
      element.style.setProperty(name, value);
    } else if (wrote.has(name)) {
      const before = wrote.get(name)!;
      if (before) element.style.setProperty(name, before);
      else element.style.removeProperty(name);
      wrote.delete(name);
    }
  }
  if (wrote.size) authored.set(element, wrote);
  else authored.delete(element);
}

/**
 * The value of the custom property `name` in effect around `element`, which is
 * what the element would inherit, or `""` when nothing sets it. A host that
 * themes by CSS alone is visible only this way.
 */
export function tokenAround(element: Element, name: string): string {
  const root = element.getRootNode();
  const parent = element.parentElement ??
    (root instanceof ShadowRoot ? root.host : null);
  return parent
    ? globalThis.getComputedStyle(parent).getPropertyValue(name).trim()
    : "";
}

/**
 * Copy the theme in effect at `from`, resolved, onto `to`: for an element
 * mounted outside `from`'s subtree, such as an overlay on the document body,
 * which inheritance cannot reach.
 */
export function copyThemeProperties(from: Element, to: HTMLElement) {
  const computed = globalThis.getComputedStyle(from);
  for (const name of themePropertyNames()) {
    const value = computed.getPropertyValue(name).trim();
    if (value) to.style.setProperty(name, value);
    else to.style.removeProperty(name);
  }
}

/**
 * Calls `onChange` when the theme in effect around `host` may have changed:
 * the enclosing `cf-theme` provides a new theme, or the user's theme
 * preference changes. An element that copies the theme onto an overlay
 * outside its subtree uses it to copy again.
 */
export class AmbientThemeWatch implements ReactiveController {
  #onChange: () => void;
  #onPreference = () => this.#onChange();

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    onChange: () => void,
  ) {
    this.#onChange = onChange;
    host.addController(this);
    new ContextConsumer(host, {
      context: cfThemeContext,
      subscribe: true,
      callback: () => this.#onChange(),
    });
  }

  hostConnected() {
    document.addEventListener("theme-preference-changed", this.#onPreference);
  }

  hostDisconnected() {
    document.removeEventListener(
      "theme-preference-changed",
      this.#onPreference,
    );
  }
}

/**
 * Context for sharing theme across Common Fabric components.
 *
 * The theme reaches components as inherited CSS custom properties, which
 * `cf-theme` or a host page sets on an ancestor. Components read
 * `var(--cf-theme-*)` in CSS with sane fallbacks, and write tokens on their
 * own host only for a theme given to them directly, since a token written on a
 * component's host hides the one it inherits.
 * An element mounted outside the subtree, such as an overlay on the document
 * body, takes the tokens in effect through `copyThemeProperties()`.
 *
 * Only consume `cfThemeContext` when the JavaScript theme object is actually
 * needed for runtime logic or derived values.
 */
export const cfThemeContext = createContext<CFTheme>("cf-theme");
