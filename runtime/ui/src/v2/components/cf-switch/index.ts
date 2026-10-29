import { CFSwitch } from "./cf-switch.ts";

if (!customElements.get("cf-switch")) {
  customElements.define("cf-switch", CFSwitch);
}

export type { CFSwitch as CFSwitchElement } from "./cf-switch.ts";

export { CFSwitch };
