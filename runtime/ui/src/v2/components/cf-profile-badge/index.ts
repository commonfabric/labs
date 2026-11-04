import { CFProfileBadge } from "./cf-profile-badge.ts";

if (!customElements.get("cf-profile-badge")) {
  customElements.define("cf-profile-badge", CFProfileBadge);
}

export type { CFProfileBadge as CFProfileBadgeElement } from "./cf-profile-badge.ts";
export {
  profileDisplayFromValue,
  profileTooltipFromValue,
} from "./cf-profile-badge.ts";

export { CFProfileBadge };
export type {
  ProfileBadgeDisplay,
  ProfileBadgeState,
} from "./cf-profile-badge.ts";
