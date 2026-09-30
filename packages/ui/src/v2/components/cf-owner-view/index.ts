import { CFOwnerView } from "./cf-owner-view.ts";

if (!customElements.get("cf-owner-view")) {
  customElements.define("cf-owner-view", CFOwnerView);
}

export { CFOwnerView };
export type { CFOwnerView as CFOwnerViewElement } from "./cf-owner-view.ts";
