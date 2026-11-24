import { CFHStack } from "./cf-hstack.ts";

if (!customElements.get("cf-hstack")) {
  customElements.define("cf-hstack", CFHStack);
}

export type { CFHStack as CFHStackElement } from "./cf-hstack.ts";

export { CFHStack };
