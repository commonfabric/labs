/**
 * The cause assignment of one pattern level: the `{ $generated: N }` number
 * the pattern builder gives each anonymous internal cell, with each cell
 * described in words that hold across compilers, and the matching of two
 * assignments of one source cell by cell.
 *
 * The builder numbers the anonymous cells of a pattern level in the order its
 * walk reaches them, and the runtime mints each cell's entity id from its
 * number. A compiler change that adds or removes an anonymous cell ahead of
 * another therefore moves the other to a new number, under a source that did
 * not change, and a deployed piece then reads each moved cell's state from
 * the document a different cell wrote. `docs/specs/computed-cell-identity.md`
 * describes the numbering.
 *
 * A cell is described here only by what the compiler cannot change for an
 * unchanged source: whether it is a stream, its entity kind, and what writes
 * it, a sub-pattern child named by its child's pattern identity. Its schema is
 * left out, since the schema generator reshapes schemas without moving any
 * cell. Cells of one level with the same description are paired across two
 * builds by their order, so a cell added or removed among them moves the
 * pairing of each one after it, and two of them trading places reads as no
 * move. `renumberedCells()` says what that pairing reports, and
 * `ambiguousDescriptions()` names the descriptions for which it cannot say
 * which cell went where.
 */

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import {
  isFunction,
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/js-values/types";

/** One numbered cell of a pattern level. */
export interface NumberedCell {
  /** Its `$generated` number: its own, or a named instance's legacy one. */
  number: number;

  /** What it is, in words that hold across compilers for one source. */
  description: string;

  /**
   * Whether it holds state that recomputing it does not restore: a
   * sub-pattern child, whose state is the child piece under its id, or a
   * cell that is not computed.
   */
  hasState: boolean;
}

/** A numbered cell whose number differs between two builds of one source. */
export interface RenumberedCell {
  /** What it is, as {@link NumberedCell} describes it. */
  description: string;

  /** Whether it holds state, as {@link NumberedCell} says. */
  hasState: boolean;

  /** Its number in the earlier build. */
  from: number;

  /** Its number in the later build. */
  to: number;
}

/**
 * A description of cells, in one pattern level built by two compilers, whose
 * cells the pairing by order cannot match across the two, with the numbers
 * its cells have in each build.
 */
export interface AmbiguousDescription {
  /** What the cells are, as {@link NumberedCell} describes them. */
  description: string;

  /** The numbers of its cells in the earlier build, in number order. */
  before: number[];

  /** The numbers of its cells in the later build, in number order. */
  after: number[];
}

/** Options for `ambiguousDescriptions()`. */
export interface AmbiguousDescriptionsOptions {
  /**
   * Whether the cells considered are those that have state, as by default,
   * or those that have none.
   */
  hasState?: boolean;
}

/**
 * The pattern identity of a builder artifact, where one is known, with a
 * symbol that is the same for every load of the artifact's module, whichever
 * of the artifact's names the load registered first.
 */
export type EntryRefOf = (
  artifact: object,
) => { identity: string; symbol: string } | undefined;

/**
 * The fields of a built pattern level that its cause assignment reads. A
 * field of another shape than the builder gives it reads as empty.
 */
export interface PatternLevel {
  readonly nodes?: unknown;
  readonly derivedInternalCells?: unknown;
}

/** The fields of a node's module that name the node's writer. */
export interface WriterModule {
  readonly type?: unknown;
  readonly implementation?: unknown;
  readonly wrapper?: unknown;
}

/**
 * Helper for `numberedCells()`, which returns the `$generated` number of
 * `cause`, or `undefined` for a cause that carries none.
 */
function generatedNumber(cause: unknown): number | undefined {
  return isObjectNotArray(cause) && typeof cause.$generated === "number"
    ? cause.$generated
    : undefined;
}

/**
 * Helper for `numberedCells()`, which adds to `out` the key of each partial
 * cause an alias anywhere in `value` names.
 */
function aliasedCauses(
  value: unknown,
  out: Set<string>,
  seen: Set<unknown> = new Set(),
): void {
  if (!isObjectOrArray(value) || seen.has(value)) return;
  seen.add(value);
  const alias = isObjectNotArray(value) ? value.$alias : undefined;
  if (isObjectNotArray(alias) && alias.partialCause !== undefined) {
    out.add(causeKey(alias.partialCause));
  }
  for (const child of Object.values(value)) aliasedCauses(child, out, seen);
}

/** A key for a partial cause, the same for two equal causes. */
function causeKey(cause: unknown): string {
  return hashStringOf(cause as FabricValue);
}

/** Names the writer `module` in words that hold across compilers. */
export function writerDescription(
  module: WriterModule,
  entryRefOf: EntryRefOf,
): string {
  switch (module.type) {
    case "ref":
      return `builtin ${String(module.implementation)}`;
    case "javascript":
      return module.wrapper === undefined
        ? "function"
        : `function (${String(module.wrapper)})`;
    case "pattern": {
      const child = module.implementation;
      const ref = isObjectOrArray(child) || isFunction(child)
        ? entryRefOf(child)
        : undefined;
      return ref === undefined
        ? "sub-pattern"
        : `sub-pattern ${ref.identity.slice(0, 12)}#${ref.symbol}`;
    }
    default:
      return String(module.type);
  }
}

/**
 * The numbered cells of the pattern level `pattern`, in number order. The
 * patterns its nodes reach are levels of their own, and none of their cells
 * is among these.
 */
export function numberedCells(
  pattern: PatternLevel,
  entryRefOf: EntryRefOf,
): NumberedCell[] {
  const writersByCause = new Map<string, string[]>();
  const nodes = Array.isArray(pattern.nodes) ? pattern.nodes : [];
  for (const node of nodes) {
    if (!isObjectNotArray(node) || !isObjectNotArray(node.module)) continue;
    const writer = writerDescription(node.module, entryRefOf);
    const written = new Set<string>();
    aliasedCauses(node.outputs, written);
    for (const cause of written) {
      writersByCause.set(cause, [
        ...(writersByCause.get(cause) ?? []),
        writer,
      ]);
    }
  }
  const descriptors = Array.isArray(pattern.derivedInternalCells)
    ? pattern.derivedInternalCells
    : [];
  const cells: NumberedCell[] = [];
  for (const descriptor of descriptors) {
    if (!isObjectNotArray(descriptor)) continue;
    const own = generatedNumber(descriptor.partialCause);
    const number = own ?? generatedNumber(descriptor.legacyPartialCause);
    if (number === undefined) continue;
    const stream = isObjectNotArray(descriptor.partialCause) &&
      descriptor.partialCause.$kind === "stream";
    const computed = descriptor.kind === "computed";
    const writers = (writersByCause.get(causeKey(descriptor.partialCause)) ??
      []).sort();
    const child = writers.some((writer) => writer.startsWith("sub-pattern"));
    cells.push({
      number,
      description: [
        stream ? "stream" : "cell",
        computed ? "computed" : "not computed",
        writers.length === 0 ? "no writer" : `written by ${writers.join(", ")}`,
      ].join(", "),
      hasState: !stream && (!computed || child),
    });
  }
  return cells.sort((a, b) => a.number - b.number);
}

/**
 * The cells of `after` whose number differs from that of the cell of
 * `before` they are paired with, for one pattern level built from one source
 * by two compilers. The k-th cell of a description in `after` is paired with
 * the k-th cell of that description in `before`, and a cell with no partner
 * at its ordinal is left out.
 *
 * So where a cell is added or removed among cells of one description, each
 * one after it is paired with a neighbor's number. That shift goes unreported
 * where the two numbers agree, and where they differ, as when a cell of
 * another description sits between, it is reported with the neighbor's
 * number as `from`. Two cells of one description trading places are not
 * reported. For cells holding state, `ambiguousDescriptions()` names the
 * descriptions this pairing cannot be trusted for.
 */
export function renumberedCells(
  before: readonly NumberedCell[],
  after: readonly NumberedCell[],
): RenumberedCell[] {
  // TODO(danfuzz): For cells that hold no state, a cell added or removed
  // among cells of one description shifts the ones after it, and this
  // reports that shift with a neighbor's number as `from`, or not at all
  // where the numbers agree. Report each such cell with its own numbers,
  // once how those cells are to be matched is settled.
  // `cause-assignment.test.ts` pins the pairing as it stands, and
  // `check-cause-assignments.ts` passes the shift it does not report.
  const numbersBefore = new Map<string, number[]>();
  for (const cell of before) {
    numbersBefore.set(cell.description, [
      ...(numbersBefore.get(cell.description) ?? []),
      cell.number,
    ]);
  }
  const ordinals = new Map<string, number>();
  const moved: RenumberedCell[] = [];
  for (const cell of after) {
    const ordinal = ordinals.get(cell.description) ?? 0;
    ordinals.set(cell.description, ordinal + 1);
    const from = numbersBefore.get(cell.description)?.[ordinal];
    if (from === undefined || from === cell.number) continue;
    moved.push({
      description: cell.description,
      hasState: cell.hasState,
      from,
      to: cell.number,
    });
  }
  return moved;
}

/**
 * The descriptions of cells holding state, or, given `{ hasState: false }`,
 * of cells holding none, in one pattern level built from one source by two
 * compilers, for which the pairing by order that `renumberedCells()` makes
 * cannot say which cell went where. Such a description is either one whose
 * count of cells differs between `before` and `after`, since the pairing then
 * leaves a cell out and pairs the ones after it with a neighbor's number, or
 * one of two or more cells whose numbers changed, since a shift and a trade
 * among them look alike. Each list is in number order, as `numberedCells()`
 * returns it. A trade among cells of one description that leaves every number
 * as it was is not found here: the descriptions cannot show it.
 */
export function ambiguousDescriptions(
  before: readonly NumberedCell[],
  after: readonly NumberedCell[],
  { hasState = true }: AmbiguousDescriptionsOptions = {},
): AmbiguousDescription[] {
  const numbers = new Map<string, AmbiguousDescription>();
  const entry = (description: string): AmbiguousDescription => {
    let found = numbers.get(description);
    if (found === undefined) {
      found = { description, before: [], after: [] };
      numbers.set(description, found);
    }
    return found;
  };
  for (const cell of after) {
    if (cell.hasState === hasState) {
      entry(cell.description).after.push(cell.number);
    }
  }
  for (const cell of before) {
    if (cell.hasState === hasState) {
      entry(cell.description).before.push(cell.number);
    }
  }
  return [...numbers.values()].filter((found) =>
    found.before.length !== found.after.length ||
    (found.before.length >= 2 &&
      found.before.some((number, index) => number !== found.after[index]))
  );
}
