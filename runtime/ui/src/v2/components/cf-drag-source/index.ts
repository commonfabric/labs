import { CFDragSource } from "./cf-drag-source.ts";

if (!customElements.get("cf-drag-source")) {
  customElements.define("cf-drag-source", CFDragSource);
}

export type { CFDragSource as CFDragSourceElement } from "./cf-drag-source.ts";

export { CFDragSource } from "./cf-drag-source.ts";
