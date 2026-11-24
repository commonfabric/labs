import { CFLink } from "./cf-link.ts";
import { CFRouter } from "./cf-router.ts";

if (!customElements.get("cf-link")) {
  customElements.define("cf-link", CFLink);
}

if (!customElements.get("cf-router")) {
  customElements.define("cf-router", CFRouter);
}

export type { CFLink as CFLinkElement } from "./cf-link.ts";
export type { CFRouter as CFRouterElement } from "./cf-router.ts";

export { CFLink, CFRouter };
