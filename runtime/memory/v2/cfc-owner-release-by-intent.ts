/**
 * An owner release by intent (§8.12.7 route 2d): the request a space's owner
 * signs to remove named confidentiality clauses stored at one path of one
 * document in their space, the record a release commits beside it, and the
 * judgment the store and the runtime both make of the two. Everything here is
 * shared by the memory engine's commit admission (`engine.ts`) and the
 * runtime's release (`runtime/runner/src/cfc/confidentiality-release.ts`), so
 * the two decide by the same code: the purpose, the bytes signed, the request
 * and record shapes, the record's identity, the envelope digest, and the
 * clauses a stored envelope holds at a path.
 *
 * Signing is not here. A signature under {@link OWNER_RELEASE_BY_INTENT_PURPOSE}
 * stands for the owner's own decision, made in person and shown the request's
 * target and the clauses it releases; the store sees a signature and not a
 * person, so that obligation rests on the host that holds the owner's key. The
 * `cf` command that releases by intent is that host here: it signs only after
 * the owner confirms the request on a terminal. No runner API, builtin,
 * handler or client action signs under this purpose, and nothing that can be
 * handed to code should.
 *
 * The request names its document directly, by space and id at space scope,
 * and one stored path, matched literally against the paths the envelope's
 * label-map entries hold, so a release follows no link to choose what it
 * lowers and reaches one stored position. A `*` segment names the wildcard
 * position stored there, such as a container's class templates, and none of
 * the concrete positions it covers.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import { hashStringOf, isValidFabricValue } from "@commonfabric/data-model";
import { encodeDagCbor } from "@commonfabric/identity/dag-cbor";
import { isDID } from "@commonfabric/identity/did";
import { verifyEd25519SignatureSync } from "@commonfabric/identity/verify-sync";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import { aclOwner, hasConcreteOwner, isACL } from "../acl.ts";
import { cfcCanonicalClauseDigest } from "./cfc-clause-identity.ts";
import { type CfcConfClause, hasExactKeys } from "./cfc-release-authority.ts";
import {
  resolveStoredLabel,
  storedConfidentiality,
  storedLabelMapEntries,
} from "./cfc-stored-label-map.ts";

/**
 * The purpose reserved for a release by intent. It is a field of the map the
 * signer signs, so bytes signed under any other purpose, or for any other
 * format, are other bytes, and their signature does not verify as one of
 * these.
 */
export const OWNER_RELEASE_BY_INTENT_PURPOSE = "cfc.owner-release-by-intent/1";

/**
 * The id scheme of a release record. The store refuses every write of a
 * document under it except the creation of a record a verified release in the
 * same commit accounts for.
 */
export const OWNER_RELEASE_BY_INTENT_RECORD_PREFIX = "cfc-release-by-intent:";

/** What the owner signs: one release, at one path of one document. */
export interface OwnerReleaseByIntentRequest {
  /** Always {@link OWNER_RELEASE_BY_INTENT_PURPOSE}. */
  readonly purpose: typeof OWNER_RELEASE_BY_INTENT_PURPOSE;

  /** The space holding the document, which the signer owns. */
  readonly space: string;

  /** The document's id, at space scope. */
  readonly document: string;

  /**
   * The one stored path the clauses come off, matched literally: a `*`
   * segment names the wildcard position.
   */
  readonly path: readonly string[];

  /**
   * The canonical clause digest of each clause released, each once, in
   * ascending order, so a request has one form.
   */
  readonly releasedClauseDigests: readonly string[];

  /**
   * The {@link ownerReleaseByIntentEnvelopeDigest} of the document's stored
   * envelope when the request was made: a release commits only against that
   * envelope.
   */
  readonly envelopeDigest: string;

  /** The DID that signs the request, which must be the space's owner. */
  readonly signer: string;
}

/** A request with the signer's signature over its bytes. */
export interface SignedOwnerReleaseByIntentRequest {
  /** The request. */
  readonly request: OwnerReleaseByIntentRequest;

  /**
   * The Ed25519 signature over {@link ownerReleaseByIntentSignedBytes}, as
   * unpadded base64url.
   */
  readonly signature: string;
}

/**
 * The record a release commits beside the lowered envelope, as the record
 * document's value. It holds the signed request and what the release did.
 */
