import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  isFabricPlainObject,
  isValidFabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  commitmentAwareEquals,
  containsCfcFieldCommitment,
  isCfcFieldCommitment,
} from "./label-representation.ts";

/**
 * Atom pattern matching for the exchange-rule calculus (spec §4.3.3/§4.4.5,
 * Epic B1 of docs/history/plans/cfc-future-work-implementation.md).
 *
 * An `AtomPattern` is one of:
 * - a **concrete scalar/array** — matches by structural equality;
 * - a **variable placeholder** `{ var: "$x" }` (a record whose SOLE own key
 *   is `var`, holding a non-empty string) — matches any value and binds it;
 * - a **record pattern** `{ type: …, field: pattern|value, … }` — matches a
 *   record atom that has every named field matching the corresponding
 *   sub-pattern (recursively). Fields the pattern does not name are
 *   UNCONSTRAINED (subset semantics): a pattern names exactly what it
 *   requires, so `{ type: HasRole, space: {var:"$s"} }` matches a full
 *   HasRole atom without spelling `principal`/`role`. The `type` field has
 *   no special role in matching — it is simply the field every registry atom
 *   carries, so patterns constrain it like any other field. A named field
 *   whose pattern value is explicitly `undefined` is an ABSENCE requirement
 *   (the atom must not have that field) — expressible from TS-authored
 *   policy records, unrepresentable in JSON, and fail-closed relative to
 *   ignoring the entry.
 *
 * Reserved-key discipline (mirrors `clause.ts`'s `anyOf`): `var` inside a
 * record is EITHER the exact placeholder shape or malformed. A record
 * containing a `var` own key in any other arrangement (extra keys, non-string
 * value, empty string) matches nothing — never silently degrading to literal
 * matching, in either direction (a pattern cannot literally match atom data
 * that happens to look like `{var: …}`, and a malformed placeholder cannot
 * match anything at all).
 *
 * Bindings are unification-style: the same variable name recurring anywhere
 * across one match (or across patterns in a conjunction) must bind
 * structurally equal values — this IS the post-match equality constraint
 * between variables (§4.3.3 `constraints`, plan B1 "constraint correlation").
 *
 * NOT a `CfcAtom`: a pattern is atom-shaped but admits things an atom cannot
 * -- `{ var }` placeholders, and an explicitly-`undefined` field, which is an
 * absence check (`CfcJsonValue` has no `undefined`). It is a `FabricValue`,
 * which is what lets a pattern be digested; `isAtomPattern()` is the check.
 */
export type AtomPattern = FabricValue;

/**
 * Indicates whether `value` can be an `AtomPattern`, which is whether it is a
 * `FabricValue`. Whatever admits a pattern the type system has not vouched for
 * -- configuration, a transported manifest -- asks this before trusting it.
 */
export const isAtomPattern = (value: unknown): value is AtomPattern =>
  isValidFabricValue(value);

/** A binding environment produced by matching (spec §4.3.3 `Bindings`). */
export type AtomPatternBindings = Readonly<Record<string, CfcAtom>>;

export const EMPTY_ATOM_PATTERN_BINDINGS: AtomPatternBindings = Object.freeze(
  {},
);

type VarPlaceholder = { readonly var: string };

/**
 * The exact placeholder shape: sole own key `var`, non-empty string value.
 * Anything else that carries a `var` key is malformed (see module doc).
 */
export const isAtomVarPlaceholder = (
  value: unknown,
): value is VarPlaceholder =>
  isObjectNotArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { var?: unknown }).var === "string" &&
  (value as { var: string }).var.length > 0;

const isMalformedVarBearingRecord = (value: unknown): boolean =>
  isObjectOrArray(value) && Object.hasOwn(value, "var") &&
  !isAtomVarPlaceholder(value);

/**
 * A pattern is CONCRETE when it contains no variable placeholders (and no
 * malformed var-bearing records) anywhere. Only a concrete pattern may
 * digest-match a committed field (inv-12 Stage 1 same-form matching): the
 * digest of a pattern with holes is meaningless, and a variable cannot see
 * inside a commitment.
 */
const patternIsConcrete = (pattern: unknown): boolean => {
  if (Array.isArray(pattern)) return pattern.every(patternIsConcrete);
  if (isObjectOrArray(pattern)) {
    if (Object.hasOwn(pattern, "var")) return false;
    // An explicit-`undefined` field is the absence-requirement form — a
    // shape constraint, not a value — so the pattern is not concrete.
    return Object.values(pattern).every((field) =>
      field !== undefined && patternIsConcrete(field)
    );
  }
  return true;
};

