import { isObjectOrArray } from "@commonfabric/utils/types";
import type { CfcConfClause } from "./clause.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import { clauseAlternatives } from "./clause.ts";
import { classifyAtomField } from "./label-field-classification.ts";
import { isCfcFieldCommitment } from "./label-representation.ts";
import { cfcLabelPathPrefixMatches } from "./label-view-core.ts";
import { uniqueCfcAtoms } from "./observation.ts";
import type { IFCLabel, LabelEntryOrigin, LabelMapEntry } from "./types.ts";

// Template-population Stage B (docs/specs/cfc-template-population.md §5/§6;
// spec §4.6.4.2): the §4.6.4.2 field-precise label-metadata population
// profile, carried as multi-`*` labelMap entries under the
// `/cfc/labels/<target-envelope-path>/...` metadata subtree.
//
// For every persisted payload label entry that carries source-bearing fields,
// the persist seam mints (via {@link deriveLabelMetadataTemplateEntries}):
//
//   ["cfc","labels","value",...target,"confidentiality","clauses","*",
//    "alternatives","*"]            → whole-atom projection label
//   [...same, <field>]              → per-field observation label, one entry
//                                     per DISTINCT protected top-level field
//                                     name present in the entry's atoms
//
// Entry count is O(#source-bearing-field-kinds) per labeled path — the
// clause/alternative axes ride the `*` wildcards, so counts are independent
// of how many clauses or alternatives the label has (the same one-level-up
// entry-count wall §5 dissolves). Presence/`type`/`kind` and table-`public`
// fields mint NOTHING: absence of a metadata entry is PUBLIC under the
// §4.6.4.2 default profile, and public entries are never materialized.
//
// The labels minted are the SAME §4.6.4.2 interim population rule the
// introspection surface computes in hand (source-identity confidentiality
// when known — no carrier feeds that arm yet; else, for derived-containment
// entries only, the entry's own effective confidentiality; else fail closed —
// mint nothing, `inspectConfLabel` keeps those fields unobservable). The
// interim rule stays the label SOURCE; these entries are the CARRIER —
// upgrading precision later (true per-source labels) changes the labels
// minted into the same entries, not the mechanism.
//
// `origin`/`observes` decision (documented for the design's §3.3 rule —
// plain `IFCLabel` under `label`, no new entry fields):
//
// - `origin: "label-metadata"` — a DEDICATED origin, because the origin axis
//   is the update-discipline axis and these entries have a discipline no
//   existing origin has: they are a pure function of the payload entries in
//   the SAME envelope, re-derived at every persist of that envelope (so
//   replace-on-overwrite / cleared-with-the-entry-they-describe / SC-11
//   zero-write all hold by construction). Reusing `derived` would put them
//   through every derived/structure-keyed rule in the persist loop (the
//   freeze-carry, the SC-4 existence pool, writer-fit policy selection,
//   `isRuntimeMintedTemplate` machinery boundaries), each needing a carve-out;
//   a dedicated origin makes every existing origin-keyed rule ignore them by
//   construction.
// - `observes: "labelMetadata"` — the #4657 observation class, now allowed on
//   persisted entries: `readConsumesEntry`'s class table already gives the
//   needed consumption for free (no payload read class — value/shape/
//   enumerate/followRef — consumes it; the introspection surface is the only
//   consumer, resolving explicitly via
//   {@link resolveLabelMetadataTemplateConfidentiality}).
// - Canonicalization/coalescing need nothing new: both key on
//   (path, origin, observes), so templates coalesce only with themselves —
//   two payload entries at one path (the C2 value/shape split) coalesce-JOIN
//   their per-entry population labels into the per-path template, the
//   fail-toward-taint direction the per-path §4.6.4.1 addressing (clause
//   indices run across the concatenated per-entry clause lists) requires.

/**
 * The dedicated origin of label-metadata population templates. See the module
 * doc for the decision rationale.
 */
export const LABEL_METADATA_TEMPLATE_ORIGIN: LabelEntryOrigin =
  "label-metadata";

/** Whether a persisted entry is a label-metadata population template. */
export const isLabelMetadataTemplateEntry = (
  entry: Pick<LabelMapEntry, "origin">,
): boolean => entry.origin === LABEL_METADATA_TEMPLATE_ORIGIN;

/**
 * Whether an entry of the template origin is keyed and classed as the mint
 * produces one: under the `["cfc", "labels"]` metadata subtree, and observed
 * by the `labelMetadata` class alone. The origin is what marks an entry as
 * document-rooted, so one keyed anywhere else, or one a payload read class
 * consumes, is a payload label spelled as a template.
 */
