import { CFSubmitInput } from "./cf-submit-input.ts";

if (!customElements.get("cf-submit-input")) {
  customElements.define("cf-submit-input", CFSubmitInput);
}

export type { CFSubmitInput as CFSubmitInputElement } from "./cf-submit-input.ts";

export { CFSubmitInput };
