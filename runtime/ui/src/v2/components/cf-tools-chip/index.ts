import { CFToolsChip } from "./cf-tools-chip.ts";

if (!customElements.get("cf-tools-chip")) {
  customElements.define("cf-tools-chip", CFToolsChip);
}

export type { CFToolsChip as CFToolsChipElement } from "./cf-tools-chip.ts";

export { CFToolsChip };
export type { ToolsChipTool } from "./cf-tools-chip.ts";
