/**
 * Who may release a stored confidentiality clause on their own authority, the
 * specification's `canReleaseStoredClause` (§8.12.7 route 2c), with the clause
 * and commitment forms it reads. It lives here, below the runner, so that the
 * store recognizes the owner release §8.12.9 admits by the same decision the
 * runtime's release makes. The runner's CFC modules re-export each name
 * their callers import it by.
 */

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  hashStringOf,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import { classifyAtomField } from "./cfc-label-fields.ts";

/**
 * CNF confidentiality clauses (spec §3.1.8 / §4.2.1; Epic A of
 * docs/history/plans/cfc-future-work-implementation.md).
 *
 * A confidentiality label is a conjunction of clauses. Each clause is either
 * a bare atom (a singleton clause — every entry in today's flat labels) or an
 * authored/exchange-produced disjunction written as `{ anyOf: [atom, …] }`.
 * The `anyOf` wrapper is the wire discriminator, chosen so a clause-unaware
 * reader deep-equals the whole object against ceiling atoms, finds no match,
 * and treats the data as MORE restricted — never less (mixed-version
 * fail-closed by construction).
 *
 * The `anyOf` key is therefore reserved: an atom must never use it. To keep
 * accidental collisions fail-closed, only a record whose SOLE own key is
 * `anyOf` (with an array value) is recognized as a clause; any other shape
 * stays an opaque atom (unsatisfiable against ceilings — restrictive).
 */
export type CfcOrClause = { readonly anyOf: readonly CfcAtom[] };

/** A confidentiality clause: a bare atom, or an OR of atoms. */
export type CfcConfClause = CfcAtom | CfcOrClause;

export const isOrClause = (value: unknown): value is CfcOrClause =>
  isObjectNotArray(value) &&
  Array.isArray((value as { anyOf?: unknown }).anyOf) &&
  Object.keys(value).length === 1;

/** The alternatives of a clause; a bare atom is its own single alternative. */
export const clauseAlternatives = (
  clause: CfcConfClause,
): readonly CfcAtom[] => isOrClause(clause) ? clause.anyOf : [clause];

/**
 * Cross-space label-metadata representation (inv-12 Stage 1 / SC-25;
 * docs/specs/cfc-label-metadata-confidentiality.md §2/§5; spec §4.6.4.1).
 *
 * At the cross-space persist seam, every commitment-classified source-bearing
 * atom field (per `label-field-classification.ts`) is replaced by its
 * unsalted canonical digest, wrapped in the self-describing marker
 * `{digestOf: "<hash>"}` so consumers dispatch on SHAPE — transformed and
 * verbatim envelopes coexist without migration (a pre-Stage-1 envelope is
 * simply one whose fields are all plaintext).
 *
 * Reserved-key discipline (mirrors `clause.ts`'s `anyOf` and
 * `atom-pattern.ts`'s `var`): only a record whose SOLE own key is `digestOf`
 * with a string value is a commitment marker. A record carrying `digestOf`
 * in any other arrangement is malformed and stays an opaque value — it never
 * digest-matches anything and only equals its structural equal (fail-closed
 * in both directions: crafted atom data cannot impersonate a marker, and a
 * malformed marker cannot match plaintext).
 *
 * Digesting uses `hashStringOf` — the shipped canonical record digest
 * (`valueDigest` / `evidenceDigest` idiom; UTF-8-sorted keys, stable number
 * formatting) — so the same field value digests identically across runtimes
 * and re-derivations (SC-11 idempotence). Privacy honesty (spec §4.6.4.1):
 * commitments of low-entropy identifiers are PROBE-ABLE; this form hides
 * identities from observation, not targeted enumeration.
 */
export type CfcFieldCommitment = { readonly digestOf: string };

/** Exact marker shape: sole own key `digestOf`, string value (see module doc). */
export const isCfcFieldCommitment = (
  value: unknown,
): value is CfcFieldCommitment =>
  isObjectNotArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { digestOf?: unknown }).digestOf === "string";

/**
 * Structural equality extended across the commitment marker: when exactly
 * one side is a marker, the plaintext side's canonical digest is compared
 * against the committed digest — the same-form matching rule of spec
 * §4.6.4.1 ("gating digests the candidate and compares"). Marker-vs-marker
 * and plaintext-vs-plaintext reduce to plain structural equality; records
 * and arrays compare fieldwise/elementwise so a committed field nested
 * inside an atom still matches its plaintext counterpart.
 */