export interface OwnerReleaseByIntentRecord {
  /** The request, as signed. */
  readonly request: OwnerReleaseByIntentRequest;

  /** The signature over the request. */
  readonly signature: string;

  /** The space's owner, who signed. */
  readonly owner: string;

  /** The document released at. */
  readonly document: string;

  /** The path released at. */
  readonly path: readonly string[];

  /** The canonical clause digests of the clauses removed. */
  readonly removed: readonly string[];

  /** The envelope digest before the release. */
  readonly before: string;

  /** The envelope digest after the release. */
  readonly after: string;
}

/** Thrown when a request cannot be built from what it was given. */
export class OwnerReleaseByIntentError extends Error {
  override name = "OwnerReleaseByIntentError" as const;
}

const REQUEST_KEYS = [
  "purpose",
  "space",
  "document",
  "path",
  "releasedClauseDigests",
  "envelopeDigest",
  "signer",
] as const;

const SIGNED_KEYS = ["request", "signature"] as const;

const RECORD_KEYS = [
  "request",
  "signature",
  "owner",
  "document",
  "path",
  "removed",
  "before",
  "after",
] as const;

/** Whether `value` is an array of strings. */
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Whether `values` are strictly ascending, so each appears once. */
const isStrictlyAscending = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || values[index - 1] < value);

/** Whether two string arrays hold the same strings in the same order. */
const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * The problem with `request`'s fields as a request names them, or `undefined`
 * when there is none: a document id under the record scheme, an empty,
 * repeated or unordered digest list, or a space or signer that is not a DID.
 */
const requestProblem = (
  request: OwnerReleaseByIntentRequest,
): string | undefined => {
  if (request.purpose !== OWNER_RELEASE_BY_INTENT_PURPOSE) {
    return `its purpose is not \`${OWNER_RELEASE_BY_INTENT_PURPOSE}\``;
  }
  if (!isDID(request.space)) return "its space is not a DID";
  if (!isDID(request.signer)) return "its signer is not a DID";
  if (
    request.document.length === 0 ||
    request.document.startsWith(OWNER_RELEASE_BY_INTENT_RECORD_PREFIX) ||
    request.document.startsWith("cid:")
  ) {
    return "its document is not one a release can name";
  }
  if (request.releasedClauseDigests.length === 0) {
    return "it releases no clause";
  }
  if (!isStrictlyAscending(request.releasedClauseDigests)) {
    return "its clause digests are not each named once, in ascending order";
  }
  if (request.envelopeDigest.length === 0) return "it names no envelope";
  return undefined;
};

/**
 * Builds the request that releases the clauses `releasedClauseDigests` names
 * at `path` of `document` in `space`, made against the stored envelope whose
 * digest is `envelopeDigest`, to be signed by `signer`. The digests are put in
 * the request's one order.
 *
 * @throws An {@link OwnerReleaseByIntentError} if a digest is named twice, or
 *   another field is not one a request can hold.
 */
export const ownerReleaseByIntentRequest = (fields: {
  readonly space: string;
  readonly document: string;
  readonly path: readonly string[];
  readonly releasedClauseDigests: readonly string[];
  readonly envelopeDigest: string;
  readonly signer: string;
}): OwnerReleaseByIntentRequest => {
  const request: OwnerReleaseByIntentRequest = {
    purpose: OWNER_RELEASE_BY_INTENT_PURPOSE,
    space: fields.space,
    document: fields.document,
    path: [...fields.path],
    releasedClauseDigests: [...fields.releasedClauseDigests].sort(),
    envelopeDigest: fields.envelopeDigest,
    signer: fields.signer,
  };
  const problem = requestProblem(request);
  if (problem !== undefined) {
    throw new OwnerReleaseByIntentError(
      `Cannot build the request: ${problem}.`,
    );
  }
  return request;
};

/**
 * The bytes a signer signs for `request`: its fields as one DAG-CBOR map,
 * the purpose among them, whose deterministic encoding gives a request one
 * byte form.
 */
export const ownerReleaseByIntentSignedBytes = (
  request: OwnerReleaseByIntentRequest,
): Uint8Array =>
  encodeDagCbor({
    purpose: request.purpose,
    space: request.space,
    document: request.document,
    path: [...request.path],
    releasedClauseDigests: [...request.releasedClauseDigests],
    envelopeDigest: request.envelopeDigest,
    signer: request.signer,
  });

