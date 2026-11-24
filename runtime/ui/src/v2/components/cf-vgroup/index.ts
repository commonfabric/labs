import { CFVGroup } from "./cf-vgroup.ts";

if (!customElements.get("cf-vgroup")) {
  customElements.define("cf-vgroup", CFVGroup);
}

export type { CFVGroup as CFVGroupElement } from "./cf-vgroup.ts";

export { CFVGroup };
