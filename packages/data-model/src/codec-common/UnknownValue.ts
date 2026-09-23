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
import { deepFreeze } from "@/deep-freeze.ts";
import { isCodecTypeTag } from "./isCodecTypeTag.ts";
import { ProblematicStateError } from "./ProblematicStateError.ts";

/**
 * Container for an unrecognized type's data, used for round-tripping. When the
 * codec system encounters a tag no codec claims during decoding, it wraps the
 * tag and state here; on re-encoding, the preserved pair reproduces the
 * original wire form. See Section 3.3 of the formal spec.
 *
 * The tag is a real tag, checked at construction. That is what makes the round
 * trip a promise rather than a hope: this class encodes back to `<its tag>`
 * over its state, so a tag a decoder would refuse would make an instance that
 * encodes and cannot be read back. A tag that is not a tag is not an unknown
 * type -- it names no type at all -- and belongs in a `ProblematicValue`, which
 * is built to carry one.
 */
export class UnknownValue extends BaseFabricInstance {
  /** The value of {@link #wireTypeTag}. */
  readonly #wireTypeTag: string;

  /** The value of {@link #state}. */
  readonly #state: FabricValue;

  /**
   * Constructs an instance for the given unrecognized tag and its state.
   *
   * @param wireTypeTag - The tag this value arrived under.
   * @param state - The raw state under that tag.
   * @throws If `wireTypeTag` is not a codec type tag.
   */
  constructor(wireTypeTag: string, state: FabricValue) {
    super();

    if (!isCodecTypeTag(wireTypeTag)) {
      throw new ProblematicStateError(
        wireTypeTag,
        state,
        "Not a codec type tag, so nothing encoded under it could be " +
          "decoded. Use a `ProblematicValue`.",
      );
    }

    this.#wireTypeTag = wireTypeTag;
    this.#state = state;
  }

  /** Arbitrary raw instance state. */
  get state(): FabricValue {
    return this.#state;
  }

  /**
   * The tag preserved for this instance. Unlike other fabric types -- whose
   * tag is a per-class constant carried by the class's `[CODEC]` -- this class
   * carries a per-instance tag, the tag of a value whose type nothing here
   * knows, which its codec's `tagForValue()` reads back.
   */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
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
  protected [DEEP_CLONE_CORE](_frozen: boolean): UnknownValue {
    throw new Error("Cannot yet handle deep cloning of `UnknownValue`.");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): UnknownValue {
    return new UnknownValue(this.wireTypeTag, this.state);
  }

  static #codec = Object.freeze(
    new (class UnknownValueCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
      constructor() {
        // No preferred wire tag: an `UnknownValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, UnknownValue);
      }

      /** @inheritDoc */
      override tagForValue(value: UnknownValue): string {
        return value.wireTypeTag;
      }

      /** @inheritDoc */
      encode(value: UnknownValue, _env: LiveEnvironment): FabricValue {
        return value.state;
      }

      /** @inheritDoc */
      canDecode(_state: FabricValue): _state is FabricValue {
        // What arrives under a tag no registry claims is preserved rather than
        // interpreted, so there is no shape it could fail to have.
        return true;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        const result = new UnknownValue(typeTag, state);
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
