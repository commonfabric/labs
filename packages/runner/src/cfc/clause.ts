import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import { parseDID } from "@commonfabric/identity/did";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { atomEntails } from "./atom-pattern.ts";
import { isCfcFieldCommitment } from "./label-representation.ts";
import { compareByCanonicalHash, uniqueCfcAtoms } from "./atoms.ts";

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
 * Canonical form of a clause:
 * - a non-clause value (bare atom) is returned unchanged (identity — flat
 *   labels are byte-identical through canonicalization);
 * - an OR-clause gets its alternatives structurally deduped and sorted by
 *   canonical value hash, so two clauses that differ only in alternative
 *   insertion order canonicalize (and hash) identically;
 * - a singleton `{anyOf: [a]}` unwraps to the bare atom `a` (semantically
 *   identical, so the two spellings must not hash differently) — UNLESS `a`
 *   is itself clause-shaped: `{anyOf: [{anyOf: […]}]}` is malformed (the
 *   reserved key must not appear in atom position), and its sole alternative
 *   is an opaque, unsatisfiable atom. Unwrapping would PROMOTE that inner
 *   value into an active OR-clause, loosening what the raw label admits —
 *   the wrong direction. Malformed nesting stays wrapped and opaque;
 * - an empty `{anyOf: []}` is kept as-is: it is an unsatisfiable clause
 *   (see `clauseSubsumes` for how both positions treat it fail-closed).
 *
 * Canonicalization never merges clauses, never unions alternative sets
 * across clauses, and never dedups an atom across a singleton clause and an
 * OR-clause containing it — `[A]` and `[A ∨ B]` are different constraints
 * (spec §3.1.8 normalization prohibitions).
 */
export const normalizeClause = (clause: CfcConfClause): CfcConfClause => {
  if (!isOrClause(clause)) return clause;
  const unique = uniqueCfcAtoms(clause.anyOf);
  if (unique.length === 1 && !isOrClause(unique[0])) return unique[0];
  return { anyOf: unique.sort(compareByCanonicalHash) };
};

/** Structural clause equality, insensitive to alternative order. */
export const clausesEqual = (
  left: CfcConfClause,
  right: CfcConfClause,
): boolean => deepEqual(normalizeClause(left), normalizeClause(right));

/**
 * Whether a value is a DID naming both of its parts: `isDID` alone admits
 * `did:` and `did:key`, which name no principal for the rewrite below to
 * restate.
 */
const isCompleteDID = (value: unknown): boolean => {
  const parsed = parseDID(value);
  return parsed !== undefined && parsed.method !== "" && parsed.id !== "";
};

/**
 * A `PersonalSpace(owner)` label alternative, restated as the one principal
 * every reading of the atom puts inside its audience: its owner.
 *
 * The atom is a SPACE principal, not a person. §15.2 and §4.1.2 both call it
 * a convenience form for a per-user space principal, and §4.9.4 generates its
 * reader fact by a §4.9.3 point query against that space's own ACL record,
 * calling it one of "the two `Space(...)` atoms". §3.6.4 does give a personal
 * space fixed membership, but only while it stays personal: its own sharing
 * bullet has adding a member CONVERT the space into a shared one, and §3.6.5
 * rewrites no labels when that happens. A `PersonalSpace(P)` clause stamped
 * beforehand therefore goes on naming a space that has stopped being
 * personal, which is what defeats reading its audience as one person.
 *
 * What holds regardless is the role hierarchy. §3.6.2 states `owner ⊃ writer
 * ⊃ reader` — "owners are implicitly writers; writers are implicitly readers"
 * — and §3.6.4 makes the named principal the space's sole owner, so the owner
 * is one of its readers by the role order rather than by any particular ACL
 * configuration. A ceiling whose audience is that owner is therefore inside
 * the label's audience however the membership has since changed, which is
 * what the fit test asks. This is a fact about space membership, not a
 * spelling equivalence, and it runs on the LABEL side only. In a ceiling the
 * same rewrite would claim a store declaring the atom is read by that person
 * ALONE — the reverse containment, which nothing establishes.
 *
 * Only the canonical two-field shape participates, and only when its `owner`
 * is a complete DID — the type §15.2 gives the field — or the §4.6.4.1
 * `{digestOf}` commitment the cross-space seam persists that field as. A
 * record carrying further fields, or an `owner` that is neither, is not the
 * atom it resembles and gets no reading either. Complete means a DID that
 * names both parts, so a truncated `did:` and a method-only `did:key` get no
 * reading; that is over-refusal, which is the direction a well-formedness
 * gate should fail in.
 *
 * Both fields are checked as OWN properties, which the sibling recognizers
 * here do not bother with because they only gate a comparison. This one
 * builds an atom out of the field it reads, so a value arriving from a
 * prototype would end up inside the manufactured `User`. Label atoms come
 * from `JSON.parse` and from module source, neither of which produces one,
 * so this is closing a shape the input cannot currently take rather than a
 * live hole.
 *
 * The well-formedness test reaches the plaintext form only. A commitment is a
 * digest of whatever the field held, and the transform that produces one
 * commits every classified field without inspecting it, so a malformed owner
 * digests exactly as a DID does and this predicate cannot tell them apart.
 * The committed form of a malformed owner is therefore admitted where its
 * plaintext twin is refused. What it can be admitted AGAINST is the bound:
 * the ceiling has to name that same malformed subject, in plaintext or under
 * the same digest, and §15.2 types `User.subject` as a DID too — so reaching
 * it takes a store whose declared policy is already malformed in the matching
 * way. Closing the gap properly means validating at the commit seam or
 * carrying the field's type into the marker, neither of which belongs in a
 * fit predicate.
 */
