import { CFScrollArea, ScrollOrientation } from "./cf-scroll-area.ts";

if (!customElements.get("cf-scroll-area")) {
  customElements.define("cf-scroll-area", CFScrollArea);
}

export type { CFScrollArea as CFScrollAreaElement } from "./cf-scroll-area.ts";

export { CFScrollArea };
export type { ScrollOrientation };
