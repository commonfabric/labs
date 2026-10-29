/**
 * Pure state-transition helpers for the pager: search matching, structure-tree
 * navigation, and scroll clamping. Kept free of terminal I/O so the navigation
 * model can be unit-tested without a TTY.
 */

import type { Document, StructureNode } from "./model.ts";
import type { Match } from "./render.ts";
import { cpLen } from "./ansi.ts";

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Largest valid `top` so the last content row can still show the last line. */
export function maxTop(lineCount: number, height: number): number {
  const contentRows = Math.max(1, height - 1);
  return Math.max(0, lineCount - contentRows);
}

/** Largest pager `top`, with the last line at the end of the top quarter. */
export function maxPagerTop(lineCount: number, height: number): number {
  const contentRows = Math.max(1, height - 1);
  const visibleDocumentRows = Math.max(1, Math.ceil(contentRows / 4));
  return Math.max(0, lineCount - visibleDocumentRows);
}

/** Number of rows occupied by diff content. The empty logical line after a
 * final line break begins the padded area. */
export function diffContentRowCount(
  rowCount: number,
  hasTrailingEmptyLine: boolean,
): number {
  return Math.max(0, rowCount - (hasTrailingEmptyLine ? 1 : 0));
}

/** All occurrences of `query`, document-ordered. Smartcase: lower-case query
 * matches case-insensitively, any upper-case forces case-sensitivity. */
export function findMatches(doc: Document, query: string): Match[] {
  if (query.length === 0) return [];
  const caseSensitive = /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Match[] = [];
  for (let line = 0; line < doc.lines.length; line++) {
    const original = doc.lines[line].text;
    const { folded, colOf } = caseSensitive
      ? plainHaystack(original)
      : foldHaystack(original);
    let from = 0;
    for (;;) {
      const idx = folded.indexOf(needle, from);
      if (idx < 0) break;
      // Columns are display code points in the ORIGINAL line, so highlights
      // line up with the cells even when folding changes a character's length
      // (e.g. `İ` U+0130 lowercases to two code units). `end` is one past the
      // last original column the match touches, so it always covers at least
      // the code point it starts on even if the needle matched a partial fold.
      const start = colOf(idx);
      const end = colOf(idx + needle.length - 1) + 1;
      matches.push({ line, start, end });
      from = idx + Math.max(1, needle.length);
    }
  }
  return matches;
}

/** A search haystack plus a map from its UTF-16 offsets back to original
 * code-point columns. `colOf(offset)` is the original column of the code point
 * that produced the code unit at `offset`; `colOf(length)` is the column past
 * the end. */
interface Haystack {
  readonly folded: string;
  colOf(offset: number): number;
}

/**
 * Build a case-folded haystack by lowercasing the original line one code point
 * at a time, recording for each resulting code unit the original code-point
 * column it came from. Doing the fold and the column map in the same walk keeps
 * `indexOf` offsets valid indices into the map regardless of how a character's
 * lowercase length differs from its original length.
 */
function foldHaystack(original: string): Haystack {
  let folded = "";
  // origColAt[k] = original code-point column that produced folded unit k.
  const origColAt: number[] = [];
  let col = 0;
  for (const cp of original) {
    const lower = cp.toLowerCase();
    for (let i = 0; i < lower.length; i++) origColAt.push(col);
    folded += lower;
    col += 1;
  }
  // One entry past the last code unit, so an offset at the end maps to the
  // column past the line's end.
  origColAt.push(col);
  return {
    folded,
    colOf: (offset) => origColAt[offset],
  };
}

/** Case-sensitive haystack: the line verbatim, with offsets mapped to columns
 * via {@link cpLen} (a non-BMP character is one code point but two code units). */
function plainHaystack(original: string): Haystack {
  return {
    folded: original,
    colOf: (offset) => cpLen(original.slice(0, offset)),
  };
}

/** Index of the next match at/after (line, col), wrapping. -1 if none. */
export function nextMatchIndex(
  matches: readonly Match[],
  line: number,
  col: number,
  forward: boolean,
): number {
  if (matches.length === 0) return -1;
  if (forward) {
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.line > line || (m.line === line && m.start > col)) return i;
    }
    return 0; // wrap
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (m.line < line || (m.line === line && m.start < col)) return i;
  }
  return matches.length - 1; // wrap
}

//
// Structure-tree navigation (over the flattened pre-order list)
//
// WASD walk the AST outline by family relationship:
//   w -> previous sibling   s -> next sibling   a -> parent   d -> first child
// `w`/`s` move among same-depth siblings. At the last sibling, `s` exits the
// parent and continues with the parent's next sibling (and so on up the tree),
// so it never gets stuck. At the first sibling, `w` steps up to the parent node
// itself. Tab/Shift-Tab navigate the same nodes by depth-first (pre-order)
// traversal instead, descending into children.
//

