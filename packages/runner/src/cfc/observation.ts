import type { JSONSchema, JSONValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { deepEqual, deepEqualKey } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { hashStringOf } from "@commonfabric/data-model";
import {
  cfcLabelPathPrefixMatches,
  type CfcLabelView,
} from "./label-view-core.ts";
import {
  cfcCommitmentNormalForm,
  commitmentAwareEquals,
} from "./label-representation.ts";
import {
  atomEntails,
  type AtomPattern,
  conceptGuard,
  matchAtomPattern,
} from "./atom-pattern.ts";
import type { TrustResolver } from "./trust.ts";
import {
  type CfcConfClause,
  clauseAlternatives,
  clauseSubsumes,
  normalizeClause,
} from "./clause.ts";

export type CfcObservedConfidentiality = readonly CfcConfClause[];
export type CfcObservationMaxConfidentiality =
  | readonly CfcConfClause[]
  | undefined;

// Marker confidentiality atom injected when a cell's label could not be read
// because a metadata read ERRORED (as opposed to being cleanly absent), so the
// LLM-observation path can fail CLOSED on read errors (audit item 22): a
// swallowed read error must not let confidential data serialize to the model as
// if it were public. `cfcObservationFitsCeiling` treats this marker as
// UNGRANTABLE — an observation carrying it never fits a ceiling, even one that
// names the marker, so it cannot be allow-listed by an author-supplied ceiling.
export const CFC_LABEL_READ_FAILED_ATOM = "cfc:label-read-failed";

// A clause "bears" the ungrantable read-failed marker if the marker is the
// clause itself OR any of its alternatives. Checking alternatives (not just
// whole-clause equality) is load-bearing: a marker wrapped in an OR-clause —
// `{anyOf:[MARKER, …]}` — must still be ungrantable, otherwise a ceiling that
// names the marker would subsume the wrapping clause and admit it, reopening
// the allow-list bypass the marker exists to prevent (audit item 22).
// Commitment-aware (inv-12 Stage 1): the Stage 1 transform never commits the
// marker itself (it is a bare string atom, not a classified field), so a
// `{digestOf: H(marker)}` spelling can only be crafted — and with atom
// equality now commitment-aware, a marker-naming ceiling would otherwise
// subsume that spelling. Recognize it here so BOTH forms stay ungrantable.
export const clauseBearsReadFailedMarker = (clause: unknown): boolean =>
  clauseAlternatives(clause as CfcConfClause).some((alternative) =>
    deepEqual(alternative, CFC_LABEL_READ_FAILED_ATOM) ||
    commitmentAwareEquals(alternative, CFC_LABEL_READ_FAILED_ATOM)
  );

export interface CfcOpaqueLink {
  "@link": string;
}

export interface CfcObservationResult<T = unknown> {
  value: T;
  observedConfidentiality: CfcObservedConfidentiality;
}

// How many kept atoms a candidate is compared against before the kept set is
// grouped instead. Keying an atom walks the whole of it, while a comparison
// against a different atom stops at the first property where they differ, so
// which of the two is cheaper depends on the atoms as well as on how many
// there are, and no single value is right everywhere. Measured over lists of
// distinct atoms at sizes from 9 to 128, in the two shapes that bound the
// ratio — atoms agreeing until their last property, and atoms differing at
// their first — a limit of 16 leaves a band just above itself where grouping
// costs at most about twice the scan, and is within a fifth of the best
// available cost by 128 atoms. A lower limit deepens that band; a higher one
// gives up the win where the growth is steepest.
const ATOM_SCAN_LIMIT = 16;

const atomGroupFor = (
  groups: Map<string, CfcAtom[]>,
  key: string,
): CfcAtom[] => {
  const group = groups.get(key);
  if (group !== undefined) {
    return group;
  }
  const created: CfcAtom[] = [];
  groups.set(key, created);
  return created;
};

const groupAtomsByKey = (
  atoms: readonly CfcAtom[],
): Map<string, CfcAtom[]> => {
  const groups = new Map<string, CfcAtom[]>();
  for (const atom of atoms) {
    atomGroupFor(groups, deepEqualKey(atom)).push(atom);
  }
  return groups;
};

// Structural deduplication, keeping the first spelling of each atom. The
// identity is `deepEqual` rather than reference equality, because a fabric
// conversion clones an atom rather than sharing it, so two atoms saying the
// same thing routinely have different references.
//
// Past `ATOM_SCAN_LIMIT` kept atoms, the kept set is grouped by `deepEqualKey`
// and a candidate is compared against its own group. Atoms that differ can
// share a key, so `deepEqual` still decides within a group. The grouping is
// built when a candidate arrives that would use it, so a list that ends at the
// limit pays for none of it.
export const uniqueCfcAtoms = (
  atoms: Iterable<unknown>,
): CfcAtom[] => {
  const unique: CfcAtom[] = [];
  const references = new Set<object>();
  let groups: Map<string, CfcAtom[]> | undefined;
  for (const atom of atoms) {
    if (isObjectOrArray(atom)) {
      if (references.has(atom)) continue;
    }
    if (groups === undefined && unique.length > ATOM_SCAN_LIMIT) {
      groups = groupAtomsByKey(unique);
    }
    if (groups === undefined) {
      if (!unique.some((kept) => deepEqual(kept, atom))) {
        unique.push(atom as JSONValue);
        if (isObjectOrArray(atom)) references.add(atom);
      }
      continue;
    }
    const group = atomGroupFor(groups, deepEqualKey(atom));
    if (group.some((kept) => deepEqual(kept, atom))) {
      continue;
    }
    group.push(atom as JSONValue);
    unique.push(atom as JSONValue);
    if (isObjectOrArray(atom)) references.add(atom);
  }
  return unique;
};

export const joinCfcObservedConfidentiality = (
  parts: Iterable<readonly unknown[] | undefined>,
): CfcObservedConfidentiality => {
  const joined: CfcConfClause[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      joined.push(...part);
    }
  }
  return uniqueCfcAtoms(joined);
};

