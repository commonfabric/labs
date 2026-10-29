import { CFSeparator, SeparatorOrientation } from "./cf-separator.ts";

if (!customElements.get("cf-separator")) {
  customElements.define("cf-separator", CFSeparator);
}

export type { CFSeparator as CFSeparatorElement } from "./cf-separator.ts";

export { CFSeparator };
export type { SeparatorOrientation };