const personalSpaceOwnerAsReader = (atom: CfcAtom): CfcAtom => {
  if (!isObjectNotArray(atom)) return atom;
  const record = atom as Record<string, CfcAtom>;
  if (
    !Object.hasOwn(record, "type") || !Object.hasOwn(record, "owner") ||
    Object.keys(record).length !== 2 ||
    record.type !== CFC_ATOM_TYPE.PersonalSpace ||
    !(isCompleteDID(record.owner) || isCfcFieldCommitment(record.owner))
  ) {
    return atom;
  }
  return { type: CFC_ATOM_TYPE.User, subject: record.owner };
};

/**
 * Clause subsumption — the ceiling-fit kernel (spec §8.10.3):
 * a ceiling clause `c` subsumes a label clause `l` when every alternative of
 * `c` appears among `l`'s alternatives (`alts(c) ⊆ alts(l)`) — then any
 * principal satisfying `c` satisfies `l`, so an observer admitted by the
 * ceiling clause is entitled to data guarded by the label clause.
 *
 * Deliberate fail-closed divergence from the pure set algebra: an EMPTY
 * ceiling clause never subsumes. Mathematically `∅ ⊆ alts(l)` holds and an
 * unsatisfiable destination-audience clause would admit any flow, but an
 * empty `anyOf` in an authored ceiling is far more likely malformed input
 * than a deliberate "nobody observes this" claim — so it contributes
 * nothing. (On the label side the algebra already fails closed: no
 * non-empty ceiling clause is a subset of an empty alternative set, so a
 * label containing `{anyOf: []}` never fits any ceiling.)
 *
 * Atom comparison is per-family entailment (`atomEntails`, Epic B1):
 * structural equality everywhere, plus the `Expires` timestamp order —
 * ceiling alternative `Expires(t_c)` entails label alternative `Expires(t_l)`
 * iff `t_c <= t_l` (every context the ceiling admits, `now <= t_c`, is one
 * the label allows). The clause generalization is per-alternative: `c ⟹ l`
 * for disjunctions iff EVERY alternative of `c` entails SOME alternative of
 * `l` — so the subset check becomes an entailment-witness check, reducing to
 * the previous deepEqual membership on order-free families.
 *
 * One case is added to that relation, on the LABEL side only: a
 * `PersonalSpace(owner)` alternative also answers a ceiling alternative
 * naming that owner, because the owner is always among their own space's
 * readers (`personalSpaceOwnerAsReader` above). Each comparison tries the
 * atoms as written first, so a clause carrying no such alternative costs
 * exactly what it did before.
 *
 * §8.12.1 states `atomLe` as structural equality plus the `Expires` order,
 * so this is a deviation from that text. It preserves the semantic criterion
 * the same section gives for the relation — satisfying the more restrictive
 * side implies satisfying the other — which is what makes it safe; the spec
 * edit it owes is recorded as SC-39.
 *
 * Clause IDENTITY is left untouched: `clausesEqual`, `normalizeClause`, and
 * `cfcCanonicalClauseDigest` still tell the two atoms apart, so a
 * mutually-subsuming pair can carry different digests. That direction is
 * fail-closed everywhere it shows — a §8.12.7 route-2b exemption naming one
 * does not exempt the other, and a ceiling meet keeps both alternatives
 * rather than collapsing them.
 */
export const clauseSubsumes = (
  ceilingClause: CfcConfClause,
  labelClause: CfcConfClause,
): boolean => {
  const ceilingAlternatives = clauseAlternatives(ceilingClause);
  if (ceilingAlternatives.length === 0) return false;
  const labelAlternatives = clauseAlternatives(labelClause);
  return ceilingAlternatives.every((ceilingAtom) => {
    return labelAlternatives.some((labelAtom) => {
      if (atomEntails(ceilingAtom, labelAtom)) return true;
      const owner = personalSpaceOwnerAsReader(labelAtom);
      return owner !== labelAtom && atomEntails(ceilingAtom, owner);
    });
  });
};

// Atom types forbidden as alternatives of an AUTHORED OR-clause (spec §3.1.8):
// alternatives must be principal-like. `Caveat` as an alternative would make a
// risk obligation dischargeable by identity ("readable by Bob OR if screened"),
// collapsing the caveat discipline; `Expires` semantics is most-restrictive-
// wins, which inverts to least-restrictive-wins as an alternative
// (`[[User(A) ∨ Expires(t)]]` world-readable until t). Both are conservative
// fail-closed rejections, relaxable later by a profile that defines the wanted
// semantics. Shared by the authored-clause gate in prepare.ts and the grant
// audience validation in grants.ts (a grant audience entry IS a future clause
// alternative — §8.12.7 route 2a) so the two cannot drift.
export const FORBIDDEN_OR_CLAUSE_ALTERNATIVE_TYPES: ReadonlySet<string> =
  new Set([
    CFC_ATOM_TYPE.Caveat,
    CFC_ATOM_TYPE.Expires,
  ]);
