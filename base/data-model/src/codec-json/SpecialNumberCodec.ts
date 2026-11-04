import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "./interface.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";

/**
 * The literals this codec decodes, and the value each one stands for. The
 * state type is read off the keys, so what is accepted and what it becomes
 * cannot disagree.
 */
const SPECIAL_NUMBERS = Object.freeze({
  "-0": -0,
  "+Infinity": Infinity,
  "-Infinity": -Infinity,
  "NaN": NaN,
});

/** The literals this codec's state may be, and nothing else. */
type SpecialNumberState = keyof typeof SPECIAL_NUMBERS;

/**
 * Codec for the four "special" numeric values that JSON cannot represent
 * faithfully: `-0`, `NaN`, `+Infinity`, and `-Infinity`. Wire format: `{
 * "/SpecialNumber@1": "<literal>" }`, where `<literal>` is one of `-0`, `NaN`,
 * `+Infinity`, or `-Infinity`.
 *
 * String state (rather than a JSON number) is used because `JSON.stringify`
 * emits `null` for `NaN`/`±Infinity` and drops the sign on `-0`, which would
 * make a numeric-state form lossy through the JSON layer.
 *
 * Any NaN bit pattern encodes as the literal `"NaN"` and round-trips back to
 * `Number.NaN`.
 */
export class SpecialNumberCodec
  extends BaseTerminalCodec<JsonCodecValue, SpecialNumberState> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.SpecialNumber, Number);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "number" &&
      (Number.isNaN(value) ||
        value === Infinity ||
        value === -Infinity ||
        Object.is(value, -0));
  }

  /** @inheritDoc */
  encode(value: number, _env: LiveEnvironment): SpecialNumberState {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "+Infinity";
    if (value === -Infinity) return "-Infinity";
    // The remaining `canEncode` case is `Object.is(value, -0)`.
    return "-0";
  }

  /** @inheritDoc */
  canDecode(state: JsonCodecValue): state is SpecialNumberState {
    return (typeof state === "string") && Object.hasOwn(SPECIAL_NUMBERS, state);
  }

  /** @inheritDoc */
  decode(
    _typeTag: string,
    state: SpecialNumberState,
    _env: LiveEnvironment,
  ): FabricValue {
    return SPECIAL_NUMBERS[state];
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
