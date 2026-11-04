/**
 * How a pattern that copies a profile's appearance into its own state picks
 * what to copy. A module of its own, importing nothing, so that every such
 * pattern applies the same rule and a unit test can hold it to it.
 */

/** The part of a profile's appearance a snapshot carries. */
export type ProfileLook<Bytes> =
  | { picture: Bytes; avatar?: undefined }
  | { avatar: string; picture?: undefined }
  | { picture?: undefined; avatar?: undefined };

/**
 * Returns the profile's `picture` when it holds any bytes, or else its
 * `avatar` text, trimmed, when that is not blank, or else neither. Spread the
 * result into the snapshot.
 */
export function profileLook<Bytes extends { readonly length: number }>(
  picture: Bytes | undefined,
  avatar: string | undefined,
): ProfileLook<Bytes> {
  if (picture !== undefined && picture.length > 0) return { picture };
  const text = (avatar ?? "").trim();
  return text ? { avatar: text } : {};
}