export const commitmentAwareEquals = (
  a: FabricValue,
  b: FabricValue,
): boolean => {
  if (valueEqual(a, b)) return true;
  const aIsCommitment = isCfcFieldCommitment(a);
  const bIsCommitment = isCfcFieldCommitment(b);
  if (aIsCommitment !== bIsCommitment) {
    const commitment = (aIsCommitment ? a : b) as CfcFieldCommitment;
    const plain = aIsCommitment ? b : a;
    return hashStringOf(plain) === commitment.digestOf;
  }
  if (aIsCommitment) {
    // Both markers and not equal: different digests.
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length &&
      a.every((element, index) => commitmentAwareEquals(element, b[index]));
  }
  if (isFabricPlainObject(a) && isFabricPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) =>
      Object.hasOwn(b, key) && commitmentAwareEquals(a[key], b[key])
    );
  }
  return false;
};

/** Whether `value` is a record with exactly the keys named. */
export const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/**
 * Whether one confidentiality alternative stands for the actor alone. Each
 * shape is matched on its exact key set, so an atom carrying any further
 * field (a `hash` binding a named policy, a `scope`) is never the actor's.
 */
export const isActorOwnedAlternative = (
  atom: unknown,
  actor: string,
): boolean => {
  if (typeof atom === "string") return atom === actor;
  if (!isObjectNotArray(atom)) return false;
  switch (atom.type) {
    case CFC_ATOM_TYPE.User:
      return hasExactKeys(atom, ["type", "subject"]) &&
        atom.subject === actor;
    case CFC_ATOM_TYPE.Context:
      return hasExactKeys(atom, ["type", "name", "subject"]) &&
        typeof atom.name === "string" && atom.subject === actor;
    case CFC_ATOM_TYPE.Resource:
      return hasExactKeys(atom, ["type", "class", "subject"]) &&
        typeof atom.class === "string" && atom.subject === actor;
    // The actor's home space is the space named by the actor's own DID. Its
    // access list is the actor's to write, so what it admits is the actor's
    // decision, as with a clause naming the actor.
    case CFC_ATOM_TYPE.Space:
      return hasExactKeys(atom, ["type", "id"]) && atom.id === actor;
    case CFC_ATOM_TYPE.PersonalSpace:
      return hasExactKeys(atom, ["type", "owner"]) && atom.owner === actor;
    default:
      return false;
  }
};

/**
 * `atom` with each commitment-classified field that holds a digest
 * commitment to `actor`'s DID written as that DID, and every other field as
 * stored. A label crossing a space boundary stores such a field — a `User`'s
 * subject, a `PersonalSpace`'s owner — as its commitment (§4.6.4.1); a field
 * the representation table keeps public, such as a `Space`'s id, never holds
 * one, so a commitment there is left as it is and matches no one.
 */
const openActorCommitments = (atom: CfcConfClause, actor: string) =>
  isObjectNotArray(atom)
    ? Object.fromEntries(
      Object.entries(atom).map(([key, value]) => [
        key,
        classifyAtomField(atom, [key]) === "commitment" &&
          isCfcFieldCommitment(value) && commitmentAwareEquals(value, actor)
          ? actor
          : value,
      ]),
    )
    : atom;

/**
 * Whether `actor` may release `clause` on their own authority, the
 * specification's `canReleaseStoredClause` (§8.12.7): every alternative
 * stands for `actor` alone in the sense the trusted host's reviewed
 * operations share (`isActorOwnedAlternative()`, the specification's
 * `standsForActor`) — `actor` as
 * `User`, `Context` or `Resource` subject or as the bare DID, or the space
 * whose DID is `actor`'s as `Space` or `PersonalSpace`, whose access list
 * `actor` writes — with a digest commitment to `actor`'s DID read as the DID.
 * Releasing such a clause is choosing the audience of their own content
 * (§3.1.8). A clause with any other alternative — another principal, another
 * space, a policy principal, an `Expires` or a `Caveat` — is not theirs alone
 * to release.
 */
export const clauseReleasableBy = (
  clause: CfcConfClause,
  actor: string,
): boolean => {
  const alternatives = clauseAlternatives(clause);
  return alternatives.length > 0 &&
    alternatives.every((alternative) =>
      isActorOwnedAlternative(openActorCommitments(alternative, actor), actor)
    );
};
