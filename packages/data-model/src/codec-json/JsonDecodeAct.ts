import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseDecodeAct, ProblematicStateError } from "@/codec-common";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { debugStr } from "@/value-debug";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import {
  isEncodedInstance,
  parseWireText,
  seemsLikeEncoded,
} from "./wire-text.ts";

/**
 * One act of decoding this format's JSON text back into `FabricValue`s.
 *
 * The tree this walks comes from a parse, so it cannot be handed a cycle and
 * enters no node: the act's in-progress set is never allocated. What it does
 * police is the boundary between the format's own structure and a payload
 * shaped like it -- the quoting rules, and the explicit runs that stand for
 * array holes.
 */
export class JsonDecodeAct extends BaseDecodeAct<JsonCodecValue, string> {
  /**
   * @inheritDoc
   *
   * Checks the format tag and parses what follows it. A string without the tag
   * is not this format's serialized form at all, which is refused here rather
   * than walked -- and settles against `lenient` like any other malformation
   * off a channel.
   */
  override encodedFromSerializedForm(data: string): JsonCodecValue {
    if (!seemsLikeEncoded(data)) {
      const excerpt = (data.length <= 50) ? data : `${data.slice(0, 50)}...`;
      throw new ProblematicStateError(
        "",
        excerpt,
        `Not a JSON-encoded \`FabricValue\` string: ${backtickQuote(excerpt)}`,
      );
    }

    return parseWireText(
      data.slice(ENCODING_PREFIX_TAG.length),
    );
  }

