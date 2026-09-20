import { isPlainObject } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import {
  CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
} from "@/codec-interface/interface.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { toReportableState } from "./toReportableState.ts";
import { toReportableTag } from "./toReportableTag.ts";

/**
 * The encoded state of a {@link ProblematicValue}: its three preserved facts,
 * the tag among them. What was at fault is data here rather than wire
 * structure, which is what lets an instance reporting a malformed tag be
 * encoded at all.
 */
type ProblematicValueState = {
  tag: string;
  state: FabricValue;
  error: string;
};

/**
 * Container for a value whose encoding or decoding failed. Preserves the tag
 * and raw state at fault, for round-tripping and debugging. Used in lenient
 * mode to allow graceful degradation rather than hard failures. See Section 3.5
 * of the formal spec.
 *
 * Both of the things it preserves are whatever was at fault, which is why the
 * constructor takes anything at all for either: the one thing this class must
 * not do is fail while reporting a failure. What can be kept is kept exactly,
 * and anything else is replaced by a debug rendering of itself --
 * `toReportableState()` for the state, `toReportableTag()` for the tag.
 *
 * A rendering is deliberately not a conversion. A `Uint8Array` could be turned
 * into a `FabricBytes` and a `RegExp` into a `FabricRegExp`, and doing so would
 * misreport the wire: a reader would find a `FabricBytes` in `state` and
 * conclude the payload carried one, when it carried raw bytes this format does
 * not accept. A string plainly reads as a description of the value rather than
 * the value, which is the honest answer where fidelity is not available.
 *
 * **This class encodes under a tag of its own**, `Problematic@1`, and carries
 * the preserved tag as data beside the state and the error. `UnknownValue` does
 * the opposite, round-tripping to the tag it preserved -- and can, because that
 * tag is a real tag. Here the preserved tag need not be one: reporting a
 * malformed tag is among the things this class is for, and a value whose whole
 * content is "this tag was not a tag" cannot go back out under that tag.
 * Encoding under a fixed tag keeps the wire form decodable whatever was
 * preserved, and keeps it a single shape rather than one shape per kind of
 * fault.
 */
export class ProblematicValue extends BaseFabricInstance {
  /** The value of {@link #wireTypeTag}. */
  readonly #wireTypeTag: string;

  /** The value of {@link #state}. */
  readonly #state: FabricValue;

  /** Value for {@link #error}. */
  readonly #error: string;

  /**
   * Constructs an instance for the given tag and state, with `error`
   * describing what went wrong.
   *
   * @param wireTypeTag - The tag the faulty data arrived under, of any type
   *   whatsoever. Kept as-is if it is a string, and otherwise replaced by a
   *   debug rendering.
   * @param state - What was at fault, of any type whatsoever. Kept as-is if it
   *   is a `FabricValue`, and otherwise replaced by a debug rendering.
   * @param error - Description of what went wrong.
   */
  constructor(wireTypeTag: any, state: any, error: string) {
    super();

    this.#wireTypeTag = toReportableTag(wireTypeTag);
    this.#state = toReportableState(state);
    this.#error = error;
  }

  /** Description of what went wrong. */
  get error(): string {
    return this.#error;
  }

  /** Arbitrary raw instance state. */
  get state(): FabricValue {
    return this.#state;
  }

  /**
   * The tag preserved for this instance, which is what arrived in tag position
   * and so need not be a well-formed tag. It is not the tag this value encodes
   * under; that is `Problematic@1`, fixed for the class.
   */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /**
   * Indicates whether `other` is an instance reporting this same fault: the
   * same tag, the same error, and the same state by identity.
   *
   * State is compared by identity rather than by content, as `equals()` does
   * across this codebase; `valueEqual()` is the content comparison. That is
   * also what this is for -- asking whether an account of a failure already in
   * hand says what a fresh one would -- where both sides came through this
   * class's own normalization and so are the same object when they match at
   * all.
   */
  equals(other: any): boolean {
    return (other instanceof ProblematicValue) &&
      (other.wireTypeTag === this.wireTypeTag) &&
      (other.error === this.error) &&
      Object.is(other.state, this.state);
  }

  /** Deep-freezes in place. */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.state);
    Object.freeze(this);
    return this;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * wrapper is frozen and `state` is recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) && subIsDeepFrozen(this.state);
  }

  /** @inheritDoc Not yet implemented, so `deepClone()` throws. */
  protected [DEEP_CLONE_CORE](_frozen: boolean): ProblematicValue {
    throw new Error("Cannot yet handle deep cloning of `ProblematicValue`.");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): ProblematicValue {
    return new ProblematicValue(this.wireTypeTag, this.state, this.error);
  }

  static #codec = Object.freeze(
    new (class ProblematicValueCodec
      extends BaseNonterminalCodec<never, ProblematicValueState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Problematic, ProblematicValue);
      }

      /** @inheritDoc */
      encode(
        value: ProblematicValue,
        _env: LiveEnvironment,
      ): ProblematicValueState {
        return {
          tag: value.wireTypeTag,
          state: value.state,
          error: value.error,
        };
      }

      /**
       * @inheritDoc
       *
       * `tag` and `error` must be strings; `state` need only be present.
       */
      canDecode(state: FabricValue): state is ProblematicValueState {
        // Every `FabricValue` is a valid state, `undefined` among them, so an
        // absent property is the only thing that marks a record this codec did
        // not write -- and accepting one would put it back on the wire with
        // the property filled in, which is a silent reshaping rather than a
        // report.
        return isPlainObject(state) && (typeof state.tag === "string") &&
          (typeof state.error === "string") && Object.hasOwn(state, "state");
      }

      /**
       * @inheritDoc
       *
       * The recursion is one deep: what this produces is well-formed by
       * construction.
       */
      decode(
        _typeTag: string,
        state: ProblematicValueState,
        env: LiveEnvironment,
      ): FabricValue {
        const result = new ProblematicValue(
          state.tag,
          state.state,
          state.error,
        );

        // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen
        // form via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
