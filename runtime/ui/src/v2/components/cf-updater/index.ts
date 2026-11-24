import { CFUpdater } from "./cf-updater.ts";

if (!customElements.get("cf-updater")) {
  customElements.define("cf-updater", CFUpdater);
}

export type { CFUpdater as CFUpdaterElement } from "./cf-updater.ts";

export * from "./cf-updater.ts";