/** `signature` as a signed request carries it: unpadded base64url. */
export const ownerReleaseByIntentSignature = (signature: Uint8Array): string =>
  toUnpaddedBase64url(signature);

/** The digest naming `request`, which the record's id derives from. */
export const ownerReleaseByIntentRequestDigest = (
  request: OwnerReleaseByIntentRequest,
): string =>
  hashStringOf({
    purpose: request.purpose,
    space: request.space,
    document: request.document,
    path: [...request.path],
    releasedClauseDigests: [...request.releasedClauseDigests],
    envelopeDigest: request.envelopeDigest,
    signer: request.signer,
  });

/**
 * The id of the record a release of `document` by the request whose digest is
 * `requestDigest` commits. It names the document, so the records of the
 * releases a document underwent share a prefix, and the request, so a request
 * is used once.
 */
export const ownerReleaseByIntentRecordId = (
  document: string,
  requestDigest: string,
): string =>
  `${OWNER_RELEASE_BY_INTENT_RECORD_PREFIX}${document}:${requestDigest}`;

/**
 * The digest a request names a document's envelope by: the hash of the `cfc`
 * member as the store holds it, `null` for a document that holds none. A
 * label held by reference is named by the reference, whose `cid:` id is the
 * hash of the label, so the digest covers every label the envelope holds.
 *
 * @throws An {@link OwnerReleaseByIntentError} if `cfc` is not a value a
 *   document can store.
 */
export const ownerReleaseByIntentEnvelopeDigest = (cfc: unknown): string => {
  if (cfc === undefined) return hashStringOf(null);
  if (!isValidFabricValue(cfc)) {
    throw new OwnerReleaseByIntentError(
      "Cannot digest an envelope that is not a stored value.",
    );
  }
  return hashStringOf(cfc);
};

/**
 * `value` as a request, or `undefined` when it is not one: a record of exactly
 * the request's fields, each of its type, with no problem a built request
 * could not have.
 */
export const parseOwnerReleaseByIntentRequest = (
  value: unknown,
): OwnerReleaseByIntentRequest | undefined => {
  if (!isObjectNotArray(value) || !hasExactKeys(value, REQUEST_KEYS)) {
    return undefined;
  }
  const { purpose, space, document, path, envelopeDigest, signer } = value;
  const releasedClauseDigests = value.releasedClauseDigests;
  if (
    purpose !== OWNER_RELEASE_BY_INTENT_PURPOSE ||
    typeof space !== "string" || typeof document !== "string" ||
    !isStringArray(path) || !isStringArray(releasedClauseDigests) ||
    typeof envelopeDigest !== "string" || typeof signer !== "string"
  ) {
    return undefined;
  }
  const request: OwnerReleaseByIntentRequest = {
    purpose,
    space,
    document,
    path: [...path],
    releasedClauseDigests: [...releasedClauseDigests],
    envelopeDigest,
    signer,
  };
  return requestProblem(request) === undefined ? request : undefined;
};

/** `value` as a signed request, or `undefined` when it is not one. */
export const parseSignedOwnerReleaseByIntentRequest = (
  value: unknown,
): SignedOwnerReleaseByIntentRequest | undefined => {
  if (!isObjectNotArray(value) || !hasExactKeys(value, SIGNED_KEYS)) {
    return undefined;
  }
  const request = parseOwnerReleaseByIntentRequest(value.request);
  return request === undefined || typeof value.signature !== "string"
    ? undefined
    : { request, signature: value.signature };
};

/**
 * Whether `signed`'s signature is its signer's over the request's bytes.
 * Synchronous, so that the store decides inside its commit.
 */
export const verifyOwnerReleaseByIntentSignature = (
  signed: SignedOwnerReleaseByIntentRequest,
): boolean => {
  let signature: Uint8Array;
  try {
    signature = fromBase64url(signed.signature);
  } catch {
    return false;
  }
  return verifyEd25519SignatureSync(
    signed.request.signer,
    ownerReleaseByIntentSignedBytes(signed.request),
    signature,
  );
};

