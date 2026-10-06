import { CFCFCAuthorship } from "./cf-cfc-authorship.ts";

if (!customElements.get("cf-cfc-authorship")) {
  customElements.define("cf-cfc-authorship", CFCFCAuthorship);
}

export type { CFCFCAuthorship as CFCFCAuthorshipElement } from "./cf-cfc-authorship.ts";

export { CFCFCAuthorship } from "./cf-cfc-authorship.ts";

// The verdict rules live with `observeAuthorship()`, and are exported here too,
// so a caller importing them from `@commonfabric/ui` reaches that one
// implementation.
export {
  authorshipStateForLabel,
  integrityAtomMatchesAuthor,
} from "@commonfabric/runtime-client";
