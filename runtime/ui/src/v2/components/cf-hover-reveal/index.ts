import { CFHoverReveal } from "./cf-hover-reveal.ts";

if (!customElements.get("cf-hover-reveal")) {
  customElements.define("cf-hover-reveal", CFHoverReveal);
}

export type { CFHoverReveal as CFHoverRevealElement } from "./cf-hover-reveal.ts";

export { CFHoverReveal };