/**
 * The record a release by `signed` commits, given the digest of the envelope
 * it leaves.
 */
export const ownerReleaseByIntentRecord = (
  signed: SignedOwnerReleaseByIntentRequest,
  after: string,
): OwnerReleaseByIntentRecord => ({
  request: signed.request,
  signature: signed.signature,
  owner: signed.request.signer,
  document: signed.request.document,
  path: [...signed.request.path],
  removed: [...signed.request.releasedClauseDigests],
  before: signed.request.envelopeDigest,
  after,
});

/**
 * `value` as a record, or `undefined` when it is not one: exactly the record's
 * fields, its request well formed, and every other field the one the request
 * determines. Its `after` is a string; whether it is the digest of the
 * envelope the commit leaves is the caller's to compare.
 */
export const parseOwnerReleaseByIntentRecord = (
  value: unknown,
): OwnerReleaseByIntentRecord | undefined => {
  if (!isObjectNotArray(value) || !hasExactKeys(value, RECORD_KEYS)) {
    return undefined;
  }
  const signed = parseSignedOwnerReleaseByIntentRequest({
    request: value.request,
    signature: value.signature,
  });
  if (signed === undefined || typeof value.after !== "string") {
    return undefined;
  }
  const expected = ownerReleaseByIntentRecord(signed, value.after);
  const { path, removed } = value;
  return value.owner === expected.owner &&
      value.document === expected.document &&
      isStringArray(path) && sameStrings(path, expected.path) &&
      isStringArray(removed) && sameStrings(removed, expected.removed) &&
      value.before === expected.before
    ? expected
    : undefined;
};

/**
 * A space's access list as the store holds it: no list document at all, or a
 * list document, whose `value` may be anything, absent included. A reader
 * that has not loaded the document from the store cannot say which, so it has
 * none of these to give.
 */
export type OwnerReleaseByIntentAcl =
  | { readonly stored: false }
  | { readonly stored: true; readonly value: unknown };

/**
 * The owner a release in `space` must be signed by, per the access list the
 * store holds for it: the list's owner (`aclOwner()`), or, where the space
 * stores no access list at all, the principal whose DID the space's is, its
 * home-space owner. `undefined` where the stored list is not a valid one with
 * a concrete owner, a deleted space's tombstone among them, so no signer is
 * its owner.
 */
export const ownerReleaseByIntentSpaceOwner = (
  space: string,
  acl: OwnerReleaseByIntentAcl,
): string | undefined => {
  if (!acl.stored) return space;
  const value = acl.value;
  return isACL(value) && hasConcreteOwner(value)
    ? aclOwner(value, space)
    : undefined;
};

/** Whether `path` is the stored path `entryPath`, segment for segment. */
const isStoredPath = (
  path: readonly string[],
  entryPath: unknown,
): boolean =>
  Array.isArray(entryPath) && entryPath.length === path.length &&
  entryPath.every((segment, index) => segment === path[index]);

/**
 * The clauses the label-map entries of `cfc`, a document's `cfc` member, hold
 * at exactly `path`, by canonical clause digest, grouped by the entry's
 * component and observation class (its `origin` and `observes`), the
 * label-metadata templates aside: those describe the labels rather than label
 * the payload. `resolveLabel` returns the content of the label document a
 * `cid:` reference names, or `undefined`. Returns `undefined` when an entry at
 * the path holds a label that does not resolve, so what is stored there is not
 * known.
 */
export const clauseDigestsByEntryAt = (
  cfc: unknown,
  path: readonly string[],
  resolveLabel: (ref: string) => unknown,
): ReadonlyMap<string, ReadonlyMap<string, CfcConfClause>> | undefined => {
  const byEntry = new Map<string, Map<string, CfcConfClause>>();
  for (const entry of storedLabelMapEntries(cfc)) {
    if (entry.origin === "label-metadata" || !isStoredPath(path, entry.path)) {
      continue;
    }
    const label = resolveStoredLabel(entry.label, resolveLabel);
    const confidentiality = label === undefined
      ? undefined
      : storedConfidentiality(label);
    if (confidentiality === undefined) return undefined;
    if (confidentiality.length === 0) continue;
    const key = JSON.stringify([entry.origin ?? null, entry.observes ?? null]);
    const clauses = byEntry.get(key) ?? new Map<string, CfcConfClause>();
    byEntry.set(key, clauses);
    for (const clause of confidentiality) {
      clauses.set(
        cfcCanonicalClauseDigest(clause as CfcConfClause),
        clause as CfcConfClause,
      );
    }
  }
  return byEntry;
};

