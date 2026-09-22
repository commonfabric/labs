import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { encodePointer, parsePointer } from "../../../memory/v2/path.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import type { CfcConfClause } from "./clause.ts";
import { clauseAlternatives } from "./clause.ts";
import {
  cfcEntryHasDerivedContainment,
  isLabelMetadataTemplateEntry,
  labelMetadataFieldIsProtected,
  resolveLabelMetadataTemplateConfidentiality,
} from "./label-metadata-population.ts";
import {
  commitmentAwareEquals,
  isCfcFieldCommitment,
} from "./label-representation.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { uniqueCfcAtoms } from "./observation.ts";
import type { CfcMetadata, LabelMapEntry } from "./types.ts";

// Inv-12 Stage 2 (SC-25/SC-6; docs/specs/cfc-label-metadata-confidentiality.md
// §3/§5; spec §4.6.4.1-.2): the bounded first-layer label-introspection
// evaluator behind the `inspectConfLabel` builtin, plus the §4.6.4.2
// population rule that labels each metadata observation it consumes.
//
// Scope discipline:
// - FIRST LAYER ONLY. A query addresses the confidentiality label stored at
//   one payload path (`/body` ↔ the `/value/body` envelope entry); the
//   labels-of-labels subtree (`/cfc/labels/...`) is runtime-enforced metadata
//   and is not introspectable (`parseConfLabelTargetPath` refuses `/cfc`).
// - EQUALITY PREDICATES ONLY, over the six §4.6.4.1 fields. An absent field
//   is no match (consulting absence is an atom-shape observation — public
//   under the default profile).
// - OUTCOME NORMALIZATION. Unobservable targets, missing metadata and
//   matching-but-unreadable atoms all collapse to one byte-identical
//   `{status:"notAvailable"}`; `ok` with empty atoms is returned only when
//   every per-atom field observation consulted to establish the miss was
//   observable (its population label exists), so the caller cannot
//   distinguish the hidden arms.
// - LABEL SOURCE (template-population Stage B). Protected field/projection
//   observation labels RESOLVE from the persisted `/cfc/labels/...`
//   population templates when the envelope carries them (the §4.6.4.2
//   field-precise profile, minted at the persist seam —
//   `label-metadata-population.ts`), falling back to the computed-in-hand
//   interim rule when absent (pre-Stage-B envelopes). On envelopes the
//   current runtime persisted the two agree exactly: the interim rule is the
//   label SOURCE, the templates its CARRIER.
// - CONSUMPTION. Every `ok` outcome reports the joined population-rule
//   confidentiality of the field observations it consumed
//   (`consumedConfidentiality`) plus the per-consulted-path records
//   (`consumedObservations`, at the CONCRETE clause/alternative metadata
//   paths); the transaction channel (`recordCfcLabelMetadataObservation`) is
//   wired by `inspectStoredConfLabel`, not the evaluator — the evaluator
//   stays pure over stored metadata.

/**
 * The §4.6.4.1 query: equality tests only, family-qualified where the spec
 * names a family (see QUERY_PREDICATES). All six fields are supported even
 * where the runner has no mint site today (`policyName` matches the B2b
 * label-carried Policy/Context ref atoms; `originUri` matches Origin atoms,
 * which nothing mints yet) — an absent field or a family miss on the
 * candidate atom is simply no match.
 */
export type ConfLabelQuery = {
  atomType?: string;
  caveatKind?: string;
  source?: FabricValue;
  resourceClass?: string;
  policyName?: string;
  originUri?: string;
};

/**
 * One projected atom, addressed by its position in the STORED label at the
 * target path. The runner stores one `LabelMapEntry` per component at a path
 * and the effective label is their clause concatenation (`mergeLabel` joins
 * by clause concatenation), so `clauseIndex` runs across the concatenated
 * per-entry confidentiality clause lists in stored entry order.
 * `alternativeIndex` addresses the alternative inside an `{anyOf: [...]}`
 * clause (0 for a bare singleton atom). `atomIndex` is the atom's position
 * within the alternative — in this runtime an alternative IS one atom, so it
 * is always 0; the field exists so the projection shape matches the
 * §4.6.4.1 profile, whose addressing allows representations with grouped
 * alternatives.
 */
