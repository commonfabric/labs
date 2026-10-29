/**
 * Cross-reference queries over a parsed {@link Document}. These reuse the
 * per-token classification already attached to every line span (so matches are
 * real identifier occurrences, not substrings inside comments or strings), plus
 * the definition index. Pure and dependency-free, so they unit-test easily and
 * power the Enter info card's "uses" and "depends on" sections.
 */

import type { Document, StructureNode, TokenClass } from "./model.ts";

/** Token classes that count as an identifier occurrence of a symbol. */
const IDENT_CLASSES: ReadonlySet<TokenClass> = new Set<TokenClass>([
  "binding",
  "parameter",
  "callName",
  "builderCall",
  "cfHelper",
  "functionName",
  "typeName",
  "interfaceName",
  "identifier",
]);

export interface Reference {
  readonly line: number;
  readonly col: number;
  readonly cls: TokenClass;

  /** The full source line, for context in the card. */
  readonly lineText: string;

  /** True when this occurrence sits inside the node being described. */
  readonly inside: boolean;
}

export interface Dependency {
  readonly name: string;
  readonly kind: StructureNode["kind"];

  /** 0-based line of the declaration this node depends on. */
  readonly line: number;

  /** Char offset of the declaration, to select its node when jumped to. */
  readonly startOffset: number;

  /** Char offset of the first use inside the node, for a semantic definition
   * lookup that resolves the exact binding (and reaches other files). */
  readonly useOffset: number;
}

/**
 * Every identifier occurrence of `name` in document order. When `within` is
 * given, each reference is flagged `inside` if it falls in that node's range, so
 * the card can separate the declaration from its uses.
 */
export function findReferences(
  doc: Document,
  name: string,
  within?: StructureNode,
): Reference[] {
  const refs: Reference[] = [];
  for (let line = 0; line < doc.lines.length; line++) {
    for (const span of doc.lines[line].spans) {
      if (
        span.text !== name || !IDENT_CLASSES.has(span.cls) ||
        span.exactDefinitionName !== undefined
      ) {
        continue;
      }
      // Bound by the node's actual span, including column bounds on the boundary
      // lines, so a sibling occurrence on the same line as (but outside the
      // column range of) the node is not mistaken for one inside it.
      const inside = within
        ? line >= within.startLine && line <= within.endLine &&
          (line !== within.startLine || span.col >= within.startCol) &&
          (line !== within.endLine || span.col < within.endCol)
        : false;
      refs.push({
        line,
        col: span.col,
        cls: span.cls,
        lineText: doc.lines[line].text,
        inside,
      });
    }
  }
  return refs;
}

/**
 * Named declarations the node refers to that are defined elsewhere in the
 * document (its outgoing dependencies), deduped and in first-use order.
 */
export function findDependencies(
  doc: Document,
  node: StructureNode,
): Dependency[] {
  const lineStarts = lineStartOffsets(doc);
  const seen = new Map<string, Dependency>();
  for (let line = node.startLine; line <= node.endLine; line++) {
    const row = doc.lines[line];
    if (!row || row.bg === "del") continue;
    // Running UTF-16 char offset of each span on this line (spans are gapless).
    let charOffset = lineStarts[line] ?? 0;
    for (const span of row.spans) {
      const spanOffset = charOffset;
      charOffset += span.text.length;
      // Stay within the node's actual span, not the whole boundary lines, so a
      // sibling on the same line (e.g. the `const page =` it initializes) is
      // not mistaken for a dependency.
      if (line === node.startLine && span.col < node.startCol) continue;
      if (line === node.endLine && span.col >= node.endCol) continue;
      if (
        !IDENT_CLASSES.has(span.cls) ||
        span.exactDefinitionName !== undefined
      ) {
        continue;
      }
      const text = span.text;
      if (text === node.name || seen.has(text)) continue;
      const defs = doc.definitions.get(text);
      if (!defs) continue;
      // Only count declarations that live outside this node's own range.
      const external = defs.find((d) =>
        d.startOffset < node.startOffset || d.startOffset >= node.endOffset
      );
      if (external) {
        seen.set(text, {
          name: text,
          kind: external.kind,
          line: external.startLine,
          startOffset: external.startOffset,
          useOffset: spanOffset,
        });
      }
    }
  }
  return [...seen.values()];
}

/** An identifier occurrence inside a node, by name and char offset. */
export interface IdentUse {
  readonly name: string;
  readonly displayName?: string;
  readonly useOffset: number;
  readonly exactDefinitionOnly?: true;
}

export interface IdentUseCollection {
  readonly uses: IdentUse[];
  readonly total: number;
}

/**
 * Identifier use sites inside `node`, in source order. Ordinary identifier
 * spellings are deduplicated at their first use. Exact-position uses are
 * retained individually because equal spellings can resolve to different
 * definitions. Used to resolve cross-file definitions via the semantic service,
 * which the name index cannot see.
 */
export function collectIdentUses(
  doc: Document,
  node: StructureNode,
): IdentUse[] {
  return collectIdentUsesBounded(doc, node, Number.POSITIVE_INFINITY).uses;
}

/** Collect at most `limit` use sites while counting every eligible site. */
export function collectIdentUsesBounded(
  doc: Document,
  node: StructureNode,
  limit: number,
): IdentUseCollection {
  const lineStarts = lineStartOffsets(doc);
  const seen = new Set<string>();
  const out: IdentUse[] = [];
  let total = 0;
  for (let line = node.startLine; line <= node.endLine; line++) {
    const row = doc.lines[line];
    if (!row || row.bg === "del") continue;
    let charOffset = lineStarts[line] ?? 0;
    for (const span of row.spans) {
      const spanOffset = charOffset;
      charOffset += span.text.length;
      if (line === node.startLine && span.col < node.startCol) continue;
      if (line === node.endLine && span.col >= node.endCol) continue;
      if (
        !IDENT_CLASSES.has(span.cls) &&
        span.exactDefinitionName === undefined
      ) {
        continue;
      }
      const text = span.exactDefinitionName ?? span.text;
      const displayName = span.exactDefinitionDisplayName ?? text;
      const exactDefinitionOnly = span.exactDefinitionName !== undefined;
      const dedupeByName = !exactDefinitionOnly;
      if (
        spanOffset === node.nameOffset || (dedupeByName && seen.has(text))
      ) {
        continue;
      }
      if (dedupeByName) seen.add(text);
      total++;
      if (out.length < limit) {
        out.push(
          exactDefinitionOnly
            ? {
              name: text,
              displayName,
              useOffset: spanOffset,
              exactDefinitionOnly: true,
            }
            : { name: text, useOffset: spanOffset },
        );
      }
    }
  }
  return { uses: out, total };
}

/** Char offset where each line begins, derived from the verbatim text. */
function lineStartOffsets(doc: Document): number[] {
  const starts = [0];
  for (let i = 0; i < doc.text.length; i++) {
    if (doc.text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Ancestor chain of `node` from outermost (section) to its direct parent, using
 * the flattened pre-order list and depth. Empty for a root node.
 */
export function ancestorsOf(
  flat: readonly StructureNode[],
  node: StructureNode,
): StructureNode[] {
  const idx = flat.indexOf(node);
  if (idx < 0) return [];
  const chain: StructureNode[] = [];
  let depth = node.depth;
  for (let i = idx - 1; i >= 0 && depth > 0; i--) {
    if (flat[i].depth < depth) {
      chain.unshift(flat[i]);
      depth = flat[i].depth;
    }
  }
  return chain;
}
