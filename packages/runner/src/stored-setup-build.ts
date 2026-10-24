/**
 * The record setup stamps on a piece as `patternSetupBuild`: which build of
 * which pattern staged the piece's internal cells and result projection, in
 * terms a later build can be held against.
 *
 * A pattern's anonymous internal cells are named by position in its build
 * (`./cause-assignment.ts`), and the result projection links each slot to
 * the cell the build that wrote it numbered for that slot. A build of the
 * same source that numbers its cells differently writes each cell's value
 * where the stored projection reads another slot. The record lets a start
 * tell that it loaded such a build, and whether re-staging the projection is
 * all it takes to put the piece right: it is, when every cell that moved is
 * one recomputing restores, and it is not when a cell holding state moved,
 * since re-staging would then read one cell's state as another's and record
 * that as the agreed setup.
 *
 * The record describes cells in words the compiler does not change for an
 * unchanged source, and leaves schemas out: the schema generator reshapes
 * schemas without moving any cell, and a record that changed with them would
 * re-stage every piece on every such deploy.
 */

import {
  convertibleJsFromFabricValue,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import {
  type EntryRefOf,
  type NumberedCell,
  numberedCells,
  type PatternLevel,
  type RenumberedCell,
  renumberedCells,
} from "./cause-assignment.ts";

/** The version of the record this module writes and reads. */
export const STORED_SETUP_BUILD_VERSION = 1;

/** A pattern identity, as the pattern pointer and the setup marker name one. */
export interface PatternRef {
  identity: string;
  symbol: string;
}

/**
 * What setup stamps. A record of another version, or of no version, reads as
 * unknown: a start then judges the piece by its manifest alone, as it does a
 * piece set up before the record existed.
 */
export interface StoredSetupBuild {
  /** {@link STORED_SETUP_BUILD_VERSION}. */
  v: typeof STORED_SETUP_BUILD_VERSION;

  /**
   * The pattern whose build the record describes. The setup marker can name
   * another pattern: a start repair rewrites this record and leaves the
   * marker alone.
   */
  pattern: PatternRef;

  /**
   * A digest of every positional cell of the level, by number and
   * description, in number order.
   */
  cells: string;

  /**
   * The positional cells that hold state recomputing does not restore, each
   * by number and description, in number order. The cells a re-staging must
   * find at their numbers.
   */
  state: [number, string][];

  /**
   * A digest of the projection map: each result path that links to a
   * positional cell, with the cell's number and the path linked inside it.
   * It changes where two cells of one description trade places, which the
   * cells' descriptions cannot show.
   */
  projection: string;
}

/** What a start finds when it holds a stored record against the build it loaded. */
export type StoredSetupBuildComparison =
  | { kind: "same" }
  /** Cells moved, none of them holding state: re-staging puts the piece right. */
  | { kind: "renumbered"; moved: RenumberedCell[] }
  /**
   * Re-staging would record one cell's state as another's: a cell holding
   * state moved (`moved`), or the projection changed over cells holding
   * state that share a description (`ambiguous`), which could have traded
   * numbers without the pairing seeing it.
   */
  | { kind: "held"; moved: RenumberedCell[]; ambiguous: string[] };

/** The fields of a built pattern the record reads. */
export interface StampedPattern extends PatternLevel {
  readonly result?: unknown;
}

/**
 * The projection map of `result`: for each `$alias` in it whose partial
 * cause is positional, the path of the slot holding it, the cell's number,
 * and the path the alias names inside the cell, in slot-path order. An alias
 * is a leaf: nothing inside one is a slot.
 */
export function projectionMap(result: unknown): [string, number, string][] {
  const entries: [string, number, string][] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string[]) => {
    if (!isObjectOrArray(value) || seen.has(value)) return;
    seen.add(value);
    const alias = isObjectNotArray(value) ? value.$alias : undefined;
    if (isObjectNotArray(alias)) {
      const cause = alias.partialCause;
      if (isObjectNotArray(cause) && typeof cause.$generated === "number") {
        const inner = Array.isArray(alias.path)
          ? alias.path.map(String).join("/")
          : "";
        entries.push([path.join("/"), cause.$generated, inner]);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key]);
    }
  };
  walk(result, []);
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The record describing `pattern`'s build, as setup stamps it for `ref`. */
export function storedSetupBuildOf(
  pattern: StampedPattern,
  ref: PatternRef,
  entryRefOf: EntryRefOf,
): StoredSetupBuild {
  const cells = numberedCells(pattern, entryRefOf);
  return {
    v: STORED_SETUP_BUILD_VERSION,
    pattern: { identity: ref.identity, symbol: ref.symbol },
    cells: hashStringOf(
      cells.map((cell) => [cell.number, cell.description]) as FabricValue,
    ),
    state: cells.filter((cell) => cell.holdsState).map((
      cell,
    ) => [cell.number, cell.description]),
    projection: hashStringOf(projectionMap(pattern.result) as FabricValue),
  };
}

