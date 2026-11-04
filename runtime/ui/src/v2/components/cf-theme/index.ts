import { CFThemeProvider } from "./cf-theme.ts";

if (!customElements.get("cf-theme")) {
  customElements.define("cf-theme", CFThemeProvider);
}

export { CFThemeProvider };
export type { CFThemeProvider as CFThemeProviderElement } from "./cf-theme.ts";
export {
  subscribeToThemeCellValues,
  unwrapThemeCellValues,
} from "./cf-theme.ts";

export type { CFThemeProvider as CFThemeElement } from "./cf-theme.ts";
