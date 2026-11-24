import { CFSvg } from "./cf-svg.ts";

if (!customElements.get("cf-svg")) {
  customElements.define("cf-svg", CFSvg);
}

export type { CFSvg as CFSvgElement } from "./cf-svg.ts";

export { CFSvg };
