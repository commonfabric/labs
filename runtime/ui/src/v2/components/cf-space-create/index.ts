import { CFSpaceCreate } from "./cf-space-create.ts";

if (!customElements.get("cf-space-create")) {
  customElements.define("cf-space-create", CFSpaceCreate);
}

export type { CFSpaceCreate as CFSpaceCreateElement } from "./cf-space-create.ts";

export * from "./cf-space-create.ts";
