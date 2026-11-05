import { CFPicker } from "./cf-picker.ts";

if (!customElements.get("cf-picker")) {
  customElements.define("cf-picker", CFPicker);
}

export type { CFPicker as CFPickerElement } from "./cf-picker.ts";

export { CFPicker } from "./cf-picker.ts";
