/**
 * The fit of a display sink's labels against a render policy (CFC §8.10.6):
 * the decision a render makes for each read that reaches the page, and that a
 * host's own read of a cell has to pass as well. It is a set of functions over
 * the policy and the sources the decision consults, rather than a part of the
 * reconciler, so that every display sink in the worker decides by the same
 * code: the reconciler for what it renders, and the worker for what the host
 * reads.
 *
 * What a decision consults beyond the labels themselves arrives as
 * {@link DisplayFitSources}: the exchange-rule resolver that rewrites a label
 * before the fit, and the providers a decision subscribes to so that it is
 * made again when the membership or a module policy its labels name changes.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  areLinksSame,
  type Cancel,
  type Cell,
  ContextualFlowControl,
  type JSONSchema,
  type SinkConsumedLabel,
} from "@commonfabric/runner";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  type CfcLabelView,
  type CfcLabelViewSource,
  cfcLabelViewSourceForCell,
  clauseAlternatives,
  membershipSpacesInConfidentiality,
  modulePolicyRefsInConfidentiality,
  readConsumesEntry,
  type RenderConfidentialityResolver,
  type SpaceMembershipProvider,
} from "@commonfabric/runner/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  normalizeRenderConfidentialityCeiling,
  type RenderPolicy,
  type WorkerReconcilerOptions,
} from "./types.ts";

// Mirrors CFC_ATOM_TYPE.Caveat in @commonfabric/api/cfc (not a dependency of
// this package).
export const CFC_CAVEAT_ATOM_TYPE = "https://commonfabric.org/cfc/atom/Caveat";

const logger = getLogger("display-fit", { enabled: false, level: "debug" });

/**
 * What a display decision consults beyond the labels it fits: the resolver
 * that rewrites a label through the display boundary's exchange rules before
 * the fit, and the sources whose changes can change the decision, which a
 * {@link FitWatch} subscribes to. A source left out is one the decision does
 * without: no resolver fits labels by exact match, and no provider leaves a
 * decision unrevisited when what it would watch changes, which still decides
 * soundly on what has synced.
 */
export type DisplayFitSources = {
  readonly resolveConfidentiality?: RenderConfidentialityResolver;
  readonly membership?: SpaceMembershipProvider;
  readonly modulePolicies?: WorkerReconcilerOptions["modulePolicySource"];
};

/**
 * The label a display decision was made on, as a denial reports it: a cell's
 * stored label, its schema's, a read's consumed labels, or none it could
 * read.
 */
export type RenderLabelSummary = {
  labelSource: "stored" | "schema" | "consumed" | "unreadable";
  confidentiality: readonly CfcConfClause[];
  integrity: readonly CfcAtom[];
};

/**
 * How a decision that is made again watches what it consulted: each label it
 * fits names documents its outcome depends on, such as a space's membership
 * or a module policy's manifest, and the watch subscribes to each, once, so
 * that the decision is made again when one changes. It holds the documents
 * already watched, the cancel group the watches join, and what to run when
 * one changes. Every entry point of the fit takes one, and watches what that
 * entry point fits; a decision made once and not again is given none.
 */
export type FitWatch = {
  readonly watched: Set<string>;
  readonly addCancel: (cancel: Cancel) => void;
  reeval: () => void;
};

/**
 * The policy a display decision starts from at the root, before any authored
 * boundary narrows it: the host's default ceiling when one is configured
 * (spec §8.10.6), or `undefined` for none, when nothing is gated. A malformed
 * ceiling reads as the empty one, which admits public content only, rather
 * than as none.
 */
export function rootRenderPolicyFor(
  configured: unknown,
): RenderPolicy | undefined {
  const ceiling = normalizeRenderConfidentialityCeiling(configured);
  return ceiling === undefined ? undefined : {
    declassifyConfidentiality: [],
    maxConfidentiality: [...(ceiling.atoms ?? [])],
    caveatKindAllow: [...(ceiling.caveatKinds ?? [])],
  };
}

/** Whether `policy` admits every cell, having no ceiling to fit. */
export function admitsEverything(policy: RenderPolicy): boolean {
  return policy.maxConfidentiality === undefined &&
    policy.declassifyConfidentiality.length === 0;
}