export const isWellFormedLabelMetadataTemplateEntry = (
  entry: Pick<LabelMapEntry, "path" | "observes">,
): boolean =>
  entry.path[0] === "cfc" && entry.path[1] === "labels" &&
  entry.observes === "labelMetadata";

/**
 * Whether the entry's own effective confidentiality is a sound population
 * label for its source-bearing fields: true exactly for the components
 * produced by the §8.9.2 conservative join — `derived` (the per-tx flow
 * stamp) and `structure` (the same join stamped on container shape,
 * §8.5.6.1) — whose label contains each influencing source's confidentiality
 * by construction. Declared/authored entries, link-carried pointer labels,
 * minted value stamps, the external-ingest mark, label-metadata templates
 * themselves and legacy (component-less) entries carry no such containment
 * guarantee and stay fail-closed (spec §4.6.4.2, merged via specs#14). Shared by the mint
 * (which entries GET templates) and the introspection surface (which entries'
 * fields are observable at all) so the two cannot drift.
 */
export const cfcEntryHasDerivedContainment = (
  entry: Pick<LabelMapEntry, "origin">,
): boolean => entry.origin === "derived" || entry.origin === "structure";

/**
 * The §4.6.4.2 public/protected split for one atom field, shared by the mint
 * and the introspection surface's in-hand rule: `type`/`kind` (and atom
 * presence itself) are public per the normative default; a field the Stage-0
 * classification table marks `public` (disclosure is the feature) is public;
 * every OTHER present field is source-protected. Commitment-classified
 * fields are protected too: the commitment hides the identity from casual
 * observation but stays probe-able, so observing it is still a protected
 * observation.
 */
export const labelMetadataFieldIsProtected = (
  atom: unknown,
  field: string,
): boolean =>
  field !== "type" && field !== "kind" &&
  classifyAtomField(atom, [field]) !== "public";

const TEMPLATE_TAIL = [
  "confidentiality",
  "clauses",
  "*",
  "alternatives",
  "*",
] as const;

/**
 * Protected-content scan of one clause alternative, mirroring the
 * introspection surface's projection walk (`atomProjectionLabel`): direct
 * fields of a record alternative register their FIELD NAME (they are
 * addressable at the `<field>` segment under `.../alternatives/*`, where the
 * evaluator's query predicates and depth-0 projection consultations land);
 * protected content found deeper — nested atoms smuggled inside public
 * wrapper fields, array elements, bare commitment markers — sets the
 * whole-atom flag only (its consultations land at nested concrete paths no
 * per-field template addresses; the whole-atom template carries the
 * projection label for it).
 */
const scanAlternative = (
  alternative: unknown,
  fields: Set<string>,
): boolean => {
  const scanNested = (value: unknown, contextAtom: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some((element) => scanNested(element, contextAtom));
    }
    if (!isObjectOrArray(value)) {
      return false;
    }
    if (isCfcFieldCommitment(value)) {
      // A bare commitment marker outside a classified field position:
      // protected (the introspection walk's marker arm).
      return true;
    }
    // Same atom-context rule as the projection walk: a record carrying a
    // string `type` or `kind` is an atom for classification purposes; plain
    // nested records keep the enclosing atom's context.
    const isAtom = typeof (value as { type?: unknown }).type === "string" ||
      typeof (value as { kind?: unknown }).kind === "string";
    const context = isAtom ? value : contextAtom;
    let found = false;
    for (const [key, field] of Object.entries(value)) {
      if (labelMetadataFieldIsProtected(context, key)) {
        found = true;
        continue;
      }
      if (scanNested(field, context)) {
        found = true;
      }
    }
    return found;
  };

  if (Array.isArray(alternative)) {
    return alternative.some((element) => scanNested(element, undefined));
  }
  if (!isObjectOrArray(alternative)) {
    // Bare string atoms are type-only tags: their entire content is the
    // public type observation.
    return false;
  }
  if (isCfcFieldCommitment(alternative)) {
    return true;
  }
  const isAtom = typeof (alternative as { type?: unknown }).type === "string" ||
    typeof (alternative as { kind?: unknown }).kind === "string";
  const context = isAtom ? alternative : undefined;
  let found = false;
  for (const [key, field] of Object.entries(alternative)) {
    if (labelMetadataFieldIsProtected(context, key)) {
      fields.add(key);
      found = true;
      continue;
    }
    if (scanNested(field, context)) {
      found = true;
    }
  }
  return found;
};

