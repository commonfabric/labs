import { CFCFCAuthorship } from "./cf-cfc-authorship.ts";

if (!customElements.get("cf-cfc-authorship")) {
  customElements.define("cf-cfc-authorship", CFCFCAuthorship);
}

export type { CFCFCAuthorship as CFCFCAuthorshipElement } from "./cf-cfc-authorship.ts";

export { CFCFCAuthorship } from "./cf-cfc-authorship.ts";