export type LabelAtomProjection = {
  targetPath: string;
  clauseIndex: number;
  alternativeIndex: number;
  atomIndex: number;
  atom: unknown;
};

export type InspectConfLabelResult =
  | { status: "ok"; atoms: LabelAtomProjection[] }
  | { status: "notAvailable" };

/**
 * The one spelling of the hidden outcome. Shared by every arm — unobservable
 * target, missing metadata, unevaluable query, unreadable match, and the
 * flow-off degradation — so the arms are indistinguishable by construction.
 */
export const CONF_LABEL_NOT_AVAILABLE: InspectConfLabelResult = Object.freeze({
  status: "notAvailable" as const,
});

/**
 * One labeled metadata observation the evaluation consumed, at its CONCRETE
 * metadata path (`["cfc","labels","value",...,"clauses","1","alternatives",
 * "0","source"]` — clause/alternative indices per the stored addressing, the
 * §4.6.4.2 example's shape). Per-field query consultations record at the
 * field segment; whole-atom projections record at the alternative node.
 * These are what `inspectStoredConfLabel` records on the transaction — reads
 * of the metadata subtree that resolved the `*`-path population templates
 * through the wildcard machinery like any read.
 */
export type ConfLabelConsumedObservation = {
  path: readonly string[];
  confidentiality: readonly CfcConfClause[];
};

export type ConfLabelQueryEvaluation = {
  result: InspectConfLabelResult;

  /**
   * Joined population-rule confidentiality of every labeled metadata
   * observation the evaluation consumed (per-field consultations and
   * whole-atom projections). Deduped. Always empty for `notAvailable`: the
   * hidden arms are value-independent of protected fields (the response is
   * the shared constant), so nothing protected flowed to the caller.
   */
  consumedConfidentiality: readonly CfcConfClause[];

  /**
   * The same consumption, one record per consulted concrete metadata path
   * (paths are unique by construction — clause/alternative indices plus
   * distinct predicate fields), each record's label deduped. Empty exactly
   * when `consumedConfidentiality` is.
   */
  consumedObservations: readonly ConfLabelConsumedObservation[];
};

/**
 * Parse the application-facing payload pointer of §4.6.4.1 into the canonical
 * entry path. `/body` addresses the payload label stored at the `/value/body`
 * envelope entry, whose labelMap path is the canonical (value-stripped)
 * `["body"]`; an explicit `/value` prefix is accepted as the envelope
 * spelling of the same path (mirroring `canonicalizeLogicalPath`).
 *
 * Returns `undefined` — the caller collapses to `notAvailable` — for the
 * envelope metadata subtree (`/cfc/...`): labels attached to label metadata
 * are runtime-enforced metadata, not introspectable payload (the §4.6.4.1
 * first-layer rule). A payload field literally named `cfc` at the root is
 * consequently not addressable through this API; the collision with the
 * metadata sibling fails closed.
 */
export const parseConfLabelTargetPath = (
  pointer: string,
): readonly string[] | undefined => {
  let segments: string[];
  try {
    segments = parsePointer(pointer);
  } catch {
    return undefined;
  }
  const canonical = canonicalizeLogicalPath(segments);
  if (canonical[0] === "cfc") {
    return undefined;
  }
  return canonical;
};

// The §4.6.4.2 population rule: persisted templates as the carrier, the
// interim rule computed from the entry in hand as source and fallback.

/**
 * Observation label of one atom field, or `undefined` when the field is
 * UNOBSERVABLE (population fails closed). An empty confidentiality array is a
 * PUBLIC observation.
 */
type FieldObservation = readonly unknown[] | undefined;

