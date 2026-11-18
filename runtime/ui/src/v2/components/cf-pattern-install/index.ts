import { CFPatternInstall } from "./cf-pattern-install.ts";

if (!customElements.get("cf-pattern-install")) {
  customElements.define("cf-pattern-install", CFPatternInstall);
}

export type { CFPatternInstall as CFPatternInstallElement } from "./cf-pattern-install.ts";

export { CFPatternInstall };
