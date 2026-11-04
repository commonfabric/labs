import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { base64pad } from "multiformats/bases/base64";

import {
  Ed25519CreateConfig,
  Ed25519Signer,
  Ed25519Verifier,
} from "./ed25519/index.ts";
import { AsBytes, DIDKey, Signer, Verifier } from "./interface.ts";
import { hash } from "./utils.ts";

const textEncoder = new TextEncoder();

// Creation options used in `Identity` instantiation.
export interface IdentityCreateConfig extends Ed25519CreateConfig {}

// An `Identity` represents a public/private key pair.
//
// Additional keys can be deterministically derived from an identity.
export class Identity<ID extends DIDKey = DIDKey> implements Signer<ID> {
  #keypair: Ed25519Signer<ID>;
  #verifier: VerifierIdentity<ID> | null = null;
  constructor(keypair: Ed25519Signer<ID>) {
    this.#keypair = keypair;
  }

  did() {
    return this.verifier.did();
  }

  get verifier(): VerifierIdentity<ID> {
    if (!this.#verifier) {
      this.#verifier = new VerifierIdentity(this.#keypair.verifier);
    }

    return this.#verifier;
  }

  /** Signs `payload` with this identity. */
  sign<T>(payload: AsBytes<T>) {
    return this.#keypair.sign(payload);
  }

  /** This identity's key pair. */
  get keyPair(): FabricKeyPair {
    return this.#keypair.keyPair;
  }

  /** Derives a new `Identity` given a seed string. */
  async derive<ID extends DIDKey>(
    name: string,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    const seed = textEncoder.encode(name);
    const { ok: signed, error } = await this.sign(seed);
    if (error) {
      throw error;
    }
    const signedHash = await hash(signed);
    return await Identity.fromRaw(new Uint8Array(signedHash), config);
  }

  /**
   * Derives PKCS8/PEM bytes from this identity. Implementations other than
   * noble throw, as private key material is needed to create the PKCS8/PEM
   * bytes.
   */
  toPkcs8(): Uint8Array {
    return this.#keypair.toPkcs8();
  }

  /** Generates a new identity from raw ed25519 key material. */
  static async fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.fromRaw<ID>(rawPrivateKey, config));
  }

  /** Generates a new identity. */
  static async generate<ID extends DIDKey>(
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.generate<ID>(config));
  }

  static async generateMnemonic<ID extends DIDKey>(
    config: IdentityCreateConfig = {},
  ): Promise<
    [Identity<ID>, string]
  > {
    const [signer, mnemonic] = await Ed25519Signer.generateMnemonic<ID>(config);
    return [new Identity(signer), mnemonic];
  }

  /**
   * Generates a new keypair in PKCS8, PEM encoded form.
   *
   * Due to hiding access to private key material in the JS environment (via
   * WebCrypto), we cannot simply export existing keys. If a key should be
   * stored as PKCS8, generate it with this method.
   */
  static async generatePkcs8(): Promise<Uint8Array> {
    // Not a promise, but force it for consistent interface
    return await Ed25519Signer.generatePkcs8();
  }

  /** Reads a PKCS8/PEM key. */
  static async fromPkcs8<ID extends DIDKey>(
    pkcs8: Uint8Array,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    const signer = await Ed25519Signer.fromPkcs8<ID>(pkcs8, config);
    return new Identity(signer);
  }

  static async fromMnemonic<ID extends DIDKey>(
    mnemonic: string,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    const signer = await Ed25519Signer.fromMnemonic<ID>(mnemonic, config);
    return new Identity(signer);
  }

  /**
   * Recovers the raw 32-byte ed25519 seed for this identity — the exact
   * inverse of `fromRaw()`, mirroring the `fromPkcs8()`/`toPkcs8()` pair.
   *
   * Named `toRaw`, _not_ `toEntropy`, on purpose: it returns a _seed_. Those
   * bytes are _also_ valid BIP39 entropy only because `fromMnemonic()` uses the
   * entropy directly as the seed with no KDF between — so a caller can do
   * `entropyToMnemonic(identity.toRaw())` to re-encode an existing key as a
   * phrase without re-keying. But the BIP39 vocabulary belongs at that call
   * site: if a KDF is ever introduced, `toRaw()` stays true (it still returns
   * the seed) while a hypothetical `toEntropy()` would silently start lying.
   *
   * Like `toPkcs8()`, only noble implementations can do this — WebCrypto hides
   * the private key material — and it throws otherwise.
   */
  toRaw(): Uint8Array {
    return this.#keypair.toRaw();
  }

  static async fromPassphrase<ID extends DIDKey>(
    passphrase: string,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    const rawPrivateKey = await hash(new TextEncoder().encode(passphrase));
    return new Identity(await Ed25519Signer.fromRaw<ID>(rawPrivateKey, config));
  }

  static fromString<ID extends DIDKey>(
    stringKey: string,
    config: IdentityCreateConfig = {},
  ): Promise<Identity<ID>> {
    return Identity.fromRaw(base64pad.decode(stringKey), config);
  }

  /** Reconstitutes an `Identity` from the key pair it hands out. */
  static async fromKeyPair<ID extends DIDKey>(
    keyPair: FabricKeyPair,
  ): Promise<Identity<ID>> {
    return new Identity(await Ed25519Signer.fromKeyPair(keyPair));
  }
}

export class VerifierIdentity<ID extends DIDKey> implements Verifier<ID> {
  #inner: Verifier<ID>;

  constructor(inner: Verifier<ID>) {
    this.#inner = inner;
  }

  verify(auth: { payload: Uint8Array; signature: Uint8Array }) {
    return this.#inner.verify(auth);
  }

  did(): ID {
    return this.#inner.did();
  }

  static async fromDid<ID extends DIDKey>(
    did: ID,
  ): Promise<VerifierIdentity<ID>> {
    return new VerifierIdentity(await Ed25519Verifier.fromDid(did));
  }
}
