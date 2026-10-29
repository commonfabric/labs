import { CFTabPanel } from "./cf-tab-panel.ts";

import { tabPanelStyles } from "./styles.ts";

if (!customElements.get("cf-tab-panel")) {
  customElements.define("cf-tab-panel", CFTabPanel);
}

export type { CFTabPanel as CFTabPanelElement } from "./cf-tab-panel.ts";

export { CFTabPanel, tabPanelStyles };
