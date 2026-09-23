import type {
  FabricEpochNsec as ApiFabricEpochNsec,
  FabricEpochNsecConstructor as ApiFabricEpochNsecConstructor,
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
 * Temporal type representing nanoseconds from the POSIX Epoch
 * (1970-01-01T00:00:00Z). Wraps a `bigint` value. Used for high-precision
 * timestamps. See Section 1.4.7 of the formal spec.
 */
export class FabricEpochNsec extends BaseFabricPrimitive
  implements ApiFabricEpochNsec {
  /**
   * Nanoseconds from the POSIX Epoch. A negative value represents a pre-epoch
   * timestamp.
   */
  readonly #value: bigint;

  /** Constructs an instance representing `value` nanoseconds from the Epoch. */
  constructor(value: bigint) {
    super();
    this.#value = value;
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricEpochNsec;
  }

  /** @inheritDoc */
  get schemaType(): "FabricEpochNsec" {
    return "FabricEpochNsec";
  }

  /**
   * Nanoseconds from the POSIX Epoch. A negative value represents a pre-epoch
   * timestamp.
   */
  get value(): bigint {
    return this.#value;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class EpochNsecCodec
      extends BaseTerminalCodec<JsonCodecValue, string> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochNsec, FabricEpochNsec);
      }

      /** @inheritDoc */
      encode(value: FabricEpochNsec, _env: LiveEnvironment): string {
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
      ): FabricValue {
        try {
          return new FabricEpochNsec(bigintFromUnpaddedBase64url(state));
        } catch {
          return new ProblematicValue(
            typeTag,
            state,
            `EpochNsec: invalid base64: ${state}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class EpochNsecCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.EpochNsec, FabricEpochNsec);
      }

      /** @inheritDoc */
      encode(value: FabricEpochNsec, _env: LiveEnvironment): RealmCodecValue {
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
        return new FabricEpochNsec(state);
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

// Compile-time check that the exported `FabricEpochNsec` constructor matches the
// `FabricEpochNsecConstructor` declared in `@/api.ts`. This catches a declared member
// that is missing here or has the wrong type. It does NOT catch the other
// direction: `satisfies` is an assignability check, so a public member on this
// class that the declaration omits passes silently. Members added here need
// adding there by hand.
FabricEpochNsec satisfies ApiFabricEpochNsecConstructor;
