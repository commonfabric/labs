import { CFRadio } from "./cf-radio.ts";

if (!customElements.get("cf-radio")) {
  customElements.define("cf-radio", CFRadio);
}

export type { CFRadio as CFRadioElement } from "./cf-radio.ts";

export { CFRadio };
