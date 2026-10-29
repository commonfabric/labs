import { CFSpaceLink } from "./cf-space-link.ts";

if (!customElements.get("cf-space-link")) {
  customElements.define("cf-space-link", CFSpaceLink);
}

export type { CFSpaceLink as CFSpaceLinkElement } from "./cf-space-link.ts";

export * from "./cf-space-link.ts";