/**
 * The protected-chain arm of the population rule for one consultation at one
 * CONCRETE metadata path:
 *
 * 1. Containment gate first (spec §4.6.4.2, merged via specs#14): only
 *    derived-containment entries (`derived`/`structure` — the §8.9.2
 *    conservative join) have observable source-bearing fields at all.
 *    Declared/authored, link, external-ingest and legacy entries stay
 *    fail-closed UNOBSERVABLE — and a persisted template at the same path
 *    never re-opens them: the per-path metadata addressing conflates the
 *    entries stored at one payload path, so a template minted for a derived
 *    sibling must not leak an observation label onto a declared entry's
 *    fields.
 * 2. The persisted `/cfc/labels/...` population template covering the
 *    concrete path, when the envelope carries one (template-population
 *    Stage B) — resolved with §4.6.3 replace-down through the wildcard
 *    machinery like any read. This is the carrier arm the future per-source
 *    precision upgrade changes labels in.
 * 3. Else the computed-in-hand interim rule: the entry's own effective
 *    confidentiality (sound per the §8.9.2 containment argument) —
 *    pre-Stage-B envelopes carry no templates and land here.
 */
const protectedFieldObservationLabel = (
  entry: LabelMapEntry,
  entries: readonly LabelMapEntry[],
  concretePath: readonly string[],
): FieldObservation => {
  if (!cfcEntryHasDerivedContainment(entry)) {
    return undefined;
  }
  const template = resolveLabelMetadataTemplateConfidentiality(
    entries,
    concretePath,
  );
  if (template !== undefined) {
    return template;
  }
  return entry.label.confidentiality ?? [];
};

/**
 * The population rule for one field of one atom in one entry:
 *
 * 1. `type`/`kind` at an atom root — and atom presence itself — are public
 *    (the normative §4.6.4.2 default).
 * 2. A field the Stage-0 classification table marks `public` (disclosure is
 *    the feature: authored attribution subjects, Policy/Context ref
 *    name/hash, `TransformedBy.identity.moduleIdentity`) is public.
 *    (Arms 1-2 are `labelMetadataFieldIsProtected`, shared with the persist
 *    seam's mint so the two cannot drift.)
 * 3. Every other present field is source-protected:
 *    {@link protectedFieldObservationLabel} — persisted template when
 *    present, derived-containment fallback, else UNOBSERVABLE (fail closed).
 *
 * A committed `{digestOf}` field keeps the same population label as its
 * plaintext form: the commitment hides the identity from casual observation
 * but stays probe-able, so observing it is still a protected observation.
 */
const fieldObservationLabel = (
  entry: LabelMapEntry,
  atom: unknown,
  field: string,
  entries: readonly LabelMapEntry[],
  concretePath: readonly string[],
): FieldObservation =>
  labelMetadataFieldIsProtected(atom, field)
    ? protectedFieldObservationLabel(entry, entries, concretePath)
    : [];

/**
 * Observation label of a WHOLE-ATOM projection: the join of the labels of
 * every field the projection reveals (§4.6.4.2 — "returning a whole
 * source-bearing atom remains source-protected even when `type` and `kind`
 * are public"). Walks nested records field-by-field with the classification
 * table's family-scoped addressing (a nested atom resets the field context,
 * mirroring the Stage 1 transform's walk), so a public wrapper cannot smuggle
 * a protected nested field out. Bare non-record atoms (string atoms) are
 * type-only tags — their entire content is the public type observation.
 *
 * Protected consultations resolve per-field templates at their concrete
 * paths (direct alternative fields land where the mint addresses them;
 * nested/array-indexed positions miss and use the fallback — the mint
 * deliberately materializes no nested per-field templates). When the walk
 * consumed anything protected, the persisted whole-atom template covering
 * the alternative node joins in: it IS the minted join of the revealed-field
 * labels, so on runtime-minted envelopes this is a dedup no-op, and a
 * foreign wider template fails toward taint.
 *
 * Returns `undefined` when any revealed field is unobservable: the projection
 * — and with it the whole query (a matching-but-unreadable atom) — fails
 * closed.
 */
