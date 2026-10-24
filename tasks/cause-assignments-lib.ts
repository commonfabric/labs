/**
 * The cause assignment of a compiled pattern and of every pattern it reaches,
 * and the comparison of two of them, for `check-cause-assignments.ts`.
 *
 * Each pattern level's cells are numbered, described and matched across two
 * builds by `packages/runner/src/cause-assignment.ts`, which says what a
 * cell's description holds and why. This file adds the walk from the entry
 * pattern to every level, a key naming each level that holds when numbers
 * move, and a digest naming one build.
 */

import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
// By path rather than through `@commonfabric/runner`: the gate runs
// `cause-assignments-dump.ts` against a checkout of the base revision, under
// that checkout's configuration, where a package specifier would reach the
// base's copy of `cause-assignment.ts`, or nothing in a base older than it.
// One description of a cell, this tree's, has to apply to both builds.
import {
  type AmbiguousDescription,
  ambiguousDescriptions,
  type EntryRefOf,
  type NumberedCell,
  numberedCells,
  type RenumberedCell,
  renumberedCells,
  writerDescription,
} from "../packages/runner/src/cause-assignment.ts";

/**
 * One pattern a pattern reaches, the entry pattern included, and its
 * numbered cells in number order.
 */
export interface AssignmentLevel {
  /**
   * Where the level sits under the entry pattern, as the path of writers
   * leading to it. A writer is named by its description and by its ordinal
   * among the parent's writers of that description, never by a number, so
   * that the key holds when numbers move.
   */
  key: string;

  cells: NumberedCell[];
}

/** One pattern file's cause assignment, as one compiler built it. */
export interface PatternAssignment {
  /** The pattern's key, as `pattern-files.ts` names it. */
  pattern: string;

  /** A digest of the source files the pattern was compiled from. */
  source: string;

  levels: AssignmentLevel[];
}

/** A pattern file one compiler could not build, and why. */
export interface PatternAssignmentError {
  pattern: string;
  error: string;
}

/** A cell whose number differs between two builds of one source. */
export interface MovedCell extends RenumberedCell {
  pattern: string;
  level: string;
}

/**
 * A description of cells whose cells two builds of one source number so that
 * which cell went where cannot be told.
 */
export interface AmbiguousCells extends AmbiguousDescription {
  /** The pattern's key, as `pattern-files.ts` names it. */
  pattern: string;

  /** The level's key, as {@link AssignmentLevel} gives it. */
  level: string;

  /** Whether the cells hold state, as {@link NumberedCell} says. */
  holdsState: boolean;
}

type Unknown = Readonly<Record<string, unknown>>;

/**
 * Whether `value` can be read by property name, a function included: a
 * pattern the builder returns is a factory function carrying the pattern's
 * fields.
 */
const isReadable = (value: unknown): value is Unknown =>
  isObjectOrArray(value) || typeof value === "function";

const isPatternLike = (value: unknown): value is Unknown =>
  isReadable(value) && Array.isArray(value.nodes) &&
  "argumentSchema" in value && "result" in value;

/**
 * Helper for `assignmentLevels()`, which adds to `out` each pattern in
 * `value`, not looking inside one it finds.
 */
function nestedPatterns(
  value: unknown,
  out: Unknown[],
  seen: Set<unknown> = new Set(),
): void {
  if (!isReadable(value) || seen.has(value)) return;
  seen.add(value);
  if (isPatternLike(value)) {
    out.push(value);
    return;
  }
  for (const child of Object.values(value)) nestedPatterns(child, out, seen);
}

/**
 * The numbered cells of `entry` and of every pattern it reaches, through a
 * sub-pattern node or a builtin's pattern input, each pattern once.
 */
export function assignmentLevels(
  entry: object,
  entryRefOf: EntryRefOf,
): AssignmentLevel[] {
  const levels: AssignmentLevel[] = [];
  const visited = new Set<unknown>();
  const visit = (pattern: Unknown, key: string) => {
    if (visited.has(pattern)) return;
    visited.add(pattern);
    const children: [string, Unknown][] = [];
    const writerOrdinals = new Map<string, number>();
    for (const node of pattern.nodes as unknown[]) {
      if (!isObjectNotArray(node) || !isObjectNotArray(node.module)) continue;
      const nested: Unknown[] = [];
      nestedPatterns(
        node.module.type === "pattern"
          ? node.module.implementation
          : node.inputs,
        nested,
      );
      if (nested.length === 0) continue;
      const writer = writerDescription(node.module, entryRefOf);
      const ordinal = writerOrdinals.get(writer) ?? 0;
      writerOrdinals.set(writer, ordinal + 1);
      nested.forEach((child, index) =>
        children.push([`${key}/${writer}[${ordinal}]#${index}`, child])
      );
    }
    levels.push({ key, cells: numberedCells(pattern, entryRefOf) });
    for (const [childKey, child] of children) visit(child, childKey);
  };
  if (isPatternLike(entry)) visit(entry, "");
  return levels;
}

/**
 * The cells of `head` whose number differs from the one `base` gives them,
 * for one pattern built from one source by two compilers, each level matched
 * to the level of `base` under the same key. A level only one side has moves
 * nothing.
 */
export function movedCells(
  base: PatternAssignment,
  head: PatternAssignment,
): MovedCell[] {
  const baseLevels = new Map(base.levels.map((level) => [level.key, level]));
  const moved: MovedCell[] = [];
  for (const level of head.levels) {
    const before = baseLevels.get(level.key);
    if (before === undefined) continue;
    for (const cell of renumberedCells(before.cells, level.cells)) {
      moved.push({ pattern: head.pattern, level: level.key, ...cell });
    }
  }
  return moved;
}

/**
 * The descriptions, in each level of one pattern built from one source by
 * two compilers, whose cells cannot be matched across `base` and `head`,
 * each level matched to the level of `base` under the same key. For cells
 * holding state and for cells holding none alike, these are the descriptions
 * `ambiguousDescriptions()` names. The gate fails on those of cells holding
 * state, and lists those of cells holding none in its report only.
 */
export function ambiguousCells(
  base: PatternAssignment,
  head: PatternAssignment,
): AmbiguousCells[] {
  const baseLevels = new Map(base.levels.map((level) => [level.key, level]));
  const ambiguous: AmbiguousCells[] = [];
  for (const level of head.levels) {
    const before = baseLevels.get(level.key);
    if (before === undefined) continue;
    for (const found of ambiguousDescriptions(before.cells, level.cells)) {
      ambiguous.push({
        pattern: head.pattern,
        level: level.key,
        holdsState: true,
        ...found,
      });
    }
    for (
      const found of ambiguousDescriptions(before.cells, level.cells, {
        hasState: false,
      })
    ) {
      ambiguous.push({
        pattern: head.pattern,
        level: level.key,
        holdsState: false,
        ...found,
      });
    }
  }
  return ambiguous;
}

/**
 * A digest of `assignment`'s levels, which names one build of one pattern in
 * the gate's report and in an accepted move.
 */
export function assignmentDigest(assignment: PatternAssignment): string {
  // The levels are this module's own plain records, which JSON represents
  // whole.
  return encodeHex(
    sha256(new TextEncoder().encode(JSON.stringify(assignment.levels))),
  ).slice(0, 16);
}
