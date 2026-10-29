/**
 * Sealed-box delivery for personal reporting keys. The requester generates
 * an X25519 identity and pastes the public half — the recipient string —
 * into the minting workflow's input; the workflow seals the key file to
 * that recipient, and only the requester's stored identity opens it. The
 * box is X25519 ECDH with an ephemeral sender key, HKDF-SHA256, and
 * AES-256-GCM, all from Web Crypto; the recipient and ephemeral public
 * keys are bound through the key derivation's salt, so a box with either
 * substituted derives a different key and fails authentication.
 *
 * A recipient string is `cfr1` followed by the base64url raw public key. A
 * delivery fingerprint — the first thirty-two hex digits of the recipient
 * string's SHA-256 — names the workflow artifact, so a requester's tool
 * finds its own delivery without reading anyone else's.
 */

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";

const RECIPIENT_PREFIX = "cfr1";
const HKDF_INFO = "common-fabric test-records key delivery v1";

export interface SealedBox {
  v: 1;

  /** Ephemeral sender public key, base64url raw. */
  epk: string;

  /** AES-GCM nonce, base64url. */
  iv: string;

  /** Ciphertext with tag, base64url. */
  ct: string;
}

export interface KeyDeliveryIdentity {
  /** The recipient string to paste into the minting workflow. */
  recipient: string;

  /** X25519 private key, base64url PKCS#8. */
  privateKey: string;
}

/** Generates a fresh delivery identity. */
export async function generateIdentity(): Promise<KeyDeliveryIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const rawPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    recipient: RECIPIENT_PREFIX + toUnpaddedBase64url(rawPublic),
    privateKey: toUnpaddedBase64url(pkcs8),
  };
}

/** Whether a string is a well-formed recipient. */
export function isRecipient(text: string): boolean {
  if (!text.startsWith(RECIPIENT_PREFIX)) return false;
  try {
    return fromBase64url(text.slice(RECIPIENT_PREFIX.length)).length === 32;
  } catch {
    return false;
  }
}

/** The fingerprint that names a delivery artifact. */
export async function recipientFingerprint(recipient: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(recipient),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  epkRaw: Uint8Array,
  recipientRaw: Uint8Array,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  const salt = new Uint8Array(epkRaw.length + recipientRaw.length);
  salt.set(epkRaw, 0);
  salt.set(recipientRaw, epkRaw.length);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    shared,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals plaintext to a recipient string. */
export async function seal(
  recipient: string,
  plaintext: Uint8Array,
): Promise<SealedBox> {
  if (!isRecipient(recipient)) {
    throw new Error("not a test-records delivery recipient");
  }
  const recipientRaw = fromBase64url(recipient.slice(RECIPIENT_PREFIX.length));
  const recipientKey = await crypto.subtle.importKey(
    "raw",
    recipientRaw as BufferSource,
    { name: "X25519" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const epkRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey),
  );
  const aesKey = await deriveAesKey(
    ephemeral.privateKey,
    recipientKey,
    epkRaw,
    recipientRaw,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aesKey,
      plaintext as BufferSource,
    ),
  );
  return {
    v: 1,
    epk: toUnpaddedBase64url(epkRaw),
    iv: toUnpaddedBase64url(iv),
    ct: toUnpaddedBase64url(ct),
  };
}

/** Opens a sealed box with the stored identity. */
export async function open(
  identity: KeyDeliveryIdentity,
  box: SealedBox,
): Promise<Uint8Array> {
  if (box.v !== 1) throw new Error(`unknown sealed-box version ${box.v}`);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64url(identity.privateKey) as BufferSource,
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const epkRaw = fromBase64url(box.epk);
  const ephemeralPublic = await crypto.subtle.importKey(
    "raw",
    epkRaw as BufferSource,
    { name: "X25519" },
    false,
    [],
  );
  const recipientRaw = fromBase64url(
    identity.recipient.slice(RECIPIENT_PREFIX.length),
  );
  const aesKey = await deriveAesKey(
    privateKey,
    ephemeralPublic,
    epkRaw,
    recipientRaw,
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(box.iv) as BufferSource },
    aesKey,
    fromBase64url(box.ct) as BufferSource,
  );
  return new Uint8Array(plaintext);
}
