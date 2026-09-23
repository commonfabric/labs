import type { FabricValue } from "@/interface.ts";
import {
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
import { FrozenSet } from "@/frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Set` instances. Stub -- the static `[CODEC]` (the source of
 * truth) throws until `Set` support is fully implemented. Extra properties
 * beyond the wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  #set: Set<FabricValue>;

  /** Constructs an instance wrapping `set`. */
  constructor(set: Set<FabricValue>) {
    super();
    this.#set = set;
  }

  /** The wrapped set. */
  get set(): Set<FabricValue> {
    return this.#set;
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. The protocol
   * methods throw rather than approximate, so that no caller can come to depend
   * on an answer that would have to be taken back.
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("`FabricSet`: not yet implemented");
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("`FabricSet`: not yet implemented");
  }

  /** @inheritDoc */
  protected get wrappedValue(): Set<FabricValue> {
    return this.#set;
  }

  /** @inheritDoc */
  protected [SHALLOW_UNFROZEN_CLONE](): FabricSet {
    return new FabricSet(this.#set);
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenSet<FabricValue> {
    return new FrozenSet(this.#set);
  }

  /** @inheritDoc */
  protected toNativeThawed(): Set<FabricValue> {
    return new Set(this.#set);
  }

  static #codec = Object.freeze(
    new (class FabricSetCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Set, FabricSet);
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Set` support is implemented.
       */
      encode(_value: FabricSet, _env: LiveEnvironment): FabricValue {
        throw new Error("`FabricSet`: not yet implemented");
      }

      /**
       * @inheritDoc
       *
       * Stub -- accepts anything until `Set` support is implemented.
       */
      canDecode(_state: FabricValue): _state is FabricValue {
        // The refusal is `decode()`'s, where "not yet implemented" is the
        // honest answer. Refusing here would name the payload as the thing at
        // fault.
        return true;
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Set` support is implemented.
       */
      decode(
        _typeTag: string,
        _state: FabricValue,
        _env: LiveEnvironment,
      ): FabricValue {
        throw new Error("`FabricSet`: not yet implemented");
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
