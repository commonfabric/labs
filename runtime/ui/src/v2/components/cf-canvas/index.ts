import { CFCanvas } from "./cf-canvas.ts";

if (!customElements.get("cf-canvas")) {
  customElements.define("cf-canvas", CFCanvas);
}

export { CFCanvas };
export type { CFCanvas as CFCanvasElement } from "./cf-canvas.ts";
