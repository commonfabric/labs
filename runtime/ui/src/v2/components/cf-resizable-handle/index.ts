import { CFResizableHandle } from "./cf-resizable-handle.ts";

import { resizableHandleStyles } from "./styles.ts";

if (!customElements.get("cf-resizable-handle")) {
  customElements.define("cf-resizable-handle", CFResizableHandle);
}

export type { CFResizableHandle as CFResizableHandleElement } from "./cf-resizable-handle.ts";

export { CFResizableHandle, resizableHandleStyles };
