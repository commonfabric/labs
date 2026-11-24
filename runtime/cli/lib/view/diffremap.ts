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
import { type ColumnOf, lineIndexOf } from "./lines.ts";

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
    diffColumnOf: ctx.diffColumnOf,
    rawLines: ctx.rawLines,
    sourceLineStarts: ctx.sourceLineStarts,
    sourceOmitsUtf8Bom: ctx.sourceOmitsUtf8Bom,
    definitions: ctx.definitions,
  };
  return remapNodes(ctx.doc.structure, remapCtx);
}

export interface RemapCtx {
  /** Source line (file or fragment) → diff line, for visible lines. */
  newToDiff: Map<number, number>;

  diffLineStarts: readonly number[];
  diffColumnOf: ColumnOf;
  rawLines: readonly string[];

  /** Line starts of the source text the nodes were parsed from. */
  sourceLineStarts: readonly number[];

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
 * Remaps workspace-file structure nodes into diff coordinates, each clamped to
 * the file lines this hunk actually shows; a node none of whose lines are
 * visible is dropped. A node whose clamped range coincides with its parent's
 * is folded away, but its children are hoisted into the parent, so a hunk
 * interior to deeply nested code still exposes the innermost distinct nodes
 * (and Tab never lands on two identical-looking ones). It keeps its own stack
 * of deferred steps, so any depth of nesting remaps, and it registers names in
 * the order a walk down the tree reaches them.
 */
function remapNodes(
  roots: readonly StructureNode[],
  ctx: RemapCtx,
): StructureNode[] {
  const out: StructureNode[] = [];
  const pending: (() => void)[] = [];
  type Range = { start: number; end: number };
  const queue = (
    nodes: readonly StructureNode[],
    depth: number,
    parentRange: Range | null,
    into: StructureNode[],
  ) => {
    for (let at = nodes.length - 1; at >= 0; at--) {
      pending.push(() => remap(nodes[at], depth, parentRange, into));
    }
  };
  const remap = (
    node: StructureNode,
    depth: number,
    parentRange: Range | null,
    into: StructureNode[],
  ) => {
    // A diff's structure stays focused on declarations and the like; the
    // generic expression and comment nodes that fill the full-AST tree are
    // skipped, but their meaningful descendants are hoisted into this node's
    // place. Object and array literals and their entries are kept, though — an
    // object literal in a diff (an options bag, a returned record) is worth
    // navigating entry by entry.
    if (
      (node.kind === "node" || node.kind === "comment") &&
      !isLiteralShape(node)
    ) {
      queue(node.children, depth, parentRange, into);
      return;
    }

    let firstVisible = -1;
    let lastVisible = -1;
    for (let n = node.startLine; n <= node.endLine; n++) {
      if (ctx.newToDiff.has(n)) {
        if (firstVisible < 0) firstVisible = n;
        lastVisible = n;
      }
    }
    if (firstVisible < 0) return;

    const startDiffLine = ctx.newToDiff.get(firstVisible)!;
    const endDiffLine = ctx.newToDiff.get(lastVisible)!;
    // A clamped boundary covers the whole source portion of the shown line.
    const startOffset = diffOffsetOf(
      firstVisible,
      Math.max(node.startOffset, ctx.sourceLineStarts[firstVisible]),
      ctx,
    );
    const endOffset = diffOffsetOf(lastVisible, node.endOffset, ctx);
    const register = () =>
      registerDefinition(
        node,
        startDiffLine,
        endDiffLine,
        startOffset,
        endOffset,
        ctx,
      );

    // Coincidence fold: a node filling its parent's visible range IS the
    // parent as far as the diff shows. Hoist its mapped children in its place
    // (same depth, same parent range) and register its name against the
    // surviving range so `t` lookups still resolve.
    if (
      parentRange && parentRange.start === startOffset &&
      parentRange.end === endOffset
    ) {
      register();
      queue(node.children, depth, parentRange, into);
      return;
    }

    const children: StructureNode[] = [];
    into.push({
      kind: node.kind,
      label: node.label,
      name: node.name,
      nameOffset: remapNameOffset(node, ctx),
      startLine: startDiffLine,
      endLine: endDiffLine,
      startCol: ctx.diffColumnOf(startDiffLine, startOffset),
      endCol: ctx.diffColumnOf(endDiffLine, endOffset),
      startOffset,
      endOffset,
      depth,
      children,
      meta: node.meta,
      astKinds: node.astKinds,
      generatedOrigin: node.generatedOrigin,
    });
    // The node's name registers after the names inside it.
    pending.push(register);
    queue(
      node.children,
      depth + 1,
      { start: startOffset, end: endOffset },
      children,
    );
  };
  queue(roots, 2, null, out);
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    step();
  }
  return out;
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
  if (!ctx.newToDiff.has(n)) return undefined;
  return diffOffsetOf(n, node.nameOffset, ctx);
}

/**
 * The diff offset of source `offset`, which is on or after the start of the
 * shown source line `line`. The source portion of the diff line begins past
 * the diff marker and any decoded BOM, and an offset beyond its end is clamped
 * to the end of the diff line.
 */
function diffOffsetOf(line: number, offset: number, ctx: RemapCtx): number {
  const diffLine = ctx.newToDiff.get(line)!;
  return ctx.diffLineStarts[diffLine] +
    Math.min(
      codeStartCol(line, ctx) + offset - ctx.sourceLineStarts[line],
      ctx.rawLines[diffLine].length,
    );
}
