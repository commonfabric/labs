import { CFHGroup } from "./cf-hgroup.ts";

if (!customElements.get("cf-hgroup")) {
  customElements.define("cf-hgroup", CFHGroup);
}

export type { CFHGroup as CFHGroupElement } from "./cf-hgroup.ts";

export { CFHGroup };
