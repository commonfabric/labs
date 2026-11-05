import { CFGrid } from "./cf-grid.ts";

if (!customElements.get("cf-grid")) {
  customElements.define("cf-grid", CFGrid);
}

export type { CFGrid as CFGridElement } from "./cf-grid.ts";

export { CFGrid };
