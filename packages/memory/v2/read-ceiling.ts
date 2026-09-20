/**
 * The read ceiling a session declares to the memory server: a
 * confidentiality ceiling every `db.query` served for that session reads
 * under (`docs/specs/sqlite-builtin/06-cfc.md`, "Runtime read ceiling").
 * Declared once, in the signed `session.open` descriptor
 * (`SessionDescriptor.readCeiling`), and carried by the serving runtime
 * onto every run it serves as that session.
 *
 * This module is the ONE shape validator for a read ceiling: the wire
 * parser below and the runtime's `cfcReadMaxConfidentiality` option both
 * hold their input to it, so a ceiling the runtime accepts is one the
 * server accepts, and the refusals name the field the caller wrote. A leaf
 * module: no dependency on the wire-shape module that re-exports it.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";

/** What a read does with a row the ceiling does not admit. */
export type ReadCeilingOnExceed = "fail" | "skip";

/**
 * One clause of a ceiling: an atom, or an OR of atoms written as
 * `{ anyOf: [atom, …] }` — the runtime's `CfcConfClause`, in the terms the
 * wire can name.
 */
export type ReadCeilingClause = CfcAtom | {
  readonly anyOf: readonly CfcAtom[];
};

/** A session's declared read ceiling. */
export type SessionReadCeiling = {
  /** The ceiling: a conjunction of clauses, never empty. */
  readonly maxConfidentiality: readonly ReadCeilingClause[];

  /**
   * The mode a query falls back to when it declares no `onExceed` of its
   * own; absent leaves the query builtin's default in force.
   */
  readonly onExceed?: ReadCeilingOnExceed;
};

/**
 * The names a refusal reports the two inputs under. A caller validating
 * the same shape from another surface — a runtime option, a run manifest
 * field, a command-line flag — passes its own, so the refusal names the
 * field the operator wrote.
 */
export interface ReadCeilingLabels {
  /** Name of the ceiling field. */
  readonly ceiling: string;

  /** Name of the mode field. */
  readonly onExceed: string;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether `value` is an OR-clause: a record whose SOLE own key is `anyOf`
 * with an array value. Any other record stays an atom (the runtime's
 * `isOrClause` rule, restated here so the two agree by construction).
 */
export const isReadCeilingOrClause = (
  value: unknown,
): value is { readonly anyOf: readonly CfcAtom[] } =>
  isPlainRecord(value) && Array.isArray(value.anyOf) &&
  Object.keys(value).length === 1;

/**
 * Whether `value` is a well-formed atom for a ceiling: a non-empty string
 * or a plain record that is not itself an OR-clause. A placeholder such as
 * `{ __ctDbOwner: true }` is a record, so it passes here and resolves per
 * query.
 */
const isCeilingAtom = (value: unknown): boolean =>
  (typeof value === "string" && value.length > 0) ||
  (isPlainRecord(value) && !isReadCeilingOrClause(value));

/**
 * The reason `ceiling` and `onExceed` are not a read ceiling, or
 * `undefined` when they are one.
 *
 * Refused: a ceiling that is not an array; an EMPTY ceiling, which admits
 * no confidential atom at all and is never what a caller who wrote one
 * meant (a caller wanting no ceiling omits the field); an entry that is
 * neither an atom nor an `anyOf` of atoms — a hole in a sparse array
 * included; an `anyOf` with no alternatives, which no label can satisfy;
 * an `onExceed` outside `fail` and `skip`; and an `onExceed` without a
 * ceiling, which would have nothing to qualify.
 *
 * Bound: this is a shape check. It does not resolve placeholders, which
 * need the acting principal and the db owner of each query, and it does not
 * judge whether an atom names a principal that exists.
 */
export function readCeilingShapeError(
  ceiling: unknown,
  onExceed: unknown,
  labels: ReadCeilingLabels,
): string | undefined {
  if (onExceed !== undefined && onExceed !== "fail" && onExceed !== "skip") {
    return `${labels.onExceed}: expected "fail" or "skip", got ${
      JSON.stringify(onExceed)
    }`;
  }
  if (ceiling === undefined) {
    return onExceed === undefined ? undefined : `${labels.onExceed}: ` +
      `qualifies \`${labels.ceiling}\`, which is not set — set both, or ` +
      "neither";
  }
  if (!Array.isArray(ceiling)) {
    return `${labels.ceiling}: expected an array of clauses`;
  }
  if (ceiling.length === 0) {
    return `${labels.ceiling}: an empty ceiling admits nothing — omit the ` +
      "field for no ceiling";
  }
  // Indexed rather than iterated with `forEach`/`map`, which skip the holes
  // of a sparse array: a hole is an entry that is not a clause, and refused
  // as one.
  for (let index = 0; index < ceiling.length; index++) {
    const clause = ceiling[index];
    const where = `${labels.ceiling}[${index}]`;
    if (isReadCeilingOrClause(clause)) {
      if (clause.anyOf.length === 0) {
        return `${where}: an \`anyOf\` with no alternatives`;
      }
      for (let i = 0; i < clause.anyOf.length; i++) {
        if (!isCeilingAtom(clause.anyOf[i])) {
          return `${where}.anyOf[${i}]: expected an atom, got ${
            JSON.stringify(clause.anyOf[i])
          }`;
        }
      }
    } else if (!isCeilingAtom(clause)) {
      return `${where}: expected an atom or an \`anyOf\` of atoms, got ${
        JSON.stringify(clause)
      }`;
    }
  }
  return undefined;
}

/** The names the wire parser reports a malformed descriptor field under. */
export const SESSION_READ_CEILING_LABELS: ReadCeilingLabels = {
  ceiling: "session.readCeiling.maxConfidentiality",
  onExceed: "session.readCeiling.onExceed",
};

/**
 * Parses the `readCeiling` field of a `session.open` descriptor: `undefined`
 * for an absent field, the ceiling for a well-formed one, `null` for a
 * malformed one — the shape every descriptor-field parser answers in, so a
 * malformed field refuses the message rather than opening a session that
 * silently reads unbounded.
 */
export function parseSessionReadCeiling(
  value: unknown,
): SessionReadCeiling | undefined | null {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return null;
  const { maxConfidentiality, onExceed, ...rest } = value;
  if (Object.keys(rest).length > 0 || maxConfidentiality === undefined) {
    return null;
  }
  if (
    readCeilingShapeError(
      maxConfidentiality,
      onExceed,
      SESSION_READ_CEILING_LABELS,
    ) !== undefined
  ) {
    return null;
  }
  return {
    maxConfidentiality: maxConfidentiality as readonly ReadCeilingClause[],
    ...(onExceed === undefined
      ? {}
      : { onExceed: onExceed as ReadCeilingOnExceed }),
  };
}