// Per-class node consumption (C4, C0 §4/§7). What an observation of the
// node at `logicalPath` consumes from a class-carrying label view:
//
// - a `value` observation (serializing the node's content) consumes content
//   labels — covering and `value`-class entries — at-or-above the node
//   (ancestor content contains the node), plus `shape`/`enumerate` entries
//   AT the node itself: enumerating the node's own members reveals its
//   membership, but an ADDRESSED child does not inherit the container's
//   membership label (the C4 precision win — the caller named the path).
//   `followRef` entries are never content.
// - a `followRef` observation (rendering an opaque link handle: WHICH
//   reference sits here, without following it) consumes followRef-class
//   entries at-or-above the node and nothing else — the pointer's label,
//   not the target's content (C0 §7).
//
// Entries without a class (legacy views, carried views) stay covering for
// content — byte-identical to the pre-C4 join for value observations.
export const cfcConfidentialityForObservationNode = (
  options: {
    schema?: JSONSchema;
    labelView?: CfcLabelView;
    logicalPath?: readonly string[];
    observes?: "value" | "followRef";
  },
): CfcObservedConfidentiality => {
  const joined: unknown[] = [];
  const logicalPath = options.logicalPath ?? [];
  const observes = options.observes ?? "value";

  if (
    observes === "value" && isObjectOrArray(options.schema) &&
    isObjectOrArray(options.schema.ifc)
  ) {
    joined.push(...(options.schema.ifc.confidentiality ?? []));
  }

  if (options.labelView !== undefined) {
    for (const entry of options.labelView.entries) {
      if (!cfcLabelPathPrefixMatches(entry.path, logicalPath)) {
        continue;
      }
      const consumed = observes === "followRef"
        ? entry.observes === "followRef"
        : entry.observes === undefined || entry.observes === "value" ||
          ((entry.observes === "shape" || entry.observes === "enumerate") &&
            entry.path.length === logicalPath.length);
      if (consumed) {
        joined.push(...(entry.label.confidentiality ?? []));
      }
    }
  }

  return uniqueCfcAtoms(joined);
};