const atomProjectionLabel = (
  entry: LabelMapEntry,
  atom: unknown,
  entries: readonly LabelMapEntry[],
  alternativePath: readonly string[],
): FieldObservation => {
  const consumed: unknown[] = [];
  const walk = (
    value: unknown,
    contextAtom: unknown,
    valuePath: readonly string[],
  ): boolean => {
    if (Array.isArray(value)) {
      return value.every((element, index) =>
        walk(element, contextAtom, [...valuePath, String(index)])
      );
    }
    if (!isObjectOrArray(value)) {
      return true;
    }
    if (isCfcFieldCommitment(value)) {
      // A bare commitment marker outside a classified field position (it
      // would have been consumed AS the field value below): protected.
      const label = protectedFieldObservationLabel(entry, entries, valuePath);
      if (label === undefined) return false;
      consumed.push(...label);
      return true;
    }
    // A record carrying a string `type` or `kind` is an atom for
    // classification purposes; plain nested records keep the enclosing
    // atom's context. Field-path depth beyond one segment (the
    // `TransformedBy.identity.*` rows) is handled by the recursion: the
    // nested record's fields are classified against the CONTEXT atom with
    // the single-segment path, and where that misses the table the field is
    // conservatively protected — strictly more protective than the Stage 1
    // transform's multi-segment resolution, never less.
    const isAtom = typeof (value as { type?: unknown }).type === "string" ||
      typeof (value as { kind?: unknown }).kind === "string";
    const context = isAtom ? value : contextAtom;
    for (const [key, field] of Object.entries(value)) {
      const fieldPath = [...valuePath, key];
      const observation = fieldObservationLabel(
        entry,
        context,
        key,
        entries,
        fieldPath,
      );
      if (observation === undefined) {
        return false;
      }
      if (observation.length > 0) {
        consumed.push(...observation);
        continue;
      }
      // Public field: recurse so a nested atom inside it (a `Caveat.by`
      // User atom) is still classified on its own terms — a public wrapper
      // field must not smuggle a protected nested field out. Scalar public
      // fields end the walk trivially.
      const nestedObservable = walk(field, context, fieldPath);
      if (!nestedObservable) {
        return false;
      }
    }
    return true;
  };
  if (!walk(atom, undefined, alternativePath)) {
    return undefined;
  }
  if (consumed.length > 0) {
    const template = resolveLabelMetadataTemplateConfidentiality(
      entries,
      alternativePath,
    );
    if (template !== undefined) {
      consumed.push(...template);
    }
  }
  return consumed;
};

//
// Query evaluation.
//

/**
 * The atom field each §4.6.4.1 query predicate tests, plus the atom FAMILY
 * the predicate is qualified to (codex/cubic P2 on the Stage 2 PR): the spec
 * names "resource/policy/origin fields", so `resourceClass` reads
 * `Resource.class`, `policyName` reads the B2b `Policy`/`Context` ref
 * `name`, and `originUri` reads `Origin.uri` — an unrelated atom that merely
 * HAS a `name`/`class`/`uri` field (a `Builtin` atom's `name`, say) is not a
 * match. `caveatKind` reads the `kind` discriminator of the kind-carrying
 * families: `Caveat` atoms and the type-less kind-shaped claim atoms
 * (authored-by / represents-principal), whose `kind` IS their family; a
 * crafted `kind` riding an unrelated typed family is not a caveat kind.
 * `atomType` and `source` are family-generic by design. A family miss is
 * treated exactly like an absent field: no match, and only the public atom
 * `type` observation was consulted to decide it.
 */
const QUERY_PREDICATES: Record<
  keyof ConfLabelQuery,
  {
    readonly field: string;

    /** Absent = family-generic. Input is the record atom's `type` field. */
    readonly familyTypes?: readonly (string | undefined)[];
  }
