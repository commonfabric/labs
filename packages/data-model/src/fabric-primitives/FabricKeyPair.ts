import type { FabricKeyPair as ApiFabricKeyPair } from "@/api.ts";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { ProblematicValue } from "@/codec-common";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm";
import type { FabricValue } from "@/interface.ts";
import { FabricBytes } from "./FabricBytes.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "./interface.ts";

/**
 * The encoded state of a {@link FabricKeyPair} that holds material: the
 * algorithm name, and the two keys as base64url. This is the only state JSON
 * carries, a pair holding handles having no representation in that format.
 */
type FabricKeyPairMaterialState = {
  algorithm: string;
  publicKey: string;
  privateKey: string;
};

/**
 * The realm-crossing state of a {@link FabricKeyPair} that holds material.
 * Each key is a bare `ArrayBuffer` for the reason `FabricBytes` encodes to
 * one: that is the form `postMessage()` can _transfer_.
 */
type RealmMaterialState = {
  algorithm: string;
  publicKey: ArrayBuffer;
  privateKey: ArrayBuffer;
};

/**
 * The realm-crossing state of a {@link FabricKeyPair} that holds handles. The
 * algorithm is absent because each `CryptoKey` carries its own, which is what
 * the reconstructed pair reads it from.
 */
type RealmHandleState = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

/**
 * Immutable asymmetric key pair in the fabric type system.
 *
 * An instance is in one of two states, which its whole surface distinguishes:
 *
 * * It **holds handles**: two `CryptoKey`s, whose material this realm may have
 *   no way to reach. {@link #publicCryptoKey} and {@link #privateCryptoKey}
 *   return them, and {@link #cryptoKeyPair} returns both in the record shape
 *   Web Crypto uses.
 * * It **holds material**: the two keys as bytes. {@link #publicKeyBytes} and
 *   {@link #privateKeyBytes} return them.
 *
 * {@link #hasMaterial} says which, and {@link #algorithm} names the algorithm
 * either way.
 *
 * Only a pair holding material has a JSON encoding. A pair holding handles
 * refuses that format: a `CryptoKey`'s material is reachable only through
 * `SubtleCrypto.exportKey()`, which is asynchronous and which a non-extractable
 * key refuses outright, so there is nothing for a synchronous `encode()` to
 * write down. It crosses a realm boundary as itself instead, structured
 * cloning carrying a `CryptoKey` with its extractability intact.
 *
 * That refusal makes this class one of the exceptions
 * `docs/specs/space-model-formal-spec/1-fabric-values.md` allows under
 * `2.10 Encode Input Contract`: an instance valid as a `FabricValue`, whose
 * class a codec in the JSON registry claims, and which that format still
 * cannot express.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and the
 * material arm holds `FabricBytes`, which own their buffers outright. Instance
 * state is elided by the debug renderer, so a private key does not reach a log
 * through a `console.log()` of the value that holds it.
 */
export class FabricKeyPair extends BaseFabricPrimitive {
  /** The algorithm name. */
  readonly #algorithm: string;

  /** The public key, in whichever form this instance holds. */
  readonly #publicKey: CryptoKey | FabricBytes;

  /** The private key, in the same form as {@link #publicKey}. */
  readonly #privateKey: CryptoKey | FabricBytes;

