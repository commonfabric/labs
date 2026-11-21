/**
 * How a data file's bytes are stored in a source package, and how they are
 * read back as bytes or as a `data:` URL.
 *
 * A source package holds text. A text file is stored as its UTF-8 decoding,
 * and a binary media file (an image, a font, a sound) as a base64 `data:` URL
 * carrying its media type, which is also the form an iframe guest can load
 * under its Content Security Policy (`docs/specs/iframe-static-assets.md`,
 * part 2). The file's extension decides which, from a closed table, so a file
 * is stored the same way whatever its bytes happen to be.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

/** A media type, and whether a file of that type is stored as a `data:` URL. */
interface MediaTypeEntry {
  /** The media type a `data:` URL for such a file carries. */
  readonly mediaType: string;

  /** Whether the file is binary, and so stored as a `data:` URL. */
  readonly binary: boolean;
}

/** The media types a `data:` URL can carry, by lowercase extension. */
const MEDIA_TYPES: ReadonlyMap<string, MediaTypeEntry> = new Map([
  ["png", { mediaType: "image/png", binary: true }],
  ["jpg", { mediaType: "image/jpeg", binary: true }],
  ["jpeg", { mediaType: "image/jpeg", binary: true }],
  ["gif", { mediaType: "image/gif", binary: true }],
  ["webp", { mediaType: "image/webp", binary: true }],
  ["avif", { mediaType: "image/avif", binary: true }],
  ["woff2", { mediaType: "font/woff2", binary: true }],
  ["woff", { mediaType: "font/woff", binary: true }],
  ["ttf", { mediaType: "font/ttf", binary: true }],
  ["otf", { mediaType: "font/otf", binary: true }],
  ["mp3", { mediaType: "audio/mpeg", binary: true }],
  ["ogg", { mediaType: "audio/ogg", binary: true }],
  ["wav", { mediaType: "audio/wav", binary: true }],
  ["svg", { mediaType: "image/svg+xml", binary: false }],
]);

/**
 * Returns the media type of the file `name` names, from its extension, or
 * `undefined` when the table has none for it. A file name that is only an
 * extension, such as `.png`, has none.
 */
export function dataFileMediaType(name: string): string | undefined {
  return mediaTypeEntry(name)?.mediaType;
}

/**
 * Returns whether the file `name` names is stored as a base64 `data:` URL
 * rather than as text.
 */
export function isStoredAsDataUrl(name: string): boolean {
  return mediaTypeEntry(name)?.binary === true;
}

/**
 * Decodes a data file's bytes as the text a source package stores.
 *
 * A binary media file becomes a base64 `data:` URL carrying its media type.
 * Any other file is decoded as UTF-8 strictly: a file that is not valid UTF-8
 * is reported by `name` rather than stored with replacement characters in
 * place of the bytes that were read. `ignoreBOM` keeps a leading byte order
 * mark in the result instead of consuming it, since a data file is stored
 * byte for byte and dropping the mark would deploy something other than the
 * authored file. Every reader of a data file decodes it here, so that each one
 * stores and hashes the same text.
 */