> = {
  atomType: { field: "type" },
  caveatKind: { field: "kind", familyTypes: [CFC_ATOM_TYPE.Caveat, undefined] },
  source: { field: "source" },
  resourceClass: { field: "class", familyTypes: [CFC_ATOM_TYPE.Resource] },
  policyName: {
    field: "name",
    familyTypes: [CFC_ATOM_TYPE.Policy, CFC_ATOM_TYPE.Context],
  },
  originUri: { field: "uri", familyTypes: [CFC_ATOM_TYPE.Origin] },
};

const entryPathMatchesTarget = (
  entry: LabelMapEntry,
  targetPath: readonly string[],
): boolean => {
  const entryPath = canonicalizeLogicalPath(entry.path);
  return entryPath.length === targetPath.length &&
    entryPath.every((segment, index) =>
      segment === targetPath[index] || segment === "*" ||
      targetPath[index] === "*"
    );
};

/**
 * Evaluate one §4.6.4.1 query against stored metadata. Pure: consumption is
 * REPORTED (see {@link ConfLabelQueryEvaluation}), not recorded — the caller
 * owns the transaction channel and the flow-dial degradation.
 *
 * `targetPath` is the canonical payload path (from
 * {@link parseConfLabelTargetPath}); only entries stored at exactly that path
 * participate (first-layer addressing — effective-label resolution across
 * ancestors is the display path's job, not introspection's).
 */
