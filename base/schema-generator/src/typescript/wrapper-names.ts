import type { CellWrapperKind } from "./cell-brand.ts";

/**
 * The authored-spelling axis of the wrapper vocabulary.
 *
 * `CellWrapperKind` (cell-brand.ts) is the RESOLVED-kind axis: what a wrapper
 * is after alias normalization (`Writable` has become `Cell`). This union is
 * the SPELLING axis: every type/interface NAME that a transformer or schema
 * pass matches against when classifying wrapper-ish types syntactically —
 * authored wrapper references (`Cell`, `Writable`, …), the callable
 * constructor-type interfaces, and the internal methods-owner interface.
 *
 * Membership sets are derived from exhaustive classification tables
 * (`Record<WrapperSpelling, boolean>` via `spellingsWhere`), so adding a
 * spelling here is a compile error at every classification site until the
 * new spelling is deliberately classified there. Keep each table co-located
 * with its consumer and its rationale; this module owns only the vocabulary
 * and the spelling→kind normalization.
 */
export type WrapperSpelling =
  | "Cell"
  | "Writable"
  | "ReadonlyCell"
  | "WriteonlyCell"
  | "ComparableCell"
  | "OpaqueCell"
  | "Stream"
  | "SqliteDb"
  | "Reactive"
  | "CellTypeConstructor"
  | "ScopedCellTypeConstructor";

/**
 * Resolved kind for each spelling, or undefined for spellings that are not
 * wrapper type references. The `Writable` → `Cell` normalization lives here,
 * once.
 */
export const WRAPPER_SPELLING_TO_KIND = {
  Cell: "Cell",
  // Authored alias of Cell that better expresses write-access semantics.
  Writable: "Cell",
  ReadonlyCell: "ReadonlyCell",
  WriteonlyCell: "WriteonlyCell",
  ComparableCell: "ComparableCell",
  OpaqueCell: "OpaqueCell",
  Stream: "Stream",
  SqliteDb: "SqliteDb",
  Reactive: "Reactive",
  // The interface typing the `Cell` constructor/namespace value (api/index.ts).
  CellTypeConstructor: undefined,
  // The interface typing the scoped-cell factory value (api/index.ts).
  ScopedCellTypeConstructor: undefined,
} as const satisfies Readonly<
  Record<WrapperSpelling, CellWrapperKind | undefined>
>;

// Every CellWrapperKind must be reachable from at least one spelling; a new
// kind fails to compile here until a spelling row maps to it.
type SpelledKinds = NonNullable<
  typeof WRAPPER_SPELLING_TO_KIND[WrapperSpelling]
>;
type AssertAllKindsSpelled = Exclude<CellWrapperKind, SpelledKinds> extends
  never ? true : never;
const _allKindsSpelled: AssertAllKindsSpelled = true;

export const WRAPPER_SPELLINGS = Object.keys(
  WRAPPER_SPELLING_TO_KIND,
) as readonly WrapperSpelling[];

const WRAPPER_SPELLING_SET: ReadonlySet<string> = new Set(WRAPPER_SPELLINGS);

export function isWrapperSpelling(name: string): name is WrapperSpelling {
  return WRAPPER_SPELLING_SET.has(name);
}

/**
 * Derive a membership set from an exhaustive classification table. Consumers
 * keep their own predicate (and its rationale) but must classify every
 * spelling.
 */
export function spellingsWhere(
  table: Readonly<Record<WrapperSpelling, boolean>>,
): ReadonlySet<string> {
  return new Set(WRAPPER_SPELLINGS.filter((spelling) => table[spelling]));
}
