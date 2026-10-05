/**
 * Shared helpers for reading CFC labels on the trusted main thread.
 *
 * These let a trusted component query a cell's runtime-attested CFC label (over
 * IPC) and pull the owner a profile badge shows out of its
 * `represents-principal` integrity atoms.
 */

import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { authorPrincipalCandidates } from "@commonfabric/runner/cfc/represents-principal";
import { isObjectOrArray } from "@commonfabric/utils/types";

export type { CfcLabelView };

export type CfcLabelQueryable = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

export type CfcLabelResolvable = {
  resolveAsCell(): Promise<unknown> | unknown;
};

export const canQueryCfcLabel = (value: unknown): value is CfcLabelQueryable =>
  isObjectOrArray(value) &&
  typeof (value as { getCfcLabel?: unknown }).getCfcLabel === "function";

const canResolveAsCell = (value: unknown): value is CfcLabelResolvable =>
  isObjectOrArray(value) &&
  typeof (value as { resolveAsCell?: unknown }).resolveAsCell === "function";

/**
 * Egress check (host-embedding seam — see `docs/features/host-embedding.md`
 * §4). An embedder that persists profile (or any) data *outside the runtime* —
 * a host-side cache, an LLM prompt assembled from cell fields — has left the CFC
 * enforcement boundary and must fail closed on non-public data. This predicate
 * is that check: a label is public iff **no entry carries a non-empty
 * `confidentiality` clause**. An absent label (`undefined`) and an empty
 * `entries` array are both public; `integrity` atoms (provenance such as
 * `represents-principal`) are orthogonal and do NOT make a value confidential.
 *
 * As `Confidential<T, X>` / `ProjectionOf<…>` land structurally (CT-1658 /
 * CT-1660), those `confidentiality` clauses become populated; a check written
 * against this predicate keeps failing closed, whereas a hard-coded
 * "always public" assumption would silently start leaking. Any change to CFC
 * label semantics or granularity must keep this egress seam correct.
 */
export const cfcLabelViewIsPublic = (
  view: CfcLabelView | undefined,
): boolean => {
  if (!view) {
    return true;
  }
  for (const entry of view.entries) {
    const confidentiality = entry.label?.confidentiality;
    if (Array.isArray(confidentiality) && confidentiality.length > 0) {
      return false;
    }
  }
  return true;
};

/**
 * Reads a cell's CFC label view, resolving the cell first if the handle itself
 * doesn't expose `getCfcLabel` (e.g. an unresolved link). Returns undefined if
 * no label can be read.
 */
export const readCfcLabelView = async (
  value: unknown,
): Promise<CfcLabelView | undefined> => {
  if (canQueryCfcLabel(value)) {
    return await value.getCfcLabel();
  }
  if (canResolveAsCell(value)) {
    const resolved = await value.resolveAsCell();
    if (canQueryCfcLabel(resolved)) {
      return await resolved.getCfcLabel();
    }
  }
  return undefined;
};

/**
 * The principal a label says its value belongs to: the one DID
 * `authorPrincipalCandidates` finds in the `represents-principal` atoms at
 * the root and on the top-level fields, where an owner-protected profile
 * carries its owner's. `undefined` when those name no principal or more than
 * one, and atoms deeper down or carried by a link are not counted: they
 * describe documents this one links to.
 */
export const ownerPrincipalFromLabel = (
  view: CfcLabelView | undefined,
): string | undefined => {
  const candidates = authorPrincipalCandidates(view);
  return candidates.length === 1 ? candidates[0] : undefined;
};
