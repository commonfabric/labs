import type { CfcAtom } from "@commonfabric/api/cfc";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { encodePointer } from "../../../memory/v2/path.ts";
import type { CfcConfClause } from "./clause.ts";
import { normalizeClause } from "./clause.ts";
import { uniqueCfcAtoms } from "./observation.ts";

export type IFCLabel = {
  confidentiality?: CfcConfClause[];
  integrity?: CfcAtom[];
};

/**
 * Consumption class of a label entry (Epic C, spec §4.6.3;
 * docs/specs/cfc-observation-classes.md §3-§4). Defined here — the leaf of
 * the cfc module graph — and re-exported through `types.ts`, which imports
 * this module.
 */
export type LabelObservationClass =
  | "value"
  | "shape"
  | "enumerate"
  | "followRef";

/**
 * The label-METADATA observation class (inv-12 Stage 2, spec §4.6.4.1;
 * docs/specs/cfc-label-metadata-confidentiality.md §3), beside the payload
 * classes above: an observation of the first-layer label metadata subtree
 * (`/cfc/labels/<target-envelope-path>/...`) rather than of payload content.
 * Deliberately NOT a member of {@link LabelObservationClass} — no persisted
 * labelMap entry carries it and no payload read consumes it. Its observations
 * are recorded explicitly (`CfcTxState.labelMetadataObservations`, via
 * `recordCfcLabelMetadataObservation`) carrying their §4.6.4.2
 * population-rule labels, and the flow/consumed-set derivations fold them in
 * beside the journal-classified payload observations (see
 * `observation-classes.ts` for how it sits next to
 * `value`/`shape`/`followRef`).
 */
export type LabelMetadataObservationClass = "labelMetadata";

export type CfcLabelViewEntry = {
  path: readonly string[];
  label: IFCLabel;

  /**
   * EFFECTIVE consumption class (C4): unlike the persisted
   * `LabelMapEntry.observes`, view entries resolve the implicit
   * `origin:"link"` ⇒ `followRef` carve-out at build time
   * (`cfcLabelViewFromMetadata`), so view consumers never see `origin`.
   * Absent = covering for the content classes.
   */
  observes?: LabelObservationClass;
};

export type CfcLabelView = {
  version: 1;
  entries: CfcLabelViewEntry[];
};

const LABEL_KEYS = [
  "confidentiality",
  "integrity",
] as const satisfies readonly (keyof IFCLabel)[];

export const canonicalizeCfcLogicalPath = (
  path: readonly string[],
): string[] => path[0] === "value" ? path.slice(1) : [...path];

export const cfcLabelViewPathKey = (path: readonly string[]): string =>
  encodePointer(path[0] === "value" ? path.slice(1) : path);

export const cfcLabelPathPrefixMatches = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

export const cfcLabelPathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  cfcLabelPathPrefixMatches(left, right) ||
  cfcLabelPathPrefixMatches(right, left);

export const cloneCfcLabel = (label: IFCLabel): IFCLabel => {
  const cloned: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const value = label[key];
    if (Array.isArray(value) && value.length > 0) {
      cloned[key] = [...value];
    }
  }
  return cloned;
};

export const hasCfcLabelValues = (label: IFCLabel): boolean =>
  LABEL_KEYS.some((key) => Array.isArray(label[key]) && label[key]!.length > 0);

// Recursively strip `Caveat.source` — the principal identity that introduced a
// caveat — from an atom and every atom nested inside it. CFC atoms nest (e.g.
// `PromptSlotBound.source` / `Caveat.by` are themselves `CfcAtom`s), so a Caveat
// can appear at any depth; walk the whole structure and drop `source` from each
// Caveat found, leaving its `kind`/`by`/`type` and all other atoms intact.
const redactCaveatSourceAtom = (atom: unknown): unknown => {
  if (Array.isArray(atom)) {
    return atom.map(redactCaveatSourceAtom);
  }
  if (!isObjectOrArray(atom)) {
    return atom;
  }
  const obj = atom as Record<string, unknown>;
  const dropSource = obj.type === CFC_ATOM_TYPE.Caveat;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (dropSource && key === "source") {
      continue;
    }
    out[key] = redactCaveatSourceAtom(value);
  }
  return out;
};

