import { CFHeading } from "./cf-heading.ts";

if (!customElements.get("cf-heading")) {
  customElements.define("cf-heading", CFHeading);
}

export type { CFHeading as CFHeadingElement } from "./cf-heading.ts";

export { CFHeading };
