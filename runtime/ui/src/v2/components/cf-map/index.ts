/**
 * CF Map Component Export and Registration
 */

import { CFMap } from "./cf-map.ts";

import type {
  Bounds,
  CfBoundsChangeDetail,
  CfCircleClickDetail,
  CfClickDetail,
  CfMarkerClickDetail,
  CfMarkerDragEndDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapPolyline,
  MapValue,
} from "./types.ts";

if (!customElements.get("cf-map")) {
  customElements.define("cf-map", CFMap);
}

export type { CFMap as CFMapElement } from "./cf-map.ts";

export { CFMap };
export type {
  Bounds,
  CfBoundsChangeDetail,
  CfCircleClickDetail,
  CfClickDetail,
  CfMarkerClickDetail,
  CfMarkerDragEndDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapPolyline,
  MapValue,
};
