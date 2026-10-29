import { CFTable } from "./cf-table.ts";

if (!customElements.get("cf-table")) {
  customElements.define("cf-table", CFTable);
}

export type { CFTable as CFTableElement } from "./cf-table.ts";

export { CFTable };
