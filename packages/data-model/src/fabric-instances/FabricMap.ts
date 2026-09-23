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
import { FrozenMap } from "@/frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Map` instances. Stub -- the static `[CODEC]` (the source of
 * truth) throws until `Map` support is fully implemented. Extra properties
 * beyond the wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  #map: Map<FabricValue, FabricValue>;

  /** Constructs an instance wrapping `map`. */
  constructor(map: Map<FabricValue, FabricValue>) {
    super();
    this.#map = map;
  }

  /** The wrapped map. */
  get map(): Map<FabricValue, FabricValue> {
    return this.#map;
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. The protocol
   * methods throw rather than approximate, so that no caller can come to depend
   * on an answer that would have to be taken back.
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("`FabricMap`: not yet implemented");
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("`FabricMap`: not yet implemented");
  }

  /** @inheritDoc */
  protected get wrappedValue(): Map<FabricValue, FabricValue> {
    return this.#map;
  }

  /** @inheritDoc */
  protected [SHALLOW_UNFROZEN_CLONE](): FabricMap {
    return new FabricMap(this.#map);
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenMap<FabricValue, FabricValue> {
    return new FrozenMap(this.#map);
  }

  /** @inheritDoc */
  protected toNativeThawed(): Map<FabricValue, FabricValue> {
    return new Map(this.#map);
  }

  static #codec = Object.freeze(
    new (class FabricMapCodec extends BaseNonterminalCodec {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Map, FabricMap);
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Map` support is implemented.
       */
      encode(_value: FabricMap, _env: LiveEnvironment): FabricValue {
        throw new Error("`FabricMap`: not yet implemented");
      }

      /**
       * @inheritDoc
       *
       * Stub -- accepts anything until `Map` support is implemented.
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
       * Stub -- throws until `Map` support is implemented.
       */
      decode(
        _typeTag: string,
        _state: FabricValue,
        _env: LiveEnvironment,
      ): FabricValue {
        throw new Error("`FabricMap`: not yet implemented");
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