export const evaluateConfLabelQuery = (
  metadata: CfcMetadata | undefined,
  targetPath: readonly string[],
  query: ConfLabelQuery,
): ConfLabelQueryEvaluation => {
  if (metadata === undefined) {
    return {
      result: CONF_LABEL_NOT_AVAILABLE,
      consumedConfidentiality: [],
      consumedObservations: [],
    };
  }
  const predicates = (Object.keys(QUERY_PREDICATES) as (keyof ConfLabelQuery)[])
    .filter((key) => query[key] !== undefined)
    .map((key) => ({ ...QUERY_PREDICATES[key], expected: query[key] }));
  const pointer = encodePointer(targetPath);
  const entries = metadata.labelMap.entries;
  // The concrete metadata subtree of this target (§4.6.4.1 addressing):
  // consultation paths extend it with the stored clause/alternative indices,
  // and template resolution reads at those concrete paths.
  const metaBase = ["cfc", "labels", "value", ...targetPath];
  const consumed: unknown[] = [];
  // One record per labeled consultation. Paths are UNIQUE by construction —
  // per-field consultations key on (clauseIndex, alternativeIndex, predicate
  // field) with the six predicate fields distinct, whole-atom projections
  // key on (clauseIndex, alternativeIndex), and a field path can never equal
  // an alternative path (field paths extend an alternative path by one
  // segment) — so no per-path merge step exists to reach.
  const consumedObservations: ConfLabelConsumedObservation[] = [];
  const consumeAt = (
    path: readonly string[],
    atoms: readonly unknown[],
  ): void => {
    if (atoms.length === 0) {
      return;
    }
    consumed.push(...atoms);
    consumedObservations.push({
      path,
      confidentiality: uniqueCfcAtoms([...atoms]),
    });
  };
  const atoms: LabelAtomProjection[] = [];
  let clauseIndex = 0;
  for (const entry of entries) {
    // Label-metadata population templates are the OBSERVATION-LABEL carrier
    // for the payload label, not payload clauses: they never enumerate as
    // atoms (a `*`-bearing target path could otherwise wildcard-match their
    // `cfc`-prefixed entry paths).
    if (isLabelMetadataTemplateEntry(entry)) {
      continue;
    }
    if (!entryPathMatchesTarget(entry, targetPath)) {
      continue;
    }
    for (const clause of entry.label.confidentiality ?? []) {
      const alternatives = clauseAlternatives(clause as CfcConfClause);
      for (
        let alternativeIndex = 0;
        alternativeIndex < alternatives.length;
        alternativeIndex++
      ) {
        const atom = alternatives[alternativeIndex];
        const alternativePath = [
          ...metaBase,
          "confidentiality",
          "clauses",
          String(clauseIndex),
          "alternatives",
          String(alternativeIndex),
        ];
        let matched = true;
        for (const { field, familyTypes, expected } of predicates) {
          if (!isObjectOrArray(atom)) {
            // A bare string atom is a type-only atom: its entire content is
            // its (public) type tag, so `atomType` equality applies to the
            // atom itself; every other field is absent (no match, shape-only
            // consultation).
            matched = field === "type"
              ? commitmentAwareEquals(atom, expected)
              : false;
            if (!matched) break;
            continue;
          }
          if (
            familyTypes !== undefined &&
            !familyTypes.includes(
              typeof (atom as { type?: unknown }).type === "string"
                ? (atom as { type: string }).type
                : undefined,
            )
          ) {
            // Family-qualified predicate against a different family: no
            // match. Decided from the public `type` observation alone.
            matched = false;
            break;
          }
          if (!Object.hasOwn(atom, field)) {
            // Absent field = no match. Establishing absence is an atom-shape
            // observation — public under the default profile — so nothing
            // protected is consumed.
            matched = false;
            break;
          }
          const fieldPath = [...alternativePath, field];
          const observation = fieldObservationLabel(
            entry,
            atom,
            field,
            entries,
            fieldPath,
          );
          if (observation === undefined) {
            // The query needs a field observation the population rule cannot
            // label: the WHOLE evaluation is unevaluable for this caller.
            // Bailing per-atom instead (skipping just this atom) would make
            // `ok` vs `notAvailable` depend on the unobservable field's
            // value — exactly the distinction normalization forbids.
            return {
              result: CONF_LABEL_NOT_AVAILABLE,
              consumedConfidentiality: [],
              consumedObservations: [],
            };
          }
          // Testing equality observes the field whether it matches or not:
          // establishing a miss is a membership observation and consumes the
          // same per-field label (§4.6.4.2). Commitment-aware so a committed
          // `{digestOf}` field digest-matches its plaintext query form
          // (Stage 1 same-form matching).
          consumeAt(fieldPath, observation);
          if (
            !commitmentAwareEquals(
              isFabricPlainObject(atom) ? atom[field] : undefined,
              expected,
            )
          ) {
            matched = false;
            break;
          }
        }
        if (!matched) {
          continue;
        }
        const projection = atomProjectionLabel(
          entry,
          atom,
          entries,
          alternativePath,
        );
        if (projection === undefined) {
          // Matching but unreadable: the projection would reveal a field the
          // population rule cannot label. Returning the other matches would
          // disclose (via ok-vs-notAvailable) facts about this atom; omitting
          // it would misreport a match as a miss. Collapse.
          return {
            result: CONF_LABEL_NOT_AVAILABLE,
            consumedConfidentiality: [],
            consumedObservations: [],
          };
        }
        // The whole-atom projection is a read AT the alternative node.
        consumeAt(alternativePath, projection);
        atoms.push({
          targetPath: pointer,
          clauseIndex,
          alternativeIndex,
          // An alternative is one atom in this runtime's representation; the
          // index exists for §4.6.4.1 shape fidelity (see
          // LabelAtomProjection).
          atomIndex: 0,
          // The STORED form, verbatim: committed fields stay committed
          // (never un-committed back to plaintext the caller supplied).
          atom,
        });
      }
      clauseIndex++;
    }
  }
  return {
    result: { status: "ok", atoms },
    consumedConfidentiality: uniqueCfcAtoms(consumed),
    consumedObservations,
  };
};

