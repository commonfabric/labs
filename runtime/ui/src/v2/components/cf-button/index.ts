import type { ColorIntent } from "../theme-context.ts";
import { ButtonSize, ButtonVariant, CFButton } from "./cf-button.ts";

if (!customElements.get("cf-button")) {
  customElements.define("cf-button", CFButton);
}

export type { CFButton as CFButtonElement } from "./cf-button.ts";

export { CFButton };
export type { ButtonSize, ButtonVariant, ColorIntent };
