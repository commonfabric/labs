// The parts of this format's wire text that both an engine and a decoding act
// need. They live here rather than on either, so that neither has to import the
// other to reach them.

import { backtickQuote } from "@commonfabric/utils/markdown";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { ProblematicStateError } from "@/codec-common";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { SlotLimitError } from "./SlotLimitError.ts";
import { excerptOf, writesMoreMembersThan } from "./text-scan.ts";

/**
 * Indicates if the given text has a "first-blush" appearance as valid JSON
 * encoded in this format -- that is, whether it carries the encoding prefix
 * tag.
 */
export function seemsLikeEncoded(value: string): boolean {
  return value.startsWith(ENCODING_PREFIX_TAG);
}

/**
 * Parses the JSON-text wire form, _without_ a tag prefix. The result is
 * deep-frozen unless `mutable`; it is freshly built either way, so a mutable
 * one is shared with nothing.
 *
 * `slotLimit`, when given, bounds the slots the text may stand for, and text
 * past it is refused with `SlotLimitError`. A slot is an array element or a
 * record member written in the text, and a `/hole` run adds one slot for each
 * hole past the first that it stands for. The elements and members are counted
 * on the text before it is parsed, and the holes on the parsed tree before it
 * is frozen or walked, so refusing text costs at most a scan of it, and
 * accepting it a parse building at most `slotLimit` values.
 */
export function parseWireText(
  jsonText: string,
  mutable = false,
  slotLimit?: number,
): JsonCodecValue {
  if (slotLimit !== undefined && writesMoreMembersThan(jsonText, slotLimit)) {
    throw new SlotLimitError(slotLimit, jsonText);
  }
  let parsed: JsonCodecValue;
  try {
    parsed = JSON.parse(jsonText) as JsonCodecValue;
  } catch (e) {
    throw malformedJsonError(jsonText, e);
  }
  if (slotLimit !== undefined && exceedsSlotLimit(parsed, slotLimit)) {
    throw new SlotLimitError(slotLimit, jsonText);
  }
  try {
    return mutable ? parsed : deepFreeze(parsed);
  } catch (e) {
    // Nesting too deep for the freeze's recursion is refused like nesting
    // the parse could not read.
    throw malformedJsonError(jsonText, e);
  }
}

/**
 * Returns the refusal for text under the tag that is not JSON this format can
 * read. The tag said this was ours, so it is a refusal of the serialized form,
 * and settles against `lenient` like the tag check. It is raised as this
 * format's own refusal rather than passing `cause` along, which nothing
 * downstream recognizes.
 */
function malformedJsonError(
  jsonText: string,
  cause: unknown,
): ProblematicStateError {
  const excerpt = excerptOf(jsonText);
  return new ProblematicStateError(
    "",
    excerpt,
    `Malformed JSON in an encoded \`FabricValue\` string: ${
      backtickQuote(excerpt)
    }`,
    { cause },
  );
}

/**
 * Indicates whether `tree` stands for more than `slotLimit` slots, counted as
 * {@link parseWireText} describes: each array element and record member, and
 * each hole past the first in a `/hole` run. That bounds the places a decode of
 * the tree fills or leaves absent, and so the work any walk over the decoded
 * value does.
 *
 * The walk stops as soon as the count passes `slotLimit`, so it takes at most
 * that many steps whatever the tree holds. A `/hole` run is recognized
 * wherever it appears, a `/quote` included, where it stands for nothing; the
 * count errs high there, never low.
 */
function exceedsSlotLimit(tree: JsonCodecValue, slotLimit: number): boolean {
  let slots = 0;
  const pending: JsonCodecValue[] = [tree];
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (!isObjectOrArray(value)) continue;
    if (Array.isArray(value)) {
      slots += value.length;
      if (slots > slotLimit) return true;
      for (const entry of value) {
        const run = holeRunLength(entry);
        if (run !== undefined && run > 1) {
          slots += run - 1;
          if (slots > slotLimit) return true;
        }
        pending.push(entry);
      }
    } else {
      for (const key in value) {
        if (++slots > slotLimit) return true;
        pending.push(value[key]!);
      }
    }
  }
  return false;
}

/**
 * Returns the count `entry` carries if it is a `/hole` run with a numeric
 * count, and `undefined` otherwise. The count is not validated: the decode
 * refuses one that is not a positive integer, and here only its size matters.
 */
function holeRunLength(entry: JsonCodecValue): number | undefined {
  if (!isObjectNotArray(entry) || !isEncodedInstance(entry)) return undefined;
  const count = entry[`/${CODEC_META_TAGS.hole}`];
  return typeof count === "number" ? count : undefined;
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
