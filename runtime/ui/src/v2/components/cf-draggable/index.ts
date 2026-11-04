import { CFDraggable } from "./cf-draggable.ts";

if (!customElements.get("cf-draggable")) {
  customElements.define("cf-draggable", CFDraggable);
}

export { CFDraggable };
export type { CFDraggable as CFDraggableElement } from "./cf-draggable.ts";
