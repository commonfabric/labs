/**
 * Ed25519 signature verification that completes synchronously, for a caller
 * that decides inside a synchronous transaction, such as the memory engine's
 * commit admission. The asynchronous `VerifierIdentity` is the one to use
 * anywhere an `await` is possible. This one verifies by the rule
 * `@noble/ed25519` applies by default, hashing with `@noble/hashes`, since
 * WebCrypto offers no synchronous digest.
 */

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

import { didToBytes, isCanonicalEd25519DID } from "./utils.ts";

// `@noble/ed25519` takes its synchronous SHA-512 from this one shared slot,
// and the asynchronous calls the rest of this package makes take theirs from
// another, so filling it changes nothing they do.
ed25519.hashes.sha512 ??= sha512;

/**
 * Whether `signature` is `signer`'s Ed25519 signature over `payload`, where
 * `signer` is a canonical Ed25519 `did:key`. Returns `false` for a signer that
 * is not one, and for a signature of the wrong length, rather than throwing:
 * every such input is a signature that does not verify.
 */
export function verifyEd25519SignatureSync(
  signer: string,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  // The library throws only for an argument of the wrong length, which the
  // checks here rule out; a malformed point or encoding verifies as `false`.
  if (!isCanonicalEd25519DID(signer) || signature.length !== 64) return false;
  return ed25519.verify(signature, payload, didToBytes(signer));
}
