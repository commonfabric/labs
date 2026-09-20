// The parts of this format's wire text that both an engine and a decoding act
// need. They live here rather than on either, so that neither has to import the
// other to reach them.

import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { ProblematicStateError } from "@/codec-common";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { deepFreeze } from "@/deep-freeze.ts";

/**
 * Indicates if the given text has a "first-blush" appearance as valid JSON
 * encoded in this format -- that is, whether it carries the encoding prefix
 * tag.
 */
export function seemsLikeEncoded(value: string): boolean {
  return value.startsWith(ENCODING_PREFIX_TAG);
}

/** Parses the JSON-text wire form, _without_ a tag prefix. */
export function parseWireText(jsonText: string): JsonCodecValue {
  try {
    return deepFreeze(JSON.parse(jsonText) as JsonCodecValue);
  } catch (e) {
    // The tag said this was ours and the text under it is not JSON, which
    // is a refusal of the serialized form and settles against `lenient`
    // like the tag check above it. Raised as this class's own refusal
    // rather than passing `JSON.parse()`'s `SyntaxError` along, which
    // nothing downstream recognizes.
    const excerpt = (jsonText.length <= 50)
      ? jsonText
      : `${jsonText.slice(0, 50)}...`;
    throw new ProblematicStateError(
      "",
      excerpt,
      `Malformed JSON in an encoded \`FabricValue\` string: ${
        backtickQuote(excerpt)
      }`,
      { cause: e },
    );
  }
}

/**
 * Returns true if `v` is a single-key object whose key starts with `/` --
 * the wire form of an encoded instance (tag-wrapped value).
 */
export function isEncodedInstance(v: JsonCodecValue): boolean {
  if (!isObjectNotArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0]!.startsWith("/");
}
