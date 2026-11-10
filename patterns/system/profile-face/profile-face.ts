/**
 * A profile's face: the picture, or else the legacy avatar text, that a
 * reader shows as the face of the person whose own profile it is. Anyone can
 * write a profile's picture, and each write labels the picture with its
 * writer, so a stored value is the owner's face only when its own cell
 * represents the owner (`writtenPrincipalOf()`). Every pattern that shows or
 * keeps a profile's face reads it through `profileFace()`, except the
 * profile pattern itself, which states the same rule inline because it is
 * compiled as a single file.
 */

import {
  type Cell,
  type FabricBytes,
  profileOwnerOf,
  writtenPrincipalOf,
} from "commonfabric";

/** The fields of a profile that make up its face. */
export type ProfileFaceFields = {
  picture?: FabricBytes;
  avatar?: string;
};

/**
 * What a reader shows as a person's face: their picture, or else their
 * avatar text, or neither, and never both. A member typed `?: never` is one
 * that is absent.
 */
export type ProfileFace =
  | { readonly picture: FabricBytes; readonly avatar?: never }
  | { readonly avatar: string; readonly picture?: never }
  | { readonly picture?: never; readonly avatar?: never };

/**
 * Returns the face of the profile `profile`: its `picture` when it holds
 * bytes and its own cell represents the person whose own profile it is
 * (`profileOwnerOf()`, `writtenPrincipalOf()`), or else its `avatar` text,
 * trimmed, when that is not blank and its own cell represents the owner, or
 * else `{}`.
 * A picture someone else set, or one stored without a label, is not the
 * owner's face, so it leaves the owner's avatar text as the face. A profile
 * that is no one's own, and a `profile` of `undefined`, have no face. Spread
 * the result into a record that keeps a copy of the face; the copy carries no
 * claim of its own.
 *
 * Call it where `profileOwnerOf()` can be called: in a handler or a reactive
 * computation, not in a pattern body.
 */
export const profileFace = (
  profile: Cell<ProfileFaceFields> | undefined,
): ProfileFace => {
  const owner = profile === undefined ? undefined : profileOwnerOf(profile);
  if (profile === undefined || owner === undefined) return {};
  const picture = profile.key("picture");
  const bytes = picture.get();
  if (
    bytes !== undefined && bytes.length > 0 &&
    writtenPrincipalOf(picture) === owner
  ) {
    return { picture: bytes };
  }
  const avatar = profile.key("avatar");
  const text = (avatar.get() ?? "").trim();
  return text !== "" && writtenPrincipalOf(avatar) === owner
    ? { avatar: text }
    : {};
};
