/**
 * The `data:` URI codec, complete and self-contained: the media-type facts, the
 * mint half ({@link dataUriFromValue}), and the read half ({@link
 * valueFromDataUri}, {@link extractDataUriPayloadText}, {@link
 * valueFromDataUriPayloadText}).
 */

import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  fromBase64url,
  toUnpaddedBase64urlFromText,
} from "@commonfabric/utils/base64url";
import { NullLiveEnvironment } from "./codec-common/index.ts";
import { fabricFromJsonValue, jsonFromFabricValue } from "./codecs.ts";
import type { FabricValue } from "./index.ts";

/**
 * A URI in string form. Structurally identical to (and hence
 * interchangeable with) the `URI` type in `memory/interface`.
 */
type UriString = `${string}:${string}`;

/** The media type minted for `data:` URIs. */
export const DATA_URI_MEDIA_TYPE = "application/vnd.common-fabric.data";

/**
 * Is `id` a `data:` URI? This is the broad test of the pair: does the
 * identifier carry its own frozen value, rather than name a document stored
 * in a space? Such a cell is read by decoding its identifier, so there is no
 * document to fetch, to sync, or to write, and no commit precondition to
 * state about one.
 *
 * Only the scheme is examined. Every media type counts, and the payload is
 * neither decoded nor validated. {@link isFabricDataUri} is the narrow
 * companion, accepting just the one media type this codec mints.
 */
export function hasDataUriScheme(id: string): boolean {
  return id.startsWith("data:");
}

/**
 * Is `mediaType` the `data:` URI media type? Exactly one type is accepted;
 * there are no parameters (the payload is always base64url of UTF-8 text, so
 * none are needed).
 */
export function isDataUriMediaType(mediaType: string): boolean {
  return mediaType === DATA_URI_MEDIA_TYPE;
}

/**
 * Does `id` carry this codec's media type? This is the narrow test of the pair,
 * for readers that go on to decode the payload; {@link hasDataUriScheme}
 * accepts any media type. Only the prefix is examined; the payload is not
 * validated.
 */
export function isFabricDataUri(id: string): boolean {
  return id.startsWith(`data:${DATA_URI_MEDIA_TYPE}`);
}

/**
 * Assembles a `data:` URI carrying (the encoding of) `value` -- the single
 * place the URI shape is put together: scheme, media type, and the
 * base64url-of-UTF-8 `fvj1:` payload. Unlike the runner's
 * `dataUriFromValueWithResolvedLinks()`, this does no link rewriting or other
 * preparation of `value`; callers hand it a ready `FabricValue`.
 */
export function dataUriFromValue(value: FabricValue): UriString {
  const payload = toUnpaddedBase64urlFromText(jsonFromFabricValue(value));
  return `data:${DATA_URI_MEDIA_TYPE},${payload}` as UriString;
}

/** Shared text decoder, created once. */
const textDecoder = new TextDecoder();

/**
 * `LiveEnvironment` for decoding `data:` URI payloads. Links at this
 * boundary are sigil (plain) data rather than cell references, so no cell
 * decoding is ever needed; this environment exists so that an unexpected
 * cell reference produces a message that names the boundary.
 */
const dataUriLiveEnvironment = new NullLiveEnvironment(
  true,
  "no cell decoding at the `data:` URI boundary",
);

/**
 * Splits a `data:` URI and decodes its payload into text -- the single
 * place the URI's surface syntax is taken apart. The header (between
 * `data:` and the first comma) is returned verbatim as the media type;
 * there are no header parameters in this format, so a header carrying any
 * (`;charset=`, `;base64`, ...) simply fails the caller's media-type
 * check. The payload is base64url of UTF-8 text. A raw `?` or `#` after
 * the comma delimits a query or fragment per the URL grammar; everything
 * from that delimiter onward (the delimiter included) is ignored -- it is
 * neither decoded, nor validated, nor returned.
 *
 * @param uri The `data:` URI to split.
 * @returns The media type and the decoded payload text.
 * @throws If `uri` is not a `data:` URI with a comma, or its payload is
 *   not base64url.
 */
export function extractDataUriPayloadText(
  uri: string,
): { mediaType: string; text: string } {
  const commaIndex = uri.indexOf(",");
  if (!hasDataUriScheme(uri) || commaIndex === -1) {
    throw new Error(`Invalid data URI format: ${backtickQuote(uri)}`);
  }

  const mediaType = uri.substring("data:".length, commaIndex);
  let data = uri.substring(commaIndex + 1);

  // Per the URL grammar, an opaque-path URI's payload runs to the first raw
  // `?` (query) or `#` (fragment); base64url never contains either.
  const delimIndex = data.search(/[?#]/);
  if (delimIndex !== -1) {
    data = data.substring(0, delimIndex);
  }

  try {
    // Note that `textDecoder` uses the default configuration of `fatal: false`,
    // so its `decode()` never throws; only the base64url decode can land in the
    // `catch`.
    const bytes = fromBase64url(data);
    return { mediaType, text: textDecoder.decode(bytes) };
  } catch {
    throw new Error(
      `Invalid data URI payload (not base64url): ${backtickQuote(uri)}`,
    );
  }
}

/**
 * Decodes the extracted payload text of a `data:` URI of this codec,
 * which must be in the standard `data-model` `FabricValue` JSON-embedded
 * encoding (tagged `fvj1:`). Results are deep-frozen and may contain
 * `FabricInstance`s. This is the single point of truth for how such
 * payloads read, shared by every reader of them; per-reader payload
 * extraction and error policy stay with the readers (see
 * {@link valueFromDataUri} and `storage/transaction/attestation.ts`'s
 * `load()`).
 *
 * Only the standard encoding is accepted, from external minters as much as
 * from this module's own encode half; any other payload text (bare JSON
 * included) fails loudly rather than being guessed at.
 *
 * @param text The payload text, after base64url decoding.
 * @returns The decoded value.
 * @throws If `text` is not a valid encoded `FabricValue` -- including when
 *   it is empty or is bare JSON.
 */
export function valueFromDataUriPayloadText(text: string): FabricValue {
  return fabricFromJsonValue(text, dataUriLiveEnvironment);
}

/**
 * Extracts and decodes the payload of a `data:` URI of this codec. Exactly one
 * shape is accepted -- the shape {@link dataUriFromValue} writes: the
 * `application/vnd.common-fabric.data` media type with no parameters, and
 * a base64url payload carrying the `fvj1:`-tagged `FabricValue` encoding
 * as UTF-8 text (decoded via {@link valueFromDataUriPayloadText}).
 *
 * @param uri The `data:` URI to read.
 * @returns The decoded payload.
 * @throws If `uri` is not a `data:` URI of exactly that shape, or its
 *   payload is not a valid encoded `FabricValue` (which includes the empty
 *   payload and bare JSON).
 */
export function valueFromDataUri(uri: UriString | string): any {
  const { mediaType, text } = extractDataUriPayloadText(uri);
  if (!isDataUriMediaType(mediaType)) {
    throw new Error(`Invalid URI: ${backtickQuote(uri)}`);
  }
  return valueFromDataUriPayloadText(text);
}
