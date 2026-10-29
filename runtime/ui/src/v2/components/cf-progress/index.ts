import { CFProgress } from "./cf-progress.ts";

if (!customElements.get("cf-progress")) {
  customElements.define("cf-progress", CFProgress);
}

export type { CFProgress as CFProgressElement } from "./cf-progress.ts";

export { CFProgress };
