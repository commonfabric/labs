import { CFAvatar } from "./cf-avatar.ts";

if (!customElements.get("cf-avatar")) {
  customElements.define("cf-avatar", CFAvatar);
}

export type { CFAvatar as CFAvatarElement } from "./cf-avatar.ts";
export {
  initialsForName,
  isAvatarImageUrl,
  isRemoteLikeSource,
} from "./cf-avatar.ts";

export { CFAvatar };
export type { AvatarShape, AvatarSize } from "./cf-avatar.ts";