export const cfcObservationFitsCeiling = (
  confidentiality: readonly CfcConfClause[],
  observationMaxConfidentiality: CfcObservationMaxConfidentiality,
): boolean => {
  // undefined means no ceiling. A declared but empty ceiling means "public
  // only": no confidential atom is permitted. Public data (no confidentiality
  // atoms) fits any ceiling, including the empty one.
  if (observationMaxConfidentiality === undefined) {
    return true;
  }

  // The read-failed marker is UNGRANTABLE: an observation that carries it never
  // fits a declared ceiling, even one that names the marker. The atom is an
  // exported string, so an author-supplied ceiling could otherwise allow-list it
  // and defeat the fail-closed redaction (audit item 22). atomsOutsideCeiling
  // already forces the marker outside every declared ceiling; keep this explicit
  // rejection too as defense in depth for the redaction path. Inspect clause
  // alternatives, not just whole-clause equality, so a wrapped marker
  // (`{anyOf:[MARKER]}`) cannot slip past into subsumption.
  if (confidentiality.some(clauseBearsReadFailedMarker)) {
    return false;
  }

  return atomsOutsideCeiling(confidentiality, observationMaxConfidentiality)
    .length === 0;
};

/**
 * Trust context threaded through the floor predicates for CONCEPT-valued
 * requirements (Epic D5). A concept floor is satisfied only via the acting
 * principal's trust closure, so the predicates need the resolver plus who is
 * acting. Optional throughout: absent it (every pre-D5 caller, and every
 * plain-atom floor) concept requirements fail closed and plain atoms behave
 * exactly as before — the change is invisible to concrete/pattern floors.
 */
export type CfcFloorTrustContext = {
  readonly trustResolver?: TrustResolver;
  readonly actingPrincipal?: string;
};

/**
 * Does carried atom `actual` satisfy floor requirement `required`
 * (§8.10.3)? Three cases, in order:
 *
 * - A CONCEPT-valued requirement (`{type: Concept, uri}`, recognized by
 *   `conceptGuard`) is satisfied iff `actual` — a CONCRETE atom — reaches the
 *   concept in the acting principal's trust closure (spec §4.8.9, D5). It is
 *   NEVER pool-matched as a literal: a concept pattern is not structural data,
 *   and carried integrity cannot legitimately contain a Concept atom (the mint
 *   gate strips it). Evaluated per single atom — `conceptSatisfied` over a set
 *   is the ∃-over-atoms disjunction, and concept edges form a graph whose
 *   reachability from a set is the union of per-atom reachability, so testing
 *   one atom at a time gives the same answer AND tells us WHICH concrete atom
 *   is the witness (keeping the coherence machinery below well-defined).
 *   Fails closed on a malformed concept shape (`conceptGuard` → `{uri:
 *   undefined}`) or an absent resolver.
 * - Otherwise the requirement is an ATOM PATTERN — `matchAtomPattern`'s
 *   subset-field semantics let a floor name exactly the fields it demands
 *   (`{type: CaveatScreened, verdict: "pass"}` accepts any trusted mint with
 *   those fields) — with `atomEntails` layered for the ordered families.
 * - Exact structural equality is the degenerate case of both, so floors
 *   authored as concrete atoms keep their meaning.
 */
const integrityAtomSatisfies = (
  required: AtomPattern,
  actual: CfcAtom,
  trust?: CfcFloorTrustContext,
): boolean => {
  const concept = conceptGuard(required);
  if (concept !== undefined) {
    // A concept floor is satisfied ONLY by concrete evidence reaching the
    // concept in the closure — NEVER by a literal Concept atom in carried
    // integrity (spec §4.8: conceptual principals live in trust statements,
    // not carried labels; the mint gate strips any Concept atom). Reject a
    // Concept-typed `actual` locally, BEFORE the resolver, so a misconfigured
    // trust statement whose `concrete` is itself Concept-shaped cannot let a
    // smuggled `Concept` atom pool-match its way through — fail closed here
    // rather than lean on the upstream mint gate. `isObjectOrArray` admits arrays, so
    // this catches a Concept-typed array shape too.
    return concept.uri !== undefined &&
      !(isObjectOrArray(actual) &&
        (actual as { type?: unknown }).type === CFC_ATOM_TYPE.Concept) &&
      trust?.trustResolver !== undefined &&
      trust.trustResolver.conceptSatisfied(
        concept.uri,
        [actual as CfcAtom],
        trust.actingPrincipal,
      );
  }
  return matchAtomPattern(required, actual) !== null ||
    atomEntails(actual, required);
};

