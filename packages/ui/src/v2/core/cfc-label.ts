/**
 * Shared helpers for reading CFC labels on the trusted main thread.
 *
 * These let a trusted component query a cell's runtime-attested CFC label (over
 * IPC) and pull a principal out of its `represents-principal` integrity atoms:
 * the owner a profile badge shows, and the author `cf-cfc-authorship` checks a
 * message against.
 */

import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

export type { CfcLabelView };

export type CfcLabelQueryable = {
  getCfcLabel(): Promise<CfcLabelView | undefined>;
};

export type CfcLabelResolvable = {
  resolveAsCell(): Promise<unknown> | unknown;
};

const REPRESENTS_PRINCIPAL = "represents-principal";

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
 * The DID a `represents-principal` integrity atom names, in either the object
 * form (`{ kind, subject }`) or the string form (`represents-principal:<did>`),
 * trimmed; `undefined` for any other atom, or for one naming no DID.
 */
const representsPrincipalSubject = (atom: unknown): string | undefined => {
  if (typeof atom === "string") {
    if (!atom.startsWith(`${REPRESENTS_PRINCIPAL}:`)) {
      return undefined;
    }
    const subject = atom.slice(REPRESENTS_PRINCIPAL.length + 1).trim();
    return subject.length > 0 ? subject : undefined;
  }
  if (!isObjectNotArray(atom)) {
    return undefined;
  }
  const record = atom as Record<string, unknown>;
  if (
    record.kind !== REPRESENTS_PRINCIPAL || typeof record.subject !== "string"
  ) {
    return undefined;
  }
  const subject = record.subject.trim();
  return subject.length > 0 ? subject : undefined;
};

/** Every DID the `represents-principal` atoms of `entries` name, in order. */
const representsPrincipalSubjects = (
  entries: CfcLabelView["entries"],
): string[] =>
  entries.flatMap((entry) =>
    (entry.label.integrity ?? []).flatMap((atom) => {
      const subject = representsPrincipalSubject(atom);
      return subject === undefined ? [] : [subject];
    })
  );

/**
 * Extracts the owning principal DID from a `represents-principal` integrity atom
 * anywhere in the label. Owner-protected profile fields (`name`/`avatar`/…)
 * carry this atom at their own paths rather than the root, so every entry is
 * scanned. Returns the first DID found.
 */
export const ownerPrincipalFromLabel = (
  view: CfcLabelView | undefined,
): string | undefined =>
  view === undefined ? undefined : representsPrincipalSubjects(view.entries)[0];

/**
 * The DIDs that could be the principal the value labeled by `view` represents,
 * as an author claim is checked against: each distinct DID a
 * `represents-principal` atom names at the root or on a top-level field, in
 * order of first appearance. A profile's owner-protected fields carry their
 * owner's atom at their own top-level paths; atoms deeper down come from
 * documents the value links, and are not counted. One DID is the principal.
 * None means the label names no principal. More than one means it names no
 * single principal, and a claim resting on it must not verify.
 */
export const authorPrincipalCandidates = (
  view: CfcLabelView | undefined,
): string[] =>
  view === undefined ? [] : [
    ...new Set(
      representsPrincipalSubjects(
        view.entries.filter((entry) => entry.path.length <= 1),
      ),
    ),
  ];
