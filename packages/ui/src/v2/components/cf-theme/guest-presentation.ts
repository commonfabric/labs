/**
 * The presentation `cf-theme` provides to the iframe guests beneath it: the
 * `--cf-theme-*` custom properties computed on the theme element, declared on
 * the guest's `:root` ahead of the guest base sheet, with the resolved color
 * scheme as a root attribute. The guest receives values, not a theme object,
 * so a host that overrides the element's tokens by CSS is what the guest sees.
 */

import { debugStr } from "@commonfabric/data-model";
import type { IframePresentation } from "@commonfabric/iframe-sandbox";

import { themePropertyNames } from "../theme-context.ts";
import { GUEST_BASE_SHEET } from "./guest-base-sheet.ts";

/** A custom property's name and its value. */
export type ThemeValue = readonly [name: string, value: string];

const THEME_PREFIX = "--cf-theme-";

let variableNames: readonly string[] | undefined;

/**
 * Returns the names of every `--cf-theme-*` property the theme element emits,
 * taken from `themePropertyNames()` rather than from a list kept beside it.
 */
export function themeVariableNames(): readonly string[] {
  variableNames ??= themePropertyNames().filter((name) =>
    name.startsWith(THEME_PREFIX)
  );
  return variableNames;
}

/**
 * Returns the `--cf-theme-*` values computed on `element`, omitting the names
 * nothing sets there.
 */
export function computedThemeValues(element: Element): ThemeValue[] {
  const computed = globalThis.getComputedStyle(element);
  return themeVariableNames().flatMap((name): ThemeValue[] => {
    const value = computed.getPropertyValue(name).trim();
    return value ? [[name, value]] : [];
  });
}

/**
 * Returns the guest's theme stylesheet: `values` declared on `:root`, then the
 * guest base sheet.
 *
 * @throws When a name is outside the `--cf-theme-` namespace or a value is
 *   empty.
 */
export function guestThemeCss(values: readonly ThemeValue[]): string {
  for (const [name, value] of values) {
    if (!name.startsWith(THEME_PREFIX)) {
      throw new Error(debugStr`Not a \`--cf-theme-*\` property: $quote${name}`);
    }
    if (!value) {
      throw new Error(debugStr`An empty value for $quote${name}`);
    }
  }
  if (values.length === 0) return GUEST_BASE_SHEET;
  const declarations = values.map(([name, value]) => `  ${name}: ${value};\n`)
    .join("");
  return `:root {\n${declarations}}\n${GUEST_BASE_SHEET}`;
}

/**
 * Returns the presentation for a guest themed with `values`, whose root
 * carries `colorScheme` as `data-color-scheme`.
 */
export function guestPresentation(
  values: readonly ThemeValue[],
  colorScheme: "light" | "dark",
): IframePresentation {
  return {
    css: guestThemeCss(values),
    attributes: { "data-color-scheme": colorScheme },
    stylesheets: [],
  };
}

/** Whether two guest presentations would style a guest alike. */
export function sameGuestPresentation(
  a: IframePresentation,
  b: IframePresentation,
): boolean {
  return a.css === b.css &&
    a.attributes["data-color-scheme"] === b.attributes["data-color-scheme"];
}
