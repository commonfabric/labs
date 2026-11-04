import { CFKbd } from "./cf-kbd.ts";

if (!customElements.get("cf-kbd")) {
  customElements.define("cf-kbd", CFKbd);
}

export { CFKbd };
export type { CFKbd as CFKbdElement } from "./cf-kbd.ts";
