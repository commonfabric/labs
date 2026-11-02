/**
 * Line-offset helpers shared across the pager: the parsers, the diff-document
 * builder, and each language's highlighter all need to turn a character offset
 * into a line index and back. Kept language-neutral so the core (diff builder)
 * and every language module can depend on them without depending on each other.
 */

/** Char offset where each line begins. */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Index of the line containing `offset` (binary search over line starts). */
export function lineIndexOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
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
  lineStarts: number[],
): ColumnOf {
  // `cpLen()` counts every UTF-16 unit except a low surrogate, so a column is
  // the distance in units less the low surrogates in between.
  const lowSurrogates: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) lowSurrogates.push(i);
  }
  const before = (offset: number): number => {
    let lo = 0;
    let hi = lowSurrogates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lowSurrogates[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (line, offset) => {
    const start = lineStarts[line];
    return offset - start - (before(offset) - before(start));
  };
}
