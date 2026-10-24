import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

import type { FabricValue } from "@/interface.ts";
import { BaseEncodeAct } from "@/codec-common";
import { CODEC_META_TAGS } from "@/codec-interface/codec-meta-tags.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";

/**
 * What an act tracks from its first `/`-keyed object on, so that each such
 * object can choose its escape when its own walk returns, without walking what
 * it encoded a second time.
 */
type EscapeState = {
  /** How many `/`-keyed objects are being encoded right now. */
  depth: number;

  /**
   * How many forms the act has built that are not quote-safe, which is to say
   * that a `/quote` cannot hold: every tagged value, `/hole` run, and `/object`
   * escape. A subtree is quote-safe exactly when this is the same after
   * encoding it as before.
   */
  unquotableCount: number;

  /**
   * The `/quote` wrap built most recently, or `undefined` before the first. A
   * wrap is a fresh object, so an encoded value is the wrap just built exactly
   * when it is identical to this one.
   */
  latestQuote: JsonCodecValue | undefined;

  /** The literal that `latestQuote` quotes. */
  latestLiteral: JsonCodecValue;

  /**
   * One entry per `/quote` wrap sitting in a container under a `/`-keyed
   * object that is being encoded, kept until the nearest such object is
   * finished. Calling an entry replaces its wrap, where it sits, with the
   * literal it quotes. Entries are in the order their wraps were built, so
   * those under an object are the ones added since its walk began.
   */
  readonly pendingUnwraps: (() => void)[];
};

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
   * The escape bookkeeping, or `undefined` until this act encodes its first
   * `/`-keyed object, so that an act which encodes none allocates nothing for
   * it.
   */
  #escape: EscapeState | undefined;

  //
  // Instance members
  //

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
   * Every form built here is one a `/quote` cannot hold, this class's own
   * `/hole` and `/object` forms included, and is counted as such. A `/quote`
   * wrap is the one `/`-keyed form that is not built here.
   *
   * The result is not frozen, and neither is anything else this act builds. An
   * encode-side tree is stringified and discarded without ever reaching a
   * caller, so the deep-frozen invariant `JsonCodecValue` states does not
   * cover it, and freezing every tagged node on the way out is measurable on
   * small values.
   */
  protected override wrapTag(
    tag: string,
    state: JsonCodecValue,
  ): JsonCodecValue {
    // With no bookkeeping there has been no `/`-keyed object, and so there is
    // nothing whose quote-safety this form could decide.
    const escape = this.#escape;
    if (escape !== undefined) {
      escape.unquotableCount++;
    }

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
    const tracking = JsonEncodeAct.#ifEscaping(this.#escape);
    try {
      let i = 0;
      while (i < value.length) {
        if (!(i in value)) {
          let count = 0;
          while (i < value.length && !(i in value)) {
            count++;
            i++;
          }
          result.push(this.wrapTag(CODEC_META_TAGS.hole, count));
        } else {
          const encoded = this.encodeValue(value[i]!);

          result.push(encoded);
          if (tracking !== undefined && encoded === tracking.latestQuote) {
            JsonEncodeAct.#deferUnwrap(tracking, result, result.length - 1);
          }
          i++;
        }
      }
    } finally {
      this.leave(value);
    }

    return result;
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in UTF-8 byte order, matching the canonical order
   * `ValueHasher` uses, so that this encoding is deterministic across
   * implementations and across objects whose keys differ only in insertion
   * order. See `3-json-encoding.md` Section 10.
   *
   * A `/`-prefixed key collides with the tag form, so an object bearing one is
   * escaped per `3-json-encoding.md` Section 6. If everything under it is
   * quote-safe, the whole object is wrapped in `/quote`, with each `/quote`
   * wrap beneath it replaced by the literal that one quotes, and otherwise it
   * is wrapped in `/object` so that the decoder walks the entries.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
  ): JsonCodecValue {
    // TODO(danfuzz): The UTF-8 order computed here does not survive the
    // assignment below. JavaScript enumerates integer-index-like keys first
    // and in numeric order, so an object carrying `"10"` and `"2"` is written
    // in the wrong order however this walk sorted them, and `JSON.stringify()`
    // never sees the order this loop chose. Section 10 of the formal spec
    // requires the UTF-8 order, so serializing the members directly -- rather
    // than by way of an object whose enumeration reorders them -- is what
    // would actually deliver it. The case
    // `record keys that read as integers` in
    // `packages/data-model/test/fixtures/fvj1-conformance.json` records it.
    const keys = utf8SortedKeysOf(value);

    this.enter(value);

    const result: Record<string, JsonCodecValue> = {};

    // `escaped` is the bookkeeping if this object is itself `/`-keyed, and
    // `tracking` is the bookkeeping if this object or one enclosing it is. The
    // two counts are read only for an escaped object.
    const escaped = JsonEncodeAct.#anySlashKey(keys)
      ? (this.#escape ??= {
        depth: 0,
        unquotableCount: 0,
        latestQuote: undefined,
        latestLiteral: null,
        pendingUnwraps: [],
      })
      : undefined;
    const tracking = escaped ?? JsonEncodeAct.#ifEscaping(this.#escape);
    const unquotableBefore = escaped?.unquotableCount ?? 0;
    const unwrapsBefore = escaped?.pendingUnwraps.length ?? 0;

    if (escaped !== undefined) {
      escaped.depth++;
    }
    try {
      for (const key of keys) {
        JsonEncodeAct.assertEncodableKey(key);

        const encoded = this.encodeValue(value[key]!);

        result[key] = encoded;
        if (tracking !== undefined && encoded === tracking.latestQuote) {
          JsonEncodeAct.#deferUnwrap(tracking, result, key);
        }
      }
    } finally {
      if (escaped !== undefined) {
        escaped.depth--;
      }
      this.leave(value);
    }

    if (escaped === undefined) {
      return result;
    }

    const unwraps = escaped.pendingUnwraps;

    if (escaped.unquotableCount !== unquotableBefore) {
      // Something under this object is not quote-safe, which is as true of
      // every object enclosing it, so nothing will quote the wraps beneath.
      unwraps.length = unwrapsBefore;
      return this.wrapTag(CODEC_META_TAGS.object, result);
    }

    // Everything under this object is literal but for the wraps beneath it,
    // and a wrap left inside a `/quote` decodes as a plain object keyed
    // `/quote`. So each is replaced by the literal it quotes.
    for (let at = unwrapsBefore; at < unwraps.length; at++) {
      unwraps[at]!();
    }
    unwraps.length = unwrapsBefore;

    const quote = { [`/${CODEC_META_TAGS.quote}`]: result };
    escaped.latestQuote = quote;
    escaped.latestLiteral = result;
    return quote;
  }

  //
  // Static members
  //

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }

  /**
   * Indicates whether any of `keys` is `/`-prefixed, given them in UTF-8 byte
   * order. That order puts the `/`-prefixed keys together, after nothing but
   * the empty key and keys whose first character is below `/`, so the first
   * key past those decides it.
   */
  static #anySlashKey(keys: readonly string[]): boolean {
    const slash = 0x2f;

    for (let at = 0; at < keys.length; at++) {
      // `NaN` for the empty key, which is neither of these.
      const first = keys[at]!.charCodeAt(0);

      if (first === slash) {
        return true;
      } else if (first > slash) {
        return false;
      }
    }

    return false;
  }

  /**
   * Returns `escape` if a `/`-keyed object is being encoded, and `undefined`
   * otherwise. A container tracks the `/quote` wraps among its members only in
   * the first case, because a wrap with no such object around it is never
   * replaced.
   */
  static #ifEscaping(
    escape: EscapeState | undefined,
  ): EscapeState | undefined {
    return (escape !== undefined && escape.depth > 0) ? escape : undefined;
  }

  /**
   * Helper for the two container walks, which records that `holder[key]` is
   * the wrap `escape.latestQuote`, so that an enclosing `/quote` can put the
   * literal there instead. The walks call this for a wrap alone, which is what
   * keeps their loops from allocating anything for the members that are not
   * one.
   */
  static #deferUnwrap<K extends PropertyKey>(
    escape: EscapeState,
    holder: Record<K, JsonCodecValue>,
    key: K,
  ): void {
    const literal = escape.latestLiteral;

    escape.pendingUnwraps.push(() => {
      holder[key] = literal;
    });
  }
}
