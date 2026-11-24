import { BadgeVariant, CFBadge } from "./cf-badge.ts";

if (!customElements.get("cf-badge")) {
  customElements.define("cf-badge", CFBadge);
}

export type { CFBadge as CFBadgeElement } from "./cf-badge.ts";

export { CFBadge };
export type { BadgeVariant };
