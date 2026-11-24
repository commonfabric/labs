import { CFSelect } from "./cf-select.ts";

if (!customElements.get("cf-select")) {
  customElements.define("cf-select", CFSelect);
}

export type { CFSelect as CFSelectElement } from "./cf-select.ts";
export type { SelectItem } from "./cf-select.ts";

export { CFSelect };
