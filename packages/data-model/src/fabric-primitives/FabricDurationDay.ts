import type {
  FabricDurationDay as ApiFabricDurationDay,
  FabricDurationDayConstructor as ApiFabricDurationDayConstructor,
} from "@/api.ts";
import {
  bigintFromUnpaddedBase64url,
  bigintToUnpaddedBase64url,
} from "@commonfabric/utils/bigint";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import type { RealmCodecValue } from "@/codec-realm";
import {
  JSON_CODEC,
  type LiveEnvironment,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import { ProblematicValue } from "@/codec-common";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "./interface.ts";

/**
 * Temporal type representing a span of time, as a count of days. Wraps a
 * `bigint` value. The companion to `FabricEpochDay`: the difference between two
 * days is one of these. See Section 1.4.14 of the formal spec.
 */
export class FabricDurationDay extends BaseFabricPrimitive
  implements ApiFabricDurationDay {
  /** Length of the span in days. A negative value is a negative span. */
  readonly #value: bigint;

  /** Constructs an instance representing a span of `value` days. */
  constructor(value: bigint) {
    super();
    this.#value = value;
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricDurationDay;
  }

  /** @inheritDoc */
  get schemaType(): "FabricDurationDay" {
    return "FabricDurationDay";
  }

  /** Length of the span in days. A negative value is a negative span. */
  get value(): bigint {
    return this.#value;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class DurationDayCodec
      extends BaseTerminalCodec<JsonCodecValue, string> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.DurationDay, FabricDurationDay);
      }

      /** @inheritDoc */
      encode(value: FabricDurationDay, _env: LiveEnvironment): string {
        return bigintToUnpaddedBase64url(value.#value);
      }

      /** @inheritDoc */
      canDecode(state: JsonCodecValue): state is string {
        return typeof state === "string";
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: string,
        _env: LiveEnvironment,
        mutable = false,
      ): FabricValue {
        try {
          return new FabricDurationDay(bigintFromUnpaddedBase64url(state));
        } catch {
          return ProblematicValue.make(
            typeTag,
            state,
            `DurationDay: invalid base64: ${state}`,
            mutable,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class DurationDayCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.DurationDay, FabricDurationDay);
      }

      /** @inheritDoc */
      encode(
        value: FabricDurationDay,
        _env: LiveEnvironment,
      ): RealmCodecValue {
        return value.#value;
      }

      /** @inheritDoc */
      canDecode(state: RealmCodecValue): state is bigint {
        return typeof state === "bigint";
      }

      /** @inheritDoc */
      decode(
        _typeTag: string,
        state: bigint,
        _env: LiveEnvironment,
      ): FabricValue {
        return new FabricDurationDay(state);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format. The
   * `bigint` travels as itself, where JSON has to encode it as base64url text
   * over its two's-complement bytes.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }
}

// Compile-time check that the exported `FabricDurationDay` constructor matches
// the `FabricDurationDayConstructor` declared in `@/api.ts`. This catches a
// declared member that is missing here or has the wrong type. It does NOT catch
// the other direction: `satisfies` is an assignability check, so a public
// member on this class that the declaration omits passes silently. Members
// added here need adding there by hand.
FabricDurationDay satisfies ApiFabricDurationDayConstructor;
