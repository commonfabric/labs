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
