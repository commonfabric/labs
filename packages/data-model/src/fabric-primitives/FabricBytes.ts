import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { toOwnedUint8Array } from "@commonfabric/utils/buffers";

import type {
  FabricBytes as ApiFabricBytes,
  FabricBytesConstructor as ApiFabricBytesConstructor,
} from "@/api.ts";
import type { FabricValue } from "@/interface.ts";
import { ProblematicValue } from "@/codec-common";
import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import type { RealmCodecValue } from "@/codec-realm";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  LiveEnvironment,
  REALM_CODEC,
  TerminalCodec,
} from "@/codec-interface/interface.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "./interface.ts";

/**
 * Immutable byte sequence in the fabric type system.
 *
 * The underlying bytes are private. Callers access them through:
 * - `length` -- the byte count.
 * - `slice()` -- returns an unshared copy (or sub-range).
 * - `sliceBuffer()` -- the same, as a bare `ArrayBuffer`.
 * - `copyInto()` -- copies bytes into a caller-provided buffer.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and an
 * instance owns its bytes outright, holding a buffer no other code can reach.
 * (JS cannot freeze `ArrayBuffer` contents, so sole ownership is the defense.)
 */
export class FabricBytes extends BaseFabricPrimitive implements ApiFabricBytes {
  /**
   * Private byte storage. Guaranteed to be backed by an exact-sized and
   * unshared `ArrayBuffer`.
   */
  readonly #bytes: Uint8Array<ArrayBuffer>;

  /**
   * Constructs an instance holding the given bytes, which it owns outright.
   *
   * @param bytes - The raw bytes to wrap, as a view or as a whole buffer.
   * @param transfer - Whether the caller cedes `bytes` to this instance, which
   *   permits taking over its buffer instead of copying it. When `true`, the
   *   caller must not use `bytes` afterwards; `toOwnedUint8Array()` says what that
   *   permission does and does not guarantee.
   */
  constructor(bytes: Uint8Array | ArrayBufferLike, transfer: boolean = false) {
    super();
    this.#bytes = toOwnedUint8Array(bytes, transfer);
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricBytes;
  }

  /** @inheritDoc */
  get schemaType(): "FabricBytes" {
    return "FabricBytes";
  }

  /** The number of bytes. */
  get length(): number {
    return this.#bytes.length;
  }

  /**
   * Returns a copy of the bytes (or a sub-range). The returned array is
   * unshared -- the caller may mutate it freely -- and is backed by a plain
   * `ArrayBuffer`, never a `SharedArrayBuffer`, so it is usable wherever one
   * is required.
   *
   * @param start - Start index (inclusive, default 0).
   * @param end - End index (exclusive, default `length`).
   */
  slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    return this.#bytes.slice(start, end);
  }

  /**
   * Returns a copy of the bytes (or a sub-range) as a bare `ArrayBuffer`. The
   * returned buffer is unshared -- the caller may mutate it freely.
   *
   * @param start - Start index (inclusive, default 0).
   * @param end - End index (exclusive, default `length`).
   */
  sliceBuffer(start?: number, end?: number): ArrayBuffer {
    // `#bytes` covers the whole of its own buffer, so the buffer's indices are
    // this value's indices and `ArrayBuffer.prototype.slice()` takes `start`
    // and `end` unaltered -- negative values included, exactly as `slice()`
    // resolves them.
    return this.#bytes.buffer.slice(start ?? 0, end);
  }

  /**
   * Copies bytes from this instance into a caller-provided buffer.
   *
   * @param target - The destination buffer.
   * @param offset - Byte offset in the source to start copying from
   *   (default `0`).
   * @param length - Number of bytes to copy (default: all remaining from
   *   `offset`).
   * @returns The number of bytes actually copied.
   */
  copyInto(target: Uint8Array, offset = 0, length?: number): number {
    if (offset < 0) {
      throw new RangeError(
        `\`copyInto()\`: offset must be non-negative, got \`${offset}\``,
      );
    }
    if (length !== undefined && length < 0) {
      throw new RangeError(
        `\`copyInto()\`: length must be non-negative, got \`${length}\``,
      );
    }
    const available = this.#bytes.length - offset;
    if (available <= 0) return 0;
    const toCopy = Math.min(length ?? available, available, target.length);
    target.set(this.#bytes.subarray(offset, offset + toCopy));
    return toCopy;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class BytesCodec extends BaseTerminalCodec<JsonCodecValue, string> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Bytes, FabricBytes);
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
      ): FabricBytes | ProblematicValue {
        try {
          const bytes = fromBase64url(state);
          return new FabricBytes(bytes, true);
        } catch {
          return new ProblematicValue(
            typeTag,
            state,
            `Bytes: invalid base64: ${state}`,
          );
        }
      }

      /** @inheritDoc */
      encode(value: FabricBytes, _env: LiveEnvironment): string {
        return toUnpaddedBase64url(value.#bytes);
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class BytesCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Bytes, FabricBytes);
      }

      /**
       * @inheritDoc
       *
       * An `ArrayBuffer` rather than a view onto one, because that is the
       * form `postMessage()` can *transfer*. The buffer is an unshared copy
       * covering exactly these bytes, so a caller assembling a transfer list
       * can hand it over outright: nothing else refers to it, and a caller
       * mutating the encoded tree before it crosses cannot reach into this
       * instance.
       */
      encode(value: FabricBytes, _env: LiveEnvironment): RealmCodecValue {
        return value.sliceBuffer();
      }

      /** @inheritDoc */
      canDecode(state: RealmCodecValue): state is ArrayBuffer {
        return state instanceof ArrayBuffer;
      }

      /**
       * @inheritDoc
       *
       * A detached buffer throws rather than being reported. It is not a
       * malformed state -- it is a well-formed one this tree already spent --
       * so it is not {@link #canDecode}'s to refuse, and it is caught rather
       * than tested for, the constructor being what discovers it.
       */
      decode(
        _typeTag: string,
        state: ArrayBuffer,
        _env: LiveEnvironment,
      ): FabricValue {
        // Taken over rather than copied. This buffer reached here either by
        // being cloned -- in which case it is this realm's own and nobody
        // else's -- or by being transferred, which detaches the sender's.
        // Either way nothing on this side but the wire tree refers to it, and
        // that tree is spent once decoding is done.
        try {
          return new FabricBytes(state, true);
        } catch (e) {
          // The one way an `ArrayBuffer` reaches here and cannot be built
          // from is by being detached, and it detaches by having been taken
          // over already -- so this tree was decoded before, and the bytes
          // went to that call. Said here because the alternative is the
          // engine reporting the runtime's own phrasing, which names a
          // detached buffer without saying how it came to be one. The tag is
          // left out: the report carries it either way, and naming it here
          // would say it twice.
          throw new Error(
            "The state is a detached buffer, this tree having been decoded " +
              "already.",
            { cause: e },
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format. The
   * bytes travel as bytes, where JSON has to encode them as base64url text.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }
}

// Compile-time check that the exported `FabricBytes` constructor matches the
// `FabricBytesConstructor` declared in `@/api.ts`. This catches a declared member
// that is missing here or has the wrong type. It does NOT catch the other
// direction: `satisfies` is an assignability check, so a public member on this
// class that the declaration omits passes silently. Members added here need
// adding there by hand.
FabricBytes satisfies ApiFabricBytesConstructor;