/**
 * Matches `value` against `pattern` under `bindings`, returning the extended
 * bindings or `null`. Placeholders bind; a placeholder whose variable is
 * already bound unifies (structural equality with the prior binding) — the
 * equality-constraint mechanism. Arrays match elementwise at equal length.
 * Records use subset-field semantics (see module doc). Everything else is
 * structural equality.
 */
const matchPatternValue = (
  pattern: AtomPattern,
  value: CfcAtom,
  bindings: AtomPatternBindings,
): AtomPatternBindings | null => {
  // Reserved-key discipline applies in EITHER direction (module doc): a
  // malformed var-bearing record — `{var: "$x", type: "…"}`, `{var: 5}` — is
  // never legitimate atom data (`var` is reserved for placeholders), so as a
  // VALUE it matches nothing. Without this, a crafted label atom carrying such
  // a key would bind to a catch-all `{var}` placeholder (or satisfy a subset
  // record pattern), letting an attacker-shaped atom slip past an
  // exchange-rule guard. Checked before binding/walking, at every recursion
  // depth (nested field values are re-checked on re-entry).
  if (isMalformedVarBearingRecord(value)) {
    return null;
  }
  if (isAtomVarPlaceholder(pattern)) {
    if (Object.hasOwn(bindings, pattern.var)) {
      // Unification of an already-bound variable is commitment-aware
      // (inv-12 Stage 1 same-form matching): a variable bound to plaintext
      // from one atom digest-compares against another atom's committed
      // field — the binding comparison evidence correlation relies on,
      // extended across representation forms. Plain values reduce to
      // `valueEqual()`.
      return commitmentAwareEquals(bindings[pattern.var], value)
        ? bindings
        : null;
    }
    // A variable does NOT take a fresh binding from a committed field
    // (inv-12 Stage 1): the plaintext is not recoverable from the digest,
    // so a rule needing a variable over the field simply does not fire —
    // the fail-closed direction (spec §4.6.4.1: an unevaluable release
    // does not happen).
    if (isCfcFieldCommitment(value)) {
      return null;
    }
    return { ...bindings, [pattern.var]: value };
  }
  if (isMalformedVarBearingRecord(pattern)) {
    return null;
  }
  // The trusted module-policy resolver may seed THIS_POLICY.subject from a
  // label-carried commitment. Evidence remains plaintext locally, so the
  // commitment can appear on the PATTERN side as well as the value side.
  // Equality is symmetric; no digest is opened and a mismatch stays closed.
  if (isCfcFieldCommitment(pattern)) {
    return commitmentAwareEquals(pattern, value) ? bindings : null;
  }
  // A committed VALUE field (inv-12 Stage 1): a fully CONCRETE pattern
  // matches iff the pattern value's canonical digest equals the commitment
  // (same-form matching — the pattern side is digested and compared, the
  // committed side never opens). A pattern still carrying variables cannot
  // see inside the digest and matches nothing (fail closed). Checked before
  // the array/record arms so a marker is never subset-matched as an
  // ordinary record.
  if (isCfcFieldCommitment(value)) {
    return patternIsConcrete(pattern) && commitmentAwareEquals(pattern, value)
      ? bindings
      : null;
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value) || value.length !== pattern.length) {
      return null;
    }
    let current: AtomPatternBindings | null = bindings;
    for (let i = 0; i < pattern.length && current !== null; i++) {
      current = matchPatternValue(pattern[i], value[i], current);
    }
    return current;
  }
  if (isFabricPlainObject(pattern)) {
    // A record pattern constrains records only: an array atom never matches
    // one. A `FabricSpecialObject` pattern is not a record pattern, having no
    // fields to name; it is a leaf, compared below.
    if (!isObjectNotArray(value)) {
      return null;
    }
    let current: AtomPatternBindings | null = bindings;
    for (const [key, fieldPattern] of Object.entries(pattern)) {
      if (fieldPattern === undefined) {
        // Absence requirement (see module doc).
        if (Object.hasOwn(value, key)) return null;
        continue;
      }
      if (!Object.hasOwn(value, key)) return null;
      current = matchPatternValue(
        fieldPattern,
        (value as Record<string, CfcAtom>)[key],
        current,
      );
      if (current === null) return null;
    }
    return current;
  }
  return valueEqual(pattern, value) ? bindings : null;
};

/**
 * Matches one atom against one pattern (spec §4.3.3). Returns the extended
 * binding environment, or `null` when the atom does not match.
 */
export const matchAtomPattern = (
  pattern: AtomPattern,
  atom: CfcAtom,
  bindings: AtomPatternBindings = EMPTY_ATOM_PATTERN_BINDINGS,
): AtomPatternBindings | null => matchPatternValue(pattern, atom, bindings);

/**
 * Structural equality of binding environments: same variable set, deepEqual
 * values. Used to dedup the environments a multi-binding enumeration yields
 * (below) and by B4 to detect that a firing changed nothing.
 */