  /**
   * Constructs an instance, either from a `CryptoKeyPair` -- whose two keys
   * must be a public/private pair agreeing on their algorithm -- or from an
   * algorithm name and the two keys' bytes. A `Uint8Array` argument is copied;
   * a caller wishing to cede its buffer wraps it in a `FabricBytes` first,
   * which is also how a caller avoids the copy.
   *
   * The algorithm name follows Web Crypto's normalized spelling (e.g.
   * `"Ed25519"`), which is what the `CryptoKeyPair` form reports.
   */
  constructor(pair: CryptoKeyPair);
  constructor(
    algorithm: string,
    publicKey: FabricBytes | Uint8Array,
    privateKey: FabricBytes | Uint8Array,
  );
  constructor(
    pairOrAlgorithm: CryptoKeyPair | string,
    publicKey?: FabricBytes | Uint8Array,
    privateKey?: FabricBytes | Uint8Array,
  ) {
    super();

    if (typeof pairOrAlgorithm === "string") {
      if (pairOrAlgorithm === "") {
        throw new Error("Cannot construct a key pair with no algorithm name.");
      }
      this.#algorithm = pairOrAlgorithm;
      this.#publicKey = FabricKeyPair.#toFabricBytes(publicKey, "publicKey");
      this.#privateKey = FabricKeyPair.#toFabricBytes(
        privateKey,
        "privateKey",
      );
    } else {
      const { publicKey: pub, privateKey: priv } = FabricKeyPair.#validPair(
        pairOrAlgorithm,
      );
      this.#algorithm = pub.algorithm.name;
      this.#publicKey = pub;
      this.#privateKey = priv;
    }
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricKeyPair;
  }

  /** @inheritDoc */
  get schemaType(): "FabricKeyPair" {
    return "FabricKeyPair";
  }

  /** The algorithm name (e.g. `"Ed25519"`). */
  get algorithm(): string {
    return this.#algorithm;
  }

  /** Whether this instance holds key material, as opposed to handles. */
  get hasMaterial(): boolean {
    return this.#publicKey instanceof FabricBytes;
  }

  /**
   * A `CryptoKeyPair` holding this instance's two keys. The record is a new
   * object on each call, so a caller may do as it likes with it; the two
   * `CryptoKey`s within it are this instance's own, and are the same two
   * objects on every call. Throws when this instance holds material.
   */
  get cryptoKeyPair(): CryptoKeyPair {
    if (this.hasMaterial) {
      throw new Error(
        "Cannot produce a `CryptoKeyPair`: this key pair holds material.",
      );
    }

    return {
      publicKey: this.#publicKey as CryptoKey,
      privateKey: this.#privateKey as CryptoKey,
    };
  }

  /** The public key's handle. Throws when this instance holds material. */
  get publicCryptoKey(): CryptoKey {
    return this.#handleOf(this.#publicKey);
  }

  /** The private key's handle. Throws when this instance holds material. */
  get privateCryptoKey(): CryptoKey {
    return this.#handleOf(this.#privateKey);
  }

  /** The public key's bytes. Throws when this instance holds handles. */
  get publicKeyBytes(): FabricBytes {
    return this.#materialOf(this.#publicKey);
  }

  /** The private key's bytes. Throws when this instance holds handles. */
  get privateKeyBytes(): FabricBytes {
    return this.#materialOf(this.#privateKey);
  }

  /**
   * Returns the given key as a handle.
   *
   * @throws If this instance holds material.
   */
  #handleOf(key: CryptoKey | FabricBytes): CryptoKey {
    if (key instanceof FabricBytes) {
      throw new Error(
        "Cannot produce a `CryptoKey`: this key pair holds material.",
      );
    }

    return key;
  }

  /**
   * Returns the given key as bytes.
   *
   * @throws If this instance holds handles.
   */
  #materialOf(key: CryptoKey | FabricBytes): FabricBytes {
    if (!(key instanceof FabricBytes)) {
      throw new Error(
        "Cannot produce key material: this key pair holds handles.",
      );
    }

    return key;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class KeyPairCodec
      extends BaseNonterminalCodec<never, FabricKeyPairMaterialState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.KeyPair, FabricKeyPair);
      }

      /**
       * @inheritDoc
       *
       * @throws If `value` holds handles, that state having no representation
       *   in this format.
       */
      encode(
        value: FabricKeyPair,
        _env: LiveEnvironment,
      ): FabricKeyPairMaterialState {
        if (!value.hasMaterial) {
          throw new Error(
            "Cannot encode a key pair that holds handles: a `CryptoKey` has " +
              "no JSON representation.",
          );
        }

        return {
          algorithm: value.#algorithm,
          publicKey: toUnpaddedBase64url(value.publicKeyBytes.slice()),
          privateKey: toUnpaddedBase64url(value.privateKeyBytes.slice()),
        };
      }

      /** @inheritDoc */
      canDecode(state: FabricValue): state is FabricKeyPairMaterialState {
        return isPlainObject(state) &&
          (typeof state.algorithm === "string") &&
          (typeof state.publicKey === "string") &&
          (typeof state.privateKey === "string");
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricKeyPairMaterialState,
        _env: LiveEnvironment,
      ): FabricValue {
        const { algorithm, publicKey, privateKey } = state;

        try {
          return new FabricKeyPair(
            algorithm,
            new FabricBytes(fromBase64url(publicKey), true),
            new FabricBytes(fromBase64url(privateKey), true),
          );
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `KeyPair: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class KeyPairCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.KeyPair, FabricKeyPair);
      }

      /**
       * @inheritDoc
       *
       * Each state names its arm by shape: a `CryptoKey` in the key slots for
       * handles, an `ArrayBuffer` and an algorithm for material.
       */
      encode(value: FabricKeyPair, _env: LiveEnvironment): RealmCodecValue {
        if (!value.hasMaterial) {
          return {
            publicKey: value.#publicKey as CryptoKey,
            privateKey: value.#privateKey as CryptoKey,
          };
        }

        return {
          algorithm: value.#algorithm,
          publicKey: value.publicKeyBytes.sliceBuffer(),
          privateKey: value.privateKeyBytes.sliceBuffer(),
        };
      }

      /** @inheritDoc */
      canDecode(
        state: RealmCodecValue,
      ): state is RealmMaterialState | RealmHandleState {
        if (!isPlainObject(state)) {
          return false;
        }

        const { algorithm, publicKey, privateKey } = state as {
          algorithm?: unknown;
          publicKey?: unknown;
          privateKey?: unknown;
        };

        if (
          FabricKeyPair.#isCryptoKey(publicKey) &&
          FabricKeyPair.#isCryptoKey(privateKey)
        ) {
          return algorithm === undefined;
        }

        // Non-empty, which is the one thing the constructor refuses about an
        // algorithm name. Left to `decode()` it would arrive as a constructor
        // throw, which that method reports as a detached buffer -- the only
        // other way its construction can fail.
        return (typeof algorithm === "string") && (algorithm !== "") &&
          (publicKey instanceof ArrayBuffer) &&
          (privateKey instanceof ArrayBuffer);
      }

      /**
       * @inheritDoc
       *
       * A detached buffer throws rather than being reported, as on
       * `FabricHash`: it is a well-formed state this tree already spent.
       */
      decode(
        _typeTag: string,
        state: RealmMaterialState | RealmHandleState,
        _env: LiveEnvironment,
      ): FabricValue {
        if (FabricKeyPair.#isCryptoKey(state.publicKey)) {
          return new FabricKeyPair(state as RealmHandleState);
        }

        const { algorithm, publicKey, privateKey } =
          state as RealmMaterialState;

        // Taken over rather than copied, as `FabricBytes` does: each buffer
        // arrived either by being cloned, making it this realm's own, or by
        // being transferred, which detached the sender's.
        try {
          return new FabricKeyPair(
            algorithm,
            new FabricBytes(publicKey, true),
            new FabricBytes(privateKey, true),
          );
        } catch (e) {
          throw new Error(
            "The state's buffer is detached, this tree having been decoded " +
              "already.",
            { cause: e },
          );
        }
      }
    })(),
  );

  /**
   * The codec for instances of this class.
   *
   * Nonterminal: the state is three strings, each a `FabricValue` the walker
   * expands in turn.
   */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, and it is the keys that make it so rather than the record around
   * them: a `CryptoKey` and an `ArrayBuffer` are both in this format's domain
   * and neither is a `FabricValue`, so a state holding either has no
   * nonterminal reading.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }

  /** Whether the given value is a `CryptoKey` this realm recognizes. */
  static #isCryptoKey(value: unknown): value is CryptoKey {
    return !!globalThis.CryptoKey && (value instanceof globalThis.CryptoKey);
  }

  /** Whether the given value is a `CryptoKeyPair` this realm recognizes. */
  static #isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
    return isPlainObject(value) &&
      FabricKeyPair.#isCryptoKey(value.publicKey) &&
      FabricKeyPair.#isCryptoKey(value.privateKey);
  }

  /**
   * Returns the given key pair's two keys, checked as a public/private pair
   * whose `algorithm` records agree in full, parameters included.
   *
   * The check does not establish that the two keys are counterparts, which no
   * synchronous check can: two independently generated keys of the same
   * algorithm and parameters are indistinguishable from a genuine pair by
   * anything but a sign/verify round trip, which is asynchronous. What it
   * establishes is that they *could* be counterparts.
   */
  static #validPair(pair: CryptoKeyPair): CryptoKeyPair {
    if (!FabricKeyPair.#isCryptoKeyPair(pair)) {
      throw new Error("Not a `CryptoKeyPair`: both keys must be `CryptoKey`s.");
    }

    const { publicKey, privateKey } = pair;

    if ((publicKey.type !== "public") || (privateKey.type !== "private")) {
      throw new Error(
        `Not a key pair: keys are of type ${
          backtickQuote(publicKey.type)
        } and ${backtickQuote(privateKey.type)}.`,
      );
    } else if (publicKey.algorithm.name !== privateKey.algorithm.name) {
      throw new Error(
        `Mismatched algorithms: ${
          backtickQuote(publicKey.algorithm.name)
        } and ${backtickQuote(privateKey.algorithm.name)}.`,
      );
    } else if (!deepEqual(publicKey.algorithm, privateKey.algorithm)) {
      // The whole record rather than a per-algorithm list of the parameters
      // that matter: a genuine pair reports the same `algorithm` on both keys
      // for every algorithm Web Crypto defines, so nothing here has to know
      // which fields a given one carries, and an algorithm added later is
      // covered as it stands.
      throw new Error(
        `Mismatched ${
          backtickQuote(publicKey.algorithm.name)
        } algorithm parameters between the two keys.`,
      );
    }

    return { publicKey, privateKey };
  }

  /**
   * Returns the given key bytes as a `FabricBytes`, copying a `Uint8Array`.
   * The `undefined` arm is the overload's doing: the two key parameters are
   * optional in the implementation signature and absent on the
   * `CryptoKeyPair` call.
   */
  static #toFabricBytes(
    bytes: FabricBytes | Uint8Array | undefined,
    name: string,
  ): FabricBytes {
    if (bytes instanceof FabricBytes) {
      return bytes;
    } else if (bytes instanceof Uint8Array) {
      return new FabricBytes(bytes);
    }

    throw new Error(
      `Not key material: ${
        backtickQuote(name)
      } must be a \`FabricBytes\` or a ` +
        "`Uint8Array`.",
    );
  }
}