/**
 * Integrity-floor membership (§8.10.3 / §8.12.4.1): every required pattern
 * must be satisfied by some carried integrity atom. This is THE single
 * shared predicate for the read-side gate (`verifyInputRequirements`, via
 * the coherent form below), the write-side floor (`verifyWriteFloor`, Epic
 * D3), and the tool-input floor (llm-dialog, Epic D2), so D5's upgrade to
 * concept matching (`conceptSatisfied`) lands in ONE place instead of
 * diverging across three inlined copies. `trust` carries the acting
 * principal's closure for CONCEPT-valued requirements; omit it for plain
 * (concrete/pattern) floors.
 */
export const cfcIntegritySatisfiesFloor = (
  integrity: readonly CfcAtom[],
  requiredIntegrity: readonly CfcAtom[],
  trust?: CfcFloorTrustContext,
): boolean =>
  requiredIntegrity.every((required) =>
    integrity.some((actual) => integrityAtomSatisfies(required, actual, trust))
  );

/**
 * Witness key of a floor match (§8.10.3 `witnessKeyForRequiredMatch`): the
 * canonical identity of the concrete atom that satisfied a requirement, used
 * to demand ONE shared witness across consumed leaves. Value-bound atoms
 * keyed by `scope.valueRef` drop `scope.projection` first — two projections
 * of the same bound value are the same witness. `null` when the atom does
 * not satisfy the requirement.
 *
 * Keys hash the COMMITMENT-NORMAL form (inv-12 Stage 1): a plaintext atom
 * and its committed persisted form (`{digestOf}` fields) normalize
 * identically, so the same logical evidence consumed in both representation
 * forms across leaves — the documented mixed migration period — counts as
 * one shared witness instead of two (codex/cubic P2 on the Stage 1 PR).
 * Keys are evaluation-local (compared only within one coherence check), so
 * re-keying every atom by its normal form is invisible beyond that
 * coalescing; injectivity across distinct atoms is the digest's collision
 * resistance.
 */
export const cfcIntegrityWitnessKey = (
  required: AtomPattern,
  actual: CfcAtom,
  trust?: CfcFloorTrustContext,
): string | null => {
  if (!integrityAtomSatisfies(required, actual, trust)) return null;
  if (
    isObjectOrArray(actual) &&
    isObjectOrArray((actual as { scope?: unknown }).scope) &&
    (actual as { scope: { valueRef?: unknown } }).scope.valueRef !== undefined
  ) {
    const scope = { ...(actual as { scope: Record<string, CfcAtom> }).scope };
    delete scope.projection;
    return hashStringOf(cfcCommitmentNormalForm({ ...actual, scope }));
  }
  return hashStringOf(cfcCommitmentNormalForm(actual));
};

/**
 * Object-level coherent floor satisfaction (§8.10.3): when one
 * `requiredIntegrity` requirement spans MULTIPLE consumed descendant leaves,
 * each requirement must be satisfied by one SHARED witness atom across all
 * of them — per requirement, the intersection of the leaves' witness-key
 * sets must be non-empty. Heterogeneous per-leaf witnesses (leaf A satisfies
 * via one screening atom, leaf B via a different one) fail: "each part was
 * screened by someone" is not "the object was screened". The single-leaf
 * case reduces exactly to `cfcIntegritySatisfiesFloor`; an empty leaf set is
 * vacuously satisfied (nothing was consumed — the caller's quantification
 * decides whether the gate even runs). For a CONCEPT-valued requirement the
 * shared witness is the CONCRETE atom that reaches the concept (D5): two
 * leaves each reaching the concept via a DIFFERENT concrete atom are
 * incoherent, exactly as two different concrete screening atoms would be.
 */