export const atomPatternBindingsEqual = (
  left: AtomPatternBindings,
  right: AtomPatternBindings,
): boolean => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) =>
    Object.hasOwn(right, key) && deepEqual(left[key], right[key])
  );
};

const pushUniqueBindings = (
  collected: AtomPatternBindings[],
  candidate: AtomPatternBindings,
): void => {
  if (
    !collected.some((existing) => atomPatternBindingsEqual(existing, candidate))
  ) {
    collected.push(candidate);
  }
};

/**
 * Multi-binding enumeration (spec §4.3.4): ALL atoms of `atoms` that match
 * `pattern`, each yielding its own extended environment — a variable matching
 * multiple atoms yields the disjunction of all valid bindings, never an
 * arbitrary first pick. Environments dedup structurally (two structurally
 * equal atoms produce one env), keeping downstream rule firings and their
 * added alternatives deterministic and duplicate-free. Result order follows
 * atom order.
 */
export const matchAtomPatternAgainstAtoms = (
  pattern: AtomPattern,
  atoms: readonly CfcAtom[],
  bindings: AtomPatternBindings = EMPTY_ATOM_PATTERN_BINDINGS,
): AtomPatternBindings[] => {
  const matched: AtomPatternBindings[] = [];
  for (const atom of atoms) {
    const extended = matchAtomPattern(pattern, atom, bindings);
    if (extended !== null) {
      pushUniqueBindings(matched, extended);
    }
  }
  return matched;
};

/**
 * Conjunction across patterns over one atom pool: every pattern must match
 * some atom, all under ONE shared environment — shared variable names unify
 * across patterns (the cross-pattern equality constraint, e.g. the §4.3.3
 * Space/HasRole correlation `Space{id:$s} ∧ HasRole{space:$s}`). Returns the
 * disjunction of all consistent environments (empty array = the conjunction
 * cannot be satisfied). An empty pattern list is vacuously satisfied by the
 * base environment.
 */
export const matchAtomPatternConjunction = (
  patterns: readonly AtomPattern[],
  atoms: readonly CfcAtom[],
  bindings: AtomPatternBindings = EMPTY_ATOM_PATTERN_BINDINGS,
): AtomPatternBindings[] => {
  let environments: AtomPatternBindings[] = [bindings];
  for (const pattern of patterns) {
    const next: AtomPatternBindings[] = [];
    for (const environment of environments) {
      for (
        const extended of matchAtomPatternAgainstAtoms(
          pattern,
          atoms,
          environment,
        )
      ) {
        pushUniqueBindings(next, extended);
      }
    }
    if (next.length === 0) return [];
    environments = next;
  }
  return environments;
};

const instantiateValue = (
  pattern: AtomPattern,
  bindings: AtomPatternBindings,
): { value: FabricValue } | null => {
  if (isAtomVarPlaceholder(pattern)) {
    if (!Object.hasOwn(bindings, pattern.var)) return null;
    const bound = bindings[pattern.var];
    // `undefined` is not a value an atom can carry; a binding holding it
    // cannot instantiate anything (fail closed rather than minting a hole).
    return bound === undefined ? null : { value: bound };
  }
  if (isMalformedVarBearingRecord(pattern)) {
    return null;
  }
  if (Array.isArray(pattern)) {
    const items: FabricValue[] = [];
    for (const element of pattern) {
      const instantiated = instantiateValue(element, bindings);
      if (instantiated === null) return null;
      items.push(instantiated.value);
    }
    return { value: items };
  }
  if (isFabricPlainObject(pattern)) {
    const record: Record<string, FabricValue> = {};
    for (const [key, fieldPattern] of Object.entries(pattern)) {
      if (fieldPattern === undefined) continue;
      const instantiated = instantiateValue(fieldPattern, bindings);
      if (instantiated === null) return null;
      record[key] = instantiated.value;
    }
    return { value: record };
  }
  return { value: pattern };
};

/**
 * Instantiates a pattern under a binding environment (spec §4.4.5
 * `substituteVars`/`instantiate`): placeholders are replaced by their bound
 * values; explicit-`undefined` fields (the absence-requirement form) are
 * omitted from the result. Returns `null` — fail closed, the caller must not
 * fire — when any placeholder is unbound (the spec's "AtomVariable not
 * allowed in postCondition" rejection generalized to unbound variables) or
 * malformed. The wrapper return shape keeps failure distinguishable from a
 * legitimately-`null` instantiated value.
 */
export const instantiateAtomPattern = (
  pattern: AtomPattern,
  bindings: AtomPatternBindings,
): { value: FabricValue } | null => instantiateValue(pattern, bindings);