/**
 * Redact `Caveat.source` identities from a label view for the pattern-facing
 * INTROSPECTION surface (`getCfcLabel()` → `handleCellGetCfcLabel`). Surfacing
 * the source lets a pattern learn which principal a caveat came from — an
 * information-flow leak (audit item 28b, inv-12; full inv-12 labeling stays
 * phased).
 *
 * Apply ONLY at main-thread-facing DISPLAY responses: the three IPC label
 * responses (`handleCellGet` includeCfcLabel, the subscribe sink,
 * `handleCellGetCfcLabel`), the sigil `cfcLabelView` copies the conversion
 * attaches inside response values (`convertCellsToLinks()` under
 * `includeCfcLabelView`), and response cell refs (`createCellRef`) — inv-12
 * Stage 0. Redacting every outbound copy is safe because the worker no longer
 * consumes inbound views: the persist seam re-derives link-origin labels from
 * stored source metadata, and the IPC ingress (`cellRefToSigilLink` /
 * `getCell`) drops ref-carried views. It is deliberately NOT used by
 * `cloneCfcLabel`, `cfcLabelViewFromMetadata`, or `cfcLabelViewForCell` —
 * those feed observation labeling (`cfcConfidentialityForObservationNode`),
 * the dereference-trace path `prepare.ts` consumes, and the worker-internal
 * carried-label views, all of which must keep `source` intact for
 * enforcement.
 */
export const redactCaveatSourcesForDisplay = (
  view: CfcLabelView,
): CfcLabelView => ({
  version: 1,
  entries: view.entries.map((entry) => {
    const label: IFCLabel = {};
    for (const key of LABEL_KEYS) {
      const value = entry.label[key];
      if (Array.isArray(value) && value.length > 0) {
        // `value` is the union of both label-key array types, so `.map()`
        // widens its callback parameter and loses the element type.
        label[key] = value.map(redactCaveatSourceAtom) as CfcAtom[];
      }
    }
    return {
      path: entry.path,
      label,
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    };
  }),
});

const sortEntries = (entries: CfcLabelViewEntry[]): CfcLabelViewEntry[] => {
  if (entries.length < 2) return entries;
  // Encoding belongs to the entry, so each path is encoded once per sort.
  // Equal keys retain input order, including separate observation classes.
  return entries.map((entry) => ({
    entry,
    key: cfcLabelViewPathKey(entry.path),
  })).sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  ).map(({ entry }) => entry);
};

export const mergeLabel = (
  left: IFCLabel | undefined,
  right: IFCLabel,
): IFCLabel => {
  const merged: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const values = [
      ...(Array.isArray(left?.[key]) ? left[key] : []),
      ...(Array.isArray(right[key]) ? right[key] : []),
    ];
    // Confidentiality is CNF clauses (Epic A3): the join is clause
    // CONCATENATION — `[[A∨B]] ⊔ [C] = [[A∨B], C]` — the OR stays clause-local
    // and `C` remains an independent gate. Normalizing each clause on ingest
    // (dedup + canonical alternative order + singleton unwrap) makes two
    // equivalent OR-clauses that differ only in alternative order coalesce
    // through the structural dedup below. It MUST NOT merge distinct clauses
    // or union their alternative sets — `normalizeClause` only rewrites a
    // clause's own interior, so concatenation + clause-granular dedup upholds
    // the §3.1.8 normalization prohibitions. Integrity carries no OR-clauses,
    // and `normalizeClause` is identity on non-clause atoms, so it is applied
    // only to confidentiality to keep intent explicit.
    const normalized = key === "confidentiality"
      ? (values as readonly CfcConfClause[]).map(normalizeClause)
      : values;
    // Dedup structurally via `uniqueCfcAtoms()` rather than by reference
    // (`new Set()`). Atoms can be fabric-converted clones (each call to
    // `cloneIfNecessary()` produces a fresh frozen object), so two
    // logically-identical caveats may not share a JS reference. The
    // reference-keyed approach would leave duplicates that callers
    // observe as both `confidentiality` bloat and -- since downstream
    // entry-merging compares labels structurally -- as label entries
    // failing to coalesce at the right path.
    const unique = uniqueCfcAtoms(normalized);
    if (unique.length > 0) {
      merged[key] = unique;
    }
  }
  return merged;
};