/**
 * The label that keeps `policy` from admitting what `reads` of `cell` show,
 * or undefined when the policy admits it. The policy has to admit both the
 * labels the reads consumed, which reach every document a read passed
 * through, including one behind a link crossed part way along the path, and
 * the labels at `cell`'s own node, as {@link cellLabelRefusal} fits them,
 * which include those its ancestors' labels cover (see {@link atNode}). What
 * lies below `cell` is fitted as the reads consumed it, so a read that stops
 * short of a labeled field is not refused for that field, and one that
 * reaches it is. A read that reports no consumed labels counts as consuming
 * the marker no policy admits, and reads that consumed none are fitted by the
 * cell's schema.
 */
export function readRefusal(
  cell: Cell<unknown>,
  reads: readonly (SinkConsumedLabel | undefined)[],
  policy: RenderPolicy,
  sources: DisplayFitSources,
  watch?: FitWatch,
): RenderLabelSummary | undefined {
  if (admitsEverything(policy)) return undefined;
  const confidentiality = reads.flatMap((read) =>
    read?.confidentiality ?? [CFC_LABEL_READ_FAILED_ATOM]
  );
  const integrity = reads.flatMap((read) => read?.integrity ?? []);
  const spaces = reads.flatMap((read) =>
    [...(read?.modulePolicySpaces.values() ?? [])].flatMap((set) => [...set])
  );
  const admitted = confidentiality.length === 0
    ? confidentialityLabelsFromCellSchema(cell).every((atom) =>
      atomRenderableUnderPolicy(atom, policy)
    )
    : canRenderLabelUnderPolicy(
      confidentiality,
      integrity,
      () => spaces,
      policy,
      sources,
      watch,
    );
  return admitted
    ? cellLabelRefusal(
      cell,
      cellLabelSources(cell)?.map(atNode),
      policy,
      sources,
      watch,
    )
    : { labelSource: "consumed", confidentiality, integrity };
}

/**
 * `source`, with its view narrowed to the entries at the node it was read
 * at. A cell's label view holds an entry for each labeled path at or below
 * the cell, and folds what its ancestors' labels cover into the entries at
 * the node itself, so these are the labels of the node and of every
 * ancestor, and none of what lies below it.
 */
function atNode(source: CfcLabelViewSource): CfcLabelViewSource {
  if (source.view === undefined) return source;
  const entries = source.view.entries.filter((entry) =>
    entry.path.length === 0
  );
  return {
    ...source,
    view: entries.length === 0 ? undefined : { ...source.view, entries },
  };
}

/** Whether `policy` admits `cell`'s labels, as {@link cellLabelRefusal} decides. */
export function canRenderCellUnderPolicy(
  cell: Cell<unknown>,
  policy: RenderPolicy,
  sources: DisplayFitSources,
  watch?: FitWatch,
): boolean {
  return admitsEverything(policy) ||
    cellLabelRefusal(cell, cellLabelSources(cell), policy, sources, watch) ===
      undefined;
}

/**
 * The label of `cell` that keeps `policy` from admitting it, or undefined
 * when the policy admits each of `labelSources`, the cell's labels as
 * {@link cellLabelSources} reads them. Each is fitted separately, through
 * {@link canRenderLabelUnderPolicy}. Labels that could not be read refuse. A
 * cell with no label is fitted by its schema's information-flow constraint,
 * atom by atom, since that constraint is not the data label and does not
 * carry the runtime `Space(...)` principals exchange resolution targets.
 */
export function cellLabelRefusal(
  cell: Cell<unknown>,
  labelSources: readonly CfcLabelViewSource[] | undefined,
  policy: RenderPolicy,
  sources: DisplayFitSources,
  watch?: FitWatch,
): RenderLabelSummary | undefined {
  if (
    labelSources === undefined ||
    labelSources.some((source) => source.readFailed)
  ) {
    return { labelSource: "unreadable", confidentiality: [], integrity: [] };
  }
  if (labelSources.every((source) => source.view === undefined)) {
    const confidentiality = confidentialityLabelsFromCellSchema(cell);
    return confidentiality.every((atom) =>
        atomRenderableUnderPolicy(atom, policy)
      )
      ? undefined
      : {
        labelSource: "schema",
        confidentiality: confidentiality as readonly CfcConfClause[],
        integrity: [],
      };
  }
  for (const { view, spaces } of labelSources) {
    if (view === undefined) continue;
    const confidentiality = confidentialityLabels(view);
    const integrity = integrityLabels(view);
    if (
      !canRenderLabelUnderPolicy(
        confidentiality,
        integrity,
        () => spaces,
        policy,
        sources,
        watch,
      )
    ) {
      return { labelSource: "stored", confidentiality, integrity };
    }
  }
  return undefined;
}

