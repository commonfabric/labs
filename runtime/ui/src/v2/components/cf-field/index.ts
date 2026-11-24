import { CFField } from "./cf-field.ts";

if (!customElements.get("cf-field")) {
  customElements.define("cf-field", CFField);
}

export type { CFField as CFFieldElement } from "./cf-field.ts";

export { CFField };
