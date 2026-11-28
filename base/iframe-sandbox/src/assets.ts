/**
 * The rules a guest's static assets follow, on both sides of the sandbox. A
 * host hands its guest a record from a name to a base64 `data:` URL. The
 * guest's document refers to an asset as `cf-asset:<name>`, which the host
 * replaces with the URL before anything parses the document, and the host
 * writes the record into the document, where the guest's `fabric.asset()`
 * reads it (`guestDocument()`).
 */

import { debugStr } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  ASSET_NAME_CHARACTERS,
  isAssetName,
} from "@commonfabric/text/data-file";

/** A record from an asset's name to its base64 `data:` URL. */
export type AssetRecord = Readonly<Record<string, string>>;

/** The attribute that marks the element carrying a guest's assets. */
export const ASSETS_ATTRIBUTE = "data-cf-assets";

/**
 * A reference to an asset in a guest's document. Its name follows the grammar
 * of an asset's name, and runs to the first character outside it, so a
 * reference ends at the quote of an attribute or the parenthesis of a CSS
 * `url()`.
 */
const ASSET_REFERENCE = new RegExp(
  `cf-asset:([${ASSET_NAME_CHARACTERS}]+)`,
  "g",
);

/**
 * A base64 `data:` URL: a media type, any parameters, and the bytes in base64
 * with its padding. None of the characters it admits needs escaping in an
 * attribute, a CSS `url()`, or JSON, so a URL is written into any of them as
 * it is.
 */
const ASSET_URL =
  /^data:([\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*);base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * Returns the media type and the base64 bytes of `url`, or `undefined` when
 * `url` is not a base64 `data:` URL. The media type keeps whatever parameters
 * the URL gives it.
 */
export function assetUrlParts(
  url: string,
): { mediaType: string; base64: string } | undefined {
  const match = ASSET_URL.exec(url);
  if (match === null || match[2].length % 4 !== 0) return undefined;
  return { mediaType: match[1], base64: match[2] };
}

/**
 * Returns `value` as a frozen asset record, copied from it.
 *
 * @throws TypeError when `value` is not a plain object, when one of its names
 *   does not match `[A-Za-z0-9_-]+`, or when one of its values is not a base64
 *   `data:` URL, naming which.
 */
export function toAssetRecord(value: unknown): AssetRecord {
  if (!isPlainObject(value)) {
    throw new TypeError(
      "Assets are a record from a name to a base64 `data:` URL, " +
        debugStr`not $quote${value}.`,
    );
  }
  const entries: [string, string][] = [];
  for (const [name, url] of Object.entries(value)) {
    if (!isAssetName(name)) {
      throw new TypeError(
        debugStr`The asset name $quote${name} does not match ` +
          "`[A-Za-z0-9_-]+`.",
      );
    }
    if (typeof url !== "string" || assetUrlParts(url) === undefined) {
      throw new TypeError(
        `The asset \`${name}\` is not a base64 \`data:\` URL: ` +
          debugStr`$quote${url}`,
      );
    }
    entries.push([name, url]);
  }
  // `Object.fromEntries()` defines each name as its own property, `__proto__`
  // included, where an assignment would reach the prototype instead.
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Returns whether `a` and `b` hold the same names, each with the same URL.
 */
export function sameAssets(a: AssetRecord, b: AssetRecord): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name]);
}

/**
 * Returns `html` with each `cf-asset:` reference to an asset `assets` holds
 * replaced with that asset's URL. A reference to a name `assets` lacks stays
 * as it is; `missingAssets()` lists those.
 */
export function substituteAssets(html: string, assets: AssetRecord): string {
  return html.replaceAll(
    ASSET_REFERENCE,
    (reference, name: string) =>
      Object.hasOwn(assets, name) ? assets[name] : reference,
  );
}

/**
 * Returns the names `html` refers to with `cf-asset:` that `assets` lacks,
 * each once, in the order of their first references.
 */
export function missingAssets(html: string, assets: AssetRecord): string[] {
  const names = new Set<string>();
  for (const [, name] of html.matchAll(ASSET_REFERENCE)) {
    if (!Object.hasOwn(assets, name)) names.add(name);
  }
  return [...names];
}
