import { CFLabel } from "./cf-label.ts";

if (!customElements.get("cf-label")) {
  customElements.define("cf-label", CFLabel);
}

export type { CFLabel as CFLabelElement } from "./cf-label.ts";

export { CFLabel };
