import { CFCard } from "./cf-card.ts";

if (!customElements.get("cf-card")) {
  customElements.define("cf-card", CFCard);
}

export type { CFCard as CFCardElement } from "./cf-card.ts";

export { CFCard };
