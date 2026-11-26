/**
 * CF Map Component Export and Registration
 */

// @ts-types="@types/leaflet"
import * as L from "leaflet";

import * as cfMap from "./cf-map.ts";

/** cf-map drawing with Leaflet, which needs a browser. */
class CFMap extends cfMap.CFMap {
  constructor() {
    super(L);
  }
}

if (!customElements.get("cf-map")) {
  customElements.define("cf-map", CFMap);
}

export type { CFMap as CFMapElement } from "./cf-map.ts";

export { CFMap };
export type * from "./types.ts";
