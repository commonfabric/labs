import { CFCheckbox } from "./cf-checkbox.ts";

if (!customElements.get("cf-checkbox")) {
  customElements.define("cf-checkbox", CFCheckbox);
}

export type { CFCheckbox as CFCheckboxElement } from "./cf-checkbox.ts";

export { CFCheckbox };
