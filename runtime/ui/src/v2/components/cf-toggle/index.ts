import { CFToggle, ToggleSize, ToggleVariant } from "./cf-toggle.ts";

if (!customElements.get("cf-toggle")) {
  customElements.define("cf-toggle", CFToggle);
}

export type { CFToggle as CFToggleElement } from "./cf-toggle.ts";

export { CFToggle };
export type { ToggleSize, ToggleVariant };
