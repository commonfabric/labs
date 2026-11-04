import { CFDropZone } from "./cf-drop-zone.ts";

if (!customElements.get("cf-drop-zone")) {
  customElements.define("cf-drop-zone", CFDropZone);
}

export type { CFDropZone as CFDropZoneElement } from "./cf-drop-zone.ts";

export { CFDropZone } from "./cf-drop-zone.ts";
