import type { FabricValue } from "@/interface.ts";
import { BaseEncodeAct, type CodecEngineConfig } from "@/codec-common";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import {
  REALM_FORMAT_VERSION,
  type RealmCodecValue,
  type RealmEncodedValue,
  type RealmFormatMarker,
  type RealmTaggedValue,
} from "./interface.ts";

/**
 * One act of encoding for the realm boundary, and the marker its output is
 * recognized by.
 *
 * The marker is minted here, which is to say once per `encode()` and after the
 * value to be encoded already exists -- what Section 2.2 of the realm spec
 * requires of it, and why a payload cannot forge one. Being per act is the
 * whole of its correctness: two acts must not share a marker, or one act's
 * data becomes another's structure.
 */
export class RealmEncodeAct
  extends BaseEncodeAct<RealmCodecValue, RealmEncodedValue> {
  readonly #marker: RealmFormatMarker;

  /** Constructs an instance, minting this act's marker. */
  constructor(
    config: CodecEngineConfig<RealmCodecValue>,
    env: LiveEnvironment,
  ) {
    super(config, env);
    this.#marker = Object.freeze([REALM_FORMAT_VERSION] as const);
  }

  /**
   * @inheritDoc
   *
   * Wraps the walked tree in this act's outer envelope. The marker is the
   * act's own, minted when the act was, which is what Section 2.2
   * requires: created after the value exists, so nothing already assembled can
   * hold a reference to it.
   */
  override serializedFromEncoded(
    encoded: RealmCodecValue,
  ): RealmEncodedValue {
    return [this.marker, encoded];
  }

  /**
   * @inheritDoc
   *
   * The marker comes from the act this form belongs to, so a form built
   * without one is not a state this can reach: an encode act has a marker
   * from the moment it exists, and only an encode act arrives here.
   */
  protected override wrapTag(
    tag: string,
    state: RealmCodecValue,
  ): RealmTaggedValue {
    return [this.marker, tag, state];
  }

  /**
   * @inheritDoc
   *
   * Holes need no representation: cloning carries a sparse array's length and
   * its absent indices directly, so skipping an absent index here leaves it
   * absent in the result.
   */
  protected override encodeArray(
    value: readonly FabricValue[],
  ): RealmCodecValue {
    this.enter(value);

    const length = value.length;
    let result: RealmCodecValue[] | undefined;

    try {
      for (let i = 0; i < length; i++) {
        if (!(i in value)) {
          continue;
        }

        const original = value[i]!;
        const encoded = this.encodeValue(original);

        if (result !== undefined) {
          result[i] = encoded;
        } else if (!Object.is(encoded, original)) {
          // The first element that changed: copy what came before it, holes and
          // all, and write into the copy from here on.
          result = new Array<RealmCodecValue>(length);
          for (let j = 0; j < i; j++) {
            if (j in value) {
              result[j] = value[j] as RealmCodecValue;
            }
          }
          result[i] = encoded;
        }
      }
    } finally {
      this.leave(value);
    }

    return result ?? (value as RealmCodecValue);
  }

  /**
   * @inheritDoc
   *
   * Keys are visited in their own order rather than sorted. JSON sorts to make
   * its text canonical, which is what lets an encoding be hashed and compared
   * as bytes; cloning preserves key order and nothing here is compared that
   * way, so sorting would buy nothing and would force a rebuild of every
   * object.
   *
   * A `/`-prefixed key needs no escaping either, this format reserving no key
   * at all. A name this runtime reserves is still refused: the rebuild below
   * cannot reproduce one, and a silent reshaping is worse than a refusal.
   */
  protected override encodePlainObject(
    value: Record<string, FabricValue>,
  ): RealmCodecValue {
    this.enter(value);

    const keys = Object.keys(value);
    let result: Record<string, RealmCodecValue> | undefined;

    try {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;

        // Checked on every object, not just the ones that get rebuilt, so that
        // the answer does not depend on whether some sibling happened to
        // change.
        RealmEncodeAct.assertEncodableKey(key);

        const original = value[key]!;
        const encoded = this.encodeValue(original);

        if (result !== undefined) {
          result[key] = encoded;
        } else if (!Object.is(encoded, original)) {
          result = {};
          for (let j = 0; j < i; j++) {
            result[keys[j]!] = value[keys[j]!] as RealmCodecValue;
          }
          result[key] = encoded;
        }
      }
    } finally {
      this.leave(value);
    }

    return result ?? (value as RealmCodecValue);
  }

  /** The marker at slot zero of this act's envelope and every tagged form. */
  get marker(): RealmFormatMarker {
    return this.#marker;
  }
}
