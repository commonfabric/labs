/**
 * What the store admits of a document's CFC envelope a commit hands it,
 * judged against the envelope it stores.
 *
 * A runtime derives a commit's labels and writes them in the reserved `cfc`
 * member, and the store is handed that member by a writer it can't inspect:
 * a runtime with a fault in its write path, or a client that skips its
 * runtime's label machinery. Of a path's label components, the declared one
 * (store policy) only tightens, so the store can judge it against what it
 * holds without re-deriving anything.
 *
 * The store refuses a commit that leaves a path whose stored declared
 * entries hold a confidentiality clause with no declared entry at all, which
 * the runtime never writes except in an owner release. A commit that the
 * space's owner signs, every clause of whose dropped entries is the owner's
 * alone to release, is that release, and is admitted. A lowering that keeps
 * some declared entry at the path, and any change to a path's existence
 * entry, are left to the runtime.
 */

// SPEC-PENDING https://github.com/commonfabric/specs/pull/89 This is the
// interim rule (`interimAdmitted`) the pull request names; the rule it
// proposes also refuses a lowering that keeps a declared entry, and a change
// to a still-existing path's existence entry. The interim rule refuses a
// subset of what the proposed rule does, and the runtime's own writes never
// make what it refuses.

import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  type CfcConfClause,
  clauseReleasableBy,
} from "./cfc-release-authority.ts";

/** A path whose stored declared entries a proposed envelope leaves out. */
export interface DroppedDeclaredPath {
  /** The path, as the stored entries hold it. */
  readonly path: readonly unknown[];

  /**
   * The confidentiality clauses the stored declared entries there hold, or
   * `undefined` when one of them holds its label by a reference the store
   * can't resolve.
   */
  readonly clauses: readonly unknown[] | undefined;
}

/**
 * The paths whose stored declared entries hold a confidentiality clause and
 * at which `proposed` holds no declared entry, where `stored` and `proposed`
 * are a document's `cfc` member before and after a commit. `resolveLabel`
 * returns the content of the label document a `cid:` reference names, or
 * `undefined` when there is none.
 *
 * An envelope with no label map holds no declared entry, so a `proposed`
 * member that is absent, or that isn't a record, leaves out every stored
 * declared path.
 */
export const droppedDeclaredPaths = (
  stored: unknown,
  proposed: unknown,
  resolveLabel: (ref: string) => unknown,
): readonly DroppedDeclaredPath[] => {
  const storedEntries = labelMapEntriesOf(stored);
  if (storedEntries.length === 0) return [];
  const proposedPaths = new Set(
    labelMapEntriesOf(proposed)
      .filter((entry) => entry.origin === "declared")
      .map((entry) => JSON.stringify(entry.path)),
  );
  const dropped = new Map<
    string,
    { path: readonly unknown[]; clauses: unknown[] | undefined }
  >();
  for (const entry of storedEntries) {
    if (entry.origin !== "declared") continue;
    const key = JSON.stringify(entry.path);
    if (proposedPaths.has(key)) continue;
    const label = resolvedLabel(entry.label, resolveLabel);
    const clauses = label === undefined ? undefined : confidentialityOf(label);
    if (clauses !== undefined && clauses.length === 0) continue;
    const known = dropped.get(key);
    if (known === undefined) {
      dropped.set(key, {
        path: Array.isArray(entry.path) ? entry.path : [],
        clauses: clauses === undefined ? undefined : [...clauses],
      });
    } else if (known.clauses !== undefined) {
      known.clauses = clauses === undefined
        ? undefined
        : [...known.clauses, ...clauses];
    }
  }
  return [...dropped.values()];
};

/**
 * Whether a commit `actor` signs for a document in `space` may drop the
 * declared paths `dropped`: it drops none, or it is an owner release, the
 * space being the actor's home space and every dropped clause the actor's
 * alone to release. A commit naming no actor, or no space, releases nothing.
 */
export const admitsDroppedDeclaredPaths = (
  dropped: readonly DroppedDeclaredPath[],
  space: string | undefined,
  actor: string | undefined,
): boolean =>
  dropped.length === 0 ||
  (actor !== undefined && space === actor &&
    dropped.every((drop) =>
      drop.clauses !== undefined &&
      drop.clauses.every((clause) =>
        clauseReleasableBy(clause as CfcConfClause, actor)
      )
    ));

/** One stored or proposed label-map entry, as far as this rule reads it. */
interface EntryView {
  readonly path: unknown;
  readonly origin: unknown;
  readonly label: unknown;
}

/** The entries of the label map `cfc` holds, or none. */
const labelMapEntriesOf = (cfc: unknown): readonly EntryView[] => {
  if (!isObjectNotArray(cfc)) return [];
  const labelMap = cfc.labelMap;
  if (!isObjectNotArray(labelMap) || !Array.isArray(labelMap.entries)) {
    return [];
  }
  return labelMap.entries.filter(isObjectNotArray).map((entry) => ({
    path: entry.path,
    origin: entry.origin,
    label: entry.label,
  }));
};

/**
 * `label` itself, or the content of the label document a single-member
 * `{ $ref: "cid:…" }` record names, or `undefined` when that document isn't
 * there.
 */
const resolvedLabel = (
  label: unknown,
  resolveLabel: (ref: string) => unknown,
): unknown => {
  if (
    isObjectNotArray(label) && Object.keys(label).length === 1 &&
    typeof label.$ref === "string"
  ) {
    return resolveLabel(label.$ref);
  }
  return label;
};

/** The confidentiality clauses a resolved label holds. */
const confidentialityOf = (label: unknown): readonly unknown[] =>
  isObjectNotArray(label) && Array.isArray(label.confidentiality)
    ? label.confidentiality
    : [];
