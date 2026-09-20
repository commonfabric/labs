import {
  bigintFromUnpaddedBase64url,
  bigintToUnpaddedBase64url,
} from "@commonfabric/utils/bigint";
import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "./interface.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { ProblematicValue } from "@/codec-common";

/**
 * Codec for `bigint`. Encodes to the `BigInt@1` tag with an unpadded base64
 * string encoding the bigint's two's-complement big-endian byte representation.
 * Wire format: `{ "/BigInt@1": "<base64>" }`.
 *
 * The byte encoding is the same one used by the hash (`2-hash-byte-format.md`
 * Section 4.5): minimal two's-complement big-endian, with sign extension as
 * needed.
 *
 * `BigInt` is a non-`new`-able pseudo-constructor, so it is cast to
 * `Constructor` (a "white lie") to seed the class fast-path; `canEncode()`
 * confirms via `typeof`.
 */
export class BigIntCodec extends BaseTerminalCodec<JsonCodecValue, string> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.BigInt, BigInt as unknown as Constructor);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "bigint";
  }

  /** @inheritDoc */
  encode(value: bigint, _env: LiveEnvironment): string {
    return bigintToUnpaddedBase64url(value);
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
      return bigintFromUnpaddedBase64url(state);
    } catch {
      return new ProblematicValue(
        typeTag,
        state,
        `bigint: invalid base64: ${state}`,
      );
    }
  }
}