export function decodeDataFile(bytes: Uint8Array, name: string): string {
  const entry = mediaTypeEntry(name);
  if (entry?.binary === true) {
    return `${dataUrlPrefix(entry.mediaType)}${encodeBase64(bytes)}`;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch {
    throw new Error(`Data file \`${name}\` is not valid UTF-8 text.`);
  }
}

/**
 * Returns the bytes of the file `contents` was stored from, the inverse of
 * {@link decodeDataFile}: what a source package is written back to disk as.
 * Throws for a binary media file whose contents are not a `data:` URL of its
 * own media type, which `decodeDataFile()` never stores.
 */
export function encodeDataFile(contents: string, name: string): Uint8Array {
  const entry = mediaTypeEntry(name);
  if (entry?.binary !== true) return new TextEncoder().encode(contents);
  return decodeBase64(base64Of(contents, name, entry.mediaType));
}

/**
 * Returns the stored `contents` of the file `name` names as a base64 `data:`
 * URL: a binary media file's contents as they are, and a text file's UTF-8
 * bytes encoded under its media type. Throws, listing the known extensions,
 * for a file the table has no media type for, and for a binary media file whose
 * contents are not a `data:` URL of its own media type: a program that did not
 * pass through {@link decodeDataFile} can carry one.
 */
export function dataFileUrl(contents: string, name: string): string {
  const entry = mediaTypeEntry(name);
  if (entry === undefined) {
    const known = [...MEDIA_TYPES.keys()].map((ext) => `\`.${ext}\``);
    throw new Error(
      `\`${name}\` has no media type a \`data:\` URL can carry. Known ` +
        `extensions: ${known.join(", ")}.`,
    );
  }
  if (entry.binary) {
    base64Of(contents, name, entry.mediaType);
    return contents;
  }
  return `${dataUrlPrefix(entry.mediaType)}${
    encodeBase64(new TextEncoder().encode(contents))
  }`;
}

/**
 * The characters an asset's name is made of. A name is one or more of them:
 * what `dataFile.urls()` keys a file by, what `cf-iframe`'s `assets` admits,
 * and what a `cf-asset:` reference in a guest's document runs to.
 */
export const ASSET_NAME_CHARACTERS = "A-Za-z0-9_-";

/** An asset's name, whole. */
const ASSET_NAME = new RegExp(`^[${ASSET_NAME_CHARACTERS}]+$`);

/** Returns whether `name` is an asset's name. */
export function isAssetName(name: string): boolean {
  return ASSET_NAME.test(name);
}

/**
 * Returns the assets the directory `directory` holds, among the root-relative
 * file names `names`: each name directly inside `directory` whose extension
 * the table has, keyed by its file name without the extension, so
 * `/donuts/glaze.png` is `glaze` in `/donuts`. Names in subdirectories, hidden
 * files (a name starting with `.`, such as macOS's `._glaze.png`), and files
 * the table has no media type for are left out.
 *
 * Throws for a file whose name without its extension is not an asset name
 * (letters, digits, `_`, and `-`), and for two files that would share a name,
 * such as `glaze.png` and `glaze.webp`.
 */
export function dataFileAssets(
  directory: string,
  names: Iterable<string>,
): Map<string, string> {
  const parent = directory.replace(/\/+$/, "");
  const assets = new Map<string, string>();
  for (const name of names) {
    const slash = name.lastIndexOf("/");
    if (name.slice(0, slash) !== parent) continue;
    const base = name.slice(slash + 1);
    if (base.startsWith(".")) continue;
    if (mediaTypeEntry(name) === undefined) continue;
    const asset = base.slice(0, base.lastIndexOf("."));
    if (!isAssetName(asset)) {
      throw new Error(
        `Data file \`${name}\` has no asset name: \`${asset}\` holds ` +
          "characters other than letters, digits, `_`, and `-`.",
      );
    }
    const other = assets.get(asset);
    if (other !== undefined) {
      throw new Error(
        `Data files \`${other}\` and \`${name}\` would both be the asset ` +
          `\`${asset}\`.`,
      );
    }
    assets.set(asset, name);
  }
  return assets;
}

/** Helper for the functions above, which looks `name` up by its extension. */
function mediaTypeEntry(name: string): MediaTypeEntry | undefined {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return MEDIA_TYPES.get(base.slice(dot + 1).toLowerCase());
}

/**
 * Helper for the functions above, which returns the base64 that `contents`, a
 * binary media file's stored contents, carries after its `data:` URL prefix.
 * Throws, naming the file, when `contents` is not a `data:` URL of `mediaType`
 * holding padded base64.
 */
function base64Of(contents: string, name: string, mediaType: string): string {
  const prefix = dataUrlPrefix(mediaType);
  if (
    !contents.startsWith(prefix) ||
    (contents.length - prefix.length) % 4 !== 0 ||
    !BASE64.test(contents.slice(prefix.length))
  ) {
    throw new Error(
      `Data file \`${name}\` does not hold an \`${mediaType}\` \`data:\` URL.`,
    );
  }
  return contents.slice(prefix.length);
}

/** Padded standard base64, as `encodeBase64()` writes it. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Helper for the functions above, which starts a base64 `data:` URL. */
function dataUrlPrefix(mediaType: string): string {
  return `data:${mediaType};base64,`;
}