/**
 * The full introspection step for one target, consuming on the transaction —
 * everything above the input plumbing the `inspectConfLabel` builtin owns:
 *
 * 1. Parse the payload pointer (a `/cfc/...` pointer — labels-of-labels — is
 *    refused: notAvailable).
 * 2. Read the resolved target's stored envelope through the SAME
 *    runtime-internal verifier seam prepare uses (`readStoredCfcMetadata`,
 *    INTERNAL_VERIFIER_META): the raw `["cfc"]` journal read stays excluded
 *    from flow/consumed derivations exactly as before (SC-6) — while still
 *    journaled, so reactivity re-runs the builtin when the envelope changes.
 *    A read ERROR is an unobservable target: notAvailable. Consumption
 *    happens through the explicit observation record below, never the raw
 *    read.
 * 3. Evaluate the §4.6.4.1 query (`evaluateConfLabelQuery`).
 * 4. The fail-closed dial rule (design §3 item 2; decision documented on the
 *    Stage 2 PR): a result whose evaluation consumed PROTECTED metadata
 *    observations is returned only when the transaction can carry the joined
 *    label onto the result — `cfcFlowLabels: "persist"` under a non-disabled
 *    enforcement mode, the one configuration where the derived component
 *    actually lands on the written result doc. Anywhere else the result
 *    would commit as an UNLABELED copy of protected label metadata, so it
 *    degrades to the same notAvailable as every hidden arm (indistinguishable
 *    by construction). Purely public results (empty consumed join) flow under
 *    every dial.
 * 5. Record the consumed observations (`recordCfcLabelMetadataObservation`),
 *    one per consulted CONCRETE metadata path (field consultations at the
 *    field segment, whole-atom projections at the alternative node — the
 *    evaluator's `consumedObservations`): they join the flow derivation
 *    (labeling the result through the normal per-tx J), the egress consumed
 *    set, the per-write input gate, and the prepared digest.
 */
export const inspectStoredConfLabel = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  targetPath: string,
  query: ConfLabelQuery,
): InspectConfLabelResult => {
  const parsed = parseConfLabelTargetPath(targetPath);
  if (parsed === undefined) {
    return CONF_LABEL_NOT_AVAILABLE;
  }
  let metadata: CfcMetadata | undefined;
  try {
    metadata = readStoredCfcMetadata(tx, {
      space: target.space,
      id: target.id,
      scope: target.scope,
    });
  } catch {
    // Unobservable target — same constant as missing metadata below.
    return CONF_LABEL_NOT_AVAILABLE;
  }
  const payloadPath = [
    ...canonicalizeLogicalPath(target.path),
    ...parsed,
  ];
  if (payloadPath[0] === "cfc") {
    // The RESOLVED target path lands in the envelope metadata subtree: the
    // §4.6.4.1 first-layer rule refuses labels-of-labels however addressed —
    // `parseConfLabelTargetPath` catches the query pointer; this catches a
    // target cell whose own path collides with the metadata sibling.
    return CONF_LABEL_NOT_AVAILABLE;
  }
  const { result, consumedConfidentiality, consumedObservations } =
    evaluateConfLabelQuery(
      metadata,
      payloadPath,
      query,
    );
  if (result.status !== "ok" || consumedConfidentiality.length === 0) {
    return result;
  }
  const state = tx.getCfcState();
  const carries = state.flowLabelsMode === "persist" &&
    state.enforcementMode !== "disabled";
  if (!carries) {
    tx.noteCfcDiagnostic(
      "label-introspection: protected metadata result withheld " +
        `(flowLabelsMode=${state.flowLabelsMode}, ` +
        `enforcementMode=${state.enforcementMode})`,
    );
    return CONF_LABEL_NOT_AVAILABLE;
  }
  const scope = normalizeCellScope(target.scope);
  for (const observation of consumedObservations) {
    tx.recordCfcLabelMetadataObservation({
      target: {
        space: target.space,
        id: target.id,
        scope,
        // The CONCRETE first-layer metadata path the consultation resolved
        // (§4.6.4.1 addressing, the §4.6.4.2 example's shape):
        // /cfc/labels/value/<payload path>/confidentiality/clauses/<i>/...
        path: [...observation.path],
      },
      observes: "labelMetadata",
      confidentiality: [...observation.confidentiality],
    });
  }
  return result;
};