  /**
   * Decodes a codec-value tree back into `FabricValue`s. See Section 4.5 of
   * the formal spec.
   *
   * Frozen-ness contract: values returned via the codec dispatch arm are
   * guaranteed deep-frozen at this boundary, so callers do not each have to
   * freeze. The unknown-tag fallback (`UnknownValue`) is a separate arm and is
   * intentionally NOT covered by this contract.
   */
  override decodeValue(
    data: JsonCodecValue,
  ): FabricValue {
    const decoded = JsonDecodeAct.#unwrapTag(data);
    if (decoded !== null) {
      const { tag, state: rawState } = decoded;

      // `CODEC_META_TAGS.quote` literal handling (`3-json-encoding.md` Section
      // 6).
      if (tag === CODEC_META_TAGS.quote) {
        // TODO(danfuzz): Quote content is returned whole, so a key this
        // implementation reserves is admitted here where the `/object` and
        // plain-object arms below refuse one. `JSON.parse` makes such a key an
        // own property, so it does arrive, and the result cannot be re-encoded:
        // `BaseEncodeAct.assertEncodableKey()` refuses it. A decode through
        // this arm therefore yields a value that does not round-trip.
        //
        // The format accepts any key, so this arm is the one behaving
        // correctly and the refusals elsewhere are the shortfall
        // (`UNSAFE_OBJECT_KEYS` in `@commonfabric/utils/types`). What is wrong
        // here is only the disagreement: until that set empties, one arm
        // admitting what the others refuse is a round trip that breaks in the
        // middle rather than a refusal a caller can see.
        return rawState;
      }

      // `CODEC_META_TAGS.object` unwrapping (`3-json-encoding.md` Section 6).
      if (tag === CODEC_META_TAGS.object) {
        if (!isPlainObject(rawState)) {
          return this.reportMalformed(
            tag,
            rawState,
            "`/object` state is not an object.",
          );
        }

        const inner = rawState as Record<string, JsonCodecValue>;
        const result: Record<string, FabricValue> = {};
        for (const [key, val] of Object.entries(inner)) {
          // Same reservation as the plain-object arm below: the assignment
          // cannot rebuild these names.
          if (isUnsafeObjectKey(key)) {
            return this.reportReservedKey(key, inner);
          }
          result[key] = this.decodeValue(val);
        }
        return Object.freeze(result);
      }

      // `/quote` and `/object` returned above, so no codec ever sees their
      // state, and `/quote` contents alone go undecoded.
      return this.decodeTagged(tag, rawState);
    }

    // Primitives pass through.
    if (
      data === null || typeof data === "boolean" ||
      typeof data === "number" || typeof data === "string"
    ) {
      return data;
    }

    if (Array.isArray(data)) {
      return this.#decodeArray(data);
    }

    // `Array.isArray()` above removed the array arm, but TypeScript keeps it
    // in the union; the remaining member is the record.
    return this.#decodePlainObject(
      data as Record<string, JsonCodecValue>,
    );
  }

  /**
   * Arrays: recursively decode elements.
   *
   * One pass. A `/hole` run advances the write index past the indices it
   * stands for, leaving them absent, and the final length is set from that
   * index so that a run in the last position is preserved. Counting the
   * logical length first would mean walking and unwrapping every entry a
   * second time, for a number this pass arrives at anyway.
   *
   * The result is still sized up front, at the entry count. That is exact
   * whenever the array has no holes, which is the ordinary case, and an
   * underestimate otherwise -- growing from there beats growing from empty,
   * and a short array of holes is common enough to be worth not pessimizing.
   *
   * A run's count is validated, wire data being untrusted. Left unchecked it
   * is added to the write index directly, so a string concatenates onto it
   * and a negative or fractional one makes the length assignment throw --
   * failures with no bearing on what went wrong. A run stands for at least
   * one absent index, and anything else is reported instead.
   */
  #decodeArray(
    data: readonly JsonCodecValue[],
  ): FabricValue {
    const result: FabricValue[] = new Array(data.length);
    let targetIndex = 0;
    for (const entry of data) {
      const entryDecoded = JsonDecodeAct.#unwrapTag(entry);
      if (
        entryDecoded !== null && entryDecoded.tag === CODEC_META_TAGS.hole
      ) {
        const count = entryDecoded.state;
        if (!JsonDecodeAct.#isHoleCount(count)) {
          return this.reportMalformed(
            CODEC_META_TAGS.hole,
            count,
            debugStr`hole: expected a positive integer count, got $quote${count}`,
          );
        }
        targetIndex += count;
      } else {
        result[targetIndex] = this.decodeValue(entry);
        targetIndex++;
      }
    }

    // The total is bounded here rather than each advance being bounded as
    // it happens, because both a single run and the running total can pass
    // what an array may hold, and one check at the end covers both. Beyond
    // that, the assignment below throws `RangeError` from the array
    // machinery, which says nothing about the wire that caused it.
    const MAX_ARRAY_LENGTH = 0xffff_ffff;
    if (targetIndex > MAX_ARRAY_LENGTH) {
      return this.reportMalformed(
        CODEC_META_TAGS.hole,
        data,
        `hole: runs total ${targetIndex} elements, past the ` +
          `${MAX_ARRAY_LENGTH} an array can hold`,
      );
    }

    result.length = targetIndex;
    return Object.freeze(result);
  }

  /**
   * Plain objects: recursively decode values and freeze. Any `/`-prefixed key
   * is reserved per spec — return `ProblematicValue` on first occurrence rather
   * than silently round-tripping the object.
   */
  #decodePlainObject(
    data: Record<string, JsonCodecValue>,
  ): FabricValue {
    const result: Record<string, FabricValue> = {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith("/")) {
        return this.reportMalformed(
          key.slice(1),
          data,
          `object contains reserved /-prefixed key: "${key}"`,
        );
      }
      // A name this runtime reserves cannot be rebuilt by the assignment
      // below: `__proto__` would repoint the result's prototype instead of
      // becoming a property. Such a record cannot have been written by this
      // implementation, whose write path refuses it, so report it rather than
      // decoding something the bytes do not say.
      if (isUnsafeObjectKey(key)) {
        return this.reportReservedKey(key, data);
      }
      result[key] = this.decodeValue(val);
    }
    return Object.freeze(result);
  }

  /**
   * Unwraps a wire representation. Detects single-key objects with `/`-prefixed
   * keys. Returns `{ tag, state }` or `null` if not a tagged value. The
   * returned `state` is extracted directly from `data`, so if `data` is
   * deep-frozen (as it should be) then `state` will be too.
   *
   * See `3-json-encoding.md` Section 4.
   */
  static #unwrapTag(
    data: JsonCodecValue,
  ): { tag: string; state: JsonCodecValue } | null {
    if (!isPlainObject(data)) {
      return null;
    }

    if (!isEncodedInstance(data)) {
      return null;
    }

    // `#isEncodedInstance()` guaranteed a single-property object, so this
    // destructures that one entry.
    const [key, value] = Object.entries(data)[0]!;
    return { tag: key.slice(1), state: value };
  }

  /**
   * Indicates whether `count` is usable as a `/hole` run length: a safe
   * integer of at least one. A run always stands for at least one absent
   * index, so zero is refused along with everything else that is not a count.
   */
  static #isHoleCount(count: JsonCodecValue): count is number {
    // `isSafeInteger()` returns `false` for a non-number, but it cannot be a
    // TypeScript type predicate on `number` since it also returns `false` for
    // plenty of numbers. So, the subsequent cast `as number` is safe by
    // construction but is nonetheless required.
    return Number.isSafeInteger(count) && ((count as number) >= 1);
  }
}
