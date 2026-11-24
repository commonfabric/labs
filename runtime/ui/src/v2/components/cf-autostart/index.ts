import { CFAutostart } from "./cf-autostart.ts";

if (!customElements.get("cf-autostart")) {
  customElements.define("cf-autostart", CFAutostart);
}

export type { CFAutostart as CFAutostartElement } from "./cf-autostart.ts";

export { CFAutostart };