/**
 * The CFC labels of `cell`, each with the spaces of the documents it was read
 * from, where a module policy the label selects has its manifest (spec
 * §4.4.1): the cell's own label, which includes a label its handle carries,
 * and, when its path resolves through links to another place, the label
 * there, which reflects every link the resolution followed (spec §8.2.7).
 * {@link cellLabelRefusal} fits each separately, so integrity evidence in one
 * does not discharge a clause of the other. Undefined when the labels cannot
 * be read, as when the resolution throws.
 */
export function cellLabelSources(
  cell: Cell<unknown>,
): CfcLabelViewSource[] | undefined {
  try {
    const own = cfcLabelViewSourceForCell(cell);
    const resolved = cell.resolveAsCell();
    return sameCell(cell, resolved)
      ? [own]
      : [own, cfcLabelViewSourceForCell(resolved)];
  } catch {
    return undefined;
  }
}

/**
 * Whether a label may render under `policy`, resolved through the
 * display-boundary exchange rules when a resolver is among `sources` and a
 * ceiling is in force, and fitted atom by atom otherwise. `spaces` names where
 * a module policy the label selects has its manifest. Watches, through
 * `watch` when given, the membership and the manifests the label names, so
 * that the decision is made again when one changes.
 */
export function canRenderLabelUnderPolicy(
  confidentiality: readonly CfcConfClause[],
  integrity: readonly CfcAtom[],
  spaces: () => readonly string[],
  policy: RenderPolicy,
  sources: DisplayFitSources,
  watch?: FitWatch,
): boolean {
  if (watch !== undefined) {
    watchLabelSources(confidentiality, spaces(), watch, sources);
  }
  // With a resolver and a ceiling in force, the label is exchange-resolved
  // before the fit, which is where `Space(...)`-via-`HasRole` principal forms
  // become admissible. Without a resolver, or on a declassify-only boundary,
  // the label is fitted atom by atom by exact match.
  if (
    sources.resolveConfidentiality !== undefined &&
    policy.maxConfidentiality !== undefined
  ) {
    return resolvedConfidentialityRenderable(
      sources.resolveConfidentiality({ confidentiality, integrity, spaces }),
      policy,
    );
  }
  return confidentiality.every((atom) =>
    atomRenderableUnderPolicy(atom, policy)
  );
}

/**
 * Per-atom admission under a render policy. The read-failure marker is
 * ungrantable: it means "the label could not be read", so neither author
 * declassification nor a ceiling entry, even one naming the exported marker
 * string, may admit it. Every other atom checks declassification first, then
 * the ceiling.
 */
export function atomRenderableUnderPolicy(
  atom: unknown,
  policy: RenderPolicy,
): boolean {
  if (deepEqual(atom, CFC_LABEL_READ_FAILED_ATOM)) {
    return false;
  }
  if (
    policy.declassifyConfidentiality.some((declassified) =>
      deepEqual(declassified, atom)
    )
  ) {
    return true;
  }
  return canRenderConfidentialityAtom(atom, policy);
}

/**
 * Whether `atom` sits under `policy`'s ceiling: listed in it, or a caveat of a
 * kind the policy's caveat-kind allowance admits (spec §8.10.6). Admission is
 * not discharge: the caveat stays on the value.
 */
export function canRenderConfidentialityAtom(
  atom: unknown,
  policy: RenderPolicy,
): boolean {
  const max = normalizeAtomBound(policy.maxConfidentiality);
  if (max === undefined) {
    return true;
  }
  if (max.some((allowed) => deepEqual(allowed, atom))) {
    return true;
  }
  const kinds = policy.caveatKindAllow;
  return kinds !== undefined && kinds.length > 0 &&
    isObjectOrArray(atom) && atom.type === CFC_CAVEAT_ATOM_TYPE &&
    typeof atom.kind === "string" && kinds.includes(atom.kind);
}

/** A ceiling's atoms, deduplicated, or undefined for no ceiling. */
export function normalizeAtomBound(
  labels: readonly unknown[] | undefined,
): readonly CfcConfClause[] | undefined {
  if (labels === undefined) {
    return undefined;
  }
  return ContextualFlowControl.uniqueAtoms(labels);
}

/** The confidentiality clauses `labelView` holds, at any path. */
export function confidentialityLabels(
  labelView: CfcLabelView,
): readonly CfcConfClause[] {
  return ContextualFlowControl.uniqueAtoms(
    labelView.entries.flatMap((entry) => [
      ...(entry.label.confidentiality ?? []),
    ]),
  );
}

/**
 * The integrity a read of the value at the root of `labelView` consumes. An
 * entry describing a link the value was once reached through, rather than
 * the value, contributes none.
 */
