import { CFAutoLayout } from "./cf-autolayout.ts";

if (!customElements.get("cf-autolayout")) {
  customElements.define("cf-autolayout", CFAutoLayout);
}

export type { CFAutoLayout as CFAutoLayoutElement } from "./cf-autolayout.ts";

export { CFAutoLayout };
