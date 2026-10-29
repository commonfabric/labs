import { CFChevronButton } from "./cf-chevron-button.ts";

if (!customElements.get("cf-chevron-button")) {
  customElements.define("cf-chevron-button", CFChevronButton);
}

export type { CFChevronButton as CFChevronButtonElement } from "./cf-chevron-button.ts";

export { CFChevronButton };