/**
 * The clauses the label-map entries of `cfc` hold at exactly `path`, by
 * canonical clause digest, every component and observation class there
 * together, as {@link clauseDigestsByEntryAt} reads them, or `undefined` when
 * what is stored there is not known.
 */
export const clauseDigestsStoredAt = (
  cfc: unknown,
  path: readonly string[],
  resolveLabel: (ref: string) => unknown,
): ReadonlyMap<string, CfcConfClause> | undefined => {
  const byEntry = clauseDigestsByEntryAt(cfc, path, resolveLabel);
  if (byEntry === undefined) return undefined;
  const stored = new Map<string, CfcConfClause>();
  for (const clauses of byEntry.values()) {
    for (const [digest, clause] of clauses) stored.set(digest, clause);
  }
  return stored;
};

/**
 * Whether `cfc`, the `cfc` member of a record's document, labels the record
 * for `owner`: a declared entry at its root holds the clause naming `owner` as
 * a `User`, so a reader other than the owner does not read it.
 */
const labeledForOwner = (
  owner: string,
  cfc: unknown,
  resolveLabel: (ref: string) => unknown,
): boolean => {
  const ownerClause = cfcCanonicalClauseDigest({
    type: CFC_ATOM_TYPE.User,
    subject: owner,
  });
  return storedLabelMapEntries(cfc).some((entry) => {
    if (
      entry.origin !== "declared" || !Array.isArray(entry.path) ||
      entry.path.length !== 0
    ) {
      return false;
    }
    const label = resolveStoredLabel(entry.label, resolveLabel);
    return (storedConfidentiality(label) ?? []).some((clause) =>
      cfcCanonicalClauseDigest(clause as CfcConfClause) === ownerClause
    );
  });
};

/** What a store holds and a commit proposes, for one record it creates. */
export interface OwnerReleaseByIntentCommit {
  /** The space the commit is in. */
  readonly space: string;

  /** The id the commit writes the record at. */
  readonly recordId: string;

  /** The value the commit leaves at the record's id. */
  readonly record: unknown;

  /** The `cfc` member the commit leaves the record's document with. */
  readonly recordCfc: unknown;

  /** Whether the store holds any state at the record's id, deleted or not. */
  readonly recordStored: boolean;

  /** The space's access list as the store holds it at the commit. */
  readonly acl: OwnerReleaseByIntentAcl;

  /**
   * The request's document as the commit treats it: the `cfc` member the
   * store holds and the one the commit leaves, or `undefined` when the
   * commit writes no envelope of that document at space scope, or deletes it.
   */
  readonly document: {
    readonly stored: unknown;
    readonly proposed: unknown;
  } | undefined;

  /** Resolves a stored label reference, as {@link clauseDigestsStoredAt}. */
  readonly resolveStoredLabel: (ref: string) => unknown;

  /**
   * Resolves a label reference of the proposed envelope, which may name a
   * label document the commit itself creates.
   */
  readonly resolveProposedLabel: (ref: string) => unknown;
}

/** A release the store has verified, as its admission of the envelope reads it. */
export interface VerifiedOwnerReleaseByIntent {
  /** The document released at. */
  readonly document: string;

  /** The path released at. */
  readonly path: readonly string[];

  /** The canonical clause digests released there. */
  readonly releasedClauseDigests: ReadonlySet<string>;
}

/**
 * Judges the record `commit` creates, as the specification's
 * `ownerReleaseByIntentAt` (§8.12.7) judges a request: returns the release it
 * verifies, or the reason it is refused. It is refused when the record is not
 * well formed or does not match its request, the purpose is another, the
 * signature does not verify, the signer is not the space's owner per the
 * access list at the commit, the request names another space, its record is
 * not at the id it derives or is already stored, the commit writes no
 * envelope of the document it names, the stored envelope's digest is not the
 * one it names, a clause it releases is not stored at the path, the proposed
 * envelope still holds one there or no longer holds a clause the request does
 * not name in an entry of the same component and class at the path, the record
 * is not labeled for its owner, or the record's `after` is not the proposed
 * envelope's digest.
 *
 * At the path, the confidentiality clauses of every entry are compared,
 * component and class by component and class. What the commit does elsewhere
 * in the envelope, at other paths, to integrity, and to the label-metadata
 * templates, is not compared here: the store judges the declared component
 * alone there (`envelope-admission.ts`), and the runtime that derives the rest
 * is the one to get it right.
 */
