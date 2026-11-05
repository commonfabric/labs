import { CFListItem } from "./cf-list-item.ts";

if (!customElements.get("cf-list-item")) {
  customElements.define("cf-list-item", CFListItem);
}

export type { CFListItem as CFListItemElement } from "./cf-list-item.ts";

export { CFListItem };