/**
 * Derive the label-metadata population template entries for one envelope's
 * FINAL payload entry set (post-clear, post-carry-forward, post-Stage-1
 * representation transform — so template label content is byte-identical to
 * the payload labels it describes, and the Stage-1 transform applies to it
 * by construction). Pure and deterministic: same payload entries in, same
 * templates out — the SC-11 canonical comparison then skips unchanged
 * envelopes exactly as before.
 *
 * Only derived-containment entries mint (the interim rule's observable
 * family); declared/authored source-bearing entries mint NOTHING — their
 * fields stay fail-closed-unobservable at the introspection surface, and a
 * sibling template at the same path never re-opens them (consumption is
 * containment-scoped, see `label-introspection.ts`).
 */
export const deriveLabelMetadataTemplateEntries = (
  entries: readonly LabelMapEntry[],
): LabelMapEntry[] => {
  const out: LabelMapEntry[] = [];
  for (const entry of entries) {
    if (
      isLabelMetadataTemplateEntry(entry) ||
      !cfcEntryHasDerivedContainment(entry)
    ) {
      continue;
    }
    const confidentiality = entry.label.confidentiality ?? [];
    if (confidentiality.length === 0) {
      continue;
    }
    const fields = new Set<string>();
    let anyProtected = false;
    for (const clause of confidentiality) {
      for (const alternative of clauseAlternatives(clause as CfcConfClause)) {
        if (scanAlternative(alternative, fields)) {
          anyProtected = true;
        }
      }
    }
    if (!anyProtected) {
      continue;
    }
    const base = [
      "cfc",
      "labels",
      "value",
      ...canonicalizeLogicalPath(entry.path),
      ...TEMPLATE_TAIL,
    ];
    const label = (): IFCLabel => ({ confidentiality: [...confidentiality] });
    out.push({
      path: base,
      label: label(),
      origin: LABEL_METADATA_TEMPLATE_ORIGIN,
      observes: "labelMetadata",
    });
    for (const field of [...fields].sort()) {
      out.push({
        path: [...base, field],
        label: label(),
        origin: LABEL_METADATA_TEMPLATE_ORIGIN,
        observes: "labelMetadata",
      });
    }
  }
  return out;
};

/**
 * Resolve the persisted population label at one CONCRETE metadata path
 * (`["cfc","labels","value",...,"clauses","1","alternatives","0","source"]`)
 * — the introspection surface's read of the metadata subtree, resolved
 * through the wildcard machinery like any read: within the label-metadata
 * component, the most specific covering template wins (§4.6.3 replace-down —
 * a per-field template shadows the whole-atom template for field reads),
 * equally specific covers JOIN (two payload entries' per-path templates
 * coalesce at persist, but foreign/stale siblings fail toward taint).
 *
 * `undefined` = no template (the caller falls back to the computed-in-hand
 * interim rule — pre-Stage-B envelopes have no templates). An EMPTY template
 * is treated as absent too: mints never produce one, and honoring a crafted
 * empty entry would turn protected fields public — absence must fail toward
 * the fallback, never toward disclosure.
 */
export const resolveLabelMetadataTemplateConfidentiality = (
  entries: readonly LabelMapEntry[],
  path: readonly string[],
): readonly CfcConfClause[] | undefined => {
  let best: { pathLength: number; atoms: unknown[] } | undefined;
  for (const entry of entries) {
    if (
      !isLabelMetadataTemplateEntry(entry) ||
      entry.observes !== "labelMetadata"
    ) {
      continue;
    }
    // Bidirectional wildcard prefix — the canonical matcher label views and
    // the payload resolution share (`*` in either the entry path or the
    // queried path matches any segment), so a concrete consultation path
    // resolves multi-`*` templates and a template minted for a `*`-path
    // payload target (a Stage-A membership template) resolves for concrete
    // slot consultations.
    const entryPath = canonicalizeLogicalPath(entry.path);
    if (!cfcLabelPathPrefixMatches(entryPath, path)) {
      continue;
    }
    const confidentiality = entry.label.confidentiality ?? [];
    if (confidentiality.length === 0) {
      continue;
    }
    if (best === undefined || best.pathLength < entryPath.length) {
      best = { pathLength: entryPath.length, atoms: [...confidentiality] };
    } else if (best.pathLength === entryPath.length) {
      for (const atom of confidentiality) best.atoms.push(atom);
    }
  }
  return best === undefined ? undefined : uniqueCfcAtoms(best.atoms);
};
