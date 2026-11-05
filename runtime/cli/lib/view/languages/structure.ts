/**
 * Structure tree entries located by offsets into a source. A language finds
 * each entry, through a parser or its own scanner, and this gives the entry
 * the line and column coordinates the pager navigates by and indexes its
 * declared name for definition peeks.
 */

import type { Definition, StructureKind, StructureNode } from "../model.ts";
import {
  codePointColumns,
  type ColumnOf,
  computeLineStarts,
  lineIndexOf,
} from "../lines.ts";

/** A source, and the index its entries' declared names go into. */
export interface StructureSource {
  readonly lineStarts: number[];
  readonly columnOf: ColumnOf;
  readonly definitions: Map<string, Definition[]>;
}

/** The {@link StructureSource} for `text`, with nothing yet indexed. */
export function structureSource(text: string): StructureSource {
  const lineStarts = computeLineStarts(text);
  return {
    lineStarts,
    columnOf: codePointColumns(text, lineStarts),
    definitions: new Map(),
  };
}

/** One structure entry, located by offsets into its source. */
export interface LocatedEntry {
  readonly kind: StructureKind;

  /** Short human label, such as `def render`. */
  readonly label: string;

  /** Declared identifier, indexed for definition peeks. */
  readonly name?: string;

  /** Offset of that identifier, for a peek that resolves by position. */
  readonly nameOffset?: number;

  readonly startOffset: number;
  readonly endOffset: number;

  /** The kind of syntax the entry was found in. */
  readonly astKind: string;
}

/**
 * Places `entry` in its source and indexes its declared name, then builds its
 * children, one level deeper, so that an entry's name is indexed ahead of the
 * names inside it.
 */
export function structureNode(
  source: StructureSource,
  entry: LocatedEntry,
  depth: number,
  children: (depth: number) => StructureNode[],
): StructureNode {
  const { lineStarts, columnOf, definitions } = source;
  const { startOffset, endOffset } = entry;
  const startLine = lineIndexOf(lineStarts, startOffset);
  const endLine = lineIndexOf(
    lineStarts,
    Math.max(startOffset, endOffset - 1),
  );
  if (entry.name !== undefined) {
    const declarations = definitions.get(entry.name) ?? [];
    declarations.push({
      name: entry.name,
      kind: entry.kind,
      startLine,
      endLine,
      startOffset,
      endOffset,
    });
    definitions.set(entry.name, declarations);
  }
  return {
    kind: entry.kind,
    label: entry.label,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.nameOffset === undefined ? {} : { nameOffset: entry.nameOffset }),
    startLine,
    endLine,
    startCol: columnOf(startLine, startOffset),
    endCol: columnOf(endLine, endOffset),
    startOffset,
    endOffset,
    depth,
    children: children(depth + 1),
    astKinds: [entry.astKind],
  };
}
