/**
 * Projecting a file's structure tree into the coordinates of a single diff
 * hunk. This is the generic remap: it clamps each node to the file lines the
 * hunk shows, folds a node that fills its parent's visible range, and registers
 * declared names so `t` peeks resolve. It is language-neutral — it works on the
 * {@link StructureNode} tree any language produces — so the TypeScript and JSON
 * languages share it. Markdown, whose hunk navigation is heading-based, does not.
 */

import type { Definition, StructureNode } from "./model.ts";
import type { HunkStructureContext } from "./languages/language.ts";
import { lineIndexOf } from "./lines.ts";
import { cpLen } from "./ansi.ts";

/**
 * Project every root of a hunk's structure tree into diff coordinates. The
 * shared body of {@link Language.hunkStructure} for every language whose
 * structure is a node tree (TypeScript, JSON); a language whose diff navigation
 * is not tree-shaped (Markdown's headings) builds its own instead. As a side
 * effect it registers each surviving node's declared name in `ctx.definitions`,
 * so `t` peeks resolve against the diff.
 */
export function remapStructure(ctx: HunkStructureContext): StructureNode[] {
  const remapCtx: RemapCtx = {
    newToDiff: ctx.lineToDiff,
    diffLineStarts: ctx.diffLineStarts,
    rawLines: ctx.rawLines,
    sourceLineStarts: ctx.sourceLineStarts,
    sourceOmitsUtf8Bom: ctx.sourceOmitsUtf8Bom,
    definitions: ctx.definitions,
  };
  const out: StructureNode[] = [];
  for (const root of ctx.doc.structure) {
    for (const node of remapNode(root, 2, null, remapCtx)) out.push(node);
  }
  return out;
}

export interface RemapCtx {
  /** Source line (file or fragment) → diff line, for visible lines. */
  newToDiff: Map<number, number>;

  diffLineStarts: number[];
  rawLines: string[];

  /** Line starts of the source text the nodes were parsed from. */
  sourceLineStarts: number[];

  sourceOmitsUtf8Bom: boolean;
  definitions: Map<string, Definition[]>;
}

function codeStartCol(sourceLine: number, ctx: RemapCtx): number {
  const diffLine = ctx.newToDiff.get(sourceLine);
  const raw = diffLine === undefined ? "" : ctx.rawLines[diffLine] ?? "";
  const markerWidth = raw.length === 0 ? 0 : 1;
  const bomWidth = ctx.sourceOmitsUtf8Bom && sourceLine === 0 &&
      raw[markerWidth] === "\uFEFF"
    ? 1
    : 0;
  return markerWidth + bomWidth;
}

/** An object/array literal or one of its entries — a generic node the diff
 * structure keeps (rather than dissolving) so it can be navigated entry by
 * entry. Matches on the TypeScript `astKinds` the TS parser records; a language
 * that records none never trips this, and dissolves nothing here (it only ever
 * emits nodes of a specific kind, not the generic `node`/`comment` kinds this
 * fold applies to). */
function isLiteralShape(node: StructureNode): boolean {
  return node.astKinds?.some((k) =>
    k === "ObjectLiteralExpression" || k === "ArrayLiteralExpression" ||
    k === "PropertyAssignment" || k === "ShorthandPropertyAssignment"
  ) ?? false;
}

/**
 * Remap a workspace-file structure node into diff coordinates, clamped to the
 * file lines this hunk actually shows. Children recurse. A node whose clamped
 * range coincides with its parent's is folded away — but its CHILDREN are
 * hoisted into the parent, so a hunk interior to deeply nested code still
 * exposes the innermost distinct nodes (and Tab never lands on two
 * identical-looking ones). Returns [] when no line of the node is visible.
 */
