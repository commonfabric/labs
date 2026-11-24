import { CFLocation } from "./cf-location.ts";

if (!customElements.get("cf-location")) {
  customElements.define("cf-location", CFLocation);
}

export type { CFLocation as CFLocationElement } from "./cf-location.ts";

export { CFLocation };
export type { LocationData } from "./cf-location.ts";
