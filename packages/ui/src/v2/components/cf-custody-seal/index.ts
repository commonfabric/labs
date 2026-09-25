/** Registers and exports the trusted custody-seal component. */

import { CFCustodySeal } from "./cf-custody-seal.ts";

if (!customElements.get("cf-custody-seal")) {
  customElements.define("cf-custody-seal", CFCustodySeal);
}

export { CFCustodySeal };
export type { CFCustodySeal as CFCustodySealElement } from "./cf-custody-seal.ts";