export function remapNode(
  node: StructureNode,
  depth: number,
  parentRange: { start: number; end: number } | null,
  ctx: RemapCtx,
): StructureNode[] {
  // A diff's structure stays focused on declarations and the like; the generic
  // expression and comment nodes that fill the full-AST tree are skipped, but
  // their meaningful descendants are hoisted into this node's place. Object and
  // array literals and their entries are kept, though — an object literal in a
  // diff (an options bag, a returned record) is worth navigating entry by entry.
  if (
    (node.kind === "node" || node.kind === "comment") && !isLiteralShape(node)
  ) {
    const hoisted: StructureNode[] = [];
    for (const child of node.children) {
      for (const mapped of remapNode(child, depth, parentRange, ctx)) {
        hoisted.push(mapped);
      }
    }
    return hoisted;
  }

  let firstVisible = -1;
  let lastVisible = -1;
  for (let n = node.startLine; n <= node.endLine; n++) {
    if (ctx.newToDiff.has(n)) {
      if (firstVisible < 0) firstVisible = n;
      lastVisible = n;
    }
  }
  if (firstVisible < 0) return [];

  const startDiffLine = ctx.newToDiff.get(firstVisible)!;
  const endDiffLine = ctx.newToDiff.get(lastVisible)!;
  // Columns begin past the diff marker and any decoded BOM. A clamped boundary
  // covers the whole source portion of the shown line.
  const startCodeCol = codeStartCol(firstVisible, ctx);
  const endCodeCol = codeStartCol(lastVisible, ctx);
  const startCol = firstVisible === node.startLine
    ? node.startCol + startCodeCol
    : startCodeCol;
  const endCol = lastVisible === node.endLine
    ? node.endCol + endCodeCol
    : cpLen(ctx.rawLines[endDiffLine]);
  const startOffset = ctx.diffLineStarts[startDiffLine] +
    cpToUtf16(ctx.rawLines[startDiffLine], startCol);
  const endOffset = ctx.diffLineStarts[endDiffLine] +
    cpToUtf16(ctx.rawLines[endDiffLine], endCol);

  // Coincidence fold: a node filling its parent's visible range IS the parent
  // as far as the diff shows. Hoist its mapped children in its place (same
  // depth, same parent range) and register its name against the surviving
  // range so `t` lookups still resolve.
  if (
    parentRange && parentRange.start === startOffset &&
    parentRange.end === endOffset
  ) {
    registerDefinition(
      node,
      startDiffLine,
      endDiffLine,
      startOffset,
      endOffset,
      ctx,
    );
    const hoisted: StructureNode[] = [];
    for (const child of node.children) {
      for (const mapped of remapNode(child, depth, parentRange, ctx)) {
        hoisted.push(mapped);
      }
    }
    return hoisted;
  }

  const nameOffset = remapNameOffset(node, ctx);
  const children: StructureNode[] = [];
  for (const child of node.children) {
    const remapped = remapNode(
      child,
      depth + 1,
      { start: startOffset, end: endOffset },
      ctx,
    );
    for (const remappedNode of remapped) children.push(remappedNode);
  }

  const mapped: StructureNode = {
    kind: node.kind,
    label: node.label,
    name: node.name,
    nameOffset,
    startLine: startDiffLine,
    endLine: endDiffLine,
    startCol,
    endCol,
    startOffset,
    endOffset,
    depth,
    children,
    meta: node.meta,
    astKinds: node.astKinds,
    generatedOrigin: node.generatedOrigin,
  };
  registerDefinition(
    node,
    startDiffLine,
    endDiffLine,
    startOffset,
    endOffset,
    ctx,
  );
  return [mapped];
}

function registerDefinition(
  node: StructureNode,
  startLine: number,
  endLine: number,
  startOffset: number,
  endOffset: number,
  ctx: RemapCtx,
): void {
  if (!node.name) return;
  const list = ctx.definitions.get(node.name) ?? [];
  list.push({
    name: node.name,
    kind: node.kind,
    startLine,
    endLine,
    startOffset,
    endOffset,
  });
  ctx.definitions.set(node.name, list);
}

/** The node's declared-name offset in diff coordinates, when visible. */
function remapNameOffset(
  node: StructureNode,
  ctx: RemapCtx,
): number | undefined {
  if (node.nameOffset === undefined) return undefined;
  const n = lineIndexOf(ctx.sourceLineStarts, node.nameOffset);
  const diffLine = ctx.newToDiff.get(n);
  if (diffLine === undefined) return undefined;
  const col = node.nameOffset - ctx.sourceLineStarts[n]; // UTF-16 in the line
  return ctx.diffLineStarts[diffLine] + codeStartCol(n, ctx) + col;
}

/** UTF-16 index of code-point column `col` within `text`. */
function cpToUtf16(text: string, col: number): number {
  let cp = 0;
  let i = 0;
  for (const ch of text) {
    if (cp >= col) break;
    cp++;
    i += ch.length;
  }
  return i;
}
