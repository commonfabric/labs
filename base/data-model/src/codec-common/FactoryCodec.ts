import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";

import {
  createFactoryShell,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@/fabric-factory.ts";
import type { FabricValue } from "@/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";

/** Codec for directly callable, serializable Fabric factories. */
export class FactoryCodec extends BaseNonterminalCodec {
  constructor() {
    super(CODEC_TYPE_TAGS.Factory, undefined);
  }

  override canEncode(value: FabricValue): boolean {
    return isAdmittedFabricFactory(value);
  }

  override encode(value: FabricValue, _env?: LiveEnvironment): FabricValue {
    return sealFactoryState(value, deepFreeze) as FabricValue;
  }

  override canDecode(_state: FabricValue): _state is FabricValue {
    return true;
  }

  override decode(
    _typeTag: string,
    state: FabricValue,
    _env: LiveEnvironment,
  ): FabricValue {
    return createFactoryShell(state, deepFreeze) as FabricValue;
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