export const cfcIntegritySatisfiesFloorCoherently = (
  consumedIntegrity: readonly (readonly CfcAtom[])[],
  requiredIntegrity: readonly CfcAtom[],
  trust?: CfcFloorTrustContext,
): boolean =>
  requiredIntegrity.every((required) => {
    let common: Set<string> | undefined;
    for (const integrity of consumedIntegrity) {
      const keys = new Set<string>();
      for (const actual of integrity) {
        const key = cfcIntegrityWitnessKey(required, actual, trust);
        if (key !== null) keys.add(key);
      }
      if (keys.size === 0) return false;
      common = common === undefined
        ? keys
        : new Set([...common].filter((key) => keys.has(key)));
      if (common.size === 0) return false;
    }
    return true;
  });

/**
 * The confidentiality CLAUSES in `confidentiality` that fall OUTSIDE `ceiling`
 * (the complement that makes `cfcObservationFitsCeiling` false). Fit is CNF
 * clause subsumption (spec §8.10.3, Epic A2): a label clause `l` is admitted
 * iff SOME ceiling clause `c` subsumes it — `alts(c) ⊆ alts(l)` — so a reader
 * the ceiling admits (satisfying `c`) is entitled to data guarded by `l`.
 *
 * On flat labels (every clause a singleton) this is the previous membership
 * check on every atom but one: `clauseSubsumes(a, l)` reduces to
 * `deepEqual(a, l)`, so `∃ c ∈ ceiling: deepEqual(c, l)` ≡ "the atom is in
 * the allowlist". The exception is a `PersonalSpace(owner)` LABEL, which also
 * meets a ceiling naming that owner — the owner is one of the space's
 * readers (`clause.ts`).
 *
 * The clause form additionally makes a **reader-enumeration** ceiling clause
 * `{anyOf:[r₁,…,rₖ]}` require EVERY listed reader to satisfy each label clause
 * (`∀reader ∀clause`) — closing the quantifier hole where a multi-party label
 * `[User(A),User(B)]` (nobody alone may read) wrongly fit a flat `[A,B]`
 * ceiling and was then shown to A alone.
 *
 * `CFC_LABEL_READ_FAILED_ATOM` is UNGRANTABLE (audit item 22): it is always
 * outside a DECLARED ceiling, even one that explicitly lists it, so a config
 * naming the exported marker string cannot allow-list a swallowed label-read
 * error. An `undefined` ceiling still admits it — no bound declared means no
 * check at all, matching `cfcObservationFitsCeiling`'s early return (the
 * sink-request gate never consults this helper for an undeclared ceiling).
 *
 * Shared by the prepare-time sink-request ceiling check so the gate and the
 * fits-test agree on membership semantics — including the ungrantable marker —
 * by construction.
 */
export const atomsOutsideCeiling = (
  confidentiality: readonly CfcConfClause[],
  ceiling: CfcObservationMaxConfidentiality,
): JSONValue[] => {
  if (ceiling === undefined) {
    return [];
  }
  return confidentiality.filter((clause) =>
    clauseBearsReadFailedMarker(clause) ||
    !ceiling.some((allowed) =>
      clauseSubsumes(allowed as CfcConfClause, clause as CfcConfClause)
    )
  ) as JSONValue[];
};