/**
 * The spaces each view was derived from: the spaces of the documents whose
 * stored labels it was read from. A module policy a view selects has its
 * manifest installed beside the label that selected it (spec §4.4.1), so these
 * are where a display boundary reads it, however many cells, proxies, links and
 * rebases the view travelled through first. The list is a superset: a derived
 * view keeps the origins of every view it was built from, including one whose
 * entries a rebase or merge dropped, which can only add a place to look.
 *
 * Runtime-only, and deliberately outside the view's data: it never enters a
 * view's hash, equality or serialized form, so a view that crosses a worker
 * boundary or a persisted link arrives without it and names no space. Keyed by
 * the view object and carried forward by {@link cloneCfcLabelView},
 * {@link mergeCfcLabelViews} and {@link rebaseCfcLabelView}, which build every
 * derived view; a site that builds one another way passes the origins on with
 * {@link withCfcLabelViewOrigins}. The lists are frozen and shared between
 * views by reference. The map is process-global; that is sound because an entry
 * is a fact about how one exact view object was derived, and a `WeakMap`
 * retains nothing.
 */
const viewOrigins = new WeakMap<CfcLabelView, readonly string[]>();

const NO_ORIGINS: readonly string[] = Object.freeze([]);

/** The spaces `view` was derived from; see {@link viewOrigins}. */
export const cfcLabelViewOriginSpaces = (
  view: CfcLabelView | undefined,
): readonly string[] =>
  view === undefined ? NO_ORIGINS : viewOrigins.get(view) ?? NO_ORIGINS;

const unionOrigins = (
  known: readonly string[] | undefined,
  added: readonly string[],
): readonly string[] => {
  if (known === undefined || known === added) {
    return Object.isFrozen(added) ? added : Object.freeze([...added]);
  }
  if (added.every((space) => known.includes(space))) return known;
  const union = [...known];
  for (const space of added) if (!union.includes(space)) union.push(space);
  return Object.freeze(union);
};

/**
 * Records that `view` was derived from stored labels in `spaces`, besides any
 * it already names. Returns `view`.
 */
export const withCfcLabelViewOrigins = <
  View extends CfcLabelView | undefined,
>(
  view: View,
  spaces: readonly string[],
): View => {
  if (view === undefined || spaces.length === 0) return view;
  viewOrigins.set(view, unionOrigins(viewOrigins.get(view), spaces));
  return view;
};

/** Carries the origins of `sources` onto `derived`, a view built from them. */
const carryOrigins = (
  derived: CfcLabelView | undefined,
  sources: readonly (CfcLabelView | undefined)[],
): CfcLabelView | undefined => {
  if (derived === undefined) return derived;
  let origins: readonly string[] | undefined;
  for (const source of sources) {
    const from = source === undefined ? undefined : viewOrigins.get(source);
    if (from !== undefined) origins = unionOrigins(origins, from);
  }
  if (origins !== undefined) viewOrigins.set(derived, origins);
  return derived;
};

export const cloneCfcLabelView = (
  view: CfcLabelView | undefined,
): CfcLabelView | undefined => {
  if (view === undefined) {
    return undefined;
  }
  const entries = sortEntries(
    view.entries.map((entry) => ({
      path: canonicalizeCfcLogicalPath(entry.path),
      label: cloneCfcLabel(entry.label),
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    })).filter((entry) => hasCfcLabelValues(entry.label)),
  );
  return carryOrigins(
    entries.length > 0 ? { version: 1, entries } : undefined,
    [view],
  );
};

