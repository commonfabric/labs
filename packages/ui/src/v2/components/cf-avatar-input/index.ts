import { CFAvatarInput } from "./cf-avatar-input.ts";

if (!customElements.get("cf-avatar-input")) {
  customElements.define("cf-avatar-input", CFAvatarInput);
}

export { CFAvatarInput };
export type { CFAvatarInput as CFAvatarInputElement } from "./cf-avatar-input.ts";
export {
  AVATAR_PIXELS,
  avatarBytesFromImage,
  NotAnImageError,
} from "./cf-avatar-input.ts";
