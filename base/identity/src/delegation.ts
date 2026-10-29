/**
 * UCAN delegations: one principal handing another its authority over a space,
 * as a signed envelope anything holding the issuer's DID can verify.
 *
 * This codec issues and decodes UCAN 1.0 delegations whose subject is a
 * space or `null` for authority over any subject, whose command is a path
 * under `/`, and whose policy is empty. The memory server requires a space
 * subject. A delegation is encoded as the UCAN specification requires, a
 * DAG-CBOR envelope of the issuer's signature and the signed payload, and is
 * identified by a CIDv1 over those bytes with the DAG-CBOR codec and a
 * SHA-256 multihash, written in base58btc. The bytes are the delegation: a
 * holder keeps and presents them as issued, and the CID a verifier computes
 * over them is the CID the issuer produced.
 *
 * Decoding is strict. The envelope, the signed payload, and the delegation
 * payload must each hold exactly the fields this shape has, and an envelope
 * carrying anything else, a non-empty policy among it, is refused. That is
 * what lets a verifier reason about every delegation it admits.
 */

import { CID } from "multiformats/cid";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";

import {
  DAG_CBOR_CODE,
  type DagCborValue,
  decodeDagCbor,
  encodeDagCbor,
  isDagCborMap,
} from "./dag-cbor.ts";
import type { DIDKey } from "./did.ts";
import { isCanonicalEd25519DID } from "./ed25519/utils.ts";
import { VerifierIdentity } from "./identity.ts";
import type { AsBytes, Signer } from "./interface.ts";

/** The envelope tag of a UCAN delegation. */
export const DELEGATION_TAG = "ucan/dlg@1.0.0";

/**
 * The varsig v1 header of an ed25519 signature over DAG-CBOR: the varsig
 * prefix, the version, the EdDSA algorithm, the ed25519 curve, the SHA-512
 * multihash ed25519 hashes with, and the DAG-CBOR payload encoding.
 */
export const ED25519_DAG_CBOR_VARSIG: Uint8Array = new Uint8Array([
  0x34,
  0x01,
  0xed,
  0x01,
  0xed,
  0x01,
  0x13,
  DAG_CBOR_CODE,
]);

/** The bytes of randomness a delegation's nonce carries when none is given. */
const NONCE_LENGTH = 12;

/** The fields of a delegation, as its issuer signed them. */
export interface DelegationPayload {
  /** The issuer: the principal handing authority down. */
  readonly iss: DIDKey;

  /** The audience: the principal receiving it. */
  readonly aud: DIDKey;

  /**
   * The subject: the space the authority is over, or `null` for authority
   * over any subject. The codec supports both; the memory server requires
   * a space subject.
   */
  readonly sub: DIDKey | null;

  /**
   * The command the authority covers, as a path: `/` covers every command,
   * and `/memory` covers every command under it. See
   * {@link delegationCovers}.
   */
  readonly cmd: string;

  /**
   * The caveats, in UCAN's policy language. Empty is the one policy this
   * shape issues or admits; a non-empty one is refused.
   */
  readonly pol: readonly unknown[];

  /** Random bytes that make two otherwise identical delegations differ. */
  readonly nonce: Uint8Array;

  /** Unix seconds the delegation expires at, or `null` for never. */
  readonly exp: number | null;

  /** Unix seconds the delegation is valid from; absent means from issue. */
  readonly nbf?: number;
}

/** A delegation: its bytes as issued, their CID, and what they decode to. */
export interface Delegation {
  /** The DAG-CBOR envelope, exactly as the issuer encoded it. */
  readonly bytes: Uint8Array;

  /** The CIDv1 of `bytes`, in base58btc. */
  readonly cid: string;

  /** The signed fields. */
  readonly payload: DelegationPayload;

  /** The issuer's signature over the DAG-CBOR encoding of the signed payload. */
  readonly signature: Uint8Array;
}

