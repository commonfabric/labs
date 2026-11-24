import { CFToolbar } from "./cf-toolbar.ts";

if (!customElements.get("cf-toolbar")) {
  customElements.define("cf-toolbar", CFToolbar);
}

export { CFToolbar };
export type { CFToolbar as CFToolbarElement } from "./cf-toolbar.ts";
