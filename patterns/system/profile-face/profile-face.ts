/**
 * A profile's face: the picture, or else the legacy avatar text, that a
 * reader shows as the face of the person whose own profile it is. The picture
 * is a blob in a space's blob store, or bytes held inline. Each write labels
 * the value with its writer, earlier releases let anyone set one, and a value
 * can be stored without a label, so a stored value is the owner's face only
 * when its own cell represents the owner (`writtenPrincipalOf()`). Every
 * pattern that shows or keeps a profile's face reads it through
 * `profileFace()`, except the profile pattern itself, which states the same
 * rule inline because it is compiled as a single file.
 */

import {
  type FabricBytes,
  profileOwnerOf,
  type ReadonlyCell,
  writtenPrincipalOf,
} from "commonfabric";

/**
 * A blob holding a picture: the DID of the space whose blob store holds it,
 * and its id there, as `<cf-avatar blob>` and `<cf-image blob>` take one.
 */
export type PictureBlob = { readonly space: string; readonly id: string };

/** The fields of a profile that make up its face. */
export type ProfileFaceFields = {
  pictureBlob?: { space?: string; id?: string };
  picture?: FabricBytes;
  avatar?: string;
};

/**
 * What a reader shows as a person's face: their picture, as a blob or as
 * bytes, or else their avatar text, or none of these, and never more than
 * one. A member typed `?: never` is one that is absent. Draw it with
 * `<cf-avatar blob={face.pictureBlob} bytes={face.picture}
 * src={face.avatar ?? ""}>`.
 */
export type ProfileFace =
  | {
    readonly pictureBlob: PictureBlob;
    readonly picture?: never;
    readonly avatar?: never;
  }
  | {
    readonly picture: FabricBytes;
    readonly pictureBlob?: never;
    readonly avatar?: never;
  }
  | {
    readonly avatar: string;
    readonly pictureBlob?: never;
    readonly picture?: never;
  }
  | {
    readonly pictureBlob?: never;
    readonly picture?: never;
    readonly avatar?: never;
  };

/**
 * Returns the face of the profile `profile`: its `pictureBlob` when it names
 * a blob, by a space's DID and a non-empty id, and its own cell represents
 * the person whose own profile it is (`profileOwnerOf()`,
 * `writtenPrincipalOf()`), or else its `picture` when it holds bytes and its
 * own cell represents the owner, or else its `avatar` text, trimmed, when
 * that is not blank and its own cell represents the owner, or else `{}`.
 * A picture someone else set, or one stored without a label, is not the
 * owner's face, and does not hide a picture or avatar text the owner set. A
 * profile that is no one's own, and a `profile` of `undefined`, have no face.
 * Spread the result into a record that keeps a copy of the face; the copy
 * carries no claim of its own.
 *
 * Call it where `profileOwnerOf()` can be called: in a handler or a reactive
 * computation, not in a pattern body.
 */
export const profileFace = (
  profile: ReadonlyCell<ProfileFaceFields> | undefined,
): ProfileFace => {
  const owner = profile === undefined ? undefined : profileOwnerOf(profile);
  if (profile === undefined || owner === undefined) return {};
  const pictureBlob = profile.key("pictureBlob");
  if (writtenPrincipalOf(pictureBlob) === owner) {
    const { space, id } = pictureBlob.get() ?? {};
    if (
      typeof space === "string" && space.startsWith("did:") &&
      typeof id === "string" && id !== ""
    ) {
      return { pictureBlob: { space, id } };
    }
  }
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