/** What {@link issueDelegation} takes: the payload less what it fills in. */
export interface DelegationFields {
  readonly aud: DIDKey;
  readonly sub: DIDKey | null;
  readonly cmd: string;
  /** The policy; `[]`, since no other is admitted. */
  readonly pol: readonly unknown[];
  /** Defaults to `null`: a delegation that does not expire. */
  readonly exp?: number | null;
  readonly nbf?: number;
  /** Defaults to fresh random bytes. */
  readonly nonce?: Uint8Array;
}

/** Thrown when bytes are not a delegation, or a delegation does not verify. */
export class DelegationError extends Error {
  override name = "DelegationError" as const;
}

const payloadToDagCbor = (payload: DelegationPayload): DagCborValue => ({
  iss: payload.iss,
  aud: payload.aud,
  sub: payload.sub,
  cmd: payload.cmd,
  pol: payload.pol as DagCborValue,
  nonce: payload.nonce,
  exp: payload.exp,
  ...(payload.nbf === undefined ? {} : { nbf: payload.nbf }),
});

/** The DAG-CBOR encoding of the signed payload: what the signature covers. */
const signedPayloadBytes = (payload: DelegationPayload): Uint8Array =>
  encodeDagCbor({
    h: ED25519_DAG_CBOR_VARSIG,
    [DELEGATION_TAG]: payloadToDagCbor(payload),
  });

/** The CID of a delegation's envelope bytes, in base58btc. */
export async function delegationCid(bytes: Uint8Array): Promise<string> {
  // multiformats' hasher rather than `@commonfabric/content-hash`: a CID is
  // built from a multihash digest, which this returns with its algorithm code
  // and encoded form, where `content-hash` returns the bare digest bytes.
  const digest = await sha256.digest(bytes);
  return CID.createV1(DAG_CBOR_CODE, digest).toString(base58btc);
}

/**
 * Issues a delegation from `signer` with `fields`, returning it in every form
 * a holder needs. The signer's DID is the issuer.
 */
export async function issueDelegation(
  signer: Signer<DIDKey>,
  fields: DelegationFields,
): Promise<Delegation> {
  const payload: DelegationPayload = {
    iss: signer.did(),
    aud: fields.aud,
    sub: fields.sub,
    cmd: fields.cmd,
    pol: fields.pol,
    nonce: fields.nonce ??
      crypto.getRandomValues(new Uint8Array(NONCE_LENGTH)),
    exp: fields.exp ?? null,
    ...(fields.nbf === undefined ? {} : { nbf: fields.nbf }),
  };
  checkPayload(payload);
  const signed = await signer.sign(
    signedPayloadBytes(payload) as AsBytes<DelegationPayload>,
  );
  if (signed.error) throw signed.error;
  const signature = new Uint8Array(signed.ok);
  const bytes = encodeDagCbor([
    signature,
    { h: ED25519_DAG_CBOR_VARSIG, [DELEGATION_TAG]: payloadToDagCbor(payload) },
  ]);
  return { bytes, cid: await delegationCid(bytes), payload, signature };
}

const checkPayload = (payload: DelegationPayload): void => {
  for (const field of ["iss", "aud"] as const) {
    if (!isCanonicalEd25519DID(payload[field])) {
      throw new DelegationError(`${field} is not an ed25519 did:key`);
    }
  }
  if (payload.sub !== null && !isCanonicalEd25519DID(payload.sub)) {
    throw new DelegationError("sub is not an ed25519 did:key or null");
  }
  if (!isCommandPath(payload.cmd)) {
    throw new DelegationError("cmd is not a command path");
  }
  if (payload.pol.length !== 0) {
    throw new DelegationError("pol is not empty");
  }
  if (payload.nonce.length === 0) {
    throw new DelegationError("nonce is empty");
  }
  if (payload.exp !== null && !isUnixSeconds(payload.exp)) {
    throw new DelegationError("exp is not a non-negative integer or null");
  }
  if (payload.nbf !== undefined && !isUnixSeconds(payload.nbf)) {
    throw new DelegationError("nbf is not a non-negative integer");
  }
};

