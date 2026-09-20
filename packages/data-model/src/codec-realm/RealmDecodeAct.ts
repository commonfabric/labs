import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseDecodeAct, ProblematicStateError } from "@/codec-common";
import { debugStr } from "@/value-debug";
import {
  REALM_FORMAT_VERSION,
  type RealmCodecValue,
  type RealmEncodedValue,
  type RealmFormatMarker,
} from "./interface.ts";
import { markerOf } from "./marker.ts";

/**
 * One act of decoding for the realm boundary, and the marker read off the
 * envelope that arrived.
 *
 * The marker is the sender's, taken off the envelope by {@link
 * #encodedFromSerializedForm}, and what every tagged form beneath that envelope
 * is checked against: a form carrying anything else is data rather than
 * structure.
 */
export class RealmDecodeAct
  extends BaseDecodeAct<RealmCodecValue, RealmEncodedValue> {
  /**
   * The marker this act's envelope arrived with, and `undefined` until
   * {@link #encodedFromSerializedForm} has taken one off it. Nothing reads it
   * before then: that method runs first, exactly once, and the walk it feeds
   * is what reads this.
   */
  #marker: RealmFormatMarker | undefined;

  /**
   * @inheritDoc
   *
   * Checks the outer envelope in full before anything is read from it -- two
   * elements, headed by a one-element array holding this format's version --
   * and returns what it wraps. Refusing by throwing lets the base settle it
   * against `lenient`, so a peer's malformed envelope degrades to a
   * `ProblematicValue` where a lenient caller asked for that.
   */
  override encodedFromSerializedForm(
    data: RealmEncodedValue,
  ): RealmCodecValue {
    if (!Array.isArray(data) || (data.length !== 2)) {
      throw new ProblematicStateError(
        "",
        data,
        "not a value this format emits: expected a two-element outer envelope",
      );
    }

    const marker = markerOf(data);

    if (!marker) {
      throw new ProblematicStateError(
        "",
        data,
        `not a value this format emits: expected an outer envelope headed by a ${
          backtickQuote(REALM_FORMAT_VERSION)
        } marker`,
      );
    }

    this.#marker = marker;

    return data[1] as RealmCodecValue;
  }

  /**
   * @inheritDoc
   *
   * Every object node goes through the guard, whichever arm then takes it. The
   * tagged form needs it as much as a container does: `decodeTagged()` walks
   * the state again for a nonterminal codec, for a tag no codec claims, and
   * for a tag that is not one, so a graph of tagged forms can close a cycle
   * with no plain container in it at all, and cloning carries such a graph
   * faithfully.
   */
  override decodeValue(
    data: RealmCodecValue,
  ): FabricValue {
    // Self-representing primitives pass straight through. A `symbol` and a
    // function are not among them and are refused here rather than returned:
    // cloning carries neither, so neither can reach this across the boundary
    // -- but `decode()` is callable in the realm that built its argument, and
    // what this format never emits is refused wherever it is found rather
    // than only where a transport would have stopped it. `encode()` refuses
    // both too, from the other side.
    if (data === null) {
      return null;
    }

    if ((typeof data === "symbol") || (typeof data === "function")) {
      return this.reportMalformed(
        "",
        data,
        `Cannot decode ${typeof data}: not a form this format emits.`,
      );
    }

    if (typeof data !== "object") {
      return data as FabricValue;
    }

    {
      const cycle = this.enterOrReport(data);
      if (cycle !== null) {
        return cycle;
      }
    }

    try {
      const unwrapped = this.#unwrapTag(data);

      if (unwrapped !== null) {
        return this.decodeTagged(unwrapped.tag, unwrapped.state);
      } else if (Array.isArray(data)) {
        return this.#decodeArray(data);
      } else if (isPlainObject(data)) {
        return this.#decodePlainObject(data);
      }

      // Cloning carries a good deal this format never emits -- a bare
      // `Uint8Array`, a `Date`, a multi-entry `Map` -- all of which reach here
      // if the far side is a different build.
      return this.reportMalformed(
        "",
        data,
        debugStr`Cannot decode $quote${data}: not a form this format emits.`,
      );
    } finally {
      this.leave(data);
    }
  }

  /**
   * Decodes an array. Holes arrive as holes and are left alone, so there is no
   * run-length form to validate, and so no count off the wire that could name
   * a length an array cannot hold.
   *
   * Frozen on the way out whether it was rebuilt or passed through, per what
   * `4-realm-encoding.md` Section 5.2 says a caller cedes to it.
   */
  #decodeArray(
    data: readonly RealmCodecValue[],
  ): FabricValue {
    const length = data.length;
    let result: FabricValue[] | undefined;

    for (let i = 0; i < length; i++) {
      if (!(i in data)) {
        continue;
      }

      const original = data[i]!;
      const decoded = this.decodeValue(original);

      if (result !== undefined) {
        result[i] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = new Array<FabricValue>(length);
        for (let j = 0; j < i; j++) {
          if (j in data) {
            result[j] = data[j] as FabricValue;
          }
        }
        result[i] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  /**
   * Decodes a plain object. A `/`-prefixed key needs no attention, unlike
   * under JSON: this format reserves no key at all, its tags living in a
   * container a payload cannot produce.
   *
   * Frozen on the way out whether it was rebuilt or passed through, per what
   * `4-realm-encoding.md` Section 5.2 says a caller cedes to it.
   */
  #decodePlainObject(
    data: Record<string, RealmCodecValue>,
  ): FabricValue {
    const keys = Object.keys(data);
    let result: Record<string, FabricValue> | undefined;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;

      if (isUnsafeObjectKey(key)) {
        return this.reportReservedKey(key, data);
      }

      const original = data[key]!;
      const decoded = this.decodeValue(original);

      if (result !== undefined) {
        result[key] = decoded;
      } else if (!Object.is(decoded, original)) {
        result = {};
        for (let j = 0; j < i; j++) {
          result[keys[j]!] = data[keys[j]!] as FabricValue;
        }
        result[key] = decoded;
      }
    }

    return Object.freeze(result ?? (data as FabricValue));
  }

  /**
   * Unwraps a tagged wire representation. Returns `{ tag, state }`, or `null`
   * if `data` is not one. The `state` is extracted directly from `data`.
   *
   * Slot zero decides, and only by identity: an array of the right length whose
   * first element is some *other* object -- or an equal-looking marker some
   * payload built for itself -- is a payload's own array and is walked as one.
   * Nothing about the shape is evidence, which is why the comparison is `===`
   * and not a structural test.
   *
   * With no marker in hand there is nothing to compare against, so nothing is a
   * tagged form. Stated rather than left to `===`: `undefined` is a value this
   * format carries directly, so a payload can put one in slot zero for free,
   * and identity against an absent marker would match it. The walk reaches here
   * only from `decode()`, which always has one, and this is the counterpart to
   * `wrapTag()` refusing to build a tagged form without one.
   *
   * The tag is handed over as it was found, of whatever type. {@link
   * RealmTaggedValue} says a tag is a `string`, but that describes what this
   * format _emits_, and decoding is where data from somewhere else arrives.
   * Whether what sits there is a tag belongs to `decodeTagged()`, which asks it
   * the same way for every format and settles the answer against `lenient`.
   */
  #unwrapTag(
    data: RealmCodecValue,
  ): { tag: any; state: RealmCodecValue } | null {
    if (
      (this.marker === undefined) || !Array.isArray(data) ||
      (data.length !== 3) || (data[0] !== this.marker)
    ) {
      return null;
    }

    return { tag: data[1], state: data[2] as RealmCodecValue };
  }

  /** The marker this act's envelope arrived with, if any. */
  get marker(): RealmFormatMarker | undefined {
    return this.#marker;
  }
}
