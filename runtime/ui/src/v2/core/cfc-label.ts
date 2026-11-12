/**
 * Shared helpers for reading CFC labels on the trusted main thread.
 *
 * These let a trusted component decide whether a cell's runtime-attested CFC
 * label is public, and pull the owner a profile badge shows out of its
 * `represents-principal` integrity atoms.
 */

import type { CfcLabelView } from "@commonfabric/runner/cfc";

export type { CfcLabelView };

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

export { ownerPrincipalFromLabel } from "@commonfabric/runner/cfc/represents-principal";