/** Whether `value` is a unix time in seconds: a non-negative safe integer. */
const isUnixSeconds = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Whether `cmd` is a command path: `/`, or `/` followed by segments of
 * lowercase letters, digits, `.`, `-` and `_` joined by `/`.
 *
 * This is narrower than UCAN's command grammar, which admits more characters
 * in a segment and leaves open whether two spellings of a segment name one
 * command. Holding a segment to this alphabet, lowercase and without
 * escapes, gives every command one spelling, so that {@link delegationCovers}
 * can decide coverage by comparing strings and no delegation covers more or
 * less than it reads as covering.
 */
const isCommandPath = (cmd: string): boolean =>
  cmd === "/" || /^(\/[a-z0-9._-]+)+$/.test(cmd);

/**
 * Whether a delegation whose command is `cmd` covers `command`: the two are
 * equal, or `cmd` is a proper path prefix of `command`. `/` covers everything.
 */
export function delegationCovers(cmd: string, command: string): boolean {
  if (cmd === "/") return true;
  return command === cmd || command.startsWith(`${cmd}/`);
}

const sameKeys = (
  map: { readonly [key: string]: DagCborValue },
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(map);
  return required.every((key) => key in map) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Decodes `bytes` as a delegation envelope, checking its shape and computing
 * its CID, but not its signature; {@link verifyDelegation} checks that.
 * Throws a {@link DelegationError} for bytes that are not a delegation of
 * the shape this repository issues.
 */
export async function decodeDelegation(bytes: Uint8Array): Promise<Delegation> {
  let envelope: DagCborValue;
  try {
    envelope = decodeDagCbor(bytes);
  } catch (error) {
    throw new DelegationError(
      `not DAG-CBOR: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(envelope) || envelope.length !== 2) {
    throw new DelegationError("envelope is not a two-element array");
  }
  const [signature, signed] = envelope;
  if (!(signature instanceof Uint8Array)) {
    throw new DelegationError("envelope signature is not bytes");
  }
  if (!isDagCborMap(signed) || !sameKeys(signed, ["h", DELEGATION_TAG])) {
    throw new DelegationError("signed payload is not a tagged delegation");
  }
  const header = signed.h;
  if (
    !(header instanceof Uint8Array) ||
    !bytesEqual(header, ED25519_DAG_CBOR_VARSIG)
  ) {
    throw new DelegationError(
      "varsig header is not ed25519 over DAG-CBOR",
    );
  }
  const fields = signed[DELEGATION_TAG];
  if (
    !isDagCborMap(fields) ||
    !sameKeys(fields, ["iss", "aud", "sub", "cmd", "pol", "nonce", "exp"], [
      "nbf",
    ])
  ) {
    throw new DelegationError("delegation payload has the wrong fields");
  }
  const { iss, aud, sub, cmd, pol, nonce, exp, nbf } = fields;
  if (
    typeof iss !== "string" || typeof aud !== "string" ||
    (sub !== null && typeof sub !== "string") || typeof cmd !== "string" ||
    !Array.isArray(pol) || !(nonce instanceof Uint8Array) ||
    (exp !== null && typeof exp !== "number") ||
    (nbf !== undefined && typeof nbf !== "number")
  ) {
    throw new DelegationError(
      "delegation payload has a field of the wrong kind",
    );
  }
  const payload: DelegationPayload = {
    iss: iss as DIDKey,
    aud: aud as DIDKey,
    sub: sub as DIDKey | null,
    cmd,
    pol,
    nonce,
    exp,
    ...(nbf === undefined ? {} : { nbf }),
  };
  checkPayload(payload);
  return { bytes, cid: await delegationCid(bytes), payload, signature };
}

/**
 * Verifies `delegation`'s signature against its issuer. Throws a
 * {@link DelegationError} when it does not verify.
 */
export async function verifyDelegation(delegation: Delegation): Promise<void> {
  const verifier = await VerifierIdentity.fromDid(delegation.payload.iss);
  const verified = await verifier.verify({
    payload: signedPayloadBytes(delegation.payload),
    signature: delegation.signature,
  });
  if (verified.error) {
    throw new DelegationError(
      `signature does not verify against ${delegation.payload.iss}`,
    );
  }
}
