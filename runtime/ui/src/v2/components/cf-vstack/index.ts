import { CFVStack } from "./cf-vstack.ts";

if (!customElements.get("cf-vstack")) {
  customElements.define("cf-vstack", CFVStack);
}

export type { CFVStack as CFVStackElement } from "./cf-vstack.ts";

export { CFVStack };
