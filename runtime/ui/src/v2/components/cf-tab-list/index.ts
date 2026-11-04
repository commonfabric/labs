import { CFTabList } from "./cf-tab-list.ts";

import { tabListStyles } from "./styles.ts";

if (!customElements.get("cf-tab-list")) {
  customElements.define("cf-tab-list", CFTabList);
}

export type { CFTabList as CFTabListElement } from "./cf-tab-list.ts";

export { CFTabList, tabListStyles };