export const judgeOwnerReleaseByIntent = (
  commit: OwnerReleaseByIntentCommit,
):
  | { readonly verified: VerifiedOwnerReleaseByIntent }
  | { readonly refused: string } => {
  // SPEC-PENDING https://github.com/commonfabric/specs/pull/90 Route 2d, which
  // the pin does not have: a verified request admits a release of clauses
  // that are not the owner's alone.
  const refused = (reason: string) => ({ refused: reason });
  const record = parseOwnerReleaseByIntentRecord(commit.record);
  if (record === undefined) {
    return refused(
      "it is not a release record matching the request it holds",
    );
  }
  const { request } = record;
  if (request.purpose !== OWNER_RELEASE_BY_INTENT_PURPOSE) {
    return refused("its request is made under another purpose");
  }
  if (
    !verifyOwnerReleaseByIntentSignature({
      request,
      signature: record.signature,
    })
  ) {
    return refused("its request's signature does not verify");
  }
  const owner = ownerReleaseByIntentSpaceOwner(commit.space, commit.acl);
  if (owner === undefined || request.signer !== owner) {
    return refused(
      `its request is signed by ${request.signer}, who is not the owner ` +
        "the space's access list names",
    );
  }
  if (request.space !== commit.space) {
    return refused(`its request names another space, ${request.space}`);
  }
  const recordId = ownerReleaseByIntentRecordId(
    request.document,
    ownerReleaseByIntentRequestDigest(request),
  );
  if (commit.recordId !== recordId) {
    return refused("it is not at the id its request derives");
  }
  if (commit.recordStored) {
    return refused("its request has already been used");
  }
  if (commit.document === undefined) {
    return refused(
      `the commit writes no envelope of the document it names, ` +
        request.document,
    );
  }
  if (
    ownerReleaseByIntentEnvelopeDigest(commit.document.stored) !==
      request.envelopeDigest
  ) {
    return refused(
      "the document's envelope has changed since the request was made",
    );
  }
  const stored = clauseDigestsByEntryAt(
    commit.document.stored,
    request.path,
    commit.resolveStoredLabel,
  );
  const released = new Set(request.releasedClauseDigests);
  if (
    stored === undefined ||
    !request.releasedClauseDigests.every((digest) =>
      [...stored.values()].some((clauses) => clauses.has(digest))
    )
  ) {
    return refused("a clause its request releases is not stored at the path");
  }
  const left = clauseDigestsByEntryAt(
    commit.document.proposed,
    request.path,
    commit.resolveProposedLabel,
  );
  if (
    left === undefined ||
    [...left.values()].some((clauses) =>
      [...released].some((digest) => clauses.has(digest))
    )
  ) {
    return refused("the commit leaves a released clause at the path");
  }
  // Exactly the named clauses come off: every other clause an entry at the
  // path holds stays in the entry of the same component and class.
  for (const [key, clauses] of stored) {
    for (const digest of clauses.keys()) {
      if (!released.has(digest) && left.get(key)?.has(digest) !== true) {
        return refused(
          "the commit removes a clause at the path its request does not name",
        );
      }
    }
  }
  if (
    !labeledForOwner(
      record.owner,
      commit.recordCfc,
      commit.resolveProposedLabel,
    )
  ) {
    return refused(
      "it is not labeled for its owner alone: its root holds no declared " +
        "`User` clause naming the owner",
    );
  }
  if (
    record.after !==
      ownerReleaseByIntentEnvelopeDigest(commit.document.proposed)
  ) {
    return refused(
      "its `after` is not the digest of the envelope the commit leaves",
    );
  }
  return {
    verified: {
      document: request.document,
      path: request.path,
      releasedClauseDigests: new Set(request.releasedClauseDigests),
    },
  };
};
