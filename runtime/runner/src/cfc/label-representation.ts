import type { CfcAtom, CfcJsonValue } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import {
  CLASSIFIED_KIND_FAMILIES,
  classifyAtomField,
} from "@commonfabric/memory/v2/cfc-label-fields";
import {
  type CfcConfClause,
  type CfcFieldCommitment,
  isCfcFieldCommitment,
} from "@commonfabric/memory/v2/cfc-release-authority";

import type { IFCLabel } from "./label-view-core.ts";

/** The commitment form of one atom field value: its canonical digest, marked. */
export const commitCfcFieldValue = (
  value: CfcJsonValue,
): CfcFieldCommitment => ({
  digestOf: hashStringOf(value),
});

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
  destination: string | undefined,
): CfcJsonValue => {
  if (isCfcFieldCommitment(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((element) => {
      const next = transformValue(
        element,
        contextAtom,
        pathInAtom,
        destination,
      );
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
    if (
      cls === "commitment" && !isCfcFieldCommitment(field) &&
      (destination === undefined || field !== destination)
    ) {
      next = commitCfcFieldValue(field);
    } else if (cls === "commitment" || cls === "public") {
      // Already committed, the destination's own identity (see
      // `transformCfcLabelForCrossSpacePersist`), or public — verbatim.
      // Public fields are scalar
      // disclosure-intended values (DIDs, module identities); nothing nests
      // under them today, and classifying a field public means exactly
      // "persist as-is".
      next = field;
    } else {
      next = transformValue(field, atom, fieldPath, destination);
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
  transformValue(atom, undefined, [], undefined);

/**
 * The Stage 1 persist transform: every commitment-classified source-bearing
 * atom field in `label` (confidentiality clauses — including `anyOf`
 * alternatives and atoms nested inside other atoms — and integrity atoms)
 * replaced by its `{digestOf}` marker. Deterministic, idempotent
 * (`transform(transform(x))` returns `transform(x)` by reference), and
 * copy-on-write: a label with nothing to commit comes back as the SAME
 * object, so callers detect divergence (the observe-mode rollout metric)
 * with a reference check.
 *
 * `destination`, when given, is the DID of the space the label is persisted
 * into, and a commitment-classified field whose value is exactly that DID
 * persists verbatim. A commitment hides an identity from the destination's
 * observers (spec §4.6.4.1), and the destination's own DID is not hidden from
 * them: it addresses every document of every replica they hold, and any of
 * them can digest it to test a commitment. Committing it therefore protects
 * nothing, and it breaks the one consumer that must dereference the field:
 * a module policy whose subject is the space it was written to
 * (`PolicyOf<Rules>` reclassified for that space), whose
 * `HasRole(reader, THIS_POLICY.subject)` guard is a membership point query
 * the display can make only on a plaintext subject
 * (`membershipSpacesInConfidentiality` in `render-ceiling.ts`). Only that
 * exact value is kept: a field naming any other space, or a principal, is
 * committed as before, so a later hop into a third space commits this one
 * too. Callers pass it only behind the `patternReclassification` dial, until
 * the ruling the experiment's PROPOSAL.md names decides it.
 */
// SPEC-PENDING specs PR not yet filed; see patterns/dev/test/share-space-declassify/PROPOSAL.md
export const transformCfcLabelForCrossSpacePersist = (
  label: IFCLabel,
  destination?: string,
): IFCLabel => {
  const confidentiality = label.confidentiality === undefined
    ? undefined
    : (transformValue(
      label.confidentiality,
      undefined,
      [],
      destination,
    ) as CfcConfClause[]);
  const integrity = label.integrity === undefined ? undefined : (transformValue(
    label.integrity,
    undefined,
    [],
    destination,
  ) as CfcAtom[]);
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