/**
 * Next sibling at the same depth; if none, exit the parent and take the
 * parent's next sibling (recursively up). `idx` unchanged only at the very end.
 */
export function treeNextSibling(
  flat: readonly StructureNode[],
  idx: number,
): number {
  let cur = idx;
  while (cur >= 0 && cur < flat.length) {
    const depth = flat[cur].depth;
    for (let i = cur + 1; i < flat.length; i++) {
      if (flat[i].depth < depth) break; // left this subtree without a sibling
      if (flat[i].depth === depth) return i;
    }
    const parent = treeParent(flat, cur);
    if (parent === cur) return idx; // no ancestor has a next sibling
    cur = parent; // pop up a level and look for the parent's next sibling
  }
  return idx;
}

/**
 * Previous sibling at the same depth. At the first sibling — where it would
 * otherwise leave the top of the parent — it steps up to the parent node
 * instead, so it is a no-op only at a top-level first node.
 */
export function treePrevSibling(
  flat: readonly StructureNode[],
  idx: number,
): number {
  const node = flat[idx];
  if (!node) return idx;
  for (let i = idx - 1; i >= 0; i--) {
    if (flat[i].depth < node.depth) break; // reached the parent
    if (flat[i].depth === node.depth) return i; // previous sibling
  }
  return treeParent(flat, idx); // first sibling: go up to the parent (or no-op)
}

/** Depth-first (pre-order) successor — the next node in document order. */
export function treePreOrderNext(
  flat: readonly StructureNode[],
  idx: number,
): number {
  return clamp(idx + 1, 0, flat.length - 1);
}

/** Depth-first (pre-order) predecessor. */
export function treePreOrderPrev(
  flat: readonly StructureNode[],
  idx: number,
): number {
  return clamp(idx - 1, 0, flat.length - 1);
}

/** Nearest enclosing node (first earlier node with smaller depth). */
export function treeParent(
  flat: readonly StructureNode[],
  idx: number,
): number {
  const depth = flat[idx]?.depth ?? 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (flat[i].depth < depth) return i;
  }
  return idx;
}

/** First child (next node, if it is one level deeper). */
export function treeChild(flat: readonly StructureNode[], idx: number): number {
  const node = flat[idx];
  if (!node) return idx;
  const next = flat[idx + 1];
  if (next && next.depth === node.depth + 1) return idx + 1;
  return idx;
}

/** Index of the first/innermost node whose range contains `line`. */
export function nodeAtLine(
  flat: readonly StructureNode[],
  line: number,
): number {
  let best = -1;
  let bestSpan = Infinity;
  for (let i = 0; i < flat.length; i++) {
    const n = flat[i];
    if (line >= n.startLine && line <= n.endLine) {
      const span = n.endLine - n.startLine;
      if (span <= bestSpan) {
        best = i;
        bestSpan = span;
      }
    }
  }
  return best;
}

/**
 * Frame a node's source range nicely: if the whole node fits on screen, center
 * it vertically; otherwise put its top line about a tenth of the way down so
 * there is a little lead-in but most of the screen shows the node. Used by `z`.
 */
export function frameTop(
  startLine: number,
  endLine: number,
  height: number,
  lineCount: number,
): number {
  const rows = Math.max(1, height - 1);
  const nodeHeight = endLine - startLine + 1;
  const top = nodeHeight <= rows
    ? startLine - Math.floor((rows - nodeHeight) / 2)
    : startLine - Math.floor(rows / 10);
  return clamp(top, 0, maxPagerTop(lineCount, height));
}

/**
 * Smallest scroll that keeps `anchorLine` on screen. Returns `top` unchanged
 * when the anchor is already visible; otherwise scrolls just enough (leaving a
 * small margin) to bring it into view. Used so changing the selection with WASD
 * does not move the viewport unless the selection's anchor would leave it.
 */
export function scrollToAnchor(
  anchorLine: number,
  top: number,
  height: number,
  lineCount: number,
): number {
  const rows = Math.max(1, height - 1);
  const bottom = top + rows - 1;
  if (anchorLine >= top && anchorLine <= bottom) return top;
  const margin = Math.min(3, Math.floor(rows / 4));
  const target = anchorLine < top
    ? anchorLine - margin
    : anchorLine - rows + 1 + margin;
  return clamp(target, 0, maxPagerTop(lineCount, height));
}

/**
 * Index of the node to select when navigation starts at the current viewport:
 * the first node whose anchor (start line) is on screen, so the first WASD press
 * selects something visible without scrolling. Falls back to the innermost node
 * containing the top line when nothing starts on screen.
 */
export function nodeForViewport(
  flat: readonly StructureNode[],
  top: number,
  height: number,
): number {
  const rows = Math.max(1, height - 1);
  const bottom = top + rows - 1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].startLine >= top && flat[i].startLine <= bottom) return i;
  }
  const enclosing = nodeAtLine(flat, top);
  return enclosing >= 0 ? enclosing : 0;
}
