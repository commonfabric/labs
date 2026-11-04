import { Identity } from "./identity.ts";
import { bufferSourceToArrayBuffer, random } from "./utils.ts";

const RP = "Common Fabric";
const PRF_SALT = new TextEncoder().encode("PRF_SALT");
const TIMEOUT = 60_000;
const RP_ID = () => new URL(globalThis.location.href).host;

// These are algorithms to use, in order of preference.
// We prefer ED25519 for security and size, though support
// in Chrome is behind a flag.
//
// https://www.iana.org/assignments/cose/cose.xhtml#algorithms
const ALGS: PublicKeyCredentialParameters[] = [
  { type: "public-key", alg: -8 }, // ed25519
  { type: "public-key", alg: -7 }, // es256
  { type: "public-key", alg: -257 }, // rs256
];

export interface PassKeyGetOptions {
  mediation?: "conditional";
  userVerification?: "required" | "preferred" | "discouraged";
  allowCredentials?: PublicKeyCredentialDescriptor[];
}

// A `PassKey` represents an authentication via a WebAuthn authenticator.
// A key must first be created for an origin, and then retrieved
// as a `PassKey` instance. From there, a root key `Identity` can be derived/stored.
export class PassKey {
  #credentials: PublicKeyCredential;
  private constructor(credentials: PublicKeyCredential) {
    this.#credentials = credentials;
  }

  id() {
    return this.#credentials.id;
  }

  /**
   * Generates a root key from this `PassKey`. A root key identity is
   * deterministically derived from a `PassKey`'s PRF output, a 32-byte hash,
   * which is used as ed25519 key material. Root keys can only be created from
   * a `PassKey` obtained via `PassKey.get()`.
   */
  async createRootKey(): Promise<Identity> {
    const seed = this.#prf();
    if (!seed) {
      throw new Error(
        "common-identity: No PRF found. This PassKey appears to have just been created - root keys can only be generated from PassKeys obtained via PassKey.get()",
      );
    }

    return await Identity.fromRaw(seed);
  }

  /** Returns the secret 32 bytes derived from the passkey's PRF data. */
  #prf(): Uint8Array | null {
    // PRF results are only available when calling `get()`,
    // not during key creation.
    const extResults = this.#getCredentials().getClientExtensionResults();
    const prf = extResults?.prf?.results?.first;
    if (prf) {
      return new Uint8Array(bufferSourceToArrayBuffer(prf));
    } else {
      return null;
    }
  }

  /**
   * Registers a new passkey with a WebAuthn authenticator. In browsers, this
   * must be called via a user gesture.
   *
   * A passkey may still be created with an authenticator even if the procedure
   * fails, e.g. the authenticator or browser is missing some needed features
   * that can only be determined after key creation.
   *
   * Different data is available within `PublicKeyCredentials` depending on
   * whether it was created or retrieved. We need the PRF assertion only
   * available on `get` requests, so we don't return a `PassKey` here.
   */
  static async create(name: string, displayName: string): Promise<PassKey> {
    const challenge = random(32);
    const userId = random(32);
    const user = {
      id: userId as BufferSource,
      name,
      displayName,
    };

    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: challenge as BufferSource,
      rp: { id: RP_ID(), name: RP },
      user,
      attestation: "none", // default
      authenticatorSelection: {
        // "Resident Keys" have been renamed to "Discoverable Keys",
        // and we explicitly want to require the key to be discoverable.
        // The typical alternative would be a server storing a public key
        // reference used in the credential `get()` request to select
        // a specific key.
        residentKey: "required",
        // `requireResidentKey` is deprecated, where `residentKey` is
        // preferred, but set it anyway.
        requireResidentKey: true,
        userVerification: "preferred", // default
      },
      pubKeyCredParams: ALGS,
      extensions: { prf: { eval: { first: PRF_SALT } } },
      timeout: TIMEOUT,
    };

    const result = (await navigator.credentials.create({ publicKey })) as
      | PublicKeyCredential
      | null;
    if (!result) {
      throw new Error("common-identity: Could not create passkey");
    }
    const extResults = result.getClientExtensionResults();
    if (!extResults?.prf?.enabled) {
      throw new Error("common-identity: prf extension not supported.");
    }

    return new PassKey(result);
  }

  /**
   * Retrieves a `PassKey` from a WebAuthn authenticator. In browsers, this
   * must be called via a user gesture.
   */
  static async get({
    userVerification,
    mediation,
    allowCredentials = [],
  }: PassKeyGetOptions = {}): Promise<PassKey> {
    // Select any credential available with the same `RP_ID`.
    const credential = (await navigator.credentials.get({
      publicKey: {
        allowCredentials,
        challenge: random(32) as BufferSource,
        rpId: RP_ID(),
        userVerification: userVerification ?? "preferred",
        extensions: { prf: { eval: { first: PRF_SALT } } },
        timeout: TIMEOUT,
      },
      mediation,
    })) as PublicKeyCredential | null;

    if (!credential) {
      throw new Error("common-identity: Could not create credentials.");
    }

    // PRF results are only available when calling `get()`,
    // not during key creation.
    const extResults = credential.getClientExtensionResults();
    const prf = extResults?.prf?.results?.first;
    if (!prf) {
      throw new Error("common-identity: prf extension not supported.");
    }
    return new PassKey(credential);
  }

  #getCredentials(): PublicKeyCredential {
    return this.#credentials;
  }
}
