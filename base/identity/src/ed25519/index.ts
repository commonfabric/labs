import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { AsBytes, DIDKey, Signer, Verifier } from "../interface.ts";
import { NativeEd25519Signer, NativeEd25519Verifier } from "./native.ts";
import { NobleEd25519Signer, NobleEd25519Verifier } from "./noble.ts";
import {
  ED25519_ALG,
  ed25519RawToPkcs8,
  fromPEM,
  generateEd25519Pkcs8,
  isNativeEd25519Supported,
  pkcs8ToEd25519Raw,
  toPEM,
} from "./utils.ts";

// Creation options used in `Ed25519Signer` instantiation.
export interface Ed25519CreateConfig {
  // Indicates the preference of implementation to use.
  // If not specified, "webcrypto" is preferred if supported,
  // falling back to "noble" otherwise.
  // If specified, uses that implementation if supported, failing otherwise.
  implementation?: "webcrypto" | "noble";
}

// Platform-specific implementation of an ED25519 Keypair.
//
// On browsers[0] that implement ed25519, the native Web Crypto
// `NativeEd25519` is used. Otherwise, the `@noble/ed25519` implementation
// is used.
//
// [0]: https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519
export class Ed25519Signer<ID extends DIDKey> implements Signer<ID> {
  #impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>;
  constructor(impl: NativeEd25519Signer<ID> | NobleEd25519Signer<ID>) {
    this.#impl = impl;
  }

  get verifier(): Verifier<ID> {
    return this.#impl.verifier;
  }

  get keyPair(): FabricKeyPair {
    return this.#impl.keyPair;
  }

  did() {
    return this.#impl.did();
  }

  sign<T>(payload: AsBytes<T>) {
    return this.#impl.sign(payload);
  }

  /**
   * This signer's key in PKCS8 form.
   *
   * Narrows to the implementation rather than asking the key pair which state
   * it is in: the bytes come from that class's own `privateKey()`, and the
   * narrowing is what makes that call reachable.
   *
   * @throws If this is not a "noble" implementation, the raw material being
   *   what the conversion needs.
   */
  toPkcs8() {
    if (this.#impl instanceof NobleEd25519Signer) {
      return toPEM(ed25519RawToPkcs8(this.#impl.privateKey().slice()));
    }
    throw new Error(
      'Cannot convert identity to PKCS8 format: requires "noble" implementation.',
    );
  }

  /**
   * Returns the raw 32-byte ed25519 seed. Like `toPkcs8()`, only noble
   * implementations expose the private material; WebCrypto (native) hides it,
   * so this throws. The array is freshly allocated, so the caller owns it
   * outright.
   */
  toRaw(): Uint8Array {
    if (this.#impl instanceof NobleEd25519Signer) {
      return this.#impl.privateKey().slice();
    }
    throw new Error(
      'Cannot export raw key material: requires "noble" implementation.',
    );
  }

  static async fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      await canUseNative(config)
        ? await NativeEd25519Signer.fromRaw(rawPrivateKey)
        : await NobleEd25519Signer.fromRaw(rawPrivateKey),
    );
  }

  static async generate<ID extends DIDKey>(
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    return new Ed25519Signer(
      await canUseNative(config)
        ? await NativeEd25519Signer.generate()
        : await NobleEd25519Signer.generate(),
    );
  }

  static async generateMnemonic<ID extends DIDKey>(
    config: Ed25519CreateConfig = {},
  ): Promise<
    [Ed25519Signer<ID>, string]
  > {
    const mnemonic = bip39.generateMnemonic(wordlist, 256);
    return [await Ed25519Signer.fromMnemonic(mnemonic, config), mnemonic];
  }

  static generatePkcs8(): Uint8Array {
    return toPEM(generateEd25519Pkcs8());
  }

  static async fromPkcs8<ID extends DIDKey>(
    pkcs8: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    const raw = pkcs8ToEd25519Raw(fromPEM(pkcs8));
    return await Ed25519Signer.fromRaw(raw, config);
  }

  static async fromMnemonic<ID extends DIDKey>(
    mnemonic: string,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Signer<ID>> {
    const bytes = bip39.mnemonicToEntropy(mnemonic, wordlist);
    return await Ed25519Signer.fromRaw(bytes, config);
  }

  /**
   * Reconstitutes a signer from the key pair it hands out.
   *
   * Which implementation does so is decided by the pair itself rather than by
   * a `config`: only "noble" can sign with material and only "webcrypto" can
   * sign with handles, so the state the pair is in names the one
   * implementation that can carry it.
   *
   * @throws If the pair is for another algorithm.
   */
  static async fromKeyPair<ID extends DIDKey>(
    keyPair: FabricKeyPair,
  ): Promise<Ed25519Signer<ID>> {
    if (keyPair.algorithm !== ED25519_ALG) {
      throw new Error(
        `Not an ${ED25519_ALG} key pair: it is for ${keyPair.algorithm}.`,
      );
    }

    return new Ed25519Signer(
      keyPair.hasMaterial
        ? await NobleEd25519Signer.fromKeyPair<ID>(keyPair)
        : await NativeEd25519Signer.fromKeyPair<ID>(keyPair),
    );
  }
}

export class Ed25519Verifier<ID extends DIDKey> implements Verifier<ID> {
  #impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>;
  constructor(impl: NativeEd25519Verifier<ID> | NobleEd25519Verifier<ID>) {
    this.#impl = impl;
  }

  verify(auth: { payload: Uint8Array; signature: Uint8Array }) {
    return this.#impl.verify(auth);
  }

  did() {
    return this.#impl.did();
  }

  static async fromDid<ID extends DIDKey>(
    did: ID,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      await canUseNative(config)
        ? await NativeEd25519Verifier.fromDid(did)
        : await NobleEd25519Verifier.fromDid(did),
    );
  }

  static async fromRaw<ID extends DIDKey>(
    rawPublicKey: Uint8Array,
    config: Ed25519CreateConfig = {},
  ): Promise<Ed25519Verifier<ID>> {
    return new Ed25519Verifier(
      await canUseNative(config)
        ? await NativeEd25519Verifier.fromRaw(rawPublicKey)
        : await NobleEd25519Verifier.fromRaw(rawPublicKey),
    );
  }
}

// Returns `true` if native WebCrypto should be used,
// or `false` if Noble implementation should be used.
//
// If WebCrypto explicitly requested and not supported,
// throws an error.
async function canUseNative(config: Ed25519CreateConfig = {}) {
  if (config.implementation === "webcrypto") {
    if (!(await isNativeEd25519Supported())) {
      throw new Error(
        "Required WebCrypto features are not supported on this platform.",
      );
    }
    return true;
  }
  if (config.implementation === "noble") {
    return false;
  }
  return await isNativeEd25519Supported();
}
