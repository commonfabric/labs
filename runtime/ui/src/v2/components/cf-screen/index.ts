import { CFScreen } from "./cf-screen.ts";

if (!customElements.get("cf-screen")) {
  customElements.define("cf-screen", CFScreen);
}

export type { CFScreen as CFScreenElement } from "./cf-screen.ts";

export { CFScreen };
