import { CFTab } from "./cf-tab.ts";

if (!customElements.get("cf-tab")) {
  customElements.define("cf-tab", CFTab);
}

export type { CFTab as CFTabElement } from "./cf-tab.ts";

export { CFTab };
