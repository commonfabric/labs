import { CFChip } from "./cf-chip.ts";

if (!customElements.get("cf-chip")) {
  customElements.define("cf-chip", CFChip);
}

export { CFChip };
export type { CFChip as CFChipElement } from "./cf-chip.ts";
