import { CFFab } from "./cf-fab.ts";

if (!customElements.get("cf-fab")) {
  customElements.define("cf-fab", CFFab);
}

export type { CFFab as CFFabElement } from "./cf-fab.ts";

export { CFFab };
