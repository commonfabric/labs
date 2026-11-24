/**
 * What a run is told about the CFC labels a referent carries.
 *
 * Atom TYPES cross and nothing else — the URLs naming what a value requires
 * and what it carries, never an atom's other fields, which say what a label
 * was computed FROM. That is the same line the shape disclosure draws: a run
 * may know what it is holding and what handling that demands, and may not read
 * what is behind it. A read that fails is reported as a label rather than as
 * no label, so a cell whose metadata could not be interpreted does not read as
 * public.
 *
 * It lives here rather than in the tool that first needed it because it is a
 * disclosure rule, and a second copy of a disclosure rule is a second answer
 * to "what may a model learn about this cell" that nothing keeps in agreement
 * with the first.
 */

import type { CfcLabelView } from "@commonfabric/runner/cfc";

/** One label a referent carries, as atom types alone. */
export interface DisclosedCfcLabel {
  /** Where within the referent the label sits; absent at its root. */
  path?: string[];

  /** One entry per clause, holding that clause's alternatives. */
  confidentiality: string[][];

  integrity: string[];
}

/** The type an atom names: its `type` field, or the whole of a string atom. */
export const cfcAtomType = (atom: unknown): string | undefined => {
  if (typeof atom === "string") {
    return atom;
  }
  const type = (atom as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : undefined;
};

/**
 * One confidentiality clause's alternatives, as atom types. A bare atom is
 * its own single alternative, and a clause whose atoms this cannot name is
 * dropped rather than reported as an empty — that is, unconditional —
 * requirement.
 */
export const cfcClauseTypes = (clause: unknown): string[] => {
  const alternatives = (clause as { anyOf?: unknown } | null)?.anyOf;
  return (Array.isArray(alternatives) ? alternatives : [clause])
    .map(cfcAtomType)
    .filter((type): type is string => type !== undefined);
};

/**
 * One stored label as atom types alone. The same projection serves a cell's
 * own labels and a database column's `ifc`, which are the same structure
 * stored in two places.
 */
export const cfcLabelAtomTypes = (
  label: { confidentiality?: unknown[]; integrity?: unknown[] },
): Omit<DisclosedCfcLabel, "path"> => ({
  confidentiality: (label.confidentiality ?? [])
    .map(cfcClauseTypes)
    .filter((clause) => clause.length > 0),
  integrity: (label.integrity ?? [])
    .map(cfcAtomType)
    .filter((type): type is string => type !== undefined),
});

/** The labels a referent's view carries, projected for a public reply. */
export const disclosedCfcLabels = (
  view: CfcLabelView | undefined,
): DisclosedCfcLabel[] =>
  (view?.entries ?? []).map((entry) => ({
    ...(entry.path.length > 0 ? { path: [...entry.path] } : {}),
    ...cfcLabelAtomTypes(entry.label),
  }));
