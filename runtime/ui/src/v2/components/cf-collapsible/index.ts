import { CFCollapsible } from "./cf-collapsible.ts";

if (!customElements.get("cf-collapsible")) {
  customElements.define("cf-collapsible", CFCollapsible);
}

export type { CFCollapsible as CFCollapsibleElement } from "./cf-collapsible.ts";

export { CFCollapsible };
