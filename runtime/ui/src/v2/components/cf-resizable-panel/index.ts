import { CFResizablePanel } from "./cf-resizable-panel.ts";

if (!customElements.get("cf-resizable-panel")) {
  customElements.define("cf-resizable-panel", CFResizablePanel);
}

export type { CFResizablePanel as CFResizablePanelElement } from "./cf-resizable-panel.ts";

export { CFResizablePanel };
