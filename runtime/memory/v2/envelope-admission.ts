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
 * alone to release, is that release (§8.12.7 route 2c), and is admitted. So
 * is a commit holding a release by intent the store has verified
 * (`cfc-owner-release-by-intent.ts`, route 2d) that releases every clause of
 * the dropped entries at that path of that document. A lowering that keeps
 * some declared entry at the path, and any change to a path's existence
 * entry, are left to the runtime.
 */

// SPEC-PENDING https://github.com/commonfabric/specs/pull/89 This is the
// interim rule (`interimAdmitted`) the pull request names; the rule it
// proposes also refuses a lowering that keeps a declared entry, and a change
// to a still-existing path's existence entry. The interim rule refuses a
// subset of what the proposed rule does, and the runtime's own writes never
// make what it refuses.

import { cfcCanonicalClauseDigest } from "./cfc-clause-identity.ts";
import type { VerifiedOwnerReleaseByIntent } from "./cfc-owner-release-by-intent.ts";
import {
  type CfcConfClause,
  clauseReleasableBy,
} from "./cfc-release-authority.ts";
import {
  resolveStoredLabel,
  storedConfidentiality,
  storedLabelMapEntries,
} from "./cfc-stored-label-map.ts";

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
  const storedEntries = storedLabelMapEntries(stored);
  if (storedEntries.length === 0) return [];
  const proposedPaths = new Set(
    storedLabelMapEntries(proposed)
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
    const label = resolveStoredLabel(entry.label, resolveLabel);
    const clauses = label === undefined
      ? undefined
      : storedConfidentiality(label) ?? [];
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
 * declared paths `dropped`. Each drop must be one of two releases. In an owner
 * release, the space is the actor's home space and every dropped clause is
 * the actor's alone to release. In a release by intent, one of `releases`,
 * the verified releases by intent of this document the commit holds, is at
 * the drop's path and releases every clause dropped there. A commit naming no
 * actor, or no space, makes no owner release.
 */
export const admitsDroppedDeclaredPaths = (
  dropped: readonly DroppedDeclaredPath[],
  space: string | undefined,
  actor: string | undefined,
  releases: readonly VerifiedOwnerReleaseByIntent[] = [],
): boolean =>
  dropped.every((drop) =>
    drop.clauses !== undefined &&
    ((actor !== undefined && space === actor &&
      drop.clauses.every((clause) =>
        clauseReleasableBy(clause as CfcConfClause, actor)
      )) ||
      releasesByIntent(drop, releases))
  );

/**
 * Helper for {@link admitsDroppedDeclaredPaths}, which returns whether one of
 * `releases` is at `drop`'s path and names every clause dropped there.
 */
const releasesByIntent = (
  drop: DroppedDeclaredPath,
  releases: readonly VerifiedOwnerReleaseByIntent[],
): boolean => {
  // SPEC-PENDING https://github.com/commonfabric/specs/pull/90 A verified
  // route-2d release admits the drop of clauses that are not the owner's
  // alone.
  const clauses = drop.clauses;
  return clauses !== undefined &&
    releases.some((release) =>
      release.path.length === drop.path.length &&
      release.path.every((segment, index) => segment === drop.path[index]) &&
      clauses.every((clause) =>
        release.releasedClauseDigests.has(
          cfcCanonicalClauseDigest(clause as CfcConfClause),
        )
      )
    );
};
