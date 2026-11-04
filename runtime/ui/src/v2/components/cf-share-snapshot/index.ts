/** Registers and exports the trusted snapshot-sharing component. */

import { CFShareSnapshot } from "./cf-share-snapshot.ts";

if (!customElements.get("cf-share-snapshot")) {
  customElements.define("cf-share-snapshot", CFShareSnapshot);
}

export { CFShareSnapshot };
export type { CFShareSnapshot as CFShareSnapshotElement } from "./cf-share-snapshot.ts";