/**
 * A concept-valued integrity guard (spec §4.4.5): a CONCRETE `Concept` atom
 * pattern. Satisfied exclusively via the acting principal's trust closure —
 * never by pool-matching a literal Concept atom (which carried integrity
 * cannot legitimately contain; the mint gate strips it). Returns `undefined`
 * for non-concept-shaped patterns (they route to ordinary pool matching) and
 * `{ uri: undefined }` — a concept guard that is NEVER satisfied — for any
 * `Concept`-typed pattern that is not the EXACT concrete two-field shape
 * `{ type, uri: <non-empty string> }`.
 *
 * The exact-shape requirement is load-bearing (codex/cubic P2 on #4564):
 * concept guards are checked ONLY on `type` + trust closure, so extra
 * constraint fields (`{ type: Concept, uri, subject: … }`) or a smuggled
 * `var` key would be silently ignored — an over-constrained guard the author
 * wrote as narrow would fire as broadly as the bare concept. Anything but the
 * canonical shape fails closed.
 *
 * Shared by the exchange-rule evaluator (B4 rule guards) and the integrity
 * floors (D5, observation.ts): one recognizer, so a Concept-typed entry means
 * the same thing in a rule precondition and a `requiredIntegrity` floor.
 */
export const conceptGuard = (
  pattern: unknown,
): { uri: string | undefined } | undefined => {
  // `isObjectOrArray` admits arrays (`typeof [] === "object"`), and an array can carry
  // own `type`/`uri` properties — exclude it explicitly so only the canonical
  // OBJECT shape `{ type, uri }` can route to trust-closure satisfaction. A
  // Concept-shaped array is not the canonical shape and fails closed to
  // ordinary matching, in keeping with the discipline below.
  if (
    !isObjectNotArray(pattern) ||
    isAtomVarPlaceholder(pattern) ||
    (pattern as { type?: unknown }).type !== CFC_ATOM_TYPE.Concept
  ) {
    return undefined;
  }
  const uri = (pattern as { uri?: unknown }).uri;
  // Exactly `{ type, uri }`, uri a non-empty string. Extra fields (or a `var`
  // key, which would push the key count past 2) → never satisfied.
  if (
    Object.keys(pattern).length !== 2 ||
    typeof uri !== "string" || uri.length === 0
  ) {
    return { uri: undefined };
  }
  return { uri };
};

type ExpiresAtom = { type: string; timestamp: number };

// Only the CANONICAL two-field `Expires` shape participates in timestamp
// ordering. A record carrying extra fields (`{type, timestamp, scope: "x"}`)
// is non-canonical: applying the `<=` order to it would let a ceiling
// `Expires(1000)` admit that atom even though equality correctly rejects
// it — silently bypassing the fail-closed intent. Non-canonical Expires
// records therefore fall through to structural equality only (below).
const isOrderedExpiresAtom = (value: unknown): value is ExpiresAtom =>
  isObjectNotArray(value) &&
  Object.keys(value).length === 2 &&
  (value as { type?: unknown }).type === CFC_ATOM_TYPE.Expires &&
  typeof (value as { timestamp?: unknown }).timestamp === "number" &&
  Number.isFinite((value as { timestamp: number }).timestamp);

/**
 * Per-family atom entailment (plan B1; spec §4.1.3/§4.2.3): `a` entails `b`
 * when every access context satisfying `a` also satisfies `b` — `a` is at
 * least as demanding. The default is structural equality; the one ordered
 * family is `Expires`, where satisfying `Expires(t)` means `now <= t`, so
 * `Expires(t_a)` entails `Expires(t_b)` iff `t_a <= t_b` (an earlier
 * deadline is the stronger constraint). Every other non-equal pair fails
 * CLOSED — no structural-similarity heuristics, no cross-family order. A
 * malformed `Expires` (missing/non-finite timestamp) has no order and only
 * entails its structural equal.
 *
 * Commitment forms (inv-12 Stage 1, spec §4.6.4.1 same-form matching): an
 * atom whose classified fields were persisted as `{digestOf}` markers
 * denotes the same principal as its plaintext form, so equality extends
 * across the marker — the plaintext side is digested and compared. This is
 * what lets read gating satisfy a committed `User.subject` clause by
 * digesting the acting reader. Guarded by a containment pre-check so the
 * dominant all-plaintext mismatch path stays a single `valueEqual()`.
 */
export const atomEntails = (a: FabricValue, b: FabricValue): boolean => {
  if (valueEqual(a, b)) return true;
  if (isOrderedExpiresAtom(a) && isOrderedExpiresAtom(b)) {
    return a.timestamp <= b.timestamp;
  }
  if (
    (containsCfcFieldCommitment(a) || containsCfcFieldCommitment(b)) &&
    commitmentAwareEquals(a, b)
  ) {
    return true;
  }
  return false;
};
