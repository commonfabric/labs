/**
 * Line-offset helpers shared across the pager: the parsers, the diff-document
 * builder, and each language's highlighter all need to turn a character offset
 * into a line index and back. Kept language-neutral so the core (diff builder)
 * and every language module can depend on them without depending on each other.
 */

import { isSurrogatePairEnd } from "./ansi.ts";

/** Char offset where each line begins. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Index of the line containing `offset` (binary search over line starts). */
export function lineIndexOf(
  lineStarts: readonly number[],
  offset: number,
): number {
  return Math.max(0, firstIndexAtLeast(lineStarts, offset + 1) - 1);
}

/**
 * Returns the index of the first of the ascending `values` that is at least
 * `bound`, or the length of `values` when none is.
 */
export function firstIndexAtLeast(
  values: readonly number[],
  bound: number,
): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < bound) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The code-point column of an offset into a text, given the line the offset
 * is on: what `cpLen()` counts from the start of that line to the offset.
 */
export type ColumnOf = (line: number, offset: number) => number;

/**
 * Returns the {@link ColumnOf} for `text`, whose line starts are
 * `lineStarts`. Each call costs two binary searches, however long the line.
 */
export function codePointColumns(
  text: string,
  lineStarts: readonly number[],
): ColumnOf {
  // `cpLen()` counts every UTF-16 unit except a low surrogate that completes a
  // pair, so a column is the distance in units less those in between.
  const pairEnds: number[] = [];
  for (let i = 1; i < text.length; i++) {
    if (isSurrogatePairEnd(text, i)) pairEnds.push(i);
  }
  const before = (offset: number): number =>
    firstIndexAtLeast(pairEnds, offset);
  return (line, offset) => {
    const start = lineStarts[line];
    return offset - start - (before(offset) - before(start));
  };
}
