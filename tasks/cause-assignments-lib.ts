/**
 * The cause assignment of a compiled pattern, and the comparison of two of
 * them, for `check-cause-assignments.ts`.
 *
 * The pattern builder numbers each anonymous internal cell of a pattern
 * `{ $generated: N }`, in the order its walk reaches them, and the runtime
 * mints the cell's entity id from that number. A compiler change that adds
 * or removes an anonymous cell ahead of another therefore moves the other to
 * a new number, under a source that did not change, and a deployed piece then
 * reads each moved cell's state from the document a different cell wrote.
 * `docs/specs/computed-cell-identity.md` describes the numbering.
 *
 * A cell is described here only by what the compiler cannot change for an
 * unchanged source: whether it is a stream, its entity kind, and what writes
 * it, a sub-pattern child named by its child's pattern identity. Its schema is
 * left out, since the schema generator reshapes schemas without moving any
 * cell. Two cells of one pattern level with the same description are told
 * apart by their order, which a change elsewhere in the walk does not
 * disturb.
 */

import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

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
  holdsState: boolean;
}

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
export interface MovedCell {
  pattern: string;
  level: string;
  description: string;
  holdsState: boolean;
  from: number;
  to: number;
}

/** The pattern identity of a builder artifact, where one is known. */
export type EntryRefOf = (
  artifact: object,
) => { identity: string; symbol: string } | undefined;

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
 * Helper for `assignmentLevels()`, which returns the `$generated` number of
 * `cause`, or `undefined` for a cause that carries none.
 */
function generatedNumber(cause: unknown): number | undefined {
  return isObjectNotArray(cause) && typeof cause.$generated === "number"
    ? cause.$generated
    : undefined;
}

/**
 * Helper for `assignmentLevels()`, which adds to `out` the key of each
 * partial cause an alias anywhere in `value` names.
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

/** A key for a partial cause, the same for two equal causes. */
function causeKey(cause: unknown): string {
  return hashStringOf(cause as FabricValue);
}

/**
 * Helper for `assignmentLevels()`, which names the writer `module` in words
 * that hold across compilers.
 */
function writerName(module: Unknown, entryRefOf: EntryRefOf): string {
  switch (module.type) {
    case "ref":
      return `builtin ${String(module.implementation)}`;
    case "javascript":
      return module.wrapper === undefined
        ? "function"
        : `function (${String(module.wrapper)})`;
    case "pattern": {
      const child = module.implementation;
      const ref = isReadable(child) ? entryRefOf(child) : undefined;
      return ref === undefined
        ? "sub-pattern"
        : `sub-pattern ${ref.identity.slice(0, 12)}#${ref.symbol}`;
    }
    default:
      return String(module.type);
  }
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
    const writersByCause = new Map<string, string[]>();
    const children: [string, Unknown][] = [];
    const writerOrdinals = new Map<string, number>();
    for (const node of pattern.nodes as unknown[]) {
      if (!isObjectNotArray(node) || !isObjectNotArray(node.module)) continue;
      const writer = writerName(node.module, entryRefOf);
      const written = new Set<string>();
      aliasedCauses(node.outputs, written);
      for (const cause of written) {
        writersByCause.set(cause, [
          ...(writersByCause.get(cause) ?? []),
          writer,
        ]);
      }
      const nested: Unknown[] = [];
      nestedPatterns(
        node.module.type === "pattern"
          ? node.module.implementation
          : node.inputs,
        nested,
      );
      if (nested.length === 0) continue;
      const ordinal = writerOrdinals.get(writer) ?? 0;
      writerOrdinals.set(writer, ordinal + 1);
      nested.forEach((child, index) =>
        children.push([`${key}/${writer}[${ordinal}]#${index}`, child])
      );
    }
    const cells: NumberedCell[] = [];
    for (
      const descriptor of (pattern.derivedInternalCells ?? []) as unknown[]
    ) {
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
          writers.length === 0
            ? "no writer"
            : `written by ${writers.join(", ")}`,
        ].join(", "),
        holdsState: !stream && (!computed || child),
      });
    }
    cells.sort((a, b) => a.number - b.number);
    levels.push({ key, cells });
    for (const [childKey, child] of children) visit(child, childKey);
  };
  if (isPatternLike(entry)) visit(entry, "");
  return levels;
}

/**
 * The cells of `head` whose number differs from the one `base` gives them,
 * for one pattern built from one source by two compilers. A cell is matched
 * across the two by its description and its ordinal among the cells of its
 * level that share the description. A cell only one side has is not a move.
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
    const numbersBefore = new Map<string, number[]>();
    for (const cell of before.cells) {
      numbersBefore.set(cell.description, [
        ...(numbersBefore.get(cell.description) ?? []),
        cell.number,
      ]);
    }
    const ordinals = new Map<string, number>();
    for (const cell of level.cells) {
      const ordinal = ordinals.get(cell.description) ?? 0;
      ordinals.set(cell.description, ordinal + 1);
      const from = numbersBefore.get(cell.description)?.[ordinal];
      if (from === undefined || from === cell.number) continue;
      moved.push({
        pattern: head.pattern,
        level: level.key,
        description: cell.description,
        holdsState: cell.holdsState,
        from,
        to: cell.number,
      });
    }
  }
  return moved;
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
