import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "./interface.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

/**
 * Codec for `undefined`. Encodes to the `Undefined@1` tag with `null` state.
 * `undefined` has no corresponding class, so there is no `uniqueHandledClass`;
 * matching is by `canEncode()`. See `1-fabric-values.md` Section 1.3.
 */
export class UndefinedCodec extends BaseTerminalCodec<JsonCodecValue, null> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.Undefined, undefined);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return value === undefined;
  }

  /** @inheritDoc */
  encode(_value: FabricValue, _env: LiveEnvironment): null {
    return null;
  }

  /** @inheritDoc */
  canDecode(state: JsonCodecValue): state is null {
    return state === null;
  }

  /** @inheritDoc */
  decode(
    _typeTag: string,
    _state: null,
    _env: LiveEnvironment,
  ): FabricValue {
    return undefined;
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
