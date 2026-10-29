import { CFTab } from "./cf-tab.ts";

import { tabStyles } from "./styles.ts";

if (!customElements.get("cf-tab")) {
  customElements.define("cf-tab", CFTab);
}

export type { CFTab as CFTabElement } from "./cf-tab.ts";

export { CFTab, tabStyles };
