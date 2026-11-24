import { CFInput, InputType } from "./cf-input.ts";

if (!customElements.get("cf-input")) {
  customElements.define("cf-input", CFInput);
}

export type { CFInput as CFInputElement } from "./cf-input.ts";
export { INPUT_PATTERNS } from "./cf-input.ts";

export { CFInput };
export type { InputType };