export function integrityLabels(labelView: CfcLabelView): readonly CfcAtom[] {
  return ContextualFlowControl.uniqueAtoms(
    labelView.entries.flatMap((entry) =>
      entry.path.length === 0 && readConsumesEntry("value", entry)
        ? [...(entry.label.integrity ?? [])]
        : []
    ),
  );
}

/**
 * The information-flow atoms `cell`'s schema declares, or a marker no policy
 * admits when the schema cannot be read for them.
 */
export function confidentialityLabelsFromCellSchema(
  cell: Cell<unknown>,
): readonly unknown[] {
  const schema = (cell as { schema?: JSONSchema }).schema;
  if (schema === undefined) {
    return [];
  }
  const joined = new Set<unknown>();
  try {
    ContextualFlowControl.joinSchema(joined, schema);
  } catch {
    return ["__unknown_cfc_schema_label__"];
  }
  return ContextualFlowControl.uniqueAtoms(joined);
}

/**
 * Subscribes `watch.reeval` to the access-list documents of the spaces the
 * resolver consults for `confidentiality` (`membershipSpacesInConfidentiality`,
 * which adds module-policy subjects to the spec's `Space(X)` candidates), and
 * to the manifest document of each module policy the label selects in each of
 * `spaces`, the spaces the label was read from, so that a fail-closed refusal
 * is decided again when an access list later grants (or revokes) READ or a
 * manifest arrives (spec §4.9.3). A no-op for a source `sources` leaves out,
 * or when the label carries nothing it would watch; idempotent per watched
 * document via `watch.watched`. A subscription that throws leaves that
 * document unwatched, and the fit itself stays fail-closed independently.
 */
function watchLabelSources(
  confidentiality: readonly CfcConfClause[],
  spaces: readonly string[],
  { watched, addCancel, reeval }: FitWatch,
  sources: DisplayFitSources,
): void {
  const watchDocument = (key: string, subscribe: () => Cancel) => {
    if (watched.has(key)) return;
    try {
      addCancel(subscribe());
      watched.add(key);
    } catch (error) {
      logger.error(
        "display policy watch subscription failed",
        () => ({ key, error }),
      );
    }
  };
  const provider = sources.membership;
  if (provider !== undefined) {
    for (const space of membershipSpacesInConfidentiality(confidentiality)) {
      watchDocument(
        `membership:${space}`,
        () => provider.subscribe(space, reeval),
      );
    }
  }
  const manifests = sources.modulePolicies;
  if (manifests !== undefined) {
    for (
      const reference of modulePolicyRefsInConfidentiality(confidentiality)
    ) {
      for (const space of spaces) {
        watchDocument(
          `manifest:${JSON.stringify([space, reference.policyDigest])}`,
          () => manifests.subscribe(reference, space, reeval),
        );
      }
    }
  }
}

/**
 * Clause-aware admission of a label the exchange rules have already resolved,
 * fitted by clause subsumption (spec §8.10.3, `atomsOutsideCeiling`). A
 * resolved OR-clause fits when one of its alternatives sits under the
 * ceiling, so `Space(X)` that gained a `User(actingUser)` alternative renders.
 * Each still-offending clause gets a last-chance check: the read-failure
 * marker is ungrantable, and author declassification and the caveat-kind
 * allowance admit only bare atoms, which an OR-clause never matches.
 */
function resolvedConfidentialityRenderable(
  resolved: readonly CfcConfClause[],
  policy: RenderPolicy,
): boolean {
  const offending = atomsOutsideCeiling(resolved, policy.maxConfidentiality);
  for (const clause of offending) {
    if (
      clauseAlternatives(clause).some((alternative) =>
        deepEqual(alternative, CFC_LABEL_READ_FAILED_ATOM)
      )
    ) {
      return false;
    }
    // Declassification names an atom; after resolution an offending clause
    // may be an OR of alternatives, and releasing one alternative releases
    // the clause.
    if (
      policy.declassifyConfidentiality.some((declassified) =>
        deepEqual(declassified, clause) ||
        clauseAlternatives(clause).some((alternative) =>
          deepEqual(declassified, alternative)
        )
      )
    ) {
      continue;
    }
    if (canRenderConfidentialityAtom(clause, policy)) {
      continue;
    }
    return false;
  }
  return true;
}

/** Whether two cells address the same place, comparing by identity when they cannot be compared by link. */
function sameCell(left: Cell<unknown>, right: Cell<unknown>): boolean {
  try {
    return areLinksSame(left, right);
  } catch {
    return left === right;
  }
}
