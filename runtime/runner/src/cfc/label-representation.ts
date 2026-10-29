import type { CfcAtom, CfcJsonValue } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  hashStringOf,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import type { CfcConfClause } from "./clause.ts";
import {
  CLASSIFIED_KIND_FAMILIES,
  classifyAtomField,
} from "./label-field-classification.ts";
import type { IFCLabel } from "./label-view-core.ts";

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

/** The commitment form of one atom field value: its canonical digest, marked. */
export const commitCfcFieldValue = (
  value: CfcJsonValue,
): CfcFieldCommitment => ({
  digestOf: hashStringOf(value),
});

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

/**
 * True when `value` contains a commitment marker anywhere — the cheap
 * pre-check consumers use before paying for commitment-aware comparison on
 * the (dominant) all-plaintext case.
 */
export const containsCfcFieldCommitment = (value: unknown): boolean => {
  if (isCfcFieldCommitment(value)) return true;
  if (Array.isArray(value)) return value.some(containsCfcFieldCommitment);
  if (isObjectOrArray(value)) {
    return Object.values(value).some(containsCfcFieldCommitment);
  }
  return false;
};

/**
 * Transforms one value subtree per the classification table.
 *
 * The walk is family-scoped (see `LabelFieldClassificationEntry.field`): a
 * record carrying a string `type` or `kind` is an ATOM and (re)sets the
 * classification context; nested plain records extend the field path within
 * the current atom (`TransformedBy.identity.sourceFile`); arrays pass
 * through without extending the path (table paths never address indices —
 * elements are either atoms, which reset context, or opaque values). A
 * field classified `commitment` is replaced by its digest marker; `public`
 * and unclassified fields recurse — recursion applies the table to atoms
 * nested INSIDE them (a `Caveat.by` User atom), which is strictly more
 * protective and still deterministic. An already-committed field passes
 * through unchanged (idempotence). Copy-on-write: unchanged subtrees return
 * by reference.
 */
const transformValue = (
  value: CfcJsonValue,
  contextAtom: unknown,
  pathInAtom: readonly string[],
): CfcJsonValue => {
  if (isCfcFieldCommitment(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((element) => {
      const next = transformValue(element, contextAtom, pathInAtom);
      if (next !== element) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!isObjectOrArray(value)) {
    return value;
  }
  // A record is an ATOM (classification-context reset) when it carries a
  // string `type` (the canonical URI families), or a string `kind` that names
  // a table-classified claim family. A bare `kind` outside that set is a
  // variant discriminator on a nested record (`ImplementationIdentity.kind`
  // inside `TransformedBy.identity`), which must EXTEND the current atom's
  // field path so multi-segment table rows keep resolving.
  const isAtom = typeof (value as { type?: unknown }).type === "string" ||
    (typeof (value as { kind?: unknown }).kind === "string" &&
      CLASSIFIED_KIND_FAMILIES.has((value as { kind: string }).kind));
  const atom = isAtom ? value : contextAtom;
  const basePath = isAtom ? [] : pathInAtom;
  let changed = false;
  const out: Record<string, CfcJsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    const fieldPath = [...basePath, key];
    const cls = atom === undefined
      ? undefined
      : classifyAtomField(atom, fieldPath);
    let next: CfcJsonValue;
    if (cls === "commitment" && !isCfcFieldCommitment(field)) {
      next = commitCfcFieldValue(field);
    } else if (cls === "commitment" || cls === "public") {
      // Already committed, or public — verbatim. Public fields are scalar
      // disclosure-intended values (DIDs, module identities); nothing nests
      // under them today, and classifying a field public means exactly
      // "persist as-is".
      next = field;
    } else {
      next = transformValue(field, atom, fieldPath);
    }
    if (next !== field) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
};

/**
 * The commitment-normal form of one atom (or any label value): every
 * commitment-classified field replaced by its digest marker; identity on
 * already-committed and unclassified values. Injective across distinct
 * atoms (digest collision resistance) and FORM-INSENSITIVE: a plaintext
 * atom and its committed persisted form normalize identically. This is the
 * canonical identity `cfcIntegrityWitnessKey` keys coherent-floor witnesses
 * by, so the same logical evidence consumed in plaintext form from one leaf
 * and committed form from another (the documented mixed migration period)
 * counts as ONE shared witness.
 */
export const cfcCommitmentNormalForm = (atom: CfcAtom): CfcAtom =>
  transformValue(atom, undefined, []);

/**
 * The Stage 1 persist transform: every commitment-classified source-bearing
 * atom field in `label` (confidentiality clauses — including `anyOf`
 * alternatives and atoms nested inside other atoms — and integrity atoms)
 * replaced by its `{digestOf}` marker. Deterministic, idempotent
 * (`transform(transform(x))` returns `transform(x)` by reference), and
 * copy-on-write: a label with nothing to commit comes back as the SAME
 * object, so callers detect divergence (the observe-mode rollout metric)
 * with a reference check.
 */
export const transformCfcLabelForCrossSpacePersist = (
  label: IFCLabel,
): IFCLabel => {
  const confidentiality = label.confidentiality === undefined
    ? undefined
    : (transformValue(label.confidentiality, undefined, []) as CfcConfClause[]);
  const integrity = label.integrity === undefined
    ? undefined
    : (transformValue(label.integrity, undefined, []) as CfcAtom[]);
  if (
    confidentiality === label.confidentiality && integrity === label.integrity
  ) {
    return label;
  }
  return {
    ...(confidentiality !== undefined ? { confidentiality } : {}),
    ...(integrity !== undefined ? { integrity } : {}),
  };
};