/**
 * Meet two confidentiality ceilings (allowlists) into the effective bound that
 * satisfies BOTH: a label fits the result iff it fits each input — the
 * both-direction property `fits(L, meet(C1,C2)) ⟺ fits(L,C1) ∧ fits(L,C2)`,
 * tested exhaustively in `cfc-clause-meet.test.ts`.
 *
 * The clause meet is the pairwise alternative-set UNION (plan decision 6,
 * corrected 2026-07-02): for every pair `(c₁ ∈ a, c₂ ∈ b)` emit the clause
 * with alternatives `alts(c₁) ∪ alts(c₂)`. Ceiling clauses sit on the
 * demanding side of subsumption (`alts(c) ⊆ alts(l)`, see
 * `atomsOutsideCeiling`), so the union demands what both parents demand:
 * `alts(c₁) ∪ alts(c₂) ⊆ alts(l)` holds iff both `c₁` and `c₂` subsume `l`
 * (soundness), and any label clause fitting both ceilings has witnesses
 * `c₁, c₂` whose union subsumes it (completeness). Do NOT intersect
 * alternative sets — fewer alternatives is a WEAKER demand, so intersection
 * loosens: `meet([{anyOf:[A,B]}], [{anyOf:[B,C]}])` as intersection gives
 * `[B]`, admitting label `[B]` that ceiling `[{anyOf:[A,B]}]` alone rejects.
 *
 * Flat/flat behavior: an equal-atom pair unions to a singleton that
 * `normalizeClause` unwraps back to the bare atom, so shared atoms survive
 * exactly as under the previous atom intersection; a cross pair of distinct
 * atoms becomes `{anyOf:[a,b]}` — decision-equivalent for flat labels (a bare
 * label atom is never subsumed by a two-alternative clause) but strictly more
 * precise for OR-labels, which the plain intersection wrongly rejected. The
 * result is O(|a|·|b|) clauses; fine for the sole production consumer
 * (`effectiveObservationCeiling` in builtins/llm-dialog.ts: pattern bound ∧
 * per-sink deployment ceiling, both tiny). Should a large-ceiling consumer
 * appear, dropping cross pairs is a sound over-restriction (it only
 * tightens); intersecting alternative sets never is.
 *
 * Each union clause is normalized (`normalizeClause`: dedup + canonical
 * order + singleton unwrap) and result clauses dedup structurally, so
 * order-differing spellings of the same clause coalesce. No absorption pass:
 * a redundant wider clause may sit beside a narrower one that subsumes
 * strictly more — harmless, it admits only a subset of what the narrower
 * clause admits (decision 4: measure before optimizing).
 *
 * Edge cases (each preserves `cfcObservationFitsCeiling` semantics):
 * - `undefined` ceiling = "no ceiling" = allow everything, so it is the
 *   identity: `meet(undefined, x) === x` and `meet(x, undefined) === x`.
 * - A declared empty ceiling is "public only"; it forms no pairs, so
 *   `meet([], x)` is `[]` — the strict bound wins.
 * - A malformed empty-alternative clause `{anyOf:[]}` never subsumes
 *   (`clauseSubsumes` fails closed), so it contributes nothing to its own
 *   ceiling and must form no pairs either — pairing it would emit its
 *   partner clause verbatim and loosen the meet past the empty-clause
 *   parent.
 *
 * Used to fold a deployment per-sink ceiling into a pattern-supplied observation
 * bound so post-commit LLM tool-loop reads cannot exceed the deployment ceiling
 * (review follow-up to #3993).
 */
export const meetCfcObservationCeilings = (
  a: CfcObservationMaxConfidentiality,
  b: CfcObservationMaxConfidentiality,
): CfcObservationMaxConfidentiality => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  function* unions(): Generator<CfcConfClause> {
    for (const clauseA of a!) {
      const alternativesA = clauseAlternatives(clauseA as CfcConfClause);
      if (alternativesA.length === 0) continue;
      for (const clauseB of b!) {
        const alternativesB = clauseAlternatives(clauseB as CfcConfClause);
        if (alternativesB.length === 0) continue;
        yield normalizeClause({
          anyOf: [...alternativesA, ...alternativesB],
        });
      }
    }
  }
  return uniqueCfcAtoms(unions());
};

export const cfcJsonPointerForPath = (
  path: readonly (string | number)[],
): string =>
  path.length === 0
    ? ""
    : `/${
      path.map((segment) =>
        String(segment).replaceAll("~", "~0").replaceAll("/", "~1")
      ).join("/")
    }`;

export const cfcOpaqueLinkForPath = (
  opaqueHandleId: string,
  path: readonly (string | number)[],
): CfcOpaqueLink => ({
  "@link": `opaque:${encodeURIComponent(opaqueHandleId)}${
    path.length === 0 ? "" : `#${cfcJsonPointerForPath(path)}`
  }`,
});
