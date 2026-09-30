import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  isObjectOrArray,
  isPlainObject,
  isUnsafeObjectKey,
} from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { isFabricSpecialObject } from "@/types";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type {
  CodecForFormat,
  NonterminalCodec,
  TerminalCodec,
} from "@/codec-interface/interface.ts";
import { debugStr } from "@/value-debug";
import { BaseCodecAct } from "./BaseCodecAct.ts";
import { SELF_REP } from "./CodecRegistry.ts";

/**
 * One act of encoding: what {@link BaseCodecAct} holds, the walk that turns a
 * `FabricValue` into this format's transport tree, and the format's own account
 * of how a container is written down.
 *
 * An engine mints one of these per `encode()` call, through a factory its
 * subclass supplies. What a format supplies is a subclass of this, which is
 * where the two type parameters land: `Encoded` is the transport tree the walk
 * and the codecs work in, and `SerializedForm` is what crosses the format's
 * public boundary. They differ where a format reduces its tree by a further
 * step -- JSON stringifies -- and a format whose tree is what crosses leaves
 * the second to default to the first.
 *
 * The division is between what a format decides and what it must not. This
 * class settles the second: a self-representing value is emitted as it stands,
 * a value matching no codec is either a container or an error, a terminal
 * codec's state is final where a nonterminal one's is walked again, and a tag
 * comes from `tagForValue()` rather than from the value. None of those is a
 * property of a wire format, and every one is a decision a walk could quietly
 * get wrong: a state expanded when it should have been passed through, or the
 * reverse, surfaces far from the dispatch that decided it, and where a state
 * is a record of strings the two choices emit byte-identical output.
 *
 * What a subclass owns is everything about containers, and that is where a
 * format is entitled to differ: whether keys are ordered, whether a key can
 * collide with the tag form and so needs escaping, and how an absent array
 * index is written down. A format that answers those differently is not
 * varying an implementation detail; it is being a different format.
 */
