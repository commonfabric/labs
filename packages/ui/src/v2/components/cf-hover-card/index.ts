import { CFHoverCard } from "./cf-hover-card.ts";

if (!customElements.get("cf-hover-card")) {
  customElements.define("cf-hover-card", CFHoverCard);
}

export type { CFHoverCard as CFHoverCardElement } from "./cf-hover-card.ts";

export { CFHoverCard };
