/**
 * UI Alert Component Export and Registration
 */

import { CFAlert } from "./cf-alert.ts";

import type { StatusIntent } from "../theme-context.ts";

if (!customElements.get("cf-alert")) {
  customElements.define("cf-alert", CFAlert);
}

export type { CFAlert as CFAlertElement } from "./cf-alert.ts";

export { CFAlert };
export type { StatusIntent };