export abstract class BaseEncodeAct<Encoded, SerializedForm = Encoded>
  extends BaseCodecAct<Encoded> {
  //
  // Subclass contract
  //

  /**
   * Converts the walk's finished tree into this format's serialized form -- a
   * stringify step, an envelope, or nothing at all for a format whose tree is
   * what crosses. Called once, on the tree this act built.
   */
  abstract serializedFromEncoded(encoded: Encoded): SerializedForm;

  /**
   * Encodes an array, which is this format's business entirely.
   *
   * An implementation owes this act one thing: the container goes in through
   * {@link #enter} and comes back out through {@link #leave} however the
   * descent ends, a throw included. The act outlives a throw, belonging to the
   * call rather than to the node, so an entry left behind makes a later visit
   * to the same value report a cycle that is not there.
   */
  protected abstract encodeArray(value: readonly FabricValue[]): Encoded;

  /**
   * Encodes a plain object, which is this format's business entirely. Owes the
   * same enter/leave discipline {@link #encodeArray} states.
   */
  protected abstract encodePlainObject(
    value: Record<string, FabricValue>,
  ): Encoded;

  /** Wraps a tag and state into this format's tagged wire form. */
  protected abstract wrapTag(tag: string, state: Encoded): Encoded;

  //
  // Instance members
  //

  /**
   * Enters a value, refusing a repeat visit.
   *
   * @throws If `value` is already being encoded. A cycle has no encoding at
   *   all, so this refuses rather than reporting, unlike its decode-side
   *   counterpart: what is being refused is a local caller's own value, not
   *   data off a channel.
   */
  enter(value: object): void {
    if (!this.tryEnter(value)) {
      throw new Error("Circular reference detected during encoding");
    }
  }

  /**
   * Encodes a `FabricValue` into the transport tree, dispatching on what the
   * registry says about it and handing a container to this format's own arms.
   *
   * @throws If `value` holds something the format cannot carry: a
   *   `FabricSpecialObject` whose class no codec in the registry claims, a
   *   cycle, or an object that is no kind of `FabricValue` at all.
   */
  encodeValue(value: FabricValue): Encoded {
    const matched = this.registry.codecFromValue(value);

    if (matched === SELF_REP) {
      // A self-representing primitive is its own wire form.
      return value as Encoded;
    } else if (matched) {
      // `value` matched from the registry as either a non-self-representing
      // primitive or a `FabricSpecialObject`.
      return this.#encodeTagged(value, matched);
    } else if (Array.isArray(value)) {
      return this.encodeArray(value);
    } else if (isPlainObject(value, false)) {
      // Note: `isPlainObject()` means what it says; notably, it returns `false`
      // for `FabricSpecialObject`s. A record is `Object.prototype`-rooted, and
      // a null-prototype object is refused below rather than written as one.
      return this.encodePlainObject(value);
    }

    // At this point, we know `value` can't be encoded. We just need to figure
    // out the right error message.

    if (isFabricSpecialObject(value)) {
      throw new Error(
        `No codec registered for \`FabricSpecialObject\` subclass ${
          backtickQuote(value.constructor.name)
        }.`,
      );
    } else {
      // `value` is a primitive (`null` included, under a registry that does
      // not claim it), a function, a null-prototype object, or a
      // non-`FabricSpecialObject` instance (non-plain object). Distinguish them
      // in the error message. The notable primitive case here is uninterned
      // symbols (which are forbidden by the data model but cannot be forbidden
      // in the type system). The object and function cases are all almost
      // certainly due to something upstream lying about the type of `value`.
      const typeName = typeof value;
      const label = (typeName !== "object")
        ? typeName
        : (value === null)
        ? "null"
        : (Object.getPrototypeOf(value) === null)
        ? "null-prototype object"
        : "instance";
      throw new Error(
        debugStr`Cannot encode ${label} $quote${value}: no applicable codec.`,
      );
    }
  }

  /** Encodes one value through the codec the registry matched to it. */
  #encodeTagged(value: FabricValue, matched: CodecForFormat<Encoded>): Encoded {
    const isObject = isObjectOrArray(value);

    if (isObject) {
      this.enter(value as object);
    }

    // `tagForValue()` rather than any direct property of `value`, because the
    // value need not know which codec is being used for it: the tag is the
    // codec's determination, not the value's.
    //
    // A terminal codec's state is already in this format's domain, so it is
    // final; a nonterminal codec's is made of `FabricValue`s, which this walk
    // has yet to expand.
    let tag: string;
    let state: Encoded;

    try {
      tag = matched.tagForValue(value);
      state = (matched instanceof BaseTerminalCodec)
        ? (matched as TerminalCodec<Encoded>).encode(value, this.env)
        : this.encodeValue(
          (matched as NonterminalCodec).encode(value, this.env),
        );
    } finally {
      // Left in a `finally` because `tagForValue()` and a codec's `encode()`
      // can both throw. The act outlives a throw -- it belongs to the call,
      // not to this node -- so an entry left behind would make a later visit
      // to the same value report a cycle that is not there.
      if (isObject) {
        this.leave(value as object);
      }
    }

    return this.wrapTag(tag, state);
  }

  //
  // Static members
  //

  /**
   * Refuses a key this runtime reserves on the way out.
   *
   * Encoding one cannot be made faithful. A rebuild by assignment drops
   * `__proto__` where the host routes it through an inherited setter, and
   * where it does not, the result is text a decoder refuses on the way back --
   * so a value carrying one is either quietly damaged or written and never
   * readable. Both are worse than a refusal, and the caller is local code
   * whose value this is, rather than a channel handing over data.
   *
   * @throws If `key` is one this runtime reserves.
   */
  protected static assertEncodableKey(key: string): void {
    if (isUnsafeObjectKey(key)) {
      throw new Error(
        `Cannot encode an object with a key this runtime reserves: ${
          backtickQuote(key)
        }`,
      );
    }
  }
}
