import type { FabricKeyPair as ApiFabricKeyPair } from "@/api.ts";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { backtickQuote } from "@commonfabric/text/markdown";
import { isPlainObject } from "@commonfabric/js-values/types";

import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { BLESSING_TOKEN } from "@/fabric-bases/blessing.ts";
import { hasOnlyKeys, ProblematicValue } from "@/codec-common";
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
 * The state of a {@link FabricKeyPair} that holds material, which is also its
 * JSON state: the algorithm name, and the two keys' bytes. This is the only
 * state JSON carries, a pair holding handles having no representation in that
 * format.
 */
type FabricKeyPairMaterialState = {
  readonly algorithm: string;
  readonly publicKey: FabricBytes;
  readonly privateKey: FabricBytes;
};

/**
 * What a {@link FabricKeyPair} that holds handles stores: the shape of
 * {@link FabricKeyPairMaterialState}, with a `CryptoKey` in each key slot.
 */
type FabricKeyPairHandleState = {
  readonly algorithm: string;
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
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
 *   {@link #privateKeyBytes} return them, and {@link #state} returns both
 *   beside the algorithm name.
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
 * `2.11 Input Contracts`: an instance valid as a `FabricValue`, whose
 * class a codec in the JSON registry claims, and which that format still
 * cannot express.
 *
 * A pair holding material encodes and hashes as though it were a
 * `FabricInstance` tagged `KeyPair@1` whose state is {@link #state}: the JSON
 * codec decomposes it, writing each key as a `Bytes@1` of its own, and the
 * hasher feeds it in the instance layout. That it is a `FabricPrimitive` is a
 * distinction of this implementation rather than of the data model.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and the
 * material arm holds `FabricBytes`, which own their buffers outright. Instance
 * state is elided by the debug renderer, so a private key does not reach a log
 * through a `console.log()` of the value that holds it.
 */
export class FabricKeyPair extends BaseFabricPrimitive {
  /**
   * The state, frozen: for a pair holding material, exactly the record
   * `.state` returns; for a pair holding handles, the same shape with the two
   * `CryptoKey`s in the key slots.
   */
  readonly #state: FabricKeyPairMaterialState | FabricKeyPairHandleState;

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
    super(BLESSING_TOKEN, FabricKeyPair);

    if (typeof pairOrAlgorithm === "string") {
      if (pairOrAlgorithm === "") {
        throw new Error("Cannot construct a key pair with no algorithm name.");
      }
      this.#state = Object.freeze({
        algorithm: pairOrAlgorithm,
        publicKey: FabricKeyPair.#toFabricBytes(publicKey, "publicKey"),
        privateKey: FabricKeyPair.#toFabricBytes(privateKey, "privateKey"),
      });
    } else {
      const { publicKey: pub, privateKey: priv } = FabricKeyPair.#validPair(
        pairOrAlgorithm,
      );
      this.#state = Object.freeze({
        algorithm: pub.algorithm.name,
        publicKey: pub,
        privateKey: priv,
      });
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
    return this.#state.algorithm;
  }

  /** Whether this instance holds key material, as opposed to handles. */
  get hasMaterial(): boolean {
    return this.#state.publicKey instanceof FabricBytes;
  }

  /**
   * The state, a frozen record of the algorithm name and the two keys' bytes.
   * This is what the JSON codec encodes and what the hasher reads. Throws when
   * this instance holds handles.
   */
  get state(): FabricKeyPairMaterialState {
    if (!this.hasMaterial) {
      throw new Error("Cannot produce a state: this key pair holds handles.");
    }

    return this.#state as FabricKeyPairMaterialState;
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
      publicKey: this.#state.publicKey as CryptoKey,
      privateKey: this.#state.privateKey as CryptoKey,
    };
  }

  /** The public key's handle. Throws when this instance holds material. */
  get publicCryptoKey(): CryptoKey {
    return this.#handleOf(this.#state.publicKey);
  }

  /** The private key's handle. Throws when this instance holds material. */
  get privateCryptoKey(): CryptoKey {
    return this.#handleOf(this.#state.privateKey);
  }

  /** The public key's bytes. Throws when this instance holds handles. */
  get publicKeyBytes(): FabricBytes {
    return this.#materialOf(this.#state.publicKey);
  }

  /** The private key's bytes. Throws when this instance holds handles. */
  get privateKeyBytes(): FabricBytes {
    return this.#materialOf(this.#state.privateKey);
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

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }

  /**
   * The keys of a state holding material, in either format: the whole of what
   * the codecs read from one.
   */
  static #MATERIAL_STATE_KEYS: readonly string[] = Object.freeze([
    "algorithm",
    "publicKey",
    "privateKey",
  ]);

  /** The keys of a realm state holding handles. */
  static #HANDLE_STATE_KEYS: readonly string[] = Object.freeze([
    "publicKey",
    "privateKey",
  ]);

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

        return value.state;
      }

      /**
       * @inheritDoc
       *
       * A state holding any key besides the three is refused, being one this
       * class never writes.
       */
      canDecode(state: FabricValue): state is FabricKeyPairMaterialState {
        return isPlainObject(state) &&
          hasOnlyKeys(state, FabricKeyPair.#MATERIAL_STATE_KEYS) &&
          Object.hasOwn(state, "algorithm") &&
          (typeof state.algorithm === "string") &&
          (["publicKey", "privateKey"] as const).every((key) =>
            Object.hasOwn(state, key) && (state[key] instanceof FabricBytes)
          );
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricKeyPairMaterialState,
        _env: LiveEnvironment,
        mutable = false,
      ): FabricValue {
        const { algorithm, publicKey, privateKey } = state;

        try {
          return new FabricKeyPair(algorithm, publicKey, privateKey);
        } catch (e) {
          return ProblematicValue.make(
            typeTag,
            state,
            `KeyPair: ${describeFailure(e)}`,
            mutable,
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
          return Object.freeze({
            publicKey: value.#state.publicKey as CryptoKey,
            privateKey: value.#state.privateKey as CryptoKey,
          });
        }

        return Object.freeze({
          algorithm: value.#state.algorithm,
          publicKey: value.publicKeyBytes.sliceBuffer(),
          privateKey: value.privateKeyBytes.sliceBuffer(),
        });
      }

      /**
       * @inheritDoc
       *
       * A state holding any key besides those of its arm is refused, being
       * one this class never writes; for the handles arm that includes an
       * `algorithm`, present even holding `undefined`.
       */
      canDecode(
        state: RealmCodecValue,
      ): state is RealmMaterialState | RealmHandleState {
        if (!isPlainObject(state)) {
          return false;
        }

        // Each field is read as an own property, so that nothing inherited
        // stands in for one.
        const own = (key: string): unknown =>
          Object.hasOwn(state, key)
            ? (state as Record<string, unknown>)[key]
            : undefined;
        const algorithm = own("algorithm");
        const publicKey = own("publicKey");
        const privateKey = own("privateKey");

        if (
          FabricKeyPair.#isCryptoKey(publicKey) &&
          FabricKeyPair.#isCryptoKey(privateKey)
        ) {
          return hasOnlyKeys(state, FabricKeyPair.#HANDLE_STATE_KEYS);
        }

        // Non-empty, which is the one thing the constructor refuses about an
        // algorithm name. Left to `decode()` it would arrive as a constructor
        // throw, which that method reports as a detached buffer -- the only
        // other way its construction can fail.
        return hasOnlyKeys(state, FabricKeyPair.#MATERIAL_STATE_KEYS) &&
          (typeof algorithm === "string") && (algorithm !== "") &&
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
   * Nonterminal: the state is the algorithm name and the two keys as
   * `FabricBytes`, each a `FabricValue` the walker expands in turn.
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