export const mergeCfcLabelViews = (
  views: Array<CfcLabelView | undefined>,
): CfcLabelView | undefined => {
  // Keyed per (class, path): entries of different observation classes stay
  // separate so class-aware consumers (C4) keep their precision; merging a
  // `shape` entry into a covering one would re-smear the container-shape
  // label onto every value read below it.
  const byKey = new Map<string, CfcLabelViewEntry>();
  for (const view of views) {
    if (!view) {
      continue;
    }
    for (const entry of view.entries) {
      const path = canonicalizeCfcLogicalPath(entry.path);
      const key = `${entry.observes ?? ""}\u0000${cfcLabelViewPathKey(path)}`;
      const existing = byKey.get(key);
      byKey.set(key, {
        path,
        label: mergeLabel(existing?.label, entry.label),
        ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
      });
    }
  }
  const entries = sortEntries(
    [...byKey.values()].filter((entry) => hasCfcLabelValues(entry.label)),
  );
  return carryOrigins(
    entries.length > 0 ? { version: 1, entries } : undefined,
    views,
  );
};

export const rebaseCfcLabelView = (
  view: CfcLabelView | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!view) {
    return undefined;
  }

  const logicalPath = canonicalizeCfcLogicalPath(path);
  const entries: CfcLabelViewEntry[] = [];
  for (const entry of view.entries) {
    const entryPath = canonicalizeCfcLogicalPath(entry.path);
    if (cfcLabelPathPrefixMatches(logicalPath, entryPath)) {
      const label = entry.label;
      if (hasCfcLabelValues(label)) {
        entries.push({
          path: entryPath.slice(logicalPath.length),
          label,
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        });
      }
    } else if (cfcLabelPathPrefixMatches(entryPath, logicalPath)) {
      // A STRICT ancestor collapsing into the sliced view: content labels
      // (covering / `value`) inherit down — the slice is part of the
      // ancestor's content. Node-anchored channels do not: an ancestor's
      // `shape`/`enumerate` labels membership/existence of the ANCESTOR
      // (the C4 precision win — a public child under a secret container
      // shape does not inherit it), and an ancestor `followRef` labels a
      // pointer the slice is not.
      if (
        entry.observes !== undefined && entry.observes !== "value"
      ) {
        continue;
      }
      const label = entry.label;
      if (hasCfcLabelValues(label)) {
        entries.push({
          path: [],
          label,
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        });
      }
    }
  }

  return carryOrigins(
    mergeCfcLabelViews([
      entries.length > 0 ? { version: 1, entries } : undefined,
    ]),
    [view],
  );
};

/**
 * Whether two label views carry the same labels.
 *
 * `cloneCfcLabelView` puts each side into canonical form: logical paths, entry
 * order, empty labels dropped, and a view left holding nothing reduced to
 * `undefined`. `deepEqual` then compares what remains property by property, so
 * an atom written `{type, subject}` equals the same atom written
 * `{subject, type}`. That is the reading `uniqueCfcAtoms` gives atoms on the
 * merge path, where a fabric-converted clone of an atom is the same atom.
 *
 * The clause list and the integrity set are compared IN ORDER. That matches
 * `canonicalizeCfcLabel`, which reorders the alternatives inside an OR-clause
 * and leaves those two lists as they were given, so this answer stays aligned
 * with the persist-side idempotence check in `prepare.ts` that deep-equals
 * canonicalized metadata.
 */
export const cfcLabelViewsEqual = (
  left: CfcLabelView | undefined,
  right: CfcLabelView | undefined,
): boolean =>
  left === right ||
  deepEqual(cloneCfcLabelView(left), cloneCfcLabelView(right));