/**
 * The record a piece's `patternSetupBuild` meta holds, or `undefined` for a
 * value that is no record of this module's version: nothing, a record of
 * another version, or a value of another shape.
 */
export function readStoredSetupBuild(
  raw: FabricValue | undefined,
): StoredSetupBuild | undefined {
  const value = raw === undefined
    ? undefined
    : convertibleJsFromFabricValue(raw);
  if (
    !isObjectNotArray(value) || value.v !== STORED_SETUP_BUILD_VERSION ||
    !isObjectNotArray(value.pattern) ||
    typeof value.pattern.identity !== "string" ||
    typeof value.pattern.symbol !== "string" ||
    typeof value.cells !== "string" || typeof value.projection !== "string" ||
    !Array.isArray(value.state) ||
    !value.state.every((entry) =>
      Array.isArray(entry) && entry.length === 2 &&
      typeof entry[0] === "number" && typeof entry[1] === "string"
    )
  ) {
    return undefined;
  }
  return {
    v: STORED_SETUP_BUILD_VERSION,
    pattern: {
      identity: value.pattern.identity,
      symbol: value.pattern.symbol,
    },
    cells: value.cells,
    state: value.state.map((
      entry,
    ) => [entry[0] as number, entry[1] as string]),
    projection: value.projection,
  };
}

/**
 * Holds `stored`, the record a piece carries, against `current`, the record
 * of the build a start loaded, whose positional cells are `cells`.
 *
 * The two agree when their cell and projection digests do. Otherwise the
 * cells holding state decide: each the stored record lists is paired with
 * the current build's cell of its description, in order among those of that
 * description (`renumberedCells()`), and one whose number differs is a move
 * that re-staging cannot put right. Two cells of one description trading
 * numbers is a move that pairing cannot see, and the projection map is what
 * shows it; so where the projection changed and cells holding state share a
 * description, the trade is taken to be among them. With no such move,
 * re-staging restores every cell that moved.
 */
export function compareStoredSetupBuild(
  stored: StoredSetupBuild,
  current: StoredSetupBuild,
  cells: readonly NumberedCell[],
): StoredSetupBuildComparison {
  if (
    stored.cells === current.cells && stored.projection === current.projection
  ) {
    return { kind: "same" };
  }
  const before: NumberedCell[] = stored.state.map(([number, description]) => ({
    number,
    description,
    holdsState: true,
  }));
  const after = cells.filter((cell) => cell.holdsState);
  const moved = renumberedCells(before, after);
  const ambiguous = stored.projection === current.projection ? [] : [
    ...new Set(
      stored.state.map(([, description]) => description).filter((
        description,
        index,
        descriptions,
      ) => descriptions.indexOf(description) !== index),
    ),
  ];
  return moved.length === 0 && ambiguous.length === 0
    ? { kind: "renumbered", moved }
    : { kind: "held", moved, ambiguous };
}
