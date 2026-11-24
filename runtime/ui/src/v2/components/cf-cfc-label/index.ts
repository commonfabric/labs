import { CFCFCLabel } from "./cf-cfc-label.ts";

if (!customElements.get("cf-cfc-label")) {
  customElements.define("cf-cfc-label", CFCFCLabel);
}

export type { CFCFCLabel as CFCFCLabelElement } from "./cf-cfc-label.ts";
export { filterCfcLabelView, formatCfcLabelAtom } from "./cf-cfc-label.ts";

export { CFCFCLabel };