// Compile-time drift guards against the `@/api.ts` declarations, in
// two halves.
//
// The instance surface compares directly. Assignability is covariant on member
// types, so this class -- nominal, holding private fields -- satisfies the
// structural declaration, and a member the declaration names that is missing
// here or typed differently fails this line. It does NOT catch the other
// direction: a public member here that the declaration omits passes silently,
// and needs adding there by hand.
FabricKeyPair.prototype satisfies ApiFabricKeyPair;

// The constructor cannot be compared that way. A construct signature's
// parameters are checked contravariantly, so satisfying
// `FabricKeyPairConstructor` would require the declaration's parameter type to
// be assignable to this class's. The declaration says `FabricBytes`, meaning
// the class of that name, and nothing structural is ever assignable to a class
// holding a private field -- so the only parameter that could satisfy it is
// one naming the declaration rather than the class, which is backwards for an
// implementation. Each form the declaration promises is therefore written out
// below instead.
//
// **The closure is not actually called**, by this module or by anything else:
// it is built, discarded, and never invoked, and only the compilation of its
// body matters -- dropping an overload, or narrowing one, stops it compiling.
// It is therefore never covered either, and no test could honestly cover it,
// so the directive keeps these lines out of the coverage denominator rather
// than out of a report someone has to remember to read.
// deno-coverage-ignore-start
(() => {
  const bytes = new FabricBytes(new Uint8Array());

  // The algorithm name is arbitrary; a real one would mislead a `grep`.
  new FabricKeyPair(undefined as unknown as CryptoKeyPair);
  new FabricKeyPair("ExampleAlgorithm", bytes, bytes);
  new FabricKeyPair("ExampleAlgorithm", new Uint8Array(), new Uint8Array());
});
// deno-coverage-ignore-stop
