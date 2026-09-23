import { isObjectOrArray } from "@commonfabric/utils/types";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import type { FabricValue } from "@/interface.ts";
import { BaseEncodeAct } from "@/codec-common";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { isEncodedInstance } from "./wire-text.ts";

/**
 * One act of encoding a `FabricValue` to this format's JSON text.
 *
 * JSON is also its own escape mechanism here: a tagged form is a `/`-keyed
 * object, so a plain object carrying such a key is ambiguous with one, and the
 * quoting this class applies is what tells the two apart on the way back. An
 * array is the other place the format expresses something JSON cannot, a hole
 * being neither `null` nor absent.
 */
export class JsonEncodeAct extends BaseEncodeAct<JsonCodecValue, string> {
  /**
   * @inheritDoc
   *
   * Stringifies the walked tree and prefixes the format tag.
   */
  override serializedFromEncoded(
    encoded: JsonCodecValue,
  ): string {
    return ENCODING_PREFIX_TAG + JSON.stringify(encoded);
  }

  /**
   * @inheritDoc
   *
   * Prepends `/` to the tag to produce the JSON key. See `3-json-encoding.md`
   * Section 2.
   *
   * The result is not frozen. An encode-side tree is stringified and
   * discarded without ever reaching a caller, so the deep-frozen invariant
   * `JsonCodecValue` states does not cover it, and freezing every tagged node
   * on the way out is measurable on small values. The meta-tag call sites
   * below freeze what they build, where the cost is already paid by the
   * rebuild around it.
   */
  protected override wrapTag(
    tag: string,
    state: JsonCodecValue,
  ): JsonCodecValue {
    return { [`/${tag}`]: state } as JsonCodecValue;
  }

  /**
   * @inheritDoc
   *
   * A run of holes is represented as a `/hole` count, JSON having no way
   * to write an absent index.
   */
  protected override encodeArray(
    value: readonly FabricValue[],
  ): JsonCodecValue {
    this.enter(value);

    const result: JsonCodecValue[] = [];
    try {
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(
            Object.freeze(this.wrapTag(CODEC_META_TAGS.hole, count)),
          );
        } else {
          result.push(this.encodeValue(value[i]!));
          i++;
        }
      }
    } finally {
      this.leave(value);
    }

    return result as JsonCodecValue;
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in UTF-8 byte order, matching the canonical order
   * `value-hash.ts` uses, so that this encoding is deterministic across
   * implementations and across objects whose keys differ only in insertion
   * order. See `3-json-encoding.md` Section 10.
   *
   * A `/`-prefixed key collides with the tag form, so an object bearing one is
   * escaped per `3-json-encoding.md` Section 6: all values are encoded first,
   * and if every one is quote-safe the whole object is wrapped in `/quote` with
   * any `/quote` children collapsed into it, and otherwise in `/object` so that
   * the decoder walks the entries.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
  ): JsonCodecValue {
    this.enter(value);

    // TODO(danfuzz): The UTF-8 order computed here does not survive the
    // assignment below. JavaScript enumerates integer-index-like keys first
    // and in numeric order, so an object carrying `"10"` and `"2"` is written
    // in the wrong order however this walk sorted them, and `JSON.stringify()`
    // never sees the order this loop chose. Section 10 of the formal spec
    // requires the UTF-8 order, so serializing the members directly -- rather
    // than by way of an object whose enumeration reorders them -- is what
    // would actually deliver it.
    const result: Record<string, JsonCodecValue> = {};
    let anySlashKey = false;
    try {
      for (const key of utf8SortedKeysOf(value)) {
        JsonEncodeAct.assertEncodableKey(key);

        if (key.startsWith("/")) {
          anySlashKey = true;
        }
        result[key] = this.encodeValue(value[key]!);
      }
    } finally {
      this.leave(value);
    }

    if (anySlashKey) {
      if (Object.values(result).every((v) => JsonEncodeAct.#isQuoteSafe(v))) {
        const unquoted = Object.freeze(
          Object.fromEntries(
            Object.entries(result).map((
              [k, v],
            ) => [k, JsonEncodeAct.#unquote(v)]),
          ),
        );
        return Object.freeze(
          this.wrapTag(CODEC_META_TAGS.quote, unquoted),
        );
      }
      return Object.freeze(this.wrapTag(CODEC_META_TAGS.object, result));
    }

    return result as JsonCodecValue;
  }

  /**
   * Returns true if the already-encoded codec value `v` can be embedded
   * inside a /quote wrap without inner decoding: primitives, plain
   * objects/arrays free of non-/quote encoded instances, and /quote-wrapped
   * values (which `#unquote()` can collapse).
   */
  static #isQuoteSafe(v: JsonCodecValue): boolean {
    if (!isObjectOrArray(v)) return true;
    if (Array.isArray(v)) {
      return v.every((item) => JsonEncodeAct.#isQuoteSafe(item));
    }
    if (!isEncodedInstance(v)) {
      return Object.values(v).every((item) =>
        JsonEncodeAct.#isQuoteSafe(item as JsonCodecValue)
      );
    }
    return Object.keys(v)[0] === "/quote";
  }

  /**
   * Unwraps /quote forms one level so their literal content can be embedded
   * directly inside a parent /quote. The inner content of a /quote is already
   * literal and must not be recursed into.
   */
  static #unquote(v: JsonCodecValue): JsonCodecValue {
    if (!isObjectOrArray(v)) {
      return v;
    } else if (Array.isArray(v)) {
      const result = v.map(JsonEncodeAct.#unquote) as JsonCodecValue;
      return Object.freeze(result);
    } else if (
      isEncodedInstance(v) && Object.keys(v)[0] === "/quote"
    ) {
      return (v as Record<string, JsonCodecValue>)["/quote"]!;
    } else {
      const result = Object.fromEntries(
        Object.entries(v).map(
          ([k, val]) => [k, JsonEncodeAct.#unquote(val as JsonCodecValue)],
        ),
      ) as JsonCodecValue;
      return Object.freeze(result);
    }
  }
}
